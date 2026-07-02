// RAG 核心：混合檢索（向量 + FTS5）→ RRF 融合 → reranker 精排 → 雙訊號門檻 → 組 context。
const fs = require('fs');
const path = require('path');
const { SOP_FILES_DIR, SIMILARITY_THRESHOLD, TOP_N_DOCS, TOP_N_CHUNKS, MAX_CONTEXT_CHARS,
        USE_RERANKER, RERANK_CANDIDATES, RERANK_THRESHOLD, COSINE_GATE } = require('./config');
const llm = require('./llm');
const dbm = require('./db');

// ── SYSTEM_PROMPT ─────────────
// 固定不變、不含 {context} → 讓推論引擎快取 system 前綴，省每次 prefill。參考資料放在 user 訊息（見 server.js）。
const SYSTEM_PROMPT = `你是部門的工作助理。下方「參考資料」是公司 SOP 資料庫的文件片段（可能含個人資料），請依此回答問題，回答一律使用繁體中文。

規則：
1. 文件開頭若有 --- YAML 區塊：exclusion_tags 命中問題關鍵字 → 跳過該文件；similar_docs 有值 → 回答最後加「⚠️ 若您要處理的是 [X]，請參考《[Y]》」。
2. 只用與問題直接相關的內容作答，其餘（FAQ、維護資訊、適用對象、前置準備）除非被問到否則忽略；不要整份貼出。
3. 找不到答案 → 回「這個問題我目前的資料裡沒有，建議詢問主管」。問題模糊且因情境而異 → 先追問一個最關鍵的問題（最多一次）。
4. 連結規則：只有當某個 URL 是「回答本次問題」直接需要的才單獨一行輸出：[點此開啟](URL)。與本次問題無關的 URL 一律不要附上。
5. 措辭：資料來自公司 SOP 資料庫，不是使用者提供的。引用來源一律稱「資料庫的文件」，開場用「根據資料庫的文件內容，…」。嚴禁說「您提供的文件」等用語。
6. 回答結尾務必附上（格式一致，無資料時來源寫「無」）：
【資料來源：文件名稱】
【後續問題：問題一|問題二|問題三】`;

// ── 圖片 / chunk 切段 ─────────────
const IMG_REGEX = /!\[([^\]]*)\]\(([^)]+)\)/g;
function extractChunkImages(text) {
  const images = []; let m; IMG_REGEX.lastIndex = 0;
  while ((m = IMG_REGEX.exec(text)) !== null) images.push({ alt: m[1], url: m[2] });
  return images;
}
function stripImages(text) { return text.replace(IMG_REGEX, '').replace(/\n{3,}/g, '\n\n').trim(); }

// 以 Markdown 標題（# / ## / ###）為界切 chunk；每個 chunk 記錄章節標題與內嵌圖片。
function chunkifyDoc(content, docId, docName) {
  const chunks = [];
  const lines = content.split('\n');
  let currentHeading = docName, currentLines = [];
  const flush = () => {
    const text = currentLines.join('\n').trim();
    if (text.length > 3) {
      chunks.push({ id: `${docId}::${chunks.length}`, docId, docName, heading: currentHeading,
        content: stripImages(text), images: extractChunkImages(text) });
    }
    currentLines = [];
  };
  for (const line of lines) {
    if (/^#{1,3} /.test(line) && currentLines.length > 0) { flush(); currentHeading = line.replace(/^#+\s+/, ''); }
    currentLines.push(line);
  }
  flush();
  if (chunks.length === 0 && content.trim().length > 0)
    chunks.push({ id: `${docId}::0`, docId, docName, heading: docName, content: content.trim(), images: [] });
  return chunks;
}

function cosineSimilarity(a, b) {
  let dot = 0, nA = 0, nB = 0; const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) { dot += a[i] * b[i]; nA += a[i] * a[i]; nB += b[i] * b[i]; }
  return dot / (Math.sqrt(nA) * Math.sqrt(nB));
}
function contentSignature(content) { return content.length + '|' + content.slice(0, 20) + '|' + content.slice(-20); }

// ── SOP 檔案存取 ─────────────
function docIdFromFilename(filename) { return filename.replace(/\.md$/i, ''); }
function listSopFiles() {
  if (!fs.existsSync(SOP_FILES_DIR)) return [];
  return fs.readdirSync(SOP_FILES_DIR).filter(f => f.toLowerCase().endsWith('.md')).map(filename => ({
    id: docIdFromFilename(filename), name: filename,
    content: fs.readFileSync(path.join(SOP_FILES_DIR, filename), 'utf8'),
  }));
}

// ── 索引（embedding）─────────────
// 增量：用「內容簽章 + 模型名」判斷是否需重算；沒變就跳過。
async function indexDoc(file, { force = false } = {}) {
  const sig = contentSignature(file.content);
  if (!force) {
    const state = dbm.getDocIndexState(file.id);
    if (state && state.sig === sig && state.model === llm.embedModel()) return 0;
  }
  const chunks = chunkifyDoc(file.content, file.id, file.name);
  const rows = [];
  for (const chunk of chunks) {
    const vector = await llm.embed(chunk.content, 'RETRIEVAL_DOCUMENT');
    rows.push({ id: chunk.id, doc_id: chunk.docId, doc_name: chunk.docName, heading: chunk.heading || '',
      content: chunk.content, images_json: JSON.stringify(chunk.images || []),
      vector_json: JSON.stringify(vector), sig, model: llm.embedModel() });
  }
  dbm.replaceDocChunks(file.id, rows);
  return rows.length;
}

async function syncIndex() {
  const files = listSopFiles(); let indexed = 0, skipped = 0, failed = 0;
  for (const file of files) {
    try { const n = await indexDoc(file); if (n > 0) indexed++; else skipped++; }
    catch (e) { failed++; console.warn(`索引失敗 ${file.name}: ${e.message}`); }
  }
  return { indexed, skipped, failed, total: files.length };
}
async function reindexAll() { let total = 0; for (const f of listSopFiles()) total += await indexDoc(f, { force: true }); return total; }
async function reindexFile(filename) {
  const id = docIdFromFilename(filename); const full = path.join(SOP_FILES_DIR, filename);
  if (!fs.existsSync(full)) { dbm.deleteDocChunks(id); return 0; }
  return indexDoc({ id, name: filename, content: fs.readFileSync(full, 'utf8') }, { force: true });
}
function removeFile(filename) { dbm.deleteDocChunks(docIdFromFilename(filename)); }

// ── 檢索 ─────────────
let lastRetrievalInfo = null;
const RRF_K = 60;       // RRF 融合常數
const FTS_LIMIT = 30;   // 關鍵字檢索取前幾名參與融合

async function retrieve(query, docIds) {
  const allow = Array.isArray(docIds) && docIds.length > 0 ? new Set(docIds) : null;
  const allChunks = dbm.getAllChunks().filter(c =>
    c.vector && c.model === llm.embedModel() && (!allow || allow.has(c.docId)));
  if (allChunks.length === 0) { lastRetrievalInfo = { mode: 'empty' }; return { hasMatch: false, context: '', sources: [], images: [] }; }

  // 0) 查詢正規化：軟分隔（半/全形空格、頓號、逗號、斜線、分號、冒號…）統一成單一半形空格。
  //    → 「A、B、C」與「A B C」變成位元組相同 → 向量/FTS/reranker 三路一致（使用者不必會用標點）。
  const normQuery = String(query || '').replace(/[　、，,．。；;：:|/\\]+/g, ' ').replace(/\s+/g, ' ').trim() || String(query || '');

  // 1) 向量檢索
  const queryVector = await llm.embed(normQuery, 'RETRIEVAL_QUERY');
  const byId = new Map(allChunks.map(c => [c.id, c]));
  const vecScored = allChunks.map(chunk => ({ chunk, sim: cosineSimilarity(queryVector, chunk.vector) })).sort((a, b) => b.sim - a.sim);
  const simOf = new Map(vecScored.map(s => [s.chunk.id, s.sim]));
  const vecRank = new Map(vecScored.map((s, i) => [s.chunk.id, i]));

  // 2) 關鍵字檢索（FTS5 trigram）：補強專有名詞 / 低 cosine 但字面命中的 chunk（如英文縮寫）
  const ftsRank = new Map();
  for (const { chunkId, rank } of dbm.ftsSearch(normQuery, FTS_LIMIT)) if (byId.has(chunkId)) ftsRank.set(chunkId, rank);

  // 3) RRF 融合：兩路名次各取 1/(K+rank) 相加
  const rrf = (id) => (vecRank.has(id) ? 1 / (RRF_K + vecRank.get(id)) : 0) + (ftsRank.has(id) ? 1 / (RRF_K + ftsRank.get(id)) : 0);
  const fused = allChunks.slice().sort((a, b) => rrf(b.id) - rrf(a.id));

  // 4) 候選池：RRF 前 RERANK_CANDIDATES
  const candidates = fused.slice(0, RERANK_CANDIDATES);

  // 5) Reranker 精排（解「雙胞胎」文件 + 校準查無資料門檻）；掛掉 → graceful fallback 回純 cosine。
  let ranked, mode, rerankOk = false;
  if (USE_RERANKER) {
    try {
      // 結構感知：餵給 reranker 的文字前綴「文件標題｜章節標題」，讓它能分辨高度相似但不同產品/流程的文件。
      const rerankText = (c) => `${c.docName.replace(/\.md$/i, '')}｜${c.heading || ''}\n${stripImages(c.content)}`;
      const scores = await llm.rerank(normQuery, candidates.map(rerankText));
      ranked = candidates.map((c, i) => ({ chunk: c, score: scores[i] != null ? scores[i] : 0, cos: simOf.get(c.id) || 0 })).sort((a, b) => b.score - a.score);
      mode = 'rerank'; rerankOk = true;
    } catch (e) {
      ranked = candidates.map(c => ({ chunk: c, score: simOf.get(c.id) || 0, cos: simOf.get(c.id) || 0 })).sort((a, b) => b.score - a.score);
      mode = 'rerank-fallback-cosine'; console.warn('[rag] reranker 失敗，fallback cosine:', e.message);
    }
  } else {
    ranked = candidates.map(c => ({ chunk: c, score: simOf.get(c.id) || 0, cos: simOf.get(c.id) || 0 })).sort((a, b) => b.score - a.score);
    mode = 'hybrid';
  }

  // ★ 雙訊號門檻 ★
  // reranker 有信心（topRerank 達標）→ 只餵 rerank 達標的 chunk，不讓「cosine 高但 rerank 近 0」的字面沾邊雜訊混入。
  // reranker 對整題都沒信心 → 退回看「整題最高 cosine」救「換句話問」極端案例（cosine 是整題最後手段，非逐 chunk OR）。
  const topRerank = ranked.length ? ranked[0].score : 0;
  const topCos = ranked.reduce((m, r) => Math.max(m, r.cos), 0);
  let relevant, gateVia;
  if (rerankOk) {
    if (topRerank >= RERANK_THRESHOLD) { relevant = ranked.filter(r => r.score >= RERANK_THRESHOLD); gateVia = 'rerank'; }
    else if (topCos >= COSINE_GATE) { relevant = ranked.filter(r => r.cos >= COSINE_GATE); gateVia = 'cosine-fallback'; }
    else { relevant = []; gateVia = 'none'; }
  } else {
    relevant = ranked.filter(r => r.cos >= SIMILARITY_THRESHOLD); gateVia = 'cosine-no-reranker';
  }

  lastRetrievalInfo = { mode, gateVia, topScore: ranked.length ? +(+ranked[0].score).toFixed(4) : 0, topCos: ranked.length ? +(+ranked[0].cos).toFixed(3) : 0 };
  if (relevant.length === 0) return { hasMatch: false, context: '', sources: [], images: [] };

  // 6) 取門檻通過的 chunk 組 context，受 TOP_N_CHUNKS + MAX_CONTEXT_CHARS 限制（餵命中 chunk，不是整份文件）
  const picked = []; let totalChars = 0;
  for (const { chunk } of relevant) {
    if (picked.length >= TOP_N_CHUNKS) break;
    const piece = stripImages(chunk.content);
    if (totalChars + piece.length > MAX_CONTEXT_CHARS && picked.length > 0) break;
    picked.push({ chunk, piece }); totalChars += piece.length;
  }
  const context = picked.map(({ chunk, piece }) => `=== 文件：${chunk.docName}｜${chunk.heading || ''} ===\n${piece}`).join('\n\n---\n\n');

  // sources：去重，最多 TOP_N_DOCS（sources[0] = 最相關文件）
  const sources = [], sourceScores = [], seenDoc = new Set();
  for (const { chunk, score, cos } of relevant) {
    if (!seenDoc.has(chunk.docName)) { seenDoc.add(chunk.docName); sources.push(chunk.docName); sourceScores.push({ name: chunk.docName, score: +(+score).toFixed(4), cos: +(+cos).toFixed(3) }); }
    if (sources.length >= TOP_N_DOCS) break;
  }

  // images：picked chunk 的圖片去重
  const imgs = [], seenImg = new Set();
  for (const { chunk } of picked) for (const img of (chunk.images || [])) if (!seenImg.has(img.url)) { seenImg.add(img.url); imgs.push(img); }

  // 連結補強（doc-scoped）：收「命中來源文件」全文裡含 URL 的行（即使該行 chunk 沒被餵進 top context）。
  // sourceUrls 同時作為 server 端「連結白名單」（過濾掉非命中文件的連結，避免模型硬湊不相關連結）。
  const URL_RE_DOC = /https?:\/\/[^\s)\]」』，。、）]+/g;
  const sourceUrls = [], linkLines = [], seenLinkLine = new Set();
  for (const c of allChunks) {
    if (!seenDoc.has(c.docName)) continue;
    for (const line of String(c.content || '').split('\n')) {
      const us = line.match(URL_RE_DOC); if (!us) continue;
      us.forEach(u => { if (!sourceUrls.includes(u)) sourceUrls.push(u); });
      const clean = stripImages(line).trim();
      if (!clean || seenLinkLine.has(clean)) continue;
      seenLinkLine.add(clean);
      if (!context.includes(clean) && linkLines.length < 6) linkLines.push(clean);
    }
  }
  const finalContext = linkLines.length
    ? `${context}\n\n---\n\n【本文件的相關連結】使用者若詢問連結／檔案／在哪裡取得／網址，請直接從下方提供對應連結：\n${linkLines.join('\n')}`
    : context;

  return { hasMatch: true, context: finalContext, sources, sourceScores, gateVia, images: imgs, sourceUrls };
}

module.exports = {
  SYSTEM_PROMPT, chunkifyDoc, cosineSimilarity, stripImages,
  listSopFiles, syncIndex, reindexAll, reindexFile, removeFile, retrieve,
  getLastRetrievalInfo: () => lastRetrievalInfo,
};

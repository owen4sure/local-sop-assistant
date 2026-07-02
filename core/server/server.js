// 進入點：host 網站 + 提供 API + 監看 sop-files/ 自動索引。
// 這是「骨架」：保留所有端點、核心演算法與門檻；密鑰/IP/真實內容皆走 env 或佔位。
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const chokidar = require('chokidar');
const config = require('./config');
const rag = require('./rag');
const llm = require('./llm');
const dbm = require('./db');
const { execFileSync } = require('child_process');
// const { markdownToLineText } = require('./lineformat'); // LINE 純文字排版

const app = express();
app.use(express.json({ limit: '25mb' })); // SOP 可內嵌 base64 圖片，放寬上限
app.use(express.static(config.WEB_DIR));   // host 前端靜態頁（index / review / generator）

// ══════════ 安全 middleware ══════════
// 內網限定：命中對外網域 → 擋掉所有「寫入/審核」類 API（只認 LAN）。
function internalOnly(req, res, next) {
  if (config.PUBLIC_HOSTNAMES.includes(req.hostname))
    return res.status(403).json({ error: '此功能僅限公司內網操作。' });
  next();
}
// 審核密碼檢查（header X-Review-Password 或 body.password；完整字串、區分大小寫）。
function checkPassword(req) {
  const pw = req.get('X-Review-Password') || (req.body && req.body.password) || '';
  return !!config.REVIEW_PASSWORD && pw === config.REVIEW_PASSWORD;
}
// 安全檔名：標題 → <title>.md（防路徑跳脫）。
function safeMdName(title) {
  let s = path.basename(String(title || 'document')).replace(/\.md$/i, '');
  s = s.replace(/[\/\\:*?"<>|]/g, '').trim() || 'document';
  return s + '.md';
}
// 本機 git commit（只在 sop-files repo；不 push）。best-effort，失敗不擋審核。
function gitCommitSopFiles(message) {
  try {
    const dir = config.SOP_FILES_DIR;
    execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'pipe' });
    execFileSync('git', ['-C', dir, '-c', 'user.name=AI SOP Review', '-c', 'user.email=ai-sop@local', 'commit', '-m', message], { stdio: 'pipe' });
    return true;
  } catch (e) { console.warn('[git] commit 略過'); return false; }
}

// ══════════ 直接寫入 / 刪除正式文件（內網 + 密碼，跳過待審）══════════
app.post('/sop-files', internalOnly, async (req, res) => {
  try {
    if (!checkPassword(req)) return res.status(403).json({ error: '需要審核密碼' });
    const { filename, content, editor } = req.body || {};
    if (!filename || typeof content !== 'string') return res.status(400).json({ error: 'filename 與 content 必填' });
    let safe = path.basename(filename); if (!safe.toLowerCase().endsWith('.md')) safe += '.md';
    fs.writeFileSync(path.join(config.SOP_FILES_DIR, safe), content, 'utf8');
    const n = await rag.reindexFile(safe);
    gitCommitSopFiles(`${editor || '某人'} 持密碼直接更新：${safe}`);
    res.json({ ok: true, filename: safe, chunks: n, direct: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/sop-files/delete', internalOnly, async (req, res) => {
  try {
    if (!checkPassword(req)) return res.status(403).json({ error: '需要審核密碼' });
    const { filename, editor, reason } = req.body || {};
    if (!filename) return res.status(400).json({ error: 'filename 必填' });
    let safe = path.basename(filename); if (!safe.toLowerCase().endsWith('.md')) safe += '.md';
    const full = path.join(config.SOP_FILES_DIR, safe);
    if (!fs.existsSync(full)) return res.status(404).json({ error: '找不到此文件' });
    fs.unlinkSync(full); await rag.removeFile(safe);
    gitCommitSopFiles(`${editor || '某人'} 持密碼直接刪除：${safe}${reason ? `（理由：${String(reason).slice(0, 80)}）` : ''}`);
    res.json({ ok: true, filename: safe, deleted: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════ AI 預檢（投稿當下跑）══════════
// 七段標題檢查（接受同義詞），只在 doc_type=SOP 套用。
function templateCheck(md) {
  const groups = [['一句話核心總結', '一句話說明', '一句話重點'], ['適用對象'], ['前置準備'],
    ['標準步驟', '主要內容'], ['異常處理'], ['常見問題', 'FAQ'], ['維護資訊']];
  const labels = ['一句話總結', '適用對象', '前置準備', '標準步驟', '異常處理', '常見問題FAQ', '維護資訊'];
  const missing = [];
  groups.forEach((alts, i) => { if (!alts.some(a => String(md || '').includes(a))) missing.push(labels[i]); });
  return { complete: missing.length === 0, missing };
}
// 去模板骨架，只留實際填寫內容（用於內容充實度 + 重複偵測，避免共用模板把相似度灌高）。
const SECTION_TITLE_RE = /^#{1,6}\s*(一句話核心總結|一句話說明|一句話重點|適用對象|前置準備|標準步驟|主要內容|異常處理|常見問題\s*FAQ|常見問題|FAQ|維護資訊|參考圖片|資訊內容)\s*$/;
const PLACEHOLDER_RE = /（[^）]*(未填|無特殊|暫無|尚未|待補|無法顯示|無法推導|無法生成|未命名)[^）]*）/g;
function stripTemplate(md) {
  let t = String(md || '').replace(/^---\n[\s\S]*?\n---\n?/, '');
  const out = [];
  for (let line of t.split('\n')) {
    let l = line.trim(); if (!l) continue;
    if (SECTION_TITLE_RE.test(l)) continue;
    if (/^\|?\s*:?-{2,}/.test(l)) continue;
    l = l.replace(/^#{1,6}\s*/, '').replace(/^>\s*/, '').replace(/^[*\-+]\s*/, '');
    l = l.replace(/\*\*/g, '').replace(/\|/g, ' ').replace(/!\[[^\]]*\]\([^)]*\)/g, '');
    l = l.replace(PLACEHOLDER_RE, '').replace(/^（無）$/, '');
    l = l.replace(/^(執行人|操作位置|具體動作|完成指標|注意事項|系統權限|硬體\/工具|必要資料|適用對象|適用情境|不適用對象|不適用情境|部門|重要程度|預計耗時|最後更新|文件負責人|職務代理人|相關附件)\s*[:：]\s*/, '');
    l = l.replace(/\s+/g, ' ').trim();
    if (l) out.push(l);
  }
  return out.join('\n');
}
function sections(md) {
  const map = {};
  const canon = [['一句話總結', /一句話(核心總結|說明|重點)/], ['適用對象', /適用對象/], ['前置準備', /前置準備/],
    ['標準步驟', /標準步驟|主要內容/], ['異常處理', /異常處理/], ['常見問題FAQ', /常見問題|FAQ/], ['維護資訊', /維護資訊/]];
  let cur = null, buf = [];
  const flush = () => { if (cur) map[cur] = (map[cur] || '') + '\n' + buf.join('\n'); buf = []; };
  for (const line of String(md || '').split('\n')) {
    if (/^#{1,2}\s/.test(line)) { flush(); const txt = line.replace(/^#{1,6}\s*/, '').trim(); const hit = canon.find(([, re]) => re.test(txt)); cur = hit ? hit[0] : null; }
    else if (cur) buf.push(line);
  }
  flush(); return map;
}
function detectDocType(md, typeParam) {
  const m = String(md || '').match(/^---[\s\S]*?\bdoc_type:\s*"?([A-Za-z_]+)"?/);
  if (m) return m[1].toUpperCase();
  return typeParam ? String(typeParam).toUpperCase() : 'SOP';
}
// 變更摘要：相對舊版的行級增刪（確定性，不靠 LLM）。
function changeSummary(newMd, oldMd) {
  if (oldMd == null) return '找不到原檔，將視為新增內容處理';
  const oldSet = new Set(String(oldMd).split('\n')), newSet = new Set(String(newMd).split('\n'));
  const added = String(newMd).split('\n').filter(l => l.trim() && !oldSet.has(l));
  const removed = String(oldMd).split('\n').filter(l => l.trim() && !newSet.has(l));
  if (!added.length && !removed.length) return '內容與原檔相同（無實質變更）';
  let s = `新增 ${added.length} 行、刪除 ${removed.length} 行`;
  const peek = (arr) => arr.map(x => x.replace(/^#+\s*/, '').trim()).filter(Boolean).join('｜').slice(0, 80);
  if (added.length && added.length <= 3) s += `（新增：${peek(added)}）`;
  else if (removed.length && removed.length <= 3 && !added.length) s += `（刪除：${peek(removed)}）`;
  return s;
}
// 內容充實度（SOP 才額外檢查七段空泛）。
function contentCheck(md, docType) {
  const issues = []; const all = stripTemplate(md).replace(/\s/g, '');
  if (all.length < 50) issues.push('整體實質內容過少');
  if (all.length >= 8 && new Set(all.split('')).size <= 4) issues.push('內容疑似佔位（同字大量重複）');
  if (docType === 'SOP') {
    const sec = sections(md);
    const need = { '一句話總結': [10, '一句話總結'], '適用對象': [4, '適用對象'], '標準步驟': [15, '標準步驟的具體動作'], '常見問題FAQ': [8, 'FAQ'] };
    const thin = [];
    for (const k of Object.keys(need)) { const [min, label] = need[k]; if (stripTemplate(sec[k] || '').replace(/\s/g, '').length < min) thin.push(label); }
    if (thin.length) issues.push('偏空泛、建議補充：' + thin.join('、'));
  }
  if (/無法推導|無法生成回答|尚未填寫\s*FAQ/.test(md)) issues.push('FAQ 含佔位回覆');
  return { substantial: issues.length === 0, issues };
}
// 重複偵測（去模板後 embedding cosine）。校準：真不相關 ~0.46–0.52、同領域 ~0.77、近雙胞胎 ~0.91。
const _docVecCache = new Map();
async function docContentVec(file) {
  const key = file.id + ':' + file.content.length;
  if (_docVecCache.has(key)) return _docVecCache.get(key);
  const vec = await llm.embed(stripTemplate(file.content).slice(0, 1500), 'RETRIEVAL_DOCUMENT');
  _docVecCache.set(key, vec); return vec;
}
const DUP_LIST_THRESHOLD = 0.78; // 列出「較相似」參考
const DUP_FLAG_THRESHOLD = 0.88; // 標「疑似重複」警示
async function dupCheck(md, excludeName) {
  try {
    const vec = await llm.embed(stripTemplate(md).slice(0, 1500), 'RETRIEVAL_QUERY');
    const scored = [];
    for (const f of rag.listSopFiles()) {
      if (excludeName && f.name === excludeName) continue; // modify 時排除自己
      scored.push({ doc: f.name, score: +(+rag.cosineSimilarity(vec, await docContentVec(f))).toFixed(3) });
    }
    scored.sort((a, b) => b.score - a.score);
    return { duplicates: scored.filter(d => d.score >= DUP_LIST_THRESHOLD).slice(0, 3), dupFlag: scored.length > 0 && scored[0].score >= DUP_FLAG_THRESHOLD };
  } catch (e) { return { duplicates: [], dupFlag: false, error: e.message }; }
}
async function runPrecheck(md, op, title, type) {
  if (op === 'delete') return { op: 'delete', docType: detectDocType(md, type), template: { complete: true, missing: [] }, content: { substantial: true, issues: [] }, duplicates: [], dupFlag: false, badge: '🟢' };
  const docType = detectDocType(md, type), isSop = docType === 'SOP';
  if (op === 'modify') {
    const targetName = safeMdName(title);
    const oldMd = fs.existsSync(path.join(config.SOP_FILES_DIR, targetName)) ? fs.readFileSync(path.join(config.SOP_FILES_DIR, targetName), 'utf8') : null;
    const targetMissing = oldMd == null; // 改名/已刪 → 核准會新建孤兒檔，警告
    const dup = await dupCheck(md, targetName);
    return { op: 'modify', docType, changeSummary: changeSummary(md, oldMd), targetMissing, duplicates: dup.dupFlag ? dup.duplicates : [], dupFlag: dup.dupFlag, badge: (dup.dupFlag || targetMissing) ? '🟡' : '🟢' };
  }
  // op = new
  const template = isSop ? templateCheck(md) : { complete: true, missing: [], na: true };
  const content = contentCheck(md, docType);
  const dup = await dupCheck(md);
  const nameCollision = fs.existsSync(path.join(config.SOP_FILES_DIR, safeMdName(title))); // 撞名 → 核准會覆蓋
  const structureOk = isSop ? template.complete : true;
  const badge = (structureOk && content.substantial && !dup.dupFlag && !nameCollision) ? '🟢' : '🟡';
  return { op: 'new', docType, template, content, nameCollision, duplicates: dup.duplicates, dupFlag: dup.dupFlag, badge };
}

// ══════════ 待審區 ══════════
// 三入口共用落地：投稿先進 pending（不落 sop-files/）。
app.post('/sop-pending', internalOnly, async (req, res) => {
  try {
    const { name, md, submitter, type, op, source, reason } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name（標題）必填' });
    const operation = op || 'new';
    if (operation !== 'delete' && (typeof md !== 'string' || !md.trim())) return res.status(400).json({ error: 'md（內容）必填' });
    const precheck = await runPrecheck(md || '', operation, String(name).trim(), type);
    const id = dbm.insertPending({ title: String(name).trim(), type: type || 'SOP', op: operation, submitter: submitter || '',
      md: md || '', precheck: JSON.stringify(precheck), source: source || '', comment: (operation === 'delete' && reason) ? ('刪除理由：' + String(reason)) : null });
    res.json({ ok: true, id, precheck });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
const safeParse = (s) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };

// 待審件數（內網、免密碼）：只回數字、不含內容，給主頁徽章用。
app.get('/pending/count', internalOnly, (req, res) => {
  try { res.json({ count: dbm.listPending(req.query.status || '待審').length }); } catch (e) { res.status(500).json({ error: e.message }); }
});
// 清單（內網 + 密碼，含標題/投稿者）。
app.get('/pending', internalOnly, (req, res) => {
  try {
    if (!checkPassword(req)) return res.status(403).json({ error: '需要審核密碼' });
    res.json({ pending: dbm.listPending(req.query.status).map(r => ({
      id: r.id, title: r.title, type: r.type, op: r.op, submitter: r.submitter, status: r.status,
      source: r.source, comment: r.comment, created_at: r.created_at, decided_by: r.decided_by, decided_at: r.decided_at, precheck: safeParse(r.precheck) })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// 細節（內網 + 密碼，含 md 全文 + op=modify 的同名現有文件供新舊對照）。
app.get('/pending/:id', internalOnly, (req, res) => {
  try {
    if (!checkPassword(req)) return res.status(403).json({ error: '需要審核密碼' });
    const p = dbm.getPending(+req.params.id); if (!p) return res.status(404).json({ error: '找不到此投稿' });
    const safe = safeMdName(p.title), full = path.join(config.SOP_FILES_DIR, safe), currentExists = fs.existsSync(full);
    res.json({ ...p, precheck: safeParse(p.precheck), targetFilename: safe, currentExists, currentMd: currentExists ? fs.readFileSync(full, 'utf8') : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// 核准（需密碼）：寫 sop-files + git commit + 重新索引；含撞名/改名/刪不存在的防呆。
app.post('/pending/:id/approve', internalOnly, async (req, res) => {
  try {
    if (!checkPassword(req)) return res.status(403).json({ error: '密碼錯誤或未提供，審核未生效' });
    const p = dbm.getPending(+req.params.id); if (!p) return res.status(404).json({ error: '找不到此投稿' });
    if (p.status === '已上架') return res.status(409).json({ error: '此投稿已上架' });
    const reviewer = (req.body && req.body.reviewer) || '審核者';
    const safe = safeMdName(p.title), full = path.join(config.SOP_FILES_DIR, safe);

    if (p.op === 'delete') {
      if (!fs.existsSync(full)) return res.status(404).json({ error: `目標文件「${safe}」不存在，無法刪除。` }); // 防假成功
      fs.unlinkSync(full); await rag.removeFile(safe);
      gitCommitSopFiles(`審核刪除：${safe}`); dbm.decidePending(p.id, '已上架', reviewer, '已刪除文件');
      return res.json({ ok: true, op: 'delete', filename: safe });
    }
    const exists = fs.existsSync(full);
    // 撞名：新增卻已有同名 → 要明確確認覆蓋
    if (p.op === 'new' && exists && !(req.body && req.body.overwrite))
      return res.status(409).json({ error: `已存在同名文件「${safe}」，核准會覆蓋舊內容。如確定請再次確認。`, needConfirm: 'overwrite', filename: safe });
    // 改名孤兒：修改卻找不到原檔 → 要明確確認新建
    if (p.op === 'modify' && !exists && !(req.body && req.body.confirmNew))
      return res.status(409).json({ error: `找不到原檔「${safe}」，核准會新建一份。如確定請再次確認。`, needConfirm: 'confirmNew', filename: safe });

    const finalMd = (typeof req.body.md === 'string' && req.body.md.trim()) ? req.body.md : p.md;
    const edited = finalMd.trim() !== (p.md || '').trim();
    fs.writeFileSync(full, finalMd, 'utf8');
    const chunks = await rag.reindexFile(safe);
    gitCommitSopFiles(`${edited ? '經審核者修改後核准' : '審核核准'}：${safe}`);
    dbm.decidePending(p.id, '已上架', reviewer, edited ? '經審核者修改後核准' : '');
    res.json({ ok: true, filename: safe, chunks, edited });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// 退回（需密碼）。
app.post('/pending/:id/reject', internalOnly, async (req, res) => {
  try {
    if (!checkPassword(req)) return res.status(403).json({ error: '密碼錯誤或未提供' });
    const p = dbm.getPending(+req.params.id); if (!p) return res.status(404).json({ error: '找不到此投稿' });
    dbm.decidePending(p.id, '退回', (req.body && req.body.reviewer) || '審核者', (req.body && req.body.comment) || '');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// 恢復待審（需密碼）：退回→待審；或已上架→待審（撤回上架：移除檔案+重新索引+commit）。
app.post('/pending/:id/reopen', internalOnly, async (req, res) => {
  try {
    if (!checkPassword(req)) return res.status(403).json({ error: '密碼錯誤或未提供' });
    const p = dbm.getPending(+req.params.id); if (!p) return res.status(404).json({ error: '找不到此投稿' });
    let unpublished = false;
    if (p.status === '已上架' && p.op !== 'delete') {
      const safe = safeMdName(p.title), full = path.join(config.SOP_FILES_DIR, safe);
      if (fs.existsSync(full)) { fs.unlinkSync(full); await rag.removeFile(safe); gitCommitSopFiles(`撤回上架：${safe}`); unpublished = true; }
    }
    dbm.decidePending(p.id, '待審', (req.body && req.body.reviewer) || '審核者', '');
    res.json({ ok: true, unpublished });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// 完全刪除紀錄（需密碼）：只刪 pending log，不動正式文件。
app.post('/pending/:id/purge', internalOnly, (req, res) => {
  try {
    if (!checkPassword(req)) return res.status(403).json({ error: '密碼錯誤或未提供' });
    const p = dbm.getPending(+req.params.id); if (!p) return res.status(404).json({ error: '找不到此投稿' });
    dbm.deletePendingRow(p.id); res.json({ ok: true, id: p.id, wasStatus: p.status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════ 文件健康整理台（唯讀 + 密碼）══════════
function parseFrontmatter(md) {
  const fm = {}; const m = String(md || '').match(/^---\n([\s\S]*?)\n---/);
  if (m) for (const line of m[1].split('\n')) { const mm = line.match(/^([A-Za-z_]+):\s*(.*)$/); if (mm) fm[mm[1]] = mm[2].trim().replace(/^["']|["']$/g, ''); }
  let similar = [];
  if (fm.similar_docs) similar = fm.similar_docs.replace(/^\[|\]$/g, '').split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  let title = fm.title || ''; if (!title) { const h = String(md || '').match(/^#\s+(.+)$/m); title = h ? h[1].trim() : ''; }
  return { title, owner: fm.owner || '', version: fm.version || '', namespace: fm.namespace || '', doc_type: fm.doc_type || '', similar_docs: similar };
}
function bestChunkPair(ca, cb) {
  let best = { score: -1, a: '', b: '' };
  for (const x of ca) for (const y of cb) { const s = rag.cosineSimilarity(x.vector, y.vector); if (s > best.score) best = { score: s, a: (x.heading ? x.heading + '｜' : '') + x.content, b: (y.heading ? y.heading + '｜' : '') + y.content }; }
  return best;
}
const HEALTH_DUP_THRESHOLD = DUP_FLAG_THRESHOLD; // 0.88
const norm = (s) => String(s || '').toLowerCase().replace(/\.md$/, '').replace(/[\s（）()【】「」《》\[\]]/g, '').trim();

app.get('/sop-health', internalOnly, async (req, res) => {
  try {
    if (!checkPassword(req)) return res.status(403).json({ error: '需要審核密碼' });
    const files = rag.listSopFiles().map(f => ({ ...f, meta: parseFrontmatter(f.content) }));
    const chunksByDoc = {};
    for (const c of dbm.getAllChunks()) { if (c.model !== llm.embedModel() || !c.vector) continue; (chunksByDoc[c.docName] = chunksByDoc[c.docName] || []).push(c); }
    const dismissed = new Set(dbm.listDismissedHealth());
    const flags = [];
    const brief = (f) => ({ name: f.name, title: f.meta.title || f.name.replace(/\.md$/, ''), owner: f.meta.owner || '（未填）', version: f.meta.version || '（未填）' });

    // (a) 同名 / 近似重複（標題正規化相同 或 去模板 cosine ≥ 0.88）
    for (let i = 0; i < files.length; i++) for (let j = i + 1; j < files.length; j++) {
      const fi = files[i], fj = files[j];
      const sameTitle = norm(fi.meta.title || fi.name) === norm(fj.meta.title || fj.name);
      let docSim = 0; try { docSim = rag.cosineSimilarity(await docContentVec(fi), await docContentVec(fj)); } catch {}
      if (!sameTitle && docSim < HEALTH_DUP_THRESHOLD) continue;
      const sig = 'dup:' + [fi.name, fj.name].sort().join('|'); if (dismissed.has(sig)) continue;
      const ev = bestChunkPair(chunksByDoc[fi.name] || [], chunksByDoc[fj.name] || []);
      flags.push({ id: sig, type: 'duplicate', severity: 'high', sameTitle, docs: [brief(fi), brief(fj)],
        evidence: ev.score >= 0 ? { aDoc: brief(fi).title, a: ev.a.slice(0, 400), bDoc: brief(fj).title, b: ev.b.slice(0, 400), segScore: Math.round(ev.score * 100) } : null });
    }

    // (b) 引用失效（similar_docs + 內文《...》對不到任何真實文件名）
    const knownNames = files.map(f => [norm(f.meta.title), norm(f.name)]).flat().filter(Boolean);
    const resolves = (r) => { const nr = norm(r); return nr.length >= 3 && knownNames.some(k => k && k.includes(nr)); }; // 只認單向（較準）
    for (const f of files) {
      const lines = f.content.split('\n'); const refs = [];
      for (const sd of f.meta.similar_docs) refs.push({ ref: sd, line: (lines.find(l => l.includes('similar_docs')) || ('similar_docs: ' + sd)).trim() });
      lines.forEach(l => { const re = /《([^》]{2,40})》/g; let mm; while ((mm = re.exec(l)) !== null) refs.push({ ref: mm[1].replace(/[\[\]]/g, '').trim(), line: l.trim() }); });
      for (const { ref, line } of refs) {
        if (!ref || resolves(ref)) continue;
        const sig = 'ref:' + f.name + '|' + ref; if (dismissed.has(sig)) continue;
        flags.push({ id: sig, type: 'reference', severity: 'medium', docs: [brief(f)], ref, evidence: { file: brief(f).title, line: line.slice(0, 300) } });
      }
    }

    // (c) 自相矛盾（讀 on-demand 掃描結果）
    const fileByName = new Map(files.map(f => [f.name, f]));
    let contraScanned = false; const contras = dbm.listContradictions(); if (contras.length) contraScanned = true;
    for (const c of contras) {
      if (dismissed.has(c.sig)) continue;
      const fa = fileByName.get(c.doc_a), fb = fileByName.get(c.doc_b); if (!fa || !fb) continue;
      flags.push({ id: c.sig, type: 'contradiction', severity: 'high', docs: [brief(fa), brief(fb)], evidence: { aDoc: brief(fa).title, a: c.quote_a, bDoc: brief(fb).title, b: c.quote_b, why: c.why } });
    }

    flags.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'high' ? -1 : 1));
    res.json({ ok: true, fileCount: files.length, dupThreshold: Math.round(HEALTH_DUP_THRESHOLD * 100), contraScanned, flags });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/sop-health/dismiss', internalOnly, (req, res) => {
  try { if (!checkPassword(req)) return res.status(403).json({ error: '密碼錯誤或未提供' });
    const { flagId } = req.body || {}; if (!flagId) return res.status(400).json({ error: 'flagId 必填' });
    dbm.dismissHealth(String(flagId)); res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 自相矛盾偵測（on-demand、嚴謹、雙引文驗證、寧漏不誤）──
const CONTRA_LOW = 0.80, CONTRA_HIGH = 0.97; // 候選相似度帶：≥0.97 視為重複交給 (a)
const _normTxt = (s) => String(s || '').replace(/\s/g, '');
function verifyQuote(q, text) { return typeof q === 'string' && q.trim().length >= 4 && _normTxt(text).includes(_normTxt(q)); }
async function askJSON(sys, user) { try { const raw = await llm.chatComplete(sys, [], user); const m = raw.match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null; } catch { return null; } }
const CONTRA_SYS = '你是嚴謹的 SOP 稽核員。只判斷「A 段與 B 段是否就『同一個操作/規則』給出互相衝突的指示／數字／條件／期限」。'
  + '只有當你能從 A、B「各引出一句互相衝突的原文」時才算矛盾。語氣/用詞不同、各講各的、互補、僅相似但不衝突 → 不算矛盾。'
  + '不要把「各文件各自的中繼資料不同」（最後更新日期、版本、負責人、檔名、部門）當矛盾；也不要把「不同流程/不同產品」當矛盾。'
  + '只輸出 JSON：{"conflict":true或false,"quoteA":"A段原文一句","quoteB":"B段原文一句","why":"一句話說明"}。引文必須一字不差，引不出就 conflict:false。';
function isMetaChunk(c) { return /維護資訊|版本資訊|文件資訊/.test(c.heading || '') || /最後更新|文件負責人|職務代理人|^version:|^owner:/m.test(c.content || ''); }
async function judgeContradiction(nameA, textA, nameB, textB) {
  const user = `【A：《${nameA}》】\n${textA}\n\n【B：《${nameB}》】\n${textB}`;
  const v1 = await askJSON(CONTRA_SYS, user);
  if (!v1 || !v1.conflict || !verifyQuote(v1.quoteA, textA) || !verifyQuote(v1.quoteB, textB)) return null;
  const v2 = await askJSON(CONTRA_SYS + '\n再次嚴格複核：若不是「同一件事的直接衝突」一律 conflict:false。', user); // 自我複核
  if (!v2 || !v2.conflict || !verifyQuote(v2.quoteA, textA) || !verifyQuote(v2.quoteB, textB)) return null;
  return { quoteA: v2.quoteA, quoteB: v2.quoteB, why: String(v2.why || '').slice(0, 200) };
}
// 背景掃描 + 進度輪詢（不卡請求；不設候選上限，覆蓋率隨文件成長）。
let contraScan = { running: false, total: 0, scanned: 0, found: 0, error: null, finishedAt: 0 };
app.post('/sop-health/contradictions/scan', internalOnly, async (req, res) => {
  try {
    if (!checkPassword(req)) return res.status(403).json({ error: '需要審核密碼' });
    if (contraScan.running) return res.json({ ok: true, running: true, total: contraScan.total, scanned: contraScan.scanned });
    const chunksByDoc = {};
    for (const c of dbm.getAllChunks()) { if (c.model !== llm.embedModel() || !c.vector || isMetaChunk(c)) continue; (chunksByDoc[c.docName] = chunksByDoc[c.docName] || []).push(c); }
    const names = Object.keys(chunksByDoc); const cands = [];
    for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
      let best = null;
      for (const x of chunksByDoc[names[i]]) for (const y of chunksByDoc[names[j]]) { const s = rag.cosineSimilarity(x.vector, y.vector); if (s >= CONTRA_LOW && s < CONTRA_HIGH && (!best || s > best.s)) best = { s, a: x, b: y }; }
      if (best) cands.push({ docA: names[i], docB: names[j], a: best.a, b: best.b, s: best.s });
    }
    cands.sort((p, q) => q.s - p.s);
    contraScan = { running: true, total: cands.length, scanned: 0, found: 0, error: null, finishedAt: 0 };
    res.json({ ok: true, started: true, total: cands.length });
    (async () => {
      const found = [];
      try {
        for (const cd of cands) {
          const v = await judgeContradiction(cd.docA, cd.a.content, cd.docB, cd.b.content);
          if (v) {
            const qhash = crypto.createHash('md5').update([_normTxt(v.quoteA || ''), _normTxt(v.quoteB || '')].sort().join('|')).digest('hex').slice(0, 8);
            found.push({ sig: 'con:' + [cd.docA, cd.docB].sort().join('|') + '|' + qhash, doc_a: cd.docA, doc_b: cd.docB, quote_a: v.quoteA, quote_b: v.quoteB, why: v.why });
            contraScan.found = found.length;
          }
          contraScan.scanned++;
        }
        dbm.replaceContradictions(found);
      } catch (e) { contraScan.error = e.message; }
      finally { contraScan.running = false; contraScan.finishedAt = Date.now(); }
    })();
  } catch (e) { contraScan.running = false; if (!res.headersSent) res.status(500).json({ error: e.message }); }
});
app.get('/sop-health/contradictions/status', internalOnly, (req, res) => {
  if (!checkPassword(req)) return res.status(403).json({ error: '需要審核密碼' });
  res.json({ ok: true, ...contraScan });
});

// ══════════ RAG 問答 ══════════
const NO_DATA_MSG = '這個問題我目前的資料裡沒有，建議詢問主管。\n\n【資料來源：無】';
const RETRY_MSG = '系統忙線中或模型正在載入，請稍等約 10 秒後再問一次 🙏';
const URL_RE = /https?:\/\/[^\s)\]」』，。、）]+/g;
function contextUrls(text) { return (String(text || '').match(URL_RE) || []); }
// URL 白名單過濾：只留 allowed 內的連結（命中來源文件的 URL）。
function stripDisallowedUrls(md, allowed) {
  return String(md || '').split('\n').map(line => {
    line = line.replace(URL_RE, (u) => allowed.has(u) ? u : '');
    return /^相關連結\s*[:：]?$/.test(line.trim()) ? null : line;
  }).filter(l => l !== null).join('\n').replace(/\n{3,}/g, '\n\n');
}
// 串流：尾端正在形成 URL/markdown 連結時 hold，其餘立刻放行。
function safeCut(buf) {
  let cut = buf.length;
  const h = buf.lastIndexOf('http'); if (h >= 0 && !/[\s)\]」』，。、）]/.test(buf.slice(h + 4))) cut = Math.min(cut, h);
  const b = buf.lastIndexOf('['); if (b >= 0 && buf.indexOf(')', b) < 0) cut = Math.min(cut, b);
  return cut;
}
// LINE 追問偵測：很短 + 含指代詞 → 追問。
const FOLLOWUP_PRONOUN = /那|這個|這|它|前面|上面|剛剛|剛才|第[一二三四五六七八九十百千兩0-9]+[步點項個條]|然後|接下來|繼續|再來|還有/;
function isFollowUp(message) { const m = String(message || '').trim(); if (!m.length || m.length > 14) return false; return FOLLOWUP_PRONOUN.test(m) || /呢[?？]?$/.test(m); }

// 共用：檢索 + 組 context。LINE 採「聰明記憶」；網站一律帶歷史、檢索只用當前句。
async function prepareAsk(body) {
  const { sessionId, message, personalContext, docIds, client } = body || {};
  const sid = sessionId || 'anonymous'; const isLine = client === 'line';
  let history = [], retrievalQuery = message;
  if (isLine) {
    const idle = (Date.now() - dbm.lastMessageAt(sid)) > config.LINE_IDLE_MS;
    const recent = idle ? [] : dbm.getRecentMessages(sid, config.LINE_FOLLOWUP_TURNS * 2);
    if (!idle && recent.length && isFollowUp(message)) {
      const lastUser = [...recent].reverse().find(m => m.role === 'user');
      if (lastUser) retrievalQuery = `${lastUser.content} ${message}`; // 脈絡化（僅追問）
      history = recent;
    }
  } else { history = dbm.getRecentMessages(sid, config.HISTORY_TURNS * 2); }
  const r = await rag.retrieve(retrievalQuery, docIds);
  if (!r.hasMatch && !personalContext) return { sid, history, r, noData: true }; // 誠實度不被歷史繞過
  const sopContext = r.hasMatch ? r.context : '（目前沒有相關的 SOP 文件）';
  const fullContext = personalContext ? `${sopContext}\n\n---\n\n${personalContext}` : sopContext;
  return { sid, history, r, modelMessage: `參考資料：\n${fullContext}\n\n━━━\n使用者問題：${message}`, noData: false };
}

// 非串流（LINE / n8n）。
app.post('/ask', async (req, res) => {
  try {
    const { message, client } = req.body || {};
    if (!message || !message.trim()) return res.status(400).json({ error: 'message 必填' });
    const isLine = client === 'line' || (req.query && req.query.format === 'plain');
    const p = await prepareAsk(req.body);
    if (p.noData) { dbm.addMessage(p.sid, 'user', message); dbm.addMessage(p.sid, 'assistant', NO_DATA_MSG); return res.json({ answer: NO_DATA_MSG, sources: [], images: [] }); }
    let raw;
    try { raw = await llm.chatComplete(rag.SYSTEM_PROMPT, p.history, p.modelMessage); }
    catch (e) { return res.json({ answer: RETRY_MSG, sources: [], images: [], retry: true }); } // 不把空答案配來源送出
    const allowedUrls = new Set([...(p.r.sourceUrls || []), ...contextUrls(p.modelMessage)]);
    const answer = stripDisallowedUrls(raw, allowedUrls);
    if (!answer.trim()) return res.json({ answer: RETRY_MSG, sources: [], images: [], retry: true });
    dbm.addMessage(p.sid, 'user', message); dbm.addMessage(p.sid, 'assistant', answer);
    res.json({ answer, sources: p.r.sources, images: p.r.images }); // LINE 模式可再轉純文字
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// 串流（SSE，網頁版）：首字在 prefill 結束就出現。
app.post('/ask/stream', async (req, res) => {
  const { message } = req.body || {};
  if (!message || !message.trim()) return res.status(400).json({ error: 'message 必填' });
  res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive');
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  try {
    const p = await prepareAsk(req.body);
    if (p.noData) { send({ type: 'token', t: NO_DATA_MSG }); dbm.addMessage(p.sid, 'user', message); dbm.addMessage(p.sid, 'assistant', NO_DATA_MSG); send({ type: 'done', sources: [] }); return res.end(); }
    const allowedUrls = new Set([...(p.r.sourceUrls || []), ...contextUrls(p.modelMessage)]);
    let hold = '', filteredFull = '';
    const full = await llm.chatStream(rag.SYSTEM_PROMPT, p.history, p.modelMessage, (t) => {
      hold += t; const cut = safeCut(hold);
      if (cut > 0) { const out = stripDisallowedUrls(hold.slice(0, cut), allowedUrls); hold = hold.slice(cut); if (out) { filteredFull += out; send({ type: 'token', t: out }); } }
    });
    if (hold) { const out = stripDisallowedUrls(hold, allowedUrls); if (out) { filteredFull += out; send({ type: 'token', t: out }); } }
    if (!filteredFull.trim()) send({ type: 'token', t: RETRY_MSG });
    dbm.addMessage(p.sid, 'user', message); dbm.addMessage(p.sid, 'assistant', filteredFull || RETRY_MSG);
    send({ type: 'done', sources: p.r.sources, images: p.r.images }); res.end();
  } catch (e) { send({ type: 'token', t: RETRY_MSG }); send({ type: 'done', sources: [] }); res.end(); }
});
// 內網生成器用：純對話（無 RAG）。
app.post('/chat', async (req, res) => {
  try {
    const { system, history, message } = req.body || {};
    if (!message) return res.status(400).json({ error: 'message 必填' });
    const reply = await llm.chatComplete(system || '你是助理。', history || [], message);
    res.json({ reply });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════ 啟動：索引 + 監看 + 預熱 ══════════
async function buildIndexInBackground() {
  const emb = await llm.initEmbed();
  if (!emb.dim) { console.warn(`⚠ Embedding 連不上：${emb.error || '未知'}`); return; }
  const purged = dbm.purgeChunksNotModel(llm.embedModel()); // 換模型 → 清舊維度向量
  if (purged > 0) console.log(`↻ 清除 ${purged} 筆舊模型向量`);
  try { const r = await rag.syncIndex(); console.log(`✓ 索引同步：共 ${r.total}，新 ${r.indexed}，沿用 ${r.skipped}，失敗 ${r.failed}`); }
  catch (e) { console.warn(`⚠ 索引同步失敗：${e.message}`); }
}
async function start() {
  try { await llm.ping(); } catch (e) { console.warn(`⚠ Ollama 連線失敗：${e.message}`); }
  try { await llm.pingChat(); } catch (e) { console.warn(`⚠ 對話服務連線失敗：${e.message}`); }
  // chokidar 監看 sop-files/：新增/修改/刪除自動重新索引（與發布時的主動 reindex 互為雙保險）。
  const watcher = chokidar.watch(config.SOP_FILES_DIR, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 } });
  const onChange = async (fp) => { const fn = path.basename(fp); if (!fn.toLowerCase().endsWith('.md')) return; try { await rag.reindexFile(fn); } catch (e) {} };
  watcher.on('add', onChange).on('change', onChange).on('unlink', (fp) => { const fn = path.basename(fp); if (fn.toLowerCase().endsWith('.md')) rag.removeFile(fn); });

  app.listen(config.PORT, config.HOST, () => {
    console.log(`✓ SOP service 啟動：http://${config.HOST}:${config.PORT}`);
    buildIndexInBackground();
    llm.warmup().then(ok => console.log(ok ? '✓ 對話模型預熱完成' : '⚠ 對話模型預熱失敗'));
    if (config.CHAT_WARM_INTERVAL_MS > 0) setInterval(() => { llm.warmup().catch(() => {}); }, config.CHAT_WARM_INTERVAL_MS).unref(); // 保溫
  });
}
start();

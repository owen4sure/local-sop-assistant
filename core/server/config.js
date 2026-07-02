// 集中設定。所有可換值都走環境變數（見 .env.example），fallback 為佔位/安全預設。
// ⚠️ 機密（審核密碼、CHAT_API_KEY）一律不寫死進原始碼。
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..'); // 專案根目錄

// 審核密碼：優先讀環境變數，否則讀 gitignored 的 .review-password 檔（不寫死進會 commit 的原始碼）。
function loadReviewPassword() {
  if (process.env.REVIEW_PASSWORD) return process.env.REVIEW_PASSWORD;
  try { return fs.readFileSync(path.join(__dirname, '.review-password'), 'utf8').trim(); }
  catch (e) { return ''; } // 都沒有 → 空字串 → 所有寫入/審核 API 一律 403
}

module.exports = {
  REVIEW_PASSWORD: loadReviewPassword(),
  PORT: parseInt(process.env.PORT || '<PORT>', 10),
  HOST: process.env.HOST || '0.0.0.0',

  // 對外網域（透過反向代理/通道對外時）。命中這些 hostname 視為「外網」→ 寫入類 API 擋下。
  PUBLIC_HOSTNAMES: (process.env.PUBLIC_HOSTNAMES || '<PUBLIC_HOSTNAME>')
    .split(',').map(s => s.trim()).filter(Boolean),

  // ── Embedding：本機 Ollama（多語、中文檢索強；維度以模型實際輸出為準，不寫死）──
  OLLAMA_URL: process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
  EMBED_MODEL: process.env.EMBED_MODEL || '<EMBED_MODEL_NAME>',
  EMBED_KEEP_ALIVE: process.env.EMBED_KEEP_ALIVE || '30m',

  // ── 對話：OpenAI 相容 /v1/chat/completions（本機推論引擎）──
  CHAT_URL: process.env.CHAT_URL || 'http://127.0.0.1:<CHAT_PORT>/v1',
  CHAT_API_KEY: process.env.CHAT_API_KEY || '<CHAT_API_KEY>',
  CHAT_MODEL: process.env.CHAT_MODEL || '<CHAT_MODEL_NAME>',
  CHAT_TEMPERATURE: parseFloat(process.env.CHAT_TEMPERATURE || '0.3'),
  CHAT_MAX_TOKENS: parseInt(process.env.CHAT_MAX_TOKENS || '2048', 10),
  CHAT_TIMEOUT_MS: parseInt(process.env.CHAT_TIMEOUT_MS || '120000', 10), // 涵蓋冷載入
  CHAT_WARM_INTERVAL_MS: parseInt(process.env.CHAT_WARM_INTERVAL_MS || '240000', 10), // 保溫

  // 路徑
  WEB_DIR: path.join(ROOT, 'web'),
  SOP_FILES_DIR: path.join(ROOT, 'sop-files'),
  DB_PATH: path.join(ROOT, 'data', 'app.db'),
  LOG_DIR: path.join(ROOT, 'logs'),

  // ── RAG 參數（門檻針對「你的 embedding + reranker 分數分佈」校準，換模型要重調）──
  SIMILARITY_THRESHOLD: 0.5,  // reranker 掛掉時的純 cosine 門檻
  RERANKER_URL: process.env.RERANKER_URL || 'http://127.0.0.1:<RERANK_PORT>',
  USE_RERANKER: process.env.USE_RERANKER !== 'false',
  RERANK_CANDIDATES: parseInt(process.env.RERANK_CANDIDATES || '20', 10),
  // 命中閘門（見 rag.js）：reranker 有信心時用 rerank 分數，整題沒信心時才退回 cosine。
  RERANK_THRESHOLD: parseFloat(process.env.RERANK_THRESHOLD || '0.1'),
  COSINE_GATE: parseFloat(process.env.COSINE_GATE || '0.60'),
  MAX_CONTEXT_CHARS: parseInt(process.env.MAX_CONTEXT_CHARS || '2000', 10),
  TOP_N_CHUNKS: parseInt(process.env.TOP_N_CHUNKS || '5', 10),
  TOP_N_DOCS: parseInt(process.env.TOP_N_DOCS || '5', 10),
  EMBED_INPUT_CHARS: parseInt(process.env.EMBED_INPUT_CHARS || '3000', 10),
  HISTORY_TURNS: parseInt(process.env.HISTORY_TURNS || '6', 10),
  LINE_FOLLOWUP_TURNS: parseInt(process.env.LINE_FOLLOWUP_TURNS || '2', 10),
  LINE_IDLE_MS: parseInt(process.env.LINE_IDLE_MS || String(30 * 60 * 1000), 10),
};

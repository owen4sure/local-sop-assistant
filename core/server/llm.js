// 本機模型存取（全部 127.0.0.1）：
//   - 對話：OpenAI 相容 /v1/chat/completions（:<CHAT_PORT>）
//   - Embedding：Ollama /api/embed（:11434）
//   - Reranker：本機 cross-encoder 小服務（:<RERANK_PORT>）
const config = require('./config');
const {
  OLLAMA_URL, EMBED_MODEL, EMBED_INPUT_CHARS, EMBED_KEEP_ALIVE,
  CHAT_URL, CHAT_API_KEY, CHAT_MODEL, CHAT_TEMPERATURE, CHAT_MAX_TOKENS, CHAT_TIMEOUT_MS,
} = config;

let _embedModel = EMBED_MODEL;
let _embedDim = null;

async function ollamaFetch(pathname, body) {
  const res = await fetch(`${OLLAMA_URL}${pathname}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Ollama ${pathname} ${res.status}`);
  return res.json();
}

// 某些 embedding 模型（如 nomic 系）需要任務前綴才會校準向量，否則任何 query 跟所有文件都 ~0.7（門檻失效）。
// 文件用 search_document:、查詢用 search_query:。目前的多語模型不需前綴 → 自動略過。
function applyEmbedPrefix(text, taskType) {
  if (!/nomic/i.test(EMBED_MODEL)) return text;
  if (taskType === 'RETRIEVAL_QUERY') return `search_query: ${text}`;
  if (taskType === 'RETRIEVAL_DOCUMENT') return `search_document: ${text}`;
  return text;
}

// ── Embedding ──
async function embed(text, taskType) {
  const input = applyEmbedPrefix((text || '').slice(0, EMBED_INPUT_CHARS), taskType);
  const data = await ollamaFetch('/api/embed', { model: EMBED_MODEL, input, keep_alive: EMBED_KEEP_ALIVE });
  const vec = data.embeddings && data.embeddings[0];
  if (!vec || !Array.isArray(vec)) throw new Error('embed 回傳格式異常');
  _embedDim = vec.length; // 維度動態偵測，不寫死
  return vec;
}

async function initEmbed() {
  try { const v = await embed('健康檢查 health check'); _embedDim = v.length; return { model: _embedModel, dim: _embedDim }; }
  catch (e) { return { model: _embedModel, dim: null, error: e.message }; }
}
function embedModel() { return _embedModel; }
function embedDim() { return _embedDim; }

// ── 對話（OpenAI 相容）──
function buildMessages(systemPrompt, history, userMessage) {
  return [
    { role: 'system', content: systemPrompt },
    ...(history || []).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
    { role: 'user', content: userMessage },
  ];
}

// 非串流。回傳模型實際生成字串（可能為空）——不在這硬塞 fallback，讓呼叫端分辨「冷載入空白」並重試。
async function chat(systemPrompt, history, userMessage) {
  const res = await fetch(`${CHAT_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CHAT_API_KEY}` },
    body: JSON.stringify({
      model: CHAT_MODEL, messages: buildMessages(systemPrompt, history, userMessage),
      temperature: CHAT_TEMPERATURE, max_tokens: CHAT_MAX_TOKENS, stream: false,
    }),
    signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`chat ${res.status}`);
  const data = await res.json();
  const c = data?.choices?.[0]?.message?.content;
  return typeof c === 'string' ? c : '';
}

// 冷啟動防呆：空白內容自動重試（重試時模型已被前一發載回）；全空才丟錯。
async function chatComplete(systemPrompt, history, userMessage, tries = 2) {
  let last = '';
  for (let i = 0; i < tries; i++) {
    last = await chat(systemPrompt, history, userMessage);
    if (last && last.trim()) return last;
  }
  throw new Error('模型連續回傳空白內容（可能正在載入）');
}

// 串流版：逐 token 呼叫 onToken(text)，回傳完整答案。解析 OpenAI SSE。
async function chatStream(systemPrompt, history, userMessage, onToken) {
  const res = await fetch(`${CHAT_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CHAT_API_KEY}` },
    body: JSON.stringify({
      model: CHAT_MODEL, messages: buildMessages(systemPrompt, history, userMessage),
      temperature: CHAT_TEMPERATURE, max_tokens: CHAT_MAX_TOKENS, stream: true,
    }),
  });
  if (!res.ok) throw new Error(`chat ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', full = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      let j; try { j = JSON.parse(payload); } catch { continue; }
      const t = j?.choices?.[0]?.delta?.content;
      if (t) { full += t; onToken(t); }
    }
  }
  return full || '抱歉，無法取得回答。';
}

async function warmup() { try { await chat('你是助理。', [], 'hi'); return true; } catch { return false; } }
async function ping() { const r = await fetch(`${OLLAMA_URL}/api/tags`); if (!r.ok) throw new Error('Ollama 無法連線'); return true; }
async function pingChat() {
  const r = await fetch(`${CHAT_URL}/models`, { headers: { 'Authorization': `Bearer ${CHAT_API_KEY}` }, signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw new Error('對話服務無法連線'); return true;
}
async function pingEmbed() { return ping(); }

// ── Reranker（本機 cross-encoder 小服務）──
const { RERANKER_URL } = config;
async function rerank(query, documents) {
  if (!documents || documents.length === 0) return [];
  const res = await fetch(`${RERANKER_URL}/rerank`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, documents }), signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Reranker ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data.scores)) throw new Error('Reranker 回傳格式異常');
  return data.scores;
}
async function pingRerank() { const r = await fetch(`${RERANKER_URL}/health`, { signal: AbortSignal.timeout(3000) }); if (!r.ok) throw new Error('reranker 無法連線'); return true; }

module.exports = {
  embed, initEmbed, embedModel, embedDim,
  chat, chatComplete, chatStream, warmup, ping, pingEmbed, pingChat,
  rerank, pingRerank, CHAT_MODEL,
};

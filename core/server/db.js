// SQLite 初始化與存取（better-sqlite3，單檔 + WAL）。
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { DB_PATH } = require('./config');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS chunks (
    id TEXT PRIMARY KEY,         -- \`\${docId}::\${index}\`
    doc_id TEXT NOT NULL,        -- 檔名（去 .md）
    doc_name TEXT NOT NULL,
    heading TEXT,
    content TEXT NOT NULL,
    images_json TEXT,            -- [{alt, url}]
    vector_json TEXT NOT NULL,   -- float[]
    sig TEXT NOT NULL,           -- 內容簽章，偵測變更
    model TEXT NOT NULL          -- 產生此向量的 embedding 模型名（換模型時用來清舊向量）
  );
  CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(doc_id);

  CREATE TABLE IF NOT EXISTS conversations (
    session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_conv_session ON conversations(session_id, created_at);

  -- 投稿待審區（內容只存 DB，不落 sop-files/，故檔案監看不會索引到）
  CREATE TABLE IF NOT EXISTS pending (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL, type TEXT,        -- SOP | FAQ | Ref
    op TEXT,                                -- new | modify | delete
    submitter TEXT, md TEXT,
    status TEXT NOT NULL,                   -- 待審 | 已上架 | 退回
    comment TEXT, precheck TEXT,            -- precheck: JSON
    source TEXT,                            -- line | web | generator ...
    created_at INTEGER NOT NULL, decided_by TEXT, decided_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_pending_status ON pending(status, created_at);

  -- 健康整理台：已消音（這不是問題）的 flag 簽章
  CREATE TABLE IF NOT EXISTS health_dismiss ( sig TEXT PRIMARY KEY, created_at INTEGER NOT NULL );

  -- 自相矛盾：on-demand 掃描結果（每次整批 replace）
  CREATE TABLE IF NOT EXISTS health_contradictions (
    sig TEXT PRIMARY KEY, doc_a TEXT, doc_b TEXT, quote_a TEXT, quote_b TEXT, why TEXT, created_at INTEGER NOT NULL
  );
`);

// FTS5（trigram tokenizer：支援中文子字串 + 英文專有名詞/縮寫的關鍵字檢索）
db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(chunk_id UNINDEXED, doc_id UNINDEXED, content, tokenize='trigram');`);

const stmtFtsDeleteDoc = db.prepare('DELETE FROM chunks_fts WHERE doc_id = ?');
const stmtFtsInsert = db.prepare('INSERT INTO chunks_fts (chunk_id, doc_id, content) VALUES (?, ?, ?)');
const stmtFtsClear = db.prepare('DELETE FROM chunks_fts');

function rebuildFts() {
  db.transaction(() => {
    stmtFtsClear.run();
    for (const r of db.prepare('SELECT id, doc_id, content FROM chunks').all()) stmtFtsInsert.run(r.id, r.doc_id, r.content);
  })();
  return db.prepare('SELECT COUNT(*) c FROM chunks_fts').get().c;
}
function ftsCount() { return db.prepare('SELECT COUNT(*) c FROM chunks_fts').get().c; }

// 問題切詞：空格(半/全形)、頓號、逗號、斜線、分號、冒號、各種括號都當「軟分隔」→ 空格版與標點版切出相同詞。
function ftsTerms(query) {
  return String(query || '')
    .split(/[\s　、，,。．｡；;：:|/\\~～「」『』（）()【】\[\]<>]+/)
    .map(t => t.trim()).filter(t => t.length >= 2)        // 過短丟掉；trigram 實際要 >=3 才命中
    .map(t => '"' + t.replace(/"/g, '""') + '"');         // 包成片語並跳脫
}
function ftsDocFreq(termPhrase) {
  try { return db.prepare('SELECT COUNT(DISTINCT doc_id) c FROM chunks_fts WHERE chunks_fts MATCH ?').get(termPhrase).c; } catch { return 0; }
}
// 關鍵字檢索：多詞 OR（不是 AND）；per-doc cap 避免常見詞灌爆；docFreq>60% 的通用/品牌詞丟棄。
function ftsSearch(query, limit = 20, perDocCap = 3) {
  const totalDocs = db.prepare('SELECT COUNT(DISTINCT doc_id) c FROM chunks_fts').get().c || 1;
  const tooCommon = Math.max(1, Math.ceil(totalDocs * 0.6));
  const terms = ftsTerms(query).filter(t => { const df = ftsDocFreq(t); return df > 0 && df <= tooCommon; });
  if (terms.length === 0) return [];
  const matchExpr = terms.join(' OR ');
  try {
    const rows = db.prepare('SELECT chunk_id, doc_id FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts) LIMIT ?').all(matchExpr, limit * 4);
    const perDoc = new Map(); const out = [];
    for (const r of rows) {
      const n = perDoc.get(r.doc_id) || 0;
      if (n >= perDocCap) continue;
      perDoc.set(r.doc_id, n + 1);
      out.push({ chunkId: r.chunk_id, rank: out.length });
      if (out.length >= limit) break;
    }
    return out;
  } catch { return []; }
}

// ── chunks ──
const stmtDeleteDocChunks = db.prepare('DELETE FROM chunks WHERE doc_id = ?');
const stmtInsertChunk = db.prepare(`INSERT OR REPLACE INTO chunks (id, doc_id, doc_name, heading, content, images_json, vector_json, sig, model)
  VALUES (@id, @doc_id, @doc_name, @heading, @content, @images_json, @vector_json, @sig, @model)`);
const stmtAllChunks = db.prepare('SELECT * FROM chunks');
const stmtDocSig = db.prepare('SELECT DISTINCT sig, model FROM chunks WHERE doc_id = ?');

function replaceDocChunks(docId, chunkRows) {
  db.transaction((rows) => {
    stmtDeleteDocChunks.run(docId); stmtFtsDeleteDoc.run(docId);
    for (const r of rows) { stmtInsertChunk.run(r); stmtFtsInsert.run(r.id, r.doc_id, r.content); }
  })(chunkRows);
}
function deleteDocChunks(docId) { stmtDeleteDocChunks.run(docId); stmtFtsDeleteDoc.run(docId); }
function purgeChunksNotModel(model) { return db.prepare('DELETE FROM chunks WHERE model IS NOT ?').run(model).changes; }
function getDocIndexState(docId) { return stmtDocSig.get(docId) || null; }
function getAllChunks() {
  return stmtAllChunks.all().map(r => ({
    id: r.id, docId: r.doc_id, docName: r.doc_name, heading: r.heading, content: r.content,
    images: r.images_json ? JSON.parse(r.images_json) : [], vector: JSON.parse(r.vector_json), sig: r.sig, model: r.model,
  }));
}

// ── conversations ──
const stmtInsertMsg = db.prepare('INSERT INTO conversations (session_id, role, content, created_at) VALUES (?, ?, ?, ?)');
const stmtRecentMsgs = db.prepare('SELECT role, content FROM conversations WHERE session_id = ? ORDER BY created_at DESC LIMIT ?');
const stmtLastMsgAt = db.prepare('SELECT created_at FROM conversations WHERE session_id = ? ORDER BY created_at DESC LIMIT 1');
function addMessage(sessionId, role, content) { stmtInsertMsg.run(sessionId, role, content, Date.now()); }
function getRecentMessages(sessionId, limit) { return stmtRecentMsgs.all(sessionId, limit).reverse().map(r => ({ role: r.role, content: r.content })); }
function lastMessageAt(sessionId) { const row = stmtLastMsgAt.get(sessionId); return row ? row.created_at : 0; }

// ── pending ──
const stmtInsertPending = db.prepare(`INSERT INTO pending (title, type, op, submitter, md, status, comment, precheck, source, created_at)
  VALUES (@title, @type, @op, @submitter, @md, '待審', @comment, @precheck, @source, @created_at)`);
function insertPending(p) {
  return stmtInsertPending.run({ title: p.title, type: p.type || 'SOP', op: p.op || 'new', submitter: p.submitter || '',
    md: p.md || '', comment: p.comment || null, precheck: p.precheck || '{}', source: p.source || '', created_at: Date.now() }).lastInsertRowid;
}
function listPending(status) {
  return status ? db.prepare('SELECT * FROM pending WHERE status = ? ORDER BY created_at DESC').all(status)
                : db.prepare('SELECT * FROM pending ORDER BY created_at DESC').all();
}
function getPending(id) { return db.prepare('SELECT * FROM pending WHERE id = ?').get(id); }
// 注意：核准/退回只 UPDATE status（永不刪 row）→ 動作可逆。
function decidePending(id, status, decidedBy, comment) {
  return db.prepare('UPDATE pending SET status = ?, decided_by = ?, comment = ?, decided_at = ? WHERE id = ?').run(status, decidedBy || '', comment || '', Date.now(), id);
}
function deletePendingRow(id) { return db.prepare('DELETE FROM pending WHERE id = ?').run(id); } // 只給「完全刪除紀錄(purge)」用

// ── health ──
function dismissHealth(sig) { db.prepare('INSERT OR IGNORE INTO health_dismiss (sig, created_at) VALUES (?, ?)').run(sig, Date.now()); }
function listDismissedHealth() { return db.prepare('SELECT sig FROM health_dismiss').all().map(r => r.sig); }
const _replaceContras = db.transaction((rows) => {
  db.prepare('DELETE FROM health_contradictions').run();
  const ins = db.prepare('INSERT INTO health_contradictions (sig, doc_a, doc_b, quote_a, quote_b, why, created_at) VALUES (@sig,@doc_a,@doc_b,@quote_a,@quote_b,@why,@created_at)');
  for (const r of rows) ins.run({ ...r, created_at: Date.now() });
});
function replaceContradictions(rows) { _replaceContras(rows); }
function listContradictions() { return db.prepare('SELECT * FROM health_contradictions').all(); }

module.exports = {
  db, replaceDocChunks, deleteDocChunks, purgeChunksNotModel, getDocIndexState, getAllChunks,
  rebuildFts, ftsCount, ftsSearch, ftsTerms, ftsDocFreq,
  addMessage, getRecentMessages, lastMessageAt,
  insertPending, listPending, getPending, decidePending, deletePendingRow,
  dismissHealth, listDismissedHealth, replaceContradictions, listContradictions,
};

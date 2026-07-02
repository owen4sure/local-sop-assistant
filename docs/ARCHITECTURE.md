# ARCHITECTURE — 元件、資料流、完整 RAG 管線

## 1. 元件

| 元件 | 技術 | 角色 |
|---|---|---|
| **Web/API backend** | Node.js + **Express** | host 前端靜態頁、提供所有 API、跑 RAG 檢索與治理邏輯 |
| **資料庫** | **better-sqlite3**（同步、單檔、WAL） | 向量 chunks、FTS5 全文索引、對話歷史、待審區、健康整理台結果 |
| **檔案監看** | **chokidar** | 監看 `sop-files/`，新增/修改/刪除 → 自動重新索引（含 `awaitWriteFinish` 去抖動） |
| **Embedding 服務** | **Ollama**（`:11434`，`/api/embed`） | 把文件 chunk 與查詢轉成向量 |
| **對話 LLM** | **OpenAI 相容服務**（例 oMLX，`:<CHAT_PORT>`，`/v1/chat/completions`） | 依檢索到的內容生成繁中回答；支援串流 |
| **Reranker** | **本機 Python 小服務**（`:<RERANK_PORT>`，cross-encoder） | 對混合檢索的候選做精排，並校準「查無資料」門檻 |
| **版本控制** | `sop-files/` 自己是一個**本機 git repo**（無 remote、不 push） | 每次發布/刪除自動 commit，可回溯 |

### 服務埠（全部綁 `127.0.0.1`，backend 對 LAN 開）

| 服務 | 埠（佔位） | 對誰開 |
|---|---|---|
| backend | `<PORT>` | LAN（公司內網） |
| Ollama embedding | `11434` | 127.0.0.1 |
| 對話 LLM | `<CHAT_PORT>` | 127.0.0.1 |
| reranker | `<RERANK_PORT>` | 127.0.0.1 |

---

## 2. 資料流

### (A) 問答（讀路徑）
```
使用者問題
  → backend /ask（JSON，LINE/n8n 用）或 /ask/stream（SSE，網頁用）
  → retrieve()：向量 + FTS5 → RRF 融合 → reranker 精排 → 雙訊號門檻
  → 命中：把「命中 chunk」組成 context（放在 user 訊息）→ 對話 LLM 生成
  → 沒命中：直接回固定「查無資料」訊息（不呼叫 LLM，誠實度不被繞過）
  → URL 白名單過濾（只留命中來源文件內的連結）→ 回答 + 來源
```

### (B) 文件進庫（寫路徑，受治理）
```
投稿（LINE / 網頁表單 / 內網生成器）
  → /sop-pending：AI 預檢（模板完整性 + 重複偵測 + 撞名/改名偵測）→ 存進 SQLite pending（不落 sop-files/）
  → 審核台 review.html（需密碼）：看新舊對照 diff → 核准
  → 核准：寫 sop-files/<title>.md + 本機 git commit + 重新索引 → 進入檢索範圍
  → chokidar 也會偵測檔案變更自動重新索引（雙保險）
```

> **關鍵隔離**：待審內容只存在 SQLite `pending` 表，**不落到 `sop-files/`**，所以 chokidar / `/ask` 在核准前完全看不到它。

---

## 3. 完整 RAG 管線（`retrieve()`）

> 這是整個系統的核心。所有數值都是**實際校準後的值**（佔位符只用於密鑰/IP，不用於演算法門檻）。

### 索引階段（寫入時）
1. **切段（chunk）**：以 Markdown 標題（`#`/`##`/`###`）為界把文件切成 chunk；每個 chunk 記錄 `文件名｜章節標題` 與內嵌圖片。
2. **Embedding**：每個 chunk 丟給 Ollama 取向量（**維度以模型實際輸出為準，不寫死**；目前用的多語模型輸出 **1024 維**）。
3. **存 SQLite**：`chunks`（向量 JSON + 內容簽章 + 模型名）＋ `chunks_fts`（FTS5 trigram 全文索引）。
4. **增量索引**：用「內容簽章（長度+頭尾片段）+ 模型名」判斷是否需要重算；沒變就跳過。換 embedding 模型 → 自動清掉舊維度向量重建。

### 檢索階段（查詢時）
```
query
  │
  ├─ 0) 查詢正規化 normQuery：把「軟分隔」(半/全形空格、頓號、逗號、斜線、分號、冒號…) 統一成單一半形空格
  │     → 「A、B、C」與「A B C」變成位元組相同 → 向量/FTS/reranker 三路一致（使用者不必會用標點）
  │
  ├─ 1) 向量檢索：query embedding 與全部 chunk 算 cosine，排序 → 得每個 chunk 的 vecRank + cosine
  │
  ├─ 2) 關鍵字檢索：FTS5 trigram，多詞之間用 OR（不是 AND）
  │       · 每個詞包成片語並跳脫；長度 < 2 丟棄（trigram 實際要 ≥3 才命中）
  │       · per-doc cap = 3：單一文件最多取 3 個 chunk，避免常見詞灌爆候選池
  │       · docFreq 過濾：命中 > 60% 文件的詞（通用詞/品牌詞）視為「太常見」丟棄
  │
  ├─ 3) RRF 融合：score(id) = 1/(K+vecRank) + 1/(K+ftsRank)，K = 60
  │       → 向量主導、FTS 補強專有名詞/低 cosine 但字面命中的 chunk
  │
  ├─ 4) 候選池：RRF 排序前 RERANK_CANDIDATES = 20 個 chunk
  │
  ├─ 5) Reranker 精排：cross-encoder 對每個候選打分 (0..1)
  │       · 結構感知：餵給 reranker 的文字前綴「文件標題｜章節標題」→ 能分辨「雙胞胎」文件
  │         (例：兩份高度相似但屬不同產品/流程的 SOP)
  │       · reranker 服務掛掉 → graceful fallback 回純 cosine（系統不中斷）
  │
  ├─ 6) ★雙訊號門檻（gate）★  ── 決定「有沒有命中、要餵哪些 chunk」
  │       topRerank = 最高 rerank 分；topCos = 候選中最高 cosine
  │       if reranker 正常:
  │          if topRerank ≥ RERANK_THRESHOLD (0.1):   餵「rerank ≥ 0.1」的 chunk        gateVia = rerank
  │          elif topCos ≥ COSINE_GATE (0.60):         餵「cosine ≥ 0.60」的 chunk        gateVia = cosine-fallback
  │          else:                                     查無資料                            gateVia = none
  │       else (reranker 掛掉):
  │          餵「cosine ≥ SIMILARITY_THRESHOLD (0.5)」  gateVia = cosine-no-reranker
  │
  └─ 7) 組 context：取門檻通過的 chunk，受 TOP_N_CHUNKS = 5 與 MAX_CONTEXT_CHARS = 2000 限制
        + doc-scoped 連結補強（見下）
        → 注入對話 LLM
```

#### 雙訊號門檻為什麼這樣設計
- **主訊號 = reranker 分數**：真陽性通常 ≥ 0.19；沾邊離題的雜訊（例如只是某個字重疊）只有 ~0.02。設 **0.1** 能擋掉這類「字面沾邊」的誤命中，又不傷真陽性。
- **cosine 只當「整題的最後手段」**，不是逐 chunk 的 OR 條件：只有當 reranker 對**整題**都沒信心（topRerank < 0.1）時，才退回看「整題最高 cosine 是否 ≥ 0.60」，用來救「換句話問」的極端案例。
- 這個雙層設計同時解決了兩個對立的問題：**誤報**（cosine 高但語意無關）與**漏報**（換句話問、cosine 偏低）。

### 注入策略：餵「命中 chunk」而非整份文件
- context 由**命中的 chunk** 組成（不是把整份文件貼進去），每段標上 `=== 文件：<名>｜<章節> ===`。
- 受 `TOP_N_CHUNKS = 5` 與 `MAX_CONTEXT_CHARS = 2000` 限制。
- **MAX_CONTEXT_CHARS 的教訓**：原本設 900 太小，會把 reranker 已認可的答案 chunk 硬砍掉（曾導致「正確文件命中卻沒被餵進去 → 答查無」）。提到 **2000**：讓門檻認可的 chunk（受 TOP_N_CHUNKS 限制）都餵得進去＝尊重 reranker 的精準判斷，又不額外引入雜訊。
- **doc-scoped 連結補強**：把「命中來源文件」全文裡含 URL 的行收進來（即使該行所在 chunk 沒被選進 top context），附在 context 末尾的「【本文件的相關連結】」區塊。這樣使用者問「某某的連結在哪」時模型拿得到正確連結；同時這份 URL 清單也是 server 端**連結白名單**——非命中文件的連結會被過濾掉，避免模型硬湊不相關連結。

### 查無資料 fallback（誠實度）
- 門檻沒過（`hasMatch=false`）且沒有個人化資料可答 → **直接回固定訊息「這個問題我目前的資料裡沒有，建議詢問主管」，不呼叫對話 LLM**。
- 這道防線在檢索層，不在 prompt 層 → 模型沒機會「腦補」；對話歷史也繞不過它。

### system prompt 設計（省 prefill）
- system prompt **固定不變、不含 {context}** → 讓推論引擎能快取 system 前綴，省下每次的 prefill。參考資料改放在 **user 訊息**裡。
- prompt 內含 6 條規則：YAML frontmatter 處理（exclusion_tags / similar_docs）、只取相關段落、查無資料話術、連結規則、措辭規範（一律稱「資料庫的文件」不可說「您提供的」）、結尾固定附上「【資料來源】【後續問題】」。

---

## 4. 串流（網頁版）
- `/ask/stream` 用 **SSE**：對話 LLM 一邊生成 backend 一邊 `data:` 推給前端，首字在 prefill 結束就出現，不必等整段生成完。
- **safeCut**：串流時若 buffer 尾端正在形成 URL / markdown 連結（可能要被白名單過濾），先 hold 那一小段、其餘文字立刻放行 → 兼顧「逐字串流的順暢」與「連結過濾的正確」。
- 空輸出防呆：若模型回空（冷載入）→ 回明確的「請稍候重試」訊息，不會把空答案配上來源送出。

---

## 5. 對話記憶
- **網頁**：帶最近 N 輪歷史（`HISTORY_TURNS`）做多輪對話。
- **LINE「聰明記憶」**（只在 `client:"line"` 生效）：
  - 獨立問題 → **零歷史**（當全新問題，避免被上一題污染）。
  - 追問（很短 ≤14 字 + 含指代詞「那/這/它/第N步…」）→ 帶最近 1–2 輪，且把「上一輪問題」併進檢索 query 做脈絡化。
  - 閒置逾 `LINE_IDLE_MS`（30 分）→ 視為新對話，不帶歷史。
  - **門檻照常套用**：脈絡化後仍撈不到 → 一樣回查無資料。

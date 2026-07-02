# MODELS — 模型清單、選型理由、換模型指南

三個模型各司其職，**全部跑在本機 `127.0.0.1`**，互不經雲端。

## 1. 對話 LLM（生成回答）

| 項目 | 值 |
|---|---|
| 用途 | 依檢索到的 SOP 內容生成繁中回答 |
| 介面 | **OpenAI 相容** `/v1/chat/completions`（`stream:true/false` 都用） |
| 服務 | 本機 OpenAI 相容推論引擎（例：oMLX / vLLM / llama.cpp server / Ollama OpenAI 端點） |
| 埠 | `<CHAT_PORT>`（佔位；實際綁 127.0.0.1） |
| 認證 | `Authorization: Bearer <CHAT_API_KEY>`（本機服務的 key，存環境變數） |
| 模型 | 一顆中等大小、繁中表現好的指令模型（建議 MoE 4-bit 量化以兼顧速度與品質） |
| 參數 | `temperature` 低（0.3）、`max_tokens` 約 2048 |
| 逾時 | `CHAT_TIMEOUT_MS`（120s）—要涵蓋「模型被踢出後冷載入」 |

**選型理由**：
- 必須**本機可跑**（資料不出內網）。
- 繁中生成品質是第一優先；其次是速度。
- MoE 4-bit 量化讓「中等規模模型」在單機也能有可接受的 tok/s（比同尺寸 dense 模型快數倍）。

**冷啟動防呆**（重要）：本機推論引擎可能因載入別的模型而把對話模型踢出記憶體，冷載入時第一發可能回**空字串**。對策：
- 非串流呼叫 `chatComplete()` 對「空白回應」自動重試（重試時模型已被前一發載回）。
- 啟動時 `warmup()` 預熱 + 每 `CHAT_WARM_INTERVAL_MS`（4 分）送極短請求保溫。
- 真的連續空白 → 回明確「請稍候重試」訊息，**不會把空答案配上來源送出**。

**要換對話模型**：改 `.env` 的 `CHAT_MODEL` / `CHAT_URL` / `CHAT_API_KEY`。只要服務是 OpenAI 相容介面就不必動程式碼。

---

## 2. Embedding（向量化）

| 項目 | 值 |
|---|---|
| 用途 | 文件 chunk 與查詢 → 向量（語意檢索 + 重複/矛盾偵測） |
| 介面 | **Ollama** `/api/embed`（`:11434`） |
| 模型 | 多語、中文檢索強的 embedding 模型（**1024 維**） |
| 維度 | **不寫死**——啟動時實跑一次拿維度；換模型自動清舊向量重建 |
| keep_alive | 30 分（避免每次重載） |
| 輸入上限 | 單一 chunk 約 3000 字 |

**選型理由**：
- 中文檢索品質是關鍵。實測一個多語強模型在中文 SOP 上的「查無資料門檻」可分離度，明顯優於需要任務前綴的英文系模型。
- **踩過的雷**：曾試一個 fp16 壓縮版 embedding（更快），但它把 cosine 全擠進 0.6–0.85 窄帶，**離題與真命中分不開 → 查無資料門檻失效**，因此退回原模型。速度不能犧牲門檻的可分離度。
- 程式內保留「任務前綴」機制（`search_query:` / `search_document:`）給需要前綴校準的模型（如 nomic 系）；目前的多語模型不需前綴，自動略過。

**要換 embedding 模型**：改 `.env` 的 `EMBED_MODEL`。**換模型後維度可能變**——backend 啟動時會自動偵測新維度、清掉舊維度向量並重建索引。重建期間檢索品質會短暫下降。

---

## 3. Reranker（精排 + 校準查無資料門檻）

| 項目 | 值 |
|---|---|
| 用途 | 對混合檢索的候選 chunk 做精排；分數用來定「查無資料」門檻 |
| 介面 | 自寫小服務：`POST /rerank {query, documents:[str]}` → `{scores:[float 0..1]}`；`GET /health` |
| 模型 | **cross-encoder reranker**（多語 XLM-RoBERTa 系，例 `BAAI/bge-reranker-v2-m3`） |
| 框架 | Python + `torch` + `transformers`，跑在 GPU/MPS（無則 CPU） |
| 埠 | `<RERANK_PORT>`（佔位；綁 127.0.0.1） |
| 計分 | `sigmoid(logits)` → 0..1；`max_length` 512 |

**選型理由**：
- 純向量檢索分不開「**雙胞胎文件**」（兩份高度相似但屬不同產品/流程的 SOP）。cross-encoder 把 `query` 與 `文件標題｜章節｜內容` 一起讀，能精準分辨。
- reranker 分數比 cosine 更適合當「**有沒有命中**」的訊號（真陽性 ≥0.19、沾邊雜訊 ~0.02，可分離度高）。
- 權重是公開模型、從 HuggingFace 下載，**無任何 SOP 資料外流**；服務只綁 127.0.0.1。

**graceful fallback**：reranker 掛掉 → backend 自動退回純 cosine 門檻，系統不中斷（只是雙胞胎辨識與門檻校準會退化）。

**要換 reranker**：改小服務的 `RERANKER_MODEL` 環境變數；或設 `USE_RERANKER=false` 完全停用（退回純 cosine）。

---

## 模型協作全圖

```
查詢 ─┬─▶ [Embedding/Ollama] ─▶ cosine 排序 ─┐
      └─▶ [FTS5/SQLite]      ─▶ bm25 排序  ─┴─▶ RRF 融合 ─▶ 前20候選
                                                              │
                                          [Reranker/cross-encoder] 精排
                                                              │
                                              雙訊號門檻 (rerank 0.1 / cosine 0.60)
                                                              │
                                              命中 chunk ─▶ [對話 LLM] ─▶ 繁中回答
```

> 三個模型可獨立替換：embedding 換了重建索引、對話模型換了改 env、reranker 換了改小服務 env 或關掉。**門檻數值是針對「embedding + reranker 的分數分佈」校準的，換這兩者要重新校準門檻**（見 DECISIONS.md）。

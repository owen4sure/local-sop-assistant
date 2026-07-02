# INSTALL_NOTES — 安裝與啟動

地端 SOP 助理「前端 + 部署」補充包。配合主架構藍圖（`sop-blueprint/`）一起看：
這裡是**前端網頁 + reranker 服務 + n8n 流程 + launchd 範本 + 安裝步驟**。

> 全部跑在**一台機器、127.0.0.1**，只對公司內網開放。所有 `<...>` 是佔位符，請換成你的值。
> 機密（審核密碼、對話服務 API key）一律走環境變數 / gitignored 檔，**不要寫進任何檔案**。

---

## 0. 元件與埠（佔位）
| 服務 | 埠 | 啟動方式 |
|---|---|---|
| backend（Node/Express） | `<PORT>` | `node server.js`（launchd 常駐） |
| Ollama（embedding） | `11434` | Ollama app / `ollama serve` |
| 對話 LLM（OpenAI 相容服務） | `<CHAT_PORT>` | 你的本機推論引擎（oMLX / vLLM / llama.cpp …） |
| reranker（Python 小服務） | `<RERANK_PORT>` | `python3 reranker.py`（launchd 常駐） |

---

## 1. 要下載哪些模型

### (a) Embedding — 經 Ollama
```bash
ollama pull bge-m3          # 多語、中文檢索強，1024 維（系統會動態偵測維度）
# 驗證
curl http://127.0.0.1:11434/api/embed -d '{"model":"bge-m3","input":"測試"}'
```
> 不建議換成需要任務前綴的英文系模型（如 nomic）——除非你同時調整 RAG 門檻。

### (b) 對話 LLM — 經 OpenAI 相容服務（非 Ollama）
- 用任一本機 OpenAI 相容推論引擎承載一顆**繁中表現好的指令模型**（建議 MoE 4-bit 量化以兼顧速度）。
- 在 backend `.env` 設 `CHAT_URL=http://127.0.0.1:<CHAT_PORT>/v1`、`CHAT_MODEL=<你的對話模型名>`、`CHAT_API_KEY=<本機服務 key>`。
- 範例（本專案實際使用）：在 oMLX 上跑一顆 ~中等規模 MoE 指令模型。

### (c) Reranker — 經 pip + HuggingFace
```bash
cd reranker
pip install -r requirements.txt          # torch + transformers + sentencepiece
# 啟動時自動下載權重：
RERANKER_MODEL=BAAI/bge-reranker-v2-m3 RERANKER_PORT=<RERANK_PORT> python3 reranker.py
```

---

## 2. Node 版本
- **Node 22.x（LTS）**（開發機實測 22.22.0）。需支援原生 `fetch` 與 `AbortSignal.timeout`（Node 18+ 即可，建議 20/22）。
- backend 依賴：`express`、`better-sqlite3`、`chokidar`（`npm install`）。

---

## 3. 啟動順序（重要）
模型服務要先就緒，backend 啟動時才連得上、才能建索引/預熱：
```
1) Ollama        （embedding） ──┐
2) 對話 LLM 服務 （:<CHAT_PORT>） ├─ 三個模型服務先起
3) reranker      （:<RERANK_PORT>）┘
4) backend       （:<PORT>）  ← 最後起：會自動掃 sop-files/ 建索引、預熱對話模型、開始 chokidar 監看
```
> backend 對缺線有韌性：reranker 掛掉會 fallback 純 cosine；embedding 連不上會等恢復後重啟或打 `/reindex`。但首次部署建議照順序。

---

## 4. 前端網頁怎麼放
- 這些 HTML 由 backend 直接 host（`express.static`）——把它們放進 backend 的 `web/` 目錄即可，使用者用 `http://<LAN_IP>:<PORT>/review.html` 等開啟。
- `admin/review.html`、`generator/*.html` 都是**單檔自帶 inline CSS/JS**，沒有額外的 css/js 相依檔（所以 `admin/` 下沒有獨立資產檔）。
- 所有 API 呼叫都是**相對路徑**（`/ask/stream`、`/sop-pending`、`/pending`…）→ 不必設定 API base，前端跟 backend 同源即可。
- 寫死的對外網域已換成 `<PUBLIC_HOSTNAME>`、埠已換成 `<PORT>`：部署時改回你的值（或維持相對行為）。

---

## 5. launchd 安裝（macOS 開機常駐）
把 `launchd/` 兩個 plist 的 `<HOME>` / `<NODE_BIN>` / `<PORT>` / `<RERANK_PORT>` 換成實際值後：
```bash
cp launchd/com.example.sop.plist           ~/Library/LaunchAgents/
cp launchd/com.example.sop-reranker.plist  ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/com.example.sop.plist
launchctl load -w ~/Library/LaunchAgents/com.example.sop-reranker.plist
# 重啟某服務：
launchctl kickstart -k gui/$(id -u)/com.example.sop
# 查狀態 / 看 log：
launchctl list | grep com.example.sop
tail -f ~/ai-sop/logs/server.err
```
> Linux 請改用 systemd（對照範例見主藍圖 `server/com.example.sop.plist.template` 底部註解）。

---

## 6. n8n（LINE / 表單入口）
- 匯入 `n8n-flows/sop-create.json`（已移除所有 credential / token / 真實 webhook 網址 / SheetID）。
- 設定 Webhook 路徑；backend 與 n8n 同機 → HTTP 節點直接打 `http://localhost:<PORT>/sop-pending`（投稿）與 `/ask`（問答）。
- LINE channel secret / access token、Google Sheet 稽核（如需）一律用 **n8n credential** 管理，不要寫進節點。

---

## 7. 安全檢查清單（部署前）
- [ ] `.env` 與 `.review-password` 都在 `.gitignore`，未進版控。
- [ ] backend 只在 LAN 可達（防火牆 / 反向代理限制；對外網域命中 `internalOnly` 會擋寫入）。
- [ ] 三個模型服務都綁 `127.0.0.1`，不對外。
- [ ] n8n credential 不外流；webhook 路徑不可猜。

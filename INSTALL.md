# 安裝指南（從零到上線）

> 目標：在公司主機上把這個 repo 裝起來、填入自己的 token，就能用。
> 建議環境：macOS（Apple Silicon）/ Node 18+ / Python 3.9+。
> 先決定要裝哪個版本（見 README）：**基本版**只做 Part 1–4；**完整版**再做 Part 5–6。

---

## Part 1 — 地端模型（三顆，都在本機）

本系統需要三個本機服務，**埠和模型名都寫在 `core/.env`**，可自由替換。

1. **Embedding（向量）— 用 Ollama**
   ```bash
   # 安裝 ollama（https://ollama.com），然後拉一顆多語/中文強的 embedding 模型
   ollama pull <你的embedding模型>     # 例：bge-m3 類（多語、中文佳）
   # ollama 預設跑在 http://127.0.0.1:11434
   ```

2. **對話模型（回答）— 任何 OpenAI 相容的本機服務**
   （可用 MLX、llama.cpp、Ollama…只要提供 `/v1/chat/completions`）
   - 記下它的 URL（例 `http://127.0.0.1:8000/v1`）、模型名、API key，等下填進 `.env`。

3. **Reranker（重排）— 本機 Python 小服務**
   ```bash
   cd core/reranker
   pip install -r requirements.txt
   python reranker.py        # 預設跑在某個埠，見該檔/README；填進 .env 的 RERANKER_URL
   ```

> 沒有 GPU 也能跑，只是慢；對話模型挑得動的大小（機器 RAM 決定）。換模型只要改 `.env` 的 `EMBED_MODEL / CHAT_MODEL / RERANKER_MODEL`，門檻可能要重調（見 docs/MODELS.md、DECISIONS.md）。

---

## Part 2 — 後端 server

```bash
cd core/server
npm install
cp ../.env.example ../.env        # 在 core/ 下建立 .env
# 編輯 core/.env，把所有 <佔位符> 換成你的值：
#   PORT / HOST、CHAT_URL / CHAT_API_KEY / CHAT_MODEL、
#   OLLAMA_URL / EMBED_MODEL、RERANKER_URL / RERANKER_MODEL、
#   RAG 門檻（先用預設）、REVIEW_PASSWORD（審核密碼）
node server.js                    # 啟動；預設綁 0.0.0.0:<PORT>，內網可達
```

健康檢查：瀏覽器開 `http://<主機內網IP>:<PORT>/pending/count`（要帶審核密碼的 API 會擋，屬正常）。

---

## Part 3 — 審核台 & 生成器（前端）

- **審核台**：開 `core/admin/review.html`。把檔內的 API base URL 改成你的後端位址（檔頭有設定處），輸入審核者姓名 + 審核密碼登入 → 待審、上下架、文件健康整理台都在這。
- **生成器**：`core/generator/sop-generator.html`，給人填一份新 SOP（會呼叫後端/AI 協助）。
- 兩者都是純前端 html，可直接開、或讓後端/任何靜態伺服器托管在內網。

---

## Part 4 — 放文件 & 驗證（基本版到此完成）

1. 參考 `core/docs-sample/` 的格式寫你的 SOP。
2. 透過**生成器**或**直接丟進 `core/sop-files/`**（會被 chokidar 自動索引）。
3. 正式流程：投稿 → 審核台核可 → 自動建索引 → `/ask` 查得到。
4. 測試問答：`POST /ask` body `{ "sessionId":"test", "message":"你的問題" }`，應正確引用到對的文件；查無資料時會明說沒有、不亂編。

> ✅ 只要知識庫 → 到這裡就裝完了。要加 LINE 請假 → 繼續 Part 5。

---

## Part 5 — n8n（完整版：請假/交接/投稿 流程）

1. 架一個 n8n（Docker 或本機皆可），登入後台。
2. **匯入流程**：Workflows → Import from File：
   - `line-attendance/n8n-flows/leave-bot.json`（請假/交接/代理人/綁定/白名單機器人）
   - `line-attendance/n8n-flows/sop-create.json`（SOP 投稿：LIFF→webhook→待審）
3. **設定 Credentials**（匯入後節點會標示缺憑證）：
   - Google Sheets（OAuth2）：用來存請假/員工/交接資料。
   - 把流程裡的 `<GOOGLE_SHEET_ID>` 換成你的試算表 ID；分頁需有 `leaves` / `employees`(A本名 B暱稱 C LINE_UserID) / `handover`(A姓名 B請假期間 C內容 D更新時間 E代理人)。
4. **填 LINE 與服務值**（流程內的佔位符）：
   - `<LINE_CHANNEL_ACCESS_TOKEN>` → 你的 LINE 官方帳號 channel token
   - `<LINE_GROUP_ID>` → 公司群組 ID（白名單用）
   - `<LOCAL_CHAT_API_KEY>` → 對話模型 key（OCR/回覆用）
   - SOP 助理位址預設 `http://localhost:3345`（請改成你的後端 PORT）
5. 啟用（Active）兩個 workflow。

---

## Part 6 — LINE 官方帳號 + LIFF（完整版）

1. **LINE Developers** 建一個 Messaging API channel：
   - 取得 **Channel access token** → 填進 n8n（Part 5）。
   - Webhook URL 指到 n8n 的 webhook（請假機器人那個 webhook 節點的 URL）。
   - 把官方帳號加進公司群組；群組 ID 填白名單。
2. **LIFF（SOP 投稿表單）**：
   - 在 LINE Login channel 建一個 LIFF，取得 **LIFF ID**。
   - 編輯 `line-attendance/liff-form/sop-liff-form.html`：把 `<LIFF_ID>` 換成你的、`<N8N_HOST>` 換成你的 n8n 網域（webhook 收件處）。
   - 把這份 html 托管在任何 HTTPS 靜態空間（或公司內網 https），LIFF endpoint 指過去。
3. **員工綁定**：群組公告請大家私訊機器人「綁定 暱稱」；新人「新成員」自助建檔（細節見 `line-attendance/README.md`）。

---

## 完成檢查清單

- [ ] 三個本機模型服務都活著（embedding / chat / reranker）
- [ ] 後端 `/ask` 能正確問答、查無資料會明說
- [ ] 審核台能登入、能上下架、健康整理台能掃
- [ ] （完整版）LINE 打 `/help` 有回使用說明
- [ ] （完整版）群組請假 → 試算表有寫入、請假人收到交接單
- [ ] `.env` / `.review-password` 沒被 commit（`git status` 確認）

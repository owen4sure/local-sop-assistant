# GOVERNANCE — 投稿 → 審核 → 發布 → 索引

知識庫**不是誰都能直接塞文件**。所有寫入都先進「待審區」，審核者核可後才進檢索範圍。這份文件說明完整流程、密碼機制與防呆守則。

## 1. 三個投稿入口 → 都打 `POST /sop-pending`

| 入口 | 路徑 | 說明 |
|---|---|---|
| ① LINE / 聊天 | LINE → **n8n webhook** → backend | 使用者在聊天裡投稿 |
| ② 網頁表單（LIFF / 內網表單） | 表單 → **n8n webhook** → backend | 結構化欄位填寫 |
| ③ 內網生成器 | `sop-generator` / `agent-optimizer` 頁面 | 用對話模型協助產出七段式 SOP，按「📤 送出待審」 |

`/sop-pending` body：`{ name(標題), md(內容), submitter, type, op, source, reason? }`
- `op`：`new`（新增）/ `modify`（修改）/ `delete`（刪除申請）
- 投稿只存進 SQLite **`pending`** 表（status=`待審`），**不落 `sop-files/`** → chokidar / `/ask` 在核准前看不到。

### AI 預檢（`runPrecheck`）— 投稿當下就跑，結果存成 JSON、給審核者紅綠燈
**op- 與 doc_type- 感知**（七段完整性只套用在 `doc_type=SOP`，FAQ/Ref 不誤套）：

- **op=new**：
  - 模板完整性（SOP 才檢查七段標題在不在，接受同義詞）
  - 內容充實度（去模板雜訊後字數 / 是否佔位灌水）
  - 重複偵測（去模板後的 embedding cosine：列出 ≥0.78、警示 ≥0.88）
  - **撞名偵測**：若 `<title>.md` 已存在 → `nameCollision=true`、badge 🟡（防「新增其實會覆蓋現有文件」）
- **op=modify**：
  - **不**做完整性檢查；改顯示確定性的**變更摘要**（相對舊檔的行級增刪）
  - 重複偵測**排除自己**，只在改到跟「別份」≥0.88 時才警示
  - **改名/找不到原檔偵測**：目標檔不存在 → `targetMissing=true`、badge 🟡（防「改名變孤兒副本」）
- **op=delete**：記錄刪除理由，審核台顯示理由 + 該檔目前內容

> badge：🟢 全部 OK ／ 🟡 有需要審核者注意的點（缺段、灌水、重複、撞名、改名）。

---

## 2. 審核台 `review.html`（內網 + 密碼）

- **兩段式登入**：輸入審核者名字 + 密碼；密碼驗證後才顯示內容。
- 分頁：**待審 / 退回 / 已上架 / 健康整理台**。
- **待審清單背景自動刷新**：每 25s 比對清單簽章，有變才重畫左側清單；**絕不碰右側正在編輯的細節**（避免打斷「修改後核准」的編輯）。
- **op=modify 顯示新舊並排 diff**（LCS 行級對齊、綠＝新增/紅＝刪除、同步捲動），可切換「編輯新版」後再核准（＝經審核者修改後核准）。

### 審核動作（都需密碼、都有 `confirm()` 防誤按）

| 動作 | 端點 | 效果 |
|---|---|---|
| 核准 | `POST /pending/:id/approve` | 寫 `sop-files/<title>.md`、git commit、重新索引、status→已上架（op=delete 則移除檔案） |
| 退回 | `POST /pending/:id/reject` | status→退回 + 退回意見 |
| 恢復待審 | `POST /pending/:id/reopen` | 退回→待審；或已上架→待審（後者會**撤回上架**：移除檔案+重新索引+git commit，md 仍留 pending） |
| 完全刪除 | `POST /pending/:id/purge` | 只刪「審核紀錄(log)」；**不動 `sop-files/` 正式文件**（已上架列 purge 只刪 log） |

- **動作可逆**：pending 列永不被「核准/退回」刪除，只是改 status，可來回 reopen。
- **永久刪除分兩種**，刻意分開避免誤解：
  - `purge`＝刪審核紀錄（log），正式文件不動。已上架分頁的按鈕標示為「🗑️ 刪除紀錄（不下架）」。
  - 要真正下架正式文件 → 用 reopen（已上架→待審，會撤回上架）。

### 核准防呆（避免「用標題當身分」的靜默資料遺失）
系統用**標題/檔名字串**當文件身分（沒有不可變 ID），所以核准前在 backend 強制檢查：
1. **op=new 撞到既有同名檔** → `409 needConfirm:'overwrite'`（要審核者明確再確認才覆蓋）。
2. **op=modify 但目標檔不存在**（被改名/已刪）→ `409 needConfirm:'confirmNew'`（會新建一份孤兒檔，要明確確認）。
3. **op=delete 但目標檔不存在** → `404`（不再假裝刪成功）。
前端 `act()` 收到 409+needConfirm → 跳 `confirm()`，使用者同意後帶 override 旗標重送。

---

## 3. 發布 → 索引（自動）

```
核准 approve
  → fs.writeFileSync(sop-files/<safeMdName(title)>.md)
  → git commit（本機 repo，user "AI SOP Review"，不 push）
  → rag.reindexFile()：重新切段 + embedding + 寫 SQLite chunks/FTS
  → status = 已上架
        ┌─ 同時 chokidar 偵測到檔案變更 → 也會觸發重新索引（雙保險、冪等）
```
- `safeMdName(title)`：取檔名本體、去掉 `/\:*?"<>|`、補 `.md`，防路徑跳脫。
- `sop-files/` 是本機 git repo（無 remote）→ 每次發布/刪除都可回溯。

---

## 4. 審核密碼機制（絕不寫進原始碼）

```
config.REVIEW_PASSWORD =
   process.env.REVIEW_PASSWORD            // 優先環境變數
   ?? 讀 gitignored 的 .review-password 檔  // 否則讀本機檔（.gitignore 已排除）
   ?? ''                                  // 都沒有 → 空字串（所有寫入/審核 API 一律 403）
```
- 送出方式：HTTP header `X-Review-Password` 或 body `password`；完整字串、區分大小寫比對。
- 錯/缺 → `403`，操作不生效。
- `.review-password` 永遠在 `.gitignore`，**不進版控**。
- **權限一致性**：不只審核動作，連 `GET /pending`、`GET /pending/:id`（含草稿全文）也要密碼——登入不能只是前端畫面。另開**免密碼的 `GET /pending/count`**（只回數字、不含內容）給主頁徽章用。

---

## 5. 內網限定（`internalOnly` middleware）
- 設定 `PUBLIC_HOSTNAMES`（對外網域清單）。當請求的 `hostname` 命中對外網域 → 所有**寫入/審核類 API 一律 403**。
- 只有從 LAN（localhost / 內網 IP）來的請求能寫入。
- 對話問答（`/ask`）可不受此限（看部署需求），但所有「會改變知識庫」的端點都包 `internalOnly`。

---

## 6. n8n 串接（LINE / 表單入口）
- n8n 與 backend 同機 → n8n 直接打 `http://localhost:<PORT>/ask`（問答）與 `/sop-pending`（投稿），不必走對外通道。
- LINE 投稿/問答的 webhook、表單欄位對應，由 n8n flow 負責（不在本 repo）。
- 重建時：在 n8n 設一個 webhook 收 LINE/表單事件 → 整理成 `/sop-pending` 或 `/ask` 的 body → 呼叫 backend。

# server/ — 程式碼骨架

保留**結構與邏輯**的 backend 骨架。所有密鑰、IP、Sheet ID、真實 SOP 內容都換成 `<佔位>` 或走環境變數。
**這不是可直接跑的成品**——是讓你照著重建的參考。

| 檔案 | 角色 | 對應文件 |
|---|---|---|
| `config.js` | 集中設定（全走 env，機密不寫死） | [GOVERNANCE](../GOVERNANCE.md) §4 |
| `llm.js` | 三個模型的呼叫（embedding / 對話 / reranker）+ 冷啟動防呆 | [MODELS](../MODELS.md) |
| `rag.js` | **RAG 核心**：混合檢索 → RRF → reranker → 雙訊號門檻 → 組 context | [ARCHITECTURE](../ARCHITECTURE.md) §3 |
| `db.js` | SQLite schema + FTS5 + 各資料表存取 | [ARCHITECTURE](../ARCHITECTURE.md) §1 |
| `server.js` | 所有 API 端點 + 治理預檢 + 健康整理台 + 矛盾偵測 + 問答 + 啟動 | 全部 |
| `lineformat.js` | LINE 純文字排版（◆ 標題 / ・ 子項 / 拿掉來源頁尾） | [ARCHITECTURE](../ARCHITECTURE.md) §5 |
| `reranker.py` | 本機 cross-encoder reranker 小服務（獨立進程） | [MODELS](../MODELS.md) §3 |
| `package.json` | Node 依賴（express / better-sqlite3 / chokidar） | — |
| `com.example.sop.plist.template` | 開機常駐範本（launchd / systemd） | [GOVERNANCE](../GOVERNANCE.md) |

## 預期的執行期目錄（不在版控）
```
專案根/
├── sop-service/        ← 本資料夾的內容
│   ├── .env            ← cp ../.env.example 後填值（gitignored）
│   └── .review-password← 或用這個檔放審核密碼（gitignored）
├── sop-files/          ← 真實 SOP 文件（.md，本機 git repo），格式見 ../docs-sample/
├── data/               ← SQLite 自動建立
├── logs/
└── web/                ← 前端靜態頁（index / review / sop-generator），本藍圖未含
```

## 前端（本藍圖未附原始碼，重點行為已寫進文件）
- `index.html`：問答（呼叫 `/ask/stream`）、文件庫、編輯/刪除（送待審或持密碼直接）、審核台入口徽章（`/pending/count`）。
- `review.html`：兩段式登入、待審/退回/已上架/健康 四分頁、新舊對照 diff、核准/退回/恢復/完全刪除（皆帶 `X-Review-Password`）、健康整理台。
- `sop-generator.html`：用 `/chat` 協助產出七段式 SOP，按鈕送 `/sop-pending`。

> 重建前端時，所有「會改變知識庫」的呼叫都要：① 走內網 ② 帶審核密碼 header ③ 對 409 needConfirm 跳二次確認。

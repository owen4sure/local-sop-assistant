# line-sop-qa — LINE SOP 問答（純問答，無請假）

把「用 LINE 問公司 SOP」單獨拉出來的輕量模組。**只給知識問答，不含請假/交接**。適合「想要 core 知識庫 + LINE 入口、但不要出勤功能」的公司。

## 它做什麼
使用者在 LINE（私訊或指定群組）打一個問題 → 機器人去問 `core` 後端的 `/ask` → 把答案回給使用者。查不到會明說沒有、不亂編（沿用後端邏輯）。

## 流程
```
LINE Webhook → 立即回應(200) → 處理問題(取文字) → 問 SOP(POST /ask) → 回覆 LINE(push 答案)
```

## 安裝（前提：core 已照 INSTALL.md 跑起來）
1. n8n 匯入 `n8n-flows/line-sop-qa.json`。
2. 改 **問 SOP** 節點的 URL：`http://localhost:3345/ask` → 你的 core 後端位址/埠。
3. 改 **回覆 LINE** 節點的 `<LINE_CHANNEL_ACCESS_TOKEN>` → 你的 LINE channel token。
4. （選用）只想限定某群組才回答：在 **處理問題** 節點解開白名單那兩行、填 `<LINE_GROUP_ID>`。
5. 啟用 workflow，把 LINE channel 的 Webhook URL 指到這個 webhook（path：`sop-ask`）。

## 與其他版本的關係
- **基本版（core）**：網頁問答，無 LINE。
- **＋ 本模組（line-sop-qa）**：基本版 ＋ LINE 問答（無請假）。← 中間檔
- **完整版（line-attendance）**：含請假/交接/代理人，且 `/sop` 也能問 SOP。

> 佔位符：`<LINE_CHANNEL_ACCESS_TOKEN>`、（選用）`<LINE_GROUP_ID>`；後端位址預設 `localhost:3345`，請改成你的。

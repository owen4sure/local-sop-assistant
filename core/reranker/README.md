# reranker 小服務

本機 cross-encoder 精排服務。把混合檢索的候選 chunk 對 query 重新打分（0..1），
用來解「雙胞胎文件」與校準「查無資料」門檻。權重是公開模型、從 HuggingFace 下載，
只綁 `127.0.0.1`，無任何 SOP 資料外流。

## 介面
- `POST /rerank  {query, documents:[str]}` → `{scores:[float 0..1]}`
- `GET  /health` → `{ok, model, device}`

## 安裝
```bash
cd reranker
python3 -m venv .venv && source .venv/bin/activate     # 選配
pip install -r requirements.txt
```

## 模型
- 預設 `RERANKER_MODEL=BAAI/bge-reranker-v2-m3`（公開、多語、含繁中）。
- 首次啟動會自動從 HuggingFace 下載權重（之後快取在本機 `~/.cache/huggingface`）。

## 啟動
```bash
# 埠與模型可用環境變數覆寫
RERANKER_PORT=<RERANK_PORT> RERANKER_MODEL=BAAI/bge-reranker-v2-m3 python3 reranker.py
# 驗證
curl http://127.0.0.1:<RERANK_PORT>/health
```

## 注意
- cross-encoder 非執行緒安全 → 服務內以 lock 序列化推論。
- backend 端設 `USE_RERANKER=false` 可完全停用（退回純 cosine 門檻，系統仍可運作）。
- 開機常駐見 `../launchd/com.example.sop-reranker.plist`。

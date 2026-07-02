#!/usr/bin/env python3
# 本機 reranker 小服務：bge-reranker-v2-m3（XLM-RoBERTa cross-encoder），只用 torch + transformers。
# 用途：把混合檢索的候選 chunk 對 query 做精排，分數可校準「查無資料」門檻。
# 介面：POST /rerank {query, documents:[str], top_k?} → {scores:[float 0..1]}；GET /health
# 只綁 127.0.0.1，模型權重從 HuggingFace 下載（公開權重，無任何 SOP 資料外流）。
import json, os, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer

MODEL_ID = os.environ.get("RERANKER_MODEL", "BAAI/bge-reranker-v2-m3")
PORT = int(os.environ.get("RERANKER_PORT", "3346"))
DEVICE = "mps" if torch.backends.mps.is_available() else "cpu"
MAX_LEN = 512

print(f"[reranker] loading {MODEL_ID} on {DEVICE} ...", flush=True)
_tok = AutoTokenizer.from_pretrained(MODEL_ID)
_model = AutoModelForSequenceClassification.from_pretrained(MODEL_ID).to(DEVICE).eval()
_lock = threading.Lock()
print(f"[reranker] ready on 127.0.0.1:{PORT} ({DEVICE})", flush=True)


@torch.no_grad()
def rerank(query, documents):
    if not documents:
        return []
    pairs = [[query, d] for d in documents]
    inputs = _tok(pairs, padding=True, truncation=True, max_length=MAX_LEN, return_tensors="pt").to(DEVICE)
    logits = _model(**inputs, return_dict=True).logits.view(-1).float()
    return torch.sigmoid(logits).cpu().tolist()


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):  # 安靜
        pass

    def _send(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"ok": True, "model": MODEL_ID, "device": DEVICE})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/rerank":
            self._send(404, {"error": "not found"})
            return
        try:
            n = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(n) or b"{}")
            query = data.get("query", "")
            docs = data.get("documents", [])
            with _lock:  # cross-encoder 非執行緒安全，序列化
                scores = rerank(query, docs)
            self._send(200, {"scores": scores})
        except Exception as e:
            self._send(500, {"error": str(e)})


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()

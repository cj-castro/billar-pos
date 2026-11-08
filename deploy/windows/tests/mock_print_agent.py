"""Mock of scripts/print_agent/print_agent.py: records every POST /chit and /print as one JSON line
{"path", "body"} and answers what the real agent answers on a successful print: 200 {"ok": true}.
(The real agent also dedups by job_id; job ids are unique per request here, so it is not needed.)
Run: python mock_print_agent.py --port 59191 --host 127.0.0.1 --out records.jsonl
"""
import argparse
import json
import threading
from pathlib import Path


def read_records(path):
    return [json.loads(l) for l in Path(path).read_text(encoding="utf-8").splitlines() if l.strip()]


def make_app(out):
    from flask import Flask, jsonify, request
    app, lock = Flask(__name__), threading.Lock()

    @app.route("/health")
    def health():
        return jsonify({"status": "ok"})

    @app.route("/chit", methods=["POST"])
    @app.route("/print", methods=["POST"])
    def record():
        line = json.dumps({"path": request.path, "body": request.get_json(force=True)}, sort_keys=True)
        with lock, open(out, "a", encoding="utf-8", newline="\n") as f:
            f.write(line + "\n")
        return jsonify({"ok": True}), 200

    return app


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    make_app(a.out).run(host=a.host, port=a.port, threaded=True)

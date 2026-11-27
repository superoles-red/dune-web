#!/usr/bin/env python3
"""Local server for the BYOP shell: COOP/COEP headers, correct MIME types."""
import argparse
import http.server
import mimetypes
import os
import socketserver

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, "web")

EXTRA_TYPES = {
    ".mjs": "text/javascript",
    ".js": "text/javascript",
    ".wasm": "application/wasm",
    ".zip": "application/zip",
    ".json": "application/json",
    ".txt": "text/plain; charset=utf-8",
    ".py": "text/plain; charset=utf-8",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WEB, **kwargs)

    def guess_type(self, path):
        ext = os.path.splitext(path)[1].lower()
        return EXTRA_TYPES.get(ext) or mimetypes.guess_type(path)[0] or "application/octet-stream"

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=4188)
    args = parser.parse_args()
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("127.0.0.1", args.port), Handler) as httpd:
        print(f"Serving {WEB} on http://127.0.0.1:{args.port}/", flush=True)
        httpd.serve_forever()


if __name__ == "__main__":
    main()

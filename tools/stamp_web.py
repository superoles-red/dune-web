#!/usr/bin/env python3
"""Stamp cache-busting build ids into the deployed shell (CI / manual deploy).

GitHub Pages serves assets with ``Cache-Control: max-age=600``, so a browser can
keep an old module for ten minutes after a deploy and mix it with the new
index.html (exactly the "old cache" failure users hit in a normal, non-incognito
profile).  This rewrites the entry script/stylesheet URLs in the deploy artifact
with a content hash, so every deploy produces new URLs.
"""
from __future__ import annotations

import hashlib
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
ENTRY = WEB / "index.html"


def digest(*names: str) -> str:
    hasher = hashlib.sha256()
    for name in names:
        path = WEB / name
        if path.is_file():
            hasher.update(path.read_bytes())
    return hasher.hexdigest()[:12]


def main() -> int:
    if not ENTRY.is_file():
        print("stamp: web/index.html is missing", file=sys.stderr)
        return 1
    build = digest("byop-boot.mjs", "shell.js", "app.mjs", "game-ui.mjs")
    html = ENTRY.read_text(encoding="utf-8")
    html = re.sub(r'(src="(?:\./)?byop-boot\.mjs)(\?v=[^"]*)?(")', rf'\1?v={build}\3', html)
    html = re.sub(r'(src="(?:\./)?shell\.js)(\?v=[^"]*)?(")', rf'\1?v={build}\3', html)
    if 'name="dune-build"' not in html:
        html = html.replace("<head>", f'<head>\n<meta name="dune-build" content="{build}">', 1)
    ENTRY.write_text(html, encoding="utf-8")
    print(f"stamp: build {build} -> web/index.html")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

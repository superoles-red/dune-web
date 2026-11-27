#!/usr/bin/env python3
"""Fail if game data or generated game code is committed to the repository.

BYOP rule: the repository contains only our code and third-party MIT code.
The ROM, the translated game core and extracted game assets must never be
committed or deployed.
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKIP_DIRS = {".git", "node_modules", ".local", "__pycache__", "test-results"}
GENERATED_PATHS = (
    "web/py-package.zip",
    "web/reference.json",
    "web/vendor/",
    "web/py-src/genesis_recompiler/",
    "web/py-src/dune-runtime.c",
    "web/py-src/profile.json",
    "web/py-src/reference.json",
    "runtime/reference.json",
    "prototype/wasm/build/",
)
ALLOWED_LARGE = {
    # third-party MIT sources that are legitimately large text
    "vendor/rearrakis/genesis_recompiler/ymfm/ymfm_fm.ipp",
}
MAX_TEXT_BYTES = 900 * 1024
FORBIDDEN_SUFFIXES = {".gen", ".smd", ".nes", ".sfc", ".bin", ".rom", ".zip", ".7z"}
FORBIDDEN_SNIPPETS = (
    "static const uint8_t rom_data[]",
    "static const uint8_t rom_code[]",
)


def main() -> int:
    problems = []
    for path in sorted(ROOT.rglob("*")):
        rel = path.relative_to(ROOT)
        if any(part in SKIP_DIRS for part in rel.parts) or path.is_dir():
            continue
        rel_text = rel.as_posix()
        if rel_text in ALLOWED_LARGE:
            continue
        if any(rel_text.startswith(prefix) for prefix in GENERATED_PATHS):
            continue
        if path.suffix.lower() in FORBIDDEN_SUFFIXES:
            problems.append(f"forbidden game-data file type: {rel_text}")
            continue
        size = path.stat().st_size
        if size == 1048576:
            problems.append(f"file is exactly one Sega ROM: {rel_text}")
        if size > MAX_TEXT_BYTES and path.suffix.lower() in {".c", ".h", ".txt", ".json", ".mjs", ".js", ".py"}:
            problems.append(f"suspiciously large text file: {rel_text} ({size} bytes)")
        if size > 4 * 1024 * 1024:
            problems.append(f"large binary in repository: {rel_text} ({size} bytes)")
        if path.suffix.lower() in {".c", ".h"}:
            try:
                head = path.read_bytes()[: 4 * 1024 * 1024]
            except OSError:
                continue
            for snippet in FORBIDDEN_SNIPPETS:
                if snippet.encode() in head:
                    problems.append(f"generated ROM data embedded in {rel_text}")

    if problems:
        print("game-data check FAILED:", file=sys.stderr)
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        return 1
    print("game-data check: OK (no ROM, no generated core, no extracted assets)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

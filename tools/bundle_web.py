#!/usr/bin/env python3
"""Assemble the browser bundle for the BYOP shell.

Copies the MIT recompiler into ``web/py-src``, adds the pinned runtime preamble,
vendors Pyodide from node_modules and writes ``web/reference.json`` +
``web/py-package.zip``. Never touches game data: the runtime preamble and the
recompiler are MIT code, the ROM is supplied by the player at run time.

Usage:
    python3 tools/bundle_web.py
    python3 tools/bundle_web.py --skip-pyodide   # fast re-pack while editing py-src
"""
import argparse
import hashlib
import json
import shutil
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / "vendor" / "rearrakis" / "genesis_recompiler"
OVERLAY = ROOT / "tools" / "recompiler_overlay"
PY_SRC = ROOT / "web" / "py-src"
WEB = ROOT / "web"
RUNTIME = ROOT / "runtime"
PYODIDE_FILES = (
    "pyodide.mjs",
    "pyodide.asm.js",
    "pyodide.asm.wasm",
    "python_stdlib.zip",
    "pyodide-lock.json",
)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def fail(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(1)


def load_manifest() -> dict:
    manifest_path = RUNTIME / "manifest.json"
    if not manifest_path.is_file():
        fail(
            "runtime/manifest.json is missing. Build the pinned runtime first: "
            "python3 tools/build_runtime.py --baseline /path/to/dune-base.c"
        )
    manifest = json.loads(manifest_path.read_text())
    required = ("runtime_file", "runtime_sha256", "window_title", "shipped_core_sha256", "shipped_core_bytes")
    for key in required:
        if key not in manifest:
            fail(f"runtime/manifest.json lacks '{key}'")
    return manifest


def copy_recompiler() -> None:
    package = PY_SRC / "genesis_recompiler"
    if package.exists():
        shutil.rmtree(package)
    package.mkdir(parents=True)
    for source in sorted(VENDOR.glob("*.py")):
        shutil.copy2(source, package / source.name)
    for patched in ("emit.py", "cli.py"):
        shutil.copy2(OVERLAY / patched, package / patched)
    # Driver sources already live in web/py-src and are committed as normal source.
    for name in ("driver.py", "dune_build.py"):
        if not (PY_SRC / name).is_file():
            fail(f"web/py-src/{name} is missing")


def copy_runtime(manifest: dict) -> None:
    runtime_file = RUNTIME / manifest["runtime_file"]
    if not runtime_file.is_file():
        fail(f"pinned runtime not found: {runtime_file}")
    if sha256(runtime_file) != manifest["runtime_sha256"]:
        fail("pinned runtime SHA-256 does not match runtime/manifest.json")
    text = runtime_file.read_text()
    if "static const uint8_t rom_data[]" in text:
        fail("pinned runtime must not contain the ROM data array")
    if len(text.encode()) > 512 * 1024:
        fail("pinned runtime looks too large to be a code-only preamble")
    shutil.copy2(runtime_file, PY_SRC / "dune-runtime.c")


def copy_metadata(manifest: dict) -> None:
    shutil.copy2(ROOT / "profiles" / "dune-us.json", PY_SRC / "profile.json")
    reference = {
        "rom_sha256": json.loads((ROOT / "profiles" / "dune-us.json").read_text())["sha256"],
        "runtime_sha256": manifest["runtime_sha256"],
        "recompiler": manifest.get("recompiler", "rearrakis@56c6a6da10+browser-overlay"),
        "window_title": manifest["window_title"],
        "expected_output_sha256": manifest["shipped_core_sha256"],
        "expected_output_bytes": manifest["shipped_core_bytes"],
        "shipped_core": manifest.get("shipped_core_note", "dune-web.c prepared from the pinned ReArrakis baseline"),
    }
    (PY_SRC / "reference.json").write_text(json.dumps(reference, indent=2) + "\n")
    (WEB / "reference.json").write_text(json.dumps(reference, indent=2) + "\n")
    shutil.copy2(PY_SRC / "reference.json", ROOT / "runtime" / "reference.json")


def copy_pyodide() -> None:
    source = ROOT / "node_modules" / "pyodide"
    if not source.is_dir():
        fail("node_modules/pyodide is missing; run: npm install")
    target = WEB / "vendor" / "pyodide"
    target.mkdir(parents=True, exist_ok=True)
    for name in PYODIDE_FILES:
        if not (source / name).is_file():
            fail(f"pyodide file missing: {name}; reinstall the npm package")
        shutil.copy2(source / name, target / name)


def build_package() -> None:
    out = WEB / "py-package.zip"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(PY_SRC.rglob("*")):
            if path.is_dir() or "__pycache__" in path.parts or path.suffix == ".pyc":
                continue
            archive.write(path, path.relative_to(PY_SRC).as_posix())
    print(f"py-package.zip: {out.stat().st_size} bytes")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-pyodide", action="store_true")
    args = parser.parse_args()
    manifest = load_manifest()
    copy_recompiler()
    copy_runtime(manifest)
    copy_metadata(manifest)
    if not args.skip_pyodide:
        copy_pyodide()
    build_package()
    reference = json.loads((WEB / "reference.json").read_text())
    print(f"runtime:  {reference['runtime_sha256']}")
    print(f"core:     {reference['expected_output_sha256']} ({reference['expected_output_bytes']} bytes)")


if __name__ == "__main__":
    main()

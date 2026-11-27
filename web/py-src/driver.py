"""Pyodide entry point: player's ROM -> game core C, byte-identical to the shipped build.

Runs inside a Web Worker. Never contains game data: the ROM arrives from the
player's file input and stays in this browser (memory + private OPFS cache).
"""
import hashlib
import json
import sys
import time
import traceback
from pathlib import Path

WORK = Path("/work")
PY_DIR = WORK / "py"
BUILD_DIR = WORK / "build"


def run():
    started = time.perf_counter()
    timings = {}
    try:
        t = time.perf_counter()
        import dune_build  # noqa: F401  (timed: package import)
        timings["import_recompiler"] = time.perf_counter() - t

        reference = json.loads((PY_DIR / "reference.json").read_text())
        profile = json.loads((PY_DIR / "profile.json").read_text())
        BUILD_DIR.mkdir(parents=True, exist_ok=True)
        rom_path = WORK / "rom.gen"
        if not rom_path.is_file():
            return json.dumps({"ok": False, "error": "ROM file is missing"})

        rom_sha = hashlib.sha256(rom_path.read_bytes()).hexdigest()
        result = dune_build.build(
            rom_path,
            profile,
            BUILD_DIR,
            PY_DIR / "dune-runtime.c",
            reference["window_title"],
        )
        timings.update(result.get("timings", {}))
        result["timings"] = timings
        result["total_seconds"] = time.perf_counter() - started
        result["rom_sha256"] = rom_sha
        result["python"] = sys.version.split()[0]
        result["expected_output_sha256"] = reference["expected_output_sha256"]
        result["expected_output_bytes"] = reference["expected_output_bytes"]
        result["matches_shipped_core"] = (
            result.get("output_sha256") == reference["expected_output_sha256"]
            and result.get("output_bytes") == reference["expected_output_bytes"]
        )
        result["ok"] = bool(result.get("matches_shipped_core"))
        return json.dumps(result)
    except dune_build.RomRejected as error:
        return json.dumps({"ok": False, "error": "unsupported-rom", "message": str(error)})
    except Exception as error:  # report instead of crashing the worker
        return json.dumps({
            "ok": False,
            "error": f"{type(error).__name__}: {error}",
            "traceback": traceback.format_exc()[-4000:],
            "timings": timings,
            "total_seconds": time.perf_counter() - started,
        })

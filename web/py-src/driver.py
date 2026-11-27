"""Pyodide entry point: player's ROM -> full game.wasm, byte-identical to the pinned core.

Runs inside a Web Worker. Never contains game data: the ROM arrives from the
player's file input and stays in this browser (memory + private OPFS cache).
The generated module is deterministic, so its SHA-256 is compared with the pinned
reference before the page offers to launch the game.
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
        import build_game_wasm  # noqa: F401  (timed: module import)
        import dune_build  # noqa: F401
        timings["import_recompiler"] = time.perf_counter() - t

        reference = json.loads((PY_DIR / "reference.json").read_text())
        profile = json.loads((PY_DIR / "profile.json").read_text())
        BUILD_DIR.mkdir(parents=True, exist_ok=True)
        rom_path = WORK / "rom.gen"
        if not rom_path.is_file():
            return json.dumps({"ok": False, "error": "ROM file is missing"})

        rom_sha = hashlib.sha256(rom_path.read_bytes()).hexdigest()
        result = build_game_wasm.build(
            rom_path,
            PY_DIR / "profile.json",
            PY_DIR / "abi.json",
            BUILD_DIR / "game.wasm",
        )
        timings.update(result.get("timings", {}))
        result["timings"] = timings
        result["total_seconds"] = time.perf_counter() - started
        result["rom_sha256"] = rom_sha
        result["python"] = sys.version.split()[0]
        # UI-compatible aliases: the "core" the page reports is the game module.
        result["output_sha256"] = result["game_sha256"]
        result["output_bytes"] = result["game_bytes"]
        result["expected_output_sha256"] = reference["expected_game_sha256"]
        result["expected_output_bytes"] = reference["expected_game_bytes"]
        result["expected_instructions"] = reference.get("game_instructions")
        result["matches_shipped_core"] = (
            result["game_sha256"] == reference["expected_game_sha256"]
            and result["game_bytes"] == reference["expected_game_bytes"]
        )
        result["ok"] = bool(result["matches_shipped_core"])
        return json.dumps(result)
    except Exception as error:
        if type(error).__name__ == "RomRejected":
            return json.dumps({"ok": False, "error": "unsupported-rom", "message": str(error)})
        return json.dumps({
            "ok": False,
            "error": f"{type(error).__name__}: {error}",
            "traceback": traceback.format_exc()[-4000:],
            "timings": timings,
            "total_seconds": time.perf_counter() - started,
        })

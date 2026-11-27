#!/usr/bin/env python3
"""Build a *test-only* runtime.wasm that additionally exports path-A audio.

The production ``runtime/wasm/runtime.wasm`` gains ``dune_rt_set_audio_mode`` /
``dune_rt_audio_pop`` once ``tools/wasm_runtime/src/dune_rt_audio.inc`` is
included in ``dune_rt_abi.inc`` and the runtime is rebuilt centrally.  Until
then (and for CI), this helper links the same pinned preamble + ABI layer plus
that include into ``.local/wasm-z80/runtime-build/runtime-audio.wasm`` without
touching the shared artifacts.

It reuses the staging directory of the last real runtime build
(``.local/wasm-runtime``) so the ABI, memory layout and pinned YM2612 driver are
byte-identical to ``runtime/wasm/runtime.wasm``; only the extra exports differ.

Usage:
    python3 tools/wasm_integration/build_audio_runtime.py [--force] [--json]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Optional

_HERE = Path(__file__).resolve().parent
_TOOLS = _HERE.parent
_ROOT = _TOOLS.parent
for _path in (str(_TOOLS), str(_HERE)):
    if _path not in sys.path:
        sys.path.insert(0, _path)

try:
    from .python_support import ROOT, ensure_tools_on_path
except ImportError:  # executed as a script
    from python_support import ROOT, ensure_tools_on_path  # type: ignore[no-redef]

ensure_tools_on_path()

DEFAULT_INPUTS = ROOT / ".local" / "wasm-runtime"
DEFAULT_OUT = ROOT / ".local" / "wasm-z80" / "runtime-build" / "runtime-audio.wasm"
RUNTIME_INC = ROOT / "tools" / "wasm_runtime" / "src" / "dune_rt_audio.inc"
MANIFEST = ROOT / "runtime" / "manifest.json"
LINK_FLAGS = [
    "-O2", "-sUSE_SDL=2", "-sSTANDALONE_WASM=1", "--no-entry",
    "-sIMPORTED_MEMORY=1", "-sINITIAL_MEMORY=67108864",
    "-sMAXIMUM_MEMORY=536870912", "-sALLOW_MEMORY_GROWTH=1",
    "-sALLOW_TABLE_GROWTH=1", "-sSTACK_SIZE=16777216",
    "-Wl,--wrap=SDL_GetWindowSize", "-Wl,--wrap=SDL_GetWindowSizeInPixels",
    "-Wl,--wrap=SDL_GetWindowPosition", "-Wl,--wrap=SDL_GetRendererOutputSize",
    "-Wl,--wrap=SDL_SetWindowSize",
]
AUDIO_EXPORTS = ("dune_rt_set_audio_mode", "dune_rt_audio_pop",
                 "dune_rt_audio_available", "dune_rt_audio_rate")


class AudioRuntimeError(RuntimeError):
    pass


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _stamp(inputs: Path) -> str:
    payload = {
        "preamble": _sha(inputs / "preamble.c"),
        "runtime_c": _sha(inputs / "runtime.c"),
        "audio_inc": _sha(RUNTIME_INC),
        "abi_fill": _sha(inputs / "dune_abi_fill.inc"),
        "layout": _sha(inputs / "dune_abi_layout.h"),
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


def _run_shell(command: str, cwd: Path, what: str) -> None:
    process = subprocess.run(["bash", "-lc", command], cwd=str(cwd),
                             capture_output=True, text=True)
    if process.returncode != 0:
        raise AudioRuntimeError(
            "%s failed (exit %d):\n%s\n%s"
            % (what, process.returncode, process.stdout[-3000:], process.stderr[-6000:])
        )


def _node_exports(path: Path) -> list:
    script = (
        "const fs=require('fs');"
        "WebAssembly.compile(fs.readFileSync(process.argv[1])).then(m=>"
        "console.log(JSON.stringify(WebAssembly.Module.exports(m).map(e=>e.name))))"
        ".catch(e=>{console.error(e);process.exit(1)});"
    )
    process = subprocess.run(["node", "-e", script, str(path)],
                             capture_output=True, text=True)
    if process.returncode != 0:
        raise AudioRuntimeError("cannot read %s exports:\n%s" % (path, process.stderr))
    return json.loads(process.stdout)


def build_audio_runtime(*, inputs: Path = DEFAULT_INPUTS, out: Path = DEFAULT_OUT,
                        force: bool = False) -> dict:
    inputs = Path(inputs)
    out = Path(out)
    if not RUNTIME_INC.is_file():
        raise AudioRuntimeError("missing %s" % RUNTIME_INC)
    for name in ("preamble.c", "runtime.c", "dune_abi_fill.inc",
                 "dune_abi_layout.h", "emsdk_env.sh"):
        if not (inputs / name).is_file():
            raise AudioRuntimeError(
                "runtime build staging is missing %s; run "
                "`python3 tools/wasm_runtime/build_runtime.py` first" % (inputs / name)
            )
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    pinned_preamble = manifest.get("full_preamble_sha256")
    if pinned_preamble and _sha(inputs / "preamble.c") != pinned_preamble:
        raise AudioRuntimeError(
            ".local/wasm-runtime/preamble.c does not match runtime/manifest.json; "
            "rebuild the runtime staging first"
        )
    stamp = _stamp(inputs)
    stamp_path = out.with_suffix(".stamp")
    if (not force and out.is_file() and stamp_path.is_file()
            and stamp_path.read_text(encoding="utf-8").strip() == stamp):
        return {"ok": True, "cached": True, "out": str(out), "bytes": out.stat().st_size}

    work = out.parent
    work.mkdir(parents=True, exist_ok=True)
    obj = work / "obj"
    obj.mkdir(exist_ok=True)
    for name in ("preamble.c", "runtime.c", "dune_abi_fill.inc", "dune_abi_layout.h"):
        shutil.copy2(inputs / name, work / name)
    runtime_c = work / "runtime.c"
    text = runtime_c.read_text(encoding="utf-8")
    if "dune_rt_audio.inc" not in text:
        runtime_c.write_text(
            text + '\n/* test-only path-A audio exports */\n#include "dune_rt_audio.inc"\n',
            encoding="utf-8",
        )
    audio_obj = inputs / "obj" / "audio.o"
    if not audio_obj.is_file():
        source = inputs / "audio_patched.cpp"
        if not source.is_file():
            raise AudioRuntimeError("missing prepared YM2612 source %s" % source)
        _run_shell(
            "source %s >/dev/null 2>&1 && em++ -O2 -std=c++17 "
            "-I%s/vendor/rearrakis/genesis_recompiler -c %s -o %s"
            % (inputs / "emsdk_env.sh", ROOT, source, work / "obj" / "audio.o"),
            cwd=ROOT, what="em++ audio",
        )
        audio_obj = work / "obj" / "audio.o"
    _run_shell(
        "source %s >/dev/null 2>&1 && emcc -O2 -std=c11 -Wno-unused-function "
        "-DGENESIS_SDL2 -DGENESIS_AUDIO -D__EMSCRIPTEN__ -sUSE_SDL=2 "
        "-I%s -I%s -I%s -I%s -c %s -o %s"
        % (inputs / "emsdk_env.sh", ROOT / "runtime" / "adapters",
           ROOT / "vendor" / "rearrakis" / "genesis_recompiler",
           ROOT / "tools" / "wasm_runtime" / "src", work, runtime_c,
           obj / "runtime.o"),
        cwd=ROOT, what="emcc runtime",
    )
    _run_shell(
        "source %s >/dev/null 2>&1 && em++ %s %s %s -o %s"
        % (inputs / "emsdk_env.sh", " ".join(LINK_FLAGS),
           obj / "runtime.o", audio_obj, out),
        cwd=ROOT, what="em++ link runtime",
    )
    exports = _node_exports(out)
    missing = [name for name in AUDIO_EXPORTS if name not in exports]
    if missing:
        raise AudioRuntimeError("audio runtime is missing exports: %s" % missing)
    stamp_path.write_text(stamp + "\n", encoding="utf-8")
    return {
        "ok": True,
        "cached": False,
        "out": str(out),
        "bytes": out.stat().st_size,
        "sha256": _sha(out),
        "exports": len(exports),
        "audio_exports": list(AUDIO_EXPORTS),
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--inputs", type=Path, default=DEFAULT_INPUTS)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    try:
        result = build_audio_runtime(inputs=args.inputs, out=args.out, force=args.force)
    except AudioRuntimeError as error:
        print("build_audio_runtime: %s" % error, file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps(result, indent=1))
    else:
        print("audio runtime: %s (%d B%s)"
              % (result["out"], result["bytes"],
                 ", cached" if result.get("cached") else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Build a full ``game.wasm`` (every decoded ROM page) against ``runtime.wasm``.

This is the browser host's module builder.  It deliberately does **not** modify
the emitter package: it imports ``tools/wasm_emitter`` read-only and reuses the
same ABI descriptor that ``tools/wasm_integration/build_page_module.py`` uses,
so the produced module is byte-for-byte the module the runtime expects:

* ``env.memory`` = the runtime-owned linear memory;
* ``env.dune_*`` = the 16 runtime helper exports (``dune_read_mem`` … ``dune_fail``);
* exports ``translated_step`` / ``warmup_all`` / ``__indirect_function_table``;
* no own memory, no data segments, no game data (only translated code).

The player ROM is read at build time and never copied into the repository: the
module lives in ``.local/`` (gitignored) and is rebuilt on demand.

Usage:
    python3 tools/host/build_game_module.py \
        --rom "/path/to/Dune - The Battle for Arrakis (USA).gen" \
        [--out .local/host-build/game.wasm] [--json]

Exit codes: 0 built, 2 build refused (ABI/ROM/decode problem), 3 unsupported ops.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools"
INTEGRATION = TOOLS / "wasm_integration"
EMITTER = TOOLS / "wasm_emitter"
for _path in (str(TOOLS), str(INTEGRATION)):
    if _path not in sys.path:
        sys.path.insert(0, _path)

from python_support import (  # noqa: E402  (tools/wasm_integration)
    ensure_tools_on_path,
    reexec_with_newer_python,
)

ensure_tools_on_path()

from wasm_emitter import check_page, game_module  # noqa: E402
from wasm_emitter.translate import UnsupportedInstruction  # noqa: E402
from wasm_integration import runtime_abi, wasm_inspect  # noqa: E402

DEFAULT_OUT = ROOT / ".local" / "host-build" / "game.wasm"
DEFAULT_PROFILE = ROOT / "profiles" / "dune-us.json"
HELPER_PREFIX = "dune_"


class BuildError(RuntimeError):
    """The module cannot be built against this runtime ABI."""


def _summary(meta: dict) -> dict:
    """Small JSON summary (the emitter's meta embeds all 40k instructions)."""
    build = meta.get("build") or {}
    return {
        "instructions": len(meta.get("instructions") or []),
        "pages": meta.get("pages") or [],
        "page_count": len(meta.get("pages") or []),
        "ram_variant_pcs": len(meta.get("ram_variant_pcs") or []),
        "generation_ms": build.get("generation_ms"),
        "functions": build.get("functions"),
        "fail_codes_used": build.get("fail_codes_used"),
        "abi_hash": meta.get("abi_hash"),
    }


def build_full_game_module(
    rom_path: Path,
    *,
    out: Path = DEFAULT_OUT,
    profile: Path = DEFAULT_PROFILE,
    runtime: Path = runtime_abi.DEFAULT_RUNTIME,
    loader: Path = runtime_abi.DEFAULT_LOADER,
    manifest: Path = runtime_abi.DEFAULT_MANIFEST,
    node: str | None = None,
    allow_lossy_fail_codes: bool = False,
    write: bool = True,
) -> dict:
    """Decode the ROM, emit one module for all pages, verify it, write it."""
    started = time.perf_counter()
    rom_path = Path(rom_path).resolve()
    if not rom_path.is_file():
        raise BuildError("ROM not found: %s" % rom_path)

    # 1. ABI from runtime.wasm (verified descriptor), before the ROM is read.
    rt_abi = runtime_abi.load_runtime_abi(
        runtime=runtime, loader=loader, manifest=manifest, node=node
    )
    if rt_abi.abi_hash != rt_abi.pinned_abi_hash:
        raise BuildError(
            "runtime ABI hash %s != pinned manifest hash %s"
            % (rt_abi.abi_hash, rt_abi.pinned_abi_hash)
        )
    abi_ms = (time.perf_counter() - started) * 1000.0

    # 2. Decode every reachable instruction the same way the CLI does.
    decode_started = time.perf_counter()
    rom, program, decode_stats = check_page.decode_program(rom_path, Path(profile))
    decode_ms = (time.perf_counter() - decode_started) * 1000.0
    if program.errors:
        raise BuildError("decoder reported %d errors" % len(program.errors))

    instructions = list(program.instructions.values())
    if not instructions:
        raise BuildError("the ROM decoded to zero instructions")
    unsupported = game_module.unsupported_ops(instructions)
    if unsupported:
        raise UnsupportedInstruction(
            "unsupported operations on the full program: %s"
            % ", ".join("%s×%d" % item for item in sorted(unsupported.items()))
        )

    # 3. Absolute memory layout published by the runtime descriptor.
    layout = rt_abi.memory_layout(len(rom))

    # 4. Emit one module: all ROM pages share one br_table dispatcher.
    data, meta = game_module.build_module(
        program,
        instructions,
        rt_abi.cpu_abi,
        layout,
        label="full",
        helper_prefix=HELPER_PREFIX,
        fail_code_map=dict(rt_abi.fail_codes.canonical_to_runtime),
    )

    # 5. Structural proof: the runtime's expected game side, no memory/data.
    inspect = wasm_inspect.inspect_wasm(data)
    checks = runtime_abi.verify_game_module(inspect, rt_abi.export_names, HELPER_PREFIX)
    build_meta = meta.get("build") or {}
    fail_codes_used = list(build_meta.get("fail_codes_used") or [])
    lossy = rt_abi.fail_codes.has_lossy(fail_codes_used)
    if lossy and not allow_lossy_fail_codes:
        raise BuildError(
            "full program uses fail codes with no exact runtime counterpart: %s"
            % lossy
        )

    summary = _summary(meta)
    summary["module_bytes"] = len(data)
    summary["module_sha256"] = hashlib.sha256(data).hexdigest()
    summary["lossy_fail_codes_used"] = lossy
    summary["checks"] = checks
    summary["abi"] = {
        "source": "runtime.wasm:dune_abi_descriptor()",
        "hash": rt_abi.abi_hash,
        "pinned_hash": rt_abi.pinned_abi_hash,
        "word_count": len(rt_abi.words),
        "pointer_bits": rt_abi.pointer_bits,
        "cpu": rt_abi.cpu_abi.describe(),
    }
    summary["runtime_wasm"] = {
        "path": str(rt_abi.runtime),
        "bytes": rt_abi.runtime_bytes,
        "sha256": rt_abi.runtime_sha256,
    }
    summary["rom"] = {
        "path": str(rom_path),
        "bytes": len(rom),
        "sha256": decode_stats.get("rom_sha256"),
        "entries": decode_stats.get("entries"),
        "ram_variants": decode_stats.get("ram_variants"),
    }
    summary["timing"] = {
        "abi_ms": round(abi_ms, 1),
        "decode_ms": round(decode_ms, 1),
        "total_ms": round((time.perf_counter() - started) * 1000.0, 1),
    }

    # 6. Write module + a small meta (no instruction list, no ROM bytes).
    if write:
        out = Path(out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(data)
        meta_path = out.with_suffix(".meta.json")
        meta_path.write_text(
            json.dumps(
                {
                    "format": "dune-host-game-module/1",
                    "kind": "full",
                    "label": "full",
                    "out": str(out),
                    **summary,
                },
                indent=1,
                sort_keys=False,
            )
            + "\n",
            encoding="utf-8",
        )
        summary["artifacts"] = {"wasm": str(out), "meta": str(meta_path)}
    return summary


def main(argv=None) -> int:
    reexec_with_newer_python(Path(__file__))
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--rom", type=Path, required=True)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--profile", type=Path, default=DEFAULT_PROFILE)
    parser.add_argument("--runtime", type=Path, default=runtime_abi.DEFAULT_RUNTIME)
    parser.add_argument("--loader", type=Path, default=runtime_abi.DEFAULT_LOADER)
    parser.add_argument("--manifest", type=Path, default=runtime_abi.DEFAULT_MANIFEST)
    parser.add_argument("--node", default=None)
    parser.add_argument(
        "--allow-lossy-fail-codes",
        action="store_true",
        help="build even if LINE-A/LINE-F have no exact runtime fail code",
    )
    parser.add_argument("--json", action="store_true", help="print a JSON summary")
    args = parser.parse_args(argv)

    try:
        summary = build_full_game_module(
            args.rom,
            out=args.out,
            profile=args.profile,
            runtime=args.runtime,
            loader=args.loader,
            manifest=args.manifest,
            node=args.node,
            allow_lossy_fail_codes=args.allow_lossy_fail_codes,
        )
    except (BuildError, UnsupportedInstruction, runtime_abi.RuntimeAbiError) as error:
        print("build_game_module: %s" % error, file=sys.stderr)
        return 2 if isinstance(error, BuildError) else 3

    if args.json:
        printable = dict(summary)
        printable.pop("checks", None)
        print(json.dumps(printable, indent=1))
        return 0

    print("== full game.wasm against runtime.wasm ABI ==")
    print(
        "ABI:       %s (hash %s, %d words, %d-bit)"
        % (
            summary["abi"]["cpu"],
            summary["abi"]["hash"][:16],
            summary["abi"]["word_count"],
            summary["abi"]["pointer_bits"],
        )
    )
    print(
        "runtime:   %s (%d B, sha %s)"
        % (
            summary["runtime_wasm"]["path"],
            summary["runtime_wasm"]["bytes"],
            summary["runtime_wasm"]["sha256"][:16],
        )
    )
    print(
        "decoded:   %d instructions on %d pages, entries %s, rom sha %s"
        % (
            summary["instructions"],
            summary["page_count"],
            summary["rom"]["entries"],
            (summary["rom"]["sha256"] or "")[:16],
        )
    )
    print(
        "game.wasm: %d B, sha %s, built in %.1f ms (decode %.1f ms)"
        % (
            summary["module_bytes"],
            summary["module_sha256"][:16],
            summary["timing"]["total_ms"],
            summary["timing"]["decode_ms"],
        )
    )
    print("imports:   %s" % ", ".join(summary["checks"]["imports"]))
    print("exports:   %s" % ", ".join(summary["checks"]["exports"]))
    print("fail codes used: %s" % summary["fail_codes_used"])
    print("PASS: full game.wasm uses runtime.wasm's ABI descriptor")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Emit ``game.wasm`` for one real ROM page against **runtime.wasm's** ABI.

The emitter itself is layout-agnostic; this script supplies the numbers.  The
descriptor is read from the shipped ``runtime/wasm/runtime.wasm`` through
``runtime/wasm/loader.mjs`` (``dune_abi_descriptor()``, verified
``dune_abi_hash()``/``dune_abi_selfcheck()``), converted to the emitter's
``CpuAbi``/``MemoryLayout`` and then used for every offset, absolute address and
fail code in the generated module.  No native C oracle numbers are involved.

What the module looks like (page ``$013``, 78 instructions):

* imports ``env.memory`` (the runtime-owned 64 MiB linear memory) and the 16
  helpers under their real runtime names ``env.dune_read_mem`` … ``env.dune_fail``;
* no data segments, no own memory, no globals -- it is pure code (BYOP rule);
* exports ``translated_step``, ``translated_step_via_table``, ``warmup_all`` and
  ``__indirect_function_table`` for the runtime's funcref table.

Usage:
    python3 tools/wasm_integration/build_page_module.py \
        --rom "/path/to/Dune (USA).gen" --page 0x13

Outputs (gitignored, no game data leaves ``.local/``):
    .local/wasm-integration/page_013.wasm
    .local/wasm-integration/page_013.meta.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path
from typing import Optional

_HERE = Path(__file__).resolve().parent
_TOOLS = _HERE.parent
for _path in (str(_TOOLS), str(_HERE)):
    if _path not in sys.path:
        sys.path.insert(0, _path)

try:  # imported as ``wasm_integration.build_page_module``
    from .python_support import (  # type: ignore[import-not-found]
        ROOT, ensure_tools_on_path, reexec_with_newer_python,
    )
    from . import runtime_abi, wasm_inspect  # type: ignore[import-not-found]
except ImportError:  # executed as ``python3 tools/wasm_integration/build_page_module.py``
    from python_support import (  # type: ignore[no-redef]
        ROOT, ensure_tools_on_path, reexec_with_newer_python,
    )
    from wasm_integration import runtime_abi, wasm_inspect  # type: ignore[no-redef]

ensure_tools_on_path()

from wasm_emitter import abi, check_page, game_module  # noqa: E402
from wasm_emitter.translate import UnsupportedInstruction  # noqa: E402

DEFAULT_OUT = ROOT / ".local" / "wasm-integration"
DEFAULT_PAGE = 0x13
HELPER_PREFIX = "dune_"


class BuildError(RuntimeError):
    """The page cannot be emitted against this runtime ABI."""


def page_instructions(program, page: int):
    return [inst for inst in program.instructions.values() if (inst.pc >> 12) == page]


def build_page_game_module(
    rom_path: Path,
    page: int = DEFAULT_PAGE,
    *,
    profile: Path = check_page.DEFAULT_PROFILE,
    runtime: Path = runtime_abi.DEFAULT_RUNTIME,
    loader: Path = runtime_abi.DEFAULT_LOADER,
    manifest: Path = runtime_abi.DEFAULT_MANIFEST,
    out_dir: Path = DEFAULT_OUT,
    node: Optional[str] = None,
    allow_lossy_fail_codes: bool = False,
    decoded=None,
    runtime_descriptor: Optional[runtime_abi.RuntimeAbi] = None,
    write: bool = True,
) -> dict:
    """Build one page ``game.wasm`` against the runtime descriptor.

    ``decoded`` lets callers reuse an already decoded ``Program`` (the
    differential script decodes the ROM once for the C oracle too).
    """
    started = time.perf_counter()
    rom_path = Path(rom_path).resolve()

    # 1. The ABI comes from runtime.wasm -- verified, then converted.  This
    #    happens before the ROM is touched so a stale/tampered descriptor can
    #    never produce a module that silently uses native numbers.
    rt_abi = runtime_descriptor or runtime_abi.load_runtime_abi(
        runtime=runtime, loader=loader, manifest=manifest, node=node
    )
    if rt_abi.abi_hash != rt_abi.pinned_abi_hash:
        raise BuildError("runtime ABI hash %s != pinned manifest hash %s"
                         % (rt_abi.abi_hash, rt_abi.pinned_abi_hash))
    if not rom_path.is_file():
        raise BuildError("ROM not found: %s" % rom_path)

    # 2. Decode the real page with the same decoder check_page.py uses.
    if decoded is None:
        rom, program, decode_stats = check_page.decode_program(rom_path, Path(profile))
    else:
        rom, program, decode_stats = decoded
    instructions = page_instructions(program, page)
    if not instructions:
        raise BuildError("page $%03x has no decoded instructions" % page)
    missing = game_module.unsupported_ops(instructions)
    if missing:
        raise BuildError("page $%03x has unsupported operations: %s" % (page, missing))

    # 3. Layout published by the descriptor (absolute linear-memory addresses).
    layout = rt_abi.memory_layout(len(rom))
    if layout.rom + len(rom) > layout.pages * 0x10000:
        raise BuildError("ROM does not fit into the runtime memory layout")

    # 4. Emit.  helper_prefix/dune_ + the descriptor's fail-code numbers are the
    #    only differences from the native-target emitter output.
    data, meta = game_module.build_page_module(
        program,
        page,
        rt_abi.cpu_abi,
        layout,
        instructions=instructions,
        helper_prefix=HELPER_PREFIX,
        fail_code_map=dict(rt_abi.fail_codes.canonical_to_runtime),
    )

    # 5. Prove the module is the runtime's expected game side (imports/exports,
    #    no memory/data/globals) before anything is written to disk.
    inspect = wasm_inspect.inspect_wasm(data)
    module_checks = runtime_abi.verify_game_module(
        inspect, rt_abi.export_names, HELPER_PREFIX
    )

    fail_codes_used = list(meta["build"].get("fail_codes_used") or [])
    lossy_used = rt_abi.fail_codes.has_lossy(fail_codes_used)
    if lossy_used and not allow_lossy_fail_codes:
        raise BuildError(
            "page $%03x uses fail codes with no exact runtime counterpart: %s "
            "(the runtime collapses LINE_A/LINE_F into ILLEGAL_INSTRUCTION; "
            "pass --allow-lossy-fail-codes to build a module whose diff can "
            "only be exact for the other codes)" % (page, lossy_used)
        )

    # 6. Everything the linker/harness needs, including the full descriptor.
    meta["format"] = "dune-game-wasm-runtime/1"
    meta["runtime_abi"] = rt_abi.to_dict()
    meta["runtime_abi_hash"] = rt_abi.abi_hash
    meta["pinned_abi_hash"] = rt_abi.pinned_abi_hash
    meta["helper_prefix"] = HELPER_PREFIX
    meta["fail_codes"] = {
        **rt_abi.fail_codes.to_dict(),
        "canonical_used": fail_codes_used,
        "lossy_used": lossy_used,
        # C ``fail(c, reason, address)`` strings, mapped to the canonical codes
        # the native C oracle reports; the Node harness needs these to classify
        # faults raised *inside* runtime helpers (address error, write to ROM...).
        "c_reasons": [[prefix, abi.FAIL_CODES[name]] for prefix, name in abi.FAIL_REASONS],
    }
    meta["module_checks"] = module_checks
    meta["modules"]["bytes"] = len(data)
    meta["modules"]["sha256"] = hashlib.sha256(data).hexdigest()

    elapsed_ms = (time.perf_counter() - started) * 1000.0
    result = {
        "format": "dune-wasm-integration-build/1",
        "ok": True,
        "page": page,
        "label": "page_%03x" % page,
        "rom_sha256": decode_stats.get("rom_sha256"),
        "runtime_wasm": {
            "path": str(rt_abi.runtime),
            "sha256": rt_abi.runtime_sha256,
            "bytes": rt_abi.runtime_bytes,
        },
        "abi": {
            "source": "runtime.wasm:dune_abi_descriptor()",
            "hash": rt_abi.abi_hash,
            "pinned_hash": rt_abi.pinned_abi_hash,
            "pointer_bits": rt_abi.pointer_bits,
            "word_count": len(rt_abi.words),
            "cpu": rt_abi.cpu_abi.describe(),
            "selfcheck": {
                "dune_abi_selfcheck_pinned": rt_abi.descriptor_checks.get("selfcheck_pinned"),
                "dune_abi_selfcheck_own": rt_abi.descriptor_checks.get("selfcheck_own"),
                "hash_recomputed_ok": rt_abi.descriptor_checks.get("hash_ok_recomputed"),
                "rom_buffer_after_init": rt_abi.descriptor_checks.get("rom_buffer_after_init"),
            },
            "offsets_used": {
                "pc": rt_abi.cpu_abi.pc,
                "sr": rt_abi.cpu_abi.sr,
                "fault": rt_abi.cpu_abi.fault,
                "instruction_cycles": rt_abi.cpu_abi.instruction_cycles,
            },
        },
        "memory": layout.to_dict(),
        "decode": decode_stats,
        "instructions": len(instructions),
        "module": meta["modules"],
        "checks": module_checks,
        "fail_codes_used": fail_codes_used,
        "lossy_fail_codes_used": lossy_used,
        "elapsed_ms": round(elapsed_ms, 1),
    }

    if write:
        out_dir = Path(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        wasm_path = out_dir / ("page_%03x.wasm" % page)
        meta_path = out_dir / ("page_%03x.meta.json" % page)
        wasm_path.write_bytes(data)
        meta_path.write_text(json.dumps(meta, indent=1), encoding="utf-8")
        result["artifacts"] = {"wasm": str(wasm_path), "meta": str(meta_path)}
        result["meta"] = meta
    return result


def main(argv=None) -> int:
    reexec_with_newer_python(Path(__file__))
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--rom", type=Path, required=True,
                        help="player-supplied ROM (never stored or committed)")
    parser.add_argument("--page", type=lambda text: int(text, 0), default=DEFAULT_PAGE,
                        help="4 KiB ROM page to translate (default 0x13)")
    parser.add_argument("--profile", type=Path, default=check_page.DEFAULT_PROFILE)
    parser.add_argument("--runtime", type=Path, default=runtime_abi.DEFAULT_RUNTIME)
    parser.add_argument("--loader", type=Path, default=runtime_abi.DEFAULT_LOADER)
    parser.add_argument("--manifest", type=Path, default=runtime_abi.DEFAULT_MANIFEST)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--node", default=None)
    parser.add_argument("--allow-lossy-fail-codes", action="store_true",
                        help="build even if the page needs LINE_A/LINE_F (no exact "
                             "runtime fail code exists)")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    try:
        result = build_page_game_module(
            args.rom, args.page, profile=args.profile, runtime=args.runtime,
            loader=args.loader, manifest=args.manifest, out_dir=args.out,
            node=args.node, allow_lossy_fail_codes=args.allow_lossy_fail_codes,
        )
    except (BuildError, runtime_abi.RuntimeAbiError, UnsupportedInstruction) as error:
        print("build_page_module: %s" % error, file=sys.stderr)
        return 2

    if args.json:
        printable = dict(result)
        printable.pop("meta", None)
        print(json.dumps(printable, indent=1))
        return 0

    print("== game.wasm against runtime.wasm ABI ==")
    print("ABI:      %s (hash %s, %d-bit, %d words)"
          % (result["abi"]["cpu"], result["abi"]["hash"][:16],
             result["abi"]["pointer_bits"], result["abi"]["word_count"]))
    selfcheck = result["abi"]["selfcheck"]
    print("ABI:      dune_abi_selfcheck(pinned)=%r, hash recomputed ok=%r, ROM buffer=0x%x"
          % (selfcheck["dune_abi_selfcheck_pinned"],
             selfcheck["hash_recomputed_ok"],
             selfcheck["rom_buffer_after_init"] or 0))
    print("runtime:  %s (%d B, sha %s)"
          % (result["runtime_wasm"]["path"], result["runtime_wasm"]["bytes"],
             result["runtime_wasm"]["sha256"][:16]))
    print("page $%03x: %d instructions, module %d B (handlers %d B, %.1f B/instr)"
          % (result["page"], result["instructions"], result["module"]["bytes"],
             result["module"]["handler_bytes"],
             result["module"]["bytes_per_instruction"]))
    print("imports:  %s" % ", ".join(result["checks"]["imports"]))
    print("exports:  %s" % ", ".join(result["checks"]["exports"]))
    print("fail codes used (canonical): %s" % result["fail_codes_used"])
    print("built in %.1f ms -> %s"
          % (result["elapsed_ms"], result["artifacts"]["wasm"]))
    print("PASS: page $%03x game.wasm uses runtime.wasm's ABI descriptor" % result["page"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

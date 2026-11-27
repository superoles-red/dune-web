#!/usr/bin/env python3
"""Emit the one full ``game.wasm`` for **all** decoded 68000 pages of a ROM.

This is the all-pages counterpart of :mod:`build_page_module`: instead of one
4 KiB page it emits every instruction the pinned recompiler decoded (40 382
instructions / 48 pages for Dune USA), dispatches them through the same
two-level ``br_table`` page/slot structure and links against the ABI that
``runtime/wasm/runtime.wasm`` publishes (``dune_abi_descriptor()``).

What the module contains (and nothing else):

* imports ``env.memory`` (the runtime-owned memory) and the 16 helper functions
  under their runtime names ``env.dune_read_mem`` ... ``env.dune_fail``;
* no data segments, no own memory, no globals -- only translated code (BYOP);
* one function per 4 KiB page that has instructions, with the inlined handlers;
* ``translated_step(c)``: PC validation (BAD_PC / ODD_PC), PAGE_SHIFT page
  dispatch (16x16 ``br_table`` for ROM pages, 16-entry table for RAM pages) and
  a ``call`` into the page function;
* ``translated_step_via_table(c)``: same function through the exported funcref
  table (game -> own table direction);
* ``translated_z80_step(c) -> i32``: honest UNTRANSLATED stub.  Z80 translation
  is out of scope; the stub reports the canonical UNTRANSLATED failure at the
  Z80 PC and returns 0 cycles instead of pretending to succeed;
* ``warmup_all(c)``: calls every page function with the magic PC so V8/Liftoff
  compiles the whole module under the loading screen;
* ``__indirect_function_table``: initialised with ``translated_step`` at slot 0
  so the runtime can append the module and call it indirectly.

Usage:
    python3 tools/wasm_integration/build_full_module.py \
        --rom "/path/to/Dune - The Battle for Arrakis (USA).gen"

Outputs (gitignored, game data never leaves ``.local/``):
    .local/wasm-full/game.wasm
    .local/wasm-full/meta.json
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

try:  # imported as ``wasm_integration.build_full_module``
    from .python_support import (  # type: ignore[import-not-found]
        ROOT, ensure_tools_on_path, reexec_with_newer_python,
    )
    from . import runtime_abi, wasm_inspect  # type: ignore[import-not-found]
except ImportError:  # executed as ``python3 tools/wasm_integration/build_full_module.py``
    from python_support import (  # type: ignore[no-redef]
        ROOT, ensure_tools_on_path, reexec_with_newer_python,
    )
    from wasm_integration import runtime_abi, wasm_inspect  # type: ignore[no-redef]

ensure_tools_on_path()

from wasm_emitter import abi, check_page, game_module, z80_translate  # noqa: E402
from wasm_emitter.translate import UnsupportedInstruction  # noqa: E402

DEFAULT_OUT = ROOT / ".local" / "wasm-full"
HELPER_PREFIX = "dune_"
FULL_GAME_EXPORTS = (
    "translated_step", "translated_step_via_table", "translated_z80_step",
    "warmup_all", "__indirect_function_table",
)
META_FORMAT = "dune-game-wasm-runtime-full/1"


class BuildError(RuntimeError):
    """The full module cannot be emitted against this runtime ABI."""


def page_instructions(program) -> list:
    """Every decoded instruction, sorted by PC (all pages, one module)."""
    return sorted(program.instructions.values(), key=lambda inst: inst.pc)


def build_full_game_module(
    rom_path: Path,
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
    z80: bool = False,
) -> dict:
    """Build the single all-pages ``game.wasm``; returns a JSON-able report.

    ``decoded`` lets callers reuse an already decoded ``Program`` (the full
    differential decodes the ROM once for the C oracle as well).
    """
    started = time.perf_counter()
    rom_path = Path(rom_path).resolve()

    # 1. ABI from runtime.wasm, verified against the pinned manifest hash.
    abi_started = time.perf_counter()
    rt_abi = runtime_descriptor or runtime_abi.load_runtime_abi(
        runtime=runtime, loader=loader, manifest=manifest, node=node
    )
    abi_ms = (time.perf_counter() - abi_started) * 1000.0
    if rt_abi.abi_hash != rt_abi.pinned_abi_hash:
        raise BuildError("runtime ABI hash %s != pinned manifest hash %s"
                         % (rt_abi.abi_hash, rt_abi.pinned_abi_hash))
    if not rom_path.is_file():
        raise BuildError("ROM not found: %s" % rom_path)

    # 2. Decode every page exactly like check_page.py.
    decode_started = time.perf_counter()
    if decoded is None:
        rom, program, decode_stats = check_page.decode_program(rom_path, Path(profile))
    else:
        rom, program, decode_stats = decoded
    decode_ms = (time.perf_counter() - decode_started) * 1000.0

    instructions = page_instructions(program)
    if not instructions:
        raise BuildError("the ROM decoded to zero instructions")
    # 2b. Z80 program: the pinned six-image plan (2577 guarded PCs / 3095
    #     variants).  Off by default so the shipped stub artifact/tests keep
    #     working; ``--z80`` emits the real translated_z80_step that audio needs.
    z80_program = None
    z80_summary = None
    if z80:
        z80_started = time.perf_counter()
        z80_program = z80_translate.analyze_dune_z80(rom)
        z80_summary = z80_translate.z80_program_summary(z80_program)
        if z80_summary["errors"]:
            raise BuildError("Z80 analysis produced %d decode error(s)"
                             % len(z80_summary["errors"]))
        z80_ms = (time.perf_counter() - z80_started) * 1000.0
    else:
        z80_ms = 0.0
    missing = game_module.unsupported_ops(instructions)
    if missing:
        raise BuildError("unsupported operations in the full program: %s" % missing)

    # 3. Layout published by the descriptor (absolute linear-memory addresses).
    layout = rt_abi.memory_layout(len(rom))
    if layout.rom + len(rom) > layout.pages * 0x10000:
        raise BuildError("ROM does not fit into the runtime memory layout")

    pages = sorted({inst.pc >> 12 for inst in instructions})
    outside = [page for page in pages
               if 0x100 <= page < game_module.RAM_PAGE_BASE]
    if outside:
        raise BuildError("pages %r are outside the ROM/RAM dispatch regions"
                         % outside)

    # 4. Emit every page into ONE module with the z80 UNTRANSLATED stub.  The
    #    per-instruction disassembly stays out of the meta (40k entries would
    #    add megabytes of JSON nothing needs at link time).
    build_started = time.perf_counter()
    data, game_meta = game_module.build_module(
        program, instructions, rt_abi.cpu_abi, layout,
        label="full", helper_prefix=HELPER_PREFIX,
        fail_code_map=dict(rt_abi.fail_codes.canonical_to_runtime),
        z80_stub=not z80,
        z80_program=z80_program,
        instruction_meta=False,
    )
    build_ms = (time.perf_counter() - build_started) * 1000.0

    # 5. Prove the module is the runtime's expected game side before writing.
    inspect = wasm_inspect.inspect_wasm(data)
    module_checks = runtime_abi.verify_game_module(
        inspect, rt_abi.export_names, HELPER_PREFIX,
        expected_exports=FULL_GAME_EXPORTS,
        extra_helpers=z80_translate.Z80_HELPER_NAMES if z80 else (),
    )
    if game_meta["pages"] != pages:
        raise BuildError("emitted pages %r != decoded pages %r"
                         % (game_meta["pages"], pages))
    if game_meta["instruction_count"] != len(instructions):
        raise BuildError("emitted %d instructions, decoded %d"
                         % (game_meta["instruction_count"], len(instructions)))

    fail_codes_used = list(game_meta["build"].get("fail_codes_used") or [])
    lossy_used = rt_abi.fail_codes.has_lossy(fail_codes_used)
    if lossy_used and not allow_lossy_fail_codes:
        raise BuildError(
            "the full program uses fail codes with no exact runtime counterpart: "
            "%s (pass --allow-lossy-fail-codes to build a module whose diff can "
            "only be exact for the other codes)" % lossy_used
        )

    # 6. Linker/harness meta: same shape as the page module's meta.json plus the
    #    full-module summary.  ``module.sha256`` is what link_and_run.mjs pins.
    meta = {
        "format": META_FORMAT,
        "generated_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "page": None,
        "label": "full",
        "instruction_count": len(instructions),
        "pages": pages,
        "page_count": len(pages),
        "page_instruction_counts": game_meta["page_instruction_counts"],
        "runtime_abi": rt_abi.to_dict(),
        "runtime_abi_hash": rt_abi.abi_hash,
        "pinned_abi_hash": rt_abi.pinned_abi_hash,
        "abi": rt_abi.cpu_abi.to_dict(),
        "memory": layout.to_dict(),
        "helper_prefix": HELPER_PREFIX,
        "fail_codes": {
            **rt_abi.fail_codes.to_dict(),
            "canonical_used": fail_codes_used,
            "lossy_used": lossy_used,
            "untranslated_canonical": abi.FAIL_UNTRANSLATED,
            # C ``fail(c, reason, address)`` strings -> canonical codes, so the
            # Node harness can classify faults raised inside runtime helpers.
            "c_reasons": [[prefix, abi.FAIL_CODES[name]]
                          for prefix, name in abi.FAIL_REASONS],
        },
        "module_checks": module_checks,
        "game": game_meta,
        "module": {
            **game_meta["modules"],
            "exports": list(FULL_GAME_EXPORTS),
        },
    }

    total_ms = (time.perf_counter() - started) * 1000.0
    result = {
        "format": "dune-wasm-full-build/1",
        "ok": True,
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
        },
        "memory": layout.to_dict(),
        "decode": decode_stats,
        "instructions": len(instructions),
        "pages": pages,
        "z80": z80_summary,
        "page_count": len(pages),
        "module": game_meta["modules"],
        "checks": module_checks,
        "fail_codes_used": fail_codes_used,
        "lossy_fail_codes_used": lossy_used,
        "timing_ms": {
            "abi": round(abi_ms, 1),
            "decode": round(decode_ms, 1),
            "z80": round(z80_ms, 1),
            "build": round(build_ms, 1),
            "total": round(total_ms, 1),
        },
        "elapsed_ms": round(total_ms, 1),
    }

    if write:
        out_dir = Path(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        wasm_path = out_dir / "game.wasm"
        meta_path = out_dir / "meta.json"
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
    parser.add_argument("--profile", type=Path, default=check_page.DEFAULT_PROFILE)
    parser.add_argument("--runtime", type=Path, default=runtime_abi.DEFAULT_RUNTIME)
    parser.add_argument("--loader", type=Path, default=runtime_abi.DEFAULT_LOADER)
    parser.add_argument("--manifest", type=Path, default=runtime_abi.DEFAULT_MANIFEST)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--node", default=None)
    parser.add_argument("--z80", action="store_true",
                        help="emit the real translated_z80_step (Z80 sound) "
                             "instead of the UNTRANSLATED stub")
    parser.add_argument("--allow-lossy-fail-codes", action="store_true",
                        help="build even if instructions need LINE_A/LINE_F "
                             "(no exact runtime fail code exists)")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    try:
        result = build_full_game_module(
            args.rom, profile=args.profile, runtime=args.runtime,
            loader=args.loader, manifest=args.manifest, out_dir=args.out,
            node=args.node,
            allow_lossy_fail_codes=args.allow_lossy_fail_codes,
            z80=args.z80,
        )
    except (BuildError, runtime_abi.RuntimeAbiError, UnsupportedInstruction) as error:
        print("build_full_module: %s" % error, file=sys.stderr)
        return 2

    if args.json:
        printable = dict(result)
        printable.pop("meta", None)
        print(json.dumps(printable, indent=1))
        return 0

    module = result["module"]
    timing = result["timing_ms"]
    print("== full game.wasm: all decoded 68000 pages against runtime.wasm ABI ==")
    print("ABI:      %s (hash %s, %d-bit, %d words)"
          % (result["abi"]["cpu"], result["abi"]["hash"][:16],
             result["abi"]["pointer_bits"], result["abi"]["word_count"]))
    print("runtime:  %s (%d B, sha %s)"
          % (result["runtime_wasm"]["path"], result["runtime_wasm"]["bytes"],
             result["runtime_wasm"]["sha256"][:16]))
    print("decode:   ROM %s, %d instructions, %d pages, %d RAM variants, %.0f ms"
          % (result["decode"]["rom_sha256"][:16], result["instructions"],
             result["page_count"], result["decode"].get("ram_variants", 0),
             timing["decode"]))
    if result.get("z80"):
        print("Z80:      %d guarded PCs, %d variants, %d mutable expansions"
              % (result["z80"]["pcs"], result["z80"]["variants"],
                 result["z80"]["mutable_expansions"]))
    print("game.wasm: %d B (%d handlers, %.1f B/instr), %d functions, built in %.0f ms"
          % (module["bytes"], module["handler_bytes"],
             module["bytes_per_instruction"], len(result["pages"]),
             timing["build"]))
    print("game.wasm: SHA-256 %s" % module["sha256"])
    print("imports:  %s" % ", ".join(result["checks"]["imports"]))
    print("exports:  %s" % ", ".join(result["checks"]["exports"]))
    print("fail codes used (canonical): %s" % result["fail_codes_used"])
    print("timing:   ABI %.0f ms + decode %.0f ms + build %.0f ms = %.0f ms"
          % (timing["abi"], timing["decode"], timing["build"], timing["total"]))
    print("artifacts: %s , %s"
          % (result["artifacts"]["wasm"], result["artifacts"]["meta"]))
    print("PASS: one game.wasm covers all %d pages" % result["page_count"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

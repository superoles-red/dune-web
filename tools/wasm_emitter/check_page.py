#!/usr/bin/env python3
"""End-to-end Phase-3 check: ROM + dune-base.c -> page game.wasm -> differential.

One command does everything the task requires for a minimal, honest slice of the
on-device WASM backend:

1. validate the player ROM against ``profiles/dune-us.json``;
2. decode the real ``Program`` (40382 instructions) with the pinned recompiler;
3. build the native C oracle from the external ``dune-base.c`` (clang, cached);
4. read the real CPU/Z80/VDP layout from that compiler (``offsetof``/``sizeof``);
5. emit a valid ``game.wasm`` for one real 4 KiB ROM page through ``br_table``
   dispatch, with a funcref table and ``translated_step`` export;
6. run N deterministic initial states per instruction in the C oracle and in
   Node with runtime-helper stubs, and compare every register, SR, PC, cycle
   counter, fault code and RAM digest byte-for-byte;
7. additionally exercise every required op family on real instructions from
   the ROM (a coverage module across pages).

Usage:
    python3 tools/wasm_emitter/check_page.py \
        --rom "/path/to/Dune - The Battle for Arrakis (USA).gen" \
        --baseline "/path/to/vendor/rearrakis/build/dune-base.c"

Python 3.10+ is required because the vendor decoder uses PEP 604 annotations;
the script re-execs a newer interpreter automatically when available.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools"
PACKAGE = ROOT / "tools" / "wasm_emitter"
DEFAULT_OUT = ROOT / ".local" / "wasm-emitter"
DEFAULT_PROFILE = ROOT / "profiles" / "dune-us.json"
DEFAULT_PAGE = 0x13

if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from wasm_emitter import abi, coverage, game_module  # noqa: E402
from wasm_emitter.oracle import build as oracle_build  # noqa: E402
from wasm_emitter.oracle import cases as oracle_cases  # noqa: E402
from wasm_emitter.oracle import compare as oracle_compare  # noqa: E402
from wasm_emitter.oracle import format as oracle_format  # noqa: E402
from wasm_emitter.translate import UnsupportedInstruction  # noqa: E402


def _reexec_with_newer_python() -> None:
    if sys.version_info >= (3, 10):
        return
    candidates = []
    for name in ("python3.13", "python3.12", "python3.11", "python3.10"):
        path = shutil.which(name)
        if path:
            candidates.append(path)
    candidates.append(os.path.expanduser("~/.local/bin/python3.12"))
    for path in candidates:
        if path and Path(path).is_file():
            os.execv(path, [path, str(Path(__file__).resolve())] + sys.argv[1:])
    raise SystemExit(
        "error: Python 3.10+ is required (found %d.%d). "
        "Use a newer interpreter, e.g. python3.12 tools/wasm_emitter/check_page.py ..."
        % sys.version_info[:2]
    )


_JSON_MODE = False


def log(message: str) -> None:
    stream = sys.stderr if _JSON_MODE else sys.stdout
    print(message, file=stream, flush=True)


def decode_program(rom_path: Path, profile_path: Path):
    """ROM -> decoded Program, exactly like tools/build_game_c.py / the CLI."""
    import build_game_c as builder

    builder.ensure_recompiler()
    from genesis_recompiler.decode import analyze

    rom = Path(rom_path).read_bytes()
    profile = json.loads(Path(profile_path).read_text(encoding="utf-8"))
    digest = builder.validate_rom(rom, profile)
    started = time.perf_counter()
    entries = builder._discover_entries(rom, profile)
    entry = int.from_bytes(rom[4:8], "big") & 0xFFFFFF
    interrupts = {
        level: int.from_bytes(rom[(24 + level) * 4:(25 + level) * 4], "big") & 0xFFFFFF
        for level in (4, 6)
    }
    program = analyze(rom, [entry, *interrupts.values(), *entries])
    elapsed = (time.perf_counter() - started) * 1000.0
    return rom, program, {
        "rom_sha256": digest,
        "entries": len(entries),
        "instructions": len(program.instructions),
        "ram_variants": sum(len(v) for v in program.ram_variants.values()),
        "errors": len(program.errors),
        "decode_ms": round(elapsed, 1),
    }


def prepare_runtime_layout(rom_size: int, abi_desc: abi.CpuAbi) -> abi.MemoryLayout:
    layout = abi.MemoryLayout.from_cpu(0x10000, abi_desc, 0x80000, rom_size)
    return layout


def _node_path() -> str:
    node = shutil.which("node")
    if not node:
        raise SystemExit("error: Node.js is required for the WASM differential harness")
    return node


def _run_node_harness(node: str, wasm_path: Path, meta_path: Path, cases_path: Path,
                      rom_path: Path, out_path: Path) -> str:
    process = subprocess.run(
        [
            node,
            str(PACKAGE / "oracle" / "run_wasm.mjs"),
            "--wasm", str(wasm_path),
            "--meta", str(meta_path),
            "--cases", str(cases_path),
            "--rom", str(rom_path),
            "--out", str(out_path),
        ],
        capture_output=True,
        text=True,
        timeout=1800,
    )
    if process.returncode != 0:
        raise RuntimeError(
            "Node WASM harness failed:\n%s\n%s" % (process.stdout, process.stderr)
        )
    return process.stdout.strip()


def _run_differential(label: str, instructions: List, cases_per_instruction: int,
                      seed: int, program, abi_desc: abi.CpuAbi,
                      layout: abi.MemoryLayout, oracle_bin: Path, node: str,
                      rom_path: Path, out_dir: Path) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    wasm_path = out_dir / (label + ".wasm")
    meta_path = out_dir / (label + ".meta.json")
    cases_path = out_dir / (label + ".cases.bin")
    oracle_out = out_dir / (label + ".oracle.bin")
    wasm_out = out_dir / (label + ".wasm.bin")

    started = time.perf_counter()
    wasm_bytes, meta = game_module.build_module(program, instructions, abi_desc, layout,
                                                label=label)
    wasm_path.write_bytes(wasm_bytes)
    meta_path.write_text(json.dumps(meta, indent=1), encoding="utf-8")
    build_ms = (time.perf_counter() - started) * 1000.0

    records = oracle_cases.make_case_records(instructions, cases_per_instruction, seed)
    oracle_cases.write_case_file(cases_path, records)

    started = time.perf_counter()
    oracle_process = oracle_build.run_oracle(
        oracle_bin, ["--run", str(cases_path), str(oracle_out)]
    )
    if oracle_process.returncode != 0:
        raise RuntimeError(
            "C oracle failed:\n%s\n%s" % (oracle_process.stdout, oracle_process.stderr)
        )
    oracle_ms = (time.perf_counter() - started) * 1000.0

    node_stdout = _run_node_harness(node, wasm_path, meta_path, cases_path, rom_path, wasm_out)
    comparison = oracle_compare.compare_result_files(cases_path, oracle_out, wasm_out)
    comparison["label"] = label
    comparison["instructions"] = len(instructions)
    comparison["cases_per_instruction"] = cases_per_instruction
    comparison["module"] = meta["modules"]
    comparison["build_ms"] = round(build_ms, 1)
    comparison["oracle_ms"] = round(oracle_ms, 1)
    comparison["node"] = node_stdout
    return comparison


def _ram_digest_selftest(oracle_bin: Path, node: str, seeds=(1, 0x12345678)) -> dict:
    results = []
    for seed in seeds:
        expected = oracle_format.ram_digest(oracle_format.fill_ram(seed))
        c_value = oracle_build.oracle_ram_digest(oracle_bin, seed)
        node_process = subprocess.run(
            [node, str(PACKAGE / "oracle" / "run_wasm.mjs"), "--ram-digest", str(seed)],
            capture_output=True, text=True, timeout=120,
        )
        if node_process.returncode != 0:
            raise RuntimeError("Node RAM digest self-test failed:\n" + node_process.stderr)
        node_value = node_process.stdout.strip()
        expected_text = "%d %d" % expected
        ok = c_value == node_value == expected_text
        results.append({"seed": seed, "ok": ok, "C": c_value, "JS": node_value,
                        "python": expected_text})
    return {
        "seeds": results,
        "ok": all(item["ok"] for item in results),
        "matched": sum(1 for item in results if item["ok"]),
        "total": len(results),
    }


def _page_instructions(program, page: int) -> List:
    return [inst for inst in program.instructions.values() if (inst.pc >> 12) == page]


def _format_mismatches(report: dict) -> str:
    lines = []
    for mismatch in report.get("mismatches", [])[:8]:
        lines.append(
            "  case %d pc=$%06x %s: oracle=%r wasm=%r"
            % (mismatch["case"], mismatch["pc"], mismatch["field"],
               mismatch["oracle"], mismatch["wasm"])
        )
    if report.get("mismatch_cases", 0) > len(report.get("mismatches", [])):
        lines.append("  ... (%d mismatching cases total)" % report["mismatch_cases"])
    return "\n".join(lines)


def main(argv=None) -> int:
    _reexec_with_newer_python()
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--rom", type=Path, required=True,
                        help="player-supplied USA ROM (never stored/copied)")
    parser.add_argument("--baseline", type=Path, required=True,
                        help="external vendor/rearrakis/build/dune-base.c")
    parser.add_argument("--profile", type=Path, default=DEFAULT_PROFILE)
    parser.add_argument("--page", type=lambda text: int(text, 0), default=DEFAULT_PAGE,
                        help="4 KiB ROM page to translate (default 0x13)")
    parser.add_argument("--cases", type=int, default=200,
                        help="differential states per page instruction (default 200)")
    parser.add_argument("--coverage", dest="coverage", action="store_true", default=True,
                        help="also run the required-op coverage module (default)")
    parser.add_argument("--no-coverage", dest="coverage", action="store_false")
    parser.add_argument("--coverage-cases", type=int, default=24,
                        help="states per coverage instruction (default 24)")
    parser.add_argument("--seed", type=int, default=0xD00E5EED)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--json", action="store_true", help="print the final report as JSON")
    parser.add_argument("--force-oracle", action="store_true",
                        help="rebuild the native oracle even if the cache is fresh")
    args = parser.parse_args(argv)
    global _JSON_MODE
    _JSON_MODE = bool(args.json)

    started = time.perf_counter()
    out_dir = args.out.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    rom_path = args.rom.resolve()
    baseline = args.baseline.resolve()
    if not rom_path.is_file():
        log("error: ROM not found: %s" % rom_path)
        return 2
    if not baseline.is_file():
        log("error: baseline C core not found: %s" % baseline)
        return 2
    node = _node_path()

    log("== Dune WASM emitter: page differential ==")
    log("ROM:      %s" % rom_path)
    log("baseline: %s" % baseline)

    try:
        contract = abi.check_runtime_contract(ROOT, abi.REFERENCE_NATIVE_ABI)
        log("runtime v2 contract: OK (%s, %s)"
            % (contract["runtime_sha256"][:16], contract["cpu_struct"]))
    except abi.AbiError as error:
        log("runtime contract check failed: %s" % error)
        return 2

    oracle_bin = oracle_build.build_oracle(ROOT, baseline, out_dir,
                                           force=args.force_oracle)
    try:
        probe = oracle_build.oracle_abi(oracle_bin)
        abi_desc = abi.CpuAbi.from_probe(probe)
        try:
            abi.check_probe(abi.REFERENCE_NATIVE_ABI, probe)
            abi_note = "matches the pinned native reference ABI"
        except abi.AbiError as error:
            abi_note = "platform ABI differs from reference: %s" % error
    except (oracle_build.OracleBuildError, abi.AbiError) as error:
        log("ABI probe failed: %s" % error)
        return 2
    log("ABI:      %s" % abi_desc.describe())
    log("ABI:      %s (hash %s, pointer %d-bit)"
        % (abi_note, abi_desc.abi_hash()[:16], abi_desc.pointer_bits))
    layout = prepare_runtime_layout(rom_path.stat().st_size, abi_desc)
    log("memory:   CPU @0x%x, RAM @0x%x, ROM @0x%x (+%d), %d pages"
        % (layout.cpu, layout.ram, layout.rom, layout.rom_size, layout.pages))

    if args.cases < 1:
        log("error: --cases must be positive")
        return 2
    rom, program, decode_stats = decode_program(rom_path, args.profile)
    log("decode:   ROM %s, %d entries, %d instructions, %d RAM variants, %.0f ms"
        % (decode_stats["rom_sha256"][:16], decode_stats["entries"],
           decode_stats["instructions"], decode_stats["ram_variants"],
           decode_stats["decode_ms"]))

    page = args.page
    page_instructions = _page_instructions(program, page)
    if not page_instructions:
        log("error: page $%03x has no decoded instructions" % page)
        return 2
    missing = game_module.unsupported_ops(page_instructions)
    if missing:
        log("error: page $%03x has unsupported operations: %s" % (page, missing))
        return 2
    log("page $%03x: %d instructions, all supported" % (page, len(page_instructions)))

    try:
        digest_test = _ram_digest_selftest(oracle_bin, node)
    except RuntimeError as error:
        log("RAM digest self-test failed: %s" % error)
        return 2
    if not digest_test["ok"]:
        log("RAM digest self-test MISMATCH: %s" % json.dumps(digest_test))
        return 2
    log("RAM fill/digest self-test: %d/%d seeds identical in Python/C/JS"
        % (digest_test["matched"], digest_test["total"]))

    try:
        page_report = _run_differential(
            "page_%03x" % page, page_instructions, args.cases, args.seed,
            program, abi_desc, layout, oracle_bin, node, rom_path, out_dir,
        )
    except (RuntimeError, UnsupportedInstruction) as error:
        log("page differential failed: %s" % error)
        return 2

    log("")
    log("page result: %d instructions x %d states = %d cases"
        % (page_report["instructions"], page_report["cases_per_instruction"],
           page_report["cases"]))
    log("  wasm: %d bytes (handlers %d B, %.1f B/instruction), built in %.1f ms"
        % (page_report["module"]["bytes"], page_report["module"]["handler_bytes"],
           page_report["module"]["bytes_per_instruction"], page_report["build_ms"]))
    log("  oracle: %d ms; %s" % (page_report["oracle_ms"], page_report["node"]))
    log("  faults in oracle/wasm: %d/%d; codes: %s"
        % (page_report["oracle_faults"], page_report["wasm_faults"],
           page_report["fault_code_histogram"]))
    if page_report["ok"]:
        log("  mismatches: 0")
    else:
        log("  MISMATCHES: %d cases" % page_report["mismatch_cases"])
        log(_format_mismatches(page_report))

    coverage_report = None
    coverage_ok = True
    if args.coverage:
        selected, coverage_selection = coverage.select_coverage(program)
        if coverage_selection["required_missing"]:
            log("error: required ops missing from coverage: %s"
                % coverage_selection["required_missing"])
            coverage_ok = False
        else:
            log("")
            log("coverage: %d real instructions across %d page(s), %d groups, "
                "%d unsafe candidates skipped"
                % (coverage_selection["instructions"],
                   len({inst.pc >> 12 for inst in selected}),
                   coverage_selection["groups"],
                   coverage_selection["skipped_unsafe"]))
            log("  required ops covered: %d/%d"
                % (sum(1 for v in coverage_selection["required_ops"].values() if v),
                   len(coverage_selection["required_ops"])))
            try:
                coverage_report = _run_differential(
                    "coverage", selected, args.coverage_cases, args.seed + 1,
                    program, abi_desc, layout, oracle_bin, node, rom_path, out_dir,
                )
            except (RuntimeError, UnsupportedInstruction) as error:
                log("coverage differential failed: %s" % error)
                coverage_ok = False
            if coverage_report is not None:
                log("  coverage result: %d instructions x %d states = %d cases"
                    % (coverage_report["instructions"],
                       coverage_report["cases_per_instruction"],
                       coverage_report["cases"]))
                log("  wasm: %d bytes (handlers %d B, %.1f B/instruction)"
                    % (coverage_report["module"]["bytes"],
                       coverage_report["module"]["handler_bytes"],
                       coverage_report["module"]["bytes_per_instruction"]))
                log("  oracle: %d ms; %s"
                    % (coverage_report["oracle_ms"], coverage_report["node"]))
                if coverage_report["ok"]:
                    log("  mismatches: 0")
                else:
                    log("  MISMATCHES: %d cases" % coverage_report["mismatch_cases"])
                    log(_format_mismatches(coverage_report))
                    coverage_ok = False

    elapsed = time.perf_counter() - started
    page_ok = page_report["ok"]
    ok = page_ok and coverage_ok
    report = {
        "format": "dune-wasm-emitter-page-report/1",
        "ok": ok,
        "page": page,
        "rom_sha256": decode_stats["rom_sha256"],
        "decode": decode_stats,
        "abi": {
            "hash": abi_desc.abi_hash(),
            "pointer_bits": abi_desc.pointer_bits,
            "note": abi_note,
            "probe": probe,
        },
        "memory": layout.to_dict(),
        "ram_fill_selftest": digest_test,
        "page_differential": page_report,
        "coverage_differential": coverage_report,
        "elapsed_seconds": round(elapsed, 2),
    }
    (out_dir / "report.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
    log("")
    log("elapsed: %.1f s; report: %s" % (elapsed, out_dir / "report.json"))
    if ok:
        log("PASS: page $%03x differential is 0 mismatches%s"
            % (page, " and coverage is 0 mismatches" if coverage_ok and coverage_report else ""))
    else:
        log("FAIL")
    if args.json:
        print(json.dumps(report, indent=1))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())

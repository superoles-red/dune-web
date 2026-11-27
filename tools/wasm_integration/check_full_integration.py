#!/usr/bin/env python3
"""Differential test of the **full** ``game.wasm`` (all pages) through runtime.wasm.

One command does the whole acceptance check for the all-pages module:

1. reads the ABI from ``runtime/wasm/runtime.wasm`` (``dune_abi_descriptor``) and
   verifies it against the pinned ``runtime/wasm/manifest.json`` hash;
2. decodes the player ROM once (same decoder/profile as ``check_page.py``);
3. emits the single full ``game.wasm`` (all 48 pages / 40 382 instructions) via
   :mod:`build_full_module` -- or reuses a freshly built one;
4. selects instructions deterministically across **every** page (``--per-page``
   evenly spaced instructions, default 10) and generates ``--cases``
   deterministic initial states per instruction;
5. runs the same states through the native C oracle (``dune-base.c``) and
   through the linked ``runtime.wasm`` + full ``game.wasm`` pair
   (``link_and_run.mjs``: runtime-owned memory, runtime helper exports,
   GAME_MODE_SINGLE, the game's own ``br_table`` dispatcher);
6. compares registers, PC, USP/SSP, SR, instruction cycles, halted/fault code,
   fault address and both 64 KiB RAM digests byte-for-byte.

Usage:
    python3 tools/wasm_integration/check_full_integration.py \
        --rom "/path/to/Dune (USA).gen" \
        --baseline "/path/to/vendor/rearrakis/build/dune-base.c"

Expected tail: ``PASS: full module: 48 pages, 480 instructions x 16 states =
7680 cases, 0 mismatches`` (exit code 0).  Artifacts stay in
``.local/wasm-full/`` (gitignored, never committed).
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple

_HERE = Path(__file__).resolve().parent
_TOOLS = _HERE.parent
for _path in (str(_TOOLS), str(_HERE)):
    if _path not in sys.path:
        sys.path.insert(0, _path)

try:  # imported as ``wasm_integration.check_full_integration``
    from .python_support import (  # type: ignore[import-not-found]
        ROOT, ensure_tools_on_path, reexec_with_newer_python,
    )
    from . import build_full_module, runtime_abi  # type: ignore[import-not-found]
except ImportError:  # executed as a script
    from python_support import (  # type: ignore[no-redef]
        ROOT, ensure_tools_on_path, reexec_with_newer_python,
    )
    from wasm_integration import build_full_module, runtime_abi  # type: ignore[no-redef]

ensure_tools_on_path()

from wasm_emitter import abi, check_page, game_module  # noqa: E402
from wasm_emitter.oracle import build as oracle_build  # noqa: E402
from wasm_emitter.oracle import cases as oracle_cases  # noqa: E402
from wasm_emitter.oracle import compare as oracle_compare  # noqa: E402
from wasm_emitter.oracle import format as oracle_format  # noqa: E402
from wasm_emitter.translate import UnsupportedInstruction  # noqa: E402

DEFAULT_OUT = ROOT / ".local" / "wasm-full"
DEFAULT_PER_PAGE = 10
DEFAULT_CASES = 16
DEFAULT_MIN_INSTRUCTIONS = 400
DEFAULT_SEED = 0xD00E5EED
LINK_SCRIPT = _HERE / "link_and_run.mjs"

_JSON_MODE = False


def log(message: str) -> None:
    stream = sys.stderr if _JSON_MODE else sys.stdout
    print(message, file=stream, flush=True)


def instructions_by_page(program) -> Dict[int, List]:
    pages: Dict[int, List] = {}
    for inst in program.instructions.values():
        pages.setdefault(inst.pc >> 12, []).append(inst)
    for page in pages:
        pages[page].sort(key=lambda inst: inst.pc)
    return pages


def select_page_spread(pages: Dict[int, List], per_page: int) -> Tuple[List, dict]:
    """Pick up to ``per_page`` evenly spaced instructions from every page."""
    selected: List = []
    page_counts: Dict[str, int] = {}
    page_pcs: Dict[str, List[int]] = {}
    for page in sorted(pages):
        insts = pages[page]
        count = min(per_page, len(insts))
        if count == 0:
            continue
        if count == 1:
            indices = [0]
        else:
            # Evenly spaced over the page's sorted instruction list; the set
            # removes duplicates for tiny pages.  Deterministic by construction.
            indices = sorted({round(index * (len(insts) - 1) / (count - 1))
                              for index in range(count)})
        picked = [insts[index] for index in indices]
        selected.extend(picked)
        page_counts[str(page)] = len(picked)
        page_pcs[str(page)] = [inst.pc for inst in picked]
    selected.sort(key=lambda inst: inst.pc)
    return selected, {
        "pages": len(page_counts),
        "per_page": per_page,
        "instructions": len(selected),
        "page_counts": page_counts,
        "page_pcs": page_pcs,
        "min_per_page": min(page_counts.values()) if page_counts else 0,
    }


def op_histogram(instructions) -> Dict[str, int]:
    histogram: Dict[str, int] = {}
    for inst in instructions:
        histogram[inst.op] = histogram.get(inst.op, 0) + 1
    return dict(sorted(histogram.items(), key=lambda item: (-item[1], item[0])))


def run_link(node: str, runtime: Path, loader: Path, game: Path, meta: Path,
             cases: Path, rom: Path, out: Path) -> dict:
    process = subprocess.run(
        [
            node, str(LINK_SCRIPT),
            "--runtime", str(runtime),
            "--loader", str(loader),
            "--game", str(game),
            "--meta", str(meta),
            "--rom", str(rom),
            "--cases", str(cases),
            "--out", str(out),
        ],
        capture_output=True, text=True, timeout=3600,
    )
    stdout = (process.stdout or "").strip()
    if not stdout:
        raise RuntimeError(
            "link_and_run.mjs produced no report (exit %d):\n%s"
            % (process.returncode, (process.stderr or "").strip()[-4000:])
        )
    try:
        report = json.loads(stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError("link_and_run.mjs produced invalid JSON: %s\n%s"
                           % (error, stdout[:2000])) from error
    report["stderr"] = (process.stderr or "").strip()
    if process.returncode != 0:
        raise RuntimeError(
            "linked runtime/game execution failed (exit %d):\n%s"
            % (process.returncode, report["stderr"][-4000:])
        )
    return report


def _format_mismatches(report: dict) -> str:
    lines = []
    for mismatch in report.get("mismatches", [])[:10]:
        lines.append(
            "  case %d pc=$%06x %s: oracle=%r runtime=%r"
            % (mismatch["case"], mismatch["pc"], mismatch["field"],
               mismatch["oracle"], mismatch["wasm"])
        )
    if report.get("mismatch_cases", 0) > len(report.get("mismatches", [])):
        lines.append("  ... (%d mismatching cases total)" % report["mismatch_cases"])
    return "\n".join(lines)


def run_full_integration(
    rom_path: Path,
    baseline: Path,
    *,
    per_page: int = DEFAULT_PER_PAGE,
    cases_per_instruction: int = DEFAULT_CASES,
    min_instructions: int = DEFAULT_MIN_INSTRUCTIONS,
    seed: int = DEFAULT_SEED,
    profile: Path = check_page.DEFAULT_PROFILE,
    runtime: Path = runtime_abi.DEFAULT_RUNTIME,
    loader: Path = runtime_abi.DEFAULT_LOADER,
    manifest: Path = runtime_abi.DEFAULT_MANIFEST,
    out_dir: Path = DEFAULT_OUT,
    node: Optional[str] = None,
    force_oracle: bool = False,
) -> dict:
    started = time.perf_counter()
    rom_path = Path(rom_path).resolve()
    baseline = Path(baseline).resolve()
    out_dir = Path(out_dir).resolve()
    if not rom_path.is_file():
        raise RuntimeError("ROM not found: %s" % rom_path)
    if not baseline.is_file():
        raise RuntimeError("baseline C core not found: %s" % baseline)
    if per_page < 1:
        raise RuntimeError("--per-page must be positive")
    if cases_per_instruction < 1:
        raise RuntimeError("--cases must be positive")
    out_dir.mkdir(parents=True, exist_ok=True)
    node = node or runtime_abi.node_path()

    log("== Dune full game.wasm: all pages through runtime.wasm ==")
    log("ROM:      %s" % rom_path)
    log("baseline: %s" % baseline)
    log("runtime:  %s" % runtime)

    # 0. The pinned runtime v2 C contract (same static check check_page uses).
    try:
        contract = abi.check_runtime_contract(ROOT, abi.REFERENCE_NATIVE_ABI)
        log("runtime v2 contract: OK (%s, %s)"
            % (contract["runtime_sha256"][:16], contract["cpu_struct"]))
    except abi.AbiError as error:
        raise RuntimeError("runtime contract check failed: %s" % error) from error

    # 1. Descriptor out of runtime.wasm; the ABI is the only source of layout.
    rt_abi = runtime_abi.load_runtime_abi(runtime=runtime, loader=loader,
                                          manifest=manifest, node=node)
    log("ABI source: runtime.wasm %s (%d B), descriptor %d words, hash %s"
        % (rt_abi.runtime_sha256[:16], rt_abi.runtime_bytes, len(rt_abi.words),
           rt_abi.abi_hash[:16]))
    log("ABI layout: %s" % rt_abi.cpu_abi.describe())

    # 2. Decode once; the full build and the case generator share the Program.
    rom, program, decode_stats = check_page.decode_program(rom_path, Path(profile))
    log("decode:   ROM %s, %d entries, %d instructions, %d RAM variants, %.0f ms"
        % (decode_stats["rom_sha256"][:16], decode_stats["entries"],
           decode_stats["instructions"], decode_stats["ram_variants"],
           decode_stats["decode_ms"]))
    missing = game_module.unsupported_ops(program.instructions.values())
    if missing:
        raise RuntimeError("unsupported operations in the full program: %s" % missing)

    # 3. One game.wasm for every page against the runtime ABI.
    build = build_full_module.build_full_game_module(
        rom_path, profile=Path(profile), runtime=runtime, loader=loader,
        manifest=manifest, out_dir=out_dir, node=node,
        decoded=(rom, program, decode_stats), runtime_descriptor=rt_abi,
    )
    game_wasm = Path(build["artifacts"]["wasm"])
    meta_path = Path(build["artifacts"]["meta"])
    log("game.wasm: %d B (handlers %d B = %.1f B/instr), %d pages, %d "
        "instructions, built in %.0f ms"
        % (build["module"]["bytes"], build["module"]["handler_bytes"],
           build["module"]["bytes_per_instruction"], build["page_count"],
           build["instructions"], build["timing_ms"]["build"]))
    log("game.wasm: SHA-256 %s; imports %d (16 helpers + env.memory), exports %s"
        % (build["module"]["sha256"], len(build["checks"]["imports"]),
           ", ".join(build["checks"]["exports"])))
    log("game.wasm: fail codes used (canonical) %s -> runtime %s"
        % (build["fail_codes_used"],
           [rt_abi.fail_codes.runtime_code(code) for code in build["fail_codes_used"]]))

    # 4. Deterministic instruction selection: every page, spread across the page.
    pages = instructions_by_page(program)
    selected, selection = select_page_spread(pages, per_page)
    if selection["pages"] != build["page_count"]:
        raise RuntimeError("selection covers %d pages, module has %d"
                           % (selection["pages"], build["page_count"]))
    if selection["instructions"] < min_instructions:
        raise RuntimeError("selection has %d instructions, need >= %d (per-page "
                           "= %d)" % (selection["instructions"], min_instructions,
                                      per_page))
    log("select:   %d instructions across %d pages (%d..%d per page), %d states "
        "each = %d cases, %d distinct ops"
        % (selection["instructions"], selection["pages"],
           selection["min_per_page"],
           max(selection["page_counts"].values()), cases_per_instruction,
           selection["instructions"] * cases_per_instruction,
           len(op_histogram(selected))))

    # 5. Native C oracle from the external dune-base.c.
    oracle_bin = oracle_build.build_oracle(ROOT, baseline, out_dir, force=force_oracle)
    probe = oracle_build.oracle_abi(oracle_bin)
    native_abi = abi.CpuAbi.from_probe(probe)
    try:
        abi.check_probe(abi.REFERENCE_NATIVE_ABI, probe)
        native_note = "matches the pinned native reference ABI"
    except abi.AbiError as error:
        native_note = "platform ABI differs from reference: %s" % error
    log("oracle:   native C ABI %d-bit (%s)" % (native_abi.pointer_bits, native_note))

    # 6. Cases, C oracle run, linked runtime+game run.
    records = oracle_cases.make_case_records(selected, cases_per_instruction, seed)
    cases_path = out_dir / "differential.cases.bin"
    oracle_out = out_dir / "differential.oracle.bin"
    runtime_out = out_dir / "differential.runtime.bin"
    oracle_cases.write_case_file(cases_path, records)
    log("cases:    %d (%s)" % (len(records), cases_path.name))

    oracle_started = time.perf_counter()
    oracle_process = oracle_build.run_oracle(
        oracle_bin, ["--run", str(cases_path), str(oracle_out)]
    )
    if oracle_process.returncode != 0:
        raise RuntimeError("C oracle failed:\n%s\n%s"
                           % (oracle_process.stdout, oracle_process.stderr))
    oracle_ms = (time.perf_counter() - oracle_started) * 1000.0

    link_started = time.perf_counter()
    link = run_link(node, Path(runtime).resolve(), Path(loader).resolve(),
                    game_wasm, meta_path, cases_path, rom_path, runtime_out)
    link_ms = (time.perf_counter() - link_started) * 1000.0
    cases_report = link.get("cases") or {}
    link_info = link["link"]
    log("link:     %d helper imports == runtime exports, memory identity %s, "
        "mode SINGLE(%d), slots [%s, %s]"
        % (link_info["helper_imports"], link_info["memory_identity"],
           link_info["game_table_mode"], link_info["game_table_slot"],
           link_info["game_z80_slot"]))
    log("z80 stub: %s (cycles %d, fault %d, code %s)"
        % ("OK" if (link_info.get("z80_stub_smoke") or {}).get("ok") else "n/a",
           (link_info.get("z80_stub_smoke") or {}).get("cycles", -1),
           (link_info.get("z80_stub_smoke") or {}).get("fault", -1),
           (link_info.get("z80_stub_smoke") or {}).get("fault_code")))
    log("runtime:  %d cases in %.0f ms (%.0f cases/s), faults %d, codes %s"
        % (cases_report.get("count", 0), cases_report.get("elapsed_ms", 0.0),
           cases_report.get("cases_per_second") or 0.0,
           cases_report.get("faults", 0),
           json.dumps(cases_report.get("fault_code_histogram") or {})))
    oracle_records, _ = oracle_compare.read_result_file(oracle_out)
    oracle_faults = sum(1 for record in oracle_records
                        if oracle_format.out_fields(record)["fault"])
    log("oracle:   %d cases in %.0f ms, faults %d"
        % (len(records), oracle_ms, oracle_faults))

    # 7. Byte-for-byte comparison; fault histograms must agree in aggregate too.
    comparison = oracle_compare.compare_result_files(cases_path, oracle_out, runtime_out)
    comparison["label"] = "full"
    comparison["instructions"] = selection["instructions"]
    comparison["cases_per_instruction"] = cases_per_instruction
    runtime_histogram = {str(key): value
                         for key, value in (cases_report.get("fault_code_histogram") or {}).items()}
    histogram_ok = comparison["fault_code_histogram"] == runtime_histogram
    if not histogram_ok:
        log("fault histogram mismatch: oracle %s runtime %s"
            % (comparison["fault_code_histogram"], runtime_histogram))
    if comparison["ok"]:
        log("mismatches: 0")
    else:
        log("MISMATCHES: %d cases" % comparison["mismatch_cases"])
        log(_format_mismatches(comparison))

    elapsed = time.perf_counter() - started
    ok = bool(comparison["ok"] and histogram_ok
              and comparison["oracle_faults"] == cases_report.get("faults")
              and (link_info.get("z80_stub_smoke") or {}).get("ok"))
    report = {
        "format": "dune-wasm-full-integration-report/1",
        "ok": ok,
        "rom_sha256": decode_stats["rom_sha256"],
        "decode": decode_stats,
        "abi": {
            "source": "runtime.wasm:dune_abi_descriptor()",
            "hash": rt_abi.abi_hash,
            "pinned_hash": rt_abi.pinned_abi_hash,
            "pointer_bits": rt_abi.pointer_bits,
            "word_count": len(rt_abi.words),
            "cpu": rt_abi.cpu_abi.describe(),
            "runtime_wasm_sha256": rt_abi.runtime_sha256,
            "native_reference": {
                "hash": native_abi.abi_hash(),
                "pointer_bits": native_abi.pointer_bits,
                "note": native_note,
            },
        },
        "game": {
            "bytes": build["module"]["bytes"],
            "sha256": build["module"]["sha256"],
            "handler_bytes": build["module"]["handler_bytes"],
            "bytes_per_instruction": build["module"]["bytes_per_instruction"],
            "pages": build["pages"],
            "page_count": build["page_count"],
            "instructions": build["instructions"],
            "imports": build["checks"]["imports"],
            "exports": build["checks"]["exports"],
            "fail_codes_used": build["fail_codes_used"],
            "timing_ms": build["timing_ms"],
            "artifacts": build["artifacts"],
        },
        "selection": {
            "per_page": per_page,
            "min_instructions": min_instructions,
            "cases_per_instruction": cases_per_instruction,
            "pages": selection["pages"],
            "instructions": selection["instructions"],
            "min_per_page": selection["min_per_page"],
            "page_counts": selection["page_counts"],
            "op_histogram": op_histogram(selected),
        },
        "link": link_info,
        "runtime_run": cases_report,
        "differential": comparison,
        "fault_histogram_ok": histogram_ok,
        "timing": {
            "oracle_ms": round(oracle_ms, 1),
            "linked_run_ms": round(link_ms, 1),
            "elapsed_seconds": round(elapsed, 2),
        },
        "elapsed_seconds": round(elapsed, 2),
    }
    report_path = out_dir / "differential.json"
    report_path.write_text(json.dumps(report, indent=1), encoding="utf-8")
    log("")
    log("elapsed: %.1f s; report: %s" % (elapsed, report_path))
    if ok:
        log("PASS: full module: %d pages, %d instructions x %d states = %d cases, "
            "0 mismatches" % (build["page_count"], selection["instructions"],
                              cases_per_instruction, comparison["cases"]))
    else:
        log("FAIL: %d mismatching cases" % comparison["mismatch_cases"])
    return report


def main(argv=None) -> int:
    reexec_with_newer_python(Path(__file__))
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--rom", type=Path, required=True,
                        help="player-supplied USA ROM (never stored/copied)")
    parser.add_argument("--baseline", type=Path, required=True,
                        help="external vendor/rearrakis/build/dune-base.c")
    parser.add_argument("--per-page", type=int, default=DEFAULT_PER_PAGE,
                        help="differential instructions per ROM page (default 10)")
    parser.add_argument("--cases", type=int, default=DEFAULT_CASES,
                        help="differential states per instruction (default 16)")
    parser.add_argument("--min-instructions", type=int,
                        default=DEFAULT_MIN_INSTRUCTIONS,
                        help="refuse to run with fewer selected instructions "
                             "(default 400; tests lower it for smoke runs)")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--profile", type=Path, default=check_page.DEFAULT_PROFILE)
    parser.add_argument("--runtime", type=Path, default=runtime_abi.DEFAULT_RUNTIME)
    parser.add_argument("--loader", type=Path, default=runtime_abi.DEFAULT_LOADER)
    parser.add_argument("--manifest", type=Path, default=runtime_abi.DEFAULT_MANIFEST)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--node", default=None)
    parser.add_argument("--force-oracle", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    global _JSON_MODE
    _JSON_MODE = bool(args.json)

    try:
        report = run_full_integration(
            args.rom, args.baseline, per_page=args.per_page,
            cases_per_instruction=args.cases,
            min_instructions=args.min_instructions, seed=args.seed,
            profile=args.profile, runtime=args.runtime, loader=args.loader,
            manifest=args.manifest, out_dir=args.out, node=args.node,
            force_oracle=args.force_oracle,
        )
    except (RuntimeError, runtime_abi.RuntimeAbiError,
            build_full_module.BuildError, UnsupportedInstruction,
            oracle_build.OracleBuildError, oracle_compare.ResultError) as error:
        if args.json:
            print(json.dumps({"ok": False, "error": str(error)}, indent=1))
        else:
            print("FAIL: %s" % error, file=sys.stderr)
        return 2
    if args.json:
        printable = dict(report)
        printable.pop("link", None)
        print(json.dumps(printable, indent=1))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

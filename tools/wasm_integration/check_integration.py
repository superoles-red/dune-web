#!/usr/bin/env python3
"""One command: real page -> game.wasm under runtime ABI -> linked differential.

Pipeline (all steps are checked, nothing is hard-coded):

1. decode the player ROM exactly like ``check_page.py`` (same decoder/profile);
2. read and verify the ABI descriptor from ``runtime/wasm/runtime.wasm`` through
   ``runtime/wasm/loader.mjs`` -- ``dune_abi_descriptor()``, ``dune_abi_hash()``
   recomputed, ``dune_abi_selfcheck()`` against the pinned manifest hash;
3. build the native C oracle from the external ``dune-base.c`` (reused as-is);
4. emit ``game.wasm`` for one real ROM page with the *runtime* ABI: ``env.memory``
   + ``env.dune_*`` imports, wasm32 ``CPU`` offsets, descriptor fail codes;
5. instantiate ``runtime.wasm`` (64 MiB/512 MiB memory) + ``game.wasm``, assert
   every import is the runtime's own export, install the game function into the
   runtime's funcref table (``GAME_MODE_SINGLE``), copy the ROM into
   ``dune_rt_rom_buffer()``;
6. run the same N deterministic states through ``dune_rt_translated_step()`` and
   through the native C oracle, compare every register/SR/PC/cycles/fault/RAM
   digest byte-for-byte; also exercise ``dune_rt_machine_step()`` once.

Usage:
    python3 tools/wasm_integration/check_integration.py \
        --rom "/path/to/Dune (USA).gen" \
        --baseline "/path/to/vendor/rearrakis/build/dune-base.c"

Expected tail: ``PASS: page $013 ... 0 mismatches`` (exit code 0).
Artifacts (gitignored, never committed): ``.local/wasm-integration/``.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path
from typing import List, Optional

_HERE = Path(__file__).resolve().parent
_TOOLS = _HERE.parent
for _path in (str(_TOOLS), str(_HERE)):
    if _path not in sys.path:
        sys.path.insert(0, _path)

try:  # imported as ``wasm_integration.check_integration``
    from .python_support import (  # type: ignore[import-not-found]
        ROOT, ensure_tools_on_path, reexec_with_newer_python,
    )
    from . import build_page_module, runtime_abi  # type: ignore[import-not-found]
except ImportError:  # executed as a script
    from python_support import (  # type: ignore[no-redef]
        ROOT, ensure_tools_on_path, reexec_with_newer_python,
    )
    from wasm_integration import build_page_module, runtime_abi  # type: ignore[no-redef]

ensure_tools_on_path()

from wasm_emitter import abi, check_page, game_module  # noqa: E402
from wasm_emitter.oracle import build as oracle_build  # noqa: E402
from wasm_emitter.oracle import cases as oracle_cases  # noqa: E402
from wasm_emitter.oracle import compare as oracle_compare  # noqa: E402
from wasm_emitter.translate import UnsupportedInstruction  # noqa: E402

DEFAULT_OUT = ROOT / ".local" / "wasm-integration"
DEFAULT_PAGE = 0x13
DEFAULT_CASES = 200
LINK_SCRIPT = _HERE / "link_and_run.mjs"

_JSON_MODE = False


def log(message: str) -> None:
    stream = sys.stderr if _JSON_MODE else sys.stdout
    print(message, file=stream, flush=True)


def run_node_harness(node: str, runtime: Path, loader: Path, game: Path, meta: Path,
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
    stdout = process.stdout.strip()
    if not stdout:
        raise RuntimeError(
            "link_and_run.mjs produced no report (exit %d):\n%s"
            % (process.returncode, process.stderr.strip()[-4000:])
        )
    try:
        report = json.loads(stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError(
            "link_and_run.mjs produced invalid JSON: %s\n%s\n%s"
            % (error, stdout[:2000], process.stderr.strip()[-2000:])
        ) from error
    report["stderr"] = process.stderr.strip()
    report["node_returncode"] = process.returncode
    if process.returncode != 0:
        raise RuntimeError(
            "linked runtime/game execution failed (exit %d):\n%s"
            % (process.returncode, process.stderr.strip()[-4000:])
        )
    return report


def _page_instructions(program, page: int) -> List:
    return [inst for inst in program.instructions.values() if (inst.pc >> 12) == page]


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


def run_integration(rom_path: Path, baseline: Path, *, page: int = DEFAULT_PAGE,
                    cases_per_instruction: int = DEFAULT_CASES,
                    seed: int = 0xD00E5EED, profile: Path = check_page.DEFAULT_PROFILE,
                    runtime: Path = runtime_abi.DEFAULT_RUNTIME,
                    loader: Path = runtime_abi.DEFAULT_LOADER,
                    manifest: Path = runtime_abi.DEFAULT_MANIFEST,
                    out_dir: Path = DEFAULT_OUT, node: Optional[str] = None,
                    force_oracle: bool = False) -> dict:
    started = time.perf_counter()
    rom_path = Path(rom_path).resolve()
    baseline = Path(baseline).resolve()
    out_dir = Path(out_dir).resolve()
    if not rom_path.is_file():
        raise RuntimeError("ROM not found: %s" % rom_path)
    if not baseline.is_file():
        raise RuntimeError("baseline C core not found: %s" % baseline)
    if cases_per_instruction < 1:
        raise RuntimeError("--cases must be positive")
    out_dir.mkdir(parents=True, exist_ok=True)
    node = node or runtime_abi.node_path()

    log("== Dune WASM integration: game.wasm inside runtime.wasm ==")
    log("ROM:      %s" % rom_path)
    log("baseline: %s" % baseline)
    log("runtime:  %s" % runtime)

    # 0. The pinned runtime v2 C contract (same static check check_page uses).
    try:
        contract = abi.check_runtime_contract(ROOT, abi.REFERENCE_NATIVE_ABI)
        log("runtime v2 contract: OK (%s, %s)"
            % (contract["runtime_sha256"][:16], contract["cpu_struct"]))
    except abi.AbiError as error:
        raise RuntimeAbiError("runtime contract check failed: %s" % error) from error

    # 1. Descriptor out of the real runtime.wasm (single source of truth).
    rt_abi = runtime_abi.load_runtime_abi(runtime=runtime, loader=loader,
                                          manifest=manifest, node=node)
    log("ABI source: runtime.wasm %s (%d B), descriptor %d words, hash %s"
        % (rt_abi.runtime_sha256[:16], rt_abi.runtime_bytes, len(rt_abi.words),
           rt_abi.abi_hash[:16]))
    log("ABI pinned: %s (matches manifest); dune_abi_selfcheck(pin)=%r, "
        "hash recomputed=%r, ROM buffer=0x%x"
        % ("YES" if rt_abi.abi_hash == rt_abi.pinned_abi_hash else "NO",
           rt_abi.descriptor_checks.get("selfcheck_pinned"),
           rt_abi.descriptor_checks.get("hash_ok_recomputed"),
           rt_abi.descriptor_checks.get("rom_buffer_after_init") or 0))
    log("ABI layout: %s" % rt_abi.cpu_abi.describe())

    # 2. Decode the ROM once (reused for the page build and the case generator).
    rom, program, decode_stats = check_page.decode_program(rom_path, Path(profile))
    log("decode:   ROM %s, %d entries, %d instructions, %d RAM variants, %.0f ms"
        % (decode_stats["rom_sha256"][:16], decode_stats["entries"],
           decode_stats["instructions"], decode_stats["ram_variants"],
           decode_stats["decode_ms"]))

    instructions = _page_instructions(program, page)
    if not instructions:
        raise RuntimeError("page $%03x has no decoded instructions" % page)
    missing = game_module.unsupported_ops(instructions)
    if missing:
        raise RuntimeError("page $%03x has unsupported operations: %s" % (page, missing))
    log("page $%03x: %d instructions, all supported" % (page, len(instructions)))

    # 3. Emit the page module against the runtime descriptor.
    build = build_page_module.build_page_game_module(
        rom_path, page, profile=profile, runtime=runtime, loader=loader,
        manifest=manifest, out_dir=out_dir, node=node,
        decoded=(rom, program, decode_stats), runtime_descriptor=rt_abi,
    )
    meta = build["meta"]
    game_wasm = Path(build["artifacts"]["wasm"])
    meta_path = Path(build["artifacts"]["meta"])
    log("game.wasm: %d B (handlers %d B = %.1f B/instr), %d imports, built in %.1f ms"
        % (build["module"]["bytes"], build["module"]["handler_bytes"],
           build["module"]["bytes_per_instruction"], len(build["checks"]["imports"]),
           build["elapsed_ms"]))
    log("game.wasm: imports %s" % ", ".join(build["checks"]["imports"]))
    log("game.wasm: fail codes used (canonical) %s -> runtime %s"
        % (build["fail_codes_used"],
           [rt_abi.fail_codes.runtime_code(code) for code in build["fail_codes_used"]]))

    # 4. Native C oracle built from the external dune-base.c (unchanged).
    oracle_bin = oracle_build.build_oracle(ROOT, baseline, out_dir, force=force_oracle)
    probe = oracle_build.oracle_abi(oracle_bin)
    native_abi = abi.CpuAbi.from_probe(probe)
    try:
        abi.check_probe(abi.REFERENCE_NATIVE_ABI, probe)
        native_note = "matches the pinned native reference ABI"
    except abi.AbiError as error:
        native_note = "platform ABI differs from reference: %s" % error
    log("oracle:   native C ABI %d-bit (%s)"
        % (native_abi.pointer_bits, native_note))
    log("oracle:   runtime ABI is a *different* layout: pc=%d vs %d, instr_cycles=%d vs %d"
        % (rt_abi.cpu_abi.pc, native_abi.pc,
           rt_abi.cpu_abi.instruction_cycles, native_abi.instruction_cycles))

    # 5. Deterministic initial states (the exact same generator check_page uses).
    records = oracle_cases.make_case_records(instructions, cases_per_instruction, seed)
    label = "page_%03x" % page
    cases_path = out_dir / (label + ".cases.bin")
    oracle_cases.write_case_file(cases_path, records)
    oracle_out = out_dir / (label + ".oracle.bin")
    runtime_out = out_dir / (label + ".runtime.bin")
    log("cases:    %d instructions x %d states = %d cases (%s)"
        % (len(instructions), cases_per_instruction, len(records), cases_path.name))

    # 6. C oracle run.
    oracle_started = time.perf_counter()
    oracle_process = oracle_build.run_oracle(
        oracle_bin, ["--run", str(cases_path), str(oracle_out)]
    )
    if oracle_process.returncode != 0:
        raise RuntimeError("C oracle failed:\n%s\n%s"
                           % (oracle_process.stdout, oracle_process.stderr))
    oracle_ms = (time.perf_counter() - oracle_started) * 1000.0

    # 7. Linked runtime.wasm + game.wasm run.
    link_started = time.perf_counter()
    link = run_node_harness(node, Path(runtime).resolve(), Path(loader).resolve(),
                            game_wasm, meta_path, cases_path, rom_path, runtime_out)
    link_ms = (time.perf_counter() - link_started) * 1000.0
    cases_report = link.get("cases") or {}
    log("link:     %d helper imports == runtime exports, memory identity %s, "
        "mode SINGLE(%d), table slot %s"
        % (link["link"]["helper_imports"], link["link"]["memory_identity"],
           link["link"]["game_table_mode"], link["link"]["game_table_slot"]))
    log("runtime:  %d cases in %.0f ms (%.0f cases/s), faults %d, codes %s"
        % (cases_report.get("count", 0), cases_report.get("elapsed_ms", 0.0),
           cases_report.get("cases_per_second") or 0.0,
           cases_report.get("faults", 0),
           json.dumps(cases_report.get("fault_code_histogram") or {})))
    if link["link"].get("machine_step_smoke"):
        smoke = link["link"]["machine_step_smoke"]
        log("machine:  dune_rt_machine_step() pc=$%06x a7=$%06x cycles=%d ok=%s"
            % (smoke["pc"], smoke["a7"], smoke["cycles"], smoke["ok"]))

    # 8. Byte-for-byte comparison against the native C oracle.
    comparison = oracle_compare.compare_result_files(cases_path, oracle_out, runtime_out)
    comparison["label"] = label
    comparison["instructions"] = len(instructions)
    comparison["cases_per_instruction"] = cases_per_instruction
    comparison["module"] = build["module"]
    comparison["oracle_ms"] = round(oracle_ms, 1)
    comparison["link_ms"] = round(link_ms, 1)
    log("oracle:   %d cases in %.0f ms, faults %d, codes %s"
        % (comparison["cases"], oracle_ms, comparison["oracle_faults"],
           json.dumps(comparison["fault_code_histogram"])))

    # Fault codes must agree in aggregate as well as per case.
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
              and comparison["oracle_faults"] == cases_report.get("faults"))
    report = {
        "format": "dune-wasm-integration-report/1",
        "ok": ok,
        "page": page,
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
            "loader_sha256": rt_abi.loader_sha256,
            "descriptor_selfcheck": {
                "dune_abi_selfcheck_pinned":
                    rt_abi.descriptor_checks.get("selfcheck_pinned"),
                "hash_recomputed_ok":
                    rt_abi.descriptor_checks.get("hash_ok_recomputed"),
                "rom_buffer_before_init":
                    rt_abi.descriptor_checks.get("rom_buffer_before_init"),
                "rom_buffer_after_init":
                    rt_abi.descriptor_checks.get("rom_buffer_after_init"),
            },
            "native_reference": {
                "hash": native_abi.abi_hash(),
                "pointer_bits": native_abi.pointer_bits,
                "note": native_note,
            },
        },
        "game": {
            "bytes": build["module"]["bytes"],
            "sha256": build["module"]["sha256"],
            "instructions": len(instructions),
            "bytes_per_instruction": build["module"]["bytes_per_instruction"],
            "imports": build["checks"]["imports"],
            "fail_codes_used": build["fail_codes_used"],
            "build_ms": build["elapsed_ms"],
            "artifacts": build["artifacts"],
        },
        "link": link["link"],
        "runtime_run": cases_report,
        "differential": comparison,
        "fault_histogram_ok": histogram_ok,
        "timing": {
            "oracle_ms": round(oracle_ms, 1),
            "runtime_run_ms": round(link_ms, 1),
            "elapsed_seconds": round(elapsed, 2),
        },
        "elapsed_seconds": round(elapsed, 2),
    }
    report_path = out_dir / "report.json"
    report_path.write_text(json.dumps(report, indent=1), encoding="utf-8")
    log("")
    log("elapsed: %.1f s; report: %s" % (elapsed, report_path))
    if ok:
        log("PASS: page $%03x differential through runtime.wasm+game.wasm is "
            "%d cases, 0 mismatches" % (page, comparison["cases"]))
    else:
        log("FAIL: %d mismatching cases" % comparison["mismatch_cases"])
    return report


def main(argv=None) -> int:
    reexec_with_newer_python(Path(__file__))
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--rom", type=Path, required=True,
                        help="player-supplied USA ROM (never stored/committed)")
    parser.add_argument("--baseline", type=Path, required=True,
                        help="external vendor/rearrakis/build/dune-base.c")
    parser.add_argument("--page", type=lambda text: int(text, 0), default=DEFAULT_PAGE)
    parser.add_argument("--cases", type=int, default=DEFAULT_CASES,
                        help="differential states per page instruction (default 200)")
    parser.add_argument("--seed", type=int, default=0xD00E5EED)
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
        report = run_integration(
            args.rom, args.baseline, page=args.page,
            cases_per_instruction=args.cases, seed=args.seed, profile=args.profile,
            runtime=args.runtime, loader=args.loader, manifest=args.manifest,
            out_dir=args.out, node=args.node, force_oracle=args.force_oracle,
        )
    except (RuntimeError, runtime_abi.RuntimeAbiError,
            build_page_module.BuildError, UnsupportedInstruction,
            oracle_build.OracleBuildError, oracle_compare.ResultError) as error:
        if args.json:
            print(json.dumps({"ok": False, "error": str(error)}, indent=1))
        else:
            print("FAIL: %s" % error, file=sys.stderr)
        return 2
    if args.json:
        printable = dict(report)
        printable.pop("game", None)
        print(json.dumps(printable, indent=1))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Z80 differential: native C oracle vs runtime.wasm + generated Z80 module.

The native oracle is the real generated C core (``translated_z80_step`` from the
pinned ``dune-base.c`` / the prepared ``.local/verify/dune.c``); the WASM side is
the real ``runtime/wasm/runtime.wasm`` plus a ``game.wasm`` whose
``translated_z80_step`` was emitted by ``tools/wasm_emitter/z80_translate.py``.
Every Z80 helper call therefore goes through the runtime's exported
``dune_z80_*`` functions and the dispatch goes through
``dune_rt_translated_z80_step()`` exactly like ``z80_tick``.

For every guarded variant of every analysed Z80 PC (2577 PCs / 3095 variants for
Dune USA) the harness runs ``--states`` random Z80/CPU states with the variant's
instruction bytes patched into Z80 RAM, then compares the full Z80 register
file, PC/SP/IX/IY/WZ, IFF/IM/halted/ei_delay/debt/steps/cycles/interrupts, fault
state, canonical failure code and both RAM digests.

Usage:
    python3 tools/wasm_integration/z80_differential.py \
        --rom "/path/to/Dune - The Battle for Arrakis (USA).gen" \
        --baseline "/path/to/vendor/rearrakis/build/dune-base.c" \
        [--states 2] [--json]

Artifacts stay in ``.local/wasm-z80/`` (gitignored).  The test in
``tests/wasm_z80/`` skips when the ROM or the baseline C core is absent.
"""

from __future__ import annotations

import argparse
import json
import random
import subprocess
import sys
import time
from pathlib import Path
from typing import List, Optional, Sequence, Tuple

_HERE = Path(__file__).resolve().parent
_TOOLS = _HERE.parent
_ROOT = _TOOLS.parent
for _path in (str(_TOOLS), str(_HERE)):
    if _path not in sys.path:
        sys.path.insert(0, _path)

try:  # imported as ``wasm_integration.z80_differential``
    from . import runtime_abi  # type: ignore[import-not-found]
    from .python_support import ROOT, ensure_tools_on_path, reexec_with_newer_python
except ImportError:  # executed as a script
    from wasm_integration import runtime_abi  # type: ignore[no-redef]
    from python_support import (  # type: ignore[no-redef]
        ROOT, ensure_tools_on_path, reexec_with_newer_python,
    )

ensure_tools_on_path()

from wasm_emitter import abi, game_module, z80_translate  # noqa: E402
from wasm_emitter.oracle import build as oracle_build  # noqa: E402
from wasm_emitter.oracle import z80_format  # noqa: E402

DEFAULT_OUT = ROOT / ".local" / "wasm-z80"
DEFAULT_STATES = 2
CASE_SEED = 0x5A80D00D

WORD_NAMES: List[str] = []
for _n in range(6):
    WORD_NAMES.append("r8_%d" % _n)
for _n in range(6):
    WORD_NAMES.append("alternate_%d" % _n)
WORD_NAMES += [
    "a", "f", "a_alt", "f_alt", "i", "r", "iff1", "iff2", "im", "halted",
    "irq_line", "ei_delay", "pc", "sp", "ix", "iy", "wz",
    "debt_lo", "debt_hi", "steps_lo", "steps_hi", "cycles_lo", "cycles_hi",
    "interrupts_lo", "interrupts_hi", "audio_mode", "bus_bank",
    "bus_requested", "bus_reset_released", "seed_z80", "seed_ram",
    "patch_len", "patch_bytes",
    "fault", "fault_address", "fail_code",
    "initial_z80_digest_1", "initial_z80_digest_2",
    "initial_ram_digest_1", "initial_ram_digest_2",
    "final_z80_digest_1", "final_z80_digest_2",
    "final_ram_digest_1", "final_ram_digest_2",
]
assert len(WORD_NAMES) == z80_format.OUT_WORDS


class DifferentialError(RuntimeError):
    pass


# ---------------------------------------------------------------------------
# Cases
# ---------------------------------------------------------------------------

def _u64_words(value: int) -> Tuple[int, int]:
    value &= 0xFFFFFFFFFFFFFFFF
    return value & 0xFFFFFFFF, (value >> 32) & 0xFFFFFFFF


def _patch_words(raw: bytes) -> Tuple[int, int]:
    if len(raw) > 4:
        raise DifferentialError("Z80 instruction longer than 4 bytes: %r" % raw)
    bits = 0
    for index, byte in enumerate(raw):
        bits |= byte << (8 * index)
    return len(raw), bits


def _case_state(rng: random.Random, pc: int, raw: bytes) -> List[int]:
    words: List[int] = []
    words += [rng.getrandbits(8) for _ in range(6)]          # r8
    words += [rng.getrandbits(8) for _ in range(6)]          # alternate
    words += [rng.getrandbits(8) for _ in range(12)]         # a..ei_delay
    words.append(pc)                                          # pc
    if rng.random() < 0.7:
        sp = rng.getrandbits(16) & 0xFFFE
    else:
        sp = 0x2000 + (rng.getrandbits(13) & 0x1FFE)
    words.append(sp & 0xFFFF)
    words.append(rng.getrandbits(16))                        # ix
    words.append(rng.getrandbits(16))                        # iy
    words.append(rng.getrandbits(16))                        # wz
    debt = rng.randint(-32, 32)
    words += list(_u64_words(debt & 0xFFFFFFFFFFFFFFFF))
    words += list(_u64_words(rng.getrandbits(48)))           # steps
    words += list(_u64_words(rng.getrandbits(48)))           # cycles
    words += list(_u64_words(rng.getrandbits(32)))           # interrupts
    words.append(1)                                          # audio_mode: AUDIO_STUB
    words.append(rng.choice((0, 1, 2, 3)))                   # bus bank -> ROM window
    words.append(1)                                          # bus requested
    words.append(1)                                          # reset released
    words.append(rng.getrandbits(32) or 0x9E3779B9)          # seed_z80
    words.append(rng.getrandbits(32) or 0x9E3779B9)          # seed_ram
    length, bits = _patch_words(raw)
    words += [length, bits]
    return words


def make_cases(program, states: int = DEFAULT_STATES, seed: int = CASE_SEED):
    rng = random.Random(seed)
    records: List[List[int]] = []
    for pc in sorted(program.instructions):
        variants = sorted(program.instructions[pc], key=lambda item: item.raw)
        for variant in variants:
            for _ in range(states):
                records.append(_case_state(rng, variant.pc, variant.raw))
    return records


# ---------------------------------------------------------------------------
# WASM module
# ---------------------------------------------------------------------------

def build_z80_module(rom: bytes, out_dir: Path,
                     rt_abi: Optional[runtime_abi.RuntimeAbi] = None):
    """Emit a ``game.wasm`` with only ``translated_z80_step`` (no 68000 pages)."""
    from wasm_emitter import z80_translate as zt

    prog = zt.analyze_dune_z80(rom)
    rt = rt_abi or runtime_abi.load_runtime_abi()
    layout = rt.memory_layout(len(rom))
    builder = game_module.ModuleBuilder(
        rt.cpu_abi, layout, rom, helper_prefix="dune_",
        fail_code_map=dict(rt.fail_codes.canonical_to_runtime),
    )
    started = time.perf_counter()
    data, meta = builder.build({}, {}, z80_program=prog)
    elapsed = (time.perf_counter() - started) * 1000.0
    meta["z80_program"] = zt.z80_program_summary(prog)
    meta["generation_ms"] = round(elapsed, 1)
    meta["runtime_abi_hash"] = rt.abi_hash
    meta["pinned_abi_hash"] = rt.pinned_abi_hash
    meta["fail_reasons"] = [[prefix, abi.FAIL_CODES[name]]
                            for prefix, name in abi.FAIL_REASONS]
    meta["canonical_to_runtime"] = dict(rt.fail_codes.canonical_to_runtime)
    return data, meta, prog


# ---------------------------------------------------------------------------
# Harnesses
# ---------------------------------------------------------------------------

def _run(command: Sequence[str], timeout: int, what: str) -> subprocess.CompletedProcess:
    process = subprocess.run(list(command), capture_output=True, text=True, timeout=timeout)
    if process.returncode != 0:
        raise DifferentialError(
            "%s failed (exit %d):\n%s\n%s"
            % (what, process.returncode, process.stdout[-4000:], process.stderr[-8000:])
        )
    return process


def compare_results(oracle_path: Path, wasm_path: Path, max_report: int = 12) -> dict:
    oracle_bytes = Path(oracle_path).read_bytes()
    wasm_bytes = Path(wasm_path).read_bytes()
    magic, version, count, record_size, ram_size = z80_format.unpack_header(oracle_bytes)
    if (magic, version, record_size, ram_size) != (
        z80_format.OUT_MAGIC, z80_format.FORMAT_VERSION,
        z80_format.OUT.size, z80_format.Z80_RAM_SIZE,
    ):
        raise DifferentialError("bad oracle Z80 result header")
    wmagic, wversion, wcount, wrecord, wram = z80_format.unpack_header(wasm_bytes)
    if (wmagic, wversion, wrecord, wram) != (
        z80_format.OUT_MAGIC, z80_format.FORMAT_VERSION,
        z80_format.OUT.size, z80_format.Z80_RAM_SIZE,
    ):
        raise DifferentialError("bad wasm Z80 result header")
    if wcount != count:
        raise DifferentialError("result count mismatch: oracle %d wasm %d" % (count, wcount))
    mismatches = []
    mismatch_cases = 0
    fault_histogram = {}
    oracle_faults = wasm_faults = 0
    for index in range(count):
        oracle_words = z80_format.unpack_out(oracle_bytes, z80_format.HEADER_SIZE + index * z80_format.OUT.size)
        wasm_words = z80_format.unpack_out(wasm_bytes, z80_format.HEADER_SIZE + index * z80_format.OUT.size)
        o_fault = oracle_words[45]
        w_fault = wasm_words[45]
        if o_fault:
            oracle_faults += 1
            code = oracle_words[47]
            fault_histogram[str(code)] = fault_histogram.get(str(code), 0) + 1
        if w_fault:
            wasm_faults += 1
        bad = False
        for word in range(z80_format.OUT_WORDS):
            if oracle_words[word] != wasm_words[word]:
                bad = True
                if len(mismatches) < max_report:
                    mismatches.append({
                        "case": index,
                        "pc": oracle_words[12] if False else oracle_words[24],
                        "word": word,
                        "field": WORD_NAMES[word],
                        "oracle": oracle_words[word],
                        "wasm": wasm_words[word],
                    })
        if bad:
            mismatch_cases += 1
    return {
        "cases": count,
        "mismatch_cases": mismatch_cases,
        "mismatches": mismatches,
        "oracle_faults": oracle_faults,
        "wasm_faults": wasm_faults,
        "fault_code_histogram": dict(sorted(fault_histogram.items())),
        "ok": mismatch_cases == 0,
    }


def run_z80_differential(
    rom_path: Path,
    baseline: Path,
    *,
    states: int = DEFAULT_STATES,
    state_seed: int = CASE_SEED,
    out_dir: Path = DEFAULT_OUT,
    runtime: Path = runtime_abi.DEFAULT_RUNTIME,
    loader: Path = runtime_abi.DEFAULT_LOADER,
    manifest: Path = runtime_abi.DEFAULT_MANIFEST,
    node: Optional[str] = None,
    force_oracle: bool = False,
    keep: bool = False,
) -> dict:
    rom_path = Path(rom_path).resolve()
    baseline = Path(baseline).resolve()
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    if not rom_path.is_file():
        raise DifferentialError("ROM not found: %s" % rom_path)
    if not baseline.is_file():
        raise DifferentialError("baseline C core not found: %s" % baseline)
    node = node or runtime_abi.node_path()

    total_started = time.perf_counter()
    timings = {}

    # 1. runtime ABI + Z80 module.
    started = time.perf_counter()
    rt_abi = runtime_abi.load_runtime_abi(runtime=runtime, loader=loader,
                                          manifest=manifest, node=node)
    if rt_abi.abi_hash != rt_abi.pinned_abi_hash:
        raise DifferentialError("runtime ABI hash does not match the pinned manifest hash")
    data, meta, program = build_z80_module(rom_path.read_bytes(), out_dir, rt_abi)
    game_path = out_dir / "game-z80.wasm"
    meta_path = out_dir / "game-z80.meta.json"
    game_path.write_bytes(data)
    meta_path.write_text(json.dumps(meta, indent=1), encoding="utf-8")
    timings["build"] = round((time.perf_counter() - started) * 1000.0, 1)

    # 2. cases.
    started = time.perf_counter()
    records = make_cases(program, states=states, seed=state_seed)
    case_path = out_dir / "z80.cases.bin"
    z80_format.write_case_file(case_path, records)
    timings["cases"] = round((time.perf_counter() - started) * 1000.0, 1)

    # 3. native oracle (cached by baseline + oracle main stamp).
    started = time.perf_counter()
    oracle_dir = out_dir / "oracle"
    oracle_bin = oracle_build.build_oracle(
        ROOT, baseline, oracle_dir, force=force_oracle,
        include_dirs=(ROOT / "runtime" / "adapters",),
    )
    oracle_out = out_dir / "z80.oracle.bin"
    _run([str(oracle_bin), "--run-z80", str(case_path), str(oracle_out)],
         timeout=1800, what="native Z80 oracle")
    timings["oracle"] = round((time.perf_counter() - started) * 1000.0, 1)

    # 4. runtime.wasm + game.wasm harness.
    started = time.perf_counter()
    wasm_out = out_dir / "z80.runtime.bin"
    harness = _HERE / "z80_run_wasm.mjs"
    process = _run([
        node, str(harness),
        "--runtime", str(Path(runtime)),
        "--loader", str(Path(loader)),
        "--game", str(game_path),
        "--meta", str(meta_path),
        "--cases", str(case_path),
        "--rom", str(rom_path),
        "--out", str(wasm_out),
    ], timeout=1800, what="runtime.wasm Z80 harness")
    timings["wasm"] = round((time.perf_counter() - started) * 1000.0, 1)

    # 5. compare.
    started = time.perf_counter()
    report = compare_results(oracle_out, wasm_out)
    timings["compare"] = round((time.perf_counter() - started) * 1000.0, 1)
    timings["total"] = round((time.perf_counter() - total_started) * 1000.0, 1)
    report.update({
        "format": "dune-z80-differential/1",
        "rom_sha256": __import__("hashlib").sha256(rom_path.read_bytes()).hexdigest(),
        "baseline": str(baseline),
        "baseline_sha256": __import__("hashlib").sha256(baseline.read_bytes()).hexdigest(),
        "runtime_abi_hash": rt_abi.abi_hash,
        "pinned_abi_hash": rt_abi.pinned_abi_hash,
        "module_bytes": len(data),
        "module_sha256": __import__("hashlib").sha256(data).hexdigest(),
        "z80": meta["z80_program"],
        "states_per_variant": states,
        "timings_ms": timings,
        "harness_stderr": process.stderr.strip().splitlines()[-2:],
        "artifacts": {
            "game": str(game_path), "meta": str(meta_path),
            "cases": str(case_path), "oracle": str(oracle_out),
            "runtime": str(wasm_out), "oracle_bin": str(oracle_bin),
        },
    })
    if not keep:
        # keep artifacts for debugging; the directory is gitignored
        pass
    return report


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--rom", type=Path, required=True)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--states", type=int, default=DEFAULT_STATES)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--runtime", type=Path, default=runtime_abi.DEFAULT_RUNTIME)
    parser.add_argument("--loader", type=Path, default=runtime_abi.DEFAULT_LOADER)
    parser.add_argument("--manifest", type=Path, default=runtime_abi.DEFAULT_MANIFEST)
    parser.add_argument("--node", default=None)
    parser.add_argument("--force-oracle", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    try:
        report = run_z80_differential(
            args.rom, args.baseline, states=max(1, args.states), out_dir=args.out,
            runtime=args.runtime, loader=args.loader, manifest=args.manifest,
            node=args.node, force_oracle=args.force_oracle,
        )
    except (DifferentialError, oracle_build.OracleBuildError,
            runtime_abi.RuntimeAbiError) as error:
        print("z80_differential: %s" % error, file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps(report, indent=1))
    else:
        print("== Z80 differential: native C oracle vs runtime.wasm + game.wasm ==")
        print("Z80 program: %d guarded PCs, %d variants, %d mutable expansions"
              % (report["z80"]["pcs"], report["z80"]["variants"],
                 report["z80"]["mutable_expansions"]))
        print("module: %d B sha %s (runtime ABI %s)"
              % (report["module_bytes"], report["module_sha256"][:16],
                 report["runtime_abi_hash"][:16]))
        print("cases: %d (%d states/variant), oracle faults=%d, wasm faults=%d"
              % (report["cases"], report["states_per_variant"],
                 report["oracle_faults"], report["wasm_faults"]))
        print("fault histogram (canonical): %s" % report["fault_code_histogram"])
        print("mismatch cases: %d" % report["mismatch_cases"])
        for item in report["mismatches"]:
            print("  case %d pc=%04x %s oracle=%s wasm=%s"
                  % (item["case"], item["pc"], item["field"],
                     item["oracle"], item["wasm"]))
        print("timing: build %.0f ms + cases %.0f ms + oracle %.0f ms + wasm %.0f ms + compare %.0f ms = %.0f ms"
              % tuple(report["timings_ms"].get(key, 0.0) for key in
                      ("build", "cases", "oracle", "wasm", "compare", "total")))
        if report["harness_stderr"]:
            print("harness: %s" % " | ".join(report["harness_stderr"]))
        print("PASS: 0 mismatches" if report["ok"] else "FAIL: %d mismatching cases"
              % report["mismatch_cases"])
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

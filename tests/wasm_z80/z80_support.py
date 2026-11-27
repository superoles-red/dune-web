"""Shared helpers for ``tests/wasm_z80`` (stdlib + Node only).

External game data is never committed; the Z80 differential skips unless
``DUNE_ROM`` and ``DUNE_BASELINE`` point at the player's files.  The other tests
need no ROM: they build tiny synthetic Z80 programs and run them through the
real ``runtime/wasm/runtime.wasm``.
"""

from __future__ import annotations

import sys
import os
from pathlib import Path

_TESTS = Path(__file__).resolve().parents[1]
_INTEGRATION_TESTS = _TESTS / "wasm_integration"
if str(_INTEGRATION_TESTS) not in sys.path:
    sys.path.insert(0, str(_INTEGRATION_TESTS))

from support import (  # noqa: E402,F401
    INTEGRATION,
    LOCAL_OUT,
    ROOT,
    TOOLS,
    VENDOR,
    add_tools_path,
    add_vendor_path,
    external_inputs,
    load_json_stdout,
    require_node,
    require_python310,
    run_node,
    run_python,
    temporary_dir,
)

add_tools_path()
add_vendor_path()

import json  # noqa: E402
import random  # noqa: E402
from typing import List, Sequence  # noqa: E402

from wasm_emitter import abi, game_module, z80_translate  # noqa: E402
from wasm_emitter.oracle import z80_format  # noqa: E402
from wasm_integration import runtime_abi  # noqa: E402

# External inputs are never committed and never hard-coded: set DUNE_ROM /
# DUNE_BASELINE to run the full differential, otherwise the tests skip.
DEFAULT_ROM = Path(os.environ["DUNE_ROM"]) if os.environ.get("DUNE_ROM") else None
DEFAULT_BASELINE = (
    Path(os.environ["DUNE_BASELINE"]) if os.environ.get("DUNE_BASELINE") else None
)
LOCAL_Z80 = ROOT / ".local" / "wasm-z80"


def z80_instruction(pc: int, raw: bytes, op: str, args: tuple = (), cycles: int = 4):
    """``genesis_recompiler.z80.ZInstruction`` without importing the decoder."""
    from genesis_recompiler.z80 import ZInstruction

    return ZInstruction(pc, pc + len(raw), op, tuple(args), cycles, bytes(raw))


class SyntheticZ80Program:
    """Minimal ``ZProgram`` (only ``instructions``/``errors`` are used)."""

    def __init__(self, instructions):
        self.instructions = instructions
        self.errors = []


def synthetic_program() -> SyntheticZ80Program:
    """A handful of instructions whose semantics are unambiguous by hand."""
    instructions = {
        0x00: [z80_instruction(0x00, b"\x00", "NOP", (), 4)],
        0x01: [z80_instruction(0x01, b"\x01\x34\x12", "LD16", (0, 0x1234), 10)],
        0x03: [z80_instruction(0x03, b"\x3e\x42", "LD8_IMM", (7, 0x42), 7)],
        0x05: [z80_instruction(0x05, b"\xf3", "DI", (), 4)],
        0x06: [z80_instruction(0x06, b"\xfb", "EI", (), 4)],
        0x08: [z80_instruction(0x08, b"\xc3\x34\x12", "JP", (0x1234,), 10)],
        0x10: [z80_instruction(0x10, b"\x00", "NOP", (), 4)],
    }
    return SyntheticZ80Program(instructions)


def build_synthetic_module(rt=None, rom: bytes = b""):
    rt = rt or runtime_abi.load_runtime_abi()
    layout = rt.memory_layout(max(len(rom), 0x10000))
    builder = game_module.ModuleBuilder(
        rt.cpu_abi, layout, rom, helper_prefix="dune_",
        fail_code_map=dict(rt.fail_codes.canonical_to_runtime),
    )
    data, meta = builder.build({}, {}, z80_program=synthetic_program())
    meta["fail_reasons"] = [[prefix, abi.FAIL_CODES[name]]
                            for prefix, name in abi.FAIL_REASONS]
    meta["canonical_to_runtime"] = dict(rt.fail_codes.canonical_to_runtime)
    return rt, layout, data, meta


def case_words(pc: int, raw: bytes, **overrides) -> List[int]:
    """Default Z80 differential case: quiet state pointing at one instruction."""
    state = {
        "r8": [0] * 6,
        "alternate": [0] * 6,
        "a": 0, "f": 0, "a_alt": 0, "f_alt": 0, "i": 0, "r": 0,
        "iff1": 0, "iff2": 0, "im": 0, "halted": 0, "irq_line": 0, "ei_delay": 0,
        "pc": pc, "sp": 0x2000, "ix": 0, "iy": 0, "wz": 0,
        "debt": 0, "steps": 0, "cycles": 0, "interrupts": 0,
        "audio_mode": 1, "bus_bank": 0, "bus_requested": 1, "bus_reset_released": 1,
        "seed_z80": 0x12345678, "seed_ram": 0x9ABCDEF0,
    }
    state.update(overrides)
    words: List[int] = []
    words += [int(value) & 0xFFFFFFFF for value in state["r8"]]
    words += [int(value) & 0xFFFFFFFF for value in state["alternate"]]
    words += [int(state[name]) & 0xFF for name in
              ("a", "f", "a_alt", "f_alt", "i", "r", "iff1", "iff2",
               "im", "halted", "irq_line", "ei_delay")]
    words += [int(state["pc"]) & 0xFFFF, int(state["sp"]) & 0xFFFF,
              int(state["ix"]) & 0xFFFF, int(state["iy"]) & 0xFFFF,
              int(state["wz"]) & 0xFFFF]
    for name in ("debt", "steps", "cycles", "interrupts"):
        value = int(state[name]) & 0xFFFFFFFFFFFFFFFF
        words += [value & 0xFFFFFFFF, (value >> 32) & 0xFFFFFFFF]
    words += [int(state["audio_mode"]), int(state["bus_bank"]),
              int(state["bus_requested"]), int(state["bus_reset_released"]),
              int(state["seed_z80"]), int(state["seed_ram"])]
    bits = 0
    for index, byte in enumerate(raw[:4]):
        bits |= byte << (8 * index)
    words += [len(raw[:4]), bits]
    assert len(words) == z80_format.CASE_WORDS
    return words


def write_cases(path: Path, records: Sequence[Sequence[int]]) -> Path:
    return z80_format.write_case_file(path, records)


def read_results(path: Path) -> List[dict]:
    data = Path(path).read_bytes()
    magic, version, count, record_size, ram_size = z80_format.unpack_header(data)
    if (magic, version, record_size, ram_size) != (
        z80_format.OUT_MAGIC, z80_format.FORMAT_VERSION,
        z80_format.OUT.size, z80_format.Z80_RAM_SIZE,
    ):
        raise AssertionError("bad Z80 result header: %r" % (magic,))
    return [z80_format.out_fields(
        z80_format.unpack_out(data, z80_format.HEADER_SIZE + index * z80_format.OUT.size)
    ) for index in range(count)]


def run_wasm_cases(rt, data: bytes, meta: dict, records, workdir: Path, rom: bytes = b"") -> List[dict]:
    """Instantiate ``data`` with the real runtime and run the Z80 cases."""
    workdir = Path(workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    game = workdir / "synthetic-z80.wasm"
    meta_path = workdir / "synthetic-z80.meta.json"
    cases = workdir / "synthetic-z80.cases.bin"
    out = workdir / "synthetic-z80.out.bin"
    rom_path = workdir / "synthetic-rom.bin"
    game.write_bytes(data)
    meta_path.write_text(json.dumps(meta), encoding="utf-8")
    write_cases(cases, records)
    rom_path.write_bytes(rom if rom else bytes(0x10000))
    process = run_node(
        INTEGRATION / "z80_run_wasm.mjs",
        "--runtime", str(rt.runtime),
        "--loader", str(rt.loader),
        "--game", str(game),
        "--meta", str(meta_path),
        "--cases", str(cases),
        "--rom", str(rom_path),
        "--out", str(out),
    )
    if process.returncode != 0:
        raise AssertionError("z80_run_wasm failed (%d):\n%s\n%s"
                             % (process.returncode, process.stdout[-4000:],
                                process.stderr[-4000:]))
    return read_results(out)


__all__ = [
    "DEFAULT_ROM", "DEFAULT_BASELINE", "LOCAL_Z80",
    "abi", "game_module", "z80_translate", "z80_format", "runtime_abi",
    "synthetic_program", "build_synthetic_module", "case_words",
    "write_cases", "read_results", "run_wasm_cases",
    "require_node", "require_python310", "external_inputs", "temporary_dir",
    "run_python", "run_node", "load_json_stdout", "ROOT", "INTEGRATION", "LOCAL_OUT",
    "z80_instruction", "random",
]

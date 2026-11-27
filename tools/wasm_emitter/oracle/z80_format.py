"""Binary Z80 case/result format for the Z80 differential test.

Mirrors :mod:`oracle.format` (same header layout, little-endian u32 words) but
carries the complete ``Z80CPU`` state plus the small part of the ``CPU`` the
translated Z80 code can observe (Z80 bus ownership, audio mode) and two RAM
images:

* the 8 KiB Z80 RAM (``z80_bus.ram``);
* the 64 KiB 68000 work RAM (the Z80 bank window can read/write it).

Case record (45 u32 = 180 bytes)::

    r8[6], alternate[6], a, f, a_alt, f_alt, i, r, iff1, iff2, im,
    halted, irq_line, ei_delay, pc, sp, ix, iy, wz, debt(2), steps(2),
    cycles(2), interrupts(2), audio_mode, bus_bank, bus_requested,
    bus_reset_released, seed_z80, seed_ram, patch_len, patch_bytes

``patch_len``/``patch_bytes`` write the selected instruction variant into the
Z80 RAM image at ``pc & 0x1fff`` (little-endian u32, at most 4 bytes), so every
case exercises the semantics of that guarded variant instead of the "RAM
differs" fallback.  The two RAM images are still filled deterministically from
the seeds exactly like the 68000 differential.

Result record (56 u32 = 224 bytes)::

    the same 45 state words, then
    fault, fault_address, fail_code,
    initial_z80_digest(2), initial_ram_digest(2),
    final_z80_digest(2), final_ram_digest(2)

Digests are the two 32-bit hashes from :func:`oracle.format.ram_digest` over the
8 KiB and 64 KiB images.  ``fail_code`` is the *canonical* emitter failure code
(``tools/wasm_emitter/abi.py``), translated from the C ``reason`` string by the
oracle and from the runtime ``reason`` string by the WASM harness.
"""

from __future__ import annotations

import struct
from typing import Sequence, Tuple

CASE_MAGIC = b"DZC1"
OUT_MAGIC = b"DZO1"
FORMAT_VERSION = 1
Z80_RAM_SIZE = 0x2000
RAM_SIZE = 0x10000

HEADER = struct.Struct("<4sIIII")     # magic, version, count, record_size, ram_size
CASE = struct.Struct("<45I")          # 180 bytes
OUT = struct.Struct("<56I")           # 224 bytes
HEADER_SIZE = HEADER.size

STATE_WORDS = 45
CASE_WORDS = 45
OUT_WORDS = 56

CASE_FIELDS = (
    "r8", "alternate", "a", "f", "a_alt", "f_alt", "i", "r", "iff1", "iff2",
    "im", "halted", "irq_line", "ei_delay", "pc", "sp", "ix", "iy", "wz",
    "debt", "steps", "cycles", "interrupts", "audio_mode", "bus_bank",
    "bus_requested", "bus_reset_released", "seed_z80", "seed_ram",
    "patch_len", "patch_bytes",
)
OUT_EXTRA_FIELDS = (
    "fault", "fault_address", "fail_code",
    "initial_z80_digest", "initial_ram_digest",
    "final_z80_digest", "final_ram_digest",
)
assert CASE.size == 180 and OUT.size == 224


def pack_header(magic: bytes, count: int, record_size: int) -> bytes:
    return HEADER.pack(magic, FORMAT_VERSION, count, record_size, Z80_RAM_SIZE)


def unpack_header(data: bytes) -> Tuple[bytes, int, int, int, int]:
    return HEADER.unpack_from(data, 0)


def pack_case(words: Sequence[int]) -> bytes:
    if len(words) != CASE_WORDS:
        raise ValueError("Z80 case needs %d u32 words, got %d" % (CASE_WORDS, len(words)))
    return CASE.pack(*words)


def unpack_case(data: bytes, offset: int = 0) -> Tuple[int, ...]:
    return CASE.unpack_from(data, offset)


def pack_out(words: Sequence[int]) -> bytes:
    if len(words) != OUT_WORDS:
        raise ValueError("Z80 result needs %d u32 words, got %d" % (OUT_WORDS, len(words)))
    return OUT.pack(*words)


def unpack_out(data: bytes, offset: int = 0) -> Tuple[int, ...]:
    return OUT.unpack_from(data, offset)


def state_fields(record: Sequence[int]) -> dict:
    """Decode the 45 state words into named Python values."""
    r8 = list(record[0:6])
    alternate = list(record[6:12])
    (a, f, a_alt, f_alt, i, r, iff1, iff2, im, halted, irq_line, ei_delay) = record[12:24]
    (pc, sp, ix, iy, wz) = record[24:29]

    def u64(lo: int, hi: int) -> int:
        return (lo | (hi << 32)) & 0xFFFFFFFFFFFFFFFF

    def s64(lo: int, hi: int) -> int:
        value = u64(lo, hi)
        return value - (1 << 64) if value >= (1 << 63) else value

    debt = s64(record[29], record[30])
    steps = u64(record[31], record[32])
    cycles = u64(record[33], record[34])
    interrupts = u64(record[35], record[36])
    return {
        "r8": r8,
        "alternate": alternate,
        "a": a, "f": f, "a_alt": a_alt, "f_alt": f_alt,
        "i": i, "r": r, "iff1": iff1, "iff2": iff2, "im": im,
        "halted": halted, "irq_line": irq_line, "ei_delay": ei_delay,
        "pc": pc, "sp": sp, "ix": ix, "iy": iy, "wz": wz,
        "debt": debt, "steps": steps, "cycles": cycles,
        "interrupts": interrupts,
        "audio_mode": record[37],
        "bus_bank": record[38],
        "bus_requested": record[39],
        "bus_reset_released": record[40],
        "seed_z80": record[41],
        "seed_ram": record[42],
    }


def out_fields(record: Sequence[int]) -> dict:
    """Decode the 56 result words: 45 state words + fault/digests."""
    state = state_fields(record[:STATE_WORDS])
    state["fault"] = record[45]
    state["fault_address"] = record[46]
    state["fail_code"] = record[47]
    state["initial_z80_digest"] = (record[48], record[49])
    state["initial_ram_digest"] = (record[50], record[51])
    state["final_z80_digest"] = (record[52], record[53])
    state["final_ram_digest"] = (record[54], record[55])
    return state


def write_case_file(path, records: Sequence[Sequence[int]]):
    from pathlib import Path

    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as handle:
        handle.write(pack_header(CASE_MAGIC, len(records), CASE.size))
        for words in records:
            handle.write(pack_case(words))
    return path


__all__ = [
    "CASE_MAGIC", "OUT_MAGIC", "FORMAT_VERSION", "Z80_RAM_SIZE", "RAM_SIZE",
    "HEADER", "CASE", "OUT", "HEADER_SIZE", "STATE_WORDS", "CASE_WORDS", "OUT_WORDS",
    "pack_header", "unpack_header", "pack_case", "unpack_case", "pack_out",
    "unpack_out", "state_fields", "out_fields", "write_case_file",
]

"""Binary case/result formats shared by Python, the C oracle and Node.

All integers are little-endian.  Keeping one authoritative layout here (and
mirroring it in C/JS) lets the differential test compare raw bytes instead of
re-implementing serialisation three times.

Case file header:  magic b"DWC1", version u32, count u32, record_size u32,
                   ram_size u32 (20 bytes).
Case record (96 bytes): d[8] a[8] pc usp ssp sr instruction_cycles halted fault
                        seed -- 24 u32.
Result header:     magic b"DWO1", version u32, count u32, record_size u32,
                   ram_size u32.
Result record (116 bytes): d[8] a[8] pc usp ssp sr instruction_cycles halted
                           fault fault_address fault_code
                           initial_digest_h1 initial_digest_h2
                           final_digest_h1 final_digest_h2 -- 29 u32.
"""

from __future__ import annotations

import struct
from typing import Iterable, List, Sequence, Tuple

CASE_MAGIC = b"DWC1"
OUT_MAGIC = b"DWO1"
FORMAT_VERSION = 1
RAM_SIZE = 0x10000

HEADER = struct.Struct("<4sIIII")          # magic, version, count, record_size, ram_size
CASE = struct.Struct("<24I")              # 96 bytes
OUT = struct.Struct("<29I")               # 116 bytes

CASE_FIELDS = (
    "d", "a", "pc", "usp", "ssp", "sr", "instruction_cycles", "halted", "fault", "seed"
)
OUT_FIELDS = (
    "d", "a", "pc", "usp", "ssp", "sr", "instruction_cycles", "halted", "fault",
    "fault_address", "fault_code", "initial_h1", "initial_h2", "final_h1", "final_h2",
)
assert HEADER.size == 20
assert CASE.size == 96
assert OUT.size == 116


def pack_header(magic: bytes, count: int, record_size: int, ram_size: int = RAM_SIZE) -> bytes:
    return HEADER.pack(magic, FORMAT_VERSION, count, record_size, ram_size)


def unpack_header(data: bytes) -> Tuple[bytes, int, int, int, int]:
    return HEADER.unpack_from(data, 0)


def pack_case(fields: Sequence[int]) -> bytes:
    if len(fields) != 24:
        raise ValueError("case record needs 24 u32 fields")
    return CASE.pack(*fields)


def unpack_case(data: bytes, offset: int = 0) -> Tuple[int, ...]:
    return CASE.unpack_from(data, offset)


def case_fields(record: Sequence[int]) -> dict:
    d = list(record[0:8])
    a = list(record[8:16])
    (
        pc, usp, ssp, sr, instruction_cycles, halted, fault, seed,
    ) = record[16:24]
    return {
        "d": d,
        "a": a,
        "pc": pc,
        "usp": usp,
        "ssp": ssp,
        "sr": sr,
        "instruction_cycles": instruction_cycles,
        "halted": halted,
        "fault": fault,
        "seed": seed,
    }


def pack_out(fields: Sequence[int]) -> bytes:
    if len(fields) != 29:
        raise ValueError("output record needs 29 u32 fields")
    return OUT.pack(*fields)


def unpack_out(data: bytes, offset: int = 0) -> Tuple[int, ...]:
    return OUT.unpack_from(data, offset)


def out_fields(record: Sequence[int]) -> dict:
    d = list(record[0:8])
    a = list(record[8:16])
    (
        pc, usp, ssp, sr, instruction_cycles, halted, fault, fault_address,
        fault_code, initial_h1, initial_h2, final_h1, final_h2,
    ) = record[16:29]
    return {
        "d": d,
        "a": a,
        "pc": pc,
        "usp": usp,
        "ssp": ssp,
        "sr": sr,
        "instruction_cycles": instruction_cycles,
        "halted": halted,
        "fault": fault,
        "fault_address": fault_address,
        "fault_code": fault_code,
        "initial_digest": (initial_h1, initial_h2),
        "final_digest": (final_h1, final_h2),
    }


# Digest used for the 64 KiB RAM comparison.  Two independent 32-bit hashes are
# cheap enough in C and JS over ~100 MB of candidate memory, unlike BigInt FNV.
# The C and JS implementations must stay in sync (checked by --ram-digest).
FNV1A_OFFSET = 2166136261
FNV1A_PRIME = 16777619
FNV2_OFFSET = 0x9E3779B9
FNV2_PRIME = 2246822519


def ram_digest(ram: bytes) -> Tuple[int, int]:
    h1 = FNV1A_OFFSET
    h2 = FNV2_OFFSET
    for byte in ram:
        h1 = ((h1 ^ byte) * FNV1A_PRIME) & 0xFFFFFFFF
        h2 = ((h2 + byte) * FNV2_PRIME) & 0xFFFFFFFF
    return h1, h2


def fill_ram(seed: int) -> bytes:
    """Deterministic xorshift32 RAM fill shared with C/JS."""
    x = seed & 0xFFFFFFFF or 0x9E3779B9
    out = bytearray(RAM_SIZE)
    for index in range(RAM_SIZE):
        x = (x ^ (x << 13)) & 0xFFFFFFFF
        x ^= x >> 17
        x = (x ^ (x << 5)) & 0xFFFFFFFF
        out[index] = x & 0xFF
    return bytes(out)


__all__ = [
    "CASE_MAGIC", "OUT_MAGIC", "FORMAT_VERSION", "RAM_SIZE", "HEADER", "CASE", "OUT",
    "CASE_FIELDS", "OUT_FIELDS", "pack_header", "unpack_header", "pack_case",
    "unpack_case", "case_fields", "pack_out", "unpack_out", "out_fields",
    "ram_digest", "fill_ram",
]

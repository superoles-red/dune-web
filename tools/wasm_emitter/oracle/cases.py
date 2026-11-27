"""Deterministic initial-state generator for the differential test.

For each instruction the generator produces ``N`` independent states: random
data/address registers, SR in user and supervisor mode, random USP/SSP, random
initial ``instruction_cycles``/``halted`` and a 64 KiB RAM image derived from a
seed.  Address registers point into the 0xE00000 RAM window so A-register
relative EAs exercise both aligned (success) and odd (address-error) paths.
"""

from __future__ import annotations

import random
from pathlib import Path
from typing import Iterable, List, Sequence, Tuple

from . import format as fmt

RAM_BUS = 0xE00000


def _ram_case_state(rng: random.Random) -> dict:
    d = [rng.getrandbits(32) for _ in range(8)]
    a = []
    odd_round = rng.randrange(5) == 0
    for _ in range(7):
        offset = rng.getrandbits(16) & 0xFFFE
        if odd_round and rng.random() < 0.5:
            offset |= 1
        a.append(RAM_BUS | offset)
    a.append(RAM_BUS | (0xF000 + (rng.getrandbits(12) & 0x0FFE)))
    sr = rng.getrandbits(16)
    if rng.random() < 0.5:
        sr |= 0x2000
    else:
        sr &= ~0x2000
    if rng.random() < 0.25:
        sr |= 0x8000  # trace bit must not disturb instruction semantics
    return {
        "d": d,
        "a": a,
        "pc": 0,
        "usp": rng.getrandbits(32),
        "ssp": rng.getrandbits(32),
        "sr": sr,
        "instruction_cycles": rng.getrandbits(32),
        "halted": 0 if rng.random() < 0.8 else 1,
        "fault": 0,
        "seed": rng.getrandbits(32),
    }


def make_case_records(instructions: Sequence, count_per_instruction: int,
                      seed: int = 0xD00E5EED) -> List[Tuple[int, ...]]:
    rng = random.Random(seed)
    records: List[Tuple[int, ...]] = []
    for inst in sorted(instructions, key=lambda item: item.pc):
        for _ in range(count_per_instruction):
            state = _ram_case_state(rng)
            state["pc"] = inst.pc
            records.append(
                tuple(
                    state["d"]
                    + state["a"]
                    + [
                        state["pc"],
                        state["usp"],
                        state["ssp"],
                        state["sr"],
                        state["instruction_cycles"],
                        state["halted"],
                        state["fault"],
                        state["seed"],
                    ]
                )
            )
    return records


def write_case_file(path: Path, records: Sequence[Tuple[int, ...]]) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as handle:
        handle.write(fmt.pack_header(fmt.CASE_MAGIC, len(records), fmt.CASE.size))
        for record in records:
            handle.write(fmt.pack_case(record))
    return path


def read_case_file(path: Path) -> List[Tuple[int, ...]]:
    data = Path(path).read_bytes()
    magic, version, count, record_size, ram_size = fmt.unpack_header(data)
    if (magic, version, record_size, ram_size) != (
        fmt.CASE_MAGIC, fmt.FORMAT_VERSION, fmt.CASE.size, fmt.RAM_SIZE
    ):
        raise ValueError("bad case file header")
    if len(data) != fmt.HEADER.size + count * record_size:
        raise ValueError("case file length mismatch")
    offset = fmt.HEADER.size
    return [fmt.unpack_case(data, offset + index * record_size) for index in range(count)]


__all__ = ["make_case_records", "write_case_file", "read_case_file", "RAM_BUS"]

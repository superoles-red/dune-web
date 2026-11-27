"""ROM-free synthetic page used by the integration tests.

A handful of real 68000 instructions placed on page ``$013`` (the page the
differential uses) so that :func:`tools.wasm_emitter.game_module.build_module`
produces a structurally complete module -- page dispatcher, ``translated_step``,
``warmup_all``, funcref table -- without any game data.  Used to test:

* the module structure (imports ``env.dune_*``, no memory/data/globals);
* that CPU offsets embedded in the code really come from the ABI descriptor;
* Node-side linking into ``runtime.wasm`` (``link_and_run.mjs --verify-only``).
"""

from __future__ import annotations

from typing import List


def _instruction_class():
    try:
        from genesis_recompiler.decode import EA, Instruction
    except Exception as error:  # pragma: no cover - Python < 3.10
        raise RuntimeError("vendored recompiler decoder is unavailable: %s" % error)
    return EA, Instruction


def synthetic_instructions() -> List:
    """A handful of real instructions on ROM page ``$013`` (PCs 0x13000..0x1300e)."""
    EA, Instruction = _instruction_class()
    d0, d1, d2, d3 = EA(0, 0), EA(0, 1), EA(0, 2), EA(0, 3)
    a0, a1, a7 = EA(1, 0), EA(1, 1), EA(1, 7)
    ind0 = EA(2, 0)
    imm = EA(7, 4, 4)

    specs = [
        # pc,     op,      size, src,   dst,   value, target, raw
        (0x13000, "ADDQ",  4,   None,  a7,    4,     None,   b"\x58\x8f"),
        (0x13002, "MOVE",  4,   d0,    d1,    0,     None,   b"\x22\x00"),
        (0x13004, "CLR",   2,   None,  d2,    0,     None,   b"\x42\x42"),
        (0x13006, "MOVEQ", 4,   None,  d3,    1,     None,   b"\x76\x01"),
        (0x13008, "LEA",   4,   ind0,  a1,    0,     None,   b"\x43\xe8\x00\x00"),
        (0x1300c, "NOP",   0,   None,  None,  0,     None,   b"\x4e\x71"),
        (0x1300e, "RTS",   0,   None,  None,  0,     None,   b"\x4e\x75"),
    ]
    instructions = []
    for pc, op, size, src, dst, value, target, raw in specs:
        instructions.append(
            Instruction(pc=pc, end=pc + len(raw), op=op, size=size, src=src,
                        dst=dst, value=value, target=target, raw=raw)
        )
    return instructions


class SyntheticProgram:
    """Minimal stand-in for ``genesis_recompiler.decode.Program``."""

    def __init__(self, instructions=None):
        self.instructions = {inst.pc: inst for inst in (instructions or synthetic_instructions())}
        # 64 KiB of zeroes is enough for the RAM-variant guard path (unused).
        self.rom = bytes(0x10000)
        self.ram_variants = {}


__all__ = ["SyntheticProgram", "synthetic_instructions"]

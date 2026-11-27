"""Translation coverage: every supported op family compiles to a valid module.

This test is ROM-free.  It constructs one synthetic ``Instruction`` per op
family/EA shape, builds a real game.wasm module through game_module and asks
V8/JSC to validate it.  That catches the most common emitter bug (stack
imbalance / missing return) for all operations without needing game data.
"""

from __future__ import annotations

import sys
import unittest

from support import add_tools_path, add_vendor_path

add_tools_path()
add_vendor_path()

from wasm_emitter import abi, encoder, game_module, translate  # noqa: E402


class FakeProgram:
    def __init__(self, instructions):
        self.instructions = {inst.pc: inst for inst in instructions}
        self.rom = bytes(0x10000)
        self.ram_variants = {}


def _synthetic_instructions():
    try:
        from genesis_recompiler.decode import EA, Instruction
    except Exception as error:  # Python < 3.10
        raise unittest.SkipTest("vendor decoder needs Python 3.10+: %s" % error)

    d0, d1, d2 = EA(0, 0), EA(0, 1), EA(0, 2)
    a0, a1, a7 = EA(1, 0), EA(1, 1), EA(1, 7)
    ind0, post0, pre0 = EA(2, 0), EA(3, 0), EA(4, 0)
    disp5, idx6 = EA(5, 0, 8), EA(6, 0, 4, 0x0800)
    abs_w = EA(7, 0, 0xE000)
    abs_l = EA(7, 1, 0xE00100)
    pcrel = EA(7, 2, 0x3000)
    pcidx = EA(7, 3, 0x3000, 0x0800)
    imm = EA(7, 4, 0x1234)

    instructions = []
    pc = 0x61000

    def add(op, size=0, src=None, dst=None, value=0, target=None, condition=0,
            raw=b"\x4e\x71"):
        nonlocal pc
        inst = Instruction(pc=pc, end=pc + len(raw), op=op, size=size, src=src,
                           dst=dst, value=value, target=target,
                           condition=condition, raw=raw)
        instructions.append(inst)
        pc += 2
        return inst

    # MOVE/MOVEA: every size and the main addressing modes.
    for size in (1, 2, 4):
        for src, dst in (
            (d0, d1), (a1, d2), (ind0, D := d1), (post0, pre0), (disp5, idx6),
            (imm, abs_w), (abs_l, ind0), (pcrel, pcidx), (d2, a0),
        ):
            add("MOVE", size, src, dst)
        add("MOVEA", size, imm if size == 2 else abs_l, a0)
    # Unary/logic.
    for size in (1, 2, 4):
        add("CLR", size, dst=d0)
        add("CLR", size, dst=ind0)
        add("TST", size, dst=abs_l)
        add("NOT", size, dst=d0)
        add("NEG", size, dst=ind0)
        add("SWAP", 4, dst=d2)
        add("EXT", 2 if size == 1 else 4, dst=d0)
        add("MULU", 2, src=d1, dst=d0)
        add("MULS", 2, src=ind0, dst=d1)
        add("DIVU", 2, src=d1, dst=d2)
        add("DIVS", 2, src=imm, dst=d0)
    # Arithmetic.
    for size in (1, 2, 4):
        add("ADDQ", size, dst=d0, value=3)
        add("SUBQ", size, dst=a0, value=2)
        add("ADD", size, src=d1, dst=d2)
        add("SUB", size, src=imm, dst=ind0)
        add("CMP", size, src=d1, dst=d2)
        add("CMPI", size, src=imm, dst=d0)
        add("ADDI", size, src=imm, dst=ind0)
        add("SUBI", size, src=imm, dst=post0)
        add("ORI", size, src=imm, dst=d0)
        add("ANDI", size, src=imm, dst=ind0)
        add("EORI", size, src=imm, dst=d0)
        add("OR", size, src=d1, dst=d2)
        add("AND", size, src=imm, dst=d0)
        add("EOR", size, src=d1, dst=ind0)
        add("ADDX", size, src=d0, dst=d1)
        add("SUBX", size, src=pre0, dst=pre0)
        add("NEGX", size, dst=d0)
    add("ABCD", 1, src=d0, dst=d1)
    add("SBCD", 1, src=pre0, dst=pre0)
    add("NBCD", 1, dst=d0)
    for size in (2, 4):
        add("ADDA", size, src=d1, dst=a0)
        add("SUBA", size, src=imm, dst=a1)
        add("CMPA", size, src=d1, dst=a0)
    # Branches/control.
    for cond in (0, 2, 4, 7, 11, 15):
        add("BCC", 0, condition=cond, target=0x61080,
            raw=b"\x66\x00\x00\x10" if cond == 6 else b"\x66\x10")
    add("BSR", 0, target=0x61070)
    add("DBCC", 2, dst=d0, condition=4, target=0x61040, raw=b"\x50\xc8\x00\x10")
    add("SCC", 1, dst=d0, condition=7)
    add("SCC", 1, dst=ind0, condition=7)
    for size in (2, 4):
        add("JSR", size, src=ind0)
        add("JMP", size, src=abs_l)
        add("LEA", 4, src=disp5, dst=a0)
        add("LEA", 4, src=abs_w, dst=a1)
        add("PEA", 4, src=idx6)
    add("RTS", 0)
    add("RTE", 0)
    add("RTR", 0)
    add("LINK", 4, dst=a7, value=-8)
    add("UNLK", 4, dst=a7)
    # Status register / USP.
    add("TO_SR", 2, src=imm)
    add("TO_CCR", 1, src=imm)
    add("SR_OR", 2, src=imm)
    add("SR_AND", 2, src=imm)
    add("SR_EOR", 2, src=imm)
    add("CCR_OR", 1, src=imm)
    add("CCR_AND", 1, src=imm)
    add("CCR_EOR", 1, src=imm)
    add("FROM_SR", 2, dst=d0)
    add("FROM_SR", 1, dst=pre0)
    add("TO_USP", 4, dst=a0)
    add("FROM_USP", 4, dst=a1)
    # Bit operations.
    for op in ("BTST", "BCHG", "BCLR", "BSET"):
        add(op, 1, src=d0, dst=d1)
        add(op, 4, src=imm, dst=d0)
        add(op, 1, src=imm, dst=ind0)
    # MOVEM.
    add("MOVEM_LOAD", 4, src=post0, value=0x0CFC)
    add("MOVEM_LOAD", 2, src=abs_w, value=0x00FF)
    add("MOVEM_STORE", 4, dst=pre0, value=0x3820)
    add("MOVEM_STORE", 2, dst=disp5, value=0x00F0)
    # Shifts: register and memory forms, all kinds.
    for name in ("ASL", "ASR", "LSL", "LSR", "ROXL", "ROXR", "ROL", "ROR"):
        add(name, 2, src=EA(7, 4, 3), dst=d0)
        add(name, 4, src=d1, dst=d2)
        if name in ("ASL", "LSL", "ROL", "ROXL"):
            add(name, 2, src=EA(7, 4, 1), dst=ind0)
    # Exceptions/oddities.
    add("NOP")
    add("TRAP", 0, value=3)
    add("STOP", 0, value=0x2700)
    add("ILLEGAL")
    add("LINE_A", 0, value=0xA000)
    add("LINE_F", 0, value=0xF000)
    add("EXG", 4, src=d0, dst=d1)
    add("EXG", 4, src=a0, dst=a1)
    return instructions


class TranslationTests(unittest.TestCase):
    def test_required_ops_are_supported(self):
        from wasm_emitter.coverage import REQUIRED_OPS

        missing = [op for op in REQUIRED_OPS if op not in translate.SUPPORTED_OPS]
        self.assertEqual(missing, [])

    def test_all_op_families_build_a_valid_module(self):
        from support import node_path, validate_wasm_bytes

        if sys.version_info < (3, 10):
            self.skipTest("vendor decoder needs Python 3.10+")
        if node_path() is None:
            self.skipTest("node is not installed")
        instructions = _synthetic_instructions()
        program = FakeProgram(instructions)
        abi_desc = abi.REFERENCE_NATIVE_ABI
        layout = abi.MemoryLayout.from_cpu(0x10000, abi_desc, 0x80000)
        data, meta = game_module.build_module(program, instructions, abi_desc, layout,
                                              label="synthetic")
        self.assertTrue(validate_wasm_bytes(data))
        self.assertEqual(len(meta["instructions"]), len(instructions))
        self.assertGreater(meta["modules"]["handler_bytes"], 0)

    def test_unsupported_op_is_rejected(self):
        if sys.version_info < (3, 10):
            self.skipTest("vendor decoder needs Python 3.10+")
        from genesis_recompiler.decode import Instruction

        inst = Instruction(pc=0x61000, end=0x61002, op="FUTURE_OP", raw=b"\x4e\x71")
        with self.assertRaises(translate.UnsupportedInstruction):
            translate.Translator(object(), {}, abi.REFERENCE_NATIVE_ABI).emit(
                encoder.Func(object(), 0, 0, [encoder.I32, encoder.I32], []),
                translate.Scratch(
                    encoder.Func(object(), 1, 0, [encoder.I32, encoder.I32], [])
                ),
                inst,
            )

    def test_mask_for(self):
        self.assertEqual(translate.mask_for(1), 0xFF)
        self.assertEqual(translate.mask_for(2), 0xFFFF)
        self.assertEqual(translate.mask_for(4), 0xFFFFFFFF)


if __name__ == "__main__":
    unittest.main()

"""Translate ``genesis_recompiler.decode`` instructions to WASM handler bodies.

The semantics are a direct port of the reference C emitter
(``genesis_recompiler/emit.py`` and ``runtime.h``):

* exactly one inline handler per instruction; no opcode fetch/decode at runtime;
* ``instruction_cycles`` is written before the first helper call;
* ``pc`` is written exactly once, at the end (or on the taken branch);
* every helper that can raise ``fault`` (``read_mem`` / ``write_mem`` /
  ``push32`` / ``pop32`` / ``movem`` / ``divide_value``) is followed by an early
  ``return``;
* ``condition`` is evaluated once per instruction and reused for cycles and the
  branch (manual CSE);
* addresses, masks, sign extension and post-increment follow the C emitter
  byte-for-byte.

Python 3.9 compatible at import time; the vendor ``decode``/``cycles`` modules
are imported lazily because they use Python 3.10 annotation syntax.
"""

from __future__ import annotations

from typing import Callable, Dict, List, Optional

from . import abi
from .encoder import Code, Func, I32, Module


class UnsupportedInstruction(NotImplementedError):
    """The decoder produced an operation this emitter does not translate yet."""


# Every op family the emitter knows.  Kept explicit so ``game_module`` can
# report the exact gap instead of emitting a handler that silently misbehaves.
SUPPORTED_OPS = frozenset(
    (
        "NOP", "TRAP", "ILLEGAL", "LINE_A", "LINE_F", "STOP",
        "TO_USP", "FROM_USP",
        "TO_SR", "TO_CCR", "SR_OR", "SR_AND", "SR_EOR",
        "CCR_OR", "CCR_AND", "CCR_EOR",
        "FROM_SR",
        "MOVEM_LOAD", "MOVEM_STORE",
        "LINK", "UNLK", "RTE", "RTR",
        "RTS",
        "BCC", "BSR", "DBCC",
        "LEA", "PEA", "JMP", "JSR",
        "MOVEQ",
        "ADDQ", "SUBQ",
        "ADDA", "SUBA", "CMPA",
        "EXG",
        "MOVE", "MOVEA", "CLR", "TST",
        "ADDI", "SUBI", "CMPI", "ORI", "ANDI", "EORI",
        "ADD", "SUB", "CMP", "OR", "AND", "EOR", "NEG",
        "ADDX", "SUBX", "NEGX",
        "ABCD", "SBCD", "NBCD",
        "NOT", "SWAP", "EXT", "SCC",
        "BTST", "BCHG", "BCLR", "BSET",
        "ASL", "ASR", "LSL", "LSR", "ROXL", "ROXR", "ROL", "ROR",
        "MULU", "MULS", "DIVU", "DIVS",
    )
)

SHIFT_OPS = frozenset(("ASL", "ASR", "LSL", "LSR", "ROXL", "ROXR", "ROL", "ROR"))
BIT_OPS = frozenset(("BTST", "BCHG", "BCLR", "BSET"))
MUL_DIV_OPS = frozenset(("MULU", "MULS", "DIVU", "DIVS"))
LOGIC_FLAG_OPS = frozenset(
    (
        "MOVE", "CLR", "TST", "ORI", "ANDI", "EORI", "OR", "AND", "EOR",
        "NOT", "EXT", "SWAP", "MULU", "MULS",
    )
)
CONDITIONAL_OPS = frozenset(("BCC", "DBCC", "SCC"))

SCRATCH_LOCALS = 12


def _cycles():
    from genesis_recompiler.cycles import instruction_cycles

    return instruction_cycles


def _ea_cycles():
    from genesis_recompiler.cycles import ea_cycles

    return ea_cycles


def mask_for(size: int) -> int:
    return 0xFFFFFFFF if size == 4 else (1 << (size * 8)) - 1


class Scratch:
    """Name -> absolute WASM local index, allocated per handler and reused."""

    def __init__(self, func: Func, capacity: int = SCRATCH_LOCALS) -> None:
        self.func = func
        self.capacity = capacity
        self.names: Dict[str, int] = {}
        func.locals = [I32] * capacity

    def reset(self) -> None:
        self.names.clear()

    def index(self, name: str) -> int:
        index = self.names.get(name)
        if index is not None:
            return index
        offset = len(self.names)
        if offset >= self.capacity:
            raise AssertionError(
                "handler needs more than %d scratch locals" % self.capacity
            )
        index = self.func.local(offset)
        self.names[name] = index
        return index


class Translator:
    """Emit one instruction handler into ``func`` (page function)."""

    def __init__(self, module: Module, imports: Dict[str, int], abi_desc: abi.CpuAbi,
                 rom: bytes = b"", scratch: Optional[Scratch] = None) -> None:
        self.module = module
        self.imports = imports
        self.abi = abi_desc
        self.rom = rom
        self.func: Optional[Func] = None
        self.code: Optional[Code] = None
        self.scratch: Optional[Scratch] = None
        self.inst = None
        self.cond_index: Optional[int] = None

    # -- low level ---------------------------------------------------------
    def helper(self, name: str) -> int:
        return self.imports[name]

    def lg(self, name: str) -> "Translator":
        self.code.local_get(self.scratch.index(name))
        return self

    def ls(self, name: str) -> "Translator":
        self.code.local_set(self.scratch.index(name))
        return self

    def push_c(self) -> "Translator":
        self.code.local_get(0)
        return self

    def push(self, expr: Callable[["Translator"], None]) -> "Translator":
        expr(self)
        return self

    def const(self, value: int) -> "Translator":
        self.code.i32_const(value & 0xFFFFFFFF)
        return self

    def load_u32(self, offset: int) -> "Translator":
        self.push_c()
        self.code.i32_load(offset=offset)
        return self

    def load_u16(self, offset: int) -> "Translator":
        self.push_c()
        self.code.i32_load16_u(offset=offset)
        return self

    def push_u16(self, offset: int) -> "Translator":
        self.push_c()
        self.code.i32_load16_u(offset=offset)
        return self

    def store_u32(self, offset: int, expr: Callable[["Translator"], None]) -> "Translator":
        self.push_c()
        expr(self)
        self.code.i32_store(offset=offset)
        return self

    def add_to_field(self, offset: int, delta: int) -> "Translator":
        self.push_c()
        self.load_u32(offset)
        self.const(delta)
        self.code.i32_add()
        self.code.i32_store(offset=offset)
        return self

    def set_field(self, offset: int, value: int) -> "Translator":
        self.push_c()
        self.const(value)
        self.code.i32_store(offset=offset)
        return self

    def check_fault(self) -> "Translator":
        self.load_u32(self.abi.fault)
        self.code.if_()
        self.code.return_()
        self.code.end()
        return self

    def fail(self, code: int) -> "Translator":
        self.push_c()
        self.const(code)
        self.load_u32(self.abi.pc)
        self.code.call(self.helper("fail"))
        return self

    def set_pc(self, value: int) -> "Translator":
        self.set_field(self.abi.pc, value)
        return self

    def return_(self) -> "Translator":
        self.code.return_()
        return self

    def finish(self) -> "Translator":
        self.set_pc(self.inst.end)
        self.code.return_()
        return self

    def sign_extend_expr(self, expr: Callable[["Translator"], None], size: int) -> "Translator":
        shift = 32 - size * 8
        expr(self)
        self.const(shift)
        self.code.i32_shl()
        self.const(shift)
        self.code.i32_shr_s()
        return self

    # -- EA handling (mirrors emit.py address/prepare/read/post/write) -----
    def address(self, ea, name: str, size: int) -> None:
        mode, reg, value = ea.mode, ea.reg, ea.value
        if mode in (2, 3, 4):
            increment = 2 if reg == 7 and size == 1 else size
            if mode == 4:
                self.add_to_field(self.abi.a + reg * 4, -increment)
            self.load_u32(self.abi.a + reg * 4)
        elif mode == 5:
            self.load_u32(self.abi.a + reg * 4)
            self.const(value)
            self.code.i32_add()
        elif mode == 6:
            self.load_u32(self.abi.a + reg * 4)
            self.const(value)
            self.code.i32_add()
            self.push_c()
            self.const(ea.index)
            self.code.call(self.helper("index_value"))
            self.code.i32_add()
        elif mode == 7 and reg <= 2:
            self.const(value)
        elif mode == 7 and reg == 3:
            self.const(value)
            self.push_c()
            self.const(ea.index)
            self.code.call(self.helper("index_value"))
            self.code.i32_add()
        else:
            raise UnsupportedInstruction("effective address has no address: %r" % (ea,))
        self.ls(name)

    def prepare(self, ea, name: str, size: int) -> None:
        if ea.mode not in (0, 1) and not (ea.mode == 7 and ea.reg == 4):
            self.address(ea, name + "_addr", size)

    def read(self, ea, name: str, size: int) -> None:
        if ea.mode in (0, 1):
            base = self.abi.d if ea.mode == 0 else self.abi.a
            self.load_u32(base + ea.reg * 4)
            self.const(mask_for(size))
            self.code.i32_and()
        elif ea.mode == 7 and ea.reg == 4:
            self.const(ea.value)
        else:
            self.push_c()
            self.lg(name + "_addr")
            self.const(size)
            self.code.call(self.helper("read_mem"))
        self.ls(name)
        self.check_fault()

    def post(self, ea, size: int) -> None:
        if ea.mode != 3:
            return
        increment = 2 if ea.reg == 7 and size == 1 else size
        self.add_to_field(self.abi.a + ea.reg * 4, increment)

    def write(self, ea, name: str, size: int,
              expr: Callable[["Translator"], None]) -> None:
        mask = mask_for(size)
        if ea.mode == 0:
            offset = self.abi.d + ea.reg * 4
            self.push_c()
            self.load_u32(offset)
            self.const(~mask)
            self.code.i32_and()
            expr(self)
            self.const(mask)
            self.code.i32_and()
            self.code.i32_or()
            self.code.i32_store(offset=offset)
        elif ea.mode == 1:
            self.store_u32(self.abi.a + ea.reg * 4, expr)
        else:
            self.push_c()
            self.lg(name + "_addr")
            self.const(size)
            expr(self)
            self.code.call(self.helper("write_mem"))
            self.check_fault()

    # -- cycles ------------------------------------------------------------
    def _condition_local(self) -> int:
        if self.cond_index is None:
            self.push_c()
            self.const(self.inst.condition)
            self.code.call(self.helper("condition"))
            self.ls("cond")
            self.cond_index = self.scratch.index("cond")
        return self.cond_index

    def _emit_cycles_value(self) -> None:
        # The BCC/DBCC/SCC/shift-register expressions are emitted explicitly;
        # everything else is a constant or a small integer expression computed
        # by the shared cycles.py module at translation time.
        inst = self.inst
        op = inst.op
        if op == "BCC":
            false_cycles = 12 if len(inst.raw) == 4 else 8
            self.code.local_get(self.cond_index)
            self.code.if_()
            self.set_field(self.abi.instruction_cycles, 10)
            self.code.else_()
            self.set_field(self.abi.instruction_cycles, false_cycles)
            self.code.end()
            return
        if op == "DBCC":
            # condition ? 12 : ((d[reg] & 0xffff) == 0 ? 14 : 10)
            reg = inst.dst.reg
            self.code.local_get(self.cond_index)
            self.code.if_()
            self.set_field(self.abi.instruction_cycles, 12)
            self.code.else_()
            self.load_u32(self.abi.d + reg * 4)
            self.const(0xFFFF)
            self.code.i32_and()
            self.code.i32_eqz()
            self.code.if_()
            self.set_field(self.abi.instruction_cycles, 14)
            self.code.else_()
            self.set_field(self.abi.instruction_cycles, 10)
            self.code.end()
            self.code.end()
            return
        if op == "SCC" and inst.dst.mode == 0:
            self.code.local_get(self.cond_index)
            self.code.if_()
            self.set_field(self.abi.instruction_cycles, 6)
            self.code.else_()
            self.set_field(self.abi.instruction_cycles, 4)
            self.code.end()
            return
        if op in SHIFT_OPS and inst.dst.mode == 0:
            base = 8 if inst.size == 4 else 6
            self.set_field(self.abi.instruction_cycles, base)
            self.push_c()
            self.load_u32(self.abi.instruction_cycles)
            self.const(2)
            if inst.src.mode == 7:
                self.const(inst.src.value)
            else:
                self.load_u32(self.abi.d + inst.src.reg * 4)
                self.const(63)
                self.code.i32_and()
            self.code.i32_mul()
            self.code.i32_add()
            self.code.i32_store(offset=self.abi.instruction_cycles)
            return
        text = _cycles()(inst)
        try:
            value = int(text)
        except ValueError:
            # Only constants and simple +/* expressions remain here.
            value = int(eval(text, {"__builtins__": {}}, {}))  # internal, trusted
        self.set_field(self.abi.instruction_cycles, value)

    # -- public entry ------------------------------------------------------
    def emit(self, func: Func, scratch: Scratch, inst) -> None:
        self.func = func
        self.code = func.code
        self.scratch = scratch
        self.inst = inst
        self.cond_index = None
        if inst.op not in SUPPORTED_OPS:
            raise UnsupportedInstruction(
                "unsupported op %s at $%06x (%s)" % (inst.op, inst.pc, inst)
            )
        scratch.reset()
        if inst.op in CONDITIONAL_OPS:
            self._condition_local()
        self._emit_cycles_value()
        self._emit_body()

    # -- body --------------------------------------------------------------
    def _emit_body(self) -> None:
        inst = self.inst
        op, size = inst.op, inst.size
        if op == "NOP":
            return self.finish()
        if op == "TRAP":
            saved = "saved_sr"
            self.load_u16(self.abi.sr)
            self.ls(saved)
            # set_sr(c, (saved_sr | 0x2000) & ~0x8000)
            self.push_c()
            self.lg(saved)
            self.const(0x2000)
            self.code.i32_or()
            self.const(0x8000)
            self.code.i32_xor()
            self.code.call(self.helper("set_sr"))
            self.push_c()
            self.const(inst.end)
            self.code.call(self.helper("push32"))
            self.check_fault()
            self.add_to_field(self.abi.a + 7 * 4, -2)
            self.push_c()
            self.load_u32(self.abi.a + 7 * 4)
            self.const(2)
            self.lg(saved)
            self.code.call(self.helper("write_mem"))
            self.check_fault()
            self.push_c()
            self.const((32 + inst.value) * 4)
            self.const(4)
            self.code.call(self.helper("read_mem"))
            self.ls("target")
            self.check_fault()
            self.push_c()
            self.lg("target")
            self.const(0xFFFFFF)
            self.code.i32_and()
            self.code.i32_store(offset=self.abi.pc)
            return self.code.return_()
        if op == "ILLEGAL":
            self.fail(abi.FAIL_ILLEGAL)
            return self.return_()
        if op in ("LINE_A", "LINE_F"):
            self.fail(abi.FAIL_LINE_A if op == "LINE_A" else abi.FAIL_LINE_F)
            return self.return_()
        if op == "STOP":
            self.load_u16(self.abi.sr)
            self.const(abi.SR_SUPERVISOR)
            self.code.i32_and()
            self.code.i32_eqz()
            self.code.if_()
            self.fail(abi.FAIL_PRIVILEGE)
            self.return_()
            self.code.end()
            self.push_c()
            self.const(inst.value)
            self.code.call(self.helper("set_sr"))
            self.set_field(self.abi.halted, 1)
            return self.finish()
        if op in ("TO_USP", "FROM_USP"):
            self.load_u16(self.abi.sr)
            self.const(abi.SR_SUPERVISOR)
            self.code.i32_and()
            self.code.i32_eqz()
            self.code.if_()
            self.fail(abi.FAIL_PRIVILEGE)
            self.return_()
            self.code.end()
            reg = inst.dst.reg
            if op == "TO_USP":
                self.push_c()
                self.load_u32(self.abi.a + reg * 4)
                self.code.i32_store(offset=self.abi.usp)
            else:
                self.push_c()
                self.load_u32(self.abi.usp)
                self.code.i32_store(offset=self.abi.a + reg * 4)
            return self.finish()
        if op in ("TO_SR", "TO_CCR", "SR_OR", "SR_AND", "SR_EOR",
                  "CCR_OR", "CCR_AND", "CCR_EOR"):
            if op == "TO_SR" or op.startswith("SR_"):
                self.load_u16(self.abi.sr)
                self.const(abi.SR_SUPERVISOR)
                self.code.i32_and()
                self.code.i32_eqz()
                self.code.if_()
                self.fail(abi.FAIL_PRIVILEGE)
                self.return_()
                self.code.end()
            self.prepare(inst.src, "src", size)
            self.read(inst.src, "src", size)
            self.post(inst.src, size)
            if op == "TO_SR":
                self.push_c()
                self.lg("src")
                self.code.call(self.helper("set_sr"))
            elif op == "TO_CCR":
                # c->sr = (c->sr & ~31) | (src & 31)
                self.push_c()
                self.load_u16(self.abi.sr)
                self.const(~31)
                self.code.i32_and()
                self.lg("src")
                self.const(31)
                self.code.i32_and()
                self.code.i32_or()
                self.code.i32_store16(offset=self.abi.sr)
            else:
                operator = {"OR": "|", "AND": "&", "EOR": "^"}[op.split("_")[1]]
                if op.startswith("SR_"):
                    self.push_c()
                    self.load_u16(self.abi.sr)
                    self._apply_sr_operator(operator)
                    self.code.call(self.helper("set_sr"))
                else:
                    self.push_c()
                    self.load_u16(self.abi.sr)
                    self.const(~31)
                    self.code.i32_and()
                    self.load_u16(self.abi.sr)
                    self._apply_sr_operator(operator)
                    self.const(31)
                    self.code.i32_and()
                    self.code.i32_or()
                    self.code.i32_store16(offset=self.abi.sr)
            return self.finish()
        if op == "FROM_SR":
            self.prepare(inst.dst, "dst", size)
            self.write(inst.dst, "dst", size, lambda t: t.push_u16(t.abi.sr))
            self.post(inst.dst, size)
            return self.finish()
        if op in ("MOVEM_LOAD", "MOVEM_STORE"):
            ea = inst.src if op == "MOVEM_LOAD" else inst.dst
            if ea.mode == 4:
                self.load_u32(self.abi.a + ea.reg * 4)
                self.ls("target")
            else:
                self.address(ea, "target", size)
            self.push_c()
            self.const(inst.value)
            self.lg("target")
            self.const(ea.mode)
            self.const(ea.reg)
            self.const(size)
            self.const(1 if op == "MOVEM_LOAD" else 0)
            self.code.call(self.helper("movem"))
            self.check_fault()
            return self.finish()
        if op == "LINK":
            reg = inst.dst.reg
            self.push_c()
            self.load_u32(self.abi.a + reg * 4)
            self.code.call(self.helper("push32"))
            self.check_fault()
            self.push_c()
            self.load_u32(self.abi.a + 7 * 4)
            self.code.i32_store(offset=self.abi.a + reg * 4)
            self.add_to_field(self.abi.a + 7 * 4, inst.value)
            return self.finish()
        if op == "UNLK":
            reg = inst.dst.reg
            self.push_c()
            self.load_u32(self.abi.a + reg * 4)
            self.code.i32_store(offset=self.abi.a + 7 * 4)
            self.push_c()
            self.code.call(self.helper("pop32"))
            self.ls("saved")
            self.check_fault()
            self.store_u32(self.abi.a + reg * 4, lambda t: t.lg("saved"))
            return self.finish()
        if op in ("RTE", "RTR"):
            if op == "RTE":
                self.load_u16(self.abi.sr)
                self.const(abi.SR_SUPERVISOR)
                self.code.i32_and()
                self.code.i32_eqz()
                self.code.if_()
                self.fail(abi.FAIL_PRIVILEGE)
                self.return_()
                self.code.end()
            self.push_c()
            self.load_u32(self.abi.a + 7 * 4)
            self.const(2)
            self.code.call(self.helper("read_mem"))
            self.ls("saved_sr")
            self.check_fault()
            self.push_c()
            self.load_u32(self.abi.a + 7 * 4)
            self.const(2)
            self.code.i32_add()
            self.const(4)
            self.code.call(self.helper("read_mem"))
            self.ls("target")
            self.check_fault()
            self.add_to_field(self.abi.a + 7 * 4, 6)
            if op == "RTE":
                self.push_c()
                self.lg("saved_sr")
                self.code.call(self.helper("set_sr"))
            else:
                self.push_c()
                self.load_u16(self.abi.sr)
                self.const(~31)
                self.code.i32_and()
                self.lg("saved_sr")
                self.const(31)
                self.code.i32_and()
                self.code.i32_or()
                self.code.i32_store16(offset=self.abi.sr)
            self.push_c()
            self.lg("target")
            self.const(0xFFFFFF)
            self.code.i32_and()
            self.code.i32_store(offset=self.abi.pc)
            return self.code.return_()
        if op == "RTS":
            self.push_c()
            self.code.call(self.helper("pop32"))
            self.ls("target")
            self.check_fault()
            self.push_c()
            self.lg("target")
            self.const(0xFFFFFF)
            self.code.i32_and()
            self.code.i32_store(offset=self.abi.pc)
            return self.code.return_()
        if op == "BSR":
            self.push_c()
            self.const(inst.end)
            self.code.call(self.helper("push32"))
            self.check_fault()
            self.set_pc(inst.target)
            return self.return_()
        if op == "BCC":
            self.code.local_get(self.cond_index)
            self.code.i32_eqz()
            self.code.if_()
            self.set_pc(inst.end)
            self.return_()
            self.code.else_()
            self.set_pc(inst.target)
            self.return_()
            self.code.end()
            return
        if op == "DBCC":
            reg = inst.dst.reg
            self.code.local_get(self.cond_index)
            self.code.i32_eqz()
            self.code.if_()
            # low = (d[reg] - 1) & 0xffff; d[reg] = (d[reg] & ~0xffff) | low
            self.load_u32(self.abi.d + reg * 4)
            self.const(1)
            self.code.i32_sub()
            self.const(0xFFFF)
            self.code.i32_and()
            self.ls("low")
            self.push_c()
            self.load_u32(self.abi.d + reg * 4)
            self.const(0xFFFF0000)
            self.code.i32_and()
            self.lg("low")
            self.code.i32_or()
            self.code.i32_store(offset=self.abi.d + reg * 4)
            self.lg("low")
            self.const(0xFFFF)
            self.code.i32_ne()
            self.code.if_()
            self.set_pc(inst.target)
            self.return_()
            self.code.end()
            self.code.end()
            return self.finish()
        if op in ("LEA", "PEA", "JMP", "JSR"):
            self.address(inst.src, "target", 4)
            if op == "LEA":
                self.store_u32(self.abi.a + inst.dst.reg * 4, lambda t: t.lg("target"))
                return self.finish()
            if op == "PEA":
                self.push_c()
                self.lg("target")
                self.code.call(self.helper("push32"))
                self.check_fault()
                return self.finish()
            if op == "JSR":
                self.push_c()
                self.const(inst.end)
                self.code.call(self.helper("push32"))
                self.check_fault()
            self.push_c()
            self.lg("target")
            self.const(0xFFFFFF)
            self.code.i32_and()
            self.code.i32_store(offset=self.abi.pc)
            return self.code.return_()
        if op == "MOVEQ":
            reg = inst.dst.reg
            self.set_field(self.abi.d + reg * 4, inst.value)
            self.push_c()
            self.load_u32(self.abi.d + reg * 4)
            self.const(4)
            self.code.call(self.helper("logic_flags"))
            return self.finish()
        if op in ("ADDQ", "SUBQ") and inst.dst.mode == 1:
            reg = inst.dst.reg
            self.add_to_field(self.abi.a + reg * 4,
                              -inst.value if op == "SUBQ" else inst.value)
            return self.finish()
        if op in ("ADDA", "SUBA", "CMPA"):
            self.prepare(inst.src, "src", size)
            self.read(inst.src, "src", size)
            self.post(inst.src, size)
            dst_off = self.abi.a + inst.dst.reg * 4
            if size == 2:
                source = lambda t: t.sign_extend_expr(lambda x: x.lg("src"), 2)
            else:
                source = lambda t: t.lg("src")
            if op == "CMPA":
                self.push_c()
                self.load_u32(dst_off)
                source(self)
                self.const(4)
                self.const(1)
                self.const(1)
                self.code.call(self.helper("arithmetic"))
                self.code.drop()
            else:
                self.push_c()
                self.load_u32(dst_off)
                source(self)
                self.code.i32_add() if op == "ADDA" else self.code.i32_sub()
                self.code.i32_store(offset=dst_off)
            return self.finish()
        if op == "EXG":
            self.read(inst.src, "src", 4)
            self.read(inst.dst, "dst", 4)
            self.write(inst.src, "src", 4, lambda t: t.lg("dst"))
            self.write(inst.dst, "dst", 4, lambda t: t.lg("src"))
            return self.finish()
        return self._emit_generic()

    def _apply_sr_operator(self, operator: str) -> None:
        # stack currently holds c->sr; append sr op src on top -> value
        self.lg("src")
        if operator == "|":
            self.code.i32_or()
        elif operator == "&":
            self.code.i32_and()
        else:
            self.code.i32_xor()

    def _emit_generic(self) -> None:
        inst = self.inst
        op, size = inst.op, inst.size
        is_shift = op in SHIFT_OPS
        source_size = 4 if is_shift or op in BIT_OPS else size
        if inst.src is not None:
            self.prepare(inst.src, "src", source_size)
            self.read(inst.src, "src", source_size)
            self.post(inst.src, source_size)
        dest_size = 4 if op in MUL_DIV_OPS else size
        self.prepare(inst.dst, "dst", dest_size)
        if op not in ("MOVE", "MOVEA"):
            self.read(inst.dst, "dst", dest_size)

        if op in ("MOVE", "MOVEA"):
            if op == "MOVEA" and size == 2:
                self.sign_extend_expr(lambda t: t.lg("src"), 2)
            else:
                self.lg("src")
            self.ls("result")
        elif op == "CLR":
            self.const(0)
            self.ls("result")
        elif op == "TST":
            self.lg("dst")
            self.ls("result")
        elif op in ("ADDQ", "SUBQ", "ADDI", "SUBI", "CMPI", "ADD", "SUB",
                    "CMP", "NEG"):
            operand = str(inst.value) + "u" if op.endswith("Q") else None
            sub = int(op in ("SUBQ", "SUBI", "CMPI", "SUB", "CMP", "NEG"))
            compare = int(op in ("CMPI", "CMP"))
            self.push_c()
            if op == "NEG":
                self.const(0)
            else:
                self.lg("dst")
            if op == "NEG":
                self.lg("dst")
            elif op is not None and operand is not None:
                self.const(inst.value)
            else:
                self.lg("src")
            self.const(size)
            self.const(sub)
            self.const(compare)
            self.code.call(self.helper("arithmetic"))
            self.ls("result")
        elif op in ("ADDX", "SUBX", "NEGX"):
            self.push_c()
            if op == "NEGX":
                self.const(0)
                self.lg("dst")
            else:
                self.lg("dst")
                self.lg("src")
            self.const(size)
            self.const(int(op != "ADDX"))
            self.code.call(self.helper("extended_arithmetic"))
            self.ls("result")
        elif op in ("ABCD", "SBCD"):
            self.push_c()
            self.lg("dst")
            self.lg("src")
            self.const(int(op != "ABCD"))
            self.code.call(self.helper("bcd_arithmetic"))
            self.ls("result")
        elif op == "NBCD":
            self.push_c()
            self.lg("dst")
            self.code.call(self.helper("bcd_negate"))
            self.ls("result")
        elif op in ("ORI", "ANDI", "EORI", "OR", "AND", "EOR"):
            self.lg("dst")
            self.lg("src")
            if op in ("ORI", "OR"):
                self.code.i32_or()
            elif op in ("ANDI", "AND"):
                self.code.i32_and()
            else:
                self.code.i32_xor()
            self.ls("result")
        elif op == "NOT":
            self.lg("dst")
            self.const(0xFFFFFFFF)
            self.code.i32_xor()
            self.ls("result")
        elif op == "SWAP":
            self.lg("dst")
            self.const(16)
            self.code.i32_shl()
            self.lg("dst")
            self.const(16)
            self.code.i32_shr_u()
            self.code.i32_or()
            self.ls("result")
        elif op == "EXT":
            self.sign_extend_expr(lambda t: t.lg("dst"), 1 if size == 2 else 2)
            self.ls("result")
        elif op == "SCC":
            self.code.local_get(self.cond_index)
            self.code.if_()
            self.const(255)
            self.ls("result")
            self.code.else_()
            self.const(0)
            self.ls("result")
            self.code.end()
        elif op in BIT_OPS:
            # bit = 1u << (src % (size*8))
            self.const(1)
            self.lg("src")
            self.const(size * 8)
            self.code.i32_rem_u()
            self.code.i32_shl()
            self.ls("bit")
            # sr = (sr & ~F_Z) | ((dst & bit) == 0 ? F_Z : 0)
            self.push_c()
            self.load_u16(self.abi.sr)
            self.const(~abi.F_Z)
            self.code.i32_and()
            self.lg("dst")
            self.lg("bit")
            self.code.i32_and()
            self.code.i32_eqz()
            self.const(abi.F_Z)
            self.code.i32_mul()
            self.code.i32_or()
            self.code.i32_store16(offset=self.abi.sr)
            if op == "BTST":
                self.lg("dst")
            elif op == "BCHG":
                self.lg("dst")
                self.lg("bit")
                self.code.i32_xor()
            elif op == "BCLR":
                self.lg("dst")
                self.lg("bit")
                self.const(0xFFFFFFFF)
                self.code.i32_xor()
                self.code.i32_and()
            else:  # BSET
                self.lg("dst")
                self.lg("bit")
                self.code.i32_or()
            self.ls("result")
        elif is_shift:
            self.push_c()
            self.lg("dst")
            self.lg("src")
            self.const(size)
            self.const({"AS": 0, "LS": 1, "ROX": 2, "RO": 3}[op[:-1]])
            self.const(int(op.endswith("L")))
            self.code.call(self.helper("shift_value"))
            self.ls("result")
        elif op in ("MULU", "MULS"):
            if op == "MULS":
                self.sign_extend_expr(lambda t: t.lg("dst"), 2)
                self.sign_extend_expr(lambda t: t.lg("src"), 2)
            else:
                self.lg("dst")
                self.const(0xFFFF)
                self.code.i32_and()
                self.lg("src")
            self.code.i32_mul()
            self.ls("result")
        elif op in ("DIVU", "DIVS"):
            self.push_c()
            self.lg("dst")
            self.lg("src")
            self.const(int(op == "DIVS"))
            self.code.call(self.helper("divide_value"))
            self.ls("result")
            self.check_fault()
        else:
            raise UnsupportedInstruction(
                "unimplemented emission for %s at $%06x" % (op, inst.pc)
            )

        if op not in ("TST", "CMPI", "CMP", "BTST"):
            self.write(inst.dst, "dst", dest_size, lambda t: t.lg("result"))
        self.post(inst.dst, dest_size)
        if op in LOGIC_FLAG_OPS:
            self.push_c()
            self.lg("result")
            self.const(dest_size)
            self.code.call(self.helper("logic_flags"))
        return self.finish()


__all__ = [
    "Translator",
    "Scratch",
    "UnsupportedInstruction",
    "SUPPORTED_OPS",
    "SCRATCH_LOCALS",
    "mask_for",
]

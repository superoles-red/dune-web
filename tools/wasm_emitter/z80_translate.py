"""Translate a statically analysed Z80 program to WASM handlers.

This is the WASM port of the reference C emitter in
``genesis_recompiler/z80.py`` (``z80_instruction_code`` + ``emit_z80``) and of
the runtime semantics in ``genesis_recompiler/z80_runtime.h``:

* every Z80 PC is one ``switch`` case in C; here every 0x400-byte group is one
  exported-through-nothing helper function with a two-level ``br_table``
  (16 chunks x 64 one-byte slots), so odd PCs and self-modifying variants are
  handled exactly like the C ``case`` labels;
* every instruction is a list of *guarded variants*: the bytes at
  ``z80_ram[pc .. pc+len)`` are compared with the compiled image (C:
  ``c->z80_bus.ram[...] == 0x..``); all matching variants are inlined, then
  the C fallback ``fail("Z80 RAM differs...")``;
* instruction semantics call the runtime's exported ``dune_z80_*`` helpers and
  access the ``Z80CPU`` fields directly through the ABI offsets, exactly like
  the C helpers do (no opcode fetch/decode at runtime);
* every path that can set ``c->fault`` returns 0 cycles *without* writing the
  next PC, matching the C emitter's early ``if (c->fault) return 0;``.
* ``translated_z80_step(c) -> i32`` returns the instruction cycles, 0 on fault;
  the caller (``z80_tick``) owns interrupts/debt/PC timing.

The Z80 program is game data derived from the player's ROM at build time (see
``analyze_dune_z80``); nothing here contains game bytes.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from . import abi
from .encoder import Code, Func, I32, Module
from .translate import Scratch, UnsupportedInstruction

# ---------------------------------------------------------------------------
# ABI: the Z80 helper imports of the real runtime.wasm and the Z80CPU layout.
# ---------------------------------------------------------------------------

# Canonical helper names (runtime exports the same names with the ``dune_``
# prefix; the game module imports ``env.dune_z80_*``).  Signatures are the C
# ones from ``genesis_recompiler/z80_runtime.h`` with every integer as i32.
Z80_HELPERS: Tuple[Tuple[str, Tuple[int, ...], Tuple[int, ...]], ...] = (
    ("z80_pair", (I32, I32), (I32,)),
    ("z80_set_pair", (I32, I32, I32), ()),
    ("z80_reg", (I32, I32), (I32,)),
    ("z80_set_reg", (I32, I32, I32), ()),
    ("z80_read", (I32, I32), (I32,)),
    ("z80_write", (I32, I32, I32), ()),
    ("z80_read16", (I32, I32), (I32,)),
    ("z80_write16", (I32, I32, I32), ()),
    ("z80_pop", (I32,), (I32,)),
    ("z80_push", (I32, I32), ()),
    ("z80_m1", (I32, I32), ()),
    ("z80_szxy", (I32,), (I32,)),
    ("z80_alu", (I32, I32, I32), ()),
    ("z80_alu16", (I32, I32, I32), ()),
    ("z80_inc", (I32, I32, I32), (I32,)),
    ("z80_add_pair", (I32, I32, I32), ()),
    ("z80_add_hl", (I32, I32), ()),
    ("z80_condition", (I32, I32), (I32,)),
    ("z80_bit", (I32, I32, I32, I32), ()),
    ("z80_block", (I32, I32, I32), (I32,)),
    ("z80_rotate", (I32, I32, I32), (I32,)),
)
Z80_HELPER_NAMES = tuple(name for name, _, _ in Z80_HELPERS)

# Offsets of the Z80CPU fields *relative to the nested z80_cpu base*.  These
# are fixed by ``genesis_recompiler/z80_cpu_state.h`` (also embedded in
# ``runtime/dune-runtime-v2.c``) and are validated against the runtime ABI
# descriptor (``OFF_Z80_*`` words) by ``validate_z80_layout``.
Z80_LAYOUT: Dict[str, int] = {
    "r8": 0,          # uint8_t r8[6]
    "alternate": 6,   # uint8_t alternate[6]
    "a": 12,
    "f": 13,
    "a_alt": 14,
    "f_alt": 15,
    "i": 16,
    "r": 17,
    "iff1": 18,
    "iff2": 19,
    "im": 20,
    "halted": 21,
    "irq_line": 22,
    "ei_delay": 23,
    "pc": 24,
    "sp": 26,
    "ix": 28,
    "iy": 30,
    "wz": 32,
    "debt": 40,
    "steps": 48,
    "cycles": 56,
    "interrupts": 64,
}
Z80_CPU_SIZE = 72

# Flag bits (same values as ``z80_cpu_state.h`` / runtime.h).
Z_C = 1
Z_N = 2
Z_PV = 4
Z_X = 8
Z_H = 16
Z_Y = 32
Z_Z = 64
Z_S = 128

Z80_RAM_BYTES = 0x2000
Z80_PC_LIMIT = 0x4000
GROUP_SHIFT = 10          # one dispatch group covers 0x400 bytes
GROUP_COUNT = Z80_PC_LIMIT >> GROUP_SHIFT  # 16 groups of 1024 one-byte slots
CHUNK_SHIFT = 6
SLOTS_PER_CHUNK = 1 << CHUNK_SHIFT  # 64
CHUNKS_PER_GROUP = (1 << GROUP_SHIFT) // SLOTS_PER_CHUNK  # 16
SLOTS_PER_GROUP = 1 << GROUP_SHIFT  # 1024
SCRATCH_LOCALS = 14

SUPPORTED_OPS = frozenset(
    (
        "NOP", "HALT", "DI", "EI", "IM",
        "LD16", "INC16", "ADD_HL", "ADD_INDEX", "ALU16",
        "LD8", "LD8_IMM", "INC8", "ROTATE", "ROTATE_A", "NEG", "BIT", "BIT_WRITE",
        "LD_INDEX_MEM", "LD_INDEX_IMM", "INC_INDEX_MEM", "ALU_INDEX_MEM",
        "ALU", "ALU_IMM", "LD_A_PAIR", "LD_A_MEM", "LD_PAIR_MEM", "LD_SP",
        "POP", "POP_INDEX", "PUSH", "PUSH_INDEX",
        "EX_AF", "EXX", "EX_DE_HL", "CPL", "SCF", "CCF",
        "BIT_INDEX", "BIT_INDEX_WRITE", "LD_IR", "LD_BLOCK",
        "JP_REG", "JP", "JP_CC", "JR", "DJNZ", "CALL", "CALL_CC",
        "RET", "RETN", "RET_CC",
    )
)


def validate_z80_layout(abi_desc) -> dict:
    """Check the hard-coded Z80CPU layout against a runtime CpuAbi descriptor.

    ``abi_desc`` is a :class:`wasm_emitter.abi.CpuAbi`; the Z80 fields we need
    (``z80cpu_pc``/``sp``/``cycles``) must agree with ``z80_cpu`` plus our
    relative offsets.  The full struct is additionally checked by the
    integration tests against ``runtime/wasm/abi.json``/manifest.
    """
    checks = {
        "pc": abi_desc.z80cpu_pc == Z80_LAYOUT["pc"],
        "sp": abi_desc.z80cpu_sp == Z80_LAYOUT["sp"],
        "cycles": abi_desc.z80cpu_cycles == Z80_LAYOUT["cycles"],
        "size": abi_desc.z80cpu_size == Z80_CPU_SIZE,
    }
    if not all(checks.values()):
        bad = [name for name, ok in checks.items() if not ok]
        raise abi.AbiError("Z80CPU layout mismatch: %s" % ", ".join(bad))
    return checks


# ---------------------------------------------------------------------------
# Z80 program analysis with the pinned Dune image plan.
# ---------------------------------------------------------------------------

#: ROM offsets of the six Z80 RAM images used by the original desktop build
#: (``tools/build_game_c.py`` / upstream ``tools/build_dune.py``), plus the
#: self-modified overlay/entry/displacement plan.  Offsets only: the bytes come
#: from the player's ROM at build time and never enter the repository.
DUNE_Z80_IMAGES = (
    (0x2C4, 0x2EA),    # 0: boot stub (38 bytes)
    (0x2952, 0x41DC),  # 1: base driver (6282 bytes)
    (0x2952, 0x41DC),  # 2: patched  (image[0x2b3:0x2b8] = 18261826c9)
    (0x2952, 0x41DC),  # 3: music    (image[0x2b7:0x2b9] = d908)
    (0x2952, 0x41DC),  # 4: playing  (image[0x2c4:0x2c6] = 0000, [0x302] = 0)
    (0x2952, 0x41DC),  # 5: voice    (image[0x2cf] = 0)
)
DUNE_Z80_ENTRIES: Tuple[Tuple[int, int], ...] = (
    (2, 0x2B3), (3, 0x2B3), (4, 0x2B3), (5, 0x2B3), (5, 0x2CF),
    (1, 0x38), (2, 0x38), (3, 0x38), (4, 0x38), (5, 0x38),
)
DUNE_Z80_OVERLAYS: Tuple[Tuple[int, bytes], ...] = ((0x0, b"\xe9"),)
DUNE_Z80_MUTABLE_DISPLACEMENTS: Tuple[int, ...] = (0x1616, 0x15F9)


def _genesis_z80_module():
    """Import the pinned ReArrakis ``z80`` module (vendored or local build tree)."""
    import importlib

    try:
        return importlib.import_module("genesis_recompiler.z80")
    except ModuleNotFoundError:
        root = Path(__file__).resolve().parents[2]
        for candidate in (root / ".local" / "recompiler",
                          root / "vendor" / "rearrakis"):
            if candidate.is_dir() and str(candidate) not in sys.path:
                sys.path.insert(0, str(candidate))
        return importlib.import_module("genesis_recompiler.z80")


def dune_z80_images(rom: bytes) -> List[bytes]:
    """Derive the six Z80 analysis images from a verified 1 MiB Dune USA ROM.

    Ported verbatim from ``tools/build_game_c.py::_z80_images`` (which itself
    is the upstream ``tools/build_dune.py`` plan); the only difference is that
    the images stay in memory instead of being written into a build directory.
    """
    if len(rom) < 0x41DC:
        raise ValueError("ROM is too small for the Z80 image plan")
    boot = rom[0x2C4:0x2EA]
    base = rom[0x2952:0x41DC]
    patched = bytearray(base)
    patched[0x2B3:0x2B8] = bytes.fromhex("18261826c9")
    music = bytearray(patched)
    music[0x2B7:0x2B9] = bytes.fromhex("d908")
    playing = bytearray(music)
    playing[0x2C4:0x2C6] = b"\x00\x00"
    playing[0x302] = 0
    voice = bytearray(playing)
    if voice[0x2CF] != 0xC9:
        raise ValueError("unexpected Z80 driver bytes in this ROM")
    voice[0x2CF] = 0
    return [bytes(boot), base, bytes(patched), bytes(music), bytes(playing), bytes(voice)]


def analyze_dune_z80(rom: bytes):
    """Analyse the six pinned Dune Z80 images into a ``z80.ZProgram``.

    This reproduces the reference C emitter's 2577 guarded PCs / 3095 guarded
    instruction variants (2 mutable-displacement sites expand to 256 variants
    each).  The returned program is exactly what ``emit_z80`` translates.
    """
    analyze_z80 = _genesis_z80_module().analyze_z80

    images = dune_z80_images(rom)
    return analyze_z80(
        images,
        (),                          # --z80-entry (none)
        DUNE_Z80_OVERLAYS,           # --z80-overlay 0:e9
        (),                          # --z80-mutable-immediate (none)
        DUNE_Z80_ENTRIES,            # --z80-image-entry ...
        DUNE_Z80_MUTABLE_DISPLACEMENTS,  # --z80-mutable-displacement ...
    )


def z80_program_summary(program) -> dict:
    variants = sum(len(items) for items in program.instructions.values())
    mutable = sum(
        1 for items in program.instructions.values()
        if len(items) == 256
    )
    errors = list(getattr(program, "errors", []) or [])
    return {
        "pcs": len(program.instructions),
        "variants": variants,
        "mutable_expansions": mutable,
        "errors": errors,
        "max_pc": max(program.instructions) if program.instructions else 0,
    }


# ---------------------------------------------------------------------------
# Emission.
# ---------------------------------------------------------------------------

class Z80Translator:
    """Emit the guarded variant bodies for one instruction into a group func."""

    def __init__(self, module: Module, imports: Dict[str, int], abi_desc,
                 memory, fail_code_map: Optional[Dict[int, int]] = None,
                 pc_local: int = 1) -> None:
        self.module = module
        self.imports = imports
        self.abi = abi_desc
        self.memory = memory
        self.fail_code_map = dict(fail_code_map or {})
        self.pc_local = pc_local
        self.func: Optional[Func] = None
        self.code: Optional[Code] = None
        self.scratch: Optional[Scratch] = None
        self.inst = None
        self.fail_codes_used = set()

    # -- primitives --------------------------------------------------------
    def helper(self, name: str) -> int:
        return self.imports[name]

    def c(self) -> "Z80Translator":
        self.code.local_get(0)
        return self

    def pc(self) -> "Z80Translator":
        self.code.local_get(self.pc_local)
        return self

    def const(self, value: int) -> "Z80Translator":
        self.code.i32_const(value & 0xFFFFFFFF)
        return self

    def lg(self, name: str) -> "Z80Translator":
        self.code.local_get(self.scratch.index(name))
        return self

    def ls(self, name: str) -> "Z80Translator":
        self.code.local_set(self.scratch.index(name))
        return self

    # Z80CPU field <-> absolute CPU offset
    def zoff(self, name: str) -> int:
        return self.abi.z80_cpu + Z80_LAYOUT[name]

    # raw byte load/store at an absolute CPU offset (r8/alternate arrays)
    def load8_at(self, offset: int) -> "Z80Translator":
        self.c()
        self.code.i32_load8_u(offset=offset)
        return self

    def store8_at(self, offset: int, expr) -> "Z80Translator":
        self.c()
        expr()
        self.code.i32_store8(offset=offset)
        return self

    def load8(self, name: str) -> "Z80Translator":
        self.c()
        self.code.i32_load8_u(offset=self.zoff(name))
        return self

    def load16(self, name: str) -> "Z80Translator":
        self.c()
        self.code.i32_load16_u(offset=self.zoff(name))
        return self

    def load32(self, name: str) -> "Z80Translator":
        self.c()
        self.code.i32_load(offset=self.zoff(name))
        return self

    def store8(self, name: str, expr) -> "Z80Translator":
        self.c()
        expr()
        self.code.i32_store8(offset=self.zoff(name))
        return self

    def store16(self, name: str, expr) -> "Z80Translator":
        self.c()
        expr()
        self.code.i32_store16(offset=self.zoff(name))
        return self

    def call(self, name: str, *args) -> "Z80Translator":
        """Push c, then every ``args`` entry (callable or int), then call."""
        self.c()
        for arg in args:
            if callable(arg):
                arg()
            else:
                self.const(arg)
        self.code.call(self.helper(name))
        return self

    def next_pc(self, value: int) -> "Z80Translator":
        return self.store16("pc", lambda: self.const(value))

    def ret(self, cycles: int) -> "Z80Translator":
        self.const(cycles)
        self.code.return_()
        return self

    def fault(self) -> "Z80Translator":
        """``if (c->fault) return 0;`` -- never advances PC."""
        self.c()
        self.code.i32_load(offset=self.abi.fault)
        self.code.if_()
        self.const(0)
        self.code.return_()
        self.code.end()
        return self

    def fail(self, canonical: int, address_expr) -> "Z80Translator":
        self.fail_codes_used.add(canonical)
        self.c()
        self.const(self.fail_code_map.get(canonical, canonical))
        address_expr()
        self.code.call(self.helper("fail"))
        return self

    # -- Z80 helpers -------------------------------------------------------
    def pair(self, number: int) -> "Z80Translator":
        return self.call("z80_pair", number)

    def set_pair(self, number: int, expr) -> "Z80Translator":
        return self.call("z80_set_pair", number, expr)

    def reg(self, number: int) -> "Z80Translator":
        return self.call("z80_reg", number)

    def set_reg(self, number: int, expr) -> "Z80Translator":
        return self.call("z80_set_reg", number, expr)

    def read_mem(self, address_expr) -> "Z80Translator":
        return self.call("z80_read", address_expr)

    def write_mem(self, address_expr, value_expr) -> "Z80Translator":
        return self.call("z80_write", address_expr, value_expr)

    def pair_plus(self, number: int, displacement: int) -> "Z80Translator":
        """``(uint16_t)(z80_pair(c, number) + displacement)``."""
        self.pair(number)
        self.const(displacement & 0xFFFF)
        self.code.i32_add()
        self.const(0xFFFF)
        self.code.i32_and()
        return self

    def load_value(self, number: int) -> "Z80Translator":
        """``uint8_t value = z80_reg(c, number); if (fault) return 0;``"""
        self.reg(number)
        self.ls("value")
        return self.fault()

    def set_value_reg(self, number: int) -> "Z80Translator":
        return self.set_reg(number, lambda: self.lg("value"))

    # -- one instruction ---------------------------------------------------
    def emit(self, func: Func, scratch: Scratch, inst) -> None:
        self.func = func
        self.code = func.code
        self.scratch = scratch
        self.inst = inst
        if inst.op not in SUPPORTED_OPS:
            raise UnsupportedInstruction(
                "unsupported Z80 op %s at $%04x" % (inst.op, inst.pc)
            )
        scratch.reset()
        # z80_m1(c, 1 or 2) happens before everything else, exactly like C.
        fetches = 2 if inst.raw[0] in (0xDD, 0xFD, 0xED, 0xCB) else 1
        self.call("z80_m1", fetches)
        getattr(self, "_op_" + inst.op)(inst)
        self.fault()
        self.next_pc(inst.end)
        self.ret(inst.cycles)

    # -- operations --------------------------------------------------------
    def _op_NOP(self, inst):
        pass

    def _op_HALT(self, inst):
        self.store8("halted", lambda: self.const(1))

    def _op_DI(self, inst):
        self.store8("iff1", lambda: self.const(0))
        self.store8("iff2", lambda: self.const(0))
        self.store8("ei_delay", lambda: self.const(0))

    def _op_EI(self, inst):
        self.store8("iff1", lambda: self.const(1))
        self.store8("iff2", lambda: self.const(1))
        self.store8("ei_delay", lambda: self.const(2))

    def _op_IM(self, inst):
        self.store8("im", lambda: self.const(inst.args[0]))

    def _op_LD16(self, inst):
        self.set_pair(inst.args[0], lambda: self.const(inst.args[1]))

    def _op_INC16(self, inst):
        pair, delta = inst.args
        self.set_pair(pair, lambda: self._pair_plus(pair, delta))

    def _pair_plus(self, pair, delta):
        self.pair(pair)
        self.const(delta & 0xFFFF)
        self.code.i32_add()

    def _op_ADD_HL(self, inst):
        self.call("z80_add_hl", lambda: self.pair(inst.args[0]))

    def _op_ADD_INDEX(self, inst):
        self.call("z80_add_pair", inst.args[0], lambda: self.pair(inst.args[1]))

    def _op_ALU16(self, inst):
        self.call("z80_alu16", lambda: self.pair(inst.args[0]), int(inst.args[1]))

    def _op_LD8(self, inst):
        dst, src = inst.args
        self.load_value(src)
        self.set_value_reg(dst)

    def _op_LD8_IMM(self, inst):
        dst, value = inst.args
        self.set_reg(dst, lambda: self.const(value))

    def _op_INC8(self, inst):
        reg, delta = inst.args
        self.load_value(reg)
        self.set_reg(reg, lambda: self.call("z80_inc", lambda: self.lg("value"), delta))

    def _op_ROTATE(self, inst):
        kind, reg = inst.args
        self.load_value(reg)
        self.set_reg(reg, lambda: self.call("z80_rotate", lambda: self.lg("value"), kind))

    def _op_ROTATE_A(self, inst):
        kind = inst.args[0]
        preserved = Z_S | Z_Z | Z_PV
        self.load8("f")
        self.const(preserved)
        self.code.i32_and()
        self.ls("preserved")
        self.store8("a", lambda: self.call("z80_rotate", lambda: self.load8("a"), kind))
        # f = preserved | (f & Z_C) | (a & 0x28)
        self.load8("f")
        self.const(Z_C)
        self.code.i32_and()
        self.lg("preserved")
        self.code.i32_or()
        self.load8("a")
        self.const(0x28)
        self.code.i32_and()
        self.code.i32_or()
        self.ls("newf")
        self.store8("f", lambda: self.lg("newf"))

    def _op_NEG(self, inst):
        self.load8("a")
        self.ls("value")
        self.store8("a", lambda: self.const(0))
        self.call("z80_alu", 2, lambda: self.lg("value"))

    def _op_BIT(self, inst):
        bit, reg = inst.args
        xy = (lambda: self.load16("wz")) if reg == 6 else (lambda: self.lg("value"))
        # BIT (HL) uses the high byte of WZ as X/Y (C: (uint8_t)(z->wz>>8)).
        self.load_value(reg)
        self.call(
            "z80_bit",
            lambda: self.lg("value"),
            bit,
            lambda: self._high8(xy) if reg == 6 else self._low8(xy),
        )

    def _low8(self, expr):
        expr()
        self.const(0xFF)
        self.code.i32_and()

    def _high8(self, expr):
        expr()
        self.const(8)
        self.code.i32_shr_u()
        self.const(0xFF)
        self.code.i32_and()

    def _op_BIT_WRITE(self, inst):
        bit, reg, set_bit = inst.args
        self.load_value(reg)
        if set_bit:
            self.set_reg(reg, lambda: (self.lg("value"), self.const(1 << bit), self.code.i32_or()))
        else:
            self.set_reg(
                reg,
                lambda: (self.lg("value"), self.const(~(1 << bit) & 0xFFFFFFFF), self.code.i32_and()),
            )

    def _op_LD_INDEX_MEM(self, inst):
        pair, disp, dst, src = inst.args
        self.pair_plus(pair, disp)
        self.ls("address")
        self.store16("wz", lambda: self.lg("address"))
        if src == 6:
            self.read_mem(lambda: self.lg("address"))
            self.ls("value")
            self.fault()
        else:
            self.reg(src)
            self.ls("value")
        if dst == 6:
            self.write_mem(lambda: self.lg("address"), lambda: self.lg("value"))
        else:
            self.set_reg(dst, lambda: self.lg("value"))

    def _op_LD_INDEX_IMM(self, inst):
        pair, disp, value = inst.args
        self.pair_plus(pair, disp)
        self.ls("address")
        self.store16("wz", lambda: self.lg("address"))
        self.write_mem(lambda: self.lg("address"), lambda: self.const(value))

    def _op_INC_INDEX_MEM(self, inst):
        pair, disp, delta = inst.args
        self.pair_plus(pair, disp)
        self.ls("address")
        self.store16("wz", lambda: self.lg("address"))
        self.read_mem(lambda: self.lg("address"))
        self.ls("value")
        self.fault()
        self.write_mem(
            lambda: self.lg("address"),
            lambda: self.call("z80_inc", lambda: self.lg("value"), delta),
        )

    def _op_ALU_INDEX_MEM(self, inst):
        pair, disp, kind = inst.args
        self.pair_plus(pair, disp)
        self.ls("address")
        self.store16("wz", lambda: self.lg("address"))
        self.read_mem(lambda: self.lg("address"))
        self.ls("value")
        self.fault()
        self.call("z80_alu", kind, lambda: self.lg("value"))

    def _op_ALU(self, inst):
        kind, reg = inst.args
        self.load_value(reg)
        self.call("z80_alu", kind, lambda: self.lg("value"))

    def _op_ALU_IMM(self, inst):
        kind, value = inst.args
        self.call("z80_alu", kind, value)

    def _op_LD_A_PAIR(self, inst):
        pair, load = inst.args
        self.pair(pair)
        self.ls("address")
        if load:
            # z->a = z80_read(c, z80_pair(c, pair)); if (fault) return 0;
            # z->wz = address + 1;
            self.store8("a", lambda: self.read_mem(lambda: self.pair(pair)))
            # C: z->a = z80_read(...); z->wz = address + 1; -- the common
            # trailing fault check returns before the PC update, but WZ and A
            # are already written, exactly like z80_instruction_code().
            self.store16("wz", lambda: self._address_plus_one())
        else:
            # z80_write(c, z80_pair(c, pair), z->a);
            # z->wz = (z->a << 8) | ((address + 1) & 255);
            self.write_mem(lambda: self.pair(pair), lambda: self.load8("a"))
            self.load8("a")
            self.const(8)
            self.code.i32_shl()
            self.lg("address")
            self.const(1)
            self.code.i32_add()
            self.const(0xFF)
            self.code.i32_and()
            self.code.i32_or()
            self.ls("newf")
            self.store16("wz", lambda: self.lg("newf"))

    def _address_plus_one(self):
        self.lg("address")
        self.const(1)
        self.code.i32_add()
        self.const(0xFFFF)
        self.code.i32_and()

    def _op_LD_A_MEM(self, inst):
        address, load = inst.args
        if load:
            self.read_mem(lambda: self.const(address))
            self.ls("value")
            self.store8("a", lambda: self.lg("value"))
            self.store16("wz", lambda: self.const((address + 1) & 0xFFFF))
        else:
            self.write_mem(lambda: self.const(address), lambda: self.load8("a"))
            self.load8("a")
            self.const(8)
            self.code.i32_shl()
            self.const((address + 1) & 0xFF)
            self.code.i32_or()
            self.ls("newf")
            self.store16("wz", lambda: self.lg("newf"))

    def _op_LD_PAIR_MEM(self, inst):
        pair, address, load = inst.args
        if load:
            self.call("z80_read16", address)
            self.ls("value")
            # z80_read16() returns 0 with c->fault set; the pair and WZ are
            # still written before the common trailing fault check.
            self.set_pair(pair, lambda: self.lg("value"))
        else:
            self.call("z80_write16", address, lambda: self.pair(pair))
        self.store16("wz", lambda: self.const((address + 1) & 0xFFFF))

    def _op_LD_SP(self, inst):
        self.store16("sp", lambda: self.pair(inst.args[0]))

    def _pop_pair(self, pair, index=False):
        self.call("z80_pop")
        self.ls("value")
        self.fault()
        self.set_pair(pair, lambda: self.lg("value"))

    def _op_POP(self, inst):
        pair = 6 if inst.args[0] == 3 else inst.args[0]
        self._pop_pair(pair)

    def _op_POP_INDEX(self, inst):
        self._pop_pair(inst.args[0])

    def _push_pair(self, pair, index=False):
        self.call("z80_push", lambda: self.pair(pair))

    def _op_PUSH(self, inst):
        pair = 6 if inst.args[0] == 3 else inst.args[0]
        self._push_pair(pair)

    def _op_PUSH_INDEX(self, inst):
        self._push_pair(inst.args[0])

    def _op_EX_AF(self, inst):
        self.load8("a")
        self.ls("t")
        self.store8("a", lambda: self.load8("a_alt"))
        self.store8("a_alt", lambda: self.lg("t"))
        self.load8("f")
        self.ls("t")
        self.store8("f", lambda: self.load8("f_alt"))
        self.store8("f_alt", lambda: self.lg("t"))

    def _op_EXX(self, inst):
        for n in range(6):
            self.load8_at(self.zoff("r8") + n)
            self.ls("t")
            self.load8_at(self.zoff("alternate") + n)
            self.ls("u")
            self.store8_at(self.zoff("r8") + n, lambda: self.lg("u"))
            self.store8_at(self.zoff("alternate") + n, lambda: self.lg("t"))

    def _op_EX_DE_HL(self, inst):
        self.pair(1)
        self.ls("t")
        self.pair(2)
        self.ls("t2")
        self.set_pair(1, lambda: self.lg("t2"))
        self.set_pair(2, lambda: self.lg("t"))

    def _op_CPL(self, inst):
        self.load8("a")
        self.const(0xFF)
        self.code.i32_xor()
        self.ls("value")
        self.store8("a", lambda: self.lg("value"))
        # f = (f & (S|Z|PV|C)) | (a & 0x28) | H | N
        self.load8("f")
        self.const(Z_S | Z_Z | Z_PV | Z_C)
        self.code.i32_and()
        self.lg("value")
        self.const(0x28)
        self.code.i32_and()
        self.code.i32_or()
        self.const(Z_H | Z_N)
        self.code.i32_or()
        self.ls("newf")
        self.store8("f", lambda: self.lg("newf"))

    def _op_SCF(self, inst):
        self._scf_ccf(Z_C)

    def _op_CCF(self, inst):
        # carry = (f & Z_C) ? Z_H : Z_C  (store it: if/else blocks cannot carry
        # a result value in this MVP encoder)
        self.load8("f")
        self.const(Z_C)
        self.code.i32_and()
        self.code.if_()
        self.const(Z_H)
        self.ls("carry")
        self.code.else_()
        self.const(Z_C)
        self.ls("carry")
        self.code.end()
        self._scf_ccf_expr()

    def _scf_ccf(self, carry):
        self.const(carry)
        self.ls("carry")
        self._scf_ccf_expr()

    def _scf_ccf_expr(self):
        # stack: carry bit value already stored in scratch "carry"
        self.load8("f")
        self.const(Z_S | Z_Z | Z_PV)
        self.code.i32_and()
        self.load8("a")
        self.const(0x28)
        self.code.i32_and()
        self.code.i32_or()
        self.lg("carry")
        self.code.i32_or()
        self.ls("newf")
        self.store8("f", lambda: self.lg("newf"))

    def _op_BIT_INDEX(self, inst):
        pair, disp, bit = inst.args
        self.pair_plus(pair, disp)
        self.ls("address")
        self.store16("wz", lambda: self.lg("address"))
        self.read_mem(lambda: self.lg("address"))
        self.ls("value")
        self.fault()
        self.load16("wz")
        self.const(8)
        self.code.i32_shr_u()
        self.const(0xFF)
        self.code.i32_and()
        self.ls("xy")
        self.call("z80_bit", lambda: self.lg("value"), bit, lambda: self.lg("xy"))

    def _op_BIT_INDEX_WRITE(self, inst):
        pair, disp, bit, reg, set_bit = inst.args
        self.pair_plus(pair, disp)
        self.ls("address")
        self.store16("wz", lambda: self.lg("address"))
        self.read_mem(lambda: self.lg("address"))
        self.ls("value")
        self.fault()
        if set_bit:
            self.lg("value")
            self.const(1 << bit)
            self.code.i32_or()
        else:
            self.lg("value")
            self.const(~(1 << bit) & 0xFFFFFFFF)
            self.code.i32_and()
        self.ls("value")
        self.write_mem(lambda: self.lg("address"), lambda: self.lg("value"))
        if reg != 6:
            self.set_reg(reg, lambda: self.lg("value"))

    def _op_LD_IR(self, inst):
        member, load = inst.args
        field = "r" if member else "i"
        if load:
            self.load8(field)
            self.ls("value")
            # f = (f & Z_C) | (szxy(a) & ~Z_PV) | (iff2 ? Z_PV : 0)
            self.call("z80_szxy", lambda: self.load8("a"))
            self.const(~Z_PV & 0xFFFFFFFF)
            self.code.i32_and()
            self.load8("f")
            self.const(Z_C)
            self.code.i32_and()
            self.code.i32_or()
            self.load8("iff2")
            self.const(Z_PV)
            self.code.i32_mul()
            self.code.i32_or()
            self.ls("newf")
            self.store8("f", lambda: self.lg("newf"))
            self.store8("a", lambda: self.lg("value"))
        else:
            self.store8(field, lambda: self.load8("a"))

    def _op_LD_BLOCK(self, inst):
        direction, repeat = inst.args
        self.call("z80_block", direction, int(repeat))
        self.code.if_()
        self.fault()
        self.store16("wz", lambda: self.const((inst.pc + 1) & 0xFFFF))
        self.next_pc(inst.pc)
        self.ret(21)
        self.code.end()

    def _op_JP_REG(self, inst):
        self.store16("pc", lambda: self.pair(inst.args[0]))
        self.ret(inst.cycles)

    def _op_JP(self, inst):
        target = inst.args[0]
        self.store16("wz", lambda: self.const(target))
        self.store16("pc", lambda: self.const(target))
        self.ret(10)

    def _op_JP_CC(self, inst):
        condition, target = inst.args
        self.store16("wz", lambda: self.const(target))
        self.call("z80_condition", condition)
        self.code.if_()
        self.next_pc(target)
        self.code.else_()
        self.next_pc(inst.end)
        self.code.end()
        self.ret(10)

    def _op_JR(self, inst):
        condition, target = inst.args
        if condition == -1:
            self.store16("wz", lambda: self.const(target))
            self.next_pc(target)
            self.ret(12)
            return
        self.call("z80_condition", condition)
        self.code.if_()
        self.store16("wz", lambda: self.const(target))
        self.next_pc(target)
        self.ret(12)
        self.code.else_()
        self.next_pc(inst.end)
        self.ret(7)
        self.code.end()

    def _op_DJNZ(self, inst):
        target = inst.args[0]
        # if (--z->r8[0]) { wz=pc=target; return 13; } pc=end; return 8;
        self.c()
        self.code.i32_load8_u(offset=self.zoff("r8"))
        self.const(1)
        self.code.i32_sub()
        self.const(0xFF)
        self.code.i32_and()
        self.ls("t")
        self.c()
        self.lg("t")
        self.code.i32_store8(offset=self.zoff("r8"))
        self.lg("t")
        self.code.if_()
        self.store16("wz", lambda: self.const(target))
        self.next_pc(target)
        self.ret(13)
        self.code.else_()
        self.next_pc(inst.end)
        self.ret(8)
        self.code.end()

    def _op_CALL(self, inst):
        target = inst.args[0]
        self.call("z80_push", inst.end)
        self.fault()
        self.store16("wz", lambda: self.const(target))
        self.next_pc(target)
        self.ret(inst.cycles)

    def _op_CALL_CC(self, inst):
        condition, target = inst.args
        self.store16("wz", lambda: self.const(target))
        self.call("z80_condition", condition)
        self.code.if_()
        self.call("z80_push", inst.end)
        self.fault()
        self.next_pc(target)
        self.ret(17)
        self.code.else_()
        self.next_pc(inst.end)
        self.ret(10)
        self.code.end()

    def _op_RET(self, inst):
        self.call("z80_pop")
        self.ls("target")
        self.fault()
        self.store16("wz", lambda: self.lg("target"))
        self.next_pc_expr(lambda: self.lg("target"))
        self.ret(inst.cycles)

    def _op_RETN(self, inst):
        self.call("z80_pop")
        self.ls("target")
        self.store8("iff1", lambda: self.load8("iff2"))
        self.fault()
        self.store16("wz", lambda: self.lg("target"))
        self.next_pc_expr(lambda: self.lg("target"))
        self.ret(inst.cycles)

    def next_pc_expr(self, expr) -> "Z80Translator":
        return self.store16("pc", expr)

    def _op_RET_CC(self, inst):
        condition = inst.args[0]
        self.call("z80_condition", condition)
        self.code.if_()
        self.call("z80_pop")
        self.ls("target")
        self.fault()
        self.store16("wz", lambda: self.lg("target"))
        self.next_pc_expr(lambda: self.lg("target"))
        self.ret(11)
        self.code.else_()
        self.next_pc(inst.end)
        self.ret(5)
        self.code.end()


# ---------------------------------------------------------------------------
# Module wiring (called from game_module.ModuleBuilder).
# ---------------------------------------------------------------------------

def emit_z80(builder, program) -> Tuple[Func, set]:
    """Append ``translated_z80_step`` (and its group functions) to ``builder``.

    ``builder`` is a :class:`game_module.ModuleBuilder` with the Z80 helper
    imports already declared (``builder.import_z80_helpers()``).  Returns the
    exported ``(i32 c) -> i32`` function.
    """
    module: Module = builder.module
    translator = Z80Translator(
        module, builder.imports, builder.abi, builder.memory,
        fail_code_map=builder.fail_code_map,
    )

    # Group functions: (c, pc) -> cycles.  Only groups with instructions exist.
    groups: Dict[int, Dict[int, List]] = {}
    for pc, variants in program.instructions.items():
        if not 0 <= pc < Z80_PC_LIMIT:
            raise UnsupportedInstruction(
                "Z80 PC $%04x is outside the 16 KiB RAM/mirror window" % pc
            )
        for inst in variants:
            if not 0 <= inst.pc < Z80_PC_LIMIT:
                raise UnsupportedInstruction(
                    "Z80 PC $%04x is outside the 16 KiB RAM/mirror window" % inst.pc
                )
        groups.setdefault(pc >> GROUP_SHIFT, {})[pc] = variants

    group_funcs: Dict[int, Func] = {}
    for group in sorted(groups):
        func = module.declare_func([I32, I32], [I32])
        group_funcs[group] = func
        _emit_group(translator, func, groups[group])

    # Dispatcher: translated_z80_step(c) -> i32
    step = module.declare_func([I32], [I32])
    code = step.code
    step.locals = [I32]
    pc_local = 1
    code.local_get(0)
    code.i32_load16_u(offset=builder.abi.z80_cpu + Z80_LAYOUT["pc"])
    code.local_set(pc_local)
    # if (pc >= 0x4000) -> fail("Z80 PC has no static translation")
    code.local_get(pc_local)
    code.i32_const(Z80_PC_LIMIT)
    code.i32_ge_u()
    code.if_()
    _emit_fail(translator, code, abi.FAIL_Z80,
               lambda: (code.local_get(pc_local), code.i32_const(0x1FFF),
                        code.i32_and(), code.i32_const(0xA00000), code.i32_add()))
    code.i32_const(0)
    code.return_()
    code.end()
    _emit_dispatch(
        code,
        lambda: code.local_get(pc_local),
        GROUP_SHIFT,
        GROUP_COUNT,
        {group: (lambda func=group_funcs[group]: _call_group(code, func, pc_local))
         for group in group_funcs},
        lambda: _emit_fail(translator, code, abi.FAIL_Z80, lambda: code.local_get(pc_local)),
    )
    return step, set(translator.fail_codes_used)


def _call_group(code: Code, func: Func, pc_local: int) -> None:
    code.local_get(0)
    code.local_get(pc_local)
    code.call(func.index)


def _emit_fail(translator: Z80Translator, code: Code, canonical: int, address_expr) -> None:
    translator.fail_codes_used.add(canonical)
    code.local_get(0)
    code.i32_const(translator.fail_code_map.get(canonical, canonical))
    address_expr()
    code.call(translator.helper("fail"))


def _emit_dispatch(code: Code, key_expr, shift: int, count: int,
                   bodies: Dict[int, object], fail_expr) -> None:
    """Two-level ``br_table`` over groups 0..count-1 (helper for the top level)."""
    for _ in range(count + 1):
        code.block()
    key_expr()
    if shift:
        code.i32_const(shift)
        code.i32_shr_u()
    entries = [group if group in bodies else count for group in range(count)]
    code.br_table(entries, count)
    for group in range(count):
        code.end()
        if group in bodies:
            bodies[group]()
            code.return_()
    code.end()  # default block
    fail_expr()
    code.i32_const(0)
    code.return_()


def _emit_group(translator: Z80Translator, func: Func, handlers: Dict[int, List]) -> None:
    code = func.code
    scratch = Scratch(func, 2 + SCRATCH_LOCALS)
    slot = scratch.index("slot")
    pc_local = 1
    code.local_get(pc_local)
    code.i32_const((1 << GROUP_SHIFT) - 1)
    code.i32_and()
    code.local_set(slot)
    chunks: Dict[int, Dict[int, List]] = {}
    for pc, variants in handlers.items():
        index = pc & ((1 << GROUP_SHIFT) - 1)
        chunks.setdefault(index >> CHUNK_SHIFT, {})[index & (SLOTS_PER_CHUNK - 1)] = variants

    for _ in range(CHUNKS_PER_GROUP + 1):
        code.block()
    code.local_get(slot)
    code.i32_const(CHUNK_SHIFT)
    code.i32_shr_u()
    entries = [
        chunk if chunk in chunks else CHUNKS_PER_GROUP
        for chunk in range(CHUNKS_PER_GROUP)
    ]
    code.br_table(entries, CHUNKS_PER_GROUP)
    for chunk in range(CHUNKS_PER_GROUP):
        code.end()
        if chunk not in chunks:
            continue
        _emit_chunk(translator, func, scratch, code, slot, chunks[chunk])
    code.end()
    _emit_fail(translator, code, abi.FAIL_Z80,
               lambda: (code.local_get(pc_local), code.i32_const(0x1FFF), code.i32_and(),
                        code.i32_const(0xA00000), code.i32_add()))
    code.i32_const(0)
    code.return_()


def _emit_chunk(translator: Z80Translator, func: Func, scratch: Scratch, code: Code,
                slot_local: int, handlers: Dict[int, List]) -> None:
    for _ in range(SLOTS_PER_CHUNK + 1):
        code.block()
    code.local_get(slot_local)
    code.i32_const(SLOTS_PER_CHUNK - 1)
    code.i32_and()
    entries = [inner if inner in handlers else SLOTS_PER_CHUNK
               for inner in range(SLOTS_PER_CHUNK)]
    code.br_table(entries, SLOTS_PER_CHUNK)
    for inner in range(SLOTS_PER_CHUNK):
        code.end()
        variants = handlers.get(inner)
        if variants is not None:
            _emit_guarded(translator, func, scratch, code, variants)
    code.end()
    pc_local = 1
    _emit_fail(translator, code, abi.FAIL_Z80,
               lambda: (code.local_get(pc_local), code.i32_const(0x1FFF), code.i32_and(),
                        code.i32_const(0xA00000), code.i32_add()))
    code.i32_const(0)
    code.return_()


def _emit_guarded(translator: Z80Translator, func: Func, scratch: Scratch, code: Code,
                  variants: List) -> None:
    """Inline every matching variant behind its RAM byte guards (C ``memcmp``)."""
    for variant in variants:
        raw = variant.raw
        if not raw:
            raise UnsupportedInstruction("empty Z80 variant at $%04x" % variant.pc)
        scratch.reset()
        # addr = z80_ram + (pc & 0x1fff)
        code.local_get(1)
        code.i32_const(0x1FFF)
        code.i32_and()
        code.i32_const(translator.memory.z80_ram)
        code.i32_add()
        addr = scratch.index("addr")
        code.local_set(addr)
        for index, byte in enumerate(raw):
            code.local_get(addr)
            code.i32_load8_u(offset=index)
            code.i32_const(byte)
            code.i32_eq()
            if index:
                code.i32_and()
        code.if_()
        translator.emit(func, scratch, variant)
        code.end()
    scratch.reset()
    _emit_fail(translator, code, abi.FAIL_Z80,
               lambda: (code.local_get(1), code.i32_const(0x1FFF), code.i32_and(),
                        code.i32_const(0xA00000), code.i32_add()))
    code.i32_const(0)
    code.return_()


__all__ = [
    "Z80_HELPERS",
    "Z80_HELPER_NAMES",
    "Z80_LAYOUT",
    "validate_z80_layout",
    "analyze_dune_z80",
    "dune_z80_images",
    "z80_program_summary",
    "Z80Translator",
    "emit_z80",
    "SUPPORTED_OPS",
]

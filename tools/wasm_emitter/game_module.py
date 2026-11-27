"""Assemble a complete ``game.wasm`` module for real decoded 68000 pages.

The module follows ``docs/WASM-BACKEND.md`` §4-§6:

* it imports the shared linear memory and the 16 runtime helpers, and owns no
  memory/data segments of its own (RAM variants embed only the few image bytes
  they guard, exactly like the C emitter's ``memcmp`` against ROM);
* every 4 KiB page is one function with a two-level ``br_table`` over 32 chunks
  x 64 slots; the handler body is inlined between the blocks;
* ``translated_step`` validates PC, then dispatches ROM pages 0x00..0xFF with a
  16x16 ``br_table`` and RAM pages 0xFF0..0xFFF with a 16-entry table;
* ``translated_step_via_table`` calls the same function through the exported
  funcref table (the production runtime -> game direction);
* ``warmup_all`` calls every page function with ``pc = 0xFFFFFFFE`` so V8/Liftoff
  compiles them under the loading screen.

No global state, no data segments, no ROM: all state lives in the runtime CPU.
"""

from __future__ import annotations

import hashlib
import time
from typing import Dict, Iterable, List, Optional, Set, Tuple

from . import abi
from .encoder import Code, Func, I32, Module
from .translate import SCRATCH_LOCALS, Scratch, Translator, UnsupportedInstruction

PAGE_SHIFT = 12
PAGE_SIZE = 1 << PAGE_SHIFT
SLOT_SHIFT = 1
SLOTS_PER_PAGE = PAGE_SIZE >> SLOT_SHIFT  # 2048
CHUNK_SHIFT = 6
SLOTS_PER_CHUNK = 1 << CHUNK_SHIFT  # 64
CHUNKS_PER_PAGE = SLOTS_PER_PAGE // SLOTS_PER_CHUNK  # 32
PAGE_GROUP_SHIFT = 4
PAGE_GROUPS = 16
PAGES_PER_GROUP = 16
RAM_PAGE_BASE = 0xFF0
RAM_PAGE_COUNT = 16
WARMUP_PC = 0xFFFFFFFE


def slot_of(pc: int) -> int:
    return (pc & (PAGE_SIZE - 1)) >> SLOT_SHIFT


def page_of(pc: int) -> int:
    return pc >> PAGE_SHIFT


def _public_instructions(program, instructions: Optional[Iterable]) -> List:
    if instructions is None:
        return sorted(program.instructions.values(), key=lambda inst: inst.pc)
    return sorted(instructions, key=lambda inst: inst.pc)


def _page_handlers(program, instructions: Iterable) -> Dict[int, Dict[int, object]]:
    handlers: Dict[int, Dict[int, object]] = {}
    for inst in instructions:
        page = page_of(inst.pc)
        if 0x100 <= page < RAM_PAGE_BASE:
            raise UnsupportedInstruction(
                "PC $%06x is outside the ROM and RAM dispatch regions" % inst.pc
            )
        handlers.setdefault(page, {})[slot_of(inst.pc)] = inst
    return handlers


class ModuleBuilder:
    def __init__(self, abi_desc: abi.CpuAbi, memory: abi.MemoryLayout,
                 rom: bytes = b"", helper_prefix: str = "",
                 fail_code_map: Optional[Dict[int, int]] = None) -> None:
        self.abi = abi_desc
        self.memory = memory
        self.rom = rom
        # Import names: "" for the native/JS-stub target (``env.read_mem``),
        # "dune_" for the real runtime.wasm (``env.dune_read_mem``).  The
        # canonical helper names stay the keys of ``self.imports``; only the
        # wasm import field name changes.
        self.helper_prefix = helper_prefix
        self.fail_code_map = dict(fail_code_map or {})
        self.module = Module()
        self.imports: Dict[str, int] = {}
        for name, params, results in abi.HELPERS:
            self.imports[name] = self.module.import_func(
                "env", helper_prefix + name, list(params), list(results)
            )
        self.module.import_memory("env", "memory", 1)
        self.step_type = self.module.add_type([I32], [])
        self.page_funcs: Dict[int, Func] = {}
        self.translator = Translator(self.module, self.imports, abi_desc, rom,
                                     fail_code_map=self.fail_code_map)
        self.fail_codes_used: Set[int] = set()

    # -- page bodies -------------------------------------------------------
    def page_function(self, page: int) -> Func:
        func = self.module.declare_func([I32, I32], [])
        self.page_funcs[page] = func
        return func

    def emit_page(self, page: int, handlers: Dict[int, object]) -> None:
        func = self.page_function(page)
        scratch = Scratch(func, SCRATCH_LOCALS)
        func.locals.append(I32)  # slot
        slot_local = func.local(SCRATCH_LOCALS)
        code = func.code
        # Warmup probe: if (pc == 0xFFFFFFFE) return;
        code.local_get(1)
        code.i32_const(WARMUP_PC)
        code.i32_eq()
        code.if_()
        code.return_()
        code.end()
        # slot = (pc & 0xfff) >> 1
        code.local_get(1)
        code.i32_const(PAGE_SIZE - 1)
        code.i32_and()
        code.i32_const(SLOT_SHIFT)
        code.i32_shr_u()
        code.local_set(slot_local)
        chunks: Dict[int, Dict[int, object]] = {}
        for slot, inst in handlers.items():
            chunks.setdefault(slot >> CHUNK_SHIFT, {})[slot & (SLOTS_PER_CHUNK - 1)] = inst
        # Level 1: block $out, block $chunk31..$chunk0 (inner-most last).
        for _ in range(CHUNKS_PER_PAGE + 1):
            code.block()
        code.local_get(slot_local)
        code.i32_const(CHUNK_SHIFT)
        code.i32_shr_u()
        entries = [
            chunk if chunk in chunks else CHUNKS_PER_PAGE
            for chunk in range(CHUNKS_PER_PAGE)
        ]
        code.br_table(entries, CHUNKS_PER_PAGE)
        for chunk in range(CHUNKS_PER_PAGE):
            code.end()  # closes block $chunk<chunk>; chunk body starts here
            if chunk not in chunks:
                continue
            self.emit_chunk(func, scratch, code, slot_local, handlers, chunk, chunks[chunk])
        code.end()  # $out
        self.fail(code, abi.FAIL_UNTRANSLATED)
        code.return_()

    def emit_chunk(self, func: Func, scratch: Scratch, code: Code, slot_local: int,
                   all_handlers: Dict[int, object], chunk: int,
                   handlers: Dict[int, object]) -> None:
        for _ in range(SLOTS_PER_CHUNK + 1):  # $out2 + $s63..$s0
            code.block()
        code.local_get(slot_local)
        code.i32_const(SLOTS_PER_CHUNK - 1)
        code.i32_and()
        entries = [
            inner if inner in handlers else SLOTS_PER_CHUNK
            for inner in range(SLOTS_PER_CHUNK)
        ]
        code.br_table(entries, SLOTS_PER_CHUNK)
        for inner in range(SLOTS_PER_CHUNK):
            code.end()  # closes $s<inner>
            inst = handlers.get(inner)
            if inst is not None:
                self.emit_handler(func, scratch, inst)
        code.end()  # $out2
        self.fail(code, abi.FAIL_UNTRANSLATED)
        code.return_()

    def emit_handler(self, func: Func, scratch: Scratch, inst) -> None:
        variants = getattr(self, "variants", {}).get(inst.pc, [])
        if not variants:
            self.translator.emit(func, scratch, inst)
            return
        # C emitter wraps the handler in memcmp(c->ram + (pc&0xffff), compiled
        # image, n) checks; every matching variant gets its own inlined body.
        for variant in variants:
            if getattr(variant, "mutable_address", False):
                raise UnsupportedInstruction(
                    "RAM variant at $%06x uses a mutable absolute address "
                    "(not implemented)" % inst.pc
                )
            self.emit_variant_guard(func, scratch, inst, variant)
            self.translator.emit(func, scratch, variant.instruction)
        self.fail(func.code, abi.FAIL_RAM_VARIANT)
        func.code.return_()

    def emit_variant_guard(self, func: Func, scratch: Scratch, inst, variant) -> None:
        code = func.code
        image = variant.image
        operation = variant.instruction
        offset = image.rom_offset + operation.pc - image.address
        raw = operation.raw
        spans = ((0, 2), (6, len(raw) - 6)) if getattr(variant, "mutable_address", False) else ((0, len(raw)),)
        # address = ram_addr + (pc & 0xffff)
        code.local_get(1)
        code.i32_const(0xFFFF)
        code.i32_and()
        code.i32_const(self.memory.ram)
        code.i32_add()
        scratch.reset()
        scratch.index("variant_addr")
        code.local_set(scratch.index("variant_addr"))
        checks = 0
        for start, length in spans:
            if length <= 0:
                continue
            for index in range(length):
                pos = offset + start + index
                if pos < 0 or pos + 1 > len(self.rom):
                    raise UnsupportedInstruction(
                        "RAM variant image outside ROM at $%06x" % inst.pc
                    )
                code.local_get(scratch.index("variant_addr"))
                code.i32_load8_u(offset=start + index)
                code.i32_const(self.rom[pos])
                code.i32_eq()
                if checks:
                    code.i32_and()
                checks += 1
        if not checks:
            raise UnsupportedInstruction("empty RAM variant guard at $%06x" % inst.pc)
        code.if_()

    # -- dispatch ----------------------------------------------------------
    def emit_step(self) -> Func:
        func = self.module.declare_func([I32], [])
        code = func.code
        func.locals = [I32, I32]  # pc, page
        pc_local, page_local = 1, 2
        # pc = c->pc
        code.local_get(0)
        code.i32_load(offset=self.abi.pc)
        code.local_set(pc_local)
        # if (pc >= 0x1000000) fail(FAIL_BAD_PC)
        code.local_get(pc_local)
        code.i32_const(0x1000000)
        code.i32_ge_u()
        code.if_()
        self.fail_with_pc(code, abi.FAIL_BAD_PC, pc_local)
        code.return_()
        code.end()
        # if (pc & 1) fail(FAIL_ODD_PC)
        code.local_get(pc_local)
        code.i32_const(1)
        code.i32_and()
        code.if_()
        self.fail_with_pc(code, abi.FAIL_ODD_PC, pc_local)
        code.return_()
        code.end()
        code.local_get(pc_local)
        code.i32_const(PAGE_SHIFT)
        code.i32_shr_u()
        code.local_set(page_local)
        code.local_get(page_local)
        code.i32_const(0x100)
        code.i32_lt_u()
        code.if_()
        self.emit_region(code, page_local, pc_local, self.rom_pages(), 0,
                         PAGE_GROUPS, PAGES_PER_GROUP, PAGE_GROUP_SHIFT, 0xF)
        code.else_()
        code.local_get(page_local)
        code.i32_const(RAM_PAGE_BASE)
        code.i32_ge_u()
        code.if_()
        self.emit_region(code, page_local, pc_local, self.ram_pages(), RAM_PAGE_BASE,
                         1, RAM_PAGE_COUNT, None, 0xF)
        code.else_()
        self.fail(code, abi.FAIL_UNMAPPED)
        code.return_()
        code.end()
        code.end()
        return func

    def rom_pages(self) -> Dict[int, Func]:
        return {page: func for page, func in self.page_funcs.items() if page < 0x100}

    def ram_pages(self) -> Dict[int, Func]:
        return {page: func for page, func in self.page_funcs.items() if page >= RAM_PAGE_BASE}

    def emit_region(self, code: Code, page_local: int, pc_local: int,
                    page_funcs: Dict[int, Func], base: int, groups: int,
                    per_group: int, group_shift: Optional[int], inner_mask: int) -> None:
        for _ in range(groups + 1):
            code.block()
        if group_shift is not None:
            code.local_get(page_local)
            code.i32_const(group_shift)
            code.i32_shr_u()
        else:
            code.local_get(page_local)
            code.i32_const(base)
            code.i32_sub()
        entries = []
        present_groups = []
        for group in range(groups):
            present = any(
                (base + group * per_group + inner) in page_funcs
                for inner in range(per_group)
            )
            present_groups.append(present)
            entries.append(group if present else groups)
        code.br_table(entries, groups)
        for group in range(groups):
            code.end()
            if not present_groups[group]:
                continue
            for _ in range(per_group + 1):
                code.block()
            code.local_get(page_local)
            code.i32_const(inner_mask)
            code.i32_and()
            inner_entries = []
            for inner in range(per_group):
                page = base + group * per_group + inner
                inner_entries.append(inner if page in page_funcs else per_group)
            code.br_table(inner_entries, per_group)
            for inner in range(per_group):
                code.end()
                page = base + group * per_group + inner
                if page in page_funcs:
                    code.local_get(0)
                    code.local_get(pc_local)
                    code.call(page_funcs[page].index)
                    code.return_()
            code.end()  # inner default
            self.fail(code, abi.FAIL_UNTRANSLATED)
            code.return_()
        code.end()  # outer default
        self.fail(code, abi.FAIL_UNTRANSLATED)
        code.return_()

    def emitted_fail_code(self, fail_code: int) -> int:
        """Canonical fail code -> the code of the runtime that runs the module."""
        self.fail_codes_used.add(fail_code)
        return self.fail_code_map.get(fail_code, fail_code)

    def fail(self, code: Code, fail_code: int) -> None:
        code.local_get(0)
        code.i32_const(self.emitted_fail_code(fail_code))
        code.local_get(0)
        code.i32_load(offset=self.abi.pc)
        code.call(self.imports["fail"])

    def fail_with_pc(self, code: Code, fail_code: int, pc_local: int) -> None:
        code.local_get(0)
        code.i32_const(self.emitted_fail_code(fail_code))
        code.local_get(pc_local)
        code.call(self.imports["fail"])

    # -- whole module ------------------------------------------------------
    def emit_extras(self) -> Tuple[Func, Func, Func]:
        step = self.emit_step()
        # warmup_all(c): every page function with the magic PC
        warmup = self.module.declare_func([I32], [])
        wcode = warmup.code
        for page in sorted(self.page_funcs):
            wcode.local_get(0)
            wcode.i32_const(WARMUP_PC)
            wcode.call(self.page_funcs[page].index)
        wcode.return_()
        # translated_step_via_table(c): call_indirect through slot 0
        via = self.module.declare_func([I32], [])
        vcode = via.code
        vcode.local_get(0)
        vcode.i32_const(0)
        vcode.call_indirect(self.step_type, 0)
        vcode.return_()
        return step, warmup, via

    def emit_z80_stub(self) -> Func:
        """``translated_z80_step(c) -> i32``: honest UNTRANSLATED stub.

        Z80 translation is out of scope for the 68000 full module.  The runtime
        installs this export as the single-dispatcher z80 slot (``table[1]``) and
        calls it only when the Z80 scheduler is active.  It reports the canonical
        UNTRANSLATED failure at the Z80 PC and returns 0 cycles, exactly like the
        runtime's own "no z80 handler" path -- never a fake success.
        """
        func = self.module.declare_func([I32], [I32])
        code = func.code
        code.local_get(0)
        code.i32_const(self.emitted_fail_code(abi.FAIL_UNTRANSLATED))
        code.local_get(0)
        code.i32_load(offset=self.abi.z80_cpu + self.abi.z80cpu_pc)
        code.call(self.imports["fail"])
        code.i32_const(0)
        code.return_()
        return func

    def build(self, handlers_by_page: Dict[int, Dict[int, object]],
              variants: Optional[Dict[int, list]] = None,
              z80_stub: bool = False) -> Tuple[bytes, dict]:
        started = time.perf_counter()
        self.variants = variants or {}
        for page in sorted(handlers_by_page):
            self.emit_page(page, handlers_by_page[page])
        step, warmup, via = self.emit_extras()
        z80 = self.emit_z80_stub() if z80_stub else None
        self.module.define_table(1, 1)
        self.module.element_funcs([step.index])
        self.module.export_func("translated_step", step.index)
        self.module.export_func("translated_step_via_table", via.index)
        self.module.export_func("warmup_all", warmup.index)
        exports = [
            "translated_step",
            "translated_step_via_table",
            "warmup_all",
            "__indirect_function_table",
        ]
        if z80 is not None:
            self.module.export_func("translated_z80_step", z80.index)
            exports.append("translated_z80_step")
        self.module.export_table("__indirect_function_table")
        data = self.module.build()
        elapsed = (time.perf_counter() - started) * 1000.0
        used_codes = sorted(self.fail_codes_used | self.translator.fail_codes_used)
        functions = {
            "pages": len(self.page_funcs),
            "translated_step": step.index,
            "warmup_all": warmup.index,
            "translated_step_via_table": via.index,
        }
        if z80 is not None:
            functions["translated_z80_step"] = z80.index
        return data, {
            "generation_ms": round(elapsed, 3),
            "functions": functions,
            "imports": [self.helper_prefix + name for name, _, _ in abi.HELPERS],
            "helper_prefix": self.helper_prefix,
            "fail_code_map": {str(key): value for key, value in sorted(self.fail_code_map.items())},
            "fail_codes_used": used_codes,
            "exports": exports,
        }


def _instruction_meta(inst) -> dict:
    return {
        "pc": inst.pc,
        "end": inst.end,
        "page": page_of(inst.pc),
        "slot": slot_of(inst.pc),
        "op": inst.op,
        "size": inst.size,
        "bytes": inst.raw.hex(),
        "assembly": str(inst),
    }


def _module_metrics(data: bytes, skeleton: bytes, meta: dict, instruction_count: int) -> dict:
    handler_bytes = max(0, len(data) - len(skeleton))
    meta["modules"] = {
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "skeleton_bytes": len(skeleton),
        "handler_bytes": handler_bytes,
        "bytes_per_instruction": round(handler_bytes / instruction_count, 1)
        if instruction_count else 0.0,
    }
    return meta


def build_module(program, instructions, abi_desc: abi.CpuAbi,
                 memory: abi.MemoryLayout, page: Optional[int] = None,
                 label: str = "", helper_prefix: str = "",
                 fail_code_map: Optional[Dict[int, int]] = None,
                 z80_stub: bool = False,
                 instruction_meta: bool = True) -> Tuple[bytes, dict]:
    """Build a module for a set of real decoded instructions.

    ``program`` supplies the ROM bytes and the RAM-variant table; ``instructions``
    is any iterable of decoded ``Instruction`` objects (one page, or the whole
    program for the full module).  ``z80_stub=True`` adds the honest
    ``translated_z80_step`` UNTRANSLATED stub used by the all-page module.
    ``instruction_meta=False`` keeps per-instruction disassembly out of the meta
    (the full module's 40 382 entries would add ~5 MiB of redundant JSON).
    """
    selected = _public_instructions(program, instructions)
    if not selected:
        raise UnsupportedInstruction("no instructions to translate")
    handlers = _page_handlers(program, selected)
    variants = {}
    for inst in selected:
        if inst.pc in program.ram_variants:
            variants[inst.pc] = program.ram_variants[inst.pc]
    builder = ModuleBuilder(abi_desc, memory, program.rom, helper_prefix, fail_code_map)
    data, build_meta = builder.build(handlers, variants, z80_stub=z80_stub)
    # Skeleton: identical page/dispatch structure but no handler bodies.
    skeleton_builder = ModuleBuilder(abi_desc, memory, program.rom, helper_prefix,
                                     fail_code_map)
    skeleton, _ = skeleton_builder.build(
        {pg: {} for pg in handlers}, {}, z80_stub=z80_stub
    )
    page_counts: Dict[str, int] = {}
    for inst in selected:
        key = str(page_of(inst.pc))
        page_counts[key] = page_counts.get(key, 0) + 1
    meta = {
        "format": "dune-game-wasm/1",
        "label": label,
        "page": page,
        "abi_hash": abi_desc.abi_hash(),
        "abi": abi_desc.to_dict(),
        "memory": memory.to_dict(),
        "dispatch": {
            "page_shift": PAGE_SHIFT,
            "slots_per_page": SLOTS_PER_PAGE,
            "slot_shift": SLOT_SHIFT,
            "slots_per_chunk": SLOTS_PER_CHUNK,
            "chunks_per_page": CHUNKS_PER_PAGE,
            "ram_page_base": RAM_PAGE_BASE,
            "ram_page_count": RAM_PAGE_COUNT,
            "warmup_pc": WARMUP_PC,
        },
        "instruction_count": len(selected),
        "page_instruction_counts": dict(sorted(page_counts.items(), key=lambda kv: int(kv[0]))),
        "pages": sorted(handlers),
        "ram_variant_pcs": sorted(variants),
        "build": build_meta,
    }
    if instruction_meta:
        meta["instructions"] = [_instruction_meta(inst) for inst in selected]
    _module_metrics(data, skeleton, meta, len(selected))
    return data, meta


def build_page_module(program, page: int, abi_desc: abi.CpuAbi,
                      memory: abi.MemoryLayout,
                      instructions: Optional[Iterable] = None,
                      helper_prefix: str = "",
                      fail_code_map: Optional[Dict[int, int]] = None) -> Tuple[bytes, dict]:
    """Build the module for one real 4 KiB ROM page."""
    if instructions is None:
        instructions = [
            inst for inst in program.instructions.values() if page_of(inst.pc) == page
        ]
    instructions = list(instructions)
    if not instructions:
        raise UnsupportedInstruction("page $%03x has no translated instructions" % page)
    for inst in instructions:
        if page_of(inst.pc) != page:
            raise UnsupportedInstruction(
                "instruction $%06x is not on page $%03x" % (inst.pc, page)
            )
    return build_module(program, instructions, abi_desc, memory, page=page,
                        label="page_%03x" % page, helper_prefix=helper_prefix,
                        fail_code_map=fail_code_map)


def unsupported_ops(instructions: Iterable) -> Dict[str, int]:
    from .translate import SUPPORTED_OPS

    missing: Dict[str, int] = {}
    for inst in instructions:
        if inst.op not in SUPPORTED_OPS:
            missing[inst.op] = missing.get(inst.op, 0) + 1
    return missing


__all__ = [
    "ModuleBuilder",
    "build_module",
    "build_page_module",
    "unsupported_ops",
    "slot_of",
    "page_of",
    "WARMUP_PC",
]

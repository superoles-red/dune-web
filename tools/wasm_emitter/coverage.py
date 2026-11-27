"""Pick a small, representative differential-test set from the real Program.

The page differential proves one whole 4 KiB page.  The coverage module proves
every op family the task requires (and the page extras) using real decoded
instructions from the ROM: one representative per distinct ``(op, size, src EA
shape, dst EA shape)`` group.  Candidates with absolute addresses in
hardware/IO/VDP ranges are skipped because the native oracle has device state
and the JS harness deliberately models only RAM/ROM.  Register-indirect EAs are
safe: every A register starts in the 0xE00000 RAM window.
"""

from __future__ import annotations

from typing import Dict, Iterable, List, Optional, Tuple

REQUIRED_OPS = (
    "MOVE", "MOVEA", "CLR", "TST", "ADDQ", "SUBQ", "ADD", "SUB", "CMP", "CMPI",
    "ORI", "ANDI", "EORI", "BCC", "BSR", "JSR", "JMP", "RTS", "LEA", "EXT",
    "SWAP", "NOT", "NEG", "MULU", "MULS", "DIVU", "DIVS",
    "ASL", "LSL", "ASR", "LSR", "ROL", "ROR", "ROXL", "ROXR",
)
PAGE_EXTRAS = ("MOVEM_LOAD", "MOVEM_STORE", "BSET", "BCLR", "BCHG", "BTST",
               "TO_SR", "FROM_SR", "SR_OR", "TO_CCR", "CCR_OR", "CCR_EOR",
               "ADDI", "SUBI", "ADDA", "SUBA", "CMPA", "OR", "AND", "EOR",
               "ADDX", "SUBX", "NEGX", "SCC", "DBCC", "MOVEQ", "PEA", "LINK",
               "UNLK", "EXG", "RTE", "NOP")

UNSAFE_RANGES = (
    (0x200000, 0x200002),   # EEPROM (disabled in the oracle, but keep clean)
    (0xA00000, 0xA10000),   # Z80 bus window
    (0xA10000, 0xA10020),   # I/O ports
    (0xA11100, 0xA11102),   # Z80 bus request
    (0xA11200, 0xA11202),   # Z80 reset
    (0xA14000, 0xA14004),   # TMSS
    (0xC00000, 0xC00020),   # VDP ports
)
CONTROL_NO_MEMORY_SRC = frozenset(("LEA", "PEA", "JMP", "JSR"))


def _absolute_address(ea) -> Optional[int]:
    if ea is None or ea.mode != 7:
        return None
    if ea.reg in (0, 1, 2):
        return ea.value & 0xFFFFFF
    return None


def _is_memory_ea(inst, ea) -> bool:
    if ea is None:
        return False
    if ea.mode in (0, 1):
        return False
    if ea.mode == 7 and ea.reg == 4:
        return False
    return True


def is_safe(inst) -> bool:
    """True if executing this instruction in isolation only touches RAM/ROM."""
    pairs = []
    if inst.src is not None and inst.op not in CONTROL_NO_MEMORY_SRC:
        pairs.append(inst.src)
    if inst.dst is not None:
        pairs.append(inst.dst)
    for ea in pairs:
        if not _is_memory_ea(inst, ea):
            continue
        address = _absolute_address(ea)
        if address is None:
            continue
        if any(start <= address < end for start, end in UNSAFE_RANGES):
            return False
    return True


def _ea_key(ea) -> Optional[Tuple[int, int]]:
    if ea is None:
        return None
    if ea.mode == 7:
        return (7, ea.reg)
    return (ea.mode, ea.reg if ea.mode in (0, 1) else -1)


def coverage_key(inst) -> Tuple:
    return (inst.op, inst.size, _ea_key(inst.src), _ea_key(inst.dst))


def select_coverage(program, ops: Iterable[str] = REQUIRED_OPS + PAGE_EXTRAS,
                    max_groups: int = 240) -> Tuple[List, dict]:
    wanted = set(ops)
    seen: Dict[Tuple, object] = {}
    skipped_unsafe = 0
    for inst in sorted(program.instructions.values(), key=lambda item: item.pc):
        if inst.op not in wanted:
            continue
        if not is_safe(inst):
            skipped_unsafe += 1
            continue
        key = coverage_key(inst)
        if key not in seen:
            seen[key] = inst
    ordered = sorted(seen.values(), key=lambda item: item.pc)
    # Prioritise (1) every op and (2) every MOVE/MOVEA size+addressing-mode
    # family, so the required "all main addressing modes" claim is backed by
    # real instructions and not just by synthetic validity tests.
    kept: Dict[Tuple, object] = {}

    def add(key, inst):
        if key not in kept and len(kept) < max_groups:
            kept[key] = inst

    for inst in ordered:
        add(("op", inst.op), inst)
    for inst in ordered:
        if inst.op not in ("MOVE", "MOVEA"):
            continue
        for role, ea in (("src", inst.src), ("dst", inst.dst)):
            if ea is not None:
                add((role, inst.op, inst.size, _ea_key(ea)), inst)
    for inst in ordered:
        if len(kept) >= max_groups:
            break
        add(coverage_key(inst), inst)
    selected = list(kept.values())[:max_groups]
    covered = {}
    for inst in selected:
        covered.setdefault(inst.op, 0)
        covered[inst.op] += 1
    required_covered = {op: covered.get(op, 0) for op in REQUIRED_OPS}
    extras_covered = {op: covered.get(op, 0) for op in PAGE_EXTRAS if covered.get(op)}
    report = {
        "instructions": len(selected),
        "groups": len(seen),
        "skipped_unsafe": skipped_unsafe,
        "required_ops": required_covered,
        "required_missing": [op for op, count in required_covered.items() if count == 0],
        "extras_covered": extras_covered,
        "ops_covered": sorted(covered),
    }
    return selected, report


__all__ = [
    "REQUIRED_OPS", "PAGE_EXTRAS", "UNSAFE_RANGES", "is_safe", "coverage_key",
    "select_coverage",
]

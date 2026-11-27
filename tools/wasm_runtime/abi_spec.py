"""ABI-descriptor v1 layout for ``runtime.wasm`` (Phase 1 of the WASM backend).

The descriptor is a flat ``uint32_t[]`` in the runtime's linear memory, returned
by the exported ``dune_abi_descriptor()``.  This module is the single source of
truth for:

* the word order (consumed by C and by JavaScript),
* the generated C header ``dune_abi_layout.h``,
* the generated C include ``dune_abi_fill.inc``,
* the ``abi`` section of ``runtime/wasm/manifest.json``.

Design references: ``docs/WASM-BACKEND.md`` §3.1 and appendix B.  Deviations
from appendix B are recorded in ``docs/WASM-RUNTIME.md``:

* the 256-bit ``abi_hash`` occupies eight consecutive words,
* Z80 offsets are absolute offsets from the ``CPU`` pointer (``off_z80_cpu`` is
  the base of the nested ``Z80CPU``); a game module never has to know the
  nesting,
* the descriptor additionally carries the ``DuneSaveState`` size/field offsets
  so the JS/Pyodide side can validate saves without a second C header.

``abi_hash`` is SHA-256 over the *structural* descriptor words only:

    words [0, 3)                       -- magic, version, size
    words [11, DUNE_ABI_LAYOUT_END)    -- layout, enums, fail codes, constants

Runtime addresses (the trailing block) are deliberately excluded: they depend
on the emcc build, while ``game.wasm`` cache keys depend on the layout only.
"""

from __future__ import annotations

from typing import Dict, List

# ---------------------------------------------------------------------------
# Constants that are not tied to a C ``offsetof``.
# ---------------------------------------------------------------------------

ABI_MAGIC = 0x31424144  # 'DAB1' little-endian
ABI_VERSION = 1
HELPER_ABI_VERSION = 1
ABI_HASH_WORDS = 8

SAVESTATE_MAGIC = 0x56415344  # 'DSAV'
SAVESTATE_VERSION = 2
SAVE_BUFFER_BYTES = 256 * 1024
ROM_CAPACITY = 1024 * 1024

PAGE_SHIFT = 12
PAGE_SIZE = 1 << PAGE_SHIFT
PAGE_SLOTS = 1 << (24 - PAGE_SHIFT)  # every 4 KiB page of the 24-bit bus
ROM_PAGES = ROM_CAPACITY // PAGE_SIZE  # 256
RAM_PAGE_FIRST = 0xFF0  # 0xFF0000 >> 12
RAM_PAGE_COUNT = 16

GAME_MODE_NONE = 0
GAME_MODE_PAGES = 1
GAME_MODE_SINGLE = 2

#: ``fail(c, reason, address)`` reason codes.  Strings live in the runtime.
FAIL_CODES: List[tuple[str, int, str]] = [
    ("UNTRANSLATED", 1, "instruction has no translated handler"),
    ("BAD_PC", 2, "program counter outside the 24-bit bus"),
    ("ODD_PC", 3, "odd instruction address"),
    ("UNMAPPED", 4, "unmapped address"),
    ("RAM_VARIANT", 5, "68000 RAM instruction bytes do not match static translation"),
    ("PRIVILEGE", 6, "privileged instruction in user mode"),
    ("ADDRESS_ERROR", 7, "address error"),
    ("UNMAPPED_READ", 8, "unmapped read"),
    ("UNMAPPED_WRITE", 9, "unmapped write"),
    ("ILLEGAL_INSTRUCTION", 10, "illegal instruction"),
    ("DIVISION_BY_ZERO", 11, "division by zero"),
    ("SERIAL_NOT_IMPLEMENTED", 12, "serial peripheral not implemented"),
    ("VDP_ACCESS", 13, "invalid VDP access"),
    ("Z80_PERIPHERAL", 14, "Z80 peripheral access not implemented"),
]

FAIL_CODE_VALUES: Dict[str, int] = {name: value for name, value, _ in FAIL_CODES}
FAIL_CODE_MESSAGES: Dict[int, str] = {value: message for _, value, message in FAIL_CODES}

#: Values recorded in the manifest and validated against ``runtime/manifest.json``.
#: ``None`` means "computed by the C compiler, validated structurally by tests".
EXPECTED_SAVESTATE = {
    "SIZEOF_SAVESTATE": 140056,
    "SAVESTATE_RAM_OFFSET": 94,
    "SAVESTATE_HOUSE_OFFSET": 49874,
    "SAVESTATE_MISSION_OFFSET": 49326,
    "SAVESTATE_YM_SIZE_FIELD_OFFSET": 8,
    "SAVESTATE_TOTAL_SIZE_FIELD_OFFSET": 12,
}


def _const(name: str, value: int) -> dict:
    return {"name": name, "kind": "const", "value": value}


def _enum(name: str, value: int) -> dict:
    return {"name": name, "kind": "const", "value": value}


def _expr(name: str, c: str, expected: int | None = None) -> dict:
    entry = {"name": name, "kind": "expr", "c": c}
    if expected is not None:
        entry["expected"] = expected
    return entry


def _offset_cpu(name: str, member: str, expected: int | None = None) -> dict:
    return _expr(name, f"(uint32_t)offsetof(CPU, {member})", expected)


def _offset_z80(name: str, member: str) -> dict:
    return _expr(name, f"(uint32_t)offsetof(CPU, z80_cpu.{member})")


def _offset_z80_bus(name: str, member: str | None = None) -> dict:
    member = f".{member}" if member else ""
    return _expr(name, f"(uint32_t)offsetof(CPU, z80_bus{member})")


def _address(name: str, c: str) -> dict:
    return {"name": name, "kind": "address", "c": c}


def _fail_word(name: str) -> dict:
    return {"name": name, "kind": "enum_const", "c": f"DUNE_FAIL_{name}"}


def build_fields() -> List[dict]:
    """Return the descriptor fields in word order."""
    fields: List[dict] = [
        _const("MAGIC", ABI_MAGIC),
        _const("VERSION", ABI_VERSION),
        {"name": "SIZE", "kind": "size"},
    ]
    for i in range(ABI_HASH_WORDS):
        fields.append({"name": f"ABI_HASH_{i}", "kind": "hash"})
    fields.append(_const("HELPER_ABI_VERSION", HELPER_ABI_VERSION))

    # --- CPU layout (68000) -------------------------------------------------
    fields += [
        _expr("SIZEOF_CPU", "(uint32_t)sizeof(CPU)"),
        _offset_cpu("OFF_D", "d", 0),
        _offset_cpu("OFF_A", "a"),
        _offset_cpu("OFF_PC", "pc"),
        _offset_cpu("OFF_USP", "usp"),
        _offset_cpu("OFF_SSP", "ssp"),
        _offset_cpu("OFF_SR", "sr"),
        _offset_cpu("OFF_RAM", "ram"),
        _offset_cpu("OFF_IO_DATA", "io_data"),
        _offset_cpu("OFF_IO_CONTROL", "io_control"),
        _offset_cpu("OFF_TMSS", "tmss"),
        _offset_cpu("OFF_IO_TX", "io_tx"),
        _offset_cpu("OFF_IO_SERIAL_CONTROL", "io_serial_control"),
        _offset_cpu("OFF_PAD_BUTTONS", "pad_buttons"),
        _offset_cpu("OFF_FAULT", "fault"),
        _offset_cpu("OFF_FAULT_ADDRESS", "fault_address"),
        _offset_cpu("OFF_REASON", "reason"),
        _offset_cpu("OFF_INSTRUCTION_CYCLES", "instruction_cycles"),
        _offset_cpu("OFF_Z80_DIVIDER", "z80_divider"),
        _offset_cpu("OFF_STEPS", "steps"),
        _offset_cpu("OFF_CYCLES", "cycles"),
        _offset_cpu("OFF_MASTER_CYCLES", "master_cycles"),
        _offset_cpu("OFF_INTERRUPTS", "interrupts"),
        _offset_cpu("OFF_HALTED", "halted"),
        _offset_cpu("OFF_ROM", "rom"),
        _offset_cpu("OFF_ROM_SIZE", "rom_size"),
        _offset_cpu("OFF_VDP", "vdp"),
        _offset_cpu("OFF_VDP_REGISTERS", "vdp.registers"),
        _offset_cpu("OFF_VDP_VRAM", "vdp.vram"),
        _offset_cpu("OFF_VDP_CRAM", "vdp.cram"),
        _offset_cpu("OFF_VDP_VSRAM", "vdp.vsram"),
        _offset_cpu("OFF_VDP_FRAME", "vdp.frame"),
        _offset_cpu("OFF_VDP_FRAME_WIDTH", "vdp.frame_width"),
        _offset_cpu("OFF_VDP_FRAME_HEIGHT", "vdp.frame_height"),
    ]

    # --- Z80 CPU (absolute offsets from CPU) --------------------------------
    fields += [
        _expr("SIZEOF_Z80CPU", "(uint32_t)sizeof(Z80CPU)", 72),
        _expr("OFF_Z80_CPU", "(uint32_t)offsetof(CPU, z80_cpu)"),
        _offset_z80("OFF_Z80_R8", "r8"),
        _offset_z80("OFF_Z80_ALTERNATE", "alternate"),
        _offset_z80("OFF_Z80_A", "a"),
        _offset_z80("OFF_Z80_F", "f"),
        _offset_z80("OFF_Z80_A_ALT", "a_alt"),
        _offset_z80("OFF_Z80_F_ALT", "f_alt"),
        _offset_z80("OFF_Z80_I", "i"),
        _offset_z80("OFF_Z80_R", "r"),
        _offset_z80("OFF_Z80_IFF1", "iff1"),
        _offset_z80("OFF_Z80_IFF2", "iff2"),
        _offset_z80("OFF_Z80_IM", "im"),
        _offset_z80("OFF_Z80_HALTED", "halted"),
        _offset_z80("OFF_Z80_IRQ_LINE", "irq_line"),
        _offset_z80("OFF_Z80_EI_DELAY", "ei_delay"),
        _offset_z80("OFF_Z80_PC", "pc"),
        _offset_z80("OFF_Z80_SP", "sp"),
        _offset_z80("OFF_Z80_IX", "ix"),
        _offset_z80("OFF_Z80_IY", "iy"),
        _offset_z80("OFF_Z80_WZ", "wz"),
        _offset_z80("OFF_Z80_DEBT", "debt"),
        _offset_z80("OFF_Z80_STEPS", "steps"),
        _offset_z80("OFF_Z80_CYCLES", "cycles"),
        _offset_z80("OFF_Z80_INTERRUPTS", "interrupts"),
    ]

    # --- Z80 bus (absolute offsets from CPU) --------------------------------
    fields += [
        _offset_z80_bus("OFF_Z80_BUS"),
        _offset_z80_bus("OFF_Z80_RAM", "ram"),
        _offset_z80_bus("OFF_Z80_BUS_REQUESTED", "requested"),
        _offset_z80_bus("OFF_Z80_BUS_RESET_RELEASED", "reset_released"),
        _offset_z80_bus("OFF_Z80_BUS_BANK", "bank"),
    ]

    # --- DSAV v2 save state -------------------------------------------------
    fields += [
        _expr("SIZEOF_SAVESTATE", "(uint32_t)sizeof(DuneSaveState)",
              EXPECTED_SAVESTATE["SIZEOF_SAVESTATE"]),
        _expr("SAVESTATE_RAM_OFFSET", "(uint32_t)offsetof(DuneSaveState, ram)",
              EXPECTED_SAVESTATE["SAVESTATE_RAM_OFFSET"]),
        _expr(
            "SAVESTATE_HOUSE_OFFSET",
            "(uint32_t)(offsetof(DuneSaveState, ram) + 0xC274u)",
            EXPECTED_SAVESTATE["SAVESTATE_HOUSE_OFFSET"],
        ),
        _expr(
            "SAVESTATE_MISSION_OFFSET",
            "(uint32_t)(offsetof(DuneSaveState, ram) + 0xC050u)",
            EXPECTED_SAVESTATE["SAVESTATE_MISSION_OFFSET"],
        ),
        _expr("SAVESTATE_YM_SIZE_FIELD_OFFSET",
              "(uint32_t)offsetof(DuneSaveState, ym_size)",
              EXPECTED_SAVESTATE["SAVESTATE_YM_SIZE_FIELD_OFFSET"]),
        _expr("SAVESTATE_TOTAL_SIZE_FIELD_OFFSET",
              "(uint32_t)offsetof(DuneSaveState, total_size)",
              EXPECTED_SAVESTATE["SAVESTATE_TOTAL_SIZE_FIELD_OFFSET"]),
        _const("SAVESTATE_MAGIC", SAVESTATE_MAGIC),
        _const("SAVESTATE_VERSION", SAVESTATE_VERSION),
    ]

    # --- sizes and dispatch modes ------------------------------------------
    fields += [
        _const("SAVE_BUFFER_BYTES", SAVE_BUFFER_BYTES),
        _const("ROM_CAPACITY", ROM_CAPACITY),
        _const("PAGE_SHIFT", PAGE_SHIFT),
        _const("PAGE_SIZE", PAGE_SIZE),
        _const("PAGE_SLOTS", PAGE_SLOTS),
        _const("ROM_PAGES", ROM_PAGES),
        _const("RAM_PAGE_FIRST", RAM_PAGE_FIRST),
        _const("RAM_PAGE_COUNT", RAM_PAGE_COUNT),
        _const("GAME_MODE_NONE", GAME_MODE_NONE),
        _const("GAME_MODE_PAGES", GAME_MODE_PAGES),
        _const("GAME_MODE_SINGLE", GAME_MODE_SINGLE),
    ]

    # --- flag values --------------------------------------------------------
    fields += [
        _enum("F_C", 1), _enum("F_V", 2), _enum("F_Z", 4), _enum("F_N", 8),
        _enum("F_X", 16),
    ]
    fields += [
        _enum("Z_C", 1), _enum("Z_N", 2), _enum("Z_PV", 4), _enum("Z_X", 8),
        _enum("Z_H", 16), _enum("Z_Y", 32), _enum("Z_Z", 64), _enum("Z_S", 128),
    ]
    fields += [
        _enum("SHIFT_KIND_ARITH", 0),
        _enum("SHIFT_KIND_LOGICAL", 1),
        _enum("SHIFT_KIND_ROX", 2),
        _enum("SHIFT_KIND_ROT", 3),
    ]
    fields += [_enum("SIZE_B", 1), _enum("SIZE_W", 2), _enum("SIZE_L", 4)]

    # --- fail reason codes --------------------------------------------------
    for name, _value, _message in FAIL_CODES:
        fields.append(_fail_word(name))

    # --- runtime addresses (never part of abi_hash) ------------------------
    fields += [
        _address("ADDR_CPU", "(uint32_t)(uintptr_t)&em_cpu"),
        _address("ADDR_RAM", "(uint32_t)(uintptr_t)em_cpu.ram"),
        _address("ADDR_Z80_RAM", "(uint32_t)(uintptr_t)em_cpu.z80_bus.ram"),
        _address("ADDR_ROM", "(uint32_t)(uintptr_t)g_rom_buffer"),
        _address("ADDR_SAVE_BUFFER", "(uint32_t)(uintptr_t)g_dune_state_buffer"),
        _address("ADDR_VDP_VRAM", "(uint32_t)(uintptr_t)em_cpu.vdp.vram"),
        _address("ADDR_VDP_CRAM", "(uint32_t)(uintptr_t)em_cpu.vdp.cram"),
        _address("ADDR_VDP_VSRAM", "(uint32_t)(uintptr_t)em_cpu.vdp.vsram"),
        _address("ADDR_VDP_FRAME", "(uint32_t)(uintptr_t)em_cpu.vdp.frame"),
        _address("ADDR_GAME_TABLE", "(uint32_t)(uintptr_t)g_page_slots"),
        _address("ADDR_ABI", "(uint32_t)(uintptr_t)dune_abi_words"),
    ]
    return fields


FIELDS: List[dict] = build_fields()

_FIELD_NAMES = [field["name"] for field in FIELDS]
if len(set(_FIELD_NAMES)) != len(_FIELD_NAMES):
    raise ValueError("duplicate ABI descriptor field name")

WORD_COUNT = len(FIELDS)
ADDRESSES_START = next(i for i, field in enumerate(FIELDS) if field["kind"] == "address")
LAYOUT_END = ADDRESSES_START
HASH_FIRST_WORD = next(i for i, field in enumerate(FIELDS) if field["kind"] == "hash")
AFTER_HASH_WORDS = HASH_FIRST_WORD + ABI_HASH_WORDS

#: Word ranges fed to SHA-256 (hash words themselves stay zero).
HASH_INPUT_WORD_RANGES = ((0, HASH_FIRST_WORD), (AFTER_HASH_WORDS, LAYOUT_END))

FIELD_NAMES: List[str] = list(_FIELD_NAMES)
FIELD_INDEX: Dict[str, int] = {name: i for i, name in enumerate(_FIELD_NAMES)}

#: Expected values known before the build (constants + compiler-independent ones).
CONSTANTS: Dict[str, int] = {}
for _field in FIELDS:
    if _field["kind"] == "const":
        CONSTANTS[_field["name"]] = _field["value"]
    elif _field["kind"] == "enum_const":
        CONSTANTS[_field["name"]] = FAIL_CODE_VALUES[_field["name"]]
    elif "expected" in _field:
        CONSTANTS[_field["name"]] = _field["expected"]

ADDRESS_FIELDS = [field["name"] for field in FIELDS if field["kind"] == "address"]
COMPUTED_FIELDS = [
    field["name"] for field in FIELDS
    if field["kind"] in ("expr",) and field["name"] not in CONSTANTS
]


def _c_uint(value: int) -> str:
    return f"{value}u"


def render_layout_header() -> str:
    """Render ``dune_abi_layout.h`` (indices + constants; no C types needed)."""
    lines = [
        "/* Generated by tools/wasm_runtime/build_runtime.py -- do not edit. */",
        "#ifndef DUNE_ABI_LAYOUT_H",
        "#define DUNE_ABI_LAYOUT_H",
        "",
        f"#define DUNE_ABI_WORD_COUNT {WORD_COUNT}",
        f"#define DUNE_ABI_LAYOUT_END {LAYOUT_END}",
        f"#define DUNE_ABI_ADDRESSES_START {ADDRESSES_START}",
        f"#define DUNE_ABI_HASH_WORD_COUNT {ABI_HASH_WORDS}",
        f"#define DUNE_ABI_HASH_FIRST_WORD {HASH_FIRST_WORD}",
        f"#define DUNE_ABI_AFTER_HASH_WORDS {AFTER_HASH_WORDS}",
        "",
        "enum {",
    ]
    for index, name in enumerate(_FIELD_NAMES):
        lines.append(f"    DUNE_ABI_{name} = {index},")
    lines += [
        "    DUNE_ABI_FIELD_COUNT",
        "};",
        "",
        "/* Expected values validated by static asserts / tests. */",
    ]
    for name in _FIELD_NAMES:
        if name in CONSTANTS:
            lines.append(f"#define DUNE_ABI_{name}_VALUE {_c_uint(CONSTANTS[name])}")
    lines += [
        "",
        "enum {",
    ]
    for name, value, _message in FAIL_CODES:
        lines.append(f"    DUNE_FAIL_{name} = {value},")
    lines += [
        "};",
        "",
        "#endif /* DUNE_ABI_LAYOUT_H */",
        "",
    ]
    return "\n".join(lines)


def render_fill_include() -> str:
    """Render ``dune_abi_fill.inc``: descriptor fill + static asserts + reasons."""
    l: List[str] = [
        "/* Generated by tools/wasm_runtime/build_runtime.py -- do not edit. */",
        "",
        "_Static_assert(sizeof(uint32_t) == 4, \"ABI words are 32-bit\");",
        "_Static_assert(sizeof(CPU) % 8 == 0, \"CPU layout is 8-byte aligned\");",
        "_Static_assert(sizeof(Z80CPU) == DUNE_ABI_SIZEOF_Z80CPU_VALUE,",
        "               \"Z80CPU size drifted from the ABI\");",
        "_Static_assert(offsetof(CPU, d) == DUNE_ABI_OFF_D_VALUE, \"CPU.d offset\");",
        "_Static_assert(sizeof(DuneSaveState) == DUNE_ABI_SIZEOF_SAVESTATE_VALUE,",
        "               \"DSAV v2 size drifted from runtime/manifest.json\");",
        "_Static_assert(offsetof(DuneSaveState, ram) == DUNE_ABI_SAVESTATE_RAM_OFFSET_VALUE,",
        "               \"DSAV v2 ram offset drifted\");",
        "_Static_assert(offsetof(DuneSaveState, ym_size) ==",
        "               DUNE_ABI_SAVESTATE_YM_SIZE_FIELD_OFFSET_VALUE, \"DSAV ym_size offset\");",
        "_Static_assert(offsetof(DuneSaveState, total_size) ==",
        "               DUNE_ABI_SAVESTATE_TOTAL_SIZE_FIELD_OFFSET_VALUE, \"DSAV total_size offset\");",
        "",
        "static void dune_abi_fill(uint32_t *w) {",
    ]
    for field in FIELDS:
        name = field["name"]
        kind = field["kind"]
        if kind in ("const",):
            l.append(f"    w[DUNE_ABI_{name}] = DUNE_ABI_{name}_VALUE;")
        elif kind == "enum_const":
            l.append(f"    w[DUNE_ABI_{name}] = (uint32_t){field['c']};")
        elif kind == "size":
            l.append("    w[DUNE_ABI_SIZE] = DUNE_ABI_WORD_COUNT;")
        elif kind == "hash":
            l.append(f"    w[DUNE_ABI_{name}] = 0u;")
        else:
            l.append(f"    w[DUNE_ABI_{name}] = {field['c']};")
    l += [
        "}",
        "",
        "static const char *dune_fail_message(uint32_t code) {",
        "    switch (code) {",
    ]
    for name, value, message in FAIL_CODES:
        escaped = message.replace('"', '\\"')
        l.append(f"        case {value}: return \"{name}: {escaped}\";")
    l += [
        "        default: return \"unknown fail reason\";",
        "    }",
        "}",
        "",
    ]
    return "\n".join(l)


def manifest_abi() -> dict:
    """Return the ``abi`` section of ``runtime/wasm/manifest.json``."""
    return {
        "format": "DAB1",
        "magic": ABI_MAGIC,
        "version": ABI_VERSION,
        "helper_abi_version": HELPER_ABI_VERSION,
        "word_count": WORD_COUNT,
        "layout_end": LAYOUT_END,
        "addresses_start": ADDRESSES_START,
        "hash": {
            "algorithm": "sha256",
            "words": ABI_HASH_WORDS,
            "first_word": HASH_FIRST_WORD,
            "after_hash_word": AFTER_HASH_WORDS,
            "input_word_ranges": [list(r) for r in HASH_INPUT_WORD_RANGES],
            "note": "SHA-256 over structural descriptor words; runtime addresses are excluded.",
        },
        "fields": list(_FIELD_NAMES),
        "field_index": {name: i for i, name in enumerate(_FIELD_NAMES)},
        "constants": dict(CONSTANTS),
        "computed_fields": list(COMPUTED_FIELDS),
        "address_fields": list(ADDRESS_FIELDS),
        "fail_codes": dict(FAIL_CODE_VALUES),
        "savestate": {
            "format": "DSAV",
            "magic": SAVESTATE_MAGIC,
            "version": SAVESTATE_VERSION,
            "base_bytes": EXPECTED_SAVESTATE["SIZEOF_SAVESTATE"],
            "ram_offset": EXPECTED_SAVESTATE["SAVESTATE_RAM_OFFSET"],
            "house_offset": EXPECTED_SAVESTATE["SAVESTATE_HOUSE_OFFSET"],
            "mission_offset": EXPECTED_SAVESTATE["SAVESTATE_MISSION_OFFSET"],
            "ym_size_field_offset": EXPECTED_SAVESTATE["SAVESTATE_YM_SIZE_FIELD_OFFSET"],
            "total_size_field_offset": EXPECTED_SAVESTATE["SAVESTATE_TOTAL_SIZE_FIELD_OFFSET"],
            "max_buffer_bytes": SAVE_BUFFER_BYTES,
        },
        "dispatch": {
            "page_shift": PAGE_SHIFT,
            "page_size": PAGE_SIZE,
            "page_slots": PAGE_SLOTS,
            "rom_pages": ROM_PAGES,
            "ram_page_first": RAM_PAGE_FIRST,
            "ram_page_count": RAM_PAGE_COUNT,
            "mode_none": GAME_MODE_NONE,
            "mode_pages": GAME_MODE_PAGES,
            "mode_single": GAME_MODE_SINGLE,
            "note": (
                "mode_pages: slot = funcref index for pc>>12 (4096 slots); "
                "mode_single: slot 0 = game translated_step, slot 1 = translated_z80_step."
            ),
        },
        "rom": {
            "capacity": ROM_CAPACITY,
            "location": "runtime heap, allocated by dune_rt_init(); never a static array",
        },
        "save_buffer": {"bytes": SAVE_BUFFER_BYTES},
    }


if __name__ == "__main__":  # pragma: no cover - tiny self-check
    print(f"fields={WORD_COUNT} layout_end={LAYOUT_END} addresses={len(ADDRESS_FIELDS)}")
    print(f"hash ranges={HASH_INPUT_WORD_RANGES}")
    assert WORD_COUNT == len(_FIELD_NAMES)
    assert ADDRESSES_START == LAYOUT_END
    print(render_layout_header()[:400])

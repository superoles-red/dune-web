"""ABI descriptor for the generated game module (runtime contract).

The generated ``game.wasm`` never hardcodes the C layout: every CPU field it
touches, every absolute address it uses for RAM/ROM/frame guard reads and every
failure code comes from this descriptor.  In production the descriptor is
produced by ``runtime.wasm`` (``dune_abi_descriptor()``, see
``docs/WASM-BACKEND.md`` §3.1); while ``runtime.wasm`` does not exist yet this
module carries a pinned **native oracle ABI** measured from the player-supplied
``dune-base.c`` with the C compiler (``offsetof`` / ``sizeof``).  That is exactly
the ABI the differential C oracle uses, so the comparison is layout-accurate.

Pointer width matters: on wasm32 ``const uint8_t *rom`` / ``size_t`` are four
bytes, so fields after them move.  The emitter never assumes a fixed layout; it
re-reads the descriptor.  ``pointer_bits`` records which layout a descriptor
describes (64 = native C oracle, 32 = future runtime.wasm).

Static checks live in :func:`check_runtime_contract`, :func:`validate_cpu_abi`
and :func:`check_probe`; ``python3 -m unittest`` runs them without a ROM.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

ABI_FORMAT = "dune-wasm-emitter-abi/1"
ABI_VERSION = 1
HELPER_ABI_VERSION = 1

I32 = 0x7F

# MC68000 status-register flag bits (same values as runtime.h / runtime v2).
F_C = 1
F_V = 2
F_Z = 4
F_N = 8
F_X = 16
SR_SUPERVISOR = 0x2000
SR_MASK = 0xA71F

# Failure codes passed to the runtime ``fail(c, code, address)`` helper.  The C
# helpers carry strings; the generated module carries these small integers and
# the runtime maps them back to strings.  Every C reason from the 68000 helpers
# is listed in FAIL_REASONS below so the native oracle can translate its
# ``c->reason`` back to the same code and the differential test compares them.
FAIL_OK = 0
FAIL_UNTRANSLATED = 1
FAIL_BAD_PC = 2
FAIL_ODD_PC = 3
FAIL_UNMAPPED = 4
FAIL_RAM_VARIANT = 5
FAIL_PRIVILEGE = 6
FAIL_ADDRESS_ERROR_READ = 7
FAIL_ADDRESS_ERROR_WRITE = 8
FAIL_UNMAPPED_READ = 9
FAIL_UNMAPPED_WRITE = 10
FAIL_WRITE_ROM = 11
FAIL_ILLEGAL = 12
FAIL_LINE_A = 13
FAIL_LINE_F = 14
FAIL_DIVIDE_BY_ZERO = 15
FAIL_DEVICE = 16
FAIL_Z80 = 17

FAIL_CODES = {
    "ok": FAIL_OK,
    "untranslated": FAIL_UNTRANSLATED,
    "bad_pc": FAIL_BAD_PC,
    "odd_pc": FAIL_ODD_PC,
    "unmapped": FAIL_UNMAPPED,
    "ram_variant": FAIL_RAM_VARIANT,
    "privilege": FAIL_PRIVILEGE,
    "address_error_read": FAIL_ADDRESS_ERROR_READ,
    "address_error_write": FAIL_ADDRESS_ERROR_WRITE,
    "unmapped_read": FAIL_UNMAPPED_READ,
    "unmapped_write": FAIL_UNMAPPED_WRITE,
    "write_rom": FAIL_WRITE_ROM,
    "illegal": FAIL_ILLEGAL,
    "line_a": FAIL_LINE_A,
    "line_f": FAIL_LINE_F,
    "divide_by_zero": FAIL_DIVIDE_BY_ZERO,
    "device": FAIL_DEVICE,
    "z80": FAIL_Z80,
}

# ``c->reason`` prefix -> code name.  The oracle maps the C string back to the
# numeric code; the generated module passes the numeric code directly.
FAIL_REASONS: Tuple[Tuple[str, str], ...] = (
    ("address error on read", "address_error_read"),
    ("address error on write", "address_error_write"),
    ("unmapped read / hardware device not implemented", "unmapped_read"),
    ("unmapped write / hardware device not implemented", "unmapped_write"),
    ("write to ROM", "write_rom"),
    ("68000 ILLEGAL instruction (exception not implemented)", "illegal"),
    ("68000 LINE_A opcode", "line_a"),
    ("68000 LINE_F opcode", "line_f"),
    ("division by zero exception not implemented", "divide_by_zero"),
    ("SR privilege violation", "privilege"),
    ("USP privilege violation", "privilege"),
    ("STOP privilege violation", "privilege"),
    ("RTE privilege violation", "privilege"),
    ("68000 RAM instruction bytes do not match static translation", "ram_variant"),
    ("PC has no translated instruction", "untranslated"),
    ("invalid I/O register", "device"),
    ("read of write-only VDP/PSG port", "device"),
    ("read of write-only Z80 reset register", "device"),
    ("Z80 bus has not been granted", "z80"),
    ("Z80 peripheral read not implemented", "z80"),
    ("Z80 peripheral write not implemented", "z80"),
    ("Z80 PC has no static translation", "z80"),
    ("Z80 RAM differs from compiled instruction variants", "z80"),
    ("active serial communication not implemented", "device"),
    ("unsupported VDP data-read access code", "device"),
    ("unsupported VDP data-write access code", "device"),
)

# Helper imports of game.wasm: (name, params, results).  Kept in the same order
# as docs/WASM-BACKEND.md §4.1 so function indices are stable.
HELPERS: Tuple[Tuple[str, Tuple[int, ...], Tuple[int, ...]], ...] = (
    ("read_mem", (I32, I32, I32), (I32,)),
    ("write_mem", (I32, I32, I32, I32), ()),
    ("push32", (I32, I32), ()),
    ("pop32", (I32,), (I32,)),
    ("movem", (I32, I32, I32, I32, I32, I32, I32), ()),
    ("set_sr", (I32, I32), ()),
    ("logic_flags", (I32, I32, I32), ()),
    ("arithmetic", (I32, I32, I32, I32, I32, I32), (I32,)),
    ("extended_arithmetic", (I32, I32, I32, I32, I32), (I32,)),
    ("bcd_arithmetic", (I32, I32, I32, I32), (I32,)),
    ("bcd_negate", (I32, I32), (I32,)),
    ("shift_value", (I32, I32, I32, I32, I32, I32), (I32,)),
    ("divide_value", (I32, I32, I32, I32), (I32,)),
    ("condition", (I32, I32), (I32,)),
    ("index_value", (I32, I32), (I32,)),
    ("fail", (I32, I32, I32), ()),
)
HELPER_NAMES = tuple(helper[0] for helper in HELPERS)

# DSAV v2 contract from runtime/manifest.json + docs/RUNTIME.md (not touched by
# the wasm emitter, checked so a runtime change cannot slip in silently).
SAVESTATE_CONTRACT = {
    "format": "DSAV",
    "magic": 0x56415344,
    "version": 2,
    "base_bytes": 140056,
    "ram_offset": 94,
    "house_offset": 49874,
    "mission_offset": 49326,
    "ym_size_field_offset": 8,
    "total_size_field_offset": 12,
    "max_buffer_bytes": 262144,
}

RAM_BYTES = 0x10000
Z80_RAM_BYTES = 0x2000
ROM_BYTES = 0x100000
FRAME_WIDTH = 320
FRAME_HEIGHT = 240
FRAME_BYTES = FRAME_WIDTH * FRAME_HEIGHT * 3


class AbiError(ValueError):
    """The ABI descriptor is inconsistent or does not match the runtime."""


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise AbiError(message)


@dataclass(frozen=True)
class CpuAbi:
    """Offsets/sizes of the runtime's ``CPU``/``Z80CPU``/``VDP`` structures."""

    pointer_bits: int
    cpu_size: int
    z80cpu_size: int
    vdp_size: int
    z80bus_size: int
    # CPU fields used by generated instruction handlers.
    d: int
    a: int
    pc: int
    usp: int
    ssp: int
    sr: int
    ram: int
    steps: int
    cycles: int
    master_cycles: int
    instruction_cycles: int
    z80_divider: int
    halted: int
    fault: int
    fault_address: int
    # Nested structures / absolute-address components.
    z80_cpu: int
    z80_bus: int
    vdp: int
    rom: int
    rom_size: int
    vdp_registers: int
    vdp_vram: int
    vdp_cram: int
    vdp_vsram: int
    vdp_frame: int
    vdp_frame_width: int
    vdp_frame_height: int
    z80bus_ram: int
    z80cpu_pc: int
    z80cpu_sp: int
    z80cpu_cycles: int
    version: int = ABI_VERSION
    helper_abi_version: int = HELPER_ABI_VERSION

    # -- construction ------------------------------------------------------
    @classmethod
    def from_probe(cls, probe: dict) -> "CpuAbi":
        """Build from the native C oracle's ``--abi`` JSON."""
        try:
            offsets = probe["offsets"]
            vdp = probe["vdp_offsets"]
            zbus = probe["z80bus_offsets"]
            zcpu = probe["z80cpu_offsets"]
            abi = cls(
                pointer_bits=int(probe.get("pointer_bits", 64)),
                cpu_size=int(probe["sizeof_cpu"]),
                z80cpu_size=int(probe["sizeof_z80cpu"]),
                vdp_size=int(probe["sizeof_vdp"]),
                z80bus_size=int(probe["sizeof_z80bus"]),
                d=int(offsets["d"]),
                a=int(offsets["a"]),
                pc=int(offsets["pc"]),
                usp=int(offsets["usp"]),
                ssp=int(offsets["ssp"]),
                sr=int(offsets["sr"]),
                ram=int(offsets["ram"]),
                steps=int(offsets["steps"]),
                cycles=int(offsets["cycles"]),
                master_cycles=int(offsets["master_cycles"]),
                instruction_cycles=int(offsets["instruction_cycles"]),
                z80_divider=int(offsets["z80_divider"]),
                halted=int(offsets["halted"]),
                fault=int(offsets["fault"]),
                fault_address=int(offsets["fault_address"]),
                z80_cpu=int(offsets["z80_cpu"]),
                z80_bus=int(offsets["z80_bus"]),
                vdp=int(offsets["vdp"]),
                rom=int(offsets["rom"]),
                rom_size=int(offsets["rom_size"]),
                vdp_registers=int(vdp["registers"]),
                vdp_vram=int(vdp["vram"]),
                vdp_cram=int(vdp["cram"]),
                vdp_vsram=int(vdp["vsram"]),
                vdp_frame=int(vdp["frame"]),
                vdp_frame_width=int(vdp["frame_width"]),
                vdp_frame_height=int(vdp["frame_height"]),
                z80bus_ram=int(zbus["ram"]),
                z80cpu_pc=int(zcpu["pc"]),
                z80cpu_sp=int(zcpu["sp"]),
                z80cpu_cycles=int(zcpu["cycles"]),
            )
        except (KeyError, TypeError, ValueError) as error:
            raise AbiError("malformed ABI probe: %s" % (error,)) from error
        validate_cpu_abi(abi)
        return abi

    # -- serialisation -----------------------------------------------------
    def to_dict(self) -> dict:
        return {
            "format": ABI_FORMAT,
            "version": self.version,
            "helper_abi_version": self.helper_abi_version,
            "pointer_bits": self.pointer_bits,
            "sizeof": {
                "cpu": self.cpu_size,
                "z80cpu": self.z80cpu_size,
                "vdp": self.vdp_size,
                "z80bus": self.z80bus_size,
            },
            "offsets": {
                "d": self.d,
                "a": self.a,
                "pc": self.pc,
                "usp": self.usp,
                "ssp": self.ssp,
                "sr": self.sr,
                "ram": self.ram,
                "steps": self.steps,
                "cycles": self.cycles,
                "master_cycles": self.master_cycles,
                "instruction_cycles": self.instruction_cycles,
                "z80_divider": self.z80_divider,
                "halted": self.halted,
                "fault": self.fault,
                "fault_address": self.fault_address,
                "z80_cpu": self.z80_cpu,
                "z80_bus": self.z80_bus,
                "vdp": self.vdp,
                "rom": self.rom,
                "rom_size": self.rom_size,
                "vdp_registers": self.vdp_registers,
                "vdp_vram": self.vdp_vram,
                "vdp_cram": self.vdp_cram,
                "vdp_vsram": self.vdp_vsram,
                "vdp_frame": self.vdp_frame,
                "vdp_frame_width": self.vdp_frame_width,
                "vdp_frame_height": self.vdp_frame_height,
                "z80bus_ram": self.z80bus_ram,
                "z80cpu_pc": self.z80cpu_pc,
                "z80cpu_sp": self.z80cpu_sp,
                "z80cpu_cycles": self.z80cpu_cycles,
            },
            "flags": {"C": F_C, "V": F_V, "Z": F_Z, "N": F_N, "X": F_X},
            "fail_codes": dict(FAIL_CODES),
            "helpers": [
                {"name": name, "params": list(params), "results": list(results)}
                for name, params, results in HELPERS
            ],
            "savestate": dict(SAVESTATE_CONTRACT),
        }

    def abi_hash(self) -> str:
        blob = json.dumps(self.to_dict(), sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(blob.encode("utf-8")).hexdigest()

    def describe(self) -> str:
        return (
            "CPU size %d, d=%d a=%d pc=%d sr=%d ram=%d fault=%d "
            "instr_cycles=%d (pointer %d-bit)"
            % (
                self.cpu_size,
                self.d,
                self.a,
                self.pc,
                self.sr,
                self.ram,
                self.fault,
                self.instruction_cycles,
                self.pointer_bits,
            )
        )


def validate_cpu_abi(abi: CpuAbi) -> dict:
    """Static, ROM-free consistency checks of one ABI descriptor."""
    _require(abi.pointer_bits in (32, 64), "pointer_bits must be 32 or 64")
    _require(abi.cpu_size >= 128, "CPU is implausibly small")
    _require(abi.d == 0, "d[8] must start the CPU struct")
    _require(abi.a == abi.d + 32, "a[8] must follow d[8]")
    _require(abi.pc == abi.a + 32, "pc must follow a[8]")
    _require(abi.usp == abi.pc + 4, "usp must follow pc")
    _require(abi.ssp == abi.usp + 4, "ssp must follow usp")
    _require(abi.sr == abi.ssp + 4, "sr must follow ssp")
    _require(abi.ram >= abi.sr + 2, "ram must follow sr")
    _require(abi.ram + RAM_BYTES <= abi.cpu_size, "ram[] overflows CPU")
    for name in ("steps", "cycles", "master_cycles", "instruction_cycles",
                 "z80_divider", "halted", "fault", "fault_address"):
        value = getattr(abi, name)
        _require(0 <= value <= abi.cpu_size - 4, "%s offset out of CPU" % name)
    for name in ("z80_cpu", "z80_bus", "vdp", "rom", "rom_size"):
        value = getattr(abi, name)
        _require(0 <= value <= abi.cpu_size - 4, "%s offset out of CPU" % name)
    _require(abi.z80_cpu + abi.z80cpu_size <= abi.cpu_size, "Z80CPU overflows CPU")
    _require(abi.z80_bus + abi.z80bus_size <= abi.cpu_size, "Z80Bus overflows CPU")
    _require(abi.vdp + abi.vdp_size <= abi.cpu_size, "VDP overflows CPU")
    _require(abi.vdp + abi.vdp_frame + FRAME_BYTES <= abi.cpu_size,
             "VDP frame overflows CPU")
    _require(abi.vdp_vram == 24, "VRAM must follow registers[24]")
    _require(abi.vdp_cram == abi.vdp_vram + 65536,
             "CRAM must follow VRAM[65536]")
    _require(abi.vdp_vsram == abi.vdp_cram + 128, "VSRAM must follow CRAM[64]")
    _require(abi.vdp_frame >= abi.vdp_vsram + 80, "frame must follow VSRAM[40]")
    _require(abi.vdp_frame + FRAME_BYTES <= abi.vdp_size, "frame overflows VDP")
    _require(abi.vdp_cram + 128 <= abi.vdp_size, "CRAM overflows VDP")
    _require(abi.z80bus_ram == 0, "Z80Bus.ram is the first member")
    _require(abi.z80cpu_pc >= 0 and abi.z80cpu_pc + 2 <= abi.z80cpu_size, "Z80CPU.pc")
    _require(abi.z80cpu_sp >= 0 and abi.z80cpu_sp + 2 <= abi.z80cpu_size, "Z80CPU.sp")
    _require(abi.z80cpu_cycles >= 0 and abi.z80cpu_cycles + 8 <= abi.z80cpu_size,
             "Z80CPU.cycles")
    flags = {F_C, F_V, F_Z, F_N, F_X}
    _require(flags == {1, 2, 4, 8, 16}, "flag bits changed")
    codes = list(FAIL_CODES.values())
    _require(len(codes) == len(set(codes)), "fail codes are not unique")
    _require(all(code >= 0 for code in codes), "negative fail code")
    names = [name for name, _, _ in HELPERS]
    _require(len(names) == len(set(names)), "helper names are not unique")
    for name, params, results in HELPERS:
        _require(params and all(param == I32 for param in params),
                 "%s: only i32 params are expected" % name)
        _require(all(result == I32 for result in results),
                 "%s: only i32 results are expected" % name)
    return {
        "cpu_size": abi.cpu_size,
        "ram_offset": abi.ram,
        "helpers": len(HELPERS),
        "fail_codes": len(FAIL_CODES),
        "pointer_bits": abi.pointer_bits,
        "abi_hash": abi.abi_hash(),
    }


def check_probe(abi: CpuAbi, probe: dict) -> dict:
    """Compare a pinned descriptor with the C compiler's measured offsets."""
    measured = CpuAbi.from_probe(probe)
    differences = []
    for name in abi.__dataclass_fields__:
        if name in ("version", "helper_abi_version"):
            continue
        expected = getattr(abi, name)
        actual = getattr(measured, name)
        if expected != actual:
            differences.append("%s: descriptor=%r probe=%r" % (name, expected, actual))
    if differences:
        raise AbiError("ABI descriptor differs from the C probe: " + "; ".join(differences))
    return {"checked_fields": len(abi.__dataclass_fields__) - 2}


# Native oracle ABI measured from dune-base.c (arm64 macOS clang; LLP64/64-bit
# pointer layout, identical on x86_64).  This is *the* ABI used by the
# differential C oracle until runtime.wasm exports its own descriptor.
REFERENCE_NATIVE_ABI = CpuAbi(
    pointer_bits=64,
    cpu_size=391624,
    z80cpu_size=72,
    vdp_size=296240,
    z80bus_size=8208,
    d=0,
    a=32,
    pc=64,
    usp=68,
    ssp=72,
    sr=76,
    ram=78,
    steps=391552,
    cycles=391560,
    master_cycles=391568,
    instruction_cycles=391592,
    z80_divider=391596,
    halted=391600,
    fault=391604,
    fault_address=391608,
    z80_cpu=370088,
    z80_bus=361880,
    vdp=65640,
    rom=391536,
    rom_size=391544,
    vdp_registers=0,
    vdp_vram=24,
    vdp_cram=65560,
    vdp_vsram=65688,
    vdp_frame=65824,
    vdp_frame_width=296226,
    vdp_frame_height=296228,
    z80bus_ram=0,
    z80cpu_pc=24,
    z80cpu_sp=26,
    z80cpu_cycles=56,
)


@dataclass(frozen=True)
class MemoryLayout:
    """Absolute linear-memory addresses game.wasm writes into ``i32.const``."""

    pages: int
    cpu: int
    ram: int
    rom: int
    rom_size: int
    z80_ram: int
    vdp: int
    vram: int
    cram: int
    vsram: int
    frame: int
    frame_bytes: int
    save_buffer: int = 0
    save_buffer_bytes: int = 0

    @classmethod
    def from_cpu(cls, cpu_base: int, abi: CpuAbi, rom_base: int,
                 rom_size: int = ROM_BYTES, pages: Optional[int] = None) -> "MemoryLayout":
        _require(cpu_base % 8 == 0, "CPU base must be 8-byte aligned")
        _require(rom_base % 8 == 0, "ROM base must be 8-byte aligned")
        _require(rom_base >= cpu_base + abi.cpu_size,
                 "ROM overlaps the CPU structure")
        layout = cls(
            pages=pages or ((rom_base + rom_size + 0xFFFF) // 0x10000),
            cpu=cpu_base,
            ram=cpu_base + abi.ram,
            rom=rom_base,
            rom_size=rom_size,
            z80_ram=cpu_base + abi.z80_bus + abi.z80bus_ram,
            vdp=cpu_base + abi.vdp,
            vram=cpu_base + abi.vdp + abi.vdp_vram,
            cram=cpu_base + abi.vdp + abi.vdp_cram,
            vsram=cpu_base + abi.vdp + abi.vdp_vsram,
            frame=cpu_base + abi.vdp + abi.vdp_frame,
            frame_bytes=FRAME_BYTES,
        )
        layout.validate(abi)
        return layout

    def validate(self, abi: CpuAbi) -> None:
        _require(self.pages >= 1, "memory needs at least one page")
        end = self.pages * 0x10000
        _require(self.cpu + abi.cpu_size <= end, "CPU outside linear memory")
        _require(self.ram == self.cpu + abi.ram, "ram address must equal cpu+offset")
        _require(self.ram + RAM_BYTES <= end, "RAM outside linear memory")
        _require(self.rom + self.rom_size <= end, "ROM outside linear memory")
        _require(self.z80_ram == self.cpu + abi.z80_bus + abi.z80bus_ram,
                 "Z80 RAM address mismatch")
        _require(self.frame + self.frame_bytes <= end, "frame outside linear memory")
        _require(self.rom >= self.cpu + abi.cpu_size, "ROM overlaps CPU")

    def to_dict(self) -> dict:
        return {
            "pages": self.pages,
            "cpu": self.cpu,
            "ram": self.ram,
            "rom": self.rom,
            "rom_size": self.rom_size,
            "z80_ram": self.z80_ram,
            "vdp": self.vdp,
            "vram": self.vram,
            "cram": self.cram,
            "vsram": self.vsram,
            "frame": self.frame,
            "frame_bytes": self.frame_bytes,
            "save_buffer": self.save_buffer,
            "save_buffer_bytes": self.save_buffer_bytes,
        }


def extract_cpu_struct(text: str) -> str:
    """Normalised text of the ``typedef struct { ... } CPU;`` definition."""
    needle = "typedef struct {\n    uint32_t d[8], a[8], pc;"
    start = text.find(needle)
    if start < 0:
        raise AbiError("CPU struct definition not found")
    end = text.find("} CPU;", start)
    if end < 0:
        raise AbiError("CPU struct terminator not found")
    block = text[start:end + len("} CPU;")]
    lines = [line.rstrip() for line in block.splitlines()]
    return "\n".join(line for line in lines if line.strip())


def check_runtime_contract(root: Path, abi: Optional[CpuAbi] = None) -> dict:
    """Verify the pinned runtime/manifest/docs against the descriptor contract.

    This is ROM-free and runs in CI.  It answers: does the committed runtime
    still have the CPU layout the emitter was validated against, and did the
    DSAV v2 contract change?
    """
    root = Path(root)
    manifest_path = root / "runtime" / "manifest.json"
    runtime_path = root / "runtime" / "dune-runtime-v2.c"
    docs_path = root / "docs" / "RUNTIME.md"
    report: Dict[str, object] = {}
    _require(manifest_path.is_file(), "runtime/manifest.json missing")
    _require(runtime_path.is_file(), "runtime/dune-runtime-v2.c missing")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    runtime = runtime_path.read_bytes()
    digest = hashlib.sha256(runtime).hexdigest()
    _require(manifest.get("runtime_version") == 2, "runtime_version must be 2")
    _require(manifest.get("runtime_file") == "dune-runtime-v2.c",
             "unexpected runtime_file")
    _require(digest == manifest.get("runtime_sha256"),
             "runtime SHA-256 does not match the manifest")
    _require(len(runtime) == manifest.get("runtime_bytes"),
             "runtime size does not match the manifest")
    text = runtime.decode("utf-8", "replace")
    _require("#define DUNE_SAVESTATE_VERSION 2" in text,
             "runtime v2 savestate version marker missing")
    _require("static void translated_step(CPU *c);" in text,
             "runtime does not declare translated_step")

    savestate = manifest.get("savestate", {})
    for key, value in SAVESTATE_CONTRACT.items():
        _require(savestate.get(key) == value,
                 "manifest savestate.%s != %r" % (key, value))
    report["savestate"] = dict(SAVESTATE_CONTRACT)

    if docs_path.is_file():
        docs = docs_path.read_text(encoding="utf-8")
        _require("sizeof(DuneSaveState) == 140 056" in docs,
                 "docs/RUNTIME.md no longer documents 140 056-byte state")
        _require("offsetof(ram) == 94" in docs,
                 "docs/RUNTIME.md no longer documents ram offset 94")
        report["docs"] = "RUNTIME.md DSAV contract matches"

    vendor_runtime = root / "vendor" / "rearrakis" / "genesis_recompiler" / "runtime.h"
    _require(vendor_runtime.is_file(), "vendor runtime.h missing")
    vendor_text = vendor_runtime.read_text(encoding="utf-8")
    runtime_cpu = extract_cpu_struct(text)
    vendor_cpu = extract_cpu_struct(vendor_text)
    _require(runtime_cpu == vendor_cpu,
             "CPU struct in runtime v2 differs from genesis_recompiler/runtime.h")
    report["cpu_struct"] = "runtime v2 == vendor runtime.h"

    if abi is not None:
        validate_cpu_abi(abi)
        _require(abi.ram == 78 or abi.pointer_bits == 32,
                 "native reference ABI must place ram at offset 78")
        report["abi_hash"] = abi.abi_hash()
        report["abi"] = abi.describe()
    report["runtime_sha256"] = digest
    report["runtime_bytes"] = len(runtime)
    return report


def fail_code_for_reason(reason: Optional[str]) -> int:
    """Map a C ``c->reason`` string to the numeric ABI code (oracle helper)."""
    if not reason:
        return FAIL_OK
    for prefix, name in FAIL_REASONS:
        if reason.startswith(prefix):
            return FAIL_CODES[name]
    raise AbiError("unmapped C failure reason: %r" % (reason,))


__all__ = [
    "ABI_FORMAT",
    "ABI_VERSION",
    "HELPER_ABI_VERSION",
    "CpuAbi",
    "MemoryLayout",
    "REFERENCE_NATIVE_ABI",
    "AbiError",
    "FAIL_CODES",
    "FAIL_REASONS",
    "HELPERS",
    "HELPER_NAMES",
    "SAVESTATE_CONTRACT",
    "RAM_BYTES",
    "ROM_BYTES",
    "Z80_RAM_BYTES",
    "FRAME_BYTES",
    "F_C", "F_V", "F_Z", "F_N", "F_X",
    "SR_SUPERVISOR", "SR_MASK",
    "validate_cpu_abi",
    "check_probe",
    "check_runtime_contract",
    "extract_cpu_struct",
    "fail_code_for_reason",
]

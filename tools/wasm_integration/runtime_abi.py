"""The ABI of the real ``runtime.wasm``, used as the *only* source of layout.

The emitter package (``tools.wasm_emitter``) is layout-agnostic: every CPU/Z80/
VDP offset, absolute linear-memory address, failure code and helper signature it
emits comes from a descriptor object.  Until this module existed the descriptor
was the *native C oracle* ABI (64-bit pointers, measured with clang).  Here the
same numbers are read from the shipped ``runtime/wasm/runtime.wasm`` through
``runtime/wasm/loader.mjs``:

1. :file:`runtime_abi_dump.mjs` instantiates the runtime in Node, calls
   ``_initialize()`` + ``dune_rt_init()``, reads ``dune_abi_descriptor()`` and
   verifies ``dune_abi_hash()`` / ``dune_abi_selfcheck()``;
2. :func:`verify_dump` re-checks the dump in Python (independent SHA-256 over the
   structural words, cross-check against ``runtime/wasm/manifest.json``, address
   identities, ROM buffer) and raises :class:`RuntimeAbiError` on any drift;
3. :func:`cpu_abi_from_fields` / :func:`memory_layout_from_fields` convert the
   wasm32 descriptor into the emitter's :class:`abi.CpuAbi` /
   :class:`abi.MemoryLayout`;
4. :func:`runtime_fail_code_map` translates the emitter's *canonical* failure
   codes (the ones the native C oracle reports) to the runtime's codes by
   descriptor name, and back.

A changed descriptor therefore breaks the build: the ABI hash no longer matches
the pinned ``runtime/wasm/manifest.json`` value and/or the structural offsets no
longer satisfy ``abi.validate_cpu_abi``.  Nothing falls back to native numbers.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:  # pragma: no cover - import bootstrap
    sys.path.insert(0, str(TOOLS))

from wasm_emitter import abi  # noqa: E402

DUMP_SCRIPT = Path(__file__).resolve().with_name("runtime_abi_dump.mjs")
DEFAULT_RUNTIME = ROOT / "runtime" / "wasm" / "runtime.wasm"
DEFAULT_LOADER = ROOT / "runtime" / "wasm" / "loader.mjs"
DEFAULT_MANIFEST = ROOT / "runtime" / "wasm" / "manifest.json"

ABI_FORMAT = "dune-wasm-integration-runtime-abi/1"
PAGE_BYTES = 0x10000
DEFAULT_PAGES = 1024  # loader.mjs createMemory(): 64 MiB initial / 512 MiB max


class RuntimeAbiError(RuntimeError):
    """The runtime descriptor is missing, malformed or does not match the pin."""


# ---------------------------------------------------------------------------
# Node <-> Python plumbing
# ---------------------------------------------------------------------------


def node_path() -> str:
    node = shutil.which("node")
    if not node:
        raise RuntimeAbiError("Node.js is required to read runtime.wasm's ABI")
    return node


def load_manifest(manifest: Path = DEFAULT_MANIFEST) -> dict:
    path = Path(manifest)
    if not path.is_file():
        raise RuntimeAbiError("runtime manifest not found: %s" % path)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise RuntimeAbiError("invalid runtime manifest %s: %s" % (path, error)) from error
    if "abi" not in data or "wasm" not in data:
        raise RuntimeAbiError("runtime manifest %s has no abi/wasm sections" % path)
    return data


def _manifest_pin(manifest: Mapping) -> dict:
    abi_section = manifest["abi"]
    wasm_section = manifest["wasm"]
    hash_section = abi_section.get("hash") or {}
    ranges = hash_section.get("input_word_ranges")
    if not ranges:
        raise RuntimeAbiError("runtime manifest has no ABI hash word ranges")
    pinned = {
        "abi_hash": str(abi_section.get("abi_hash") or ""),
        "abi_version": int(abi_section.get("version", 1)),
        "helper_abi_version": int(abi_section.get("helper_abi_version", 1)),
        "word_count": int(abi_section.get("word_count", 0)),
        "hash_first_word": int(hash_section.get("first_word", 3)),
        "hash_words": int(hash_section.get("words", 8)),
        "hash_word_ranges": [(int(a), int(b)) for a, b in ranges],
        "fields": dict(abi_section.get("actual") or {}),
        "fail_codes": dict(abi_section.get("fail_codes") or {}),
        "runtime_sha256": str(wasm_section.get("sha256") or ""),
        "runtime_bytes": int(wasm_section.get("bytes", -1)),
        "loader_sha256": str((manifest.get("loader") or {}).get("sha256") or ""),
        "rom_capacity": int((manifest.get("abi") or {}).get("rom", {}).get("capacity",
                            (abi_section.get("constants") or {}).get("ROM_CAPACITY", 0))),
        "memory_initial_pages": int((manifest.get("memory") or {}).get("initial_pages",
                                                                       DEFAULT_PAGES)),
    }
    if not pinned["abi_hash"]:
        raise RuntimeAbiError("runtime manifest has no pinned abi_hash")
    return pinned


def dump_runtime_abi(runtime: Path = DEFAULT_RUNTIME, loader: Path = DEFAULT_LOADER,
                     manifest: Path = DEFAULT_MANIFEST, node: Optional[str] = None,
                     tamper: Sequence[str] = (), rehash: bool = False,
                     timeout: int = 300) -> dict:
    """Run :file:`runtime_abi_dump.mjs`; return its raw JSON report.

    ``tamper``/``rehash`` are test hooks: patch descriptor words in runtime memory
    before the checks (see the module docstring of the Node script).
    """
    runtime = Path(runtime).resolve()
    loader = Path(loader).resolve()
    for path, label in ((runtime, "runtime.wasm"), (loader, "loader.mjs")):
        if not path.is_file():
            raise RuntimeAbiError("%s not found: %s" % (label, path))
    pinned = _manifest_pin(load_manifest(Path(manifest).resolve()))
    command = [
        node or node_path(),
        str(DUMP_SCRIPT),
        "--runtime", str(runtime),
        "--loader", str(loader),
        "--pinned-hash", pinned["abi_hash"],
        "--pinned-version", str(pinned["abi_version"]),
    ]
    for spec in tamper:
        command += ["--tamper", spec]
    if rehash:
        command.append("--rehash")
    process = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
    raw = process.stdout.strip()
    if not raw:
        raise RuntimeAbiError(
            "runtime ABI dump produced no JSON (exit %d):\n%s"
            % (process.returncode, process.stderr.strip())
        )
    try:
        report = json.loads(raw)
    except json.JSONDecodeError as error:
        raise RuntimeAbiError(
            "runtime ABI dump produced invalid JSON: %s\n%s" % (error, raw[:2000])
        ) from error
    report["stderr"] = process.stderr.strip()
    report["node_returncode"] = process.returncode
    return report


# ---------------------------------------------------------------------------
# Independent verification of the dump
# ---------------------------------------------------------------------------


def compute_abi_hash(words: Sequence[int],
                     ranges: Iterable[Tuple[int, int]]) -> str:
    """SHA-256 over the structural descriptor words (little-endian u32).

    This mirrors ``runtime/wasm/manifest.json#abi.hash.input_word_ranges`` and
    ``loader.mjs#computeAbiHash`` without trusting either of them.
    """
    digest = hashlib.sha256()
    for start, end in ranges:
        for index in range(start, end):
            digest.update(int(words[index] & 0xFFFFFFFF).to_bytes(4, "little"))
    return digest.hexdigest()


def _diff_fields(actual: Mapping[str, int], expected: Mapping[str, int],
                 max_report: int = 8) -> List[str]:
    problems = []
    for name, value in expected.items():
        if name not in actual:
            problems.append("field %s missing from descriptor" % name)
        elif int(actual[name]) != int(value):
            problems.append("%s: descriptor=%r manifest=%r"
                            % (name, int(actual[name]), int(value)))
        if len(problems) >= max_report:
            problems.append("...")
            break
    return problems


def verify_dump(report: Mapping, manifest: Mapping, runtime: Path = DEFAULT_RUNTIME,
                loader: Path = DEFAULT_LOADER) -> dict:
    """Cross-check a dump against the committed manifest and internal identities."""
    pinned = _manifest_pin(manifest)
    problems: List[str] = []
    checks = dict(report.get("checks") or {})
    fields = dict(report.get("fields") or {})
    words = list(report.get("words") or [])
    if report.get("node_returncode") not in (0, None):
        problems.append("Node dump exited with %s" % report.get("node_returncode"))
    if not report.get("ok"):
        problems.append("Node descriptor checks failed")
    if len(words) != pinned["word_count"]:
        problems.append("descriptor has %d words, manifest pins %d"
                        % (len(words), pinned["word_count"]))
    if len(fields) != pinned["word_count"]:
        problems.append("dump has %d fields, manifest pins %d"
                        % (len(fields), pinned["word_count"]))

    recomputed = ""
    if words:
        recomputed = compute_abi_hash(words, pinned["hash_word_ranges"])
        if recomputed != pinned["abi_hash"]:
            problems.append("abi_hash mismatch: computed %s, manifest pins %s"
                            % (recomputed, pinned["abi_hash"]))
        if report.get("abi_hash_hex") and report["abi_hash_hex"] != recomputed:
            problems.append("dump hash %s != independently computed %s"
                            % (report["abi_hash_hex"], recomputed))
    fields_problems = _diff_fields(fields, pinned["fields"])
    if fields_problems:
        problems.append("descriptor fields differ from manifest.abi.actual: "
                        + "; ".join(fields_problems))

    if checks.get("word_count") != pinned["word_count"]:
        problems.append("dune_abi_word_count()=%r, expected %d"
                        % (checks.get("word_count"), pinned["word_count"]))
    if checks.get("abi_version") != pinned["abi_version"]:
        problems.append("dune_abi_version()=%r, expected %d"
                        % (checks.get("abi_version"), pinned["abi_version"]))
    if checks.get("helper_abi_version") != pinned["helper_abi_version"]:
        problems.append("dune_abi_helper_version()=%r, expected %d"
                        % (checks.get("helper_abi_version"),
                           pinned["helper_abi_version"]))
    if fields.get("SIZE") != pinned["word_count"]:
        problems.append("descriptor SIZE field %r != %d"
                        % (fields.get("SIZE"), pinned["word_count"]))

    for name in ("descriptor_magic_ok", "descriptor_version_ok",
                 "descriptor_size_ok", "hash_ok_recomputed", "selfcheck_own_ok",
                 "selfcheck_pinned_ok", "missing_exports_ok"):
        if checks.get(name) is not True:
            problems.append("descriptor check %s is %r" % (name, checks.get(name)))

    expected_sha = pinned["runtime_sha256"]
    if checks.get("runtime_sha256") and checks["runtime_sha256"] != expected_sha:
        problems.append("runtime.wasm SHA-256 %s != manifest %s"
                        % (checks["runtime_sha256"], expected_sha))
    if int(checks.get("runtime_bytes", -1)) != pinned["runtime_bytes"]:
        problems.append("runtime.wasm size %r != manifest %r"
                        % (checks.get("runtime_bytes"), pinned["runtime_bytes"]))
    if pinned["loader_sha256"] and checks.get("loader_sha256") != pinned["loader_sha256"]:
        problems.append("loader.mjs SHA-256 changed (manifest pins %s)"
                        % pinned["loader_sha256"])

    # Runtime addresses must describe the same objects the loader exposes.
    for name, export in (("ADDR_CPU", "cpu_pointer"),
                         ("ADDR_ROM", "rom_pointer_export"),
                         ("ADDR_GAME_TABLE", "game_table_pointer"),
                         ("ADDR_SAVE_BUFFER", "save_buffer_pointer")):
        if fields.get(name) != checks.get(export):
            problems.append("%s descriptor=%r export %s=%r"
                            % (name, fields.get(name), export, checks.get(export)))
    if int(checks.get("rom_buffer_before_init") or 0) != 0:
        problems.append("ROM buffer is non-zero before dune_rt_init()")
    if int(checks.get("initialized_before_init") or 0) != 0:
        problems.append("runtime reports initialized before dune_rt_init()")
    if int(checks.get("rom_buffer_after_init") or 0) != fields.get("ADDR_ROM"):
        problems.append("dune_rt_rom_buffer() != ADDR_ROM")
    if pinned["rom_capacity"] and int(checks.get("rom_capacity", -1)) != pinned["rom_capacity"]:
        problems.append("ROM capacity %r != manifest %r"
                        % (checks.get("rom_capacity"), pinned["rom_capacity"]))
    pages = int(checks.get("memory_pages") or 0)
    if pages < pinned["memory_initial_pages"]:
        problems.append("runtime memory is %d pages, expected >= %d"
                        % (pages, pinned["memory_initial_pages"]))
    if int(checks.get("indirect_table_length") or 0) <= 0:
        problems.append("runtime exports an empty __indirect_function_table")

    if problems:
        raise RuntimeAbiError(
            "runtime ABI descriptor rejected (%d problem(s)):\n  - %s"
            % (len(problems), "\n  - ".join(problems))
        )
    return {
        "runtime_sha256": checks.get("runtime_sha256"),
        "runtime_bytes": checks.get("runtime_bytes"),
        "loader_sha256": checks.get("loader_sha256"),
        "abi_hash": recomputed,
        "pinned_abi_hash": pinned["abi_hash"],
        "word_count": pinned["word_count"],
        "memory_pages": pages,
        "checked": True,
    }


# ---------------------------------------------------------------------------
# Descriptor -> emitter ABI objects
# ---------------------------------------------------------------------------


def _field(fields: Mapping[str, int], name: str) -> int:
    try:
        return int(fields[name])
    except KeyError as error:
        raise RuntimeAbiError("runtime descriptor has no field %r" % name) from error


def _relative_offsets(fields: Mapping[str, int], base_name: str,
                      member_names: Sequence[str]) -> Dict[str, int]:
    """Return ``member - base`` offsets, accepting absolute or relative words.

    ``runtime/manifest.json`` stores ``OFF_VDP_*``/``OFF_Z80_*`` as offsets from
    the ``CPU`` base (documented in ``docs/WASM-RUNTIME.md`` §3), while a native
    C probe naturally reports offsets from the nested struct.  Both forms are
    accepted as long as they are self-consistent, and the style is validated.
    """
    base = _field(fields, base_name)
    values = [_field(fields, name) for name in member_names]
    if base == 0:
        return {name: _field(fields, name) for name in member_names}
    above = sum(1 for value in values if value >= base)
    below = sum(1 for value in values if value < base)
    if above == len(values):
        # Descriptor stores absolute offsets from the CPU pointer.
        return {name: _field(fields, name) - base for name in member_names}
    if below == len(values):
        # Descriptor stores offsets from the nested structure (native probe).
        return {name: _field(fields, name) for name in member_names}
    raise RuntimeAbiError(
        "mixed absolute/relative offsets for %s: base=%d values=%r"
        % (base_name, base, dict(zip(member_names, values)))
    )


def cpu_abi_from_fields(fields: Mapping[str, int]) -> abi.CpuAbi:
    """Build the emitter :class:`abi.CpuAbi` from runtime descriptor words."""
    pointer_bytes = _field(fields, "OFF_ROM_SIZE") - _field(fields, "OFF_ROM")
    if pointer_bytes not in (4, 8):
        raise RuntimeAbiError(
            "cannot infer pointer width: OFF_ROM=%d OFF_ROM_SIZE=%d"
            % (_field(fields, "OFF_ROM"), _field(fields, "OFF_ROM_SIZE"))
        )
    z80_cpu = _field(fields, "OFF_Z80_CPU")
    z80_bus = _field(fields, "OFF_Z80_BUS")
    vdp = _field(fields, "OFF_VDP")
    cpu_size = _field(fields, "SIZEOF_CPU")
    if not (0 <= vdp < z80_bus < z80_cpu < cpu_size):
        raise RuntimeAbiError(
            "implausible CPU layout: vdp=%d z80_bus=%d z80_cpu=%d sizeof=%d"
            % (vdp, z80_bus, z80_cpu, cpu_size)
        )
    vdp_members = _relative_offsets(
        fields, "OFF_VDP",
        ("OFF_VDP_REGISTERS", "OFF_VDP_VRAM", "OFF_VDP_CRAM", "OFF_VDP_VSRAM",
         "OFF_VDP_FRAME", "OFF_VDP_FRAME_WIDTH", "OFF_VDP_FRAME_HEIGHT"),
    )
    z80_members = _relative_offsets(
        fields, "OFF_Z80_CPU", ("OFF_Z80_PC", "OFF_Z80_SP", "OFF_Z80_CYCLES"),
    )
    z80bus_ram = _field(fields, "OFF_Z80_RAM") - z80_bus
    z80bus_size = z80_cpu - z80_bus
    vdp_size = z80_bus - vdp
    if z80bus_ram < 0:
        raise RuntimeAbiError("OFF_Z80_RAM is before OFF_Z80_BUS")
    descriptor = abi.CpuAbi(
        pointer_bits=pointer_bytes * 8,
        cpu_size=cpu_size,
        z80cpu_size=_field(fields, "SIZEOF_Z80CPU"),
        vdp_size=vdp_size,
        z80bus_size=z80bus_size,
        d=_field(fields, "OFF_D"),
        a=_field(fields, "OFF_A"),
        pc=_field(fields, "OFF_PC"),
        usp=_field(fields, "OFF_USP"),
        ssp=_field(fields, "OFF_SSP"),
        sr=_field(fields, "OFF_SR"),
        ram=_field(fields, "OFF_RAM"),
        steps=_field(fields, "OFF_STEPS"),
        cycles=_field(fields, "OFF_CYCLES"),
        master_cycles=_field(fields, "OFF_MASTER_CYCLES"),
        instruction_cycles=_field(fields, "OFF_INSTRUCTION_CYCLES"),
        z80_divider=_field(fields, "OFF_Z80_DIVIDER"),
        halted=_field(fields, "OFF_HALTED"),
        fault=_field(fields, "OFF_FAULT"),
        fault_address=_field(fields, "OFF_FAULT_ADDRESS"),
        z80_cpu=z80_cpu,
        z80_bus=z80_bus,
        vdp=vdp,
        rom=_field(fields, "OFF_ROM"),
        rom_size=_field(fields, "OFF_ROM_SIZE"),
        vdp_registers=vdp_members["OFF_VDP_REGISTERS"],
        vdp_vram=vdp_members["OFF_VDP_VRAM"],
        vdp_cram=vdp_members["OFF_VDP_CRAM"],
        vdp_vsram=vdp_members["OFF_VDP_VSRAM"],
        vdp_frame=vdp_members["OFF_VDP_FRAME"],
        vdp_frame_width=vdp_members["OFF_VDP_FRAME_WIDTH"],
        vdp_frame_height=vdp_members["OFF_VDP_FRAME_HEIGHT"],
        z80bus_ram=z80bus_ram,
        z80cpu_pc=z80_members["OFF_Z80_PC"],
        z80cpu_sp=z80_members["OFF_Z80_SP"],
        z80cpu_cycles=z80_members["OFF_Z80_CYCLES"],
    )
    # Structural identities the C struct order guarantees; if the descriptor
    # drifts these fail loudly instead of producing a subtly wrong module.
    if not (descriptor.instruction_cycles + 4 == descriptor.z80_divider
            and descriptor.z80_divider + 4 == descriptor.halted
            and descriptor.halted + 4 == descriptor.fault
            and descriptor.fault + 4 == descriptor.fault_address):
        raise RuntimeAbiError(
            "CPU counter/fault fields are not the expected run of u32/u16 values: "
            "instruction_cycles=%d z80_divider=%d halted=%d fault=%d fault_address=%d"
            % (descriptor.instruction_cycles, descriptor.z80_divider,
               descriptor.halted, descriptor.fault, descriptor.fault_address)
        )
    if descriptor.fault_address + 4 > descriptor.cpu_size:
        raise RuntimeAbiError("fault_address lies outside the CPU struct")
    if descriptor.sr + 2 > descriptor.cpu_size:
        raise RuntimeAbiError("SR lies outside the CPU struct")
    if descriptor.z80_bus + descriptor.z80bus_size > descriptor.cpu_size:
        raise RuntimeAbiError("Z80Bus overflows the CPU struct")
    abi.validate_cpu_abi(descriptor)
    return descriptor


def memory_layout_from_fields(fields: Mapping[str, int], cpu_abi: abi.CpuAbi,
                              rom_size: int,
                              pages: int = DEFAULT_PAGES) -> abi.MemoryLayout:
    """Absolute linear-memory layout published by the runtime descriptor."""
    cpu = _field(fields, "ADDR_CPU")
    ram = _field(fields, "ADDR_RAM")
    rom = _field(fields, "ADDR_ROM")
    z80_ram = _field(fields, "ADDR_Z80_RAM")
    vram = _field(fields, "ADDR_VDP_VRAM")
    cram = _field(fields, "ADDR_VDP_CRAM")
    vsram = _field(fields, "ADDR_VDP_VSRAM")
    frame = _field(fields, "ADDR_VDP_FRAME")
    vdp = cpu + cpu_abi.vdp
    if vram < cpu or cram < cpu or frame < cpu:
        raise RuntimeAbiError(
            "VDP addresses are not absolute linear-memory addresses "
            "(ADDR_CPU=%d vram=%d cram=%d frame=%d)" % (cpu, vram, cram, frame)
        )
    if _field(fields, "ADDR_ROM") + rom_size > pages * PAGE_BYTES:
        raise RuntimeAbiError("ROM buffer (0x%x + %d bytes) is outside runtime memory"
                             % (rom, rom_size))
    layout = abi.MemoryLayout(
        pages=pages,
        cpu=cpu,
        ram=ram,
        rom=rom,
        rom_size=rom_size,
        z80_ram=z80_ram,
        vdp=vdp,
        vram=vram,
        cram=cram,
        vsram=vsram,
        frame=frame,
        frame_bytes=abi.FRAME_BYTES,
        save_buffer=_field(fields, "ADDR_SAVE_BUFFER"),
        save_buffer_bytes=_field(fields, "SAVE_BUFFER_BYTES"),
    )
    layout.validate(cpu_abi)
    if layout.ram != cpu + cpu_abi.ram:
        raise RuntimeAbiError("ADDR_RAM != ADDR_CPU + OFF_RAM")
    if layout.z80_ram != cpu + cpu_abi.z80_bus + cpu_abi.z80bus_ram:
        raise RuntimeAbiError("ADDR_Z80_RAM != ADDR_CPU + OFF_Z80_BUS + Z80Bus.ram")
    if layout.rom < cpu + cpu_abi.cpu_size:
        raise RuntimeAbiError("ADDR_ROM overlaps the CPU struct")
    return layout


# ---------------------------------------------------------------------------
# Failure codes: canonical (native C oracle) <-> runtime (descriptor)
# ---------------------------------------------------------------------------

#: Canonical codes the emitter can actually pass to ``fail``: the page
#: dispatcher always uses UNTRANSLATED/BAD_PC/ODD_PC/UNMAPPED/RAM_VARIANT, and
#: instruction bodies add PRIVILEGE/ILLEGAL/LINE_A/LINE_F.  Everything else
#: faults inside the runtime's C helpers with the shared C reason strings.
EMITTABLE_CANONICAL_CODES: Tuple[int, ...] = (
    abi.FAIL_UNTRANSLATED,
    abi.FAIL_BAD_PC,
    abi.FAIL_ODD_PC,
    abi.FAIL_UNMAPPED,
    abi.FAIL_RAM_VARIANT,
    abi.FAIL_PRIVILEGE,
    abi.FAIL_ILLEGAL,
    abi.FAIL_LINE_A,
    abi.FAIL_LINE_F,
)

#: Canonical code -> descriptor fail-code *name* (numbers are re-read from the
#: descriptor: that is how a runtime fail-code change propagates into game.wasm).
CANONICAL_TO_RUNTIME_NAME: Dict[int, str] = {
    abi.FAIL_UNTRANSLATED: "UNTRANSLATED",
    abi.FAIL_BAD_PC: "BAD_PC",
    abi.FAIL_ODD_PC: "ODD_PC",
    abi.FAIL_UNMAPPED: "UNMAPPED",
    abi.FAIL_RAM_VARIANT: "RAM_VARIANT",
    abi.FAIL_PRIVILEGE: "PRIVILEGE",
    abi.FAIL_ILLEGAL: "ILLEGAL_INSTRUCTION",
    # The runtime has a single illegal-instruction code and no LINE_A/LINE_F
    # variants; those two are explicitly recorded as lossy (see below).
    abi.FAIL_LINE_A: "ILLEGAL_INSTRUCTION",
    abi.FAIL_LINE_F: "ILLEGAL_INSTRUCTION",
}


@dataclass(frozen=True)
class FailCodeMap:
    """Canonical errors -> runtime codes, and the inverse for the differential."""

    runtime_names: Mapping[str, int]
    canonical_to_runtime: Mapping[int, int]
    runtime_to_canonical: Mapping[int, int]
    lossy_canonical: Tuple[int, ...]

    def runtime_code(self, canonical_code: int) -> int:
        return self.canonical_to_runtime.get(canonical_code, canonical_code)

    def canonical_code(self, runtime_code: int) -> int:
        try:
            return self.runtime_to_canonical[runtime_code]
        except KeyError as error:
            raise RuntimeAbiError(
                "runtime fail code %r has no canonical counterpart (map: %r)"
                % (runtime_code, dict(self.canonical_to_runtime))
            ) from error

    def has_lossy(self, canonical_codes: Iterable[int]) -> List[int]:
        lossy = set(self.lossy_canonical)
        return sorted(set(canonical_codes) & lossy)

    def to_dict(self) -> dict:
        return {
            "runtime_names": dict(sorted(self.runtime_names.items())),
            "canonical_to_runtime": {str(k): v for k, v in sorted(self.canonical_to_runtime.items())},
            "runtime_to_canonical": {str(k): v for k, v in sorted(self.runtime_to_canonical.items())},
            "lossy_canonical": list(self.lossy_canonical),
        }


def runtime_fail_code_map(fields: Mapping[str, int]) -> FailCodeMap:
    """Build the canonical->runtime fail-code map from descriptor words."""
    runtime_names: Dict[str, int] = {}
    for canonical_name, runtime_name in (
        ("UNTRANSLATED", "UNTRANSLATED"), ("BAD_PC", "BAD_PC"), ("ODD_PC", "ODD_PC"),
        ("UNMAPPED", "UNMAPPED"), ("RAM_VARIANT", "RAM_VARIANT"),
        ("PRIVILEGE", "PRIVILEGE"), ("ILLEGAL_INSTRUCTION", "ILLEGAL_INSTRUCTION"),
    ):
        try:
            runtime_names[runtime_name] = _field(fields, runtime_name)
        except RuntimeAbiError as error:
            raise RuntimeAbiError(
                "runtime descriptor lacks fail code %r needed by game.wasm"
                % runtime_name
            ) from error
    canonical_to_runtime = {
        canonical: runtime_names[CANONICAL_TO_RUNTIME_NAME[canonical]]
        for canonical in EMITTABLE_CANONICAL_CODES
    }
    reverse: Dict[int, int] = {}
    lossy: List[int] = []
    for canonical, runtime in canonical_to_runtime.items():
        if runtime in reverse:
            lossy.append(canonical)
        else:
            reverse[runtime] = canonical
    if abi.FAIL_LINE_A not in lossy:
        raise RuntimeAbiError("LINE_A must be recorded as a lossy fail code mapping")
    return FailCodeMap(
        runtime_names=runtime_names,
        canonical_to_runtime=canonical_to_runtime,
        runtime_to_canonical=reverse,
        lossy_canonical=tuple(sorted(lossy)),
    )


# ---------------------------------------------------------------------------
# High-level object
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RuntimeAbi:
    """Verified runtime descriptor + the emitter objects derived from it."""

    runtime: Path
    loader: Path
    manifest: Path
    fields: Mapping[str, int]
    words: Tuple[int, ...]
    abi_hash: str
    pinned_abi_hash: str
    runtime_sha256: str
    runtime_bytes: int
    loader_sha256: str
    memory_pages: int
    cpu_abi: abi.CpuAbi
    fail_codes: FailCodeMap
    checks: Mapping[str, object]
    descriptor_checks: Mapping[str, object]
    export_names: Tuple[str, ...]

    @property
    def pointer_bits(self) -> int:
        return self.cpu_abi.pointer_bits

    def memory_layout(self, rom_size: int, pages: Optional[int] = None) -> abi.MemoryLayout:
        return memory_layout_from_fields(self.fields, self.cpu_abi, rom_size,
                                         pages or self.memory_pages)

    def to_dict(self) -> dict:
        return {
            "format": ABI_FORMAT,
            "runtime_wasm": str(self.runtime),
            "runtime_sha256": self.runtime_sha256,
            "runtime_bytes": self.runtime_bytes,
            "loader_mjs": str(self.loader),
            "loader_sha256": self.loader_sha256,
            "manifest": str(self.manifest),
            "abi_hash": self.abi_hash,
            "pinned_abi_hash": self.pinned_abi_hash,
            "word_count": len(self.words),
            "version": self.fields.get("VERSION"),
            "helper_abi_version": self.fields.get("HELPER_ABI_VERSION"),
            "pointer_bits": self.pointer_bits,
            "memory_pages": self.memory_pages,
            "fields": dict(sorted(self.fields.items())),
            "fail_codes": self.fail_codes.to_dict(),
            "cpu_abi": self.cpu_abi.to_dict(),
            "checks": dict(self.checks),
            "descriptor_checks": dict(self.descriptor_checks),
            "exports": list(self.export_names),
        }


def load_runtime_abi(runtime: Path = DEFAULT_RUNTIME, loader: Path = DEFAULT_LOADER,
                     manifest: Path = DEFAULT_MANIFEST, node: Optional[str] = None,
                     tamper: Sequence[str] = (), rehash: bool = False) -> RuntimeAbi:
    """Read, verify and convert ``runtime.wasm``'s ABI descriptor.

    Raises :class:`RuntimeAbiError` when the descriptor is tampered with, drifted
    from ``runtime/wasm/manifest.json`` or structurally inconsistent.  There is
    deliberately no "fall back to native numbers" path.
    """
    runtime = Path(runtime).resolve()
    loader = Path(loader).resolve()
    manifest_path = Path(manifest).resolve()
    manifest_data = load_manifest(manifest_path)
    raw = dump_runtime_abi(runtime, loader, manifest_path, node=node,
                           tamper=tamper, rehash=rehash)
    checks = verify_dump(raw, manifest_data, runtime, loader)
    fields = {name: int(value) for name, value in raw["fields"].items()}
    try:
        cpu_abi = cpu_abi_from_fields(fields)
        fail_codes = runtime_fail_code_map(fields)
    except abi.AbiError as error:
        raise RuntimeAbiError("runtime descriptor is not a valid CPU ABI: %s" % error) from error
    memory_layout_from_fields(fields, cpu_abi, int(fields.get("ROM_CAPACITY", 0)),
                              int(checks["memory_pages"]))
    return RuntimeAbi(
        runtime=runtime,
        loader=loader,
        manifest=manifest_path,
        fields=fields,
        words=tuple(int(word) for word in raw["words"]),
        abi_hash=str(raw["abi_hash_hex"]),
        pinned_abi_hash=str(checks["pinned_abi_hash"]),
        runtime_sha256=str(checks["runtime_sha256"]),
        runtime_bytes=int(checks["runtime_bytes"]),
        loader_sha256=str(checks["loader_sha256"]),
        memory_pages=int(checks["memory_pages"]),
        cpu_abi=cpu_abi,
        fail_codes=fail_codes,
        checks=checks,
        descriptor_checks=dict(raw.get("checks") or {}),
        export_names=tuple(entry["name"] for entry in raw.get("exports") or []),
    )


# ---------------------------------------------------------------------------
# Structural checks of the generated game module
# ---------------------------------------------------------------------------

EXPECTED_GAME_EXPORTS = (
    "translated_step", "translated_step_via_table", "warmup_all",
    "__indirect_function_table",
)


def game_import_names(helper_prefix: str) -> List[str]:
    return ["%s%s" % (helper_prefix, name) for name in abi.HELPER_NAMES]


def verify_game_module(info, runtime_export_names: Iterable[str],
                       helper_prefix: str = "dune_",
                       expected_exports: Optional[Sequence[str]] = None,
                       extra_helpers: Sequence[str] = ()) -> dict:
    """Check that a generated module is the runtime's expected game side.

    * imports are exactly ``env.memory`` + the 16 runtime helper functions, and
      every helper is an export of ``runtime.wasm``;
    * the module defines no memory, no globals and carries no data segments
      (i.e. it cannot smuggle ROM/RAM content into the artifact);
    * exports are exactly ``expected_exports`` (default: the four page-module
      symbols; the full module passes five, incl. the ``translated_z80_step``
      stub).
    """
    problems: List[str] = []
    exports_available = set(runtime_export_names)
    expected_helpers = game_import_names(helper_prefix) + [
        helper_prefix + name for name in extra_helpers
    ]
    imports = list(info.imports)
    memory_imports = [entry for entry in imports if entry.kind == "memory"]
    function_imports = [entry for entry in imports if entry.kind == "function"]
    other_imports = [entry for entry in imports
                     if entry.kind not in ("memory", "function")]
    if len(memory_imports) != 1:
        problems.append("expected exactly one memory import, found %d"
                        % len(memory_imports))
    for entry in memory_imports:
        if (entry.module, entry.name) != ("env", "memory"):
            problems.append("memory import is %s.%s, expected env.memory"
                            % (entry.module, entry.name))
        limits = entry.limits or {}
        if int(limits.get("min", 0)) < 1:
            problems.append("memory import declares %r pages" % limits)
    if other_imports:
        problems.append("unexpected non-function imports: %s"
                        % [entry.to_dict() for entry in other_imports])
    names = ["%s.%s" % (entry.module, entry.name) for entry in function_imports]
    expected = ["env.%s" % name for name in expected_helpers]
    if names != expected:
        problems.append("function imports are %r, expected %r" % (names, expected))
    missing = [name for name in expected_helpers if name not in exports_available]
    if missing:
        problems.append("game.wasm imports names runtime.wasm does not export: %s"
                        % missing)
    if info.defined_memory_pages is not None:
        problems.append("game.wasm defines its own memory: %r"
                        % (info.defined_memory_pages,))
    if info.data_segments:
        problems.append("game.wasm carries %d data segment(s)" % info.data_segments)
    if info.global_count:
        problems.append("game.wasm declares %d global(s)" % info.global_count)
    if info.element_segments != 1:
        problems.append("expected one element segment, found %d"
                        % info.element_segments)
    export_names = [entry.name for entry in info.exports]
    expected = tuple(expected_exports or EXPECTED_GAME_EXPORTS)
    if sorted(export_names) != sorted(expected):
        problems.append("exports are %r, expected %r"
                        % (export_names, list(expected)))
    if problems:
        raise RuntimeAbiError("generated game.wasm rejected:\n  - "
                              + "\n  - ".join(problems))
    return {
        "imports": names + ["env.memory"],
        "exports": export_names,
        "data_segments": info.data_segments,
        "defined_memory": info.defined_memory_pages,
        "has_own_memory": info.defined_memory_pages is not None,
        "helper_prefix": helper_prefix,
    }


__all__ = [
    "ABI_FORMAT",
    "DEFAULT_LOADER",
    "DEFAULT_MANIFEST",
    "DEFAULT_RUNTIME",
    "FailCodeMap",
    "RuntimeAbi",
    "RuntimeAbiError",
    "compute_abi_hash",
    "cpu_abi_from_fields",
    "dump_runtime_abi",
    "game_import_names",
    "load_manifest",
    "load_runtime_abi",
    "memory_layout_from_fields",
    "node_path",
    "runtime_fail_code_map",
    "verify_dump",
    "verify_game_module",
]

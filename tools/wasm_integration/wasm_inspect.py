"""Minimal, dependency-free reader for the WebAssembly binary structure.

Used to prove properties of the generated ``game.wasm`` *without* trusting the
encoder that produced it and without Node: which sections exist, what the module
imports/exports, whether it defines its own memory or carries data segments
(i.e. game data).  Only what the integration checks need is decoded -- numeric
instruction bodies and code internals are skipped, not parsed.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

WASM_MAGIC = b"\x00asm"
WASM_VERSION = 1

SECTION_NAMES: Dict[int, str] = {
    1: "type",
    2: "import",
    3: "function",
    4: "table",
    5: "memory",
    6: "global",
    7: "export",
    8: "start",
    9: "element",
    10: "code",
    11: "data",
    12: "datacount",
    13: "tag",
}

IMPORT_KINDS = {0x00: "function", 0x01: "table", 0x02: "memory", 0x03: "global"}
EXPORT_KINDS = {0x00: "function", 0x01: "table", 0x02: "memory", 0x03: "global"}


class WasmFormatError(ValueError):
    """The bytes are not a well-formed WebAssembly MVP module."""


def read_uleb(data: bytes, offset: int) -> Tuple[int, int]:
    result = 0
    shift = 0
    while True:
        if offset >= len(data):
            raise WasmFormatError("truncated LEB128 at offset %d" % offset)
        byte = data[offset]
        offset += 1
        result |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return result, offset
        shift += 7
        if shift > 63:
            raise WasmFormatError("LEB128 too long")


def _read_name(data: bytes, offset: int) -> Tuple[str, int]:
    length, offset = read_uleb(data, offset)
    end = offset + length
    if end > len(data):
        raise WasmFormatError("truncated name at offset %d" % offset)
    try:
        text = data[offset:end].decode("utf-8")
    except UnicodeDecodeError as error:
        raise WasmFormatError("invalid UTF-8 name: %s" % error) from error
    return text, end


def _read_limits(data: bytes, offset: int) -> Tuple[dict, int]:
    flags = data[offset]
    offset += 1
    minimum, offset = read_uleb(data, offset)
    limits = {"min": minimum, "max": None, "shared": bool(flags & 0x02)}
    if flags & 0x01:
        maximum, offset = read_uleb(data, offset)
        limits["max"] = maximum
    return limits, offset


@dataclass(frozen=True)
class WasmImport:
    module: str
    name: str
    kind: str
    type_index: Optional[int] = None
    limits: Optional[dict] = None
    table_ref_type: Optional[int] = None

    def to_dict(self) -> dict:
        result = {"module": self.module, "name": self.name, "kind": self.kind}
        if self.type_index is not None:
            result["type_index"] = self.type_index
        if self.limits is not None:
            result["limits"] = dict(self.limits)
        if self.table_ref_type is not None:
            result["table_ref_type"] = self.table_ref_type
        return result


@dataclass(frozen=True)
class WasmExport:
    name: str
    kind: str
    index: int

    def to_dict(self) -> dict:
        return {"name": self.name, "kind": self.kind, "index": self.index}


@dataclass
class WasmInfo:
    sections: Dict[int, int] = field(default_factory=dict)  # id -> payload bytes
    imports: List[WasmImport] = field(default_factory=list)
    exports: List[WasmExport] = field(default_factory=list)
    defined_memory_pages: Optional[dict] = None
    defined_table: Optional[dict] = None
    element_segments: int = 0
    data_segments: int = 0
    global_count: int = 0
    function_count: int = 0

    def section_ids(self) -> List[int]:
        return sorted(self.sections)

    def import_names(self) -> List[str]:
        return ["%s.%s" % (entry.module, entry.name) for entry in self.imports]

    def function_imports(self) -> List[WasmImport]:
        return [entry for entry in self.imports if entry.kind == "function"]

    def has_section(self, section_id: int) -> bool:
        return section_id in self.sections

    def to_dict(self) -> dict:
        return {
            "bytes": len(self.raw),
            "sha256": None,  # filled by callers that need it
            "sections": [SECTION_NAMES.get(section, str(section))
                         for section in self.section_ids()],
            "section_ids": self.section_ids(),
            "imports": [entry.to_dict() for entry in self.imports],
            "exports": [entry.to_dict() for entry in self.exports],
            "defined_memory_pages": self.defined_memory_pages,
            "defined_table": self.defined_table,
            "element_segments": self.element_segments,
            "data_segments": self.data_segments,
            "global_count": self.global_count,
            "function_count": self.function_count,
        }

    raw: bytes = b""


def inspect_wasm(data: bytes) -> WasmInfo:
    """Parse the section structure, imports and exports of a wasm module."""
    if len(data) < 8 or data[:4] != WASM_MAGIC:
        raise WasmFormatError("not a WebAssembly module (bad magic)")
    version = int.from_bytes(data[4:8], "little")
    if version != WASM_VERSION:
        raise WasmFormatError("unsupported wasm version %d" % version)
    info = WasmInfo(raw=data)
    offset = 8
    while offset < len(data):
        section_id = data[offset]
        offset += 1
        size, offset = read_uleb(data, offset)
        end = offset + size
        if end > len(data):
            raise WasmFormatError("truncated section %d" % section_id)
        payload = data[offset:end]
        if section_id in info.sections:
            raise WasmFormatError("duplicate section %d" % section_id)
        info.sections[section_id] = payload
        if section_id == 2:
            info.imports = _parse_imports(payload)
        elif section_id == 4:
            info.defined_table = _parse_table(payload)
        elif section_id == 5:
            info.defined_memory_pages = _parse_memory(payload)
        elif section_id == 6:
            info.global_count = read_uleb(payload, 0)[0]
        elif section_id == 7:
            info.exports = _parse_exports(payload)
        elif section_id == 9:
            info.element_segments = read_uleb(payload, 0)[0]
        elif section_id == 10:
            info.function_count = read_uleb(payload, 0)[0]
        elif section_id == 11:
            info.data_segments = read_uleb(payload, 0)[0]
        offset = end
    return info


def _parse_imports(payload: bytes) -> List[WasmImport]:
    count, offset = read_uleb(payload, 0)
    imports: List[WasmImport] = []
    for _ in range(count):
        module, offset = _read_name(payload, offset)
        name, offset = _read_name(payload, offset)
        kind = payload[offset]
        offset += 1
        if kind not in IMPORT_KINDS:
            raise WasmFormatError("unknown import kind 0x%02x" % kind)
        if kind == 0x00:
            type_index, offset = read_uleb(payload, offset)
            imports.append(WasmImport(module, name, "function", type_index=type_index))
        elif kind == 0x01:
            ref_type = payload[offset]
            offset += 1
            limits, offset = _read_limits(payload, offset)
            imports.append(WasmImport(module, name, "table", limits=limits,
                                      table_ref_type=ref_type))
        elif kind == 0x02:
            limits, offset = _read_limits(payload, offset)
            imports.append(WasmImport(module, name, "memory", limits=limits))
        else:
            value_type = payload[offset]
            mutable = payload[offset + 1]
            offset += 2
            imports.append(WasmImport(module, name, "global",
                                      type_index=(value_type, mutable)))
    return imports


def _parse_exports(payload: bytes) -> List[WasmExport]:
    count, offset = read_uleb(payload, 0)
    exports: List[WasmExport] = []
    for _ in range(count):
        name, offset = _read_name(payload, offset)
        kind = payload[offset]
        offset += 1
        index, offset = read_uleb(payload, offset)
        if kind not in EXPORT_KINDS:
            raise WasmFormatError("unknown export kind 0x%02x" % kind)
        exports.append(WasmExport(name, EXPORT_KINDS[kind], index))
    return exports


def _parse_table(payload: bytes) -> dict:
    count, offset = read_uleb(payload, 0)
    if count != 1:
        raise WasmFormatError("expected exactly one defined table, got %d" % count)
    ref_type = payload[offset]
    offset += 1
    limits, _ = _read_limits(payload, offset)
    return {"ref_type": ref_type, **limits}


def _parse_memory(payload: bytes) -> dict:
    count, offset = read_uleb(payload, 0)
    if count != 1:
        raise WasmFormatError("expected exactly one defined memory, got %d" % count)
    limits, _ = _read_limits(payload, offset)
    return limits


__all__ = [
    "WasmInfo",
    "WasmImport",
    "WasmExport",
    "WasmFormatError",
    "inspect_wasm",
    "read_uleb",
    "SECTION_NAMES",
]

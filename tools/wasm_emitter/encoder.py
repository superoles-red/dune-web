"""Minimal WebAssembly (MVP, binary format 1) encoder — standard library only.

This module is the bottom layer of the on-device WASM backend
(``docs/WASM-BACKEND.md`` / ``docs/WASM-EMITTER.md``): it encodes a complete,
valid ``.wasm`` module without any compiler, dependency or toolchain.  It is
deliberately small and follows the binary format specification directly:

    section 1  type        function signatures (deduplicated)
    section 2  import      functions / memories / tables from another module
    section 3  function    type index of every defined function
    section 4  table       funcref tables (for the runtime-side indirect call)
    section 5  memory      linear memory (pages of 64 KiB)
    section 7  export      functions / memories / tables
    section 9  element     active funcref table initialisation
    section 10 code        function bodies

Instructions are emitted by appending one-opcode-at-a-time helpers (``Code``).
Only the subset the Dune backend needs is implemented: i32/i64 load/store,
i32 arithmetic/comparisons, ``block``/``loop``/``if``/``br``/``br_if``/
``br_table``/``return``/``call``/``call_indirect``/``local.*``.

Encoded values follow the spec exactly:
  * ``uleb128`` for counts/indices, ``sleb128`` for ``i32.const``/``i64.const``;
  * memarg = alignment exponent + offset (both unsigned LEB);
  * function index space = imported functions first, then defined functions.

Python 3.9+ compatible (no third-party packages, no 3.10 syntax).
"""

from __future__ import annotations

I32 = 0x7F
I64 = 0x7E
F32 = 0x7D
F64 = 0x7C
FUNCREF = 0x70

TYPE_FUNC = 0x60
EMPTY_BLOCK = 0x40

_U32_MAX = 0xFFFFFFFF
_U32_SIGN = 0x80000000
_U64_MAX = 0xFFFFFFFFFFFFFFFF
_U64_SIGN = 0x8000000000000000


def uleb128(value: int) -> bytes:
    """Unsigned LEB128 (counts, indices, sizes)."""
    if value < 0 or value > _U64_MAX:
        raise ValueError("uleb128 out of range: %r" % (value,))
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def sleb128(value: int) -> bytes:
    """Signed LEB128 (i32.const / i64.const immediates)."""
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        sign = byte & 0x40
        done = (value == 0 and not sign) or (value == -1 and sign)
        out.append(byte if done else (byte | 0x80))
        if done:
            return bytes(out)


def _as_u32(value: int) -> int:
    return value & _U32_MAX


def _as_s32(value: int) -> int:
    value &= _U32_MAX
    return value - 0x100000000 if value >= _U32_SIGN else value


def _as_s64(value: int) -> int:
    value &= _U64_MAX
    return value - 0x10000000000000000 if value >= _U64_SIGN else value


def _vec(items) -> bytes:
    items = list(items)
    return uleb128(len(items)) + b"".join(items)


def _name(text: str) -> bytes:
    encoded = text.encode("utf-8")
    return uleb128(len(encoded)) + encoded


def _limits(minimum: int, maximum) -> bytes:
    if maximum is None:
        return b"\x00" + uleb128(minimum)
    return b"\x01" + uleb128(minimum) + uleb128(maximum)


def _section(section_id: int, payload: bytes) -> bytes:
    if not payload:
        return b""
    return bytes([section_id]) + uleb128(len(payload)) + payload


class Code:
    """Appends instructions to one function body (without locals/end)."""

    __slots__ = ("data",)

    def __init__(self) -> None:
        self.data = bytearray()

    # -- raw / control -----------------------------------------------------
    def raw(self, payload: bytes) -> "Code":
        self.data += payload
        return self

    def unreachable(self) -> "Code":
        self.data.append(0x00)
        return self

    def nop(self) -> "Code":
        self.data.append(0x01)
        return self

    def block(self) -> "Code":
        self.data += b"\x02\x40"
        return self

    def loop(self) -> "Code":
        self.data += b"\x03\x40"
        return self

    def if_(self) -> "Code":
        self.data += b"\x04\x40"
        return self

    def else_(self) -> "Code":
        self.data.append(0x05)
        return self

    def end(self) -> "Code":
        self.data.append(0x0B)
        return self

    end_ = end  # pyflakes-friendly alias (block/if/function end is not a keyword)

    def br(self, depth: int) -> "Code":
        self.data.append(0x0C)
        self.data += uleb128(depth)
        return self

    def br_if(self, depth: int) -> "Code":
        self.data.append(0x0D)
        self.data += uleb128(depth)
        return self

    def br_table(self, labels, default: int) -> "Code":
        self.data.append(0x0E)
        self.data += _vec(uleb128(label) for label in labels)
        self.data += uleb128(default)
        return self

    def return_(self) -> "Code":
        self.data.append(0x0F)
        return self

    def call(self, func_index: int) -> "Code":
        self.data.append(0x10)
        self.data += uleb128(func_index)
        return self

    def call_indirect(self, type_index: int, table_index: int = 0) -> "Code":
        self.data.append(0x11)
        self.data += uleb128(type_index)
        self.data += uleb128(table_index)
        return self

    # -- locals / globals --------------------------------------------------
    def local_get(self, index: int) -> "Code":
        self.data.append(0x20)
        self.data += uleb128(index)
        return self

    def local_set(self, index: int) -> "Code":
        self.data.append(0x21)
        self.data += uleb128(index)
        return self

    def local_tee(self, index: int) -> "Code":
        self.data.append(0x22)
        self.data += uleb128(index)
        return self

    def drop(self) -> "Code":
        self.data.append(0x1A)
        return self

    # -- constants ---------------------------------------------------------
    def i32_const(self, value: int) -> "Code":
        self.data.append(0x41)
        self.data += sleb128(_as_s32(value))
        return self

    def i64_const(self, value: int) -> "Code":
        self.data.append(0x42)
        self.data += sleb128(_as_s64(value))
        return self

    # -- memory loads (align is a power-of-two exponent) -------------------
    def i32_load(self, offset: int = 0, align: int = 2) -> "Code":
        self.data.append(0x28)
        self.data += uleb128(align) + uleb128(offset)
        return self

    def i64_load(self, offset: int = 0, align: int = 3) -> "Code":
        self.data.append(0x29)
        self.data += uleb128(align) + uleb128(offset)
        return self

    def i32_load8_s(self, offset: int = 0, align: int = 0) -> "Code":
        self.data.append(0x2C)
        self.data += uleb128(align) + uleb128(offset)
        return self

    def i32_load8_u(self, offset: int = 0, align: int = 0) -> "Code":
        self.data.append(0x2D)
        self.data += uleb128(align) + uleb128(offset)
        return self

    def i32_load16_s(self, offset: int = 0, align: int = 1) -> "Code":
        self.data.append(0x2E)
        self.data += uleb128(align) + uleb128(offset)
        return self

    def i32_load16_u(self, offset: int = 0, align: int = 1) -> "Code":
        self.data.append(0x2F)
        self.data += uleb128(align) + uleb128(offset)
        return self

    # -- memory stores -----------------------------------------------------
    def i32_store(self, offset: int = 0, align: int = 2) -> "Code":
        self.data.append(0x36)
        self.data += uleb128(align) + uleb128(offset)
        return self

    def i64_store(self, offset: int = 0, align: int = 3) -> "Code":
        self.data.append(0x37)
        self.data += uleb128(align) + uleb128(offset)
        return self

    def i32_store8(self, offset: int = 0, align: int = 0) -> "Code":
        self.data.append(0x3A)
        self.data += uleb128(align) + uleb128(offset)
        return self

    def i32_store16(self, offset: int = 0, align: int = 1) -> "Code":
        self.data.append(0x3B)
        self.data += uleb128(align) + uleb128(offset)
        return self

    # -- i32 arithmetic / comparison --------------------------------------
    def i32_eqz(self) -> "Code":
        self.data.append(0x45)
        return self

    def i32_eq(self) -> "Code":
        self.data.append(0x46)
        return self

    def i32_ne(self) -> "Code":
        self.data.append(0x47)
        return self

    def i32_lt_u(self) -> "Code":
        self.data.append(0x49)
        return self

    def i32_gt_u(self) -> "Code":
        self.data.append(0x4B)
        return self

    def i32_le_u(self) -> "Code":
        self.data.append(0x4D)
        return self

    def i32_ge_u(self) -> "Code":
        self.data.append(0x4F)
        return self

    def i32_add(self) -> "Code":
        self.data.append(0x6A)
        return self

    def i32_sub(self) -> "Code":
        self.data.append(0x6B)
        return self

    def i32_mul(self) -> "Code":
        self.data.append(0x6C)
        return self

    def i32_and(self) -> "Code":
        self.data.append(0x71)
        return self

    def i32_or(self) -> "Code":
        self.data.append(0x72)
        return self

    def i32_xor(self) -> "Code":
        self.data.append(0x73)
        return self

    def i32_shl(self) -> "Code":
        self.data.append(0x74)
        return self

    def i32_shr_s(self) -> "Code":
        self.data.append(0x75)
        return self

    def i32_shr_u(self) -> "Code":
        self.data.append(0x76)
        return self

    def i32_rem_u(self) -> "Code":
        self.data.append(0x70)
        return self

    def i32_rem_s(self) -> "Code":
        self.data.append(0x6F)
        return self

    def i32_div_u(self) -> "Code":
        self.data.append(0x6E)
        return self

    # -- i64 arithmetic ----------------------------------------------------
    def i64_eqz(self) -> "Code":
        self.data.append(0x50)
        return self

    def i64_add(self) -> "Code":
        self.data.append(0x7C)
        return self

    def i64_sub(self) -> "Code":
        self.data.append(0x7D)
        return self

    def i64_and(self) -> "Code":
        self.data.append(0x83)
        return self

    def i64_or(self) -> "Code":
        self.data.append(0x84)
        return self

    def i64_shl(self) -> "Code":
        self.data.append(0x86)
        return self

    def i64_shr_u(self) -> "Code":
        self.data.append(0x88)
        return self

    def i64_extend_i32_u(self) -> "Code":
        self.data.append(0xAD)
        return self

    def i32_wrap_i64(self) -> "Code":
        self.data.append(0xA7)
        return self


class Func:
    """One defined function: signature, locals and body."""

    __slots__ = ("module", "index", "type_index", "params", "results", "locals", "code")

    def __init__(self, module: "Module", index: int, type_index: int, params, results):
        self.module = module
        self.index = index
        self.type_index = type_index
        self.params = list(params)
        self.results = list(results)
        self.locals = []  # list of value types, in local index order after params
        self.code = Code()

    def local(self, number: int) -> int:
        """Absolute local index of the ``number``-th declared local (after params)."""
        return len(self.params) + number

    def finish(self) -> "Func":
        return self


class Module:
    """Builds a complete ``.wasm`` module."""

    def __init__(self) -> None:
        self._types = []  # list[(tuple(params), tuple(results))]
        self._type_index = {}
        self._import_entries = []  # encoded import section entries
        self._import_func_count = 0
        self._funcs = []  # list[Func]
        self._frozen = False
        self._memory = None  # (min, max|None) of a defined memory
        self._table = None  # (min, max|None) of a defined table
        self._elements = []  # list[(offset, [func indices], table index)]
        self._exports = []  # list[(name, kind, index)]

    # -- types -------------------------------------------------------------
    def add_type(self, params, results=()) -> int:
        signature = (tuple(params), tuple(results))
        index = self._type_index.get(signature)
        if index is not None:
            return index
        index = len(self._types)
        self._types.append(signature)
        self._type_index[signature] = index
        return index

    # -- imports -----------------------------------------------------------
    def import_func(self, module: str, field: str, params, results=()) -> int:
        if self._frozen:
            raise RuntimeError("imports must be declared before defined functions")
        type_index = self.add_type(params, results)
        self._import_entries.append(
            _name(module) + _name(field) + b"\x00" + uleb128(type_index)
        )
        index = self._import_func_count
        self._import_func_count += 1
        return index

    def import_memory(self, module: str, field: str, minimum: int, maximum=None) -> int:
        if self._frozen:
            raise RuntimeError("imports must be declared before defined functions")
        self._import_entries.append(
            _name(module) + _name(field) + b"\x02" + _limits(minimum, maximum)
        )
        return 0

    def import_table(self, module: str, field: str, minimum: int, maximum=None) -> int:
        if self._frozen:
            raise RuntimeError("imports must be declared before defined functions")
        self._import_entries.append(
            _name(module)
            + _name(field)
            + b"\x01"
            + bytes([FUNCREF])
            + _limits(minimum, maximum)
        )
        return 0

    # -- definitions -------------------------------------------------------
    def define_memory(self, minimum: int, maximum=None) -> int:
        if self._memory is not None:
            raise RuntimeError("module already has a memory")
        self._memory = (minimum, maximum)
        return 0

    def define_table(self, minimum: int, maximum=None) -> int:
        if self._table is not None:
            raise RuntimeError("module already has a table")
        self._table = (minimum, maximum)
        return 0

    def element_funcs(self, func_indices, offset: int = 0, table_index: int = 0) -> None:
        """Active element segment: table[offset + i] = func_indices[i]."""
        self._elements.append((offset, list(func_indices), table_index))

    def declare_func(self, params, results=()) -> Func:
        self._frozen = True
        type_index = self.add_type(params, results)
        index = self._import_func_count + len(self._funcs)
        func = Func(self, index, type_index, params, results)
        self._funcs.append(func)
        return func

    # -- exports -----------------------------------------------------------
    def export_func(self, name: str, func_index: int) -> None:
        self._exports.append((name, 0x00, func_index))

    def export_table(self, name: str, table_index: int = 0) -> None:
        self._exports.append((name, 0x01, table_index))

    def export_memory(self, name: str, memory_index: int = 0) -> None:
        self._exports.append((name, 0x02, memory_index))

    # -- serialisation -----------------------------------------------------
    def _type_section(self) -> bytes:
        entries = [
            bytes([TYPE_FUNC])
            + _vec(bytes([value_type]) for value_type in params)
            + _vec(bytes([value_type]) for value_type in results)
            for params, results in self._types
        ]
        return _section(1, _vec(entries))

    def _import_section(self) -> bytes:
        return _section(2, _vec(self._import_entries))

    def _function_section(self) -> bytes:
        return _section(3, _vec(uleb128(func.type_index) for func in self._funcs))

    def _table_section(self) -> bytes:
        if self._table is None:
            return b""
        minimum, maximum = self._table
        table_type = bytes([FUNCREF]) + _limits(minimum, maximum)
        return _section(4, _vec([table_type]))

    def _memory_section(self) -> bytes:
        if self._memory is None:
            return b""
        minimum, maximum = self._memory
        return _section(5, _vec([_limits(minimum, maximum)]))

    def _export_section(self) -> bytes:
        entries = [
            _name(name) + bytes([kind]) + uleb128(index)
            for name, kind, index in self._exports
        ]
        return _section(7, _vec(entries))

    def _element_section(self) -> bytes:
        segments = []
        for offset, func_indices, table_index in self._elements:
            segments.append(
                uleb128(table_index)
                + b"\x41"
                + sleb128(_as_s32(offset))
                + b"\x0b"
                + _vec(uleb128(index) for index in func_indices)
            )
        return _section(9, _vec(segments))

    @staticmethod
    def _locals(types) -> bytes:
        groups = []  # runs of identical value types, WASM compresses them
        for value_type in types:
            if groups and groups[-1][1] == value_type:
                groups[-1][0] += 1
            else:
                groups.append([1, value_type])
        return _vec(uleb128(count) + bytes([value_type]) for count, value_type in groups)

    def _code_section(self) -> bytes:
        bodies = []
        for func in self._funcs:
            body = self._locals(func.locals) + bytes(func.code.data) + b"\x0B"
            bodies.append(uleb128(len(body)) + body)
        return _section(10, _vec(bodies))

    def build(self) -> bytes:
        header = b"\x00asm\x01\x00\x00\x00"
        return (
            header
            + self._type_section()
            + self._import_section()
            + self._function_section()
            + self._table_section()
            + self._memory_section()
            + self._export_section()
            + self._element_section()
            + self._code_section()
        )


if __name__ == "__main__":  # tiny smoke check: LEB128 round-trips
    def _decode_uleb(data, offset):
        result = shift = 0
        while True:
            byte = data[offset]
            offset += 1
            result |= (byte & 0x7F) << shift
            if not byte & 0x80:
                return result, offset
            shift += 7

    for value in (0, 1, 127, 128, 255, 300, 0xFFFF, 0xFFFFFFFF):
        encoded = uleb128(value)
        decoded, consumed = _decode_uleb(encoded, 0)
        assert decoded == value and consumed == len(encoded), (value, encoded)
    for value in (0, 1, -1, 63, 64, -64, -65, 127, 128, -128, 0x7FFFFFFF, -0x80000000):
        encoded = sleb128(value)
        # StringIO-free signed round-trip.
        result = shift = 0
        for byte in encoded:
            result |= (byte & 0x7F) << shift
            shift += 7
        if encoded[-1] & 0x40:
            result -= 1 << shift
        assert result == value, (value, encoded, result)
    print("wasm_emit: LEB128 self-test OK")

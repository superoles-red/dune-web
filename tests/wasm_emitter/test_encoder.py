"""Binary encoder tests: LEB128, module sections, table/element/execution."""

from __future__ import annotations

import unittest

from support import add_tools_path, node_path, validate_wasm_bytes

add_tools_path()

from wasm_emitter import encoder as w  # noqa: E402


class EncoderTests(unittest.TestCase):
    def test_uleb128_roundtrip(self):
        for value in (0, 1, 127, 128, 255, 300, 0xFFFF, 0xFFFFFFFF):
            encoded = w.uleb128(value)
            result = shift = 0
            for byte in encoded:
                result |= (byte & 0x7F) << shift
                shift += 7
            self.assertEqual(result, value)
            self.assertEqual(len(encoded), len(w.uleb128(value)))

    def test_sleb128_roundtrip(self):
        for value in (0, 1, -1, 63, 64, -64, -65, 127, 128, -128,
                      0x7FFFFFFF, -0x80000000):
            encoded = w.sleb128(value)
            result = shift = 0
            for byte in encoded:
                result |= (byte & 0x7F) << shift
                shift += 7
            if encoded[-1] & 0x40:
                result -= 1 << shift
            self.assertEqual(result, value)

    def test_module_valid_and_executes(self):
        module = w.Module()
        inc = module.import_func("env", "inc", [w.I32], [w.I32])
        func = module.declare_func([], [w.I32])
        func.code.i32_const(41)
        func.code.call(inc)
        func.code.return_()
        module.export_func("answer", func.index)
        data = module.build()
        self.assertTrue(validate_wasm_bytes(data))
        if node_path() is None:
            self.skipTest("node is not installed")
        process = w_run_node(
            "const fs=require('fs');const b=fs.readFileSync(process.argv[1]);"
            "WebAssembly.instantiate(b,{env:{inc:x=>x+1}}).then(({instance})=>"
            "console.log(instance.exports.answer()));",
            data,
        )
        self.assertIsNotNone(process)
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertEqual(process.stdout.strip(), "42")

    def test_table_element_and_call_indirect(self):
        module = w.Module()
        module.define_memory(1)
        module.define_table(1, 1)
        type_index = module.add_type([w.I32], [w.I32])
        callee = module.declare_func([w.I32], [w.I32])
        callee.code.local_get(0)
        callee.code.i32_const(1)
        callee.code.i32_add()
        callee.code.return_()
        caller = module.declare_func([], [w.I32])
        caller.code.i32_const(41)
        caller.code.i32_const(0)
        caller.code.call_indirect(type_index, 0)
        caller.code.return_()
        module.element_funcs([callee.index])
        module.export_func("caller", caller.index)
        module.export_table("__indirect_function_table")
        module.export_memory("memory")
        data = module.build()
        self.assertTrue(validate_wasm_bytes(data))
        self.assertGreater(len(data), 8)


def w_run_node(script: str, data: bytes):
    import tempfile
    from pathlib import Path

    from support import run_node

    with tempfile.NamedTemporaryFile(suffix=".wasm", delete=False) as handle:
        handle.write(data)
        path = handle.name
    try:
        return run_node(script, path)
    finally:
        Path(path).unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()

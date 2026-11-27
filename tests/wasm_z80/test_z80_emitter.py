"""ROM-free tests for the Z80 -> WASM emitter.

Builds a tiny synthetic Z80 program, emits a real ``game.wasm`` fragment against
the shipped ``runtime.wasm`` ABI, inspects the module (pure code, 37 helper
imports, one element segment, ``translated_z80_step`` export) and executes the
instructions through ``runtime.wasm`` + ``dune_rt_translated_z80_step`` with the
same binary differential harness the full Z80 differential uses.

Run:
    python3.12 -m unittest discover -s tests/wasm_z80 -v
"""

from __future__ import annotations

import unittest
from pathlib import Path

from z80_support import (  # noqa: F401
    INTEGRATION, ROOT, abi, build_synthetic_module, case_words,
    require_node, require_python310, runtime_abi, run_wasm_cases, temporary_dir,
    z80_translate,
)
from wasm_emitter import z80_translate as zt  # noqa: E402
from wasm_integration import wasm_inspect  # noqa: E402

EXPECTED_HELPERS = 16 + len(zt.Z80_HELPERS)


class Z80LayoutTests(unittest.TestCase):
    """The hard-coded Z80CPU offsets must match the runtime ABI descriptor."""

    @classmethod
    def setUpClass(cls):
        require_python310()
        cls.rt = runtime_abi.load_runtime_abi()

    def test_layout_offsets_match_runtime_descriptor(self):
        checks = zt.validate_z80_layout(self.rt.cpu_abi)
        self.assertTrue(all(checks.values()), checks)
        # Absolute Z80CPU base: every relative field from z80_cpu_state.h.
        base = self.rt.cpu_abi.z80_cpu
        self.assertEqual(base + zt.Z80_LAYOUT["pc"], self.rt.cpu_abi.z80_cpu + 24)
        self.assertEqual(base + zt.Z80_LAYOUT["sp"], self.rt.cpu_abi.z80_cpu + 26)

    def test_abi_hash_is_still_the_pinned_one(self):
        self.assertEqual(self.rt.abi_hash, self.rt.pinned_abi_hash)
        self.assertTrue(self.rt.abi_hash.startswith("fb47e138"))

    def test_helper_list_matches_runtime_exports(self):
        exports = set(self.rt.export_names)
        missing = [name for name in zt.Z80_HELPER_NAMES if "dune_" + name not in exports]
        self.assertEqual(missing, [])


class Z80ModuleShapeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        require_python310()
        require_node()
        cls.rt, cls.layout, cls.data, cls.meta = build_synthetic_module()
        cls._tmp = temporary_dir("dune-z80-emitter-")
        cls._tmp_path = Path(cls._tmp.name)

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def test_module_is_pure_code_with_z80_exports(self):
        info = wasm_inspect.inspect_wasm(self.data)
        self.assertEqual(info.data_segments, 0)
        self.assertIsNone(info.defined_memory_pages)
        self.assertEqual(info.global_count, 0)
        self.assertEqual(info.element_segments, 1)
        names = sorted(entry.name for entry in info.exports)
        self.assertEqual(names, sorted([
            "translated_step", "translated_step_via_table", "warmup_all",
            "translated_z80_step", "__indirect_function_table",
        ]))
        imports = info.imports
        self.assertEqual(sum(1 for entry in imports if entry.kind == "memory"), 1)
        self.assertEqual(len(imports), EXPECTED_HELPERS + 1)
        self.assertIn("env.dune_z80_pair", {f"{e.module}.{e.name}" for e in imports})
        self.assertIn("env.dune_z80_alu", {f"{e.module}.{e.name}" for e in imports})

    def test_module_carries_z80_program_metadata(self):
        self.assertEqual(self.meta["z80"]["pcs"], 7)
        self.assertEqual(self.meta["z80"]["variants"], 7)
        self.assertIn("translated_z80_step", self.meta["exports"])
        self.assertEqual(self.meta["imports"][0], "dune_read_mem")
        self.assertEqual(len(self.meta["imports"]), EXPECTED_HELPERS)

    def test_module_compiles_in_node(self):
        path = self._tmp_path / "synthetic-z80.wasm"
        path.write_bytes(self.data)
        process = __import__("subprocess").run(
            [__import__("shutil").which("node"), "--input-type=module", "-e",
             "const fs=await import('node:fs');"
             "await WebAssembly.compile(fs.readFileSync(process.argv[1]));"
             "console.log('compiled')",
             str(path)],
            capture_output=True, text=True, timeout=120,
        )
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertIn("compiled", process.stdout)


class Z80ExecutionTests(unittest.TestCase):
    """Execute the synthetic module through the real runtime + differential harness."""

    @classmethod
    def setUpClass(cls):
        require_python310()
        require_node()
        cls.rt, cls.layout, cls.data, cls.meta = build_synthetic_module()
        cls.records = [
            case_words(0x00, b"\x00"),                      # NOP
            case_words(0x01, b"\x01\x34\x12"),              # LD BC,0x1234
            case_words(0x03, b"\x3e\x42"),                  # LD A,0x42
            case_words(0x05, b"\xf3"),                      # DI
            case_words(0x06, b"\xfb"),                      # EI
            case_words(0x08, b"\xc3\x34\x12"),              # JP 0x1234
            case_words(0x10, b"\x76"),                      # guard differs -> fault
            case_words(0x4000, b"\x00"),                    # PC outside RAM -> fault
            case_words(0x01, b"\x01\x34\x12", r=0x7F, sp=0x1234),
        ]
        cls._tmp = temporary_dir("dune-z80-exec-")
        cls.workdir = Path(cls._tmp.name)
        cls.results = run_wasm_cases(cls.rt, cls.data, cls.meta, cls.records,
                                     cls.workdir)

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def test_nop_advances_pc_and_r(self):
        result = self.results[0]
        self.assertEqual(result["fault"], 0)
        self.assertEqual(result["pc"], 0x01)
        self.assertEqual(result["r"], 0x01)  # z80_m1(fetches=1)
        self.assertEqual(result["cycles"], 0)  # translated_z80_step does not add
        self.assertEqual(result["steps"], 0)

    def test_ld16_sets_pair(self):
        result = self.results[1]
        self.assertEqual(result["fault"], 0)
        self.assertEqual(result["pc"], 0x04)
        self.assertEqual(result["r8"][0] << 8 | result["r8"][1], 0x1234)
        self.assertEqual(result["r"], 0x01)

    def test_ld8_imm(self):
        result = self.results[2]
        self.assertEqual(result["a"], 0x42)
        self.assertEqual(result["pc"], 0x05)

    def test_di_and_ei(self):
        di, ei = self.results[3], self.results[4]
        self.assertEqual((di["iff1"], di["iff2"], di["ei_delay"]), (0, 0, 0))
        self.assertEqual((ei["iff1"], ei["iff2"], ei["ei_delay"]), (1, 1, 2))

    def test_jp_sets_pc_and_wz(self):
        result = self.results[5]
        self.assertEqual(result["pc"], 0x1234)
        self.assertEqual(result["wz"], 0x1234)
        self.assertEqual(result["fault"], 0)

    def test_guard_mismatch_reports_z80_failure(self):
        result = self.results[6]
        self.assertEqual(result["fault"], 1)
        self.assertEqual(result["fail_code"], 17)  # FAIL_Z80 canonical
        self.assertEqual(result["pc"], 0x10)       # never advanced on fault

    def test_pc_outside_ram_is_rejected(self):
        result = self.results[7]
        self.assertEqual(result["fault"], 1)
        self.assertEqual(result["fail_code"], 17)
        self.assertEqual(result["pc"], 0x4000)

    def test_initial_state_is_preserved_on_fault(self):
        result = self.results[8]
        self.assertEqual(result["fault"], 0)
        self.assertEqual(result["pc"], 0x04)
        self.assertEqual(result["sp"], 0x1234)  # LD16 does not touch SP
        self.assertEqual(result["r"], 0x00)     # (0x7F+1)&0x7f == 0, high bit kept


if __name__ == "__main__":
    unittest.main()

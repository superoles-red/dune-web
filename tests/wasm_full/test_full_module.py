"""Tests for the single all-pages ``game.wasm`` (``.local/wasm-full/game.wasm``).

Two layers, per the BYOP rule:

* **No ROM needed** (runs in CI): a full-shaped synthetic module against the real
  ``runtime.wasm`` ABI proves the module stays pure code (no data segments, no
  memory, no globals), exports exactly the five full-module symbols (including
  the honest ``translated_z80_step`` UNTRANSLATED stub), links into the runtime
  as ``GAME_MODE_SINGLE`` and reports the canonical UNTRANSLATED code when the
  Z80 slot is executed.
* **With a ROM** (skipped otherwise: set ``DUNE_ROM`` and ``DUNE_BASELINE``):
  build the real module for all 48 pages / 40 382 instructions, prove its
  structure and that it embeds no ROM bytes, link it with ``runtime.wasm``, and
  run a smoke differential across every page (1 instruction per page x 2 states
  = 96 cases, 0 mismatches).

Run:
    DUNE_ROM=... DUNE_BASELINE=... python3.12 -m unittest discover -s tests/wasm_full -v
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

_TESTS = Path(__file__).resolve().parents[1]
_INTEGRATION_TESTS = _TESTS / "wasm_integration"
if str(_INTEGRATION_TESTS) not in sys.path:
    sys.path.insert(0, str(_INTEGRATION_TESTS))

from support import (  # noqa: E402
    INTEGRATION,
    ROOT,
    add_tools_path,
    add_vendor_path,
    external_inputs,
    git_output,
    load_json_stdout,
    require_node,
    require_python310,
    run_node,
    run_python,
    temporary_dir,
)

add_tools_path()
add_vendor_path()

from synthetic import SyntheticProgram, synthetic_instructions  # noqa: E402
from wasm_emitter import game_module  # noqa: E402
from wasm_integration import (  # noqa: E402
    build_full_module, runtime_abi, wasm_inspect,
)

LINK_SCRIPT = INTEGRATION / "link_and_run.mjs"
BUILD_SCRIPT = INTEGRATION / "build_full_module.py"
CHECK_SCRIPT = INTEGRATION / "check_full_integration.py"
DEFAULT_FULL_DIR = ROOT / ".local" / "wasm-full"
LOCAL_TEST_DIR = DEFAULT_FULL_DIR / "tests"
FULL_EXPORTS = (
    "translated_step", "translated_step_via_table", "translated_z80_step",
    "warmup_all", "__indirect_function_table",
)


class FullModuleStructureTests(unittest.TestCase):
    """ROM-free: module shape, z80 stub, link into runtime.wasm."""

    @classmethod
    def setUpClass(cls):
        require_python310()
        cls.node = require_node()
        cls.rt = runtime_abi.load_runtime_abi()
        cls.cpu_abi = cls.rt.cpu_abi
        cls.program = SyntheticProgram(synthetic_instructions())
        cls.layout = cls.rt.memory_layout(0x10000)
        cls.data, cls.module_meta = game_module.build_module(
            cls.program, synthetic_instructions(), cls.cpu_abi, cls.layout,
            label="synthetic-full", helper_prefix="dune_",
            fail_code_map=dict(cls.rt.fail_codes.canonical_to_runtime),
            z80_stub=True, instruction_meta=False,
        )

    def test_module_is_pure_code_with_full_exports(self):
        info = wasm_inspect.inspect_wasm(self.data)
        self.assertEqual(info.data_segments, 0)
        self.assertIsNone(info.defined_memory_pages)
        self.assertEqual(info.global_count, 0)
        self.assertNotIn(5, info.section_ids(), "module defines its own memory")
        self.assertNotIn(11, info.section_ids(), "module has a data section")
        self.assertEqual(info.element_segments, 1)
        self.assertEqual(sorted(entry.name for entry in info.exports),
                         sorted(FULL_EXPORTS))
        self.assertEqual({entry.kind for entry in info.imports},
                         {"function", "memory"})
        self.assertEqual(sum(1 for entry in info.imports if entry.kind == "memory"), 1)

    def test_runtime_abi_accepts_the_full_module(self):
        info = wasm_inspect.inspect_wasm(self.data)
        checks = runtime_abi.verify_game_module(
            info, self.rt.export_names, "dune_",
            expected_exports=FULL_EXPORTS,
        )
        self.assertEqual(checks["data_segments"], 0)
        self.assertIsNone(checks["defined_memory"])
        self.assertEqual(len(checks["imports"]), 17)  # 16 helpers + env.memory
        self.assertEqual(sorted(checks["exports"]), sorted(FULL_EXPORTS))
        self.assertIn("translated_z80_step", self.module_meta["build"]["exports"])

    def _meta(self) -> dict:
        return {
            "format": build_full_module.META_FORMAT,
            "page": None,
            "instruction_count": self.module_meta["instruction_count"],
            "runtime_abi": self.rt.to_dict(),
            "runtime_abi_hash": self.rt.abi_hash,
            "pinned_abi_hash": self.rt.pinned_abi_hash,
            "abi": self.cpu_abi.to_dict(),
            "memory": self.layout.to_dict(),
            "fail_codes": {
                **self.rt.fail_codes.to_dict(),
                "untranslated_canonical": 1,
            },
            "module": {
                "bytes": len(self.data),
                "sha256": build_full_module.hashlib.sha256(self.data).hexdigest(),
            },
        }

    def test_links_into_runtime_with_z80_stub(self):
        with temporary_dir("dune-full-synthetic-") as tmp:
            directory = Path(tmp)
            wasm_path = directory / "game.wasm"
            meta_path = directory / "meta.json"
            wasm_path.write_bytes(self.data)
            meta_path.write_text(json.dumps(self._meta()), encoding="utf-8")
            process = run_node(
                LINK_SCRIPT,
                "--runtime", str(self.rt.runtime),
                "--loader", str(self.rt.loader),
                "--game", str(wasm_path),
                "--meta", str(meta_path),
                "--verify-only",
            )
            report = load_json_stdout(process)
            self.assertEqual(process.returncode, 0, process.stderr[-4000:])
            link = report["link"]
            self.assertTrue(report["ok"], json.dumps(link, indent=1))
            self.assertEqual(link["helper_imports"], 16)
            self.assertTrue(link["memory_identity"])
            self.assertEqual(link["game_table_mode"], 2)
            self.assertTrue(link["game_z80_export"])
            self.assertTrue(link["game_z80_slot_ok"])
            self.assertNotEqual(link["game_z80_slot"], 0)
            self.assertTrue(link["game_via_table_smoke"]["ok"])
            # The z80 stub must fail with the canonical UNTRANSLATED code.
            smoke = link["z80_stub_smoke"]
            self.assertIsNotNone(smoke, "z80 stub was not exercised")
            self.assertTrue(smoke["ok"], json.dumps(smoke, indent=1))
            self.assertEqual(smoke["cycles"], 0)
            self.assertEqual(smoke["fault_code"], 1)
            self.assertNotEqual(smoke["fault"], 0)

    def test_build_rejects_missing_rom(self):
        with self.assertRaises(build_full_module.BuildError):
            build_full_module.build_full_game_module(
                Path("/nonexistent/dune.gen"), runtime_descriptor=self.rt,
                write=False,
            )


class FullModuleTests(unittest.TestCase):
    """ROM-dependent: build the real all-pages module and link it."""

    @classmethod
    def setUpClass(cls):
        cls.rom, cls.baseline = external_inputs()
        require_python310()
        require_node()
        cls._tmp = temporary_dir("dune-wasm-full-")
        cls.out_dir = Path(cls._tmp.name)
        cls.build = build_full_module.build_full_game_module(
            cls.rom, out_dir=cls.out_dir, write=True,
        )
        cls.wasm_bytes = Path(cls.build["artifacts"]["wasm"]).read_bytes()
        cls.meta = json.loads(
            Path(cls.build["artifacts"]["meta"]).read_text(encoding="utf-8")
        )

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def test_all_pages_and_instructions_are_in_one_module(self):
        self.assertTrue(self.build["ok"])
        self.assertEqual(self.build["page_count"], 48)
        self.assertEqual(self.build["pages"], sorted(self.build["pages"]))
        self.assertEqual(self.build["instructions"], 40382)
        self.assertEqual(self.meta["instruction_count"], 40382)
        self.assertEqual(self.meta["page_count"], 48)
        self.assertEqual(len(self.meta["page_instruction_counts"]), 48)
        expected = {"translated_step", "translated_step_via_table",
                    "translated_z80_step", "warmup_all",
                    "__indirect_function_table"}
        self.assertEqual(set(self.build["checks"]["exports"]), expected)
        self.assertEqual(self.build["abi"]["hash"], self.build["abi"]["pinned_hash"])
        self.assertEqual(self.build["abi"]["pointer_bits"], 32)
        self.assertEqual(self.build["lossy_fail_codes_used"], [])

    def test_module_size_and_generation_time(self):
        module = self.build["module"]
        self.assertGreater(module["bytes"], 3_000_000)
        self.assertLess(module["bytes"], 4_500_000)
        self.assertLess(module["bytes"], 4 * 1024 * 1024,
                        "game.wasm must stay below the guard's 4 MiB limit")
        self.assertGreater(module["handler_bytes"], 3_000_000)
        self.assertLess(self.build["timing_ms"]["build"], 10_000.0,
                        "generation must stay under 10 s")
        self.assertGreater(module["bytes_per_instruction"], 60.0)
        self.assertLess(module["bytes_per_instruction"], 100.0)

    def test_artifact_sha_matches_meta(self):
        module = self.build["module"]
        self.assertEqual(self.meta["module"]["sha256"], module["sha256"])
        self.assertEqual(self.meta["module"]["bytes"], len(self.wasm_bytes))
        self.assertEqual(self.meta["format"], build_full_module.META_FORMAT)
        self.assertEqual(self.meta["runtime_abi_hash"],
                         self.build["abi"]["hash"])
        self.assertEqual(self.meta["runtime_abi_hash"],
                         self.meta["pinned_abi_hash"])

    def test_built_module_has_no_data_segments_or_rom_memory(self):
        info = wasm_inspect.inspect_wasm(self.wasm_bytes)
        self.assertEqual(info.data_segments, 0)
        self.assertIsNone(info.defined_memory_pages)
        self.assertEqual(info.global_count, 0)
        self.assertNotIn(5, info.section_ids(), "module defines its own memory")
        self.assertNotIn(11, info.section_ids(), "module has a data section")
        self.assertEqual(info.element_segments, 1)
        self.assertEqual(len(info.imports), 17)
        # Imports are exactly the runtime's exports (identity is checked at link).
        runtime_exports = set(self.build["meta"]["runtime_abi"].get("exports") or [])
        if runtime_exports:
            for entry in info.function_imports():
                self.assertIn(entry.name, runtime_exports)

    def test_built_module_does_not_contain_rom_windows(self):
        rom = self.rom.read_bytes()
        window = 16
        probes = 0
        stride = max(window, len(rom) // 256)
        for offset in range(0, len(rom) - window, stride):
            probe = rom[offset:offset + window]
            self.assertNotIn(probe, self.wasm_bytes,
                             "ROM bytes at 0x%x are embedded in game.wasm" % offset)
            probes += 1
        self.assertGreaterEqual(probes, 200)

    def test_full_module_links_into_runtime(self):
        process = run_node(
            LINK_SCRIPT,
            "--runtime", str(self.build["meta"]["runtime_abi"]["runtime_wasm"]),
            "--loader", str(self.build["meta"]["runtime_abi"]["loader_mjs"]),
            "--game", self.build["artifacts"]["wasm"],
            "--meta", self.build["artifacts"]["meta"],
            "--verify-only",
        )
        report = load_json_stdout(process)
        self.assertEqual(process.returncode, 0, process.stderr[-4000:])
        self.assertTrue(report["ok"])
        link = report["link"]
        self.assertEqual(link["helper_imports"], 16)
        self.assertTrue(link["memory_identity"])
        self.assertEqual(link["game_table_mode"], 2)
        self.assertTrue(link["game_z80_export"])
        self.assertTrue(link["game_z80_slot_ok"])
        self.assertTrue(link["game_indirect_table_ok"])
        self.assertTrue(link["game_via_table_smoke"]["ok"])
        self.assertGreater(link["warmup_ms"], 0.0)
        self.assertTrue(link["z80_stub_smoke"]["ok"])
        self.assertEqual(report["game"]["instructions"], 40382)

    def test_cli_builds_the_same_artifact(self):
        with temporary_dir("dune-wasm-full-cli-") as tmp:
            process = run_python(
                BUILD_SCRIPT,
                "--rom", str(self.rom),
                "--out", str(Path(tmp)),
            )
            self.assertEqual(process.returncode, 0,
                             process.stdout[-4000:] + process.stderr[-4000:])
            self.assertIn("PASS: one game.wasm covers all 48 pages", process.stdout)
            self.assertIn("game.wasm: SHA-256", process.stdout)
            wasm = Path(tmp) / "game.wasm"
            meta = Path(tmp) / "meta.json"
            self.assertTrue(wasm.is_file())
            self.assertTrue(meta.is_file())
            self.assertEqual(wasm.read_bytes(), self.wasm_bytes)


class FullDifferentialSmokeTests(unittest.TestCase):
    """ROM-dependent: linked differential across every page (smoke size)."""

    def test_smoke_differential_covers_all_pages(self):
        rom, baseline = external_inputs()
        require_python310()
        require_node()
        out_dir = LOCAL_TEST_DIR
        process = run_python(
            CHECK_SCRIPT,
            "--rom", str(rom),
            "--baseline", str(baseline),
            "--per-page", "1",
            "--cases", "2",
            "--min-instructions", "48",
            "--out", str(out_dir),
            timeout=3600,
        )
        self.assertEqual(
            process.returncode, 0,
            "check_full_integration failed:\n%s\n%s"
            % (process.stdout[-8000:], process.stderr[-4000:]),
        )
        self.assertIn("PASS: full module:", process.stdout)
        self.assertIn("mismatches: 0", process.stdout)
        report = json.loads(
            (out_dir / "differential.json").read_text(encoding="utf-8")
        )
        self.assertTrue(report["ok"])
        self.assertEqual(report["game"]["page_count"], 48)
        self.assertEqual(report["selection"]["pages"], 48)
        self.assertEqual(report["selection"]["instructions"], 48)
        differential = report["differential"]
        self.assertEqual(differential["cases"], 48 * 2)
        self.assertEqual(differential["mismatch_cases"], 0)
        self.assertEqual(differential["mismatches"], [])
        self.assertEqual(differential["oracle_faults"], differential["wasm_faults"])
        self.assertTrue(report["fault_histogram_ok"])
        self.assertTrue(report["link"]["z80_stub_smoke"]["ok"])


class FullArtifactIsNotCommittedTests(unittest.TestCase):
    def test_default_artifact_paths_are_gitignored(self):
        for relative in (".local/wasm-full/game.wasm",
                         ".local/wasm-full/meta.json",
                         ".local/wasm-full/differential.json"):
            git_output("check-ignore", "-q", relative)
            with self.assertRaises(AssertionError):
                git_output("ls-files", "--error-unmatch", relative)


if __name__ == "__main__":
    unittest.main()

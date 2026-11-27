"""No game data may leave ``.local/`` / enter the repository or the wasm.

Two layers:

* ROM-free: the BYOP guard script, a scan of every tracked file for game-data
  file types / one-ROM-sized blobs / generated ``rom_data[]`` arrays, and the
  structural proof that a generated module has no data segments, no memory and
  no globals (it is pure code).
* With a ROM (skipped otherwise): build the real page module into a temporary
  directory and prove the artifact contains no ROM bytes and that the default
  artifact directory is gitignored.
"""

from __future__ import annotations

import unittest
from pathlib import Path

from support import (
    ROOT,
    add_tools_path,
    add_vendor_path,
    external_inputs,
    git_output,
    require_python310,
    run_python,
    temporary_dir,
)

add_tools_path()
add_vendor_path()

from synthetic import SyntheticProgram, synthetic_instructions  # noqa: E402
from wasm_emitter import game_module  # noqa: E402
from wasm_integration import build_page_module, runtime_abi, wasm_inspect  # noqa: E402

GAME_DATA_SUFFIXES = {".gen", ".smd", ".nes", ".sfc", ".bin", ".rom", ".zip", ".7z"}
ROM_BYTES = 1048576


class NoGameDataTests(unittest.TestCase):
    def test_byop_guard_script_passes(self):
        process = run_python(Path(ROOT) / "tools" / "check_no_game_data.py")
        self.assertEqual(process.returncode, 0, process.stdout + process.stderr)
        self.assertIn("game-data check: OK", process.stdout)

    def test_no_game_data_files_are_tracked(self):
        tracked = [line for line in git_output("ls-files").splitlines() if line.strip()]
        problems = []
        for relative in tracked:
            path = Path(ROOT) / relative
            if path.suffix.lower() in GAME_DATA_SUFFIXES:
                problems.append("game-data file tracked: %s" % relative)
            if relative.startswith(".local/"):
                problems.append("local artifact tracked: %s" % relative)
            # runtime/wasm/stub_game.wasm is a hand-written Phase-1 stub, not a
            # generated game module: it contains no game data by construction.
            if relative.endswith("game.wasm") and relative != "runtime/wasm/stub_game.wasm":
                problems.append("generated game module tracked: %s" % relative)
            if path.is_file() and path.stat().st_size == ROM_BYTES:
                problems.append("file is exactly one Sega ROM: %s" % relative)
        self.assertEqual(problems, [])

    def test_integration_sources_carry_no_rom_blob(self):
        for directory in (Path(ROOT) / "tools" / "wasm_integration",
                          Path(ROOT) / "tests" / "wasm_integration"):
            for path in sorted(directory.rglob("*")):
                if not path.is_file() or path.suffix == ".pyc":
                    continue
                if path.suffix.lower() in GAME_DATA_SUFFIXES:
                    self.fail("game-data file in integration sources: %s" % path)
                data = path.read_bytes()
                needle = b"static const uint8_t " + b"rom_data[]"
                self.assertNotIn(needle, data,
                                 "generated ROM data embedded in %s" % path)
                self.assertLess(len(data), 256 * 1024,
                                "suspiciously large source artifact: %s" % path)

    def test_synthetic_game_module_has_no_data_sections(self):
        require_python310()
        rt = runtime_abi.load_runtime_abi()
        program = SyntheticProgram(synthetic_instructions())
        layout = rt.memory_layout(0x10000)
        data, _ = game_module.build_module(
            program, synthetic_instructions(), rt.cpu_abi, layout,
            label="synthetic", helper_prefix="dune_",
            fail_code_map=dict(rt.fail_codes.canonical_to_runtime),
        )
        info = wasm_inspect.inspect_wasm(data)
        self.assertEqual(info.data_segments, 0)
        self.assertIsNone(info.defined_memory_pages)
        self.assertEqual(info.global_count, 0)
        self.assertNotIn(5, info.section_ids(), "module defines its own memory")
        self.assertNotIn(11, info.section_ids(), "module has a data section")
        self.assertLess(len(data), 64 * 1024)
        # Imports are only the shared memory and the runtime helpers.
        self.assertEqual({entry.kind for entry in info.imports}, {"function", "memory"})
        self.assertEqual(sum(1 for entry in info.imports if entry.kind == "memory"), 1)

    def test_default_artifact_directory_is_gitignored(self):
        process = run_python(
            Path(ROOT) / "tools" / "check_no_game_data.py", timeout=120
        )
        self.assertEqual(process.returncode, 0)
        for relative in (".local/wasm-integration/page_013.wasm",
                         ".local/wasm-integration/page_013.meta.json",
                         ".local/wasm-integration/report.json"):
            ignored = git_output("check-ignore", "-q", relative)
            self.assertEqual(ignored, "")  # check-ignore -q prints nothing on success
            with self.assertRaises(AssertionError):
                git_output("ls-files", "--error-unmatch", relative)


class PageArtifactNoGameDataTests(unittest.TestCase):
    """ROM-dependent: the real artifact must not embed the ROM."""

    @classmethod
    def setUpClass(cls):
        cls.rom, cls.baseline = external_inputs()
        require_python310()
        cls._tmp = temporary_dir("dune-integration-nogamedata-")
        cls.build = build_page_module.build_page_game_module(
            cls.rom, 0x13, out_dir=Path(cls._tmp.name), write=True,
        )
        cls.wasm_bytes = Path(cls.build["artifacts"]["wasm"]).read_bytes()

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def test_built_module_has_no_data_segments(self):
        info = wasm_inspect.inspect_wasm(self.wasm_bytes)
        self.assertEqual(info.data_segments, 0)
        self.assertIsNone(info.defined_memory_pages)
        self.assertEqual(info.global_count, 0)
        self.assertNotIn(5, info.section_ids(), "module defines its own memory")
        self.assertNotIn(11, info.section_ids(), "module has a data section")
        self.assertLess(len(self.wasm_bytes), 128 * 1024,
                        "page module is implausibly large for pure code")

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

    def test_artifacts_live_only_in_the_requested_local_directory(self):
        wasm = Path(self.build["artifacts"]["wasm"])
        self.assertTrue(wasm.is_file())
        with self.assertRaises(AssertionError):
            git_output("ls-files", "--error-unmatch", str(wasm))


if __name__ == "__main__":
    unittest.main()

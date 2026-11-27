"""End-to-end differential: real ROM page through runtime.wasm + game.wasm.

Skipped without external ROM/baseline (BYOP): set ``DUNE_ROM`` and
``DUNE_BASELINE`` to run it.  ``DUNE_WASM_FAST=1`` lowers the state count for a
quick local loop (the acceptance run uses 200 states * 78 instructions).

The test asserts the *linked* run (runtime.wasm's dispatcher calling the
generated game module through its funcref table) matches the native C oracle
byte-for-byte: registers, PC, USP/SSP, SR, instruction cycles, halted/fault,
fault address + reason code, and both 64 KiB RAM digests.
"""

from __future__ import annotations

import json
import os
import unittest
from pathlib import Path

from support import (
    INTEGRATION,
    ROOT,
    add_tools_path,
    add_vendor_path,
    external_inputs,
    require_node,
    require_python310,
    run_python,
)

add_tools_path()
add_vendor_path()


class PageDifferentialTests(unittest.TestCase):
    def test_check_integration_end_to_end(self):
        rom, baseline = external_inputs()
        require_python310()
        require_node()
        fast = os.environ.get("DUNE_WASM_FAST") == "1"
        cases = 20 if fast else 200
        out_dir = ROOT / ".local" / "wasm-integration" / "tests"
        process = run_python(
            Path(INTEGRATION) / "check_integration.py",
            "--rom", str(rom),
            "--baseline", str(baseline),
            "--cases", str(cases),
            "--out", str(out_dir),
            timeout=3600,
        )
        self.assertEqual(
            process.returncode, 0,
            "check_integration failed:\n%s\n%s"
            % (process.stdout[-8000:], process.stderr[-4000:]),
        )
        self.assertIn("PASS:", process.stdout)
        self.assertIn("mismatches: 0", process.stdout)

        report_path = out_dir / "report.json"
        self.assertTrue(report_path.is_file())
        report = json.loads(report_path.read_text(encoding="utf-8"))
        self.assertTrue(report["ok"])
        self.assertEqual(report["page"], 0x13)
        self.assertEqual(report["game"]["instructions"], 78)
        self.assertEqual(report["abi"]["source"], "runtime.wasm:dune_abi_descriptor()")
        self.assertEqual(report["abi"]["hash"], report["abi"]["pinned_hash"])
        self.assertEqual(report["abi"]["pointer_bits"], 32)

        differential = report["differential"]
        self.assertEqual(differential["cases"], 78 * cases)
        self.assertEqual(differential["mismatch_cases"], 0)
        self.assertEqual(differential["mismatches"], [])
        self.assertEqual(differential["oracle_faults"], differential["wasm_faults"])
        self.assertEqual(report["runtime_run"]["faults"], differential["oracle_faults"])
        self.assertTrue(report["fault_histogram_ok"])

        link = report["link"]
        self.assertEqual(link["helper_imports"], 16)
        self.assertTrue(link["memory_identity"])
        self.assertEqual(link["game_table_mode"], 2)
        self.assertTrue(link["game_table_mode_ok"])
        self.assertTrue(link["game_indirect_table_ok"])
        self.assertTrue(link["game_via_table_smoke"]["ok"])
        self.assertIsNotNone(link["machine_step_smoke"])
        self.assertTrue(link["machine_step_smoke"]["ok"])

        self.assertEqual(len(report["game"]["imports"]), 17)  # 16 helpers + memory
        self.assertTrue(report["game"]["imports"].count("env.memory") == 1)
        self.assertGreater(report["game"]["bytes"], 0)


if __name__ == "__main__":
    unittest.main()

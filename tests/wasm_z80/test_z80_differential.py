"""Z80 differential: native C oracle vs ``runtime.wasm`` + generated Z80 module.

Runs the complete analysed Dune Z80 program (2577 guarded PCs / 3095 variants)
through both implementations with random Z80/CPU states and compares registers,
alternative register set, PC/SP/IX/IY/WZ, IFF/IM/halted/ei_delay/debt/steps/
cycles/interrupts, fault state + canonical failure code and both RAM images.

Requires the player's ROM and the generated native C core (``dune-base.c``):

    DUNE_ROM="/path/to/Dune (USA).gen" \
    DUNE_BASELINE="/path/to/vendor/rearrakis/build/dune-base.c" \
        python3.12 -m unittest discover -s tests/wasm_z80 -v

Without them the test is skipped; no game data is ever committed.
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from z80_support import (
    DEFAULT_BASELINE,
    DEFAULT_ROM,
    LOCAL_Z80,
    ROOT,
    external_inputs,
    load_json_stdout,
    require_node,
    require_python310,
    run_python,
)


class Z80DifferentialTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rom, cls.baseline = external_inputs()
        require_python310()
        require_node()
        cls.out_dir = LOCAL_Z80 / "tests"
        cls.report_path = cls.out_dir / "differential.json"

    def test_differential_has_zero_mismatches(self):
        process = run_python(
            ROOT / "tools" / "wasm_integration" / "z80_differential.py",
            "--rom", str(self.rom),
            "--baseline", str(self.baseline),
            "--states", "1",
            "--out", str(self.out_dir),
            "--json",
            timeout=3600,
        )
        self.assertEqual(
            process.returncode, 0,
            "Z80 differential failed:\n%s\n%s"
            % (process.stdout[-6000:], process.stderr[-4000:]),
        )
        report = load_json_stdout(process)
        self.out_dir.mkdir(parents=True, exist_ok=True)
        self.report_path.write_text(json.dumps(report, indent=1), encoding="utf-8")
        self.assertEqual(report["format"], "dune-z80-differential/1")
        self.assertEqual(report["z80"]["pcs"], 2577)
        self.assertEqual(report["z80"]["variants"], 3095)
        self.assertEqual(report["z80"]["mutable_expansions"], 2)
        self.assertEqual(report["z80"]["errors"], [])
        self.assertGreaterEqual(report["cases"], 3000)
        self.assertEqual(report["mismatch_cases"], 0, json.dumps(report["mismatches"], indent=1))
        self.assertTrue(report["ok"])
        # The oracle must actually exercise instruction semantics, not only the
        # "RAM differs" fallback: fault cases are a minority.
        self.assertLess(report["oracle_faults"], report["cases"] // 2)
        self.assertEqual(report["oracle_faults"], report["wasm_faults"])
        self.assertEqual(report["runtime_abi_hash"], report["pinned_abi_hash"])

    def test_report_is_reproducible(self):
        if not self.report_path.is_file():
            self.skipTest("run test_differential_has_zero_mismatches first")
        report = json.loads(self.report_path.read_text(encoding="utf-8"))
        self.assertEqual(report["module_sha256"], report["module_sha256"].lower())
        self.assertGreater(report["module_bytes"], 300_000)
        self.assertLess(report["module_bytes"], 1_000_000)
        self.assertEqual(report["states_per_variant"], 1)
        self.assertIn("timings_ms", report)


if __name__ == "__main__":
    unittest.main()

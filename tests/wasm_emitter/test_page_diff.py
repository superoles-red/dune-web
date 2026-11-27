"""End-to-end differential test; skips cleanly without external ROM/baseline."""

from __future__ import annotations

import os
import subprocess
import sys
import unittest
from pathlib import Path

from support import DEFAULT_BASELINE, DEFAULT_ROM, ROOT, TOOLS, add_tools_path, node_path

add_tools_path()


def _inputs():
    if DEFAULT_ROM is None:
        raise unittest.SkipTest("external ROM not configured: set DUNE_ROM")
    if DEFAULT_BASELINE is None:
        raise unittest.SkipTest("external dune-base.c not configured: set DUNE_BASELINE")
    return DEFAULT_ROM, DEFAULT_BASELINE


class PageDifferentialTests(unittest.TestCase):
    def test_check_page_end_to_end(self):
        rom, baseline = _inputs()
        if sys.version_info < (3, 10):
            self.skipTest("vendor decoder needs Python 3.10+")
        if node_path() is None:
            self.skipTest("node is not installed")
        if not rom.is_file():
            self.skipTest("external ROM not available (set DUNE_ROM): %s" % rom)
        if not baseline.is_file():
            self.skipTest(
                "external dune-base.c not available (set DUNE_BASELINE): %s" % baseline
            )
        full = os.environ.get("DUNE_WASM_FULL") == "1"
        cases = "200" if full else "4"
        coverage_cases = "24" if full else "2"
        command = [
            sys.executable,
            str(TOOLS / "wasm_emitter" / "check_page.py"),
            "--rom", str(rom),
            "--baseline", str(baseline),
            "--cases", cases,
            "--coverage-cases", coverage_cases,
            "--out", str(ROOT / ".local" / "wasm-emitter" / "tests"),
        ]
        process = subprocess.run(command, capture_output=True, text=True, timeout=1800)
        self.assertEqual(process.returncode, 0,
                         "check_page failed:\n%s\n%s"
                         % (process.stdout[-8000:], process.stderr[-4000:]))
        self.assertIn("PASS:", process.stdout)
        self.assertIn("mismatches: 0", process.stdout)


if __name__ == "__main__":
    unittest.main()

"""ROM-free ABI/runtime contract tests."""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from support import ROOT, add_tools_path

add_tools_path()

from wasm_emitter import abi  # noqa: E402


class AbiTests(unittest.TestCase):
    def test_reference_abi_consistency(self):
        report = abi.validate_cpu_abi(abi.REFERENCE_NATIVE_ABI)
        self.assertEqual(report["cpu_size"], 391624)
        self.assertEqual(report["ram_offset"], 78)
        self.assertEqual(report["helpers"], 16)
        self.assertEqual(report["fail_codes"], len(abi.FAIL_CODES))
        self.assertRegex(report["abi_hash"], r"^[0-9a-f]{64}$")

    def test_reference_abi_hash_is_pinned(self):
        # If this changes, the descriptor changed: update the doc and the
        # game.wasm cache key intentionally, do not silently accept it.
        self.assertEqual(
            abi.REFERENCE_NATIVE_ABI.abi_hash(),
            "2e870f72c64d96cfba68e5cad3d333b87579b7b342019ac392b62b08bf0567e1",
        )

    def test_runtime_contract(self):
        report = abi.check_runtime_contract(ROOT, abi.REFERENCE_NATIVE_ABI)
        self.assertEqual(report["runtime_bytes"], 129922)
        self.assertEqual(report["savestate"]["ram_offset"], 94)
        self.assertEqual(report["cpu_struct"], "runtime v2 == vendor runtime.h")

    def test_layout_relations(self):
        layout = abi.MemoryLayout.from_cpu(0x10000, abi.REFERENCE_NATIVE_ABI, 0x80000)
        self.assertEqual(layout.ram, 0x10000 + 78)
        self.assertEqual(layout.rom, 0x80000)
        self.assertGreaterEqual(layout.pages, 24)
        with self.assertRaises(abi.AbiError):
            abi.MemoryLayout.from_cpu(0x1800, abi.REFERENCE_NATIVE_ABI, 0x10000)

    def test_fail_reason_mapping(self):
        self.assertEqual(
            abi.fail_code_for_reason("address error on read"),
            abi.FAIL_ADDRESS_ERROR_READ,
        )
        self.assertEqual(
            abi.fail_code_for_reason("SR privilege violation"), abi.FAIL_PRIVILEGE
        )
        self.assertEqual(
            abi.fail_code_for_reason("68000 LINE_A opcode $a000"),
            abi.FAIL_LINE_A,
        )
        with self.assertRaises(abi.AbiError):
            abi.fail_code_for_reason("something new and unmapped")
        self.assertEqual(abi.fail_code_for_reason(None), abi.FAIL_OK)

    def test_malformed_descriptor_rejected(self):
        bad = abi.REFERENCE_NATIVE_ABI.__class__(
            **{**abi.REFERENCE_NATIVE_ABI.__dict__, "a": 64}
        )
        with self.assertRaises(abi.AbiError):
            abi.validate_cpu_abi(bad)

    def test_probe_parser_requires_keys(self):
        with self.assertRaises(abi.AbiError):
            abi.CpuAbi.from_probe({"sizeof_cpu": 1})

    def test_manifest_is_consistent(self):
        manifest = json.loads((ROOT / "runtime" / "manifest.json").read_text())
        self.assertEqual(manifest["runtime_file"], "dune-runtime-v2.c")
        self.assertEqual(manifest["savestate"]["magic"], 0x56415344)
        self.assertEqual(manifest["savestate"]["version"], 2)
        self.assertEqual(manifest["savestate"]["base_bytes"], 140056)
        self.assertEqual(manifest["savestate"]["max_buffer_bytes"], 262144)


if __name__ == "__main__":
    unittest.main()

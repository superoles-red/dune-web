"""The runtime ABI descriptor is the single source of layout/fail codes.

ROM-free tests (Node + ``runtime/wasm/runtime.wasm`` only):

* the descriptor read through ``loader.mjs`` matches the pinned manifest;
* the emitter's ``CpuAbi``/``MemoryLayout`` are derived from the wasm32 words
  (32-bit pointers, different counter offsets than the native C oracle);
* mutating the descriptor makes the build path *fail*, it is not ignored;
* a synthetic module built with the runtime ABI imports ``env.dune_*`` and has
  no memory/data segments of its own;
* changing a descriptor offset changes the emitted code (offsets are consumed).
"""

from __future__ import annotations

import dataclasses
import hashlib
import unittest

from support import (
    ROOT,
    add_tools_path,
    add_vendor_path,
    require_node,
    require_python310,
)

add_tools_path()
add_vendor_path()

from synthetic import SyntheticProgram, synthetic_instructions  # noqa: E402
from wasm_emitter import abi, game_module  # noqa: E402
from wasm_integration import build_page_module, runtime_abi, wasm_inspect  # noqa: E402


class RuntimeAbiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        require_node()
        cls.rt = runtime_abi.load_runtime_abi()
        cls.manifest = runtime_abi.load_manifest()

    # -- descriptor contents ------------------------------------------------
    def test_descriptor_matches_pinned_manifest(self):
        rt = self.rt
        self.assertEqual(rt.abi_hash, rt.pinned_abi_hash)
        self.assertEqual(rt.abi_hash, self.manifest["abi"]["abi_hash"])
        self.assertEqual(len(rt.words), self.manifest["abi"]["word_count"])
        self.assertEqual(rt.fields["MAGIC"], 0x31424144)
        self.assertEqual(rt.fields["VERSION"], 1)
        self.assertEqual(rt.fields["SIZE"], len(rt.words))
        expected = self.manifest["abi"]["actual"]
        self.assertEqual(rt.fields, {name: int(value) for name, value in expected.items()})
        self.assertEqual(rt.runtime_sha256, self.manifest["wasm"]["sha256"])
        self.assertEqual(rt.loader_sha256, self.manifest["loader"]["sha256"])

    def test_cpu_abi_is_derived_from_wasm32_words(self):
        rt = self.rt
        cpu = rt.cpu_abi
        # wasm32 pointers: rom pointer + size_t are 4 bytes each.
        self.assertEqual(cpu.pointer_bits, 32)
        self.assertEqual(rt.fields["OFF_ROM_SIZE"] - rt.fields["OFF_ROM"], 4)
        self.assertEqual(cpu.pc, rt.fields["OFF_PC"])
        self.assertEqual(cpu.instruction_cycles, rt.fields["OFF_INSTRUCTION_CYCLES"])
        self.assertEqual(cpu.fault, rt.fields["OFF_FAULT"])
        self.assertEqual(cpu.fault_address, rt.fields["OFF_FAULT_ADDRESS"])
        self.assertEqual(cpu.ram, rt.fields["OFF_RAM"])
        # ... and it is a different ABI from the native C oracle.
        native = abi.REFERENCE_NATIVE_ABI
        self.assertEqual(native.pointer_bits, 64)
        self.assertNotEqual(cpu.instruction_cycles, native.instruction_cycles)
        self.assertNotEqual(cpu.cpu_size, native.cpu_size)
        self.assertNotEqual(cpu.abi_hash(), native.abi_hash())
        abi.validate_cpu_abi(cpu)

    def test_memory_layout_matches_descriptor_addresses(self):
        rt = self.rt
        layout = rt.memory_layout(int(rt.fields["ROM_CAPACITY"]))
        fields = rt.fields
        self.assertEqual(layout.cpu, fields["ADDR_CPU"])
        self.assertEqual(layout.ram, fields["ADDR_RAM"])
        self.assertEqual(layout.ram, layout.cpu + rt.cpu_abi.ram)
        self.assertEqual(layout.rom, fields["ADDR_ROM"])
        self.assertEqual(layout.z80_ram, fields["ADDR_Z80_RAM"])
        self.assertEqual(layout.vram, fields["ADDR_VDP_VRAM"])
        self.assertEqual(layout.cram, fields["ADDR_VDP_CRAM"])
        self.assertEqual(layout.vsram, fields["ADDR_VDP_VSRAM"])
        self.assertEqual(layout.frame, fields["ADDR_VDP_FRAME"])
        self.assertEqual(layout.save_buffer, fields["ADDR_SAVE_BUFFER"])
        self.assertEqual(layout.save_buffer_bytes, fields["SAVE_BUFFER_BYTES"])
        self.assertEqual(layout.rom_size, fields["ROM_CAPACITY"])

    def test_fail_codes_come_from_descriptor_names(self):
        rt = self.rt
        mapping = rt.fail_codes
        self.assertEqual(mapping.runtime_code(abi.FAIL_UNTRANSLATED),
                         rt.fields["UNTRANSLATED"])
        self.assertEqual(mapping.runtime_code(abi.FAIL_PRIVILEGE), rt.fields["PRIVILEGE"])
        # The runtime has no LINE_A/LINE_F code; those must be declared lossy.
        self.assertIn(abi.FAIL_LINE_A, mapping.lossy_canonical)
        self.assertIn(abi.FAIL_LINE_F, mapping.lossy_canonical)
        self.assertEqual(mapping.canonical_code(rt.fields["ILLEGAL_INSTRUCTION"]),
                         abi.FAIL_ILLEGAL)
        # Numbers are re-read from the descriptor, not hard-coded.
        patched = dict(rt.fields)
        patched["PRIVILEGE"] = 20
        patched_map = runtime_abi.runtime_fail_code_map(patched)
        self.assertEqual(patched_map.runtime_code(abi.FAIL_PRIVILEGE), 20)
        self.assertEqual(patched_map.canonical_code(20), abi.FAIL_PRIVILEGE)

    # -- descriptor is authoritative ---------------------------------------
    def test_tampered_descriptor_is_rejected(self):
        cases = [
            ("offset without rehash", ["OFF_PC=68"], False),
            ("offset with rehashed hash", ["OFF_PC=68"], True),
            ("address word with rehashed hash", ["ADDR_ROM=1234"], True),
            ("fail code with rehashed hash", ["UNTRANSLATED=99"], True),
        ]
        for label, tamper, rehash in cases:
            with self.subTest(label=label):
                with self.assertRaises(runtime_abi.RuntimeAbiError):
                    runtime_abi.load_runtime_abi(tamper=tamper, rehash=rehash)

    def test_build_refuses_descriptor_with_wrong_pinned_hash(self):
        rt = self.rt
        broken = dataclasses.replace(rt, abi_hash="0" * 64)
        # Fails on the pinned-hash guard before any ROM access: a descriptor that
        # does not match runtime/wasm/manifest.json can never be built against.
        with self.assertRaises(build_page_module.BuildError) as context:
            build_page_module.build_page_game_module(
                ROOT / "does-not-exist.gen", 0x13,
                runtime_descriptor=broken, write=False,
            )
        self.assertIn("pinned", str(context.exception).lower())

    # -- generated module structure ----------------------------------------
    def _build_synthetic(self, cpu_abi=None, helper_prefix="dune_",
                         fail_code_map=None) -> tuple:
        require_python310()
        rt = self.rt
        program = SyntheticProgram(synthetic_instructions())
        layout = rt.memory_layout(0x10000)
        data, meta = game_module.build_module(
            program, synthetic_instructions(), cpu_abi or rt.cpu_abi, layout,
            label="synthetic", helper_prefix=helper_prefix,
            fail_code_map=fail_code_map if fail_code_map is not None
            else dict(rt.fail_codes.canonical_to_runtime),
        )
        return data, meta

    def test_synthetic_module_structure(self):
        data, meta = self._build_synthetic()
        info = wasm_inspect.inspect_wasm(data)
        checks = runtime_abi.verify_game_module(info, self.rt.export_names, "dune_")
        self.assertEqual(checks["helper_prefix"], "dune_")
        self.assertEqual(info.data_segments, 0)
        self.assertIsNone(info.defined_memory_pages)
        self.assertEqual(info.global_count, 0)
        import_names = info.import_names()
        self.assertIn("env.memory", import_names)
        for name in abi.HELPER_NAMES:
            self.assertIn("env.dune_" + name, import_names)
        self.assertEqual(meta["build"]["helper_prefix"], "dune_")
        self.assertIn(1, meta["build"]["fail_codes_used"])  # UNTRANSLATED

    def test_fail_code_numbers_are_consumed_from_the_descriptor(self):
        real_data, real_meta = self._build_synthetic()
        # UNTRANSLATED is emitted by the page dispatcher; moving its runtime number
        # must change the module bytes (the native default would keep code 1).
        patched_map = dict(self.rt.fail_codes.canonical_to_runtime)
        patched_map[abi.FAIL_UNTRANSLATED] = 11
        patched_data, patched_meta = self._build_synthetic(fail_code_map=patched_map)
        self.assertNotEqual(hashlib.sha256(real_data).hexdigest(),
                            hashlib.sha256(patched_data).hexdigest())
        self.assertEqual(patched_meta["build"]["fail_code_map"]["1"], 11)
        self.assertEqual(real_meta["build"]["fail_code_map"]["1"],
                         self.rt.fail_codes.runtime_code(abi.FAIL_UNTRANSLATED))

    def test_offsets_are_consumed_from_the_descriptor(self):
        real_data, _ = self._build_synthetic()
        # A descriptor with a different PC offset must produce different code:
        # if the emitter ignored the descriptor the bytes would be identical.
        shifted = dataclasses.replace(self.rt.cpu_abi, pc=self.rt.cpu_abi.pc + 4)
        shifted_data, shifted_meta = self._build_synthetic(cpu_abi=shifted)
        self.assertNotEqual(hashlib.sha256(real_data).hexdigest(),
                            hashlib.sha256(shifted_data).hexdigest())
        self.assertEqual(shifted_meta["abi"]["offsets"]["pc"],
                         self.rt.cpu_abi.pc + 4)
        # The shifted descriptor is not internally consistent -> validate() fails.
        with self.assertRaises(abi.AbiError):
            abi.validate_cpu_abi(shifted)
        # Native ABI (64-bit layout) gives yet another module.
        native_layout = abi.MemoryLayout.from_cpu(0x10000, abi.REFERENCE_NATIVE_ABI, 0x80000)
        program = SyntheticProgram(synthetic_instructions())
        native_data, _ = game_module.build_module(
            program, synthetic_instructions(), abi.REFERENCE_NATIVE_ABI, native_layout,
            label="synthetic-native",
        )
        self.assertNotEqual(hashlib.sha256(real_data).hexdigest(),
                            hashlib.sha256(native_data).hexdigest())


if __name__ == "__main__":
    unittest.main()

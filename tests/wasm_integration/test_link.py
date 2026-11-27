"""Link a generated module into ``runtime.wasm`` (ROM-free, Node only).

Builds the synthetic page module against the runtime descriptor, writes it with a
meta file in the exact format ``link_and_run.mjs`` expects, and asks the linker
for its ``--verify-only`` report.  This proves, without a ROM:

* every function import resolves to the runtime's own export object (identity),
* the game module receives the runtime-owned ``WebAssembly.Memory``,
* the game ``translated_step`` is appended to the runtime's funcref table and
  installed as ``GAME_MODE_SINGLE``,
* ``warmup_all`` runs inside the runtime,
* a meta file whose descriptor snapshot disagrees with the runtime is rejected.
"""

from __future__ import annotations

import copy
import hashlib
import json
import unittest
from pathlib import Path

from support import (
    INTEGRATION,
    add_tools_path,
    add_vendor_path,
    load_json_stdout,
    require_node,
    require_python310,
    run_node,
    temporary_dir,
)

add_tools_path()
add_vendor_path()

from synthetic import SyntheticProgram, synthetic_instructions  # noqa: E402
from wasm_emitter import game_module  # noqa: E402
from wasm_integration import runtime_abi  # noqa: E402

LINK_SCRIPT = INTEGRATION / "link_and_run.mjs"


class LinkRuntimeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        require_node()
        require_python310()
        cls.rt = runtime_abi.load_runtime_abi()

    def _build(self, directory) -> tuple:
        program = SyntheticProgram(synthetic_instructions())
        layout = self.rt.memory_layout(0x10000)
        data, module_meta = game_module.build_module(
            program, synthetic_instructions(), self.rt.cpu_abi, layout,
            label="synthetic", helper_prefix="dune_",
            fail_code_map=dict(self.rt.fail_codes.canonical_to_runtime),
        )
        meta = {
            "format": "dune-game-wasm-runtime/1",
            "page": 0x13,
            "instructions": module_meta["instructions"],
            "runtime_abi": self.rt.to_dict(),
            "runtime_abi_hash": self.rt.abi_hash,
            "pinned_abi_hash": self.rt.pinned_abi_hash,
            "abi": self.rt.cpu_abi.to_dict(),
            "memory": layout.to_dict(),
            "fail_codes": self.rt.fail_codes.to_dict(),
            "module": {
                "bytes": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
            },
        }
        wasm_path = directory / "synthetic.wasm"
        meta_path = directory / "synthetic.meta.json"
        wasm_path.write_bytes(data)
        meta_path.write_text(json.dumps(meta), encoding="utf-8")
        return wasm_path, meta_path, meta

    def _link_verify(self, wasm_path, meta_path):
        return run_node(
            LINK_SCRIPT,
            "--runtime", str(self.rt.runtime),
            "--loader", str(self.rt.loader),
            "--game", str(wasm_path),
            "--meta", str(meta_path),
            "--verify-only",
        )

    def test_link_verify_only(self):
        with temporary_dir() as tmp:
            directory = Path(tmp)
            wasm_path, meta_path, _ = self._build(directory)
            process = self._link_verify(wasm_path, meta_path)
            report = load_json_stdout(process)
            self.assertEqual(process.returncode, 0, process.stderr[-4000:])
            self.assertTrue(report["ok"], json.dumps(report.get("link"), indent=1))
            link = report["link"]
            self.assertEqual(link["helper_imports"], 16)
            self.assertTrue(link["memory_identity"])
            self.assertEqual(link["game_table_mode"], 2)
            self.assertTrue(link["game_table_mode_ok"])
            self.assertTrue(link["game_indirect_table_ok"])
            self.assertTrue(link["game_via_table_smoke"]["ok"])
            self.assertEqual(link["game_via_table_smoke"]["pc"], 0x13002)
            self.assertGreater(link["warmup_ms"], 0.0)
            self.assertEqual(report["runtime"]["abi_hash"], self.rt.abi_hash)
            self.assertEqual(report["runtime"]["word_count"], 140)
            # Every import is the runtime's own export, env.memory included.
            self.assertEqual(len(link["imports"]), 17)
            self.assertTrue(all(entry["identity"] for entry in link["imports"]))
            memory_imports = [entry for entry in link["imports"]
                              if entry["kind"] == "memory"]
            self.assertEqual([entry["name"] for entry in memory_imports], ["memory"])

    def test_meta_descriptor_mismatch_is_rejected(self):
        with temporary_dir() as tmp:
            directory = Path(tmp)
            wasm_path, meta_path, meta = self._build(directory)
            tampered = copy.deepcopy(meta)
            tampered["runtime_abi"]["fields"]["OFF_PC"] += 4
            meta_path.write_text(json.dumps(tampered), encoding="utf-8")
            process = self._link_verify(wasm_path, meta_path)
            self.assertNotEqual(process.returncode, 0)
            self.assertIn("descriptor differs", process.stderr)

    def test_meta_game_hash_mismatch_is_rejected(self):
        with temporary_dir() as tmp:
            directory = Path(tmp)
            wasm_path, meta_path, meta = self._build(directory)
            tampered = copy.deepcopy(meta)
            tampered["module"]["sha256"] = "0" * 64
            meta_path.write_text(json.dumps(tampered), encoding="utf-8")
            process = self._link_verify(wasm_path, meta_path)
            self.assertNotEqual(process.returncode, 0)
            self.assertIn("game.wasm SHA", process.stderr)


if __name__ == "__main__":
    unittest.main()

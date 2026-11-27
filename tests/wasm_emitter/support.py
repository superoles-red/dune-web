"""Shared helpers for the wasm_emitter tests (no third-party packages)."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools"
VENDOR = ROOT / "vendor" / "rearrakis"
# External inputs are never committed and never hard-coded to one machine:
# set DUNE_ROM / DUNE_BASELINE to run the full differential check, otherwise the
# tests skip with an explanation.
DEFAULT_ROM = Path(os.environ["DUNE_ROM"]) if os.environ.get("DUNE_ROM") else None
DEFAULT_BASELINE = Path(os.environ["DUNE_BASELINE"]) if os.environ.get("DUNE_BASELINE") else None


def add_tools_path() -> None:
    if str(TOOLS) not in sys.path:
        sys.path.insert(0, str(TOOLS))


def add_vendor_path() -> None:
    if str(VENDOR) not in sys.path:
        sys.path.insert(0, str(VENDOR))


def node_path():
    return shutil.which("node")


def run_node(script: str, *args: str, timeout: int = 120):
    node = node_path()
    if not node:
        return None
    return subprocess.run([node, "-e", script, *args], capture_output=True,
                          text=True, timeout=timeout)


def validate_wasm_bytes(data: bytes) -> bool:
    node = node_path()
    if not node:
        raise unittest_skip("node is not installed")
    with tempfile.NamedTemporaryFile(suffix=".wasm", delete=False) as handle:
        handle.write(data)
        path = handle.name
    try:
        process = run_node(
            "const fs=require('fs');"
            "const b=fs.readFileSync(process.argv[1]);"
            "console.log(WebAssembly.validate(b)?'valid':'invalid');",
            path,
        )
        if process is None:
            raise unittest_skip("node is not installed")
        if process.returncode != 0:
            raise AssertionError(process.stderr)
        return process.stdout.strip() == "valid"
    finally:
        Path(path).unlink(missing_ok=True)


class SkipTest(Exception):
    pass


def unittest_skip(message: str):
    import unittest

    raise unittest.SkipTest(message)


def external_inputs_available() -> bool:
    return bool(DEFAULT_ROM and DEFAULT_ROM.is_file() and DEFAULT_BASELINE and DEFAULT_BASELINE.is_file())

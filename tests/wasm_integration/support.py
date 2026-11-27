"""Shared helpers for the wasm integration tests (stdlib + Node only).

External game data is never hard-coded: set ``DUNE_ROM`` / ``DUNE_BASELINE`` to
run the ROM-dependent differential; otherwise those tests skip with an explicit
message.  ``DUNE_WASM_FAST=1`` lowers the state count for quick local runs.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools"
INTEGRATION = TOOLS / "wasm_integration"
VENDOR = ROOT / "vendor" / "rearrakis"
LOCAL_OUT = ROOT / ".local" / "wasm-integration" / "tests"

DEFAULT_ROM = Path(os.environ["DUNE_ROM"]) if os.environ.get("DUNE_ROM") else None
DEFAULT_BASELINE = (
    Path(os.environ["DUNE_BASELINE"]) if os.environ.get("DUNE_BASELINE") else None
)


def add_tools_path() -> None:
    for path in (str(TOOLS), str(INTEGRATION)):
        if path not in sys.path:
            sys.path.insert(0, path)


def add_vendor_path() -> None:
    if str(VENDOR) not in sys.path:
        sys.path.insert(0, str(VENDOR))


def node_path():
    return shutil.which("node")


def require_node() -> str:
    node = node_path()
    if node is None:
        raise unittest.SkipTest("node is not installed")
    return node


def require_python310() -> None:
    if sys.version_info < (3, 10):
        raise unittest.SkipTest("vendored recompiler decoder needs Python 3.10+")


def external_inputs():
    """(rom, baseline) or skip; callers check the files themselves."""
    if DEFAULT_ROM is None:
        raise unittest.SkipTest("external ROM not configured: set DUNE_ROM")
    if DEFAULT_BASELINE is None:
        raise unittest.SkipTest(
            "external dune-base.c not configured: set DUNE_BASELINE"
        )
    if not DEFAULT_ROM.is_file():
        raise unittest.SkipTest("external ROM not available: %s" % DEFAULT_ROM)
    if not DEFAULT_BASELINE.is_file():
        raise unittest.SkipTest(
            "external dune-base.c not available: %s" % DEFAULT_BASELINE
        )
    return DEFAULT_ROM, DEFAULT_BASELINE


def run_python(script: Path, *args: str, timeout: int = 1800):
    return subprocess.run(
        [sys.executable, str(script), *args],
        capture_output=True, text=True, timeout=timeout,
    )


def run_node(script: Path, *args: str, timeout: int = 1800):
    node = require_node()
    return subprocess.run(
        [node, str(script), *args],
        capture_output=True, text=True, timeout=timeout,
    )


def load_json_stdout(process) -> dict:
    stdout = (process.stdout or "").strip()
    if not stdout:
        raise AssertionError(
            "no JSON on stdout (exit %d):\n%s" % (process.returncode,
                                                 (process.stderr or "")[-4000:])
        )
    try:
        return json.loads(stdout)
    except json.JSONDecodeError as error:
        raise AssertionError(
            "invalid JSON (exit %d): %s\nstdout=%s\nstderr=%s"
            % (process.returncode, error, stdout[:2000],
               (process.stderr or "")[-2000:])
        ) from error


def temporary_dir(prefix: str = "dune-wasm-integration-"):
    return tempfile.TemporaryDirectory(prefix=prefix)


def git_output(*args: str) -> str:
    process = subprocess.run(["git", *args], cwd=str(ROOT), capture_output=True,
                             text=True, timeout=120)
    if process.returncode != 0:
        raise AssertionError("git %s failed: %s" % (" ".join(args), process.stderr))
    return process.stdout


__all__ = [
    "DEFAULT_BASELINE",
    "DEFAULT_ROM",
    "INTEGRATION",
    "LOCAL_OUT",
    "ROOT",
    "TOOLS",
    "add_tools_path",
    "add_vendor_path",
    "external_inputs",
    "git_output",
    "load_json_stdout",
    "node_path",
    "require_node",
    "require_python310",
    "run_node",
    "run_python",
    "temporary_dir",
]

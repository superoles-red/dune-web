"""Small CLI helpers shared by the integration scripts (stdlib only)."""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import List, Optional

ROOT = Path(__file__).resolve().parents[2]
TOOLS = ROOT / "tools"
INTEGRATION_DIR = Path(__file__).resolve().parent

MIN_PYTHON = (3, 10)


def ensure_tools_on_path() -> None:
    if str(TOOLS) not in sys.path:
        sys.path.insert(0, str(TOOLS))


def newer_python_candidates() -> List[str]:
    candidates: List[str] = []
    for name in ("python3.13", "python3.12", "python3.11", "python3.10"):
        path = _which(name)
        if path:
            candidates.append(path)
    default = os.path.expanduser("~/.local/bin/python3.12")
    if Path(default).is_file():
        candidates.append(default)
    seen = set()
    unique = []
    for path in candidates:
        if path not in seen:
            seen.add(path)
            unique.append(path)
    return unique


def _which(name: str) -> Optional[str]:
    try:
        from shutil import which

        return which(name)
    except Exception:  # pragma: no cover - defensive
        return None


def reexec_with_newer_python(script: Optional[Path] = None) -> None:
    """Re-execute ``script`` with Python >= 3.10 when the current one is older.

    The vendored recompiler decoder uses PEP 604 annotations, so ROM decoding
    needs 3.10+; everything else in this package is 3.9-compatible.
    """
    if sys.version_info >= MIN_PYTHON:
        return
    target = Path(script or sys.argv[0]).resolve()
    for candidate in newer_python_candidates():
        if Path(candidate).is_file():
            os.execv(candidate, [candidate, str(target)] + sys.argv[1:])
    raise SystemExit(
        "error: Python 3.10+ is required (found %d.%d); "
        "e.g. python3.12 %s ..." % (sys.version_info[0], sys.version_info[1], target)
    )


__all__ = [
    "INTEGRATION_DIR",
    "MIN_PYTHON",
    "ROOT",
    "TOOLS",
    "ensure_tools_on_path",
    "newer_python_candidates",
    "reexec_with_newer_python",
]

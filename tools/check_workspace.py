#!/usr/bin/env python3
"""Validate the workspace contracts: ROM profile, runtime manifest, references."""
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ROM_SHA256 = "b1bbe73186e0902fa8b2db0f227bf306e3d6a80fe592f927d1aa9d60c0f335ba"
ROM_BYTES = 1048576


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def warn(message: str) -> None:
    print(f"warning: {message}", file=sys.stderr)


def check_profile() -> bool:
    path = ROOT / "profiles" / "dune-us.json"
    if not path.is_file():
        print("error: profiles/dune-us.json missing", file=sys.stderr)
        return False
    profile = json.loads(path.read_text())
    ok = True
    if profile.get("sha256") != ROM_SHA256 or profile.get("rom_bytes") != ROM_BYTES:
        print("error: profile does not describe the supported USA dump", file=sys.stderr)
        ok = False
    if not profile.get("entries"):
        print("error: profile has no entry points", file=sys.stderr)
        ok = False
    return ok


def check_runtime() -> bool:
    manifest_path = ROOT / "runtime" / "manifest.json"
    if not manifest_path.is_file():
        warn("runtime/manifest.json is not built yet (needs the external dune-base.c)")
        return True
    manifest = json.loads(manifest_path.read_text())
    runtime = ROOT / "runtime" / manifest["runtime_file"]
    if not runtime.is_file():
        print(f"error: runtime file missing: {runtime}", file=sys.stderr)
        return False
    if sha256(runtime) != manifest["runtime_sha256"]:
        print("error: pinned runtime SHA-256 mismatch", file=sys.stderr)
        return False
    if "static const uint8_t rom_data[]" in runtime.read_text():
        print("error: pinned runtime contains ROM data", file=sys.stderr)
        return False
    for key in ("shipped_core_sha256", "shipped_core_bytes", "window_title", "recompiler"):
        if key not in manifest:
            print(f"error: runtime manifest lacks '{key}'", file=sys.stderr)
            return False
    return True


def check_bundle() -> bool:
    reference = ROOT / "web" / "reference.json"
    if not reference.is_file():
        warn("web/reference.json not built yet (run tools/bundle_web.py)")
        return True
    data = json.loads(reference.read_text())
    if data.get("rom_sha256") != ROM_SHA256:
        print("error: web reference points at the wrong ROM", file=sys.stderr)
        return False
    if not isinstance(data.get("expected_output_bytes"), int) or data["expected_output_bytes"] <= 0:
        print("error: web reference lacks the expected core size", file=sys.stderr)
        return False
    return True


def main() -> int:
    checks = [check_profile(), check_runtime(), check_bundle()]
    if not all(checks):
        return 1
    print("workspace contract: OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

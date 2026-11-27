#!/usr/bin/env python3
"""One-command verification of the pinned runtime v2 and the exact core rebuild.

Runs, in order:

1. input manifests: ROM dump profile, pinned vendored MIT recompiler, browser
   overlay, runtime manifest schema;
2. the committed runtime artifact: SHA-256 sidecar, no ROM bytes/byte arrays,
   adapter set and their pinned SHA-256 values, DSAV v2 ABI, window title;
3. with ``--baseline``: re-apply the public host/input patches to the external
   generated ``dune-base.c`` and confirm the prepared core SHA-256
   (``d7c84066...``), the audio driver SHA-256, and that the committed runtime is
   exactly the preamble of that prepared core;
4. with ``--rom``: recompile the player's ROM in-process through the patched
   ReArrakis recompiler + this runtime and confirm the generated C is
   byte-identical to the prepared ``dune-web.c``.

The ROM and the generated baseline are player-supplied game data: they are never
stored in the repository. Without them the checks are reported as warnings and
the command still succeeds, so CI can run it on a clean checkout.

Usage:
    python3 tools/verify.py --baseline /path/to/dune-base.c \\
        --rom "/path/to/Dune - The Battle for Arrakis (USA).gen"
"""
import argparse
import hashlib
import json
import os
import sys
import time
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
sys.path.insert(0, str(TOOLS))

import bootstrap_core_source as bootstrap  # noqa: E402
import build_game_c  # noqa: E402
import build_runtime  # noqa: E402
import prepare_source  # noqa: E402

ROM_SHA256 = "b1bbe73186e0902fa8b2db0f227bf306e3d6a80fe592f927d1aa9d60c0f335ba"
ROM_BYTES = 1048576
MANIFEST_REQUIRED = (
    "runtime_file",
    "runtime_sha256",
    "window_title",
    "shipped_core_sha256",
    "shipped_core_bytes",
    "recompiler",
)
MANIFEST_EXPECTED = (
    "runtime_bytes",
    "baseline_sha256",
    "baseline_bytes",
    "full_preamble_sha256",
    "full_preamble_bytes",
    "generated_prefix_sha256",
    "savestate",
    "adapters",
    "exports",
    "vendor_source_manifest_sha256",
    "recompiler_overlay",
)


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class Report:
    def __init__(self, quiet=False):
        self.entries = []
        self.quiet = quiet

    def _add(self, status, name, detail="", seconds=None):
        entry = {"status": status, "name": name, "detail": detail}
        if seconds is not None:
            entry["seconds"] = round(seconds, 3)
        self.entries.append(entry)
        if not self.quiet:
            suffix = f" ({detail})" if detail else ""
            print(f"  [{status}] {name}{suffix}")

    def ok(self, name, detail="", seconds=None):
        self._add("ok", name, detail, seconds)

    def warn(self, name, detail="", seconds=None):
        self._add("warn", name, detail, seconds)

    def fail(self, name, detail="", seconds=None):
        self._add("fail", name, detail, seconds)

    def check(self, condition, name, detail="", failure_detail=""):
        if condition:
            self.ok(name, detail)
        else:
            self.fail(name, failure_detail or detail)
        return bool(condition)

    @property
    def failed(self):
        return [entry for entry in self.entries if entry["status"] == "fail"]

    @property
    def warnings(self):
        return [entry for entry in self.entries if entry["status"] == "warn"]

    @property
    def passed(self):
        return [entry for entry in self.entries if entry["status"] == "ok"]


def check_profile(report: Report) -> dict:
    path = ROOT / "profiles" / "dune-us.json"
    if not path.is_file():
        report.fail("inputs/profile", f"missing {path.relative_to(ROOT)}")
        return {}
    profile = json.loads(path.read_text(encoding="utf-8"))
    valid = (
        profile.get("rom_bytes") == ROM_BYTES
        and profile.get("sha256") == ROM_SHA256
        and isinstance(profile.get("entries"), list)
        and len(profile["entries"]) > 0
    )
    report.check(
        valid,
        "inputs/profile",
        f"USA dump {ROM_BYTES} bytes, {len(profile.get('entries', []))} pinned entries",
        "profiles/dune-us.json does not describe the supported dump",
    )
    return profile


def check_vendor_inputs(report: Report) -> dict:
    try:
        vendor = bootstrap.verify_vendored()
    except (ValueError, FileNotFoundError) as error:
        report.fail("inputs/vendor", str(error))
        return {}
    report.ok(
        "inputs/vendor",
        f"{vendor['files']} MIT files, {vendor['bytes']} bytes, manifest pinned",
    )
    for warning in vendor["warnings"]:
        report.warn("inputs/vendor/license", warning)
    try:
        overlay = bootstrap.verify_overlay()
    except (ValueError, FileNotFoundError) as error:
        report.fail("inputs/overlay", str(error))
        return vendor
    report.ok(
        "inputs/overlay",
        ", ".join(
            f"{name} +{info['addedLines']}/-{info['removedLines']} lines"
            for name, info in overlay["files"].items()
        ),
    )
    return vendor


def load_manifest(report: Report):
    path = ROOT / "runtime" / "manifest.json"
    if not path.is_file():
        report.fail("artifact/manifest", "runtime/manifest.json is missing; run tools/build_runtime.py")
        return None
    manifest = json.loads(path.read_text(encoding="utf-8"))
    missing = [key for key in MANIFEST_REQUIRED if key not in manifest]
    if missing:
        report.fail("artifact/manifest", "missing required keys: " + ", ".join(missing))
        return None
    report.ok("artifact/manifest", f"{len(manifest)} keys, runtime {manifest['runtime_file']}")
    absent = [key for key in MANIFEST_EXPECTED if key not in manifest]
    if absent:
        report.warn("artifact/manifest/extras", "missing descriptive keys: " + ", ".join(absent))
    return manifest


def check_runtime_artifact(report: Report, manifest, vendor) -> str:
    runtime_dir = ROOT / "runtime"
    runtime_path = runtime_dir / manifest["runtime_file"]
    if not runtime_path.is_file():
        report.fail("artifact/runtime", f"missing {runtime_path.relative_to(ROOT)}")
        return ""
    data = runtime_path.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    ok = (
        digest == manifest["runtime_sha256"]
        and len(data) == manifest.get("runtime_bytes", len(data))
    )
    report.check(
        ok,
        "artifact/runtime",
        f"{manifest['runtime_file']} {digest[:16]}… {len(data)} bytes",
        f"runtime SHA/size mismatch: {digest} {len(data)} bytes",
    )
    sidecar = runtime_dir / (manifest["runtime_file"] + ".sha256")
    expected_sidecar = f"{manifest['runtime_sha256']}  {manifest['runtime_file']}\n"
    report.check(
        sidecar.is_file() and sidecar.read_text(encoding="utf-8") == expected_sidecar,
        "artifact/runtime/sha256",
        f"{manifest['runtime_file']}.sha256 matches",
        "SHA-256 sidecar is missing or does not match the manifest",
    )
    text = data.decode("utf-8")
    try:
        build_runtime.validate_runtime_text(text)
        report.ok("artifact/runtime/code-only", "no rom_data marker, no byte-array runs, DSAV v2 present")
    except ValueError as error:
        report.fail("artifact/runtime/code-only", str(error))
    report.check(
        manifest.get("window_title") == build_runtime.WINDOW_TITLE,
        "artifact/runtime/title",
        repr(build_runtime.WINDOW_TITLE),
        "window title does not match the shipped core header",
    )
    report.check(
        manifest.get("shipped_core_sha256") == prepare_source.PREPARED_SHA256
        and manifest.get("shipped_core_bytes") == prepare_source.PREPARED_BYTES,
        "artifact/pinned-core",
        f"{prepare_source.PREPARED_SHA256[:16]}… {prepare_source.PREPARED_BYTES} bytes",
        "shipped core identity differs from the prepared dune-web.c pin",
    )
    report.check(
        manifest.get("baseline_sha256") == prepare_source.BASELINE_SHA256,
        "artifact/baseline-pin",
        prepare_source.BASELINE_SHA256[:16] + "…",
        "baseline pin differs from the generated dune-base.c pin",
    )
    if vendor:
        manifest_sha = (ROOT / "vendor" / "rearrakis" / "source-manifest.json")
        report.check(
            manifest.get("vendor_source_manifest_sha256") == sha256_file(manifest_sha),
            "artifact/vendor-pin",
            "vendor manifest SHA-256 recorded",
            "runtime manifest records a different vendor source manifest",
        )
    return text


def check_adapters(report: Report, manifest, runtime_text: str):
    adapters_dir = ROOT / "runtime" / "adapters"
    manifest_path = adapters_dir / build_runtime.ADAPTERS_MANIFEST
    if not manifest_path.is_file():
        report.fail("artifact/adapters", "runtime/adapters/manifest.json is missing")
        return
    try:
        entries = build_runtime.sync_adapters(None)
        expected_manifest = build_runtime.adapters_manifest(entries)
    except (ValueError, FileNotFoundError) as error:
        report.fail("artifact/adapters", str(error))
        return
    on_disk = json.loads(manifest_path.read_text(encoding="utf-8"))
    report.check(
        on_disk == expected_manifest,
        "artifact/adapters",
        f"{expected_manifest['count']} MIT adapters, {expected_manifest['bytes']} bytes, pinned",
        "runtime/adapters/manifest.json differs from the committed adapter files",
    )
    if manifest.get("adapters", {}).get("files") != expected_manifest["files"]:
        report.fail("artifact/adapters/pin", "runtime/manifest.json adapter list differs")
    else:
        report.ok("artifact/adapters/pin", "manifest adapter list matches")
    includes = sorted(set(build_runtime.ADAPTER_INCLUDE_RE.findall(runtime_text)))
    unknown = sorted(set(includes) - build_runtime.EXPECTED_ADAPTERS)
    report.check(
        bool(includes) and not unknown,
        "artifact/adapters/includes",
        f"{len(includes)} adapter includes resolved",
        "runtime includes unknown adapters: " + str(unknown),
    )
    overlay = manifest.get("recompiler_overlay") or {}
    try:
        actual = bootstrap.verify_overlay()["files"]
    except (ValueError, FileNotFoundError) as error:
        report.fail("artifact/overlay-pin", str(error))
        return
    report.check(
        overlay == {name: info["sha256"] for name, info in actual.items()},
        "artifact/overlay-pin",
        "recompiler overlay SHA-256 recorded",
        "runtime manifest overlay pin differs from tools/recompiler_overlay",
    )


def resolve_recompiler_dir() -> Path:
    local = ROOT / ".local/source/genesis_recompiler"
    if (local / "audio_ymfm.cpp").is_file():
        return local
    return bootstrap.VENDOR / "genesis_recompiler"


def check_baseline(report: Report, manifest, baseline_arg):
    """Reapply the patches to the external baseline and rebuild the pins."""
    if baseline_arg is None:
        report.warn(
            "inputs/baseline",
            "not supplied; prepared-core rebuild skipped (pass --baseline /path/to/dune-base.c)",
        )
        return None
    started = time.perf_counter()
    baseline = Path(baseline_arg)
    try:
        info = bootstrap.verify_baseline(baseline)
    except (ValueError, FileNotFoundError) as error:
        report.fail("inputs/baseline", str(error))
        return None
    report.ok(
        "inputs/baseline",
        f"{info['sha256'][:16]}… {info['bytes']} bytes",
        seconds=time.perf_counter() - started,
    )
    started = time.perf_counter()
    try:
        prepared = prepare_source.apply(
            baseline.read_text(encoding="utf-8"),
            ROOT / "runtime" / "adapters",
            resolve_recompiler_dir(),
        )
    except (ValueError, FileNotFoundError) as error:
        report.fail("reconcile/prepared-core", str(error))
        return None
    report.check(
        prepared["core_sha256"] == manifest["shipped_core_sha256"]
        and prepared["core_bytes"] == manifest["shipped_core_bytes"],
        "reconcile/prepared-core",
        f"{prepared['core_sha256'][:16]}… {prepared['core_bytes']} bytes",
        f"prepared core {prepared['core_sha256']} {prepared['core_bytes']} bytes "
        f"!= pinned {manifest['shipped_core_sha256']} {manifest['shipped_core_bytes']} bytes",
    )
    report.check(
        prepared["audio_sha256"] == manifest.get("prepared_audio_sha256", prepare_source.AUDIO_SHA256),
        "reconcile/prepared-audio",
        prepared["audio_sha256"][:16] + "…",
        "prepared audio driver SHA-256 differs",
    )
    try:
        preamble = build_runtime.extract_preamble(prepared["core"])
    except ValueError as error:
        report.fail("reconcile/preamble", str(error))
        return prepared
    runtime_path = ROOT / "runtime" / manifest["runtime_file"]
    report.check(
        runtime_path.is_file() and runtime_path.read_bytes() == preamble["runtime_bytes"],
        "reconcile/preamble",
        "committed runtime == prepared core preamble",
        "committed runtime differs from the prepared core preamble",
    )
    report.check(
        preamble["full_preamble_sha256"] == manifest.get("full_preamble_sha256"),
        "reconcile/full-preamble",
        preamble["full_preamble_sha256"][:16] + "…",
        "full preamble SHA-256 differs from runtime/manifest.json",
    )
    local_core = ROOT / ".local/build/dune-web.c"
    if local_core.is_file():
        report.check(
            sha256_file(local_core) == manifest["shipped_core_sha256"],
            "reconcile/local-core",
            ".local/build/dune-web.c matches",
            ".local/build/dune-web.c does not match the pinned core",
        )
    prepared["_seconds"] = time.perf_counter() - started
    return prepared


def check_rom(report: Report, manifest, rom_arg, prepared):
    if rom_arg is None:
        report.warn(
            "reconcile/rom",
            "not supplied; ROM -> C rebuild skipped (pass --rom /path/to/Dune-USA.gen)",
        )
        return
    rom = Path(rom_arg)
    if not rom.is_file():
        report.fail("inputs/rom", f"ROM not found: {rom}")
        return
    data = rom.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if len(data) != ROM_BYTES or digest != ROM_SHA256:
        report.fail(
            "inputs/rom",
            f"not the supported USA dump: {len(data)} bytes, sha256 {digest}",
        )
        return
    report.ok("inputs/rom", f"{digest[:16]}… {len(data)} bytes")
    profile = json.loads((ROOT / "profiles" / "dune-us.json").read_text(encoding="utf-8"))
    runtime_path = ROOT / "runtime" / manifest["runtime_file"]
    title = manifest.get("window_title", build_game_c.DEFAULT_TITLE)
    started = time.perf_counter()
    try:
        build_game_c.ensure_recompiler()
    except (ValueError, FileNotFoundError) as error:
        report.fail("reconcile/recompiler", str(error))
        return
    build_dir = ROOT / ".local/verify/build"
    out = ROOT / ".local/verify/dune.c"
    out.parent.mkdir(parents=True, exist_ok=True)
    try:
        result = build_game_c.build(
            rom, profile, build_dir, runtime_path, title, prepare=False
        )
    except (ValueError, FileNotFoundError) as error:
        report.fail("reconcile/rom", str(error))
        return
    seconds = time.perf_counter() - started
    if result.get("returncode") != 0 or not result.get("output_sha256"):
        report.fail(
            "reconcile/rom",
            "recompiler stopped: " + " | ".join(result.get("stdout", [])[:2]),
        )
        return
    out.write_bytes(Path(result["output_path"]).read_bytes())
    report.ok(
        "reconcile/rom",
        f"{result['entries']} entries, {result['translated_instructions']} instructions, "
        f"z80 {result['z80_guarded_variants']} variants",
        seconds=seconds,
    )
    report.check(
        result["output_sha256"] == manifest["shipped_core_sha256"]
        and result["output_bytes"] == manifest["shipped_core_bytes"],
        "reconcile/recompiled-core",
        f"ROM -> C is byte-identical to dune-web.c ({result['output_sha256'][:16]}…)",
        f"ROM -> C mismatch: {result['output_sha256']} {result['output_bytes']} bytes",
    )
    if prepared is not None:
        generated = Path(result["output_path"]).read_bytes()
        report.check(
            generated == prepared["core"].encode("utf-8"),
            "reconcile/byte-identical",
            "generated bytes == freshly prepared dune-web.c bytes",
            "generated bytes differ from the prepared dune-web.c bytes",
        )


def check_bundle(report: Report, manifest):
    reference = ROOT / "web" / "reference.json"
    if not reference.is_file():
        return
    data = json.loads(reference.read_text(encoding="utf-8"))
    mismatches = []
    for key, expected in (
        ("runtime_sha256", manifest["runtime_sha256"]),
        ("expected_output_sha256", manifest["shipped_core_sha256"]),
        ("expected_output_bytes", manifest["shipped_core_bytes"]),
    ):
        if data.get(key) != expected:
            mismatches.append(key)
    if mismatches:
        report.warn(
            "bundle/reference",
            "web/reference.json is stale (run tools/bundle_web.py): " + ", ".join(mismatches),
        )
    else:
        report.ok("bundle/reference", "web/reference.json matches the runtime manifest")


def find_input(arg_value, env_name, local_default):
    if arg_value:
        return Path(arg_value)
    env = os.environ.get(env_name)
    if env:
        return Path(env)
    return local_default


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--baseline",
        type=Path,
        help="external vendor/rearrakis/build/dune-base.c (game data; enables prepared-core check)",
    )
    parser.add_argument(
        "--rom", type=Path, help="player-supplied USA ROM (game data; enables ROM -> C rebuild)"
    )
    parser.add_argument("--json", action="store_true", help="print a JSON report")
    parser.add_argument("--quiet", action="store_true", help="only warnings/failures and the summary")
    args = parser.parse_args(argv)
    started = time.perf_counter()
    report = Report(quiet=args.quiet)
    if not args.quiet:
        print("runtime v2 verification")

    check_profile(report)
    vendor = check_vendor_inputs(report)
    manifest = load_manifest(report)
    prepared = None
    if manifest is not None:
        runtime_text = check_runtime_artifact(report, manifest, vendor)
        if runtime_text:
            check_adapters(report, manifest, runtime_text)
        baseline_path = find_input(
            args.baseline, "DUNE_BASELINE", ROOT / ".local/source/build/dune-base.c"
        )
        if baseline_path is not None and not Path(baseline_path).is_file():
            if args.baseline is not None:
                report.fail("inputs/baseline", f"not found: {args.baseline}")
                baseline_path = None
            else:
                baseline_path = None
        prepared = check_baseline(report, manifest, baseline_path)
        rom_path = find_input(args.rom, "DUNE_ROM", None)
        if rom_path is not None and not Path(rom_path).is_file():
            if args.rom is not None:
                report.fail("inputs/rom", f"not found: {args.rom}")
            rom_path = None
        check_rom(report, manifest, rom_path, prepared)
        check_bundle(report, manifest)

    elapsed = time.perf_counter() - started
    for entry in report.entries:
        if entry["status"] in ("warn", "fail") and args.quiet:
            print(f"  [{entry['status']}] {entry['name']}: {entry['detail']}")
    summary = {
        "ok": not report.failed,
        "passed": len(report.passed),
        "warnings": len(report.warnings),
        "failed": len(report.failed),
        "seconds": round(elapsed, 2),
        "checks": report.entries,
        "runtime_sha256": manifest["runtime_sha256"] if manifest else None,
        "runtime_bytes": manifest.get("runtime_bytes") if manifest else None,
        "shipped_core_sha256": manifest["shipped_core_sha256"] if manifest else None,
        "shipped_core_bytes": manifest.get("shipped_core_bytes") if manifest else None,
        "rom_recompiled": any(entry["name"] == "reconcile/recompiled-core" for entry in report.entries),
        "prepared_rebuilt": prepared is not None,
    }
    if args.json:
        print(json.dumps(summary, indent=2))
    else:
        print(
            f"summary: {summary['passed']} passed, {summary['warnings']} warnings, "
            f"{summary['failed']} failed in {summary['seconds']:.2f}s"
        )
        if report.failed:
            print(
                "RESULT: FAIL — " + "; ".join(entry["name"] for entry in report.failed),
                file=sys.stderr,
            )
        else:
            print("RESULT: OK — pinned runtime v2 and reconciliation contracts verified")
    return 0 if not report.failed else 1


if __name__ == "__main__":
    raise SystemExit(main())

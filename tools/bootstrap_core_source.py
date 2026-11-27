#!/usr/bin/env python3
"""Verify the pinned MIT ReArrakis sources and prepare the local workspace.

The generated game baseline (``build/dune-base.c``) is player-supplied game
data and is *not* part of this repository. This tool therefore verifies only the
vendored MIT recompiler tree against ``vendor/rearrakis/source-manifest.json``
and, unless ``--check`` is given, materialises the two local working trees:

    .local/source/genesis_recompiler/   pristine pinned sources (headers,
                                        audio_ymfm.cpp, YMFM, Python modules)
    .local/recompiler/genesis_recompiler/  importable generation package:
                                        vendored modules + the browser overlay
                                        (``--pinned-runtime``/``--window-title``)

Nothing here touches game data: ``build/dune-base.c`` is only ever read from an
external ``--baseline`` path and only its size/SHA-256 are reported. The old
``bootstrap_core_source.py`` also copied the baseline into ``.local``; the BYOP
port deliberately does not, because the baseline embeds the ROM and translated
game code.
"""
import argparse
import difflib
import hashlib
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / "vendor" / "rearrakis"
MANIFEST_PATH = VENDOR / "source-manifest.json"
OVERLAY = ROOT / "tools" / "recompiler_overlay"
LOCAL_SOURCE = ROOT / ".local" / "source"
LOCAL_RECOMPILER = ROOT / ".local" / "recompiler"

BASELINE_ENTRY = "build/dune-base.c"
RECOMPILER_DIR = "genesis_recompiler/"
OVERLAY_FILES = ("cli.py", "emit.py")
# The overlay only adds two additive features. These needles must be present and
# the rest of each module must stay close to the pinned upstream file.
OVERLAY_NEEDLES = {
    "cli.py": (
        "--pinned-runtime",
        "--window-title",
        "pinned_runtime = args.pinned_runtime.read_text()",
        "runtime_text=pinned_runtime, title=args.window_title",
    ),
    "emit.py": (
        "runtime_text: str | None = None",
        "if runtime_text is None:",
        "runtime = runtime_text",
        "window_title = title if title is not None",
    ),
}
MAX_OVERLAY_REMOVED_LINES = 12
MAX_OVERLAY_ADDED_LINES = 16


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256(path.read_bytes())


def load_manifest() -> dict:
    if not MANIFEST_PATH.is_file():
        raise FileNotFoundError(f"pinned source manifest missing: {MANIFEST_PATH}")
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


def verify_vendored() -> dict:
    """Verify every vendored pinned file that is present in this repository."""
    manifest = load_manifest()
    warnings = []
    files = 0
    total = 0
    for name, record in sorted(manifest["files"].items()):
        if name == BASELINE_ENTRY:
            # Game data: verified only when an external baseline is supplied.
            continue
        path = VENDOR / name
        if not path.is_file() or path.is_symlink():
            if name == "LICENSE":
                warnings.append(
                    "vendor/rearrakis/LICENSE is absent; licensing is recorded in "
                    "LICENSE-ReArrakis.md and THIRD_PARTY_NOTICES.md"
                )
                continue
            raise ValueError(f"pinned vendored source missing: {name}")
        data = path.read_bytes()
        if len(data) != record["bytes"] or sha256(data) != record["sha256"]:
            raise ValueError(f"pinned vendored source changed: {name}")
        files += 1
        total += len(data)
    recompiler_files = [n for n in manifest["files"] if n.startswith(RECOMPILER_DIR)]
    if not recompiler_files:
        raise ValueError("pinned manifest contains no genesis_recompiler files")
    return {
        "manifest": str(MANIFEST_PATH.relative_to(ROOT)),
        "files": files,
        "bytes": total,
        "recompilerFiles": len(recompiler_files),
        "warnings": warnings,
    }


def verify_overlay() -> dict:
    """Check that the committed overlay is the documented additive patch."""
    details = {}
    for name in OVERLAY_FILES:
        vendor_path = VENDOR / RECOMPILER_DIR / name
        overlay_path = OVERLAY / name
        if not overlay_path.is_file():
            raise FileNotFoundError(f"recompiler overlay file missing: {overlay_path}")
        vendor_text = vendor_path.read_text(encoding="utf-8")
        overlay_text = overlay_path.read_text(encoding="utf-8")
        if overlay_text == vendor_text:
            raise ValueError(f"recompiler overlay is not applied: {name}")
        for needle in OVERLAY_NEEDLES[name]:
            if needle not in overlay_text:
                raise ValueError(f"recompiler overlay {name} lacks expected patch: {needle!r}")
        matcher = difflib.SequenceMatcher(
            a=vendor_text.splitlines(), b=overlay_text.splitlines()
        )
        removed = added = 0
        for tag, i1, i2, j1, j2 in matcher.get_opcodes():
            if tag in ("replace", "delete"):
                removed += i2 - i1
            if tag in ("replace", "insert"):
                added += j2 - j1
        if removed > MAX_OVERLAY_REMOVED_LINES or added > MAX_OVERLAY_ADDED_LINES:
            raise ValueError(
                f"recompiler overlay {name} changes too much of the pinned module "
                f"(removed {removed}, added {added} lines)"
            )
        if matcher.ratio() < 0.95:
            raise ValueError(f"recompiler overlay {name} diverges from the pinned module")
        details[name] = {
            "sha256": sha256_file(overlay_path),
            "bytes": overlay_path.stat().st_size,
            "removedLines": removed,
            "addedLines": added,
        }
    return {"files": details}


def verify_baseline(path: Path) -> dict:
    """Verify an externally supplied generated baseline against the pin."""
    manifest = load_manifest()
    record = manifest["files"].get(BASELINE_ENTRY)
    if record is None:
        raise ValueError("pinned manifest has no build/dune-base.c record")
    path = Path(path)
    if not path.is_file():
        raise FileNotFoundError(f"external baseline not found: {path}")
    data = path.read_bytes()
    if len(data) != record["bytes"] or sha256(data) != record["sha256"]:
        raise ValueError(
            "external baseline does not match the pinned generated source: "
            f"{path} ({len(data)} bytes, sha256 {sha256(data)})"
        )
    if sha256(data) != manifest["generatedSourceSha256"]:
        raise ValueError("pinned manifest generatedSourceSha256 does not match the baseline")
    return {
        "path": str(path),
        "bytes": len(data),
        "sha256": sha256(data),
        "generatedSourceSha256": manifest["generatedSourceSha256"],
        "romSha256": manifest["romSha256"],
    }


def _copy_pinned_tree(manifest: dict) -> dict:
    copied = 0
    reused = 0
    total = 0
    for name, record in sorted(manifest["files"].items()):
        if not name.startswith(RECOMPILER_DIR):
            continue
        source = VENDOR / name
        target = LOCAL_SOURCE / name
        if target.exists():
            if target.is_symlink() or not target.is_file():
                raise ValueError(f"refusing to replace non-regular local input: {target}")
            if sha256_file(target) != record["sha256"]:
                raise ValueError(
                    "local native input differs; preserve it before bootstrapping: "
                    + str(target)
                )
            reused += 1
            total += target.stat().st_size
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        copied += 1
        total += target.stat().st_size
    return {"path": str(LOCAL_SOURCE), "copied": copied, "reused": reused, "bytes": total}


def _build_importable_package() -> dict:
    """Assemble the local generation package (vendored modules + overlay)."""
    package = LOCAL_RECOMPILER / "genesis_recompiler"
    if package.exists():
        shutil.rmtree(package)
    package.mkdir(parents=True)
    modules = 0
    for source in sorted((VENDOR / RECOMPILER_DIR).glob("*.py")):
        shutil.copyfile(source, package / source.name)
        modules += 1
    for name in OVERLAY_FILES:
        shutil.copyfile(OVERLAY / name, package / name)
    files = {
        path.name: {"bytes": path.stat().st_size, "sha256": sha256_file(path)}
        for path in sorted(package.iterdir())
        if path.is_file()
    }
    (LOCAL_RECOMPILER / "manifest.json").write_text(
        json.dumps(
            {
                "package": "genesis_recompiler",
                "source": "vendor/rearrakis/genesis_recompiler + tools/recompiler_overlay",
                "modules": modules,
                "files": files,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return {"path": str(package), "modules": modules, "files": len(files)}


def prepare_local(check_only=False, baseline=None):
    """Verify pinned inputs and (unless check_only) prepare local work trees."""
    report = {"vendor": verify_vendored(), "overlay": verify_overlay()}
    if baseline is not None:
        report["baseline"] = verify_baseline(baseline)
    if not check_only:
        manifest = load_manifest()
        report["pinnedTree"] = _copy_pinned_tree(manifest)
        report["package"] = _build_importable_package()
    report["checkOnly"] = check_only
    return report


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="verify only; do not populate .local")
    parser.add_argument(
        "--baseline",
        type=Path,
        help="optional external build/dune-base.c to verify against the pinned manifest",
    )
    parser.add_argument("--json", action="store_true", help="print a JSON report")
    args = parser.parse_args(argv)
    try:
        report = prepare_local(check_only=args.check, baseline=args.baseline)
    except (ValueError, FileNotFoundError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        vendor = report["vendor"]
        print(f"pinned MIT recompiler: {vendor['files']} files, {vendor['bytes']} bytes OK")
        for warning in vendor["warnings"]:
            print(f"warning: {warning}", file=sys.stderr)
        overlay = report["overlay"]["files"]
        print(
            "recompiler overlay: "
            + ", ".join(
                f"{name} +{info['addedLines']}/-{info['removedLines']} lines"
                for name, info in overlay.items()
            )
        )
        if "baseline" in report:
            baseline = report["baseline"]
            print(f"external baseline: {baseline['sha256']} ({baseline['bytes']} bytes) OK")
        if args.check:
            print("check only: .local was not modified")
        else:
            tree = report["pinnedTree"]
            package = report["package"]
            print(f"pristine sources: {tree['path']} ({tree['copied']} copied, {tree['reused']} reused)")
            print(f"generation package: {package['path']} ({package['modules']} modules + overlay)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

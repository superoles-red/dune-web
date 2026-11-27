#!/usr/bin/env python3
"""Recompile the player's ROM into the prepared C core, exactly like the old build.

Derived from ReArrakis ``tools/build_dune.py`` (andvolodko/dune2-sega-web
@56c6a6da10, MIT) through the browser adaptation: discovery order, Z80 image
patches and every compiler argument are kept identical. The only differences are
that the recompiler is called in-process instead of through ``subprocess`` and
that it receives the pinned runtime via ``--pinned-runtime`` and the shipped
window title via ``--window-title``.

This is the local verification path for `tools/verify.py`: a supported ROM must
produce a C core byte-identical to the prepared ``dune-web.c`` pinned in
``runtime/manifest.json`` (SHA-256 d7c84066...). The ROM is never stored in the
repository and the generated core stays in ``.local/`` (untracked).

Usage:
    python3 tools/build_game_c.py --rom "/path/to/Dune - The Battle for Arrakis (USA).gen"
"""
import argparse
import hashlib
import io
import json
import sys
import time
from contextlib import redirect_stdout
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
sys.path.insert(0, str(TOOLS))

DEFAULT_PROFILE = ROOT / "profiles" / "dune-us.json"
DEFAULT_RUNTIME = ROOT / "runtime" / "dune-runtime-v2.c"
RUNTIME_MANIFEST = ROOT / "runtime" / "manifest.json"
DEFAULT_TITLE = "ReArrakis  Dune: The Battle for Arrakis"
DEFAULT_OUT = ROOT / ".local/verify/dune.c"

_IMPORTED = False


class RomRejected(ValueError):
    pass


def ensure_recompiler() -> None:
    """Prepare the local patched recompiler package and import it."""
    global _IMPORTED
    if _IMPORTED:
        return
    import bootstrap_core_source as bootstrap

    bootstrap.prepare_local()
    local_package = str(ROOT / ".local/recompiler")
    if local_package not in sys.path:
        sys.path.insert(0, local_package)
    _IMPORTED = True


def manifest_title() -> str:
    if RUNTIME_MANIFEST.is_file():
        return json.loads(RUNTIME_MANIFEST.read_text(encoding="utf-8")).get(
            "window_title", DEFAULT_TITLE
        )
    return DEFAULT_TITLE


def validate_rom(rom: bytes, profile: dict) -> str:
    digest = hashlib.sha256(rom).hexdigest()
    if len(rom) != profile["rom_bytes"] or digest != profile["sha256"]:
        raise RomRejected(
            "Это не поддерживаемая USA-версия Dune: The Battle for Arrakis. "
            "Нужен образ 1 048 576 байт с SHA-256 " + profile["sha256"]
        )
    return digest


def _z80_images(rom: bytes, build: Path):
    """Same ROM slices and guarded variants as tools/build_dune.py."""
    z80 = build / "dune-z80.bin"
    z80.write_bytes(rom[0x2952:0x41DC])
    boot = build / "dune-z80-boot.bin"
    boot.write_bytes(rom[0x2C4:0x2EA])
    patched = build / "dune-z80-patched.bin"
    image = bytearray(rom[0x2952:0x41DC])
    image[0x2B3:0x2B8] = bytes.fromhex("18261826c9")
    patched.write_bytes(image)
    music = build / "dune-z80-music.bin"
    image[0x2B7:0x2B9] = bytes.fromhex("d908")
    music.write_bytes(image)
    playing = build / "dune-z80-playing.bin"
    image[0x2C4:0x2C6] = bytes.fromhex("0000")
    image[0x302] = 0
    playing.write_bytes(image)
    voice = build / "dune-z80-voice.bin"
    if image[0x2CF] != 0xC9:
        raise ValueError("unexpected Z80 driver bytes in this ROM")
    image[0x2CF] = 0
    voice.write_bytes(image)
    return boot, z80, patched, music, playing, voice


def _discover_entries(rom: bytes, profile: dict):
    """Verbatim port of the entry discovery loop from tools/build_dune.py."""
    from genesis_recompiler.decode import EA, Decoder, analyze

    entries = set(profile["entries"])
    for table in profile.get("callback_tables", []):
        offset, count = table["offset"], table["count"]
        if not 0 <= offset <= len(rom) - count * 4:
            raise ValueError("callback table out of range")
        for pos in range(offset, offset + count * 4, 4):
            target = int.from_bytes(rom[pos:pos + 4], "big")
            if not (target % 2 == 0 and 0 <= target < len(rom)):
                raise ValueError("bad callback target")
            Decoder(rom, target).decode()
            entries.add(target)
    for table in profile.get("relative_callback_tables", []):
        base, first, count = table["offset"], table["first"], table["count"]
        if not 0 <= first < count and 0 <= base <= len(rom) - count * 2:
            raise ValueError("relative callback table out of range")
        for index in range(first, count):
            pos = base + index * 2
            target = base + int.from_bytes(rom[pos:pos + 2], "big", signed=True)
            if not (target % 2 == 0 and 0 <= target < len(rom)):
                raise ValueError("bad relative callback target")
            Decoder(rom, target).decode()
            entries.add(target)
    for _ in range(16):
        program = analyze(rom, [0x200, *entries])
        preceding = {inst.end: inst for inst in program.instructions.values()}
        added = set()
        for call in program.instructions.values():
            if call.op != "JSR" or call.target != 0x4796:
                continue
            argument = preceding.get(call.pc)
            if (
                argument is not None
                and argument.op == "MOVE"
                and argument.size == 4
                and argument.src.mode == 7
                and argument.src.reg == 4
                and argument.dst == EA(2, 7)
                and 0 < argument.src.value < len(rom)
                and argument.src.value % 2 == 0
            ):
                Decoder(rom, argument.src.value).decode()
                added.add(argument.src.value)
        for jump in program.instructions.values():
            if jump.op != "JMP" or jump.src.mode != 7 or jump.src.reg != 3:
                continue
            rotate = preceding.get(jump.pc)
            mask = preceding.get(rotate.pc) if rotate is not None else None
            if (
                rotate is not None
                and mask is not None
                and rotate.op == "ROL"
                and rotate.size == 2
                and rotate.src == EA(7, 4, value=3)
                and rotate.dst.mode == 0
                and mask.op == "ANDI"
                and mask.size == 2
                and mask.src == EA(7, 4, value=0xC000)
                and mask.dst == rotate.dst
                and jump.src.index == ((rotate.dst.reg << 12) | 2)
            ):
                for index in range(4):
                    target = jump.src.value + index * 2
                    Decoder(rom, target).decode()
                    added.add(target)
                continue
            sequence = []
            before = jump.pc
            for _ in range(6):
                inst = preceding.get(before)
                if inst is None:
                    break
                sequence.append(inst)
                before = inst.pc
            if len(sequence) != 6:
                continue
            load, scale, upper, compare, lower, normalize = sequence
            if not (
                load.op == "MOVE"
                and load.size == 2
                and load.src.mode == 7
                and load.src.reg == 3
                and load.dst == EA(0, 0)
                and load.src.value == jump.src.value
                and load.src.index == 0x0806
                and jump.src.index == 0x0002
                and scale.op == "ADD"
                and scale.size == 4
                and scale.src == EA(0, 0)
                and scale.dst == EA(0, 0)
                and upper.op == "BCC"
                and upper.condition == 14
                and compare.op == "CMPI"
                and compare.size == 4
                and compare.dst == EA(0, 0)
                and compare.src.mode == 7
                and compare.src.reg == 4
                and 0 <= compare.src.value < 256
                and lower.op == "BCC"
                and lower.condition == 11
                and lower.target == upper.target
                and normalize.op in ("EXT", "SUBQ", "SUBI")
                and normalize.size == 4
                and normalize.dst == EA(0, 0)
            ):
                continue
            base = load.src.value
            for index in range(compare.src.value + 1):
                offset = base + index * 2
                target = base + int.from_bytes(rom[offset:offset + 2], "big", signed=True)
                Decoder(rom, target).decode()
                added.add(target)
        new = added - entries
        if not new:
            break
        entries.update(new)
    return sorted(entries)


def build(rom_path, profile, build_dir, runtime_path, title, prepare=True):
    """Translate the player's ROM into C exactly like the old desktop build."""
    if prepare:
        ensure_recompiler()
    from genesis_recompiler.cli import main as cli_main

    timings = {}
    rom_path = Path(rom_path)
    build_dir = Path(build_dir)
    build_dir.mkdir(parents=True, exist_ok=True)

    started = time.perf_counter()
    rom = rom_path.read_bytes()
    rom_sha = validate_rom(rom, profile)
    timings["validate_rom"] = time.perf_counter() - started

    started = time.perf_counter()
    boot, z80, patched, music, playing, voice = _z80_images(rom, build_dir)
    timings["z80_images"] = time.perf_counter() - started

    started = time.perf_counter()
    entries = _discover_entries(rom, profile)
    timings["entry_discovery"] = time.perf_counter() - started

    output = build_dir / "dune.c"
    argv = [
        str(rom_path),
        "-o",
        str(output),
        "--z80-image",
        str(boot),
        "--z80-image",
        str(z80),
        "--z80-image",
        str(patched),
        "--z80-image",
        str(music),
        "--z80-image",
        str(playing),
        "--z80-image",
        str(voice),
        "--z80-image-entry",
        "2:0x2b3",
        "--z80-image-entry",
        "3:0x2b3",
        "--z80-image-entry",
        "4:0x2b3",
        "--z80-image-entry",
        "5:0x2b3",
        "--z80-image-entry",
        "5:0x2cf",
        "--z80-image-entry",
        "1:0x38",
        "--z80-image-entry",
        "2:0x38",
        "--z80-image-entry",
        "3:0x38",
        "--z80-image-entry",
        "4:0x38",
        "--z80-image-entry",
        "5:0x38",
        "--z80-overlay",
        "0:e9",
        "--z80-mutable-displacement",
        "0x1616",
        "--z80-mutable-displacement",
        "0x15f9",
        "--pinned-runtime",
        str(runtime_path),
        "--window-title",
        title,
    ]
    for entry in entries:
        argv += ["--entry", hex(entry)]

    started = time.perf_counter()
    stdout = io.StringIO()
    code = 0
    try:
        with redirect_stdout(stdout):
            code = cli_main(argv)
    except SystemExit as error:  # argparse errors
        code = int(error.code or 1)
    timings["translate_and_emit"] = time.perf_counter() - started

    translated = z80_variants = None
    for line in stdout.getvalue().splitlines():
        if line.startswith("Z80 translated="):
            try:
                z80_variants = int(line.split("Z80 translated=")[1].split(" ")[0])
            except (IndexError, ValueError):
                pass
        elif "translated=" in line:
            try:
                translated = int(line.split("translated=")[1].split(" ")[0])
            except (IndexError, ValueError):
                pass

    result = {
        "returncode": code,
        "entries": len(entries),
        "translated_instructions": translated,
        "z80_guarded_variants": z80_variants,
        "stdout": stdout.getvalue().strip().splitlines()[-4:],
        "timings": timings,
        "rom_sha256": rom_sha,
    }
    if code != 0 or not output.is_file():
        result["error"] = "translation stopped (see stdout)"
        return result

    started = time.perf_counter()
    data = output.read_bytes()
    result.update(
        {
            "output_path": str(output),
            "output_bytes": len(data),
            "output_sha256": hashlib.sha256(data).hexdigest(),
        }
    )
    timings["hash_output"] = time.perf_counter() - started
    result["timings"] = timings
    return result


def expected_core():
    """Return the pinned core identity from runtime/manifest.json, if present."""
    if not RUNTIME_MANIFEST.is_file():
        return None
    manifest = json.loads(RUNTIME_MANIFEST.read_text(encoding="utf-8"))
    return {
        "sha256": manifest.get("shipped_core_sha256"),
        "bytes": manifest.get("shipped_core_bytes"),
        "runtime_sha256": manifest.get("runtime_sha256"),
        "window_title": manifest.get("window_title"),
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--rom", type=Path, required=True, help="player-supplied USA ROM (never stored)")
    parser.add_argument(
        "--profile", type=Path, default=DEFAULT_PROFILE, help="dump profile (default: profiles/dune-us.json)"
    )
    parser.add_argument(
        "--runtime",
        type=Path,
        default=DEFAULT_RUNTIME,
        help="pinned runtime preamble passed as --pinned-runtime (default: runtime/dune-runtime-v2.c)",
    )
    parser.add_argument("--title", default=None, help="window title (default from runtime/manifest.json)")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="generated C core (default: .local/verify/dune.c)")
    parser.add_argument("--build-dir", type=Path, default=None, help="scratch directory (default: parent of --out)")
    parser.add_argument("--json", action="store_true", help="print a JSON report")
    args = parser.parse_args(argv)

    if not args.runtime.is_file():
        print(f"error: pinned runtime not found: {args.runtime}", file=sys.stderr)
        return 1
    profile = json.loads(args.profile.read_text(encoding="utf-8"))
    title = args.title if args.title is not None else manifest_title()
    out = args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    build_dir = args.build_dir if args.build_dir is not None else out.parent / "build"

    started = time.perf_counter()
    try:
        result = build(args.rom, profile, build_dir, args.runtime, title)
    except RomRejected as error:
        print(f"error: unsupported ROM: {error}", file=sys.stderr)
        return 1
    result["total_seconds"] = time.perf_counter() - started
    result["runtime"] = str(args.runtime)
    result["window_title"] = title

    pinned = expected_core()
    result["expected_core_sha256"] = pinned["sha256"] if pinned else None
    result["expected_core_bytes"] = pinned["bytes"] if pinned else None
    result["matches_shipped_core"] = bool(
        pinned
        and result.get("output_sha256") == pinned["sha256"]
        and result.get("output_bytes") == pinned["bytes"]
    )
    # Move the generated core to the requested path (game data stays in .local).
    if result.get("output_path") and Path(result["output_path"]).resolve() != out.resolve():
        target = out.resolve()
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(Path(result["output_path"]).read_bytes())
        result["output_path"] = str(target)

    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print(f"ROM: {result['rom_sha256']} ({args.rom.stat().st_size} bytes) OK")
        print(
            f"entries: {result['entries']}, instructions: {result['translated_instructions']}, "
            f"z80 variants: {result['z80_guarded_variants']}"
        )
        print(f"core: {result['output_sha256']} ({result['output_bytes']} bytes)")
        if pinned:
            print(f"pinned: {pinned['sha256']} ({pinned['bytes']} bytes)")
            print("match: " + ("byte-identical to the prepared dune-web.c" if result["matches_shipped_core"] else "MISMATCH"))
        print(f"elapsed: {result['total_seconds']:.2f}s")
    if result.get("returncode") != 0 or not result.get("output_sha256"):
        return 1
    if pinned and not result["matches_shipped_core"]:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

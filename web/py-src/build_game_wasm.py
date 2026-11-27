"""Build the full game.wasm from the player's ROM inside Pyodide.

Reuses the pinned ReArrakis decoder for discovery/analysis and the MIT WASM
emitter for code generation. The runtime ABI (offsets, addresses, fail codes)
comes from ``abi.json`` exported from the shipped runtime.wasm, so the generated
module links only against that exact runtime. Deterministic: the same ROM, ABI
and emitter produce the same bytes, which lets the page verify the SHA.

The module contains the **real** Z80 translation (2577 guarded PCs / 3095
guarded variants from the pinned six-image plan) so the original GEMS driver
runs and the YM2612/PSG audio path can be enabled by the host
(``dune_rt_set_audio_mode(3)`` + ``dune_rt_audio_pop``).  ``z80_translate``
reproduces the reference desktop build (``tools/build_game_c.py``) from the ROM;
nothing game-derived is embedded in the package.
"""
import hashlib
import json
import sys
import time
from pathlib import Path


def _progress(progress, phase, fraction):
    line = f"PROGRESS {phase} {fraction:.3f}"
    if progress is None:
        print(line, flush=True)
    else:
        progress(phase, fraction)


def build(rom_path, profile_path, abi_path, out_path, progress=None):
    started = time.perf_counter()
    timings = {}
    from genesis_recompiler.decode import analyze
    from wasm_emitter import abi, game_module, z80_translate
    import dune_build

    _progress(progress, "validate_rom", 0.01)
    rom = Path(rom_path).read_bytes()
    profile = json.loads(Path(profile_path).read_text())
    abi_data = json.loads(Path(abi_path).read_text())
    rom_sha = dune_build.validate_rom(rom, profile)

    t = time.perf_counter()
    cpu_abi = abi.CpuAbi(**abi_data["cpu_abi"])
    layout = abi.MemoryLayout(**abi_data["memory_layout"])
    fail_map = {int(k): int(v) for k, v in abi_data["fail_codes"]["canonical_to_runtime"].items()}
    timings["abi"] = time.perf_counter() - t

    _progress(progress, "entry_discovery", 0.02)
    t = time.perf_counter()
    entries = dune_build._discover_entries(rom, profile)
    timings["entry_discovery"] = time.perf_counter() - t
    _progress(progress, "entry_discovery", 0.50)

    t = time.perf_counter()
    reset = int.from_bytes(rom[4:8], "big") & 0xFFFFFF
    interrupts = {
        level: int.from_bytes(rom[(24 + level) * 4:(25 + level) * 4], "big") & 0xFFFFFF
        for level in (4, 6)
    }
    program = analyze(rom, [reset, *interrupts.values(), *entries])
    timings["decode"] = time.perf_counter() - t

    # Z80 driver: same six ROM images / entries / overlays / mutable
    # displacements as the reference native build (tools/build_game_c.py).
    _progress(progress, "z80_analysis", 0.70)
    t = time.perf_counter()
    z80_program = z80_translate.analyze_dune_z80(rom)
    z80_summary = z80_translate.z80_program_summary(z80_program)
    if z80_summary["errors"]:
        raise RuntimeError(
            "Z80 analysis produced %d decode error(s)" % len(z80_summary["errors"])
        )
    timings["z80_analysis"] = time.perf_counter() - t
    _progress(progress, "translate_emit", 0.75)

    t = time.perf_counter()
    data, meta = game_module.build_module(
        program,
        list(program.instructions.values()),
        cpu_abi,
        layout,
        label="dune-game",
        helper_prefix="dune_",
        fail_code_map=fail_map,
        z80_stub=False,
        z80_program=z80_program,
        instruction_meta=False,
    )
    timings["emit"] = time.perf_counter() - t
    _progress(progress, "translate_emit", 0.98)

    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(data)
    t = time.perf_counter()
    digest = hashlib.sha256(data).hexdigest()
    timings["hash_output"] = time.perf_counter() - t
    modules = meta.get("modules", {})
    return {
        "rom_sha256": rom_sha,
        "abi_hash": meta.get("abi_hash"),
        "game_sha256": digest,
        "game_bytes": len(data),
        "instructions": len(program.instructions),
        "pages": meta.get("pages") or len({inst.pc >> 12 for inst in program.instructions.values()}),
        "z80": z80_summary,
        "z80_variants": z80_summary["variants"],
        "handlers_bytes": modules.get("handler_bytes"),
        "timings": timings,
        "total_seconds": time.perf_counter() - started,
    }

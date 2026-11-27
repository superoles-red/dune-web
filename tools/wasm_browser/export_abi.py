#!/usr/bin/env python3
"""Export the runtime ABI (from runtime.wasm) as JSON for the in-browser emitter.

The browser builds ``game.wasm`` against this exported descriptor; the host still
reads the same numbers from ``runtime.wasm`` at run time, so a drift between them
fails the link instead of silently producing wrong code.
"""
import argparse
import dataclasses
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rom", type=Path, required=True)
    parser.add_argument("--out", type=Path, default=ROOT / "runtime" / "wasm" / "abi.json")
    parser.add_argument("--node")
    args = parser.parse_args()

    from wasm_integration import runtime_abi

    rom = args.rom.read_bytes()
    rt = runtime_abi.load_runtime_abi(node=args.node)
    layout = rt.memory_layout(len(rom))
    payload = {
        "format": "dune-runtime-abi/1",
        "runtime_sha256": rt.runtime_sha256,
        "runtime_bytes": rt.runtime_bytes,
        "memory_pages": rt.memory_pages,
        "abi_hash": rt.abi_hash,
        "abi_version": rt.cpu_abi.version,
        "helper_abi_version": rt.cpu_abi.helper_abi_version,
        "pointer_bits": rt.cpu_abi.pointer_bits,
        "cpu_abi": dataclasses.asdict(rt.cpu_abi),
        "memory_layout": dataclasses.asdict(layout),
        "fail_codes": {
            "canonical_to_runtime": {str(k): v for k, v in rt.fail_codes.canonical_to_runtime.items()},
            "runtime_names": dict(rt.fail_codes.runtime_names),
            "lossy_canonical": list(rt.fail_codes.lossy_canonical),
        },
        "rom_bytes": len(rom),
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
    print(f"wrote {args.out} ({args.out.stat().st_size} bytes, abi {rt.abi_hash[:16]})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

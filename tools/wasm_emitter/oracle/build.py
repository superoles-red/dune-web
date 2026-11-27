"""Build (and cache) the native C oracle from the player-supplied dune-base.c."""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path
from typing import List, Optional

from .. import abi

ORACLE_MAIN = Path(__file__).resolve().with_name("dune_oracle_main.c")


class OracleBuildError(RuntimeError):
    pass


def _escape_c_string(text: str) -> str:
    return text.replace("\\", "\\\\").replace('"', '\\"')


def write_fail_map(path: Path) -> None:
    lines = [
        "/* Generated from tools/wasm_emitter/abi.py FAIL_REASONS; do not edit. */",
        "static const struct { const char *prefix; unsigned code; } dune_fail_map[] = {",
    ]
    for prefix, name in abi.FAIL_REASONS:
        lines.append('    {"%s", %du},' % (_escape_c_string(prefix), abi.FAIL_CODES[name]))
    lines += [
        "};",
        "static unsigned dune_fail_code(const char *reason) {",
        "    if (!reason) return 0u;",
        "    for (size_t i = 0; i < sizeof dune_fail_map / sizeof dune_fail_map[0]; ++i) {",
        "        const char *prefix = dune_fail_map[i].prefix;",
        "        size_t n = strlen(prefix);",
        "        if (strncmp(reason, prefix, n) == 0) return dune_fail_map[i].code;",
        "    }",
        "    return 0xFFFFFFFFu;",
        "}",
        "",
    ]
    path.write_text("\n".join(lines), encoding="utf-8")


def _stamp(baseline: Path, out_dir: Path) -> str:
    payload = {
        "baseline_size": baseline.stat().st_size,
        "baseline_mtime_ns": baseline.stat().st_mtime_ns,
        "baseline_sha256": hashlib.sha256(baseline.read_bytes()).hexdigest(),
        "oracle_main_sha256": hashlib.sha256(ORACLE_MAIN.read_bytes()).hexdigest(),
        "abi_fail_codes": abi.FAIL_CODES,
        "abi_fail_reasons": abi.FAIL_REASONS,
    }
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True).encode("utf-8")
    ).hexdigest()


def find_clang() -> str:
    from shutil import which

    for candidate in ("/usr/bin/clang", "clang"):
        path = which(candidate) if not candidate.startswith("/") else candidate
        if path and Path(path).is_file():
            return str(path)
    raise OracleBuildError("clang is required to build the native C oracle")


def build_oracle(root: Path, baseline: Path, out_dir: Path,
                 force: bool = False, include_dirs=()) -> Path:
    root = Path(root).resolve()
    baseline = Path(baseline).resolve()
    out_dir = Path(out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    if not baseline.is_file():
        raise OracleBuildError("baseline C core not found: %s" % baseline)
    binary = out_dir / "dune_oracle"
    stamp_path = out_dir / "dune_oracle.stamp"
    fail_map = out_dir / "fail_map.inc"
    wrapper = out_dir / "dune_oracle_wrapper.c"
    stamp = _stamp(baseline, out_dir)
    if not force and binary.is_file() and stamp_path.is_file():
        if stamp_path.read_text(encoding="utf-8").strip() == stamp:
            return binary
    write_fail_map(fail_map)
    wrapper.write_text(
        "/* Generated wrapper: include the player C core and the oracle driver. */\n"
        "#define GENESIS_NO_MAIN\n"
        '#include "%s"\n'
        '#include "%s"\n'
        % (_escape_c_string(str(baseline)), _escape_c_string(str(ORACLE_MAIN))),
        encoding="utf-8",
    )
    command: List[str] = [
        find_clang(),
        "-std=c11",
        "-O0",
        "-w",
        "-DDUNE_FAIL_MAP=%s" % json.dumps(str(fail_map)),
    ]
    for include_dir in include_dirs:
        command += ["-I", str(include_dir)]
    command += [str(wrapper), "-o", str(binary), "-lm"]
    process = subprocess.run(command, capture_output=True, text=True)
    if process.returncode != 0:
        raise OracleBuildError(
            "clang failed building the C oracle:\n%s\n%s"
            % (process.stdout, process.stderr)
        )
    stamp_path.write_text(stamp + "\n", encoding="utf-8")
    return binary


def run_oracle(binary: Path, args: List[str], timeout: int = 600) -> subprocess.CompletedProcess:
    return subprocess.run([str(binary)] + list(args), capture_output=True, text=True,
                          timeout=timeout)


def oracle_abi(binary: Path) -> dict:
    process = run_oracle(binary, ["--abi"])
    if process.returncode != 0:
        raise OracleBuildError("oracle --abi failed:\n" + process.stderr)
    try:
        return json.loads(process.stdout)
    except json.JSONDecodeError as error:
        raise OracleBuildError("oracle --abi produced invalid JSON: %s" % error)


def oracle_ram_digest(binary: Path, seed: int) -> str:
    process = run_oracle(binary, ["--ram-digest", str(seed)])
    if process.returncode != 0:
        raise OracleBuildError("oracle --ram-digest failed:\n" + process.stderr)
    return process.stdout.strip()


__all__ = [
    "build_oracle", "run_oracle", "oracle_abi", "oracle_ram_digest",
    "write_fail_map", "OracleBuildError", "find_clang",
]

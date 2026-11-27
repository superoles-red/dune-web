"""Compare the C oracle and WASM result files byte-for-byte per record."""

from __future__ import annotations

from pathlib import Path
from typing import Dict, List, Sequence, Tuple

from . import format as fmt

FIELD_NAMES = (
    "d", "a", "pc", "usp", "ssp", "sr", "instruction_cycles", "halted", "fault",
    "fault_address", "fault_code", "initial_digest", "final_digest",
)


class ResultError(RuntimeError):
    pass


def read_result_file(path: Path) -> Tuple[List[Tuple[int, ...]], dict]:
    data = Path(path).read_bytes()
    if len(data) < fmt.HEADER.size:
        raise ResultError("%s: short result header" % path)
    magic, version, count, record_size, ram_size = fmt.unpack_header(data)
    if (magic, version, record_size, ram_size) != (
        fmt.OUT_MAGIC, fmt.FORMAT_VERSION, fmt.OUT.size, fmt.RAM_SIZE
    ):
        raise ResultError("%s: incompatible result header" % path)
    if len(data) != fmt.HEADER.size + count * record_size:
        raise ResultError("%s: result length mismatch" % path)
    offset = fmt.HEADER.size
    records = [fmt.unpack_out(data, offset + index * record_size) for index in range(count)]
    return records, {"count": count, "record_size": record_size}


def _mismatch(case_index: int, pc: int, name: str, c_value, w_value) -> dict:
    return {
        "case": case_index,
        "pc": pc,
        "field": name,
        "oracle": c_value,
        "wasm": w_value,
    }


def compare_results(cases, oracle_records, wasm_records,
                    max_report: int = 12) -> dict:
    if len(oracle_records) != len(wasm_records):
        raise ResultError(
            "result count mismatch: oracle %d != wasm %d"
            % (len(oracle_records), len(wasm_records))
        )
    if len(cases) != len(oracle_records):
        raise ResultError("case/result count mismatch")
    mismatches: List[dict] = []
    mismatch_cases = 0
    fault_histogram: Dict[int, int] = {}
    oracle_faults = 0
    wasm_faults = 0
    for index, (case, c_record, w_record) in enumerate(
        zip(cases, oracle_records, wasm_records)
    ):
        c_fields = fmt.out_fields(c_record)
        w_fields = fmt.out_fields(w_record)
        pc = fmt.case_fields(case)["pc"]
        if c_fields["fault"]:
            oracle_faults += 1
            fault_histogram[c_fields["fault_code"]] = fault_histogram.get(c_fields["fault_code"], 0) + 1
        if w_fields["fault"]:
            wasm_faults += 1
        case_bad = False
        for name in FIELD_NAMES:
            c_value = c_fields[name]
            w_value = w_fields[name]
            if c_value != w_value:
                case_bad = True
                if len(mismatches) < max_report:
                    mismatches.append(_mismatch(index, pc, name, c_value, w_value))
        if case_bad:
            mismatch_cases += 1
    return {
        "cases": len(cases),
        "mismatch_cases": mismatch_cases,
        "mismatches": mismatches,
        "oracle_faults": oracle_faults,
        "wasm_faults": wasm_faults,
        "fault_code_histogram": {str(k): v for k, v in sorted(fault_histogram.items())},
        "ok": mismatch_cases == 0,
    }


def compare_result_files(case_path: Path, oracle_path: Path, wasm_path: Path,
                         max_report: int = 12) -> dict:
    from .cases import read_case_file

    cases = read_case_file(case_path)
    oracle_records, oracle_meta = read_result_file(oracle_path)
    wasm_records, wasm_meta = read_result_file(wasm_path)
    report = compare_results(cases, oracle_records, wasm_records, max_report)
    report["oracle"] = oracle_meta
    report["wasm"] = wasm_meta
    return report


__all__ = ["compare_results", "compare_result_files", "read_result_file", "ResultError"]

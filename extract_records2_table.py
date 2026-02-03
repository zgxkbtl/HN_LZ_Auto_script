from __future__ import annotations

import argparse
import datetime as dt
import json
import re
from pathlib import Path
from typing import Any


def _is_table_line(line: str) -> bool:
    s = line.strip()
    return s.startswith("|") and s.endswith("|") and "|" in s[1:-1]


def _split_md_row(line: str) -> list[str]:
    raw = line.strip()
    if raw.startswith("|"):
        raw = raw[1:]
    if raw.endswith("|"):
        raw = raw[:-1]
    return [cell.strip() for cell in raw.split("|")]


def _is_alignment_row(cells: list[str]) -> bool:
    def looks_like_align(cell: str) -> bool:
        s = cell.strip()
        if not s:
            return False
        return bool(re.fullmatch(r":?-{3,}:?", s))

    return len(cells) > 0 and all(looks_like_align(c) for c in cells)


def _coerce_int(text: str) -> int | None:
    t = (text or "").strip()
    if not t:
        return None
    m = re.search(r"\d+", t)
    if not m:
        return None
    try:
        return int(m.group(0))
    except ValueError:
        return None


def _clean_cell(text: str) -> str:
    s = (text or "").strip()
    if not s:
        return ""
    # records2.md sometimes contains <br> to embed line breaks.
    s = re.sub(r"<\s*br\s*/?\s*>", " ", s, flags=re.IGNORECASE)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _parse_iso_date(value: str) -> dt.date:
    value = value.strip()

    # Accept YYYY-MM-DD
    m = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", value)
    if m:
        return dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))

    # Accept M.D or MM.DD (default year=2025 to match existing dataset)
    m = re.fullmatch(r"(\d{1,2})\.(\d{1,2})", value)
    if m:
        return dt.date(2025, int(m.group(1)), int(m.group(2)))

    raise argparse.ArgumentTypeError(
        f"Invalid date '{value}'. Use YYYY-MM-DD or M.D (e.g. 2025-04-20 or 4.20)."
    )


def extract_records2_table(text: str) -> dict[str, Any]:
    lines = text.splitlines()

    header_cells: list[str] | None = None
    header_line_index: int | None = None

    for i, line in enumerate(lines):
        if not _is_table_line(line):
            continue
        cells = _split_md_row(line)
        if "手术间" in cells and "手术名称" in cells:
            header_cells = cells
            header_line_index = i
            break

    if header_cells is None or header_line_index is None:
        return {
            "schedule": {
                "date_text": None,
                "date_iso": None,
                "weekday": None,
                "total_count": 0,
            },
            "surgeries": [],
        }

    # Determine row start (skip alignment row if present).
    row_start = header_line_index + 1
    if row_start < len(lines) and _is_table_line(lines[row_start]):
        align_cells = _split_md_row(lines[row_start])
        if _is_alignment_row(align_cells):
            row_start += 1

    col_index = {name: idx for idx, name in enumerate(header_cells)}

    def _get(row: list[str], *names: str) -> str:
        for name in names:
            idx = col_index.get(name)
            if idx is None:
                continue
            if 0 <= idx < len(row):
                return _clean_cell(row[idx])
        return ""

    def normalize_row(row_cells: list[str]) -> list[str]:
        if len(row_cells) == len(header_cells):
            return row_cells
        if len(row_cells) < len(header_cells):
            return row_cells + [""] * (len(header_cells) - len(row_cells))
        fixed = row_cells[: len(header_cells) - 1]
        fixed.append("|".join(row_cells[len(header_cells) - 1 :]).strip())
        return fixed

    surgeries: list[dict[str, Any]] = []

    for j in range(row_start, len(lines)):
        line = lines[j]
        if not _is_table_line(line):
            if surgeries:
                break
            continue

        row_cells = normalize_row(_split_md_row(line))
        if _is_alignment_row(row_cells):
            continue

        assistants = [
            _get(row_cells, "医助1"),
            _get(row_cells, "医助2"),
            _get(row_cells, "医助3"),
            _get(row_cells, "医助4"),
        ]
        assistants = [a for a in (x.strip() for x in assistants) if a]

        record: dict[str, Any] = {
            "room": _get(row_cells, "手术间"),
            "department": _get(row_cells, "科室"),
            # records2.md uses 床号; records.md uses 号
            "number": _get(row_cells, "床号", "号"),
            "inpatient_no": _get(row_cells, "住院号"),
            "name": _get(row_cells, "姓名"),
            "gender": _get(row_cells, "性别"),
            "age": _coerce_int(_get(row_cells, "年龄")),
            "surgery_name": _get(row_cells, "手术名称"),
            "surgeon": _get(row_cells, "主刀医生"),
            "assistants": assistants,
            "anesthesia_method": _get(row_cells, "麻醉方法"),
            "anesthesia_main": _get(row_cells, "主麻"),
            "anesthesia_assistant": _get(row_cells, "副麻"),
            "remark": _get(row_cells, "备注"),
            "_row": j + 1,
        }

        # Normalize empty strings to None (match existing JSON style)
        for k, v in list(record.items()):
            if k.startswith("_"):
                continue
            if isinstance(v, str) and not v:
                record[k] = None

        surgeries.append(record)

    return {
        "schedule": {
            "date_text": None,
            "date_iso": None,
            "weekday": None,
            "total_count": len(surgeries),
        },
        "surgeries": surgeries,
    }


def add_operate_date(
    payload: dict[str, Any], *, start: dt.date, group_size: int
) -> dict[str, Any]:
    surgeries = payload.get("surgeries")
    if not isinstance(surgeries, list):
        raise ValueError("payload must contain a top-level 'surgeries' list")

    if group_size <= 0:
        raise ValueError("group_size must be > 0")

    for i, item in enumerate(surgeries):
        if not isinstance(item, dict):
            continue
        operate_dt = start + dt.timedelta(days=i // group_size)
        item["operate_date"] = operate_dt.isoformat()

    return payload


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Extract the surgery table from records2.md into JSON (fields aligned with "
            "records_surgery_with_operate_date.json), and generate operate_date: start from 4.20, "
            "increase by 1 day every 10 records."
        )
    )
    parser.add_argument("--input", "-i", default="records2.md", help="Input Markdown file")
    parser.add_argument(
        "--output",
        "-o",
        default=None,
        help="Output JSON file (default: <input>_surgery_with_operate_date.json)",
    )
    parser.add_argument(
        "--start",
        type=_parse_iso_date,
        default=_parse_iso_date("2025-04-20"),
        help="Operate date start. Accepts YYYY-MM-DD or M.D. Default: 2025-04-20",
    )
    parser.add_argument(
        "--group-size",
        type=int,
        default=10,
        help="How many records share the same operate_date. Default: 10",
    )
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON")
    parser.add_argument("--encoding", default="utf-8", help="Input encoding")

    args = parser.parse_args(argv)

    input_path = Path(args.input)
    if not input_path.exists():
        raise SystemExit(f"Input not found: {input_path}")

    output_path = (
        Path(args.output)
        if args.output
        else input_path.with_name(f"{input_path.stem}_surgery_with_operate_date.json")
    )

    text = input_path.read_text(encoding=args.encoding)
    payload = extract_records2_table(text)
    payload = add_operate_date(payload, start=args.start, group_size=args.group_size)

    json_kwargs: dict[str, Any] = {"ensure_ascii": False}
    if args.pretty:
        json_kwargs["indent"] = 2

    output_path.write_text(json.dumps(payload, **json_kwargs) + ("\n" if args.pretty else ""), encoding="utf-8")
    print(f"Wrote: {output_path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

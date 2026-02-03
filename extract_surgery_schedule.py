from __future__ import annotations

import argparse
import dataclasses
import datetime as dt
import json
import re
from pathlib import Path
from typing import Any, Iterable


_DATE_LINE_RE = re.compile(
    r"(?P<date>\d{4}年\d{2}月\d{2}日)\s*(?P<weekday>星期[一二三四五六日天])?\s*共(?P<count>\d+)台"
)


def _parse_cn_date(date_text: str) -> str | None:
    m = re.match(r"^(\d{4})年(\d{2})月(\d{2})日$", date_text.strip())
    if not m:
        return None
    y, mo, d = (int(m.group(1)), int(m.group(2)), int(m.group(3)))
    try:
        return dt.date(y, mo, d).isoformat()
    except ValueError:
        return None


def _is_table_line(line: str) -> bool:
    s = line.strip()
    return s.startswith("|") and s.endswith("|") and "|" in s[1:-1]


def _split_md_row(line: str) -> list[str]:
    # Assumes a standard Markdown table row: | a | b | c |
    raw = line.strip()
    if raw.startswith("|"):
        raw = raw[1:]
    if raw.endswith("|"):
        raw = raw[:-1]
    return [cell.strip() for cell in raw.split("|")]


def _is_alignment_row(cells: list[str]) -> bool:
    # Markdown alignment row is usually like: ---- or :---:
    def looks_like_align(cell: str) -> bool:
        s = cell.strip()
        if not s:
            return False
        return bool(re.fullmatch(r":?-{3,}:?", s))

    return all(looks_like_align(c) for c in cells)


def _coerce_int(text: str) -> int | None:
    t = text.strip()
    if not t:
        return None
    m = re.search(r"\d+", t)
    if not m:
        return None
    try:
        return int(m.group(0))
    except ValueError:
        return None


@dataclasses.dataclass(frozen=True)
class ScheduleMeta:
    date_text: str | None
    date_iso: str | None
    weekday: str | None
    total_count: int | None


def extract_schedule_from_markdown(text: str) -> dict[str, Any]:
    lines = text.splitlines()

    meta = ScheduleMeta(date_text=None, date_iso=None, weekday=None, total_count=None)

    # Try to find date/weekday/total line anywhere above the table.
    for line in lines[:80]:
        m = _DATE_LINE_RE.search(line)
        if m:
            date_text = m.group("date")
            meta = ScheduleMeta(
                date_text=date_text,
                date_iso=_parse_cn_date(date_text),
                weekday=m.group("weekday"),
                total_count=_coerce_int(m.group("count")),
            )
            break

    # Find the first surgery table by header keywords.
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
            "schedule": dataclasses.asdict(meta),
            "surgeries": [],
            "warnings": ["No surgery table header found (需要包含: 手术间 / 手术名称)."],
        }

    # Validate alignment row exists.
    surgeries: list[dict[str, Any]] = []
    warnings: list[str] = []

    # Next line should usually be alignment; if not, continue anyway.
    if header_line_index + 1 < len(lines) and _is_table_line(lines[header_line_index + 1]):
        align_cells = _split_md_row(lines[header_line_index + 1])
        if not _is_alignment_row(align_cells):
            warnings.append("Header alignment row not detected; parsing continues.")
        row_start = header_line_index + 2
    else:
        warnings.append("Header alignment row missing; parsing continues.")
        row_start = header_line_index + 1

    col_index = {name: idx for idx, name in enumerate(header_cells)}

    def get_cell(row: list[str], col_name: str) -> str:
        idx = col_index.get(col_name)
        if idx is None:
            return ""
        if idx < 0 or idx >= len(row):
            return ""
        return row[idx]

    def normalize_row(row_cells: list[str]) -> list[str]:
        # If cell count differs, try best-effort fix.
        if len(row_cells) == len(header_cells):
            return row_cells
        if len(row_cells) < len(header_cells):
            return row_cells + [""] * (len(header_cells) - len(row_cells))
        # Too many cells: merge extras into last column.
        fixed = row_cells[: len(header_cells) - 1]
        fixed.append("|".join(row_cells[len(header_cells) - 1 :]).strip())
        return fixed

    for j in range(row_start, len(lines)):
        line = lines[j]
        if not _is_table_line(line):
            # End of table.
            if surgeries:
                break
            continue

        row_cells = normalize_row(_split_md_row(line))
        # Skip accidental separators.
        if _is_alignment_row(row_cells):
            continue

        assistants = [
            get_cell(row_cells, "医助1"),
            get_cell(row_cells, "医助2"),
            get_cell(row_cells, "医助3"),
            get_cell(row_cells, "医助4"),
        ]
        assistants = [a for a in (x.strip() for x in assistants) if a]

        record: dict[str, Any] = {
            "room": get_cell(row_cells, "手术间").strip(),
            "department": get_cell(row_cells, "科室").strip(),
            "number": get_cell(row_cells, "号").strip(),
            "inpatient_no": get_cell(row_cells, "住院号").strip(),
            "name": get_cell(row_cells, "姓名").strip(),
            "gender": get_cell(row_cells, "性别").strip(),
            "age": _coerce_int(get_cell(row_cells, "年龄")),
            "surgery_name": get_cell(row_cells, "手术名称").strip(),
            "surgeon": get_cell(row_cells, "主刀医生").strip(),
            "assistants": assistants,
            "anesthesia_method": get_cell(row_cells, "麻醉方法").strip(),
            "anesthesia_main": get_cell(row_cells, "主麻").strip(),
            "anesthesia_assistant": get_cell(row_cells, "副麻").strip(),
            "remark": get_cell(row_cells, "备注").strip(),
            "_row": j + 1,  # 1-based line number in source
        }

        # Drop empty strings for cleanliness (keep lists/ints).
        for k in list(record.keys()):
            if k.startswith("_"):
                continue
            v = record[k]
            if isinstance(v, str) and not v:
                record[k] = None

        surgeries.append(record)

    return {
        "schedule": dataclasses.asdict(meta),
        "surgeries": surgeries,
        "warnings": warnings,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Extract surgery schedule from records.md Markdown table and output JSON."
    )
    parser.add_argument(
        "--input",
        "-i",
        default="records.md",
        help="Input Markdown file (default: records.md)",
    )
    parser.add_argument(
        "--output",
        "-o",
        default=None,
        help="Output JSON path. Use '-' to print to stdout. Default: <input>_surgery.json",
    )
    parser.add_argument(
        "--pretty",
        action="store_true",
        help="Pretty-print JSON (indent=2, ensure_ascii=False)",
    )
    parser.add_argument(
        "--encoding",
        default="utf-8",
        help="File encoding (default: utf-8)",
    )

    args = parser.parse_args(argv)

    input_path = Path(args.input)
    if not input_path.exists():
        raise SystemExit(f"Input not found: {input_path}")

    output_path: str | Path
    if args.output is None:
        output_path = input_path.with_name(f"{input_path.stem}_surgery.json")
    else:
        output_path = args.output

    text = input_path.read_text(encoding=args.encoding)
    payload = extract_schedule_from_markdown(text)
    payload.update(
        {
            "source_file": str(input_path.as_posix()),
            "extracted_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        }
    )

    json_kwargs: dict[str, Any] = {"ensure_ascii": False}
    if args.pretty:
        json_kwargs.update({"indent": 2})

    out = json.dumps(payload, **json_kwargs)

    if output_path == "-":
        print(out)
    else:
        Path(output_path).write_text(out, encoding="utf-8")
        print(f"Wrote: {output_path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

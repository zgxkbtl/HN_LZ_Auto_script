from __future__ import annotations

import argparse
import datetime as dt
import json
import random
import re
from pathlib import Path
from typing import Any


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


def _parse_iso_date(value: str) -> dt.date:
    value = value.strip()
    m = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", value)
    if not m:
        raise argparse.ArgumentTypeError(
            f"Invalid date '{value}'. Use YYYY-MM-DD (e.g. 2025-04-20)."
        )
    return dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))


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
    s = re.sub(r"<\s*br\s*/?\s*>", " ", s, flags=re.IGNORECASE)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def extract_records_md_table(text: str) -> dict[str, Any]:
    lines = text.splitlines()

    schedule = {
        "date_text": None,
        "date_iso": None,
        "weekday": None,
        "total_count": None,
    }

    for line in lines[:200]:
        m = _DATE_LINE_RE.search(line)
        if not m:
            continue
        date_text = m.group("date")
        schedule = {
            "date_text": date_text,
            "date_iso": _parse_cn_date(date_text),
            "weekday": m.group("weekday"),
            "total_count": _coerce_int(m.group("count")),
        }
        break

    def _extract_from_table(header_line_index: int, header_cells: list[str]) -> tuple[list[dict[str, Any]], int]:
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

        surgeries_local: list[dict[str, Any]] = []
        j = row_start
        while j < len(lines):
            line = lines[j]
            if not _is_table_line(line):
                break

            row_cells = normalize_row(_split_md_row(line))
            if _is_alignment_row(row_cells):
                j += 1
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

            for k, v in list(record.items()):
                if k.startswith("_"):
                    continue
                if isinstance(v, str) and not v:
                    record[k] = None

            surgeries_local.append(record)
            j += 1

        return surgeries_local, j

    surgeries: list[dict[str, Any]] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        if not _is_table_line(line):
            i += 1
            continue

        cells = _split_md_row(line)
        if "手术间" not in cells or "手术名称" not in cells:
            i += 1
            continue

        extracted, next_index = _extract_from_table(i, cells)
        surgeries.extend(extracted)
        i = max(next_index, i + 1)

    # Keep schedule.total_count consistent with extracted content.
    schedule["total_count"] = len(surgeries)
    return {"schedule": schedule, "surgeries": surgeries}


def add_random_operate_date(
    payload: dict[str, Any], *, start: dt.date, end: dt.date, seed: int | None
) -> dict[str, Any]:
    if end < start:
        raise ValueError("operate_end must be >= operate_start")

    surgeries = payload.get("surgeries")
    if not isinstance(surgeries, list):
        raise ValueError("payload must contain a top-level 'surgeries' list")

    rng = random.Random(seed)
    day_span = (end - start).days

    for item in surgeries:
        if not isinstance(item, dict):
            continue
        offset = rng.randint(0, day_span)
        item["operate_date"] = (start + dt.timedelta(days=offset)).isoformat()

    return payload


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Extract records.md Markdown surgery table into JSON (schema aligned with "
            "records_surgery_with_operate_date.json), and assign random operate_date in a range."
        )
    )
    parser.add_argument("--input", "-i", default="records.md", help="Input Markdown file")
    parser.add_argument(
        "--output",
        "-o",
        default=None,
        help="Output JSON path (default: <input>_surgery_with_operate_date.json)",
    )
    parser.add_argument(
        "--operate-start",
        type=_parse_iso_date,
        default=_parse_iso_date("2025-04-01"),
        help="Operate date start (YYYY-MM-DD). Default: 2025-04-01",
    )
    parser.add_argument(
        "--operate-end",
        type=_parse_iso_date,
        default=_parse_iso_date("2025-08-31"),
        help="Operate date end (YYYY-MM-DD). Default: 2025-08-31",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=None,
        help="Random seed for reproducible operate_date assignment (optional)",
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
    payload = extract_records_md_table(text)
    payload = add_random_operate_date(
        payload, start=args.operate_start, end=args.operate_end, seed=args.seed
    )

    json_kwargs: dict[str, Any] = {"ensure_ascii": False}
    if args.pretty:
        json_kwargs["indent"] = 2

    output_path.write_text(
        json.dumps(payload, **json_kwargs) + ("\n" if args.pretty else ""),
        encoding="utf-8",
    )
    print(f"Wrote: {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

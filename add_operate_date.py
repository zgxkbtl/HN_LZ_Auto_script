import argparse
import json
from datetime import date, timedelta
from pathlib import Path
from typing import Any


def _parse_iso_date(value: str) -> date:
    try:
        year, month, day = value.split("-")
        return date(int(year), int(month), int(day))
    except Exception as exc:  # noqa: BLE001
        raise argparse.ArgumentTypeError(f"Invalid date '{value}'. Expected YYYY-MM-DD.") from exc


def add_operate_dates(
    data: dict[str, Any],
    *,
    start: date,
    group_size: int,
    end: date | None,
    field_name: str,
    overwrite_existing: bool,
) -> tuple[int, int, bool]:
    surgeries = data.get("surgeries")
    if not isinstance(surgeries, list):
        raise ValueError("Input JSON must contain a top-level 'surgeries' array.")

    total = len(surgeries)
    updated = 0
    capped = False

    for i, item in enumerate(surgeries):
        if not isinstance(item, dict):
            continue

        if (not overwrite_existing) and (field_name in item) and item[field_name]:
            continue

        day_offset = i // group_size
        operate_dt = start + timedelta(days=day_offset)
        if end is not None and operate_dt > end:
            operate_dt = end
            capped = True

        item[field_name] = operate_dt.isoformat()
        updated += 1

    return total, updated, capped


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Add 'operate_date' to each element in surgeries: start from 2025-04-01, "
            "increase by 1 day every N items." 
        )
    )
    parser.add_argument("--input", required=True, help="Input JSON file path")
    parser.add_argument(
        "--output",
        help=(
            "Output JSON file path (default: <input>_with_operate_date.json). "
            "If --in-place is set, this is ignored."
        ),
    )
    parser.add_argument(
        "--in-place",
        action="store_true",
        help="Overwrite the input file in place.",
    )
    parser.add_argument(
        "--start",
        type=_parse_iso_date,
        default=_parse_iso_date("2025-04-01"),
        help="Start date (YYYY-MM-DD). Default: 2025-04-01",
    )
    parser.add_argument(
        "--end",
        type=_parse_iso_date,
        default=_parse_iso_date("2025-08-31"),
        help="End date cap (YYYY-MM-DD). Default: 2025-08-31",
    )
    parser.add_argument(
        "--no-end-cap",
        action="store_true",
        help="Do not cap at end date; dates can extend beyond --end.",
    )
    parser.add_argument(
        "--group-size",
        type=int,
        default=10,
        help="How many items share the same date. Default: 10",
    )
    parser.add_argument(
        "--field-name",
        default="operate_date",
        help="Field name to add. Default: operate_date",
    )
    parser.add_argument(
        "--overwrite-existing",
        action="store_true",
        help="Overwrite existing operate_date values if present.",
    )
    parser.add_argument(
        "--pretty",
        action="store_true",
        help="Pretty-print output JSON.",
    )

    args = parser.parse_args()

    if args.group_size <= 0:
        raise SystemExit("--group-size must be > 0")

    input_path = Path(args.input)
    if not input_path.exists():
        raise SystemExit(f"Input file not found: {input_path}")

    if args.in_place:
        output_path = input_path
    else:
        output_path = Path(args.output) if args.output else input_path.with_name(
            f"{input_path.stem}_with_operate_date{input_path.suffix}"
        )

    with input_path.open("r", encoding="utf-8") as f:
        data = json.load(f)

    if not isinstance(data, dict):
        raise SystemExit("Input JSON must be a JSON object with a 'surgeries' key.")

    end_cap = None if args.no_end_cap else args.end

    total, updated, capped = add_operate_dates(
        data,
        start=args.start,
        group_size=args.group_size,
        end=end_cap,
        field_name=args.field_name,
        overwrite_existing=args.overwrite_existing,
    )

    indent = 2 if args.pretty else None
    with output_path.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=indent)
        if args.pretty:
            f.write("\n")

    msg = f"Wrote {output_path} | surgeries: {total}, updated: {updated}"
    if capped:
        msg += f" (capped at {args.end.isoformat()})"
    print(msg)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

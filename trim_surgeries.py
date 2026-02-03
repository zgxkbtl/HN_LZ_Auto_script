import argparse
import json
from pathlib import Path
from typing import Any


def trim_surgeries(
    data: dict[str, Any], *, drop_first: int, update_total_count: bool
) -> tuple[int, int]:
    surgeries = data.get("surgeries")
    if not isinstance(surgeries, list):
        raise ValueError("Input JSON must contain a top-level 'surgeries' array.")

    original = len(surgeries)
    if drop_first < 0:
        raise ValueError("drop_first must be >= 0")
    if drop_first > original:
        raise ValueError(f"Not enough surgeries to drop: {original} < {drop_first}")

    data["surgeries"] = surgeries[drop_first:]

    if update_total_count:
        schedule = data.get("schedule")
        if isinstance(schedule, dict) and isinstance(schedule.get("total_count"), int):
            schedule["total_count"] = len(data["surgeries"])

    return original, len(data["surgeries"])


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Drop the first N elements from top-level surgeries array."
    )
    parser.add_argument("--input", required=True, help="Input JSON file path")
    parser.add_argument(
        "--output",
        help=(
            "Output JSON file path (default: <input>_trimmed.json). "
            "Ignored when --in-place is set."
        ),
    )
    parser.add_argument(
        "--in-place", action="store_true", help="Overwrite the input file."
    )
    parser.add_argument(
        "--drop-first",
        type=int,
        default=50,
        help="How many items to drop from the start. Default: 50",
    )
    parser.add_argument(
        "--update-total-count",
        action="store_true",
        help="If schedule.total_count exists and is int, update it to the new length.",
    )
    parser.add_argument(
        "--pretty", action="store_true", help="Pretty-print output JSON."
    )

    args = parser.parse_args()

    input_path = Path(args.input)
    if not input_path.exists():
        raise SystemExit(f"Input file not found: {input_path}")

    output_path = (
        input_path
        if args.in_place
        else (Path(args.output) if args.output else input_path.with_name(f"{input_path.stem}_trimmed{input_path.suffix}"))
    )

    data = json.loads(input_path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise SystemExit("Input JSON must be a JSON object with a 'surgeries' key.")

    original, remaining = trim_surgeries(
        data, drop_first=args.drop_first, update_total_count=args.update_total_count
    )

    indent = 2 if args.pretty else None
    output_path.write_text(
        json.dumps(data, ensure_ascii=False, indent=indent) + ("\n" if args.pretty else ""),
        encoding="utf-8",
    )

    print(
        f"Wrote {output_path} | dropped {args.drop_first} of {original} | remaining {remaining}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

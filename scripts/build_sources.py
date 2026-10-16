#!/usr/bin/env python3
"""Build web/data-sources.json, the sources the site's "How sure is this data?" card shows.

Two inputs, both committed:

  data/sources/web_sources.csv   values read off fan sites (wikily.gg), one per row:
                                 kind, facility, key, column, value, source, url, checked_on
                                 (kinds recipe | unlock | cap | upgrade_cost | rv_cost; see the file's header).
                                 Fan data: a match is corroboration, not VERIFIED.
  data/overrides/values.csv      the active rows (not comments) of my own in-game checks:
                                 file, match, column, value, upstream_value, verified_on, note

Output: web/data-sources.json (committed, because GitHub Pages serves only web/):

  {"format": "aniimax-data-sources", "version": 1, "generatedFrom": [...],
   "web": [{kind, facility, key, column, value, source, url, checked_on}],
   "owner": [{file, match, column, value, verified_on, note}]}

A malformed row is skipped with a warning on stderr. Keys are sorted and there is no time stamp, so the
same inputs always give the same file and `--check` can compare it.

Usage (from the repository root):
  python scripts/build_sources.py            write web/data-sources.json
  python scripts/build_sources.py --check    exit 1 if the committed file is not what the inputs give

Standard library only.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

FORMAT = "aniimax-data-sources"
WEB_SOURCES = "data/sources/web_sources.csv"
VALUES = "data/overrides/values.csv"
OUTPUT = "web/data-sources.json"
WEB_COLUMNS = ["kind", "facility", "key", "column", "value", "source", "url", "checked_on"]
VALUES_COLUMNS = ["file", "match", "column", "value", "upstream_value", "verified_on", "note"]
KINDS = {"recipe", "unlock", "cap", "upgrade_cost", "rv_cost"}
LEVEL_KINDS = KINDS - {"recipe"}  # their key is a level
DAY = re.compile(r"\d{4}-\d{2}-\d{2}")
INTEGER = re.compile(r"-?\d+")


def stderr_warn(message: str) -> None:
    print(f"warning: {message}", file=sys.stderr)


def number(text: str):
    """'2400' -> 2400, '1.5' -> 1.5; anything else stays text (a fan page may give a name, e.g. raw_materials)."""
    if INTEGER.fullmatch(text):
        return int(text)
    try:
        value = float(text)
    except ValueError:
        return text
    return value if value == value and value not in (float("inf"), float("-inf")) else text


def data_lines(path: Path) -> list[tuple[int, str]]:
    """(line number, line) for every line that is not blank and not a # comment."""
    lines = path.read_text(encoding="utf-8").splitlines() if path.is_file() else []
    return [(n, line) for n, line in enumerate(lines, start=1) if line.strip() and not line.lstrip().startswith("#")]


def split(line: str) -> list[str]:
    return [cell.strip() for cell in line.split(",")]


def read_web(path: Path, warn) -> list[dict]:
    lines = data_lines(path)
    if not lines:
        return []
    (n, head), rows = lines[0], []
    if split(head) != WEB_COLUMNS:
        warn(f"{path.name} line {n}: the header must be {', '.join(WEB_COLUMNS)}; nothing read")
        return []
    for n, line in lines[1:]:
        cells = split(line)
        if len(cells) != len(WEB_COLUMNS):
            warn(f"{path.name} line {n}: {len(cells)} cells, not {len(WEB_COLUMNS)}; skipped")
            continue
        row = dict(zip(WEB_COLUMNS, cells))
        if row["kind"] == "rv_cost" and not row["facility"]:
            row["facility"] = "RV"
        problem = None
        if row["kind"] not in KINDS:
            problem = f"unknown kind '{row['kind']}'"
        elif not all(row[k] for k in ("facility", "key", "column", "value", "source")):
            problem = "facility, key, column, value and source are all needed"
        elif row["kind"] in LEVEL_KINDS and not row["key"].isdigit():
            problem = f"a {row['kind']} key is a level, not '{row['key']}'"
        elif not DAY.fullmatch(row["checked_on"]):
            problem = f"checked_on '{row['checked_on']}' is not YYYY-MM-DD"
        elif row["url"] and not row["url"].startswith("https://"):
            problem = "the url must start with https://"
        if problem:
            warn(f"{path.name} line {n}: {problem}; skipped")
            continue
        row["value"] = number(row["value"])
        rows.append(row)
    return rows


def read_owner(path: Path, warn) -> list[dict]:
    """The active rows of values.csv (read like scripts/apply_overrides.py: a comma in the note is kept)."""
    lines = data_lines(path)
    if not lines:
        return []
    (n, head), rows = lines[0], []
    if split(head) != VALUES_COLUMNS:
        warn(f"{path.name} line {n}: the header must be {', '.join(VALUES_COLUMNS)}; nothing read")
        return []
    for n, line in lines[1:]:
        cells = split(line)
        if len(cells) > len(VALUES_COLUMNS):
            cells = cells[: len(VALUES_COLUMNS) - 1] + [", ".join(cells[len(VALUES_COLUMNS) - 1:])]
        cells += [""] * (len(VALUES_COLUMNS) - len(cells))
        row = dict(zip(VALUES_COLUMNS, cells))
        if not all(row[k] for k in ("file", "match", "column", "value")):
            warn(f"{path.name} line {n}: file, match, column and value are all needed; skipped")
            continue
        value = number(row["value"])
        if isinstance(value, str):
            warn(f"{path.name} line {n}: value '{row['value']}' is not a number; skipped")
            continue
        rows.append({"file": row["file"], "match": row["match"], "column": row["column"], "value": value,
                     "verified_on": row["verified_on"], "note": row["note"]})
    return rows


def build(root: Path, warn=stderr_warn) -> dict:
    """The data-sources document for `root` (the repository folder)."""
    root = Path(root)
    return {"format": FORMAT, "version": 1, "generatedFrom": [WEB_SOURCES, VALUES],
            "web": read_web(root / WEB_SOURCES, warn), "owner": read_owner(root / VALUES, warn)}


def render(doc: dict) -> str:
    return json.dumps(doc, indent=2, sort_keys=True) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--check", action="store_true", help="exit 1 if the committed web/data-sources.json differs")
    args = parser.parse_args(argv)
    doc = build(args.root)
    text, out = render(doc), args.root / OUTPUT
    if args.check:
        current = out.read_text(encoding="utf-8") if out.is_file() else ""
        if current != text:
            print(f"{OUTPUT} is out of date: run python scripts/build_sources.py", file=sys.stderr)
            return 1
        print(f"{OUTPUT} is up to date ({len(doc['web'])} web rows, {len(doc['owner'])} owner rows).")
        return 0
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    print(f"Wrote {OUTPUT}: {len(doc['web'])} web rows, {len(doc['owner'])} owner rows.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

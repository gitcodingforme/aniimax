#!/usr/bin/env python3
"""Apply my in-game verified overrides on top of upstream game data.

Upstream files are never hand-edited in this fork, so merging ae-bii/aniimax stays conflict-free.
Instead this script runs right before a build or a test run and rewrites the overridden cells:

  data/overrides/values.csv       -> cells in data/*.csv (rewritten in place, not committed)
  data/overrides/structure.json   -> copied to web/structure-overrides.json (gitignored), which
                                     the page reads at load for RV counts, unlocks, level-up costs
                                     and module caps

Usage (from the repository root):
  python scripts/apply_overrides.py                      apply; prints what changed
  python scripts/apply_overrides.py --check              validate only, write nothing, exit 1 on a bad row
  python scripts/apply_overrides.py --record             fill in empty upstream_value cells from the
                                                         current files (do this when adding an override)
  python scripts/apply_overrides.py --report FILE.md     also write the conflict table as Markdown
  python scripts/apply_overrides.py --restore            undo: `git restore data` (the CI jobs do this)

values.csv columns: file, match, column, value, upstream_value, verified_on, note
  file           a file in data/, e.g. farmland.csv
  match          the row: either the first-column value (e.g. rose) or `col=value;col=value`
                 for files whose rows need more than one column (e.g. name=wheat;step=Sowing)
  column         the column to change, e.g. production_time
  value          my verified value
  upstream_value the value upstream had when I verified mine (filled by --record). When upstream
                 later changes that cell, the sync check reports a conflict.
  verified_on    date I checked it in game
  note           free text

Lines starting with `#` are comments. Standard library only.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

VALUES_NAME = "values.csv"
STRUCTURE_NAME = "structure.json"
STRUCTURE_OUT = Path("web") / "structure-overrides.json"
OVERRIDE_COLUMNS = ["file", "match", "column", "value", "upstream_value", "verified_on", "note"]


class OverrideError(Exception):
    """A row in values.csv points at something that does not exist, or is malformed."""


@dataclass
class Override:
    line_no: int
    file: str
    match: str
    column: str
    value: str
    upstream_value: str
    verified_on: str
    note: str

    def matchers(self) -> list[tuple[str, str]]:
        if "=" not in self.match:
            return [("", self.match)]  # first column
        pairs = []
        for part in self.match.split(";"):
            key, _, val = part.partition("=")
            if not key.strip() or not val.strip():
                raise OverrideError(f"line {self.line_no}: bad match '{self.match}' (use col=value;col=value)")
            pairs.append((key.strip(), val.strip()))
        return pairs

    def where(self) -> str:
        return f"{self.file} row '{self.match}' column '{self.column}'"


@dataclass
class Conflict:
    override: Override
    upstream_now: str


@dataclass
class Result:
    applied: list[str] = field(default_factory=list)
    unchanged: list[str] = field(default_factory=list)
    conflicts: list[Conflict] = field(default_factory=list)
    recorded: list[str] = field(default_factory=list)
    structure: str = ""


# --- values.csv ----------------------------------------------------------------------------------

def split_row(line: str) -> list[str]:
    return [cell.strip() for cell in line.rstrip("\r\n").split(",")]


def read_overrides(path: Path) -> list[Override]:
    if not path.exists():
        return []
    overrides = []
    lines = path.read_text(encoding="utf-8").splitlines()
    if not lines:
        return []
    header = split_row(lines[0])
    if header != OVERRIDE_COLUMNS:
        raise OverrideError(f"{path.name} header must be: {', '.join(OVERRIDE_COLUMNS)}")
    for line_no, line in enumerate(lines[1:], start=2):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        cells = split_row(line)
        if len(cells) < 4:
            raise OverrideError(f"{path.name} line {line_no}: needs at least file, match, column, value")
        cells += [""] * (len(OVERRIDE_COLUMNS) - len(cells))
        if len(cells) > len(OVERRIDE_COLUMNS):
            # Commas inside the note are allowed; glue the tail back together.
            cells = cells[: len(OVERRIDE_COLUMNS) - 1] + [", ".join(cells[len(OVERRIDE_COLUMNS) - 1:])]
        o = Override(line_no, *cells)
        if not o.file or not o.match or not o.column or o.value == "":
            raise OverrideError(f"{path.name} line {line_no}: file, match, column and value are all required")
        try:
            float(o.value)
        except ValueError:
            raise OverrideError(f"{path.name} line {line_no}: value '{o.value}' is not a number") from None
        overrides.append(o)
    return overrides


# --- target CSV files ----------------------------------------------------------------------------

@dataclass
class DataFile:
    path: Path
    lines: list[str]
    newline: str
    header: list[str]

    @classmethod
    def load(cls, path: Path) -> "DataFile":
        text = path.read_bytes().decode("utf-8")  # bytes: keep the file's own line endings
        newline = "\r\n" if "\r\n" in text else "\n"
        lines = text.split(newline)
        return cls(path, lines, newline, split_row(lines[0]))

    def column_index(self, column: str, o: Override) -> int:
        if column not in self.header:
            raise OverrideError(f"line {o.line_no}: {self.path.name} has no column '{column}' (has: {', '.join(self.header)})")
        return self.header.index(column)

    def find_row(self, o: Override) -> int:
        matchers = [(self.column_index(col, o) if col else 0, val) for col, val in o.matchers()]
        hits = [i for i, line in enumerate(self.lines[1:], start=1)
                if line.strip() and all(len(split_row(line)) > idx and split_row(line)[idx] == val for idx, val in matchers)]
        if len(hits) != 1:
            raise OverrideError(f"line {o.line_no}: {self.path.name} has {len(hits)} rows matching '{o.match}' (need exactly 1)")
        return hits[0]

    def get(self, row: int, col: int) -> str:
        cells = split_row(self.lines[row])
        return cells[col] if col < len(cells) else ""

    def set(self, row: int, col: int, value: str) -> None:
        cells = self.lines[row].split(",")
        while len(cells) <= col:
            cells.append("")
        cells[col] = value if col == 0 else f" {value}"
        self.lines[row] = ",".join(cells)

    def save(self) -> None:
        self.path.write_text(self.newline.join(self.lines), encoding="utf-8", newline="")


# --- main pass -----------------------------------------------------------------------------------

def run(root: Path, write: bool, record: bool) -> Result:
    result = Result()
    overrides_dir = root / "data" / "overrides"
    values_path = overrides_dir / VALUES_NAME
    overrides = read_overrides(values_path)
    files: dict[str, DataFile] = {}
    recorded_lines: dict[int, str] = {}

    for o in overrides:
        target = root / "data" / o.file
        if "/" in o.file or "\\" in o.file or not target.is_file():
            raise OverrideError(f"line {o.line_no}: data/{o.file} does not exist")
        df = files.setdefault(o.file, DataFile.load(target))
        row = df.find_row(o)
        col = df.column_index(o.column, o)
        current = df.get(row, col)
        if o.upstream_value and current != o.upstream_value and current != o.value:
            result.conflicts.append(Conflict(o, current))
        if record and not o.upstream_value:
            o.upstream_value = current
            recorded_lines[o.line_no] = current
            result.recorded.append(f"{o.where()}: upstream value is {current or '(empty)'}")
        if current == o.value:
            result.unchanged.append(o.where())
        else:
            result.applied.append(f"{o.where()}: {current or '(empty)'} -> {o.value}")
            df.set(row, col, o.value)

    if write:
        for df in files.values():
            df.save()
    if write and recorded_lines:
        text = values_path.read_bytes().decode("utf-8")
        newline = "\r\n" if "\r\n" in text else "\n"
        lines = text.split(newline)
        for line_no, value in recorded_lines.items():
            cells = lines[line_no - 1].split(",")
            while len(cells) < len(OVERRIDE_COLUMNS):
                cells.append("")
            cells[4] = f" {value}"
            lines[line_no - 1] = ",".join(cells)
        values_path.write_text(newline.join(lines), encoding="utf-8", newline="")

    structure = overrides_dir / STRUCTURE_NAME
    out = root / STRUCTURE_OUT
    if structure.exists():
        try:
            data = json.loads(structure.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            raise OverrideError(f"{structure.name} is not valid JSON: {e}") from None
        if not isinstance(data, dict):
            raise OverrideError(f"{structure.name} must hold one JSON object")
        result.structure = f"{structure.name} -> {STRUCTURE_OUT.as_posix()}"
        if write:
            out.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(structure, out)
    elif write and out.exists():
        out.unlink()
        result.structure = f"removed stale {STRUCTURE_OUT.as_posix()}"
    return result


def conflict_report(result: Result) -> str:
    lines = ["# Override conflicts", ""]
    if not result.conflicts:
        lines.append("No conflicts: upstream has not changed any value I override.")
    else:
        lines += [
            "Upstream changed a value I verified myself. My override still wins until I either delete its",
            "line in `data/overrides/values.csv` (accept upstream) or re-check it in game and update",
            "`verified_on` and `upstream_value` (keep mine).",
            "",
            "| File | Row | Column | Mine (verified on) | Upstream before | Upstream now |",
            "|---|---|---|---|---|---|",
        ]
        for c in result.conflicts:
            o = c.override
            lines.append(f"| {o.file} | {o.match} | {o.column} | {o.value} ({o.verified_on or '?'}) | {o.upstream_value} | {c.upstream_now or '(empty)'} |")
    lines += ["", f"Overrides applied: {len(result.applied)}; already matching upstream: {len(result.unchanged)}."]
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent, help="repository root")
    parser.add_argument("--check", action="store_true", help="validate only; write nothing")
    parser.add_argument("--record", action="store_true", help="fill empty upstream_value cells from the current files")
    parser.add_argument("--report", type=Path, help="write the conflict table to this Markdown file")
    parser.add_argument("--restore", action="store_true", help="undo applied overrides with `git restore data`")
    args = parser.parse_args(argv)

    if args.restore:
        subprocess.run(["git", "-C", str(args.root), "restore", "data"], check=True)
        print("Restored data/ from git; overrides are no longer applied.")
        return 0

    try:
        result = run(args.root, write=not args.check, record=args.record)
    except OverrideError as e:
        print(f"Override error: {e}", file=sys.stderr)
        return 1

    verb = "Would apply" if args.check else "Applied"
    for line in result.applied:
        print(f"{verb}: {line}")
    for line in result.recorded:
        print(f"Recorded: {line}")
    if result.structure:
        print(f"Structure: {result.structure}")
    print(f"{len(result.applied)} applied, {len(result.unchanged)} already matching, {len(result.conflicts)} conflicts.")
    if result.conflicts:
        for c in result.conflicts:
            o = c.override
            print(f"CONFLICT: {o.where()}: mine {o.value}, upstream was {o.upstream_value}, now {c.upstream_now or '(empty)'}")
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(conflict_report(result), encoding="utf-8")
        print(f"Report written to {args.report}")
    if not args.check and result.applied:
        print("Reminder: data/ now differs from upstream. Build, then `python scripts/apply_overrides.py --restore` before committing.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

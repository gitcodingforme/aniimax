#!/usr/bin/env python3
"""Describe a change to data/*.csv in plain words, grouped by facility, instead of as a raw CSV diff.

When the game patches, upstream edits the CSVs in data/. This compares two versions of that folder and says what
changed, one line per changed value, for example:

  - **Farmland**: Wheat grow time 240 s (4m 0s) → 210 s (3m 30s), 12% faster.

Compare two folders of CSVs, or two git refs (reads the top-level data/*.csv of each ref with `git ls-tree` and
`git show`; the working tree is never touched):

  python scripts/describe_data_diff.py --old OLD_DIR --new NEW_DIR [--max-lines 150] [--format md|text]
  python scripts/describe_data_diff.py --git OLD_REF NEW_REF [--repo PATH] [--max-lines 150] [--format md|text]

A row is identified by its name (by name + facility, or name + facility + step, in the files that repeat names);
a removed row and an added row that match in every other cell are reported as a rename. A column that appears or
disappears is reported once per file. pair_coverage.csv (generated) is only reported as regenerated. Output goes
to stdout; differences are not errors (exit 0). Exit 2 means bad arguments or unreadable input (one line on stderr).
Standard library only.
"""
from __future__ import annotations

import argparse
import csv
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

PAIR_FILE = "pair_coverage.csv"
UNVERIFIED_FILE = "unverified.csv"
KEYS = {"aniimo_requirements.csv": ("name", "facility"), "harvest_moon_festival.csv": ("name", "facility"),
        UNVERIFIED_FILE: ("name", "facility"), "grower_steps.csv": ("name", "facility", "step")}
NOUNS = {"aniimo_requirements.csv": "Aniimo requirement", "grower_steps.csv": "grower step"}  # anything else is a "recipe"
LABELS = {"production_time": "grow time", "ability": "Aniimo ability", "min_level": "Aniimo min level",
          "points": "festival points", "sell_currency": "sell currency"}
COUNT_WORDS = {"yield": "yield", "byproduct_yield": "by-product yield", "required_amount": "amount needed"}
SUMMARY = [("value", "value", "values"), ("new_recipe", "new recipe", "new recipes"), ("new_row", "new row", "new rows"),
           ("removed", "removed", "removed"), ("renamed", "renamed", "renamed"), ("new_column", "new column", "new columns"),
           ("dropped_column", "column removed", "columns removed"), ("unverified", "marked unverified", "marked unverified"),
           ("confirmed", "confirmed", "confirmed"), ("file_added", "file added", "files added"),
           ("file_removed", "file removed", "files removed"), ("layout", "layout table regenerated", "layout table regenerated")]
Change = tuple[str, str, str]  # (file name, kind, sentence)


class UsageError(Exception):
    """Bad arguments or unreadable input: main prints the message on stderr and exits 2."""


def read_table(text: str) -> tuple[list[str], list[dict]]:
    """(header, rows as dicts) of a data CSV. Blank and # comment lines are skipped and a space after each comma is
    ignored, as scripts/verify_data.py read_rows does. An empty file gives ([], [])."""
    lines = (line for line in text.lstrip("﻿").splitlines(keepends=True) if line.strip() and not line.lstrip().startswith("#"))
    reader = csv.DictReader(lines, skipinitialspace=True)
    header = [(h or "").strip() for h in (reader.fieldnames or [])]
    return header, [{k.strip(): (v if isinstance(v, str) else "").strip() for k, v in row.items() if k is not None} for row in reader]


def index_rows(rows: list[dict], key_cols: tuple[str, ...]) -> dict[tuple, dict]:
    """{key: row}. A key used by several rows becomes name#1, name#2, ... instead of overwriting."""
    keys = [tuple(r.get(c, "") for c in key_cols) for r in rows]
    total, seen, out = Counter(keys), Counter(), {}
    for key, row in zip(keys, rows):
        if total[key] > 1:
            seen[key] += 1
            out[(f"{key[0]}#{seen[key]}",) + key[1:]] = row
        else:
            out[key] = row
    return out


def align_single_keys(rows: dict[tuple, dict], other: dict[tuple, dict]) -> dict[tuple, dict]:
    """rows, with a key that is single here but repeated in `other` renamed to name#1, so the first of the repeats
    is compared with it (a name that becomes duplicated, or stops being so, is not reported as a rename)."""
    out = {}
    for key, row in rows.items():
        first = (f"{key[0]}#1",) + key[1:]
        out[first if key not in other and first in other and first not in rows else key] = row
    return out


def pretty(name: str) -> str:
    return " ".join(w.capitalize() for w in name.replace("_", " ").split())


def file_title(file: str) -> str:
    return pretty(Path(file).stem)


def label(key: tuple) -> str:
    """'Wheat' for ('wheat',), 'Wheat#2' for a repeated name, 'Soy Sauce (Blazing Stove)' when the key has more parts."""
    name, dup = re.fullmatch(r"(.*?)(#\d+)?", key[0], re.S).groups()  # re.S: a quoted name may hold a newline
    return pretty(name) + (dup or "") + (f" ({', '.join(key[1:])})" if len(key) > 1 else "")


def to_num(text: str):
    for kind in (int, float):
        try:
            return kind(text)
        except ValueError:
            pass
    return None


def duration(seconds) -> str:
    """4m 0s, 3m 30s, 54s, 1h 2m (the way the game writes times)."""
    h, rest = divmod(int(round(seconds)), 3600)
    m, s = divmod(rest, 60)
    return (f"{h}h {m}m" + (f" {s}s" if s else "")) if h else f"{m}m {s}s" if m else f"{s}s"


def seconds_text(text: str) -> str:
    """'240 s (4m 0s)'; just '30 s' under a minute; the cell as written when it is not a number."""
    n = to_num(text)
    return text if n is None else f"{text} s" + (f" ({duration(n)})" if n >= 60 else "")


def percent(old, new, up: str, down: str) -> str:
    if old == 0 or old == new:
        return ""
    return f", {max(1, round(abs(new - old) / abs(old) * 100))}% {up if new > old else down}"


def blank(text: str) -> str:
    return text or "none"


def listed(text: str, words: bool = False) -> str:
    """'wheat;water' -> 'wheat, water' (and 'milled_rice' -> 'milled rice' when words)."""
    text = ", ".join(p.strip() for p in text.split(";"))
    return blank(text.replace("_", " ") if words else text)


def modules(text: str) -> list[tuple[str, str]]:
    """[(module name, level)] from 'resource_detector:4' (several joined by ';'); the level is '' when the cell has none."""
    return [(n.strip(), lv.strip()) for n, _, lv in (p.partition(":") for p in text.split(";")) if n.strip()]


def module_text(items: list[tuple[str, str]]) -> str:
    return ", ".join(pretty(n) + (f" Lv {lv}" if lv else "") for n, lv in items)


def module_sentence(old: str, new: str) -> str:
    o, n = modules(old), modules(new)
    if not n:
        return f"no longer needs a module (was {module_text(o)})"
    if not o:
        return f"now needs {module_text(n)}"
    if len(o) == len(n) == 1 and o[0][0] == n[0][0] and o[0][1] and n[0][1]:
        return f"needs {pretty(n[0][0])} Lv {o[0][1]} → Lv {n[0][1]}"
    return f"needs {module_text(n)} (was {module_text(o)})"


def sale_sentences(old: dict, new: dict, has_currency: bool) -> list[str]:
    """What a change of sell_value and/or sell_currency says. A file without a sell_currency column sells for coins."""
    oc, nc = (old.get("sell_currency") or "coins", new.get("sell_currency") or "coins") if has_currency else ("coins", "coins")
    ov, nv = old["sell_value"], new["sell_value"]
    if (oc, ov) == (nc, nv):
        return []
    if nc == "none":
        return ["now not sold"] if oc != "none" else []
    unit = lambda c: c.replace("_", " ")  # noqa: E731
    if oc == "none":
        return [f"now sells for {nv} {unit(nc)}"]
    return [f"sells for {ov} {unit(oc)} → {nv} {unit(nc)}" if oc != nc else f"sells for {ov} → {nv} {unit(nc)}"]


def change_sentence(col: str, old: str, new: str) -> str:
    a, b = to_num(old), to_num(new)
    both = a is not None and b is not None
    if col == "production_time" and both:
        return f"grow time {seconds_text(old)} → {seconds_text(new)}{percent(a, b, 'slower', 'faster')}"
    if col == "workload" and both:
        return f"workload {old} → {new}{percent(a, b, 'more', 'less')}"
    if col in ("cost", "seed_cost"):
        return f"seed cost {blank(old)} → {blank(new)} coins per seed"
    if col in COUNT_WORDS:
        return f"{COUNT_WORDS[col]} {listed(old)} → {listed(new)} per batch"
    if col == "facility_level":
        return f"needs facility {'Lv ' + old if old else 'no level'} → {'Lv ' + new if new else 'no level'}"
    if col == "module_requirement":
        return module_sentence(old, new)
    if col == "raw_materials":
        return f"ingredients {listed(old, True)} → {listed(new, True)}"
    return f"{LABELS.get(col, col.replace('_', ' '))} {blank(old)} → {blank(new)}"


def row_sentences(old: dict, new: dict, cols: list[str]) -> list[str]:
    """One sentence per changed column of a row (sell_value and sell_currency are told together)."""
    joint = "sell_value" in cols
    out = sale_sentences(old, new, "sell_currency" in cols) if joint else []
    for col in cols:
        if old.get(col, "") != new.get(col, "") and not (joint and col in ("sell_value", "sell_currency")):
            out.append(change_sentence(col, old.get(col, ""), new.get(col, "")))
    return out


def new_row_details(file: str, row: dict, key_cols: tuple[str, ...]) -> str:
    parts = []
    if row.get("production_time"):
        n = to_num(row["production_time"])
        parts.append(f"grow time {duration(n) if n is not None else row['production_time']}")
    if row.get("workload"):
        parts.append(f"workload {row['workload']}")
    currency = row.get("sell_currency") or "coins"
    if row.get("sell_value") and currency != "none":
        parts.append(f"sells for {row['sell_value']} {currency.replace('_', ' ')}")
    if row.get("facility_level"):
        parts.append(f"{row.get('facility') or file_title(file)} Lv {row['facility_level']}")
    if modules(row.get("module_requirement", "")):
        parts.append("needs " + module_text(modules(row["module_requirement"])))
    if not parts:  # a file with none of the usual columns: show whatever the row holds
        parts = [f"{LABELS.get(c, c.replace('_', ' '))} {v}" for c, v in row.items() if v and c not in key_cols]
    return ", ".join(parts)


def find_renames(gone: dict, fresh: dict, others: list[str]) -> list[tuple[tuple, tuple]]:
    """(old key, new key) for a removed and an added row that match in every column but the name. Only when the match
    is unambiguous: exactly one removed and one added row share those cells."""
    sig = lambda row: tuple(row.get(c, "") for c in others)  # noqa: E731
    by_old, by_new = {}, {}
    for key, row in gone.items():
        by_old.setdefault(sig(row), []).append(key)
    for key, row in fresh.items():
        by_new.setdefault(sig(row), []).append(key)
    return [(keys[0], by_new[s][0]) for s, keys in by_old.items() if len(keys) == 1 and len(by_new.get(s, [])) == 1]


def diff_file(file: str, old_text: str, new_text: str) -> list[tuple[str, str]]:
    """The changes in one CSV as (kind, sentence) pairs, in the order they are reported."""
    old_head, old_rows = read_table(old_text)
    new_head, new_rows = read_table(new_text)
    if file == PAIR_FILE:
        same = (old_head, old_rows) == (new_head, new_rows)
        return [] if same else [("layout", f"layout table regenerated ({len(old_rows)} rows → {len(new_rows)} rows)")]
    old_head, new_head = old_head or new_head, new_head or old_head  # an empty file has no header of its own: compare rows only
    out = [("new_column", f"new column {c}, filled for {sum(1 for r in new_rows if r.get(c))} of {len(new_rows)} rows") for c in new_head if c not in old_head]
    out += [("dropped_column", f"column {c} removed (it was filled for {sum(1 for r in old_rows if r.get(c))} of {len(old_rows)} rows)") for c in old_head if c not in new_head]
    common = [c for c in new_head if c in old_head]
    key_cols = tuple(c for c in KEYS.get(file, ("name",)) if c in common)
    if not key_cols:
        return out
    old_by, new_by = index_rows(old_rows, key_cols), index_rows(new_rows, key_cols)
    old_by, new_by = align_single_keys(old_by, new_by), align_single_keys(new_by, old_by)
    gone = {k: r for k, r in old_by.items() if k not in new_by}
    fresh = {k: r for k, r in new_by.items() if k not in old_by}
    for before, after in find_renames(gone, fresh, [c for c in common if c != key_cols[0]]):
        out.append(("renamed", f"{label(before)} renamed to {label(after)}"))
        del gone[before], fresh[after]
    cells = [c for c in common if c not in key_cols]
    for key, row in new_by.items():
        if key in old_by:
            out += [("value", f"{label(key)} {s}") for s in row_sentences(old_by[key], row, cells)]
    noun = NOUNS.get(file, "recipe")
    for key, row in fresh.items():
        if file == UNVERIFIED_FILE:
            out.append(("unverified", f"{label(key)} now marked unverified"))
        else:
            details = new_row_details(file, row, key_cols)
            tail = (f": {details}" if len(key) > 1 else f" ({details})") if details else ""  # a key like (name, facility) has its own parentheses
            out.append(("new_recipe" if noun == "recipe" else "new_row", f"new {noun} {label(key)}{tail}"))
    for key in gone:
        out.append(("confirmed", f"{label(key)} now confirmed (no longer unverified)") if file == UNVERIFIED_FILE else ("removed", f"{label(key)} removed"))
    return out


def diff_trees(old: dict[str, str], new: dict[str, str]) -> list[Change]:
    """Every change between two {file name: CSV text} folders, files in name order."""
    changes: list[Change] = []
    for file in sorted(set(old) | set(new)):
        if file in old and file in new:
            if old[file] != new[file]:
                changes += [(file, kind, text) for kind, text in diff_file(file, old[file], new[file])]
        else:
            side, text = ("added", new[file]) if file in new else ("removed", old[file])
            changes.append((file, f"file_{side}", f"facility file {file} {side} ({len(read_table(text)[1])} rows)"))
    return changes


def summarize(changes: list[Change]) -> str:
    if not changes:
        return "No data changes."
    files, kinds = len({c[0] for c in changes}), Counter(c[1] for c in changes)
    parts = [f"{kinds[k]} {one if kinds[k] == 1 else many}" for k, one, many in SUMMARY if kinds[k]]
    return f"{files} file{'s' if files != 1 else ''} changed: {', '.join(parts)}"


def render(changes: list[Change], fmt: str = "md", max_lines: int = 150) -> str:
    lines = [summarize(changes)] + ([""] if changes else [])
    for file, _, text in changes[:max_lines]:
        text = " ".join(text.split())  # a quoted cell may hold a newline: keep one change per line
        lines.append(f"- **{file_title(file)}**: {text}." if fmt == "md" else f"{file_title(file)}: {text}.")
    if len(changes) > max_lines:
        lines.append(f"... and {len(changes) - max_lines} more change{'s' if len(changes) - max_lines != 1 else ''}")
    return "\n".join(lines)


def read_dir(path: Path) -> dict[str, str]:
    """{file name: text} of the top-level *.csv files in a folder."""
    if not path.is_dir():
        raise UsageError(f"not a folder: {path}")
    out = {}
    for f in sorted(path.glob("*.csv")):
        try:
            out[f.name] = f.read_text(encoding="utf-8") if f.is_file() else ""
        except (OSError, UnicodeDecodeError) as e:
            raise UsageError(f"cannot read {f}: {e}") from None
    return out


def git(repo: Path, *args: str) -> bytes:
    try:
        done = subprocess.run(["git", "-C", str(repo), *args], capture_output=True)
    except OSError as e:
        raise UsageError(f"cannot run git: {e}") from None
    if done.returncode:
        why = done.stderr.decode("utf-8", "replace").strip().splitlines()
        raise UsageError(f"git {args[0]} failed: {why[0] if why else 'no message'}")
    return done.stdout


def read_git(repo: Path, ref: str) -> dict[str, str]:
    """{file name: text} of the top-level data/*.csv at a git ref (read-only: ls-tree and show)."""
    if ref.startswith("-"):
        raise UsageError(f"not a git ref: {ref}")
    out = {}
    for name in git(repo, "ls-tree", "--name-only", "-z", ref, "data/").decode("utf-8", "replace").split("\0"):
        if name.startswith("data/") and name.endswith(".csv") and "/" not in name[5:]:
            try:
                out[name[5:]] = git(repo, "show", f"{ref}:{name}").decode("utf-8")
            except UnicodeDecodeError:
                raise UsageError(f"{name} at {ref} is not UTF-8 text") from None
    return out


class OneLineParser(argparse.ArgumentParser):
    def error(self, message: str):
        self.exit(2, f"describe_data_diff: {message}\n")


def main(argv: list[str] | None = None) -> int:
    parser = OneLineParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--old", type=Path, help="folder of the old CSVs")
    parser.add_argument("--new", type=Path, help="folder of the new CSVs")
    parser.add_argument("--git", nargs=2, metavar=("OLD_REF", "NEW_REF"), help="compare data/*.csv at two git refs instead")
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parent.parent, help="repository for --git (default: this one)")
    parser.add_argument("--max-lines", type=int, default=150, help="most change lines to print, then '... and N more changes'")
    parser.add_argument("--format", choices=["md", "text"], default="md")
    args = parser.parse_args(argv)
    if args.max_lines < 1:
        parser.error("--max-lines must be at least 1")
    if args.git and (args.old or args.new):
        parser.error("use either --git OLD_REF NEW_REF or --old DIR --new DIR, not both")
    if not args.git and not (args.old and args.new):
        parser.error("give --old DIR and --new DIR, or --git OLD_REF NEW_REF")
    for stream, errors in ((sys.stdout, "strict"), (sys.stderr, "replace")):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors=errors)  # the arrows must survive a Windows pipe or file
    try:
        old, new = (read_git(args.repo, args.git[0]), read_git(args.repo, args.git[1])) if args.git else (read_dir(args.old), read_dir(args.new))
    except UsageError as e:
        print(f"describe_data_diff: {e}", file=sys.stderr)
        return 2
    print(render(diff_trees(old, new), args.format, args.max_lines))
    return 0


if __name__ == "__main__":
    sys.exit(main())

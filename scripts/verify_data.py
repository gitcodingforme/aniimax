#!/usr/bin/env python3
"""Check what the game showed (the watcher's observations) against this fork's game data.

scripts/watch_game.py notes facts it reads off a facility's panel in screenshots/observations.jsonl,
one JSON object per line:

  {"t": "...Z", "frame": "facility-....png", "facility": "Chimney Kiln", "level": 2,
   "fact": "unlock", "facility_level": 3, "rv_level": 14}        "can be upgraded to Lv.3 once the RV reaches Lv.14"
  {"t": "...Z", "frame": "...", "facility": "Chimney Kiln", "level": 2,
   "fact": "recipe", "recipe": "coarse_sifted_ore", "time": "2s"}   the recipe running in the facility's box
  {"t": "...Z", "frame": "stock-....png", "facility": "Farmland", "fact": "card", "item": "rose",
   "facility_level": 4, "time": "40m 0s", "time_seconds": 2400, "workload": null, "environment": "Cool"}
                                                                   an item's information card

This script compares them with the data and writes a short report:

  unlock   the RV level a facility level needs: `unlocks` per facility in web/facility-config.js,
           with data/overrides/structure.json (my own verified values) applied on top.
           agree = same RV level, disagree = a different one, unknown = facility or level not in the table.
  recipe   the recipe is a row of that facility's data/<facility>.csv (or of the seasonal
           data/harvest_moon_festival.csv for that facility) = agree; a known recipe of another
           facility = disagree; anything else = unknown.
  time     the number in the recipe box is not understood yet (docs/design.md section 7), so
           times are listed in "Seen, not comparable" and never judged.
  card     an item card names the facility and level that make the item, its time and, for a crop,
           its environment: the row of that facility's CSV (or the seasonal file) is looked up by the
           item name and each column the card shows is judged on its own. facility_level always;
           production_time against the card's time in seconds where the CSV has that column (crops);
           for a processed item the card's "Time" against emode_seconds in data/overrides/emode_times.csv
           (the recipe's E-mode base time, which the card shows once E-mode exists at RV 12; see
           docs/design.md section 7, question 8), or listed, not judged, when that table has no row for
           the item; workload only when the card itself says "Workload N" (the processor CSVs hold a
           workload, not seconds); environment when the
           card shows one. One disagreeing column makes the card disagree; a card whose item is a row
           of another facility's file disagrees too; an item that is no row anywhere is unknown.
           A card that agrees for an item listed in data/unverified.csv confirms that row.
  unclear  an unlock line read one RV level off the table, in a single frame: the number is often
           half hidden behind the Batch button, so it is not a disagreement (no override is proposed)
           until a second frame shows the same number; off by two or more is judged as a disagreement.
  level_up a Level Up tab's coin cost against FACILITY_UPGRADE_COSTS in web/facility-config.js with
           structure.json `upgradeCosts` on top; cap, a plot's held/cap line against OUTPUT_CAPS with
           `outputCaps` on top. Both prompts are untested, so these have their own section and stay
           out of the verdict counts and the site's rows.
  panel, manage, emode, food, tick, screen
           facts from untested prompts or kept for the game questions: listed under "Seen, not judged
           yet", never judged. scripts/game_questions.py turns all facts into the "Game questions"
           checklist (scripts/game_questions.json).

Nothing is written to the overrides: a disagreement prints a ready-to-paste fragment for
data/overrides/structure.json (unlocks), a row for data/overrides/values.csv (card columns) or a row
for data/overrides/emode_times.csv (a processed item's time) that you accept or reject.

Usage (from the repository root):
  python scripts/verify_data.py [--root R] [--observations FILE] [--out-md FILE] [--out-json FILE] [--web-dir DIR]
  python scripts/verify_data.py --questions     print the game-question checklist and exit (writes nothing)

Defaults: screenshots/observations.jsonl in, screenshots/verification.md and verification.json out;
with --web-dir the JSON summary is also copied there as verification.json (the local site reads it).
The summary's `rows` (see summary_rows) feed the site's "How sure is this data?" card; they name only
facility, item, column, key, status and day, never frames, times of day or values read off the screen;
`questions` holds four whole numbers (total, answered, evidence, open) and `unclear` one.
Standard library only.
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import time
from pathlib import Path

REPORT_FORMAT = "aniimax-verification"
SEASONAL_FILE = "harvest_moon_festival.csv"
EMODE_FILE = "overrides/emode_times.csv"  # under data/: item, facility, emode_seconds, source, fetched_on
ENTRY = re.compile(r"name: '([^']+)',\s*slug: '([^']+)'")
CLASSIC_FACTS = ("unlock", "recipe", "card")  # judged one by one (judge)
NEW_FACTS = ("level_up", "panel", "manage", "food", "cap", "emode", "tick", "screen")  # watch_game.FACTS minus the classic ones
NOT_JUDGED = ("panel", "manage", "emode", "food")  # listed under "Seen, not judged yet"


def load_observations(path: Path) -> list[dict]:
    """The observations, bad lines skipped."""
    try:
        lines = path.read_text(encoding="utf-8").splitlines() if path.is_file() else []
    except (OSError, ValueError):
        return []
    found = []
    for line in lines:
        try:
            item = json.loads(line)
        except ValueError:
            continue
        if not (isinstance(item, dict) and isinstance(item.get("facility"), str)):
            continue
        whole = lambda v: isinstance(v, int) and not isinstance(v, bool) and v >= 1  # noqa: E731
        if item.get("fact") == "unlock" and whole(item.get("facility_level")) and whole(item.get("rv_level")):
            found.append(item)
        elif item.get("fact") == "recipe" and isinstance(item.get("recipe"), str) and item["recipe"]:
            found.append(item)
        elif item.get("fact") == "card" and isinstance(item.get("item"), str) and item["item"]:
            found.append(item)
    return found


def load_new_facts(path: Path) -> list[dict]:
    """The facts of the newer types (NEW_FACTS: Level Up tabs, aux panels, Manage tabs, food, caps,
    E-mode, recipe-box ticks, screens seen), bad lines skipped. They never reach judge(); see
    judge_new and game_questions.py. A fact needs a time and a facility string ("" for food and
    screens, which belong to no facility)."""
    try:
        lines = path.read_text(encoding="utf-8").splitlines() if path.is_file() else []
    except (OSError, ValueError):
        return []
    found = []
    for line in lines:
        try:
            item = json.loads(line)
        except ValueError:
            continue
        if isinstance(item, dict) and item.get("fact") in NEW_FACTS and isinstance(item.get("facility"), str) and isinstance(item.get("t"), str):
            found.append(item)
    return found


def load_categories(root: Path) -> dict[str, str]:
    """{facility name: category} from web/facility-config.js (Materials, Aniimo Materials,
    Environment, Materials Processing), for the game questions' grower and processor detectors."""
    path = root / "web" / "facility-config.js"
    text = path.read_text(encoding="utf-8") if path.is_file() else ""
    return dict(re.findall(r"name: '([^']+)',\s*slug: '[^']+'[^\n]*?category: '([^']+)'", text))


def js_table(config: str, name: str) -> dict[str, dict[int, int | None]]:
    """`export const NAME = { Facility: [a, b, null], 'Two Words': { 2: c } };` as {facility: {level: value}}
    (a list's index 0 is level 1), read by web_check's own parser (js_block, js_level_tables) so the
    two scripts read the table one way. Imported here, not at the top: web_check imports this module."""
    import web_check
    return web_check.js_level_tables(web_check.js_block(config, name)) or {}


def load_structure(root: Path) -> dict:
    try:
        data = json.loads((root / "data" / "overrides" / "structure.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def load_upgrade_costs(root: Path, files: dict[str, str]) -> dict[str, dict[int, int | None]]:
    """FACILITY_UPGRADE_COSTS (Home Coins to reach each level) with structure.json `upgradeCosts`
    merged per level, the way web/overrides.js applies them: a known facility, levels 2 and up, whole
    numbers above 0, or that facility's patch is skipped."""
    config_path = root / "web" / "facility-config.js"
    table = js_table(config_path.read_text(encoding="utf-8"), "FACILITY_UPGRADE_COSTS") if config_path.is_file() else {}
    for name, levels in (load_structure(root).get("upgradeCosts") or {}).items():
        if name in files and isinstance(levels, dict) and levels and all(
                str(k).isdigit() and int(k) >= 2 and whole(v) and v > 0 for k, v in levels.items()):
            table[name] = {**table.get(name, {}), **{int(k): v for k, v in levels.items()}}
    return table


def load_output_caps(root: Path, files: dict[str, str]) -> dict[str, dict[int, int | None]]:
    """OUTPUT_CAPS (index 0 = level 1) with a known facility's structure.json `outputCaps` replacing
    its whole list, as web/overrides.js does (a list of whole numbers or null; unknown facilities skipped)."""
    config_path = root / "web" / "facility-config.js"
    table = js_table(config_path.read_text(encoding="utf-8"), "OUTPUT_CAPS") if config_path.is_file() else {}
    for name, patch in (load_structure(root).get("facilities") or {}).items():
        caps = patch.get("outputCaps") if isinstance(patch, dict) else None
        if name in files and isinstance(caps, list) and caps and all(c is None or (whole(c) and c >= 0) for c in caps):
            table[name] = {i + 1: c for i, c in enumerate(caps)}
    return table


TIME_PART = re.compile(r"(\d+)\s*([hms])\b")


def parse_seconds(text) -> int | None:
    """Seconds from a time as the game writes it: '40m 0s' -> 2400, '1m 48s' -> 108, '54s' -> 54,
    '1h 2m' -> 3720. None when no 'Nh', 'Nm' or 'Ns' part is found (a bare number is not a time)."""
    if not isinstance(text, str):
        return None
    parts = TIME_PART.findall(text.lower())
    if not parts:
        return None
    return sum(int(n) * {"h": 3600, "m": 60, "s": 1}[unit] for n, unit in parts)


def load_item_rows(root: Path, files: dict[str, str]) -> tuple[dict[str, dict[str, dict]], dict[str, dict[str, dict]]]:
    """{facility: {item name: its row}} from each facility's own CSV, and the same from the seasonal file."""
    own, seasonal = {}, {}
    for facility, file in files.items():
        path = root / "data" / file
        if path.is_file():
            own[facility] = {row["name"]: row for row in read_rows(path) if row.get("name")}
    season = root / "data" / SEASONAL_FILE
    if season.is_file():
        for row in read_rows(season):
            if row.get("name") and row.get("facility"):
                seasonal.setdefault(row["facility"], {})[row["name"]] = row
    return own, seasonal


def load_emode_times(root: Path) -> dict[tuple[str, str], int]:
    """{(facility, item): E-mode base time in seconds} from data/overrides/emode_times.csv, the time a
    processed item's card shows (fan data, see the file's header). Rows without a whole number of
    seconds are skipped. Empty when the file is missing."""
    path = root / "data" / EMODE_FILE
    if not path.is_file():
        return {}
    table = {}
    for row in read_rows(path):
        if row.get("item") and row.get("facility") and row.get("emode_seconds", "").isdigit():
            table[(row["facility"], row["item"])] = int(row["emode_seconds"])
    return table


def load_unverified(root: Path) -> list[dict]:
    """The rows of data/unverified.csv: {name, facility}, the values upstream has not confirmed in game."""
    path = root / "data" / "unverified.csv"
    return [r for r in read_rows(path) if r.get("name")] if path.is_file() else []


def load_facilities(root: Path) -> tuple[dict[str, str], dict[str, dict[int, int]]]:
    """From web/facility-config.js: {facility name: csv file name} and {facility name: {facility level: RV level}}.
    Each entry starts at `name: '...', slug: '...'` and runs to the next entry (or the end of the list)."""
    text = (root / "web" / "facility-config.js").read_text(encoding="utf-8")
    end = text.find("\n];")
    text = text[: end if end > 0 else len(text)]
    marks = list(ENTRY.finditer(text))
    files, unlocks = {}, {}
    for i, mark in enumerate(marks):
        chunk = text[mark.end(): marks[i + 1].start() if i + 1 < len(marks) else len(text)]
        name = mark.group(1)
        files[name] = mark.group(2).replace("-", "_") + ".csv"
        table = re.search(r"unlocks:\s*\{([^}]*)\}", chunk)
        if table:
            unlocks[name] = {int(k): int(v) for k, v in re.findall(r"(\d+)\s*:\s*(\d+)", table.group(1))}
    return files, unlocks


def apply_structure_overrides(root: Path, unlocks: dict[str, dict[int, int]]) -> dict[str, dict[int, int]]:
    """My verified unlocks from data/overrides/structure.json, applied the way the site applies them
    (web/overrides.js): a facility's `unlocks` REPLACES its whole table, only known facilities count,
    every level must be digits and every RV a whole number of at least 1, or that facility's patch
    is skipped. Judging against the same table the site uses is the point."""
    merged = {name: dict(levels) for name, levels in unlocks.items()}
    path = root / "data" / "overrides" / "structure.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}
    except (OSError, ValueError):
        return merged
    facilities = data.get("facilities") if isinstance(data, dict) else None
    if not isinstance(facilities, dict):
        return merged
    for name, entry in facilities.items():
        if name not in merged or not isinstance(entry, dict) or "unlocks" not in entry:
            continue
        table = entry.get("unlocks")
        if not isinstance(table, dict) or not table:
            continue
        valid = {}
        for level, rv in table.items():
            if isinstance(level, str) and level.isdigit() and isinstance(rv, int) and not isinstance(rv, bool) and rv >= 1:
                valid[int(level)] = rv
        if len(valid) == len(table):
            merged[name] = valid
    return merged


def load_recipes(root: Path, files: dict[str, str]) -> tuple[dict[str, set[str]], dict[str, set[str]]]:
    """{facility: recipe names in its own CSV}, {facility: seasonal recipe names (harvest_moon_festival.csv)}."""
    own, seasonal = {}, {}
    for facility, file in files.items():
        path = root / "data" / file
        if path.is_file():
            own[facility] = {row["name"].strip() for row in read_rows(path) if row.get("name")}
    season = root / "data" / SEASONAL_FILE
    if season.is_file():
        for row in read_rows(season):
            if row.get("name") and row.get("facility"):
                seasonal.setdefault(row["facility"].strip(), set()).add(row["name"].strip())
    return own, seasonal


def read_rows(path: Path) -> list[dict]:
    """A data CSV as dicts. The files put a space after each comma, hence skipinitialspace."""
    with path.open(encoding="utf-8", newline="") as f:
        reader = csv.DictReader((line for line in f if line.strip() and not line.lstrip().startswith("#")), skipinitialspace=True)
        return [{(k or "").strip(): (v or "").strip() for k, v in row.items()} for row in reader]


def whole(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def judge_card(obs: dict, files: dict[str, str], own_rows: dict[str, dict[str, dict]], seasonal_rows: dict[str, dict[str, dict]],
               emode: dict[tuple[str, str], int] | None = None) -> dict:
    """The verdict for one item card: {obs, status, detail, columns: [{column, screen, data, status}],
    proposals: [values.csv or emode_times.csv rows as dicts, each with a "table"]}. Columns are judged
    one by one (see the module docstring); a column the card did not show, or that the data holds in
    another unit, is listed as "listed". `emode` is the E-mode time table (load_emode_times)."""
    facility, item = obs["facility"], obs["item"]
    emode = emode or {}
    if facility not in files:
        return {"obs": obs, "status": "unknown", "detail": "facility not in the table", "columns": [], "proposals": []}
    row, file = None, files[facility]
    if item in own_rows.get(facility, {}):
        row = own_rows[facility][item]
    elif item in seasonal_rows.get(facility, {}):
        row, file = seasonal_rows[facility][item], SEASONAL_FILE
    if row is None:
        elsewhere = sorted([files[f] for f, rows in own_rows.items() if item in rows and f != facility]
                           + [f"{SEASONAL_FILE} ({f})" for f, rows in seasonal_rows.items() if item in rows and f != facility])
        if elsewhere:
            return {"obs": obs, "status": "disagree", "detail": f"the data has {item} under {', '.join(elsewhere)}, not {file}", "columns": [], "proposals": []}
        return {"obs": obs, "status": "unknown", "detail": f"{item} is not a row of {file} (maybe an ingredient, or a new recipe)", "columns": [], "proposals": []}

    columns = [{"column": "facility", "screen": facility, "data": file, "status": "agree"}]

    def compare(column: str, screen, data_text: str, same) -> None:
        if screen is None:
            columns.append({"column": column, "screen": None, "data": data_text, "status": "listed"})
        elif same(screen, data_text):
            columns.append({"column": column, "screen": screen, "data": data_text, "status": "agree"})
        else:
            columns.append({"column": column, "screen": screen, "data": data_text, "status": "disagree"})

    level = obs.get("facility_level") if whole(obs.get("facility_level")) else None
    compare("facility_level", level, row.get("facility_level", ""), lambda s, d: d.isdigit() and int(d) == s)
    seconds = obs.get("time_seconds") if whole(obs.get("time_seconds")) else None
    if row.get("production_time", "").strip():  # a crop or seasonal crop: the data holds seconds
        compare("production_time", seconds, row["production_time"], lambda s, d: d.isdigit() and int(d) == s)
    elif "workload" in row:  # a processor: the card's time is the E-mode base time when the table has it, else listed
        if obs.get("time"):
            if (facility, item) in emode:
                compare("emode_seconds", seconds, str(emode[(facility, item)]), lambda s, d: d.isdigit() and int(d) == s)
            else:
                columns.append({"column": "time", "screen": obs["time"], "data": f"workload {row.get('workload', '')}", "status": "listed"})
        workload = obs.get("workload") if whole(obs.get("workload")) else None
        if workload is not None:
            compare("workload", workload, row.get("workload", ""), lambda s, d: d.isdigit() and int(d) == s)
        elif not obs.get("time"):  # neither line read: the card is not complete (it showed one of them)
            columns.append({"column": "workload", "screen": None, "data": row.get("workload", ""), "status": "listed"})
    if "environment" in row:
        env = obs.get("environment") if isinstance(obs.get("environment"), str) and obs["environment"].strip() else None
        data_env = row.get("environment", "").strip()
        if env is None and not data_env:
            columns.append({"column": "environment", "screen": None, "data": "", "status": "agree"})  # no line on the card, none in the data
        else:
            compare("environment", env, data_env, lambda s, d: slug(s) == slug(d))

    bad = [c for c in columns if c["status"] == "disagree"]
    unread = [c for c in columns if c["status"] == "listed" and c["column"] != "time"]  # a processor's time is never judged
    status = "disagree" if bad else "agree"
    said = [f"{c['column']} {c['screen']} (data: {c['data'] or 'none'})" for c in columns if c["column"] != "facility" and c["status"] in ("agree", "disagree")]
    said += [f"{c['column']} not read (data: {c['data'] or 'none'})" for c in unread]
    detail = f"a row of {file}" + (f": {'; '.join(said)}" if said else "")
    if bad:
        detail = f"screen: " + "; ".join(f"{c['column']} {c['screen']}" for c in bad) + "; " + file + " says " + "; ".join(f"{c['data'] or 'none'}" for c in bad)
    proposals = [{"table": "values", "file": file, "match": item, "column": c["column"], "value": str(c["screen"]), "upstream_value": c["data"],
                  "verified_on": day(obs.get("t")), "note": f"seen on the item card in {obs.get('frame')}"} for c in bad if c["column"] != "emode_seconds"]
    proposals += [{"table": "emode", "item": item, "facility": facility, "emode_seconds": str(c["screen"]),
                   "source": f"seen on the item card in {obs.get('frame')} (table said {c['data']})", "fetched_on": day(obs.get("t"))}
                  for c in bad if c["column"] == "emode_seconds"]
    if obs.get("behind"):
        detail += " (read off a half-hidden card behind another: weaker)"
    # complete: every column the data holds for this item was read off the card and agreed, and the card was in front
    return {"obs": obs, "status": status, "detail": detail, "columns": columns, "proposals": proposals,
            "complete": status == "agree" and not unread and not obs.get("behind")}


def slug(text) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(text or "").lower()).strip("_")


def judge(observations: list[dict], unlocks: dict[str, dict[int, int]], files: dict[str, str],
          own: dict[str, set[str]], seasonal: dict[str, set[str]],
          own_rows: dict[str, dict[str, dict]] | None = None, seasonal_rows: dict[str, dict[str, dict]] | None = None,
          emode: dict[tuple[str, str], int] | None = None) -> list[dict]:
    """One verdict per observation: {obs, status: agree|disagree|unclear|unknown, detail, [table_rv]}.
    An unlock read one RV level off the table in fewer than UNCLEAR_FRAMES frames is unclear, not a
    disagreement (see the module docstring)."""
    out = []
    # The same unlock line seen with different numbers in different frames: the model misreads a
    # number that a button half hides, so every reading of that line is marked as conflicting.
    readings: dict[tuple, set] = {}
    frames_of: dict[tuple, set] = {}  # (facility, level, rv) -> the frames that showed that number
    for i, obs in enumerate(observations):
        if obs["fact"] == "unlock":
            readings.setdefault((obs["facility"], obs.get("facility_level")), set()).add(obs.get("rv_level"))
            frames_of.setdefault((obs["facility"], obs.get("facility_level"), obs.get("rv_level")), set()).add(obs.get("frame") or f"#{i}")
    for obs in observations:
        facility = obs["facility"]
        if obs["fact"] == "card":
            out.append(judge_card(obs, files, own_rows or {}, seasonal_rows or {}, emode))
        elif obs["fact"] == "unlock":
            fl, rv = obs.get("facility_level"), obs.get("rv_level")
            table = unlocks.get(facility)
            seen = readings.get((facility, fl), set())
            conflict = f" (conflicting sightings of this line: RV {', '.join(str(v) for v in sorted(seen))}; one is a misread)" if len(seen) > 1 else ""
            if table is None or fl not in table:
                why = "facility not in the table" if table is None else f"Lv.{fl} not in the table"
                out.append({"obs": obs, "status": "unknown", "detail": why})
            elif table[fl] == rv:
                out.append({"obs": obs, "status": "agree", "detail": f"Lv.{fl} needs RV {rv} (table says RV {table[fl]}){conflict}{untested_note(obs)}"})
            elif abs(rv - table[fl]) == 1 and len(frames_of.get((facility, fl, rv), ())) < UNCLEAR_FRAMES:
                out.append({"obs": obs, "status": "unclear", "table_rv": table[fl],
                            "detail": f"screen: Lv.{fl} needs RV {rv}; table says RV {table[fl]}; off by one in a single frame: open the panel again{conflict}{untested_note(obs)}"})
            else:
                out.append({"obs": obs, "status": "disagree", "table_rv": table[fl],
                            "detail": f"screen: Lv.{fl} needs RV {rv}; table says RV {table[fl]}{conflict}{untested_note(obs)}"})
        else:
            recipe = obs.get("recipe")
            if facility not in files:
                out.append({"obs": obs, "status": "unknown", "detail": "facility not in the table"})
            elif recipe in own.get(facility, set()):
                out.append({"obs": obs, "status": "agree", "detail": f"a row of {files[facility]}"})
            elif recipe in seasonal.get(facility, set()):
                out.append({"obs": obs, "status": "agree", "detail": f"a seasonal row of {SEASONAL_FILE}"})
            else:
                elsewhere = sorted([files[f] for f, names in own.items() if recipe in names and f != facility]
                                   + [f"{SEASONAL_FILE} ({f})" for f, names in seasonal.items() if recipe in names and f != facility])
                if elsewhere:
                    out.append({"obs": obs, "status": "disagree", "detail": f"the data has it under {', '.join(elsewhere)}, not {files[facility]}"})
                else:
                    out.append({"obs": obs, "status": "unknown", "detail": f"not a recipe row in {files[facility]} (maybe an ingredient or a new recipe)"})
    return out


UNCLEAR_FRAMES = 2  # frames that must show the same off-by-one number before it is a disagreement


def untested_note(obs: dict) -> str:
    return " (read from the Level Up tab, an untested prompt)" if obs.get("untested") else ""


def digits(value) -> int | None:
    """A whole number from a value written on screen ('81 000', '81,000', 81000), or None."""
    if whole(value):
        return value
    text = re.sub(r"[^0-9]", "", str(value)) if isinstance(value, str) else ""
    return int(text) if text else None


def judge_new(facts: list[dict], upgrade: dict[str, dict[int, int | None]], caps: dict[str, dict[int, int | None]]) -> list[dict]:
    """The new checks, one verdict per level_up or cap fact: {obs, check, status:
    agree|disagree|unknown|listed, detail, fragment}. `fragment` is a structure.json patch to paste
    on a disagreement (nothing is applied). The prompts behind both are untested, so these verdicts
    are kept apart from judge()'s: own section, no counts in the summary, no rows."""
    out = []
    for f in facts:
        facility = f.get("facility")
        if f.get("fact") == "level_up":
            cost, level = digits(f.get("coin_cost")), f.get("next_level")
            table = upgrade.get(facility)
            if cost is None or not whole(level):
                out.append({"obs": f, "check": "upgrade cost", "status": "listed", "detail": "no cost or next level read (a cost equal to the Home Coins balance is cleared)"})
            elif table is None or table.get(level) is None:
                out.append({"obs": f, "check": "upgrade cost", "status": "unknown", "detail": f"no upgrade cost to Lv.{level} in the table"})
            elif table[level] == cost:
                out.append({"obs": f, "check": "upgrade cost", "status": "agree", "detail": f"Lv.{level} costs {cost} (table says {table[level]})"})
            else:
                out.append({"obs": f, "check": "upgrade cost", "status": "disagree", "detail": f"screen: Lv.{level} costs {cost}; table says {table[level]}",
                            "fragment": {"upgradeCosts": {facility: {str(level): cost}}}})
        elif f.get("fact") == "cap":
            cap, level = f.get("cap"), f.get("level")
            table = caps.get(facility)
            if not whole(cap) or not whole(level):
                out.append({"obs": f, "check": "store cap", "status": "listed", "detail": "no cap or facility level read"})
            elif table is None or table.get(level) is None:
                out.append({"obs": f, "check": "store cap", "status": "unknown", "detail": f"no output cap for Lv.{level} in the table"})
            elif table[level] == cap:
                out.append({"obs": f, "check": "store cap", "status": "agree", "detail": f"Lv.{level} holds {cap} (table says {table[level]})"})
            else:
                levels = dict(table)
                levels[level] = cap
                whole_list = [levels.get(i) for i in range(1, max(levels) + 1)]
                out.append({"obs": f, "check": "store cap", "status": "disagree", "detail": f"screen: Lv.{level} holds {cap}; table says {table[level]}",
                            "fragment": {"facilities": {facility: {"outputCaps": whole_list}}}})
    return out


def cell(text) -> str:
    return str(text if text is not None else "").replace("|", "\\|")


def day(t) -> str:
    return str(t or "")[:10]


def table(headers: list[str], rows: list[list]) -> list[str]:
    lines = ["| " + " | ".join(headers) + " |", "|" + "|".join("---" for _ in headers) + "|"]
    lines += ["| " + " | ".join(cell(c) for c in row) + " |" for row in rows]
    return lines


def confirmed_unverified(verdicts: list[dict], unverified: list[dict]) -> list[dict]:
    """For each row of data/unverified.csv: {name, facility, confirmed: [card verdicts that agree]}."""
    out = []
    for row in unverified:
        name, facility = row.get("name", ""), row.get("facility", "")
        seen = [v for v in verdicts if v["obs"]["fact"] == "card" and v["obs"]["item"] == name and slug(v["obs"]["facility"]) == slug(facility)]
        out.append({"name": name, "facility": facility, "confirmed": [v for v in seen if v.get("complete")],
                    "partial": [v for v in seen if not v.get("complete")]})
    return out


SUMMARY_STATUSES = ("agree", "disagree")
DAY = re.compile(r"\d{4}-\d{2}-\d{2}")


def summary_rows(verdicts: list[dict]) -> list[dict]:
    """The verdicts merged per value, for the site's "How sure is this data?" card (web/cards/coverage.js):
    [{facility, item, column, key, status, day}], sorted.

      card columns  each judged column of an item card (agree or disagree; a `listed` column and the
                    facility column are skipped), key "". A card whose item is a row of another
                    facility's file has no columns and counts as a "recipe" disagreement.
      unlock        column "unlock", item "", key "<facility level>".
      recipe        the recipe in a facility's box: column "recipe", item = the recipe, key "".

    Unknown verdicts are skipped (nothing was compared). A value seen with one status keeps it; seen
    both agreeing and disagreeing (a misread, or the game changed) it becomes "conflict". `day` is the
    last day it was seen (YYYY-MM-DD, or "" when the observation had no usable time).
    PRIVACY: web/verification.json carries these rows and the site shows them, so a row never holds a
    frame name, a time of day or a value read off the screen."""
    merged: dict[tuple[str, str, str, str], dict] = {}

    def add(facility, item, column, key, status, t) -> None:
        if status not in SUMMARY_STATUSES or not isinstance(facility, str) or not facility:
            return
        entry = merged.setdefault((facility, str(item or ""), column, str(key if key is not None else "")), {"statuses": set(), "day": ""})
        entry["statuses"].add(status)
        seen = day(t)
        if DAY.fullmatch(seen):
            entry["day"] = max(entry["day"], seen)

    for v in verdicts:
        obs = v.get("obs") or {}
        fact, facility, t = obs.get("fact"), obs.get("facility"), obs.get("t")
        if fact == "card":
            for c in v.get("columns") or []:
                if c.get("column") != "facility":
                    add(facility, obs.get("item"), str(c.get("column")), "", c.get("status"), t)
            if not v.get("columns") and v.get("status") == "disagree":
                add(facility, obs.get("item"), "recipe", "", "disagree", t)
        elif fact == "unlock":
            if obs.get("untested"):
                continue  # read from the Level Up tab, an untested prompt: never a served row
            add(facility, "", "unlock", obs.get("facility_level"), v.get("status"), t)
        elif fact == "recipe":
            add(facility, obs.get("recipe"), "recipe", "", v.get("status"), t)
    rows = []
    for (facility, item, column, key), entry in sorted(merged.items()):
        statuses = entry["statuses"]
        rows.append({"facility": facility, "item": item, "column": column, "key": key,
                     "status": "conflict" if len(statuses) > 1 else next(iter(statuses)), "day": entry["day"]})
    return rows


VALUES_HEADER = "file, match, column, value, upstream_value, verified_on, note"
EMODE_HEADER = "item, facility, emode_seconds, source, fetched_on"


def override_row(p: dict) -> str:
    """One data/overrides/values.csv line (file, match, column, value, upstream_value, verified_on, note),
    or one data/overrides/emode_times.csv line (item, facility, emode_seconds, source, fetched_on)."""
    keys = EMODE_HEADER.split(", ") if p.get("table") == "emode" else VALUES_HEADER.split(", ")
    return ", ".join(str(p[k]).replace(",", ";") for k in keys)


def render(verdicts: list[dict], updated: str, unlocks: dict[str, dict[int, int]] | None = None, unverified: list[dict] | None = None,
           new_verdicts: list[dict] | None = None, new_facts: list[dict] | None = None, questions: list[dict] | None = None) -> str:
    counts = {s: sum(1 for v in verdicts if v["status"] == s) for s in ("agree", "disagree", "unclear", "unknown")}
    frames = {v["obs"].get("frame") for v in verdicts}
    last = max((str(v["obs"].get("t") or "") for v in verdicts), default="")
    cards = [v for v in verdicts if v["obs"]["fact"] == "card"]
    panel = [v for v in verdicts if v["obs"]["fact"] != "card"]
    lines = ["# Game data check", "",
             f"- Screens observed: {len(frames)} ({len(verdicts)} facts: {len(panel)} from facility panels, {len(cards)} from item cards).",
             f"- Agree with the data: {counts['agree']}.",
             f"- Disagree with the data: {counts['disagree']}" + (f" (plus {counts['unclear']} unclear: off by one in a single frame, see Unclear)." if counts["unclear"] else "."),
             f"- Unknown (nothing to compare with): {counts['unknown']}.",
             f"- Last observation: {last or 'none yet'} (report written {updated}).", ""]
    by = {s: [v for v in panel if v["status"] == s] for s in counts}

    def row(v):
        o = v["obs"]
        what = f"Lv.{o['facility_level']} unlock -> RV {o['rv_level']}" if o["fact"] == "unlock" else f"recipe {o.get('recipe')}"
        return [o["facility"], what, v["detail"], o.get("frame"), day(o.get("t"))]
    headers = ["Facility", "Fact", "Detail", "Frame", "Seen"]

    lines += ["## Agree", ""] + (table(headers, [row(v) for v in by["agree"]]) if by["agree"] else ["Nothing yet."]) + [""]
    lines += ["## Disagree", ""]
    if not by["disagree"]:
        lines += ["Nothing disagrees." + (" (Item cards have their own section below.)" if cards else ""), ""]
    else:
        lines += ["Open the panel in game and read the line yourself before pasting anything: the model misreads a number that the "
                  "Batch button half hides (seen 2026-10-15, RV 12 read off a cut-off 13).", ""]
    for v in by["disagree"]:
        o = v["obs"]
        lines += [f"### {o['facility']}: {row(v)[1]}", "", f"- {v['detail']}", f"- Frame {o.get('frame')}, seen {day(o.get('t'))}."]
        if o["fact"] == "unlock" and o.get("untested"):
            lines += ["- No override is proposed: this line was read from the Level Up tab, whose prompt has no checked frames yet. "
                      "Check the tab in game; a facility panel's grey line seen in two frames gives a fragment.", ""]
        elif o["fact"] == "unlock":
            # The site replaces the whole table with the override, so the fragment carries every level.
            levels = dict((unlocks or {}).get(o["facility"], {}))
            levels[o["facility_level"]] = o["rv_level"]
            fragment = {"facilities": {o["facility"]: {"unlocks": {str(k): v for k, v in sorted(levels.items())}}}}
            lines += ["- Proposed override for data/overrides/structure.json (paste into its `facilities`; it replaces this facility's whole unlock table, so every level is listed; nothing is applied for you). "
                      f"Note to keep with it: seen on screen in {o.get('frame')} on {day(o.get('t'))}.", "",
                      "```json", json.dumps(fragment, indent=2), "```", ""]
        else:
            lines += ["- Recipe placement is not an override (the CSV rows are upstream's). Check the panel in game, then fix the row in "
                      "data/overrides/values.csv or tell upstream.", ""]
    if by["unclear"]:
        lines += ["## Unclear", "",
                  "Read one RV level off the table, in a single frame: the Batch button often half hides that number. No override is "
                  "proposed; open the panel again (a second frame with the same number makes it a disagreement).", ""]
        lines += table(headers, [row(v) for v in by["unclear"]]) + [""]
    lines += ["## Unknown", ""] + (table(headers, [row(v) for v in by["unknown"]]) if by["unknown"] else ["Nothing here."]) + [""]

    # Item cards: one row per card seen, judged column by column against the item's CSV row.
    lines += ["## Item cards", "",
              "An item's information card names the facility and level that make it, its time and, for a crop, its environment: "
              "the facility_level, production_time and environment columns of that facility's CSV. A processed item's time is its "
              "recipe's E-mode base time (shown once E-mode exists, RV 12), judged against emode_seconds in data/overrides/emode_times.csv "
              "(fan data from wikily.gg, not upstream's) and listed, not judged, when that table has no row for the item; a card that "
              "itself says 'Workload N' is compared with the workload column. Verdict: agree when every judged column agrees, disagree "
              "when one does not.", ""]
    if not cards:
        lines += ["No item card seen yet. Click an item on the Home Management screen while the watcher runs.", ""]
    else:
        def card_row(v):
            o = v["obs"]
            shown = o.get("time") or (f"Workload {o['workload']}" if o.get("workload") is not None else "")
            return [o["item"], o["facility"], o.get("facility_level"), shown, o.get("environment") or "", v["status"], v["detail"], o.get("frame"), day(o.get("t"))]
        lines += table(["Item", "Made by (card)", "Level", "Time", "Environment", "Verdict", "Detail", "Frame", "Seen"],
                       [card_row(v) for v in cards]) + [""]
        bad = [v for v in cards if v["status"] == "disagree"]
        if bad:
            lines += ["### Card disagreements", "",
                      "Open the card in game and read the line yourself before pasting anything (two cards can overlap, and the model has "
                      "mixed the front card with the one behind it). Each proposed line goes into data/overrides/values.csv (run "
                      "`python scripts/apply_overrides.py --check` afterwards) or, for an E-mode time, replaces that item's row in "
                      "data/overrides/emode_times.csv. Nothing is applied for you.", ""]
        for v in bad:
            o = v["obs"]
            lines += [f"#### {o['item']} ({o['facility']})", "", f"- {v['detail']}", f"- Frame {o.get('frame')}, seen {day(o.get('t'))}."]
            values = [p for p in v.get("proposals", []) if p.get("table") != "emode"]
            emodes = [p for p in v.get("proposals", []) if p.get("table") == "emode"]
            if values:
                lines += ["- Proposed row(s) for data/overrides/values.csv:", "", "```csv", VALUES_HEADER]
                lines += [override_row(p) for p in values] + ["```", ""]
            if emodes:
                lines += ["- Proposed row(s) for data/overrides/emode_times.csv (replace the item's current row):", "", "```csv", EMODE_HEADER]
                lines += [override_row(p) for p in emodes] + ["```", ""]
            if not v.get("proposals"):
                lines += ["- Placement is not an override (the CSV rows are upstream's). Check the card in game, then tell upstream.", ""]
        lines += ["### Rows of data/unverified.csv", "",
                  "Upstream marks these values as not yet confirmed in game. A card confirms a row when every column the data holds "
                  "for it (level, time or workload, environment) was read off the card and agrees.", ""]
        if unverified:
            rows = []
            for u in confirmed_unverified(verdicts, unverified):
                if u["confirmed"]:
                    hit = u["confirmed"][0]
                    rows.append([u["name"], u["facility"], f"confirmed: {hit['detail']}", hit["obs"].get("frame"), day(hit["obs"].get("t"))])
                elif u["partial"]:
                    hit = u["partial"][0]
                    rows.append([u["name"], u["facility"], f"seen, not confirmed ({hit['status']}): {hit['detail']}", hit["obs"].get("frame"), day(hit["obs"].get("t"))])
                else:
                    rows.append([u["name"], u["facility"], "not seen on a card yet", "", ""])
            lines += table(["Item", "Facility", "Status", "Frame", "Seen"], rows) + [""]
        else:
            lines += ["data/unverified.csv is empty or missing.", ""]
    times = [v["obs"] for v in verdicts if v["obs"]["fact"] == "recipe" and v["obs"].get("time")]
    lines += ["## Seen, not comparable", "",
              "The time in a facility's recipe box is not understood yet (docs/design.md section 7), so it is listed and never judged.", ""]
    lines += table(["Facility", "Recipe", "Time in the box", "Frame", "Seen"],
                   [[o["facility"], o.get("recipe"), o["time"], o.get("frame"), day(o.get("t"))] for o in times]) if times else ["Nothing yet."]
    lines += [""] + render_new(new_verdicts or [], new_facts or [])
    if questions is not None:
        lines += [""] + render_questions(questions)
    return "\n".join(lines) + "\n"


def describe(fact: dict) -> str:
    """What a not-yet-judged fact read, in a few words (the local report only)."""
    keys = {"panel": ("tab", "capacity", "in_use", "supply_rate", "supply_mode"), "manage": ("slots_total", "slots_empty", "first_ability", "emode_on"),
            "emode": ("switch_visible", "emode_on", "power_draw"), "food": ("total_food_energy", "working_aniimo")}.get(fact.get("fact"), ())
    return "; ".join(f"{k} {fact.get(k)}" for k in keys if fact.get(k) is not None) or "nothing read"


def render_new(new_verdicts: list[dict], new_facts: list[dict]) -> list[str]:
    lines = ["## Upgrade costs and store caps (untested prompts)", "",
             "A Level Up tab's coin cost against FACILITY_UPGRADE_COSTS (with structure.json `upgradeCosts`), and a plot's held/cap line "
             "against OUTPUT_CAPS (with `outputCaps`). Both prompts were written without a real frame, so read the screen yourself before "
             "pasting a fragment; these are not counted above and never reach the site.", ""]
    if new_verdicts:
        lines += table(["Facility", "Check", "Verdict", "Detail", "Frame", "Seen"],
                       [[v["obs"].get("facility"), v["check"], v["status"], v["detail"], v["obs"].get("frame"), day(v["obs"].get("t"))] for v in new_verdicts]) + [""]
        for v in (v for v in new_verdicts if v.get("fragment")):
            lines += [f"- Proposed fragment for data/overrides/structure.json ({v['obs'].get('facility')}, {v['check']}; nothing is applied for you):", "",
                      "```json", json.dumps(v["fragment"], indent=2), "```", ""]
    else:
        lines += ["Nothing yet.", ""]
    seen = [f for f in new_facts if f.get("fact") in NOT_JUDGED]
    ticks = sum(1 for f in new_facts if f.get("fact") == "tick")
    screens = sorted({str(f.get("screen")) for f in new_facts if f.get("fact") == "screen"})
    lines += ["## Seen, not judged yet", "",
              "Aux panels (Crackle Generator, Storage Unit), Manage tabs, E-mode switches and the Food tab, read with prompts that have no "
              "checked frames yet. Kept for the game questions below; nothing here is compared with the data.", ""]
    lines += table(["Fact", "Facility", "Level", "Read", "Frame", "Seen"],
                   [[f["fact"], f.get("facility") or "", f.get("level"), describe(f), f.get("frame"), day(f.get("t"))] for f in seen]) if seen else ["Nothing yet."]
    lines += ["", f"- Recipe-box readings kept over time (tick facts): {ticks}.",
              f"- Screens read at least once (RV, modules, roster): {', '.join(screens) if screens else 'none yet'}.", ""]
    return lines


def render_questions(questions: list[dict]) -> list[str]:
    """The game-question checklist: id, status, screen, question (text from scripts/game_questions.json
    only, never a value read off the screen)."""
    counts = question_counts(questions)
    lines = ["## Game questions", "",
             f"{counts['answered']} of {counts['total']} answered, {counts['evidence']} with evidence waiting for you, {counts['open']} open. "
             "Evidence means a screen was captured but its prompt is untested or the answer needs your eye; set `settled_by_doc` in "
             "scripts/game_questions.json once you log the answer.", ""]
    return lines + table(["Id", "Status", "Screen", "Minutes", "Question"],
                         [[q["id"], q["status"], q.get("screen", ""), q.get("minutes", ""), q.get("question", "")] for q in questions])


def question_counts(questions: list[dict]) -> dict[str, int]:
    """{total, answered, evidence, open}: four whole numbers, all verification.json carries about the questions."""
    return {"total": len(questions), **{s: sum(1 for q in questions if q.get("status") == s) for s in ("answered", "evidence", "open")}}


def game_questions_for(root: Path, observations: Path, verdicts: list[dict] | None = None) -> list[dict]:
    """Each question of scripts/game_questions.json with its status, from every fact in the log."""
    import game_questions  # here, not at the top: game_questions is optional for the plain check
    files, unlocks = load_facilities(root)
    if verdicts is None:
        own, seasonal = load_recipes(root, files)
        own_rows, seasonal_rows = load_item_rows(root, files)
        verdicts = judge(load_observations(observations), apply_structure_overrides(root, unlocks), files, own, seasonal,
                         own_rows, seasonal_rows, load_emode_times(root))
    facts = load_observations(observations) + load_new_facts(observations)
    unverified = confirmed_unverified(verdicts, load_unverified(root))
    return game_questions.evaluate(game_questions.load_questions(), facts, categories=load_categories(root), unverified=unverified)


def run(root: Path, observations: Path, out_md: Path, out_json: Path, web_json: Path | None = None, now=None,
        question_status: dict | None = None) -> dict:
    """Compare, write the report and the JSON summary (and the web copy). Returns the summary.
    `question_status`, when given, is filled with {question id: status} (it never reaches a file)."""
    files, unlocks = load_facilities(root)
    unlocks = apply_structure_overrides(root, unlocks)
    own, seasonal = load_recipes(root, files)
    own_rows, seasonal_rows = load_item_rows(root, files)
    unverified = load_unverified(root)
    verdicts = judge(load_observations(observations), unlocks, files, own, seasonal, own_rows, seasonal_rows, load_emode_times(root))
    updated = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now if now is not None else time.time()))
    try:
        report = out_md.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        report = out_md.name
    cards = [v for v in verdicts if v["obs"]["fact"] == "card"]
    new_facts = load_new_facts(observations)
    new_verdicts = judge_new(new_facts, load_upgrade_costs(root, files), load_output_caps(root, files))
    try:
        questions = game_questions_for(root, observations, verdicts)
    except Exception as e:  # noqa: BLE001  (a broken questions file must not stop the data check)
        print(f"game questions skipped: {e}")
        questions = None
    if question_status is not None:
        question_status.clear()
        question_status.update({q["id"]: q["status"] for q in questions or []})
    summary = {"format": REPORT_FORMAT, "version": 1, "updatedAt": updated, "observations": len(verdicts),
               "agree": sum(1 for v in verdicts if v["status"] == "agree"),
               "disagree": sum(1 for v in verdicts if v["status"] == "disagree"),
               "unclear": sum(1 for v in verdicts if v["status"] == "unclear"),
               "unknown": sum(1 for v in verdicts if v["status"] == "unknown"),
               "cards": {"seen": len(cards), **{s: sum(1 for v in cards if v["status"] == s) for s in ("agree", "disagree", "unknown")},
                         "unverified_confirmed": [u["name"] for u in confirmed_unverified(verdicts, unverified) if u["confirmed"]],
                         "unverified_total": len(unverified)},
               "rows": summary_rows(verdicts),
               "report": report}
    if questions is not None:
        summary["questions"] = question_counts(questions)  # counts only: no id, text or value
    out_md.parent.mkdir(parents=True, exist_ok=True)
    out_md.write_text(render(verdicts, updated, unlocks, unverified, new_verdicts, new_facts, questions), encoding="utf-8")
    text = json.dumps(summary)
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(text, encoding="utf-8")
    if web_json:
        web_json.parent.mkdir(parents=True, exist_ok=True)
        web_json.write_text(text, encoding="utf-8")
    return summary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--observations", type=Path, help="default: <root>/screenshots/observations.jsonl")
    parser.add_argument("--out-md", type=Path, help="default: <root>/screenshots/verification.md")
    parser.add_argument("--out-json", type=Path, help="default: <root>/screenshots/verification.json")
    parser.add_argument("--web-dir", type=Path, help="also copy the JSON summary here as verification.json")
    parser.add_argument("--questions", action="store_true", help="print the game-question checklist and exit (writes nothing)")
    args = parser.parse_args(argv)
    shots = args.root / "screenshots"
    if args.questions:
        return print_questions(args.root, args.observations or shots / "observations.jsonl")
    summary = run(args.root, args.observations or shots / "observations.jsonl", args.out_md or shots / "verification.md",
                  args.out_json or shots / "verification.json", args.web_dir / "verification.json" if args.web_dir else None)
    print(f"{summary['observations']} observations: {summary['agree']} agree, {summary['disagree']} disagree, {summary['unclear']} unclear, "
          f"{summary['unknown']} unknown. Report: {args.out_md or shots / 'verification.md'}")
    if "questions" in summary:
        q = summary["questions"]
        print(f"Game questions: {q['answered']} of {q['total']} answered, {q['evidence']} with evidence waiting for you, {q['open']} open.")
    return 0


def print_questions(root: Path, observations: Path) -> int:
    """The checklist on the terminal: one line per question (id, status, minutes, screen) and the
    counts. Only text from scripts/game_questions.json is printed, never a value from the log."""
    questions = game_questions_for(root, observations)
    counts = question_counts(questions)
    width = max((len(q["id"]) for q in questions), default=2)
    for q in questions:
        print(f"{q['id']:<{width}}  {q['status']:<8}  {str(q.get('minutes', '')):>3} min  {q.get('screen', '')}: {q.get('question', '')}")
    print(f"\n{counts['answered']} of {counts['total']} answered, {counts['evidence']} with evidence waiting for you, {counts['open']} open.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

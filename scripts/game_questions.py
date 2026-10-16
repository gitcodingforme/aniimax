#!/usr/bin/env python3
"""The game questions only a play session can settle, and how far the watcher's log has got with each.

scripts/game_questions.json lists the questions (id, source, question, screen, minutes, detector,
settle, settled_by_doc). Each detector looks at the facts in screenshots/observations.jsonl (see
scripts/watch_game.py) and gives a status:

  open      nothing that bears on it has been captured;
  evidence  something was captured, but the prompt that read it has no checked frames yet
            ("untested", see read_screenshots.SCREEN_KINDS), or the question is `settle: owner`
            (the answer needs your own eye on the frames);
  answered  the detector's condition holds on facts read with tested prompts, or `settled_by_doc`
            names where you logged the answer.

Detectors (the "type" of a question's detector):
  fact                 facts of one type, optionally for a facility, facilities or a category
                       (grower, processor), with fields that must be read (`needs`, `needs_any`),
                       values (`where`), two equal fields (`same`), or `min` distinct values of a field
                       (`distinct`) for one facility;
  pair_over_time       two readings of a number at least `min_minutes` / `min_seconds` apart, with no
                       rise between them (food read an hour apart; a countdown read twice);
  tick_reset           a recipe box whose time went up between two readings: a new batch started;
  corroborated_unlock  the same RV level for one unlock line in `frames` different frames;
  unverified_cards     the rows of data/unverified.csv confirmed by complete item cards;
  screens              each listed screen read at least once;
  supply_above         a generator reading with its load above capacity / `ratio`, supply rate read;
  card_near_supply     a processor's item card within `minutes` of a generator reading at `rate`%;
  any / all            the best status of the detectors in `of` / answered only when every one is
                       answered, evidence when any part has something;
  manual               always open until settled_by_doc is set.

verify_data.run writes the checklist into screenshots/verification.md and only the counts
{total, answered, evidence, open} into verification.json (the site's line). Standard library only.
"""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

QUESTIONS_FILE = HERE / "game_questions.json"
QUESTIONS_FORMAT = "aniimax-game-questions"
FILE_KEYS = {"format", "version", "_comment", "questions"}
QUESTION_KEYS = {"id", "source", "question", "screen", "minutes", "detector", "settle", "settled_by_doc"}
SETTLE = ("auto", "owner")
STATUSES = ("open", "evidence", "answered")  # in order: a status only ever moves right
DETECTORS = ("fact", "pair_over_time", "tick_reset", "corroborated_unlock", "unverified_cards", "screens",
             "supply_above", "card_near_supply", "any", "all", "manual")
CATEGORIES = {"grower": ("Materials", "Aniimo Materials"), "processor": ("Materials Processing",)}
# The read_screenshots spec that read each fact type, for "is that prompt tested yet?". An unlock or a
# recipe from a facility panel is a tested reading; an unlock marked untested came from the Level Up tab.
FACT_SPEC = {"level_up": "level_up", "unlock": "level_up", "panel": "pairs", "manage": "manage", "food": "food",
             "cap": "store", "emode": "emode", "tick": "facility_detail", "card": "item_card"}


def load_questions(path: Path | None = None) -> list[dict]:
    data = json.loads((path or QUESTIONS_FILE).read_text(encoding="utf-8"))
    problems = check_file(data)
    if problems:
        raise ValueError("game_questions.json: " + "; ".join(problems))
    return data["questions"]


def check_file(data) -> list[str]:
    """What is wrong with a questions file (empty when it is fine): keys, ids, settle, detector types."""
    if not isinstance(data, dict) or data.get("format") != QUESTIONS_FORMAT or not isinstance(data.get("questions"), list):
        return ["not an aniimax-game-questions file"]
    problems = [f"unknown top-level key {k}" for k in sorted(set(data) - FILE_KEYS)]
    seen = set()
    for q in data["questions"]:
        if not isinstance(q, dict):
            problems.append("a question is not an object")
            continue
        if set(q) != QUESTION_KEYS:
            problems.append(f"{q.get('id')}: keys must be exactly {sorted(QUESTION_KEYS)}")
        if q.get("id") in seen:
            problems.append(f"duplicate id {q.get('id')}")
        seen.add(q.get("id"))
        if q.get("settle") not in SETTLE:
            problems.append(f"{q.get('id')}: settle must be auto or owner")
        problems += [f"{q.get('id')}: {p}" for p in check_detector(q.get("detector"))]
    return problems


def check_detector(det) -> list[str]:
    if not isinstance(det, dict) or det.get("type") not in DETECTORS:
        return [f"unknown detector {det!r}"]
    if det["type"] in ("any", "all"):
        if not isinstance(det.get("of"), list) or not det["of"]:
            return [f"{det['type']} needs a list `of`"]
        return [p for d in det["of"] for p in check_detector(d)]
    return []


# --- reading facts ----------------------------------------------------------------------------------

def when(fact: dict) -> datetime | None:
    try:
        return datetime.strptime(str(fact.get("t")), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def number(value) -> int | None:
    """A whole number from a fact's value: an int, or a number written on screen ('12 400')."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        text = re.sub(r"[^0-9]", "", value)
        return int(text) if text else None
    return None


def slug(text) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(text or "").lower()).strip("_")


def spec_tested(fact: dict, kinds: dict | None) -> bool:
    """Was this fact read with a prompt that is tested now? A fact without "untested" is; one with it
    is when its spec has since been flipped to tested (so old facts count once the prompt is proven)."""
    if not fact.get("untested"):
        return True
    spec = fact.get("screen") if fact.get("fact") == "screen" else FACT_SPEC.get(fact.get("fact"))
    if kinds is None:
        import read_screenshots
        return read_screenshots.is_tested(spec)
    return (kinds.get(spec) or {}).get("tested", False) is True  # the same default as read_screenshots.is_tested


class Context:
    def __init__(self, facts: list[dict], categories: dict[str, str] | None, unverified: list[dict] | None, kinds: dict | None):
        self.facts = [f for f in facts if isinstance(f, dict)]
        self.categories = categories or {}
        self.unverified = unverified
        self.kinds = kinds

    def tested(self, fact: dict) -> bool:
        return spec_tested(fact, self.kinds)

    def in_category(self, facility, category: str) -> bool:
        return self.categories.get(facility) in CATEGORIES.get(category, ())


def matching(det: dict, ctx: Context, fact_type: str | None = None) -> list[dict]:
    """The facts a detector looks at: type, facility / facilities / category, `where`, `needs`,
    `needs_any` and `same`."""
    wanted = fact_type or det.get("fact")
    out = []
    for f in ctx.facts:
        if f.get("fact") != wanted:
            continue
        if "facility" in det and slug(f.get("facility")) != slug(det["facility"]):
            continue
        if "facilities" in det and slug(f.get("facility")) not in {slug(x) for x in det["facilities"]}:
            continue
        if "category" in det and not ctx.in_category(f.get("facility"), det["category"]):
            continue
        if any(f.get(k) != v for k, v in (det.get("where") or {}).items()):
            continue
        if any(f.get(k) in (None, "") for k in det.get("needs") or []):
            continue
        if det.get("needs_any") and all(f.get(k) in (None, "") for k in det["needs_any"]):
            continue
        same = det.get("same")
        if same and (f.get(same[0]) is None or any(f.get(k) != f.get(same[0]) for k in same[1:])):
            continue
        out.append(f)
    return out


# --- conditions: does this set of facts settle the question? ----------------------------------------

def cond_fact(facts: list[dict], det: dict, ctx: Context) -> bool:
    if not facts:
        return False
    field = det.get("distinct")
    if not field:
        return len(facts) >= int(det.get("count", 1))
    by: dict[str, set] = {}
    for f in facts:
        if f.get(field) is not None:
            by.setdefault(slug(f.get("facility")), set()).add(f.get(field))
    return any(len(values) >= int(det.get("min", 2)) for values in by.values())


def cond_pair(facts: list[dict], det: dict, ctx: Context) -> bool:
    """Two readings of `field`, `min_minutes` (or `min_seconds`) apart within one group, with no rise in
    any step between them when `no_rise` (food added, or a new batch, spoils the pair)."""
    gap = float(det.get("min_seconds", 0)) + 60 * float(det.get("min_minutes", 0))
    groups: dict[tuple, list] = {}
    for f in facts:
        t, v = when(f), number(f.get(det["field"]))
        if t is not None and v is not None:
            groups.setdefault(tuple(slug(f.get(k)) for k in det.get("group") or []), []).append((t, v))
    for readings in groups.values():
        readings.sort(key=lambda r: r[0])
        for i in range(len(readings)):
            for j in range(i + 1, len(readings)):
                if (readings[j][0] - readings[i][0]).total_seconds() < gap:
                    continue
                if det.get("no_rise") and any(readings[k + 1][1] > readings[k][1] for k in range(i, j)):
                    continue
                return True
    return False


def cond_tick_reset(facts: list[dict], det: dict, ctx: Context) -> bool:
    groups: dict[tuple, list] = {}
    for f in facts:
        t, v = when(f), number(f.get("time_seconds"))
        if t is not None and v is not None:
            groups.setdefault((slug(f.get("facility")), slug(f.get("recipe"))), []).append((t, v))
    for readings in groups.values():
        readings.sort(key=lambda r: r[0])
        if any(b[1] > a[1] for a, b in zip(readings, readings[1:])):
            return True
    return False


def cond_unlock(facts: list[dict], det: dict, ctx: Context) -> bool:
    frames: dict = {}
    for i, f in enumerate(facts):
        frames.setdefault(f.get("rv_level"), set()).add(f.get("frame") or f"#{i}")
    return any(len(v) >= int(det.get("frames", 2)) for v in frames.values())


def cond_screens(facts: list[dict], det: dict, ctx: Context) -> bool:
    return set(det.get("screens") or []) <= {f.get("screen") for f in facts if f.get("read")}


def cond_supply_above(facts: list[dict], det: dict, ctx: Context) -> bool:
    ratio = float(det.get("ratio", 1.2))
    return any(number(f.get("in_use")) is not None and number(f.get("capacity")) and number(f.get("supply_rate")) is not None
               and number(f["in_use"]) * ratio > number(f["capacity"]) for f in facts)


def cond_card_near(facts: list[dict], det: dict, ctx: Context) -> bool:
    panels = [f for f in facts if f.get("fact") == "panel" and number(f.get("supply_rate")) == int(det.get("rate", 120)) and when(f)]
    cards = [f for f in facts if f.get("fact") == "card" and f.get("time") and when(f)]
    window = 60 * float(det.get("minutes", 10))
    return any(abs((when(c) - when(p)).total_seconds()) <= window for c in cards for p in panels)


def relevant(det: dict, ctx: Context) -> list[dict]:
    kind = det["type"]
    if kind == "fact":
        return matching(det, ctx)
    if kind == "pair_over_time":
        return matching({k: v for k, v in det.items() if k in ("facility", "facilities", "category")}, ctx, det["fact"])
    if kind == "tick_reset":
        return matching({"category": det["category"]} if det.get("category") else {}, ctx, "tick")
    if kind == "corroborated_unlock":
        return [f for f in matching({"facility": det["facility"]}, ctx, "unlock") if f.get("facility_level") == det["facility_level"]]
    if kind == "screens":
        return [f for f in matching({}, ctx, "screen") if f.get("screen") in (det.get("screens") or [])]
    if kind == "supply_above":
        return matching({"facility": det["facility"]}, ctx, "panel")
    if kind == "card_near_supply":
        cards = matching({"category": det["category"]} if det.get("category") else {}, ctx, "card")
        return cards + matching({"facility": det["facility"]}, ctx, "panel")
    return []


CONDITIONS = {"fact": cond_fact, "pair_over_time": cond_pair, "tick_reset": cond_tick_reset, "corroborated_unlock": cond_unlock,
              "screens": cond_screens, "supply_above": cond_supply_above, "card_near_supply": cond_card_near}
# A detector whose relevant facts are only noise until its condition holds (a tick on a processor is
# not yet evidence that it restarts by itself).
NO_PARTIAL = ("tick_reset",)


def detect(det: dict, ctx: Context) -> str:
    kind = det["type"]
    if kind == "manual":
        return "open"
    if kind in ("any", "all"):
        ranks = [STATUSES.index(detect(d, ctx)) for d in det["of"]]
        if kind == "any" or min(ranks) == max(ranks):
            return STATUSES[max(ranks)]
        return "evidence" if max(ranks) > 0 else "open"  # all: some parts captured, not every one answered
    if kind == "unverified_cards":
        rows = ctx.unverified or []
        if not rows:
            return "open"
        if all(r.get("confirmed") for r in rows):
            return "answered"
        return "evidence" if any(r.get("confirmed") or r.get("partial") for r in rows) else "open"
    facts = relevant(det, ctx)
    condition = CONDITIONS[kind]
    if condition([f for f in facts if ctx.tested(f)], det, ctx):
        return "answered"
    if condition(facts, det, ctx) or (facts and kind not in NO_PARTIAL):
        return "evidence"
    return "open"


def status(question: dict, ctx: Context) -> str:
    if question.get("settled_by_doc"):
        return "answered"
    found = detect(question["detector"], ctx)
    if found == "answered" and question.get("settle") == "owner":
        return "evidence"  # captured; the answer needs your eye on the frames, then settled_by_doc
    return found


def evaluate(questions: list[dict], facts: list[dict], categories: dict[str, str] | None = None,
             unverified: list[dict] | None = None, kinds: dict | None = None) -> list[dict]:
    """Each question with its "status" added. `facts` are every fact of the log (classic and new),
    `categories` {facility: category}, `unverified` verify_data.confirmed_unverified's rows, `kinds`
    the spec table (read_screenshots.SCREEN_KINDS by default) for the tested flags."""
    ctx = Context(facts, categories, unverified, kinds)
    return [{**q, "status": status(q, ctx)} for q in questions]


if __name__ == "__main__":
    import verify_data
    sys.exit(verify_data.main(["--questions", *sys.argv[1:]]))

#!/usr/bin/env python3
"""Read my homeland state from game screenshots with a local Ollama vision model.

Nothing leaves this PC: images go to the Ollama server on localhost and the result is a JSON file
the site can load ("Load screenshot reading" in the Profile box), which always shows a diff to
confirm before anything is applied. The screenshots folder is gitignored.

Screens are told apart by the file name's prefix (see SCREEN_KINDS):
  rv-*.png         the Homeland / RV level screen (RV level, Home Coins)
  facility-*.png   one facility's panel (its name, how many you have, their level)
  modules-*.png    the upgrade modules screen (four module levels)
  aniimo-*.png     the Aniimo roster (name, abilities with levels, personalities)
  stock-*.png      storage / inventory (item amounts, mainly level-up materials)
Anything else is described but not merged into the setup.

Usage (from the repository root, with Ollama running):
  python scripts/read_screenshots.py                       read screenshots/*.png, write screenshots/reading.json
  python scripts/read_screenshots.py --model qwen2.5vl:7b  pick the vision model
  python scripts/read_screenshots.py --expected screenshots/expected.json
                                                           also score accuracy against hand-checked values
  python scripts/read_screenshots.py --check               just confirm Ollama answers and the model is there
Standard library + Pillow (only to downscale big images). Keys, hosts and files are all local.
"""
from __future__ import annotations

import argparse
import base64
import difflib
import io
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

DEFAULT_HOST = "http://localhost:11434"
DEFAULT_MODEL = "qwen2.5vl:7b"
READING_FORMAT = "aniimax-screenshot-reading"
READING_VERSION = 1
MAX_SIDE = 1600  # px; game screenshots are 4K-ish, the model does not need that
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}

MODULES = ["ecological_module", "kitchen_module", "resource_detector", "crafting_module"]
ABILITIES = ["Grass", "Fire", "Water", "Earth", "Wind", "Light", "Dark", "Ice", "Electric"]

SCREEN_KINDS = {
    "rv": {
        "prompt": "This is a screenshot from the game Aniimo that states the RV level as text (for example 'RV Lv.12' or 'RV Level 12'). Read the RV level, and the Home Coins amount if a coin icon with a number is shown: copy that number exactly as written, keeping its spaces (for example '220 724'). Use null for anything not written on screen; never guess.",
        "schema": {"type": "object", "properties": {"rv": {"type": ["integer", "null"]}, "coins": {"type": ["string", "null"]}}, "required": ["rv", "coins"]},
    },
    "home": {
        "prompt": "This is the Home Management screen of the game Aniimo: a green grid of white plot tiles with facility icons. Read only the Home Coins amount shown at the top right next to a coin icon: copy that number exactly as written, keeping its spaces (for example '220 724'). Use null if no such number is visible.",
        "schema": {"type": "object", "properties": {"coins": {"type": ["string", "null"]}}, "required": ["coins"]},
    },
    "facility": {
        "prompt": "This is the Home Management screen of the game Aniimo with a facility's side panel open on the right. The panel's heading is the facility name followed by its level in brackets, for example 'Chimney Kiln (Level 2)'. Read the name exactly as written and the level from that heading only. The game does not show how many of the facility are owned, so count is always null. If no such heading is visible, answer null for everything.",
        "schema": {"type": "object", "properties": {"facility": {"type": ["string", "null"]}, "count": {"type": ["integer", "null"]}, "level": {"type": ["integer", "null"]}}, "required": ["facility", "count", "level"]},
    },
    "modules": {
        "prompt": "This is a screenshot of the upgrade modules screen in the game Aniimo. Read the level of each module: Ecological Module, Kitchen Module, Resource Detector, Crafting Module. Use null for a module not visible.",
        "schema": {"type": "object", "properties": {m: {"type": ["integer", "null"]} for m in MODULES}, "required": MODULES},
    },
    "aniimo": {
        "prompt": "This is a screenshot from the game Aniimo that may show the Aniimo roster: a list of the player's Aniimo with each name written as text. For every Aniimo whose name is written, read the name, the abilities whose names and levels are written next to it (ability names are among: " + ", ".join(ABILITIES) + "), and its personality words if written. Copy only what is written on screen; never invent an Aniimo, an ability or a level. If no list of named Aniimo is visible, answer with an empty list.",
        "schema": {"type": "object", "properties": {"aniimo": {"type": "array", "items": {"type": "object", "properties": {
            "name": {"type": "string"},
            "abilities": {"type": "array", "items": {"type": "object", "properties": {"ability": {"type": "string"}, "level": {"type": "integer"}}, "required": ["ability", "level"]}},
            "personalities": {"type": "array", "items": {"type": "string"}},
        }, "required": ["name", "abilities", "personalities"]}}}, "required": ["aniimo"]},
    },
    "stock": {
        "prompt": "Look for an item information card in this screenshot from the game Aniimo. If there is one, give the item name shown as the card's title and the numbers shown after 'Inventory:' and 'Homeland:' (or after 'Owned' in a shop); use null for a number that is not shown. Icons with numbers but no written name are not items. If there is no such card, answer with an empty list.",
        "schema": {"type": "object", "properties": {"items": {"type": "array", "items": {"type": "object", "properties": {
            "name": {"type": "string"}, "inventory": {"type": ["integer", "null"]}, "homeland": {"type": ["integer", "null"]}, "owned": {"type": ["integer", "null"]}},
            "required": ["name", "inventory", "homeland", "owned"]}}}, "required": ["items"]},
    },
    "unknown": {
        "prompt": "This is a screenshot from the game Aniimo. In one sentence, say what screen it shows and list any numbers with their labels.",
        "schema": {"type": "object", "properties": {"description": {"type": "string"}}, "required": ["description"]},
    },
}


def screen_kind(path: Path) -> str:
    prefix = path.stem.split("-", 1)[0].lower()
    return prefix if prefix in SCREEN_KINDS and prefix != "unknown" else "unknown"


# --- names known to the site, for mapping what the model read ----------------------------------

def known_names(root: Path) -> dict:
    config = (root / "web" / "facility-config.js").read_text(encoding="utf-8") if (root / "web" / "facility-config.js").exists() else ""
    facilities = re.findall(r"name: '([^']+)'", config)
    # Items: every recipe and ingredient in the CSVs, plus the level-up materials (byproducts such
    # as wood_block appear only as ingredients and in LEVEL_UP_COSTS).
    items = set(re.findall(r"\['([a-z0-9_]+)', \d+\]", config))
    for csv in (root / "data").glob("*.csv"):
        lines = csv.read_text(encoding="utf-8").splitlines()
        if not lines:
            continue
        header = [h.strip() for h in lines[0].split(",")]
        columns = [i for i, h in enumerate(header) if h in ("name", "raw_materials")]
        for line in lines[1:]:
            cells = [c.strip() for c in line.split(",")]
            for i in columns:
                if i < len(cells):
                    for token in re.split(r"[;+|& ]+", cells[i]):
                        if token and re.fullmatch(r"[a-z0-9_]+", token):
                            items.add(token)
    return {"facilities": sorted(set(facilities)), "items": sorted(items)}


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(text).lower()).strip("_")


def match_name(text, candidates: list[str], notes: list[str], what: str):
    """Closest known name for what the model read, or None (with a note) when nothing is close."""
    if not text:
        return None
    wanted = slug(text)
    by_slug = {slug(c): c for c in candidates}
    if wanted in by_slug:
        return by_slug[wanted]
    close = difflib.get_close_matches(wanted, list(by_slug), n=1, cutoff=0.75)
    if close:
        notes.append(f"{what}: read '{text}', taken as '{by_slug[close[0]]}'")
        return by_slug[close[0]]
    notes.append(f"{what}: read '{text}', which matches nothing the site knows; left out")
    return None


# --- Ollama ----------------------------------------------------------------------------

def image_payload(path: Path) -> str:
    data = path.read_bytes()
    try:
        from PIL import Image  # optional: only to shrink big screenshots
        with Image.open(io.BytesIO(data)) as im:
            if max(im.size) > MAX_SIDE:
                im.thumbnail((MAX_SIDE, MAX_SIDE))
                out = io.BytesIO()
                im.convert("RGB").save(out, format="PNG")
                data = out.getvalue()
    except Exception:  # no Pillow, or a file Pillow cannot open: send it as it is
        pass
    return base64.b64encode(data).decode("ascii")


def post_json(url: str, body: dict, timeout: float):
    request = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def get_json(url: str, timeout: float):
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def ask_model(host: str, model: str, prompt: str, schema: dict, image_b64: str, timeout: float = 300, keep_alive: str | None = None) -> dict:
    body = {
        "model": model,
        "messages": [{"role": "user", "content": prompt, "images": [image_b64]}],
        "format": schema,
        "stream": False,
        "options": {"temperature": 0, "num_predict": 4096},  # enough tokens for a long roster or storage list
    }
    if keep_alive:
        body["keep_alive"] = keep_alive  # how long Ollama keeps the model loaded after this call
    answer = post_json(f"{host}/api/chat", body, timeout)
    content = answer.get("message", {}).get("content", "")
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        error = ValueError(f"the model did not answer with JSON: {content[:200]!r}")
        error.content = content  # the whole answer, for a debugging file
        raise error from None


def check_server(host: str, model: str) -> str:
    try:
        tags = get_json(f"{host}/api/tags", 10)
    except (urllib.error.URLError, OSError) as e:
        raise SystemExit(f"Ollama is not answering at {host} ({e}). Start Ollama first.") from None
    names = [m.get("name", "") for m in tags.get("models", [])]
    if model not in names and f"{model}:latest" not in names:
        raise SystemExit(f"Model '{model}' is not pulled. Models here: {', '.join(names) or 'none'}. Pull one with `ollama pull {model}` (ask first).")
    return f"Ollama at {host} has {model}; {len(names)} models in all."


# --- merging what was read into a partial setup --------------------------------------------------

def count_from(value) -> int | None:
    """A whole number from what the model read: an int, or a string such as '220 724' or '29,698,282'."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        digits = re.sub(r"[^0-9]", "", value)
        return int(digits) if digits else None
    return None


def merge_screens(screens: list[dict], names: dict) -> tuple[dict, dict, list[str]]:
    setup: dict = {}
    actual: dict = {}
    notes: list[str] = []
    for screen in screens:
        fields = screen.get("fields") or {}
        kind = screen.get("kind")
        if screen.get("error"):
            continue
        if kind in ("rv", "home"):
            if isinstance(fields.get("rv"), int) and fields["rv"] >= 1:
                setup["home-level"] = str(fields["rv"])
                actual["rv"] = fields["rv"]
            coins = count_from(fields.get("coins"))
            if coins is not None and coins >= 0:
                actual["coins"] = coins
        elif kind == "facility":
            facility = match_name(fields.get("facility"), names["facilities"], notes, f"{screen['file']} facility")
            count, level = fields.get("count"), fields.get("level")
            if facility and (count is None or (isinstance(count, int) and count >= 0)):
                # count None: the game's panel shows the level only; the site keeps the count it already has
                tiers = setup.setdefault("facilityTiers", {}).setdefault(facility, [])
                tiers.append({"count": count, "level": level if isinstance(level, int) and level >= 1 else 1})
        elif kind == "modules":
            for module in MODULES:
                value = fields.get(module)
                if isinstance(value, int) and value >= 0:
                    setup[f"{module.replace('_', '-')}-level"] = str(value)
        elif kind == "aniimo":
            roster = setup.setdefault("roster", [])
            for entry in fields.get("aniimo") or []:
                abilities = {}
                for a in entry.get("abilities") or []:
                    ability = match_name(a.get("ability"), ABILITIES, notes, f"{screen['file']} ability")
                    if ability and isinstance(a.get("level"), int) and 1 <= a["level"] <= 4:
                        abilities[ability] = a["level"]
                if abilities:
                    roster.append({"name": str(entry.get("name") or ""), "count": 1, "abilities": abilities,
                                   "personalities": [str(p) for p in entry.get("personalities") or []]})
        elif kind == "stock":
            stock = setup.setdefault("levelUpStock", {})
            for item in fields.get("items") or []:
                name = match_name(item.get("name"), names["items"], notes, f"{screen['file']} item")
                amount = item.get("amount")
                if amount is None:  # the detail card's Homeland count first (what the homeland can use), else the others
                    amount = next((item.get(k) for k in ("homeland", "inventory", "owned") if isinstance(item.get(k), int)), None)
                if name and isinstance(amount, int) and amount >= 0:
                    stock[name] = amount
    return setup, actual, notes


# --- accuracy against hand-checked values ---------------------------------------------------------

def flatten(value, prefix=""):
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            out.update(flatten(v, f"{prefix}{k}."))
        return out
    if isinstance(value, list):
        out = {}
        for i, v in enumerate(value):
            out.update(flatten(v, f"{prefix}{i}."))
        return out
    return {prefix.rstrip("."): value}


def score(screens: list[dict], expected: dict) -> list[dict]:
    rows = []
    for screen in screens:
        want = expected.get(screen["file"])
        if want is None:
            continue
        got = flatten(screen.get("fields") or {})
        wanted = flatten(want)
        correct = sum(1 for k, v in wanted.items() if got.get(k) == v or (isinstance(v, str) and isinstance(got.get(k), str) and slug(v) == slug(got[k])))
        rows.append({"file": screen["file"], "correct": correct, "total": len(wanted), "seconds": screen.get("seconds", 0),
                     "wrong": {k: (got.get(k), v) for k, v in wanted.items() if got.get(k) != v and not (isinstance(v, str) and isinstance(got.get(k), str) and slug(v) == slug(got[k]))}})
    return rows


# --- main ----------------------------------------------------------------------------------

def read_all(paths: list[Path], host: str, model: str, ask=ask_model) -> list[dict]:
    screens = []
    for path in paths:
        kind = screen_kind(path)
        spec = SCREEN_KINDS[kind]
        started = time.time()
        entry = {"file": path.name, "kind": kind, "fields": None, "seconds": 0.0}
        try:
            entry["fields"] = ask(host, model, spec["prompt"], spec["schema"], image_payload(path))
        except (urllib.error.URLError, OSError, ValueError) as e:
            entry["error"] = str(e)
        entry["seconds"] = round(time.time() - started, 1)
        screens.append(entry)
        status = "error: " + entry["error"] if entry.get("error") else json.dumps(entry["fields"])[:100]
        print(f"{path.name} [{kind}] {entry['seconds']}s: {status}")
    return screens


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--dir", type=Path, help="screenshots folder (default: <root>/screenshots)")
    parser.add_argument("--out", type=Path, help="where to write the reading (default: <dir>/reading.json)")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--expected", type=Path, help="JSON of hand-checked values per file, to score accuracy")
    parser.add_argument("--check", action="store_true", help="only check that Ollama and the model are available")
    args = parser.parse_args(argv)

    print(check_server(args.host, args.model))
    if args.check:
        return 0
    folder = args.dir or (args.root / "screenshots")
    paths = sorted(p for p in folder.glob("*") if p.suffix.lower() in IMAGE_SUFFIXES)
    if not paths:
        print(f"No images in {folder}. Put your game screenshots there (see docs/runbooks/screenshots.md).")
        return 1
    screens = read_all(paths, args.host, args.model)
    setup, actual, notes = merge_screens(screens, known_names(args.root))
    reading = {
        "format": READING_FORMAT, "version": READING_VERSION,
        "readAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "model": args.model,
        "screens": screens, "setup": setup, "actual": actual, "notes": notes,
    }
    out = args.out or (folder / "reading.json")
    out.write_text(json.dumps(reading, indent=2), encoding="utf-8")
    errors = sum(1 for s in screens if s.get("error"))
    print(f"\nRead {len(screens)} screenshots ({errors} failed) in {sum(s['seconds'] for s in screens):.0f}s; wrote {out}")
    for note in notes:
        print(f"note: {note}")
    if args.expected:
        expected = json.loads(args.expected.read_text(encoding="utf-8"))
        rows = score(screens, expected)
        correct = sum(r["correct"] for r in rows)
        total = sum(r["total"] for r in rows)
        print(f"\nAccuracy against {args.expected.name}: {correct}/{total} fields" + (f" ({correct / total:.0%})" if total else ""))
        for r in rows:
            print(f"  {r['file']}: {r['correct']}/{r['total']} in {r['seconds']}s" + (f"; wrong: {r['wrong']}" if r["wrong"] else ""))
    print("Next: on the site, Profile details -> Load screenshot reading, and confirm the diff.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

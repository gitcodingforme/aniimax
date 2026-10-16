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
  item_card-*.png  an item's information card on its own (facility, level, time, environment), used to
                   measure that reading; stock and facility frames read any open card as `card` too
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


def crop_box(size: tuple, crop) -> tuple:
    """Pixel box for a crop given as (left, top, right, bottom) fractions of the frame, or as a function
    of (width, height) returning a pixel box."""
    w, h = size
    if callable(crop):
        return tuple(int(v) for v in crop(w, h))
    return (int(w * crop[0]), int(h * crop[1]), int(w * crop[2]), int(h * crop[3]))


def panel_crop(w: int, h: int) -> tuple:
    """The facility side panel: anchored to the right edge and sized with the window height (about
    0.52 of it wide at 3440x1440), so the crop is measured from the height, not the width, and keeps
    the heading on a 16:9 window too. The coins at the top right come with it."""
    return (max(0, w - int(0.72 * h)), 0, w, h)


def card_crop(w: int, h: int) -> tuple:
    """An item's information card: a tall card left of the facility panel. On the saved 3440x1440
    frames the cards sit between 0.50 and 0.79 of the width, so the crop runs from 1.30 to 0.45 window
    heights left of the right edge (measured from the height, like panel_crop) and is sent at full
    detail; it is about 1224x1440 there, under MAX_SIDE, so nothing is shrunk."""
    return (max(0, w - int(1.30 * h)), 0, max(1, w - int(0.45 * h)), h)


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
        "prompt": "This is the Home Management screen of the game Aniimo with a facility's side panel open on the right. The panel's heading is the facility name followed by its level in brackets, for example 'Chimney Kiln (Level 2)'. Read the name exactly as written and the level from that heading only. The game does not show how many of the facility are owned, so count is always null. Also read the Home Coins amount at the top right next to a coin icon, copied exactly as written, keeping its spaces; null if not visible. If no such heading is visible, answer null for the facility, count and level.",
        "schema": {"type": "object", "properties": {"facility": {"type": ["string", "null"]}, "count": {"type": ["integer", "null"]}, "level": {"type": ["integer", "null"]}, "coins": {"type": ["string", "null"]}}, "required": ["facility", "count", "level", "coins"]},
    },
    "facility_detail": {
        "prompt": "This is the Home Management screen of the game Aniimo with a facility's side panel open on the right. Read only text that is written in that panel; never guess. facility: the name in the panel heading, written before the level in brackets (for example 'Chimney Kiln (Level 2)'), and level: the number after 'Level' in that heading. tab: the selected tab at the top of the panel, one of 'Formula', 'Details', 'Manage', 'Level Up'. recipe_status: what the large box at the top of the panel says: 'set' when a recipe name and a clock time are written there, 'not set' when it says 'Recipe not set', 'power' when it says 'Provides Power', 'none' when there is no such box. recipe: only when recipe_status is 'set', the recipe name written in that box; otherwise null. recipe_time: only when recipe_status is 'set', the time written next to the clock icon in that box, exactly as written (for example '2s' or '1m 19s'); otherwise null. The 'Season Recipe' bar with a countdown is not the recipe box. recipes_per_level: for every blue heading 'Level N Facility' visible in the panel, the number of recipe icons shown directly under it (count the icons, do not name them; leave out a heading whose icons are cut off). coins: the Home Coins number at the top right of the screen next to a coin icon, copied exactly as written keeping its spaces, or null. If no facility panel is open, answer 'none' for recipe_status, null for facility, level, tab, recipe and recipe_time, and an empty list for recipes_per_level.",
        "schema": {"type": "object", "properties": {
            "facility": {"type": ["string", "null"]}, "level": {"type": ["integer", "null"]}, "tab": {"type": ["string", "null"]},
            "recipe_status": {"type": "string", "enum": ["set", "not set", "power", "none"]},
            "recipe": {"type": ["string", "null"]}, "recipe_time": {"type": ["string", "null"]},
            "recipes_per_level": {"type": "array", "items": {"type": "object", "properties": {"level": {"type": "integer"}, "count": {"type": "integer"}}, "required": ["level", "count"]}},
            "coins": {"type": ["string", "null"]},
        }, "required": ["facility", "level", "tab", "recipe_status", "recipe", "recipe_time", "recipes_per_level", "coins"]},
        "crop": panel_crop,  # the side panel and the coins, at full detail
        "also": {"card": "item_card"},  # an item card can be open beside the panel; read under `card`
        # A second, smaller question for the same frame: asked together with the rest, the model
        # skipped the grey upgrade line every time (0 of 13 on real frames); asked alone it read it
        # every time. Its answer is merged into the fields under `upgrade_notes`.
        "follow_up": {
            "field": "upgrade_note",
            # One object, not a list: asked for a list, the 7b model answers an empty one every time.
            "prompt": "Somewhere in this part of a game screen there may be a grey line of small text that reads 'Facilities can be upgraded to Lv.N once the RV reaches Lv.M' with two numbers. Give N as facility_level and M as rv_level, or null for a number that is not visible or cut off. Both null if there is no such line.",
            "schema": {"type": "object", "properties": {"facility_level": {"type": ["integer", "null"]}, "rv_level": {"type": ["integer", "null"]}}, "required": ["facility_level", "rv_level"]},
            "crop": panel_crop,
        },
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
        "also": {"card": "item_card"},  # the same card's facility, level and time, read on a full-detail crop
    },
    # An item's information card (opened by clicking an item on the Home Management screen) states the
    # facility and level that make it, its base time and, for a crop, its recommended environment: the
    # production_time, facility_level and environment columns of data/*.csv, read straight off the screen.
    # Read on its own for files named item_card-*.png (to measure it), and as `card` of a stock or
    # facility frame. One card per answer (asked for a list, the 7b model answers an empty one); a second
    # card half hidden behind the first is a follow-up question, merged under `behind`.
    "item_card": {
        "prompt": "This part of a screenshot from the game Aniimo may show an item information card: a tall card whose coloured top holds the item name as its title with 'Home materials' under it, then 'Inventory:' and 'Homeland:' counts, a 'Unit Price' line, then a facility line such as 'Farmland (Level 4)' or 'Simmering Pot (Level 1)' above ingredient icons, under the icons one line that reads either 'Time' with a clock and a duration or 'Workload' with a number, and sometimes a 'Recommended Environment' line. The white facility side panel at the right edge of the screen (headed 'Name (Level N)' with the tabs Formula, Manage, Level Up, a 'Season Recipe' bar and 'Level N Facility' headings) is NOT an item card: ignore it, and if no item card is open answer null for everything. An item card's title is an item (a crop, a material, a food, a product), never a facility name. If two cards overlap, read only the card in FRONT: the one whose title and coloured top are completely visible (the card behind shows only part of its title). Take every field from that one card, each line directly under that card's own title; never from the one partly covered. Read only text written on that card; never guess. item: the title. facility: the name written before '(Level N)' on the facility line. facility_level: that N. time: when the line under the icons says 'Time', the duration written after it exactly as written (for example '1m 48s' or '54s'); null when that line says 'Workload'. workload: when that line says 'Workload', the number written after it; null when it says 'Time'. environment: the single word written at the right end of the 'Recommended Environment' line, or null when the card has no line with those words ('Provides Energy', 'How to Obtain' and 'Home Processing' are other lines, not it).",
        "schema": {"type": "object", "properties": {
            "item": {"type": ["string", "null"]}, "facility": {"type": ["string", "null"]}, "facility_level": {"type": ["integer", "null"]},
            "time": {"type": ["string", "null"]}, "workload": {"type": ["integer", "null"]}, "environment": {"type": ["string", "null"]},
        }, "required": ["item", "facility", "facility_level", "time", "workload", "environment"]},
        "crop": card_crop,
        "key_field": "item",  # as `card` of another screen, the answer counts only when this is written
        "validate": "card",   # validate_card, on the answer and on the follow-up's answer
        "gate": "card",       # card_present: the model is only asked when a card's header is in the strip
        "follow_up": {
            "field": "behind",
            "prompt": "This part of a game screen may show TWO overlapping item information cards (tall cards with an item name as title, 'Inventory:' and 'Homeland:' counts, a 'Unit Price' line and a facility line such as 'Simmering Pot (Level 2)'), one partly hidden behind the other. Only if there really are two cards, read the card BEHIND, the partly covered one: item, the visible part of its title; facility, the facility name on its facility line; facility_level, the N in '(Level N)' there; time, the text after 'Time' on it exactly as written. If there is only one card, or none, answer null for everything.",
            "schema": {"type": "object", "properties": {
                "item": {"type": ["string", "null"]}, "facility": {"type": ["string", "null"]}, "facility_level": {"type": ["integer", "null"]}, "time": {"type": ["string", "null"]},
            }, "required": ["item", "facility", "facility_level", "time"]},
            "crop": card_crop,
        },
    },
    "unknown": {
        "prompt": "This is a screenshot from the game Aniimo. In one sentence, say what screen it shows and list any numbers with their labels.",
        "schema": {"type": "object", "properties": {"description": {"type": "string"}}, "required": ["description"]},
    },
}

# A facility panel is always read the detailed way (crop, status, second question for the grey line);
# the plain "facility" prompt it replaces lives on only as this alias, so file names and the merge
# keep working.
SCREEN_KINDS["facility"] = SCREEN_KINDS["facility_detail"]


def screen_kind(path: Path) -> str:
    prefix = path.stem.split("-", 1)[0].lower()
    if prefix == "item" and path.stem.lower().startswith("item_card-"):
        return "item_card"
    return prefix if prefix in SCREEN_KINDS and prefix != "unknown" else "unknown"


# --- names known to the site, for mapping what the model read ----------------------------------

def known_names(root: Path) -> dict:
    config = (root / "web" / "facility-config.js").read_text(encoding="utf-8") if (root / "web" / "facility-config.js").exists() else ""
    # Only the FACILITIES entries (name followed by slug), not the festival, special recipes or notes.
    facilities = re.findall(r"name: '([^']+)',\s*slug: '", config)
    # Items: every recipe and ingredient in the CSVs, plus the level-up materials (byproducts such
    # as wood_block appear only as ingredients and in LEVEL_UP_COSTS).
    items = set(re.findall(r"\['([a-z0-9_]+)', \d+\]", config))
    environments = set()  # the growing environments the data names (Cool, Warm, ...), to check an item card's line
    for csv in (root / "data").glob("*.csv"):
        lines = csv.read_text(encoding="utf-8").splitlines()
        if not lines:
            continue
        header = [h.strip() for h in lines[0].split(",")]
        columns = [i for i, h in enumerate(header) if h in ("name", "raw_materials")]
        env_column = header.index("environment") if "environment" in header else None
        for line in lines[1:]:
            if line.lstrip().startswith("#"):
                continue
            cells = [c.strip() for c in line.split(",")]
            for i in columns:
                if i < len(cells):
                    for token in re.split(r"[;+|& ]+", cells[i]):
                        if token and re.fullmatch(r"[a-z0-9_]+", token):
                            items.add(token)
            if env_column is not None and env_column < len(cells) and cells[env_column]:
                environments.add(cells[env_column])
    return {"facilities": sorted(set(facilities)), "items": sorted(items), "environments": sorted(environments)}


def validate_card(fields: dict, names: dict) -> dict:
    """Deterministic checks on an item card reading, because the 7b model reads the facility side
    panel as a card when none is open (its 'item' is then a facility name, with an invented time) and
    copies stray words ('Home Processing') into environment. A title that is a facility name means no
    card: everything becomes null. An environment the data does not know becomes null."""
    if not isinstance(fields, dict):
        return fields
    out = dict(fields)
    item = out.get("item")
    if isinstance(item, str) and slug(item) in {slug(f) for f in names.get("facilities", [])}:
        out = {k: None for k in out}
    env = out.get("environment")
    if "environment" in out and isinstance(env, str) and slug(env) not in {slug(e) for e in names.get("environments", [])}:
        out["environment"] = None
    # A card shows either a Time or a Workload line, never both: a workload next to a time is another
    # number from the card (the 'Provides Energy 45280' line, seen 2026-10-15), so it is dropped.
    if out.get("time") and out.get("workload") is not None:
        out["workload"] = None
    return out


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

def image_payload(path: Path, crop=None) -> str:
    """The image as base64, shrunk to MAX_SIDE. `crop` (see crop_box) is the part of the screen to send
    at full detail, e.g. the side panel, so small text such as the facility panel's grey upgrade
    line is not lost in the shrink."""
    data = path.read_bytes()
    try:
        from PIL import Image  # optional: only to shrink big screenshots
        with Image.open(io.BytesIO(data)) as im:
            if crop:
                im = im.crop(crop_box(im.size, crop))
            if crop or max(im.size) > MAX_SIDE:
                im.thumbnail((MAX_SIDE, MAX_SIDE))
                out = io.BytesIO()
                im.convert("RGB").save(out, format="PNG")
                data = out.getvalue()
    except Exception:  # no Pillow, or a file Pillow cannot open: send it as it is
        pass
    return base64.b64encode(data).decode("ascii")


def open_image(path: Path):
    """The frame as a Pillow image for the gates, or None without Pillow (the model is then always asked)."""
    try:
        from PIL import Image
        with Image.open(path) as im:
            return im.convert("RGB")
    except Exception:
        return None


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
        if kind in ("rv", "home", "facility"):
            if isinstance(fields.get("rv"), int) and fields["rv"] >= 1:
                setup["home-level"] = str(fields["rv"])
                actual["rv"] = fields["rv"]
            coins = count_from(fields.get("coins"))
            if coins is not None and coins >= 0:
                actual["coins"] = coins
        if kind == "facility":
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

def attach_follow_up(fields: dict, follow: dict, answer) -> None:
    """Merge a follow-up answer into the first reading under follow["field"]. The note is kept only
    when it carries a number; "no such line" (all null, or an empty answer) becomes None."""
    answer = answer if isinstance(answer, dict) else {}
    fields[follow["field"]] = answer if any(isinstance(v, int) and not isinstance(v, bool) for v in answer.values()) else None


ASK_ERRORS = (urllib.error.URLError, OSError, ValueError)


VALIDATORS = {"card": validate_card}

CARD_HEADER = (400, 180, 0.4)  # width, height (px) and fill a card's coloured header block must reach
GATE_BLOCK = 8                 # the detector works on 8x8 blocks of the crop


def card_present(crop) -> bool:
    """Is an item card open in this (Pillow) image of the card strip? Looked for without the model:
    the card's top is a block of saturated colour (blue, purple or orange, never the grid's green)
    about 530x260 px on a 3440x1440 window, and nothing else in that strip comes close (measured on
    the 61 saved frames on 2026-10-15: the nine cards gave blocks of at least 528x256 px, the rest at
    most 408x8 or 112x232). The model otherwise invents a card from a tile or the side panel."""
    from collections import deque
    w, h = crop.size
    sw, sh = max(1, w // GATE_BLOCK), max(1, h // GATE_BLOCK)
    px = crop.convert("HSV").resize((sw, sh)).load()
    on = [[(lambda hue, sat, val: sat > 110 and val > 120 and not 50 <= hue <= 115)(*px[x, y][:3]) for x in range(sw)] for y in range(sh)]
    seen = [[False] * sw for _ in range(sh)]
    min_w, min_h, min_fill = CARD_HEADER
    for y in range(sh):
        for x in range(sw):
            if not on[y][x] or seen[y][x]:
                continue
            queue, cells = deque([(x, y)]), []
            seen[y][x] = True
            while queue:
                cx, cy = queue.popleft()
                cells.append((cx, cy))
                for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                    if 0 <= nx < sw and 0 <= ny < sh and on[ny][nx] and not seen[ny][nx]:
                        seen[ny][nx] = True
                        queue.append((nx, ny))
            xs, ys = [c[0] for c in cells], [c[1] for c in cells]
            bw, bh = (max(xs) - min(xs) + 1) * GATE_BLOCK, (max(ys) - min(ys) + 1) * GATE_BLOCK
            if bw >= min_w and bh >= min_h and len(cells) * GATE_BLOCK * GATE_BLOCK >= min_fill * bw * bh:
                return True
    return False


GATES = {"card": card_present}


def empty_answer(spec: dict) -> dict:
    """All-null fields for a kind (what the model would answer when nothing is there)."""
    fields = {k: None for k in spec["schema"].get("properties", {})}
    if spec.get("follow_up"):
        fields[spec["follow_up"]["field"]] = None
    return fields


def read_spec(spec: dict, ask, payload, names: dict | None = None, image=None) -> tuple[dict, dict]:
    """One screen kind on one frame: the main question, its follow-up (merged under the follow-up's
    field) and the extra kinds in `also` ({field: kind}), each read the same way on its own crop and
    merged under its field (None when its key_field is not written, e.g. no item card is open).
    `ask(prompt, schema, image_b64)` asks the model; `payload(crop)` gives the frame (or that part of
    it) as base64; `names` (known_names) feeds the kind's validator, if it has one; `image` (the
    frame as a Pillow image, when Pillow is there) lets a kind's gate look for its subject first and
    skip the model when it is absent. Returns (fields, errors): a failed side question costs only its
    field and is listed in errors by that field; a failed main question raises."""
    gate = GATES.get(spec.get("gate")) if image is not None else None
    if gate and not gate(image.crop(crop_box(image.size, spec["crop"])) if spec.get("crop") else image):
        return empty_answer(spec), {}
    check = VALIDATORS.get(spec.get("validate")) if names else None
    clean = (lambda a: check(unnull(a), names)) if check else unnull
    fields = clean(ask(spec["prompt"], spec["schema"], payload(spec.get("crop"))))
    errors: dict = {}
    if not isinstance(fields, dict):
        return fields, errors
    follow = spec.get("follow_up")
    if follow and key_present(spec, fields):  # no card read: no point asking about a second one
        try:
            answer = clean(ask(follow["prompt"], follow["schema"], payload(follow.get("crop"))))
        except ASK_ERRORS as e:
            answer, errors[follow["field"]] = None, str(e)
        attach_follow_up(fields, follow, answer)
    elif follow:
        fields[follow["field"]] = None
    for field, kind in (spec.get("also") or {}).items():
        extra_spec = SCREEN_KINDS[kind]
        try:
            extra, more = read_spec(extra_spec, ask, payload, names, image)
        except ASK_ERRORS as e:
            extra, more = None, {field: str(e)}
        errors.update(more)
        fields[field] = extra if isinstance(extra, dict) and key_present(extra_spec, extra) else None
    return fields, errors


def unnull(answer):
    """The model sometimes writes the word 'null' as a string ("time": "null"); that means null."""
    if isinstance(answer, dict):
        return {k: (None if isinstance(v, str) and v.strip().lower() in ("null", "none") else v) for k, v in answer.items()}
    return answer


def key_present(spec: dict, fields: dict) -> bool:
    """Did the model read the thing this kind is about? True when the kind has no key_field, else when
    that field holds written text (an item card's title, for example)."""
    key = spec.get("key_field")
    return not key or bool(isinstance(fields.get(key), str) and fields[key].strip())


def read_all(paths: list[Path], host: str, model: str, ask=ask_model, names: dict | None = None) -> list[dict]:
    screens = []
    for path in paths:
        kind = screen_kind(path)
        spec = SCREEN_KINDS[kind]
        started = time.time()
        entry = {"file": path.name, "kind": kind, "fields": None, "seconds": 0.0}
        try:
            entry["fields"], errors = read_spec(spec, lambda p, s, b: ask(host, model, p, s, b), lambda crop: image_payload(path, crop), names, open_image(path))
            if errors:
                entry["follow_up_error"] = "; ".join(f"{k}: {v}" for k, v in errors.items())
        except ASK_ERRORS as e:
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
    names = known_names(args.root)
    screens = read_all(paths, args.host, args.model, names=names)
    setup, actual, notes = merge_screens(screens, names)
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

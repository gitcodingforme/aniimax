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
  level_up-*.png, pairs-*.png, manage-*.png, store-*.png, emode-*.png, food-*.png
                   a side question's screen on its own (Level Up tab, generator Details, Manage tab, a
                   plot's store, an E-mode switch, the Food tab), to measure those prompts; all are
                   "tested": False until they score 90% on 5 checked frames (see gate_report)
Anything else is described but not merged into the setup.

Usage (from the repository root, with Ollama running):
  python scripts/read_screenshots.py                       read screenshots/*.png, write screenshots/reading.json
  python scripts/read_screenshots.py --model qwen2.5vl:7b  pick the vision model
  python scripts/read_screenshots.py --expected screenshots/expected.json
                                                           also score accuracy against hand-checked values
                                                           (entries with "checked": true), per spec against the
                                                           gate (90% on at least 5 frames) for flipping "tested"
  python scripts/read_screenshots.py --dir screenshots/next-session --expected-skeleton screenshots/next-session/expected.json
                                                           write expected.json pre-filled with the model's answers,
                                                           every entry "checked": false, for you to correct
  python scripts/read_screenshots.py --check              just confirm Ollama answers and the model is there
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
# Facilities the game shows a panel for but the site does not model: the power generator (E-mode)
# and the Storage Unit. Their panels are logged as `panel` facts (watch_game.panel_facts).
AUX_FACILITIES = ["Crackle Generator", "Storage Unit"]
GROWER_CATEGORIES = ("Materials", "Aniimo Materials")  # plots and gatherers (web/facility-config.js categories)
PROCESSOR_CATEGORY = "Materials Processing"
EMODE_GATHERERS = ("Well", "Mine")  # the two gatherers with an E-mode row in data/overrides/emode_times.csv

# "tested": False marks a spec written without a real frame of its screen (INFERRED: what the
# prompt says about the screen is a guess from fan sources and the panels seen so far). Facts read
# with it carry "untested": true. A spec flips to tested after scoring at least 90% on at least 5
# hand-checked frames of its kind (read_screenshots.py --expected, see gate_report).
SCREEN_KINDS = {
    "rv": {
        # Never captured (the RV screen is one of the three screens no frame has shown), so untested;
        # title and next_rv_cost are INFERRED fields of that screen.
        "prompt": "This is a screenshot from the game Aniimo that states the RV level as text (for example 'RV Lv.12' or 'RV Level 12'). Read the RV level, and the Home Coins amount if a coin icon with a number is shown: copy that number exactly as written, keeping its spaces (for example '220 724'). title: the screen's title or heading text as written, or null. next_rv_cost: if the screen shows what the next RV level costs in Home Coins, that cost copied exactly as written keeping its spaces; null otherwise (the Home Coins balance is not a cost). Use null for anything not written on screen; never guess.",
        "schema": {"type": "object", "properties": {"rv": {"type": ["integer", "null"]}, "coins": {"type": ["string", "null"]},
                                                    "title": {"type": ["string", "null"]}, "next_rv_cost": {"type": ["string", "null"]}},
                   "required": ["rv", "coins"]},
        "rules": "rv",
        "also": {"pairs": "pairs"},
        "only_if": {"pairs": "rv_cost"},  # the requirement lines sit on the screen that shows the next cost (INFERRED)
        "tested": False,
    },
    "home": {
        "prompt": "This is the Home Management screen of the game Aniimo: a green grid of white plot tiles with facility icons. Read only the Home Coins amount shown at the top right next to a coin icon: copy that number exactly as written, keeping its spaces (for example '220 724'). Use null if no such number is visible.",
        "schema": {"type": "object", "properties": {"coins": {"type": ["string", "null"]}}, "required": ["coins"]},
        "tested": True,
    },
    "facility": {
        "prompt": "This is the Home Management screen of the game Aniimo with a facility's side panel open on the right. The panel's heading is the facility name followed by its level in brackets, for example 'Chimney Kiln (Level 2)'. Read the name exactly as written and the level from that heading only. The game does not show how many of the facility are owned, so count is always null. Also read the Home Coins amount at the top right next to a coin icon, copied exactly as written, keeping its spaces; null if not visible. If no such heading is visible, answer null for the facility, count and level.",
        "schema": {"type": "object", "properties": {"facility": {"type": ["string", "null"]}, "count": {"type": ["integer", "null"]}, "level": {"type": ["integer", "null"]}, "coins": {"type": ["string", "null"]}}, "required": ["facility", "count", "level", "coins"]},
    },
    "facility_detail": {
        "prompt": "This is the Home Management screen of the game Aniimo with a facility's side panel open on the right. Read only text that is written in that panel; never guess. facility: the name in the panel heading, written before the level in brackets (for example 'Chimney Kiln (Level 2)'), and level: the number after 'Level' in that heading. tab: the selected tab at the top of the panel, one of 'Formula', 'Details', 'Manage', 'Level Up', 'Food'. recipe_status: what the large box at the top of the panel says: 'set' when a recipe name and a clock time are written there, 'not set' when it says 'Recipe not set', 'power' when it says 'Provides Power', 'none' when there is no such box. recipe: only when recipe_status is 'set', the recipe name written in that box; otherwise null. recipe_time: only when recipe_status is 'set', the time written next to the clock icon in that box, exactly as written (for example '2s' or '1m 19s'); otherwise null. The 'Season Recipe' bar with a countdown is not the recipe box. recipes_per_level: for every blue heading 'Level N Facility' visible in the panel, the number of recipe icons shown directly under it (count the icons, do not name them; leave out a heading whose icons are cut off). coins: the Home Coins number at the top right of the screen next to a coin icon, copied exactly as written keeping its spaces, or null. If no facility panel is open, answer 'none' for recipe_status, null for facility, level, tab, recipe and recipe_time, and an empty list for recipes_per_level.",
        "schema": {"type": "object", "properties": {
            "facility": {"type": ["string", "null"]}, "level": {"type": ["integer", "null"]}, "tab": {"type": ["string", "null"]},
            "recipe_status": {"type": "string", "enum": ["set", "not set", "power", "none"]},
            "recipe": {"type": ["string", "null"]}, "recipe_time": {"type": ["string", "null"]},
            "recipes_per_level": {"type": "array", "items": {"type": "object", "properties": {"level": {"type": "integer"}, "count": {"type": "integer"}}, "required": ["level", "count"]}},
            "coins": {"type": ["string", "null"]},
        }, "required": ["facility", "level", "tab", "recipe_status", "recipe", "recipe_time", "recipes_per_level", "coins"]},
        "crop": panel_crop,  # the side panel and the coins, at full detail
        # An item card can be open beside the panel; read under `card`. The other side questions are
        # asked only on the tab or facility they are about (only_if, see ONLY_IF): an answer about a
        # tab that is not open would be invented.
        "also": {"card": "item_card", "level_up": "level_up", "pairs": "pairs", "manage": "manage",
                 "store": "store", "emode": "emode", "food": "food"},
        "only_if": {"level_up": "level_up_tab", "pairs": "aux_panel", "manage": "manage_tab",
                    "store": "grower_formula", "emode": "emode_manage", "food": "food_tab"},
        "tested": True,
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
        "tested": False,  # never captured: the modules screen is one of the three no frame has shown
    },
    "aniimo": {
        "prompt": "This is a screenshot from the game Aniimo that may show the Aniimo roster: a list of the player's Aniimo with each name written as text. For every Aniimo whose name is written, read the name, the abilities whose names and levels are written next to it (ability names are among: " + ", ".join(ABILITIES) + "), and its personality words if written. Copy only what is written on screen; never invent an Aniimo, an ability or a level. If no list of named Aniimo is visible, answer with an empty list.",
        "schema": {"type": "object", "properties": {"aniimo": {"type": "array", "items": {"type": "object", "properties": {
            "name": {"type": "string"},
            "abilities": {"type": "array", "items": {"type": "object", "properties": {"ability": {"type": "string"}, "level": {"type": "integer"}}, "required": ["ability", "level"]}},
            "personalities": {"type": "array", "items": {"type": "string"}},
        }, "required": ["name", "abilities", "personalities"]}}}, "required": ["aniimo"]},
        "tested": False,  # never captured: the roster is one of the three screens no frame has shown
    },
    "stock": {
        "prompt": "Look for an item information card in this screenshot from the game Aniimo. If there is one, give the item name shown as the card's title and the numbers shown after 'Inventory:' and 'Homeland:' (or after 'Owned' in a shop); use null for a number that is not shown. Icons with numbers but no written name are not items. If there is no such card, answer with an empty list.",
        "schema": {"type": "object", "properties": {"items": {"type": "array", "items": {"type": "object", "properties": {
            "name": {"type": "string"}, "inventory": {"type": ["integer", "null"]}, "homeland": {"type": ["integer", "null"]}, "owned": {"type": ["integer", "null"]}},
            "required": ["name", "inventory", "homeland", "owned"]}}}, "required": ["items"]},
        "also": {"card": "item_card"},  # the same card's facility, level and time, read on a full-detail crop
        "tested": True,
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
        "tested": True,
        "follow_up": {
            "field": "behind",
            "prompt": "This part of a game screen may show TWO overlapping item information cards (tall cards with an item name as title, 'Inventory:' and 'Homeland:' counts, a 'Unit Price' line and a facility line such as 'Simmering Pot (Level 2)'), one partly hidden behind the other. Only if there really are two cards, read the card BEHIND, the partly covered one: item, the visible part of its title; facility, the facility name on its facility line; facility_level, the N in '(Level N)' there; time, the text after 'Time' on it exactly as written. If there is only one card, or none, answer null for everything.",
            "schema": {"type": "object", "properties": {
                "item": {"type": ["string", "null"]}, "facility": {"type": ["string", "null"]}, "facility_level": {"type": ["integer", "null"]}, "time": {"type": ["string", "null"]},
            }, "required": ["item", "facility", "facility_level", "time"]},
            "crop": card_crop,
        },
    },

    # --- side questions for screens no frame has shown yet (all "tested": False, INFERRED) ---------
    # Each copies an existing pattern: one object with fixed fields (asked for a list, the 7b model
    # answers an empty one), the panel crop, and a key so an all-null answer counts as "not there".
    "level_up": {
        # The Level Up tab: seen only in beta footage at a maxed facility ("Max level reached");
        # the cost, RV and material lines are INFERRED from wikily's per-level wording.
        "prompt": "This is the Home Management screen of the game Aniimo with a facility's side panel open on the right, showing its 'Level Up' tab. Read only text written in that panel; never guess. max_level: true when the panel says 'Max level reached', else false. next_level: the facility level the upgrade leads to (the N in 'Lv.N' or 'Level N' after an arrow or under 'Next level'), or null. coin_cost: the Home Coins cost of the upgrade, the number next to a coin icon INSIDE the panel (not the Home Coins balance at the top right of the screen), copied exactly as written keeping its spaces, or null. rv_required: the RV level the upgrade needs (the M in 'RV Lv.M'), or null. material_1_name, material_1_amount, material_2_name, material_2_amount: the first two materials the upgrade needs, each name as written and the amount needed, or null. If no Level Up tab is open, answer false for max_level and null for everything else.",
        "schema": {"type": "object", "properties": {
            "max_level": {"type": ["boolean", "null"]}, "next_level": {"type": ["integer", "null"]}, "coin_cost": {"type": ["string", "null"]},
            "rv_required": {"type": ["integer", "null"]},
            "material_1_name": {"type": ["string", "null"]}, "material_1_amount": {"type": ["integer", "null"]},
            "material_2_name": {"type": ["string", "null"]}, "material_2_amount": {"type": ["integer", "null"]},
        }, "required": ["max_level", "next_level", "coin_cost", "rv_required", "material_1_name", "material_1_amount", "material_2_name", "material_2_amount"]},
        "crop": panel_crop,
        "rules": "level_up",  # rule_level_up: a cost equal to the balance is cleared, next_level must exceed the panel's level
        "key_any": ["next_level", "coin_cost", "rv_required", "max_level"],
        "tested": False,
    },
    "pairs": {
        # The Crackle Generator's Details tab (capacity, power in use, supply rate: docs/plans/emode.md
        # section 5), the Storage Unit's panel and the RV screen's requirement lines. Labels are
        # mapped to capacity, in_use and supply_rate by keyword in rule_pairs; the raw pairs stay.
        "prompt": "This part of a screen from the game Aniimo shows a panel with labelled numbers, for example a power generator's 'Details' tab (power capacity, power in use, supply rate), a storage building's panel, or the requirements for the next level. Copy up to four lines that each pair a label with a value: label_1 to label_4, the label text exactly as written, and value_1 to value_4, the number or value written with that label exactly as written (keep units such as 'W' or '%' and any '/' between two numbers). Use null for a pair that is not there. supply_mode: if the panel offers a supply setting such as '100%' or '120%', the one that is selected, as written; otherwise null. Never guess.",
        "schema": {"type": "object", "properties": {
            **{f"label_{i}": {"type": ["string", "null"]} for i in range(1, 5)},
            **{f"value_{i}": {"type": ["string", "null"]} for i in range(1, 5)},
            "supply_mode": {"type": ["string", "null"]},
        }, "required": [f"label_{i}" for i in range(1, 5)] + [f"value_{i}" for i in range(1, 5)] + ["supply_mode"]},
        "crop": panel_crop,
        "rules": "pairs",
        "key_field": "label_1",
        "tested": False,
    },
    "manage": {
        # A facility's Manage tab (the worker slots). Seen on panels as a tab name only; the slot
        # layout and an E-mode switch on it are INFERRED.
        "prompt": "This is the Home Management screen of the game Aniimo with a facility's side panel open on the right, showing its 'Manage' tab, where Aniimo are assigned to work. Read only that panel; never guess. slots_total: how many worker slots it shows, filled and empty together, or null. slots_empty: how many of those slots are empty, or null. first_name: the name written in the first filled slot, or null. first_ability: the ability shown for that Aniimo, one of: " + ", ".join(ABILITIES) + ", or null. emode_on: true if the tab shows an E-mode (electric mode) switch that is on, false if it shows one that is off, null if there is no such switch.",
        "schema": {"type": "object", "properties": {
            "slots_total": {"type": ["integer", "null"]}, "slots_empty": {"type": ["integer", "null"]},
            "first_name": {"type": ["string", "null"]}, "first_ability": {"type": ["string", "null"]}, "emode_on": {"type": ["boolean", "null"]},
        }, "required": ["slots_total", "slots_empty", "first_name", "first_ability", "emode_on"]},
        "crop": panel_crop,
        "key_any": ["slots_total", "slots_empty", "first_ability", "emode_on"],
        "tested": False,
    },
    "store": {
        # How much a plot holds (plot overflow, the level 1 caps). The 'held/cap' line is INFERRED;
        # no grower panel frame shows it clearly.
        "prompt": "This is the Home Management screen of the game Aniimo with the side panel of a plot or gathering facility open on the right. Look in that panel for a line showing how much finished output the facility holds, usually two numbers such as '12/35' next to a storage, basket or harvest icon. label: the words written with it, or null. held: the first number (what it holds now), or null. cap: the second number (the most it can hold), or null. Never guess; if there is no such line, answer null for everything.",
        "schema": {"type": "object", "properties": {"label": {"type": ["string", "null"]}, "held": {"type": ["integer", "null"]}, "cap": {"type": ["integer", "null"]}},
                   "required": ["label", "held", "cap"]},
        "crop": panel_crop,
        "key_any": ["held", "cap"],
        "tested": False,
    },
    "emode": {
        # E-mode on a processor, the Well or the Mine (docs/plans/emode.md section 5, questions 3 to 6).
        # Where the switch sits is INFERRED (asked on the Manage tab).
        "prompt": "This is the Home Management screen of the game Aniimo with a facility's side panel open on the right. switch_visible: true if the panel shows an 'E-mode' (electric mode) switch, toggle or button, false if it does not. emode_on: true when that switch is on, false when it is off, null when there is no switch. power_draw: the power the facility uses, the number written with 'W' or a lightning icon near that switch, or null. Read only that panel; never guess.",
        "schema": {"type": "object", "properties": {"switch_visible": {"type": ["boolean", "null"]}, "emode_on": {"type": ["boolean", "null"]}, "power_draw": {"type": ["integer", "null"]}},
                   "required": ["switch_visible", "emode_on", "power_draw"]},
        "crop": panel_crop,  # no key: asked only on such a facility's Manage tab, where "no switch" is itself an answer
        "tested": False,
    },
    "food": {
        # The Food tab of Aniimo Management (docs/research/worker-food.md): the shared food bowl. Read
        # as its own screen (food-*.png, or the watcher's "food" kind) and as the Food tab of a panel.
        "prompt": "This is a screenshot from the game Aniimo that may show the Food tab of Aniimo Management: a shared food bowl that the working Aniimo eat from. total_food_energy: the total food energy shown for the bowl, copied exactly as written keeping its spaces, or null. working_aniimo: how many Aniimo it says are working or eating, or null. Use null for anything not written; never guess.",
        "schema": {"type": "object", "properties": {"total_food_energy": {"type": ["string", "null"]}, "working_aniimo": {"type": ["integer", "null"]}},
                   "required": ["total_food_energy", "working_aniimo"]},
        "key_field": "total_food_energy",
        "tested": False,
    },
    "unknown": {
        "prompt": "This is a screenshot from the game Aniimo. In one sentence, say what screen it shows and list any numbers with their labels.",
        "schema": {"type": "object", "properties": {"description": {"type": "string"}}, "required": ["description"]},
        "tested": False,  # a free description, never scored
    },
}

# A facility panel is always read the detailed way (crop, status, second question for the grey line);
# the plain "facility" prompt it replaces lives on only as this alias, so file names and the merge
# keep working.
SCREEN_KINDS["facility"] = SCREEN_KINDS["facility_detail"]


def is_tested(kind) -> bool:
    """Is this spec's prompt proven on checked frames? Every spec states "tested"; anything that does
    not (an unknown kind) counts as untested. The one default, used by the watcher, the gate and the
    game questions."""
    return SCREEN_KINDS.get(kind, {}).get("tested", False) is True


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
    # Each facility's category (Materials, Aniimo Materials, Environment, Materials Processing), from
    # the same FACILITIES entries, so a side question can be asked of growers or processors only.
    categories = dict(re.findall(r"name: '([^']+)',\s*slug: '[^']+'[^\n]*?category: '([^']+)'", config))
    return {"facilities": sorted(set(facilities)), "items": sorted(items), "environments": sorted(environments),
            "categories": categories, "aux": list(AUX_FACILITIES)}


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


# --- fixed rules on the side questions' answers (like validate_card: code, not the model) -----------

def rule_level_up(fields: dict, parent: dict | None) -> dict:
    """A Level Up reading, checked against the panel it was read on (`parent`, the facility_detail
    answer). The 7b model copies the nearest big number, so a cost equal to the Home Coins balance
    at the top right is that balance, not a cost: cleared. An upgrade leads up, so a next_level that
    does not exceed the panel's level is cleared."""
    out = dict(fields)
    parent = parent if isinstance(parent, dict) else {}
    balance = count_from(parent.get("coins"))
    if out.get("coin_cost") is not None and balance is not None and count_from(out.get("coin_cost")) == balance:
        out["coin_cost"] = None
    level, nxt = parent.get("level"), out.get("next_level")
    if isinstance(nxt, int) and isinstance(level, int) and not isinstance(level, bool) and nxt <= level:
        out["next_level"] = None
    return out


PAIR_KEYWORDS = (  # first match wins: "supply rate" before "rate", "in use" before "capacity"
    ("supply_rate", ("supply", "rate", "efficien", "%")),
    ("in_use", ("in use", "used", "usage", "load", "consum", "draw", "occupied")),
    ("capacity", ("capacity", "max", "total", "limit", "output")),
)


def pair_role(label) -> str | None:
    """capacity, in_use or supply_rate for a label read off a panel, by keyword; None for anything else."""
    text = str(label or "").lower()
    for role, words in PAIR_KEYWORDS:
        if any(w in text for w in words):
            return role
    return None


def rule_pairs(fields: dict, parent: dict | None = None) -> dict:
    """The four label/value pairs mapped to capacity, in_use and supply_rate (whole numbers, the first
    label of each role wins), with the raw pairs kept as read. A value written 'a/b' under a capacity
    or in-use label gives in_use a and capacity b (INFERRED: how a power gauge is usually written)."""
    out = dict(fields)
    mapped: dict = {"capacity": None, "in_use": None, "supply_rate": None}
    for i in range(1, 5):
        role, value = pair_role(out.get(f"label_{i}")), out.get(f"value_{i}")
        if role is None or value is None:
            continue
        text = str(value)
        if "/" in text and role in ("capacity", "in_use"):
            left, _, right = text.partition("/")
            if mapped["in_use"] is None:
                mapped["in_use"] = count_from(left)
            if mapped["capacity"] is None:
                mapped["capacity"] = count_from(right)
        elif mapped[role] is None:
            mapped[role] = count_from(text)
    if mapped["supply_rate"] is None and out.get("supply_mode") is not None:
        mapped["supply_rate"] = count_from(out.get("supply_mode"))
    out.update(mapped)
    return out


def rule_rv(fields: dict, parent: dict | None = None) -> dict:
    """On the RV screen the next level's cost and the Home Coins balance are both coin numbers; a
    'balance' equal to the cost is the cost read twice, so the balance is cleared."""
    out = dict(fields)
    cost = count_from(out.get("next_rv_cost"))
    if cost is not None and count_from(out.get("coins")) == cost:
        out["coins"] = None
    return out


RULES = {"level_up": rule_level_up, "pairs": rule_pairs, "rv": rule_rv}


# --- when a side question is asked (`only_if` of a kind's `also`) -----------------------------------

def known_facility(text, names: dict) -> str | None:
    """The facility (or aux facility) a panel heading names, matched like match_name but quietly."""
    if not text:
        return None
    candidates = list(names.get("facilities") or []) + list(names.get("aux") or AUX_FACILITIES)
    by_slug = {slug(c): c for c in candidates}
    wanted = slug(text)
    if wanted in by_slug:
        return by_slug[wanted]
    close = difflib.get_close_matches(wanted, list(by_slug), n=1, cutoff=0.75)
    return by_slug[close[0]] if close else None


def tab_is(fields: dict, tab: str) -> bool:
    return slug(fields.get("tab") or "") == slug(tab)


def facility_category(fields: dict, names: dict) -> str | None:
    return (names.get("categories") or {}).get(known_facility(fields.get("facility"), names))


def is_aux(fields: dict, names: dict) -> bool:
    return known_facility(fields.get("facility"), names) in (names.get("aux") or AUX_FACILITIES)


ONLY_IF = {
    "level_up_tab": lambda f, n: tab_is(f, "Level Up"),
    "manage_tab": lambda f, n: tab_is(f, "Manage"),
    "food_tab": lambda f, n: tab_is(f, "Food"),
    "aux_panel": lambda f, n: is_aux(f, n) and not any(tab_is(f, t) for t in ("Level Up", "Manage", "Food")),
    "grower_formula": lambda f, n: tab_is(f, "Formula") and facility_category(f, n) in GROWER_CATEGORIES,
    "emode_manage": lambda f, n: tab_is(f, "Manage") and (facility_category(f, n) == PROCESSOR_CATEGORY
                                                          or known_facility(f.get("facility"), n) in EMODE_GATHERERS),
    "rv_cost": lambda f, n: count_from(f.get("next_rv_cost")) is not None,
}


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


def checked(want) -> bool:
    """Is this expected.json entry hand-checked? An entry written by --expected-skeleton carries
    "checked": false until the owner has corrected it and set it to true; an entry without the key
    (a file written by hand) counts as checked."""
    return isinstance(want, dict) and want.get("checked", True) is True


def score(screens: list[dict], expected: dict) -> list[dict]:
    """Per frame: how many of the hand-checked values the reading got right. Only checked entries
    count (see checked); the "checked" key itself is not a value."""
    rows = []
    for screen in screens:
        want = expected.get(screen["file"])
        if want is None or not checked(want):
            continue
        got = flatten(screen.get("fields") or {})
        wanted = flatten({k: v for k, v in want.items() if k != "checked"})
        same = lambda k, v: got.get(k) == v or (isinstance(v, str) and isinstance(got.get(k), str) and slug(v) == slug(got[k]))  # noqa: E731
        correct = sum(1 for k, v in wanted.items() if same(k, v))
        rows.append({"file": screen["file"], "kind": screen.get("kind"), "correct": correct, "total": len(wanted), "seconds": screen.get("seconds", 0),
                     "wrong": {k: (got.get(k), v) for k, v in wanted.items() if not same(k, v)}, "keys": sorted(wanted)})
    return rows


def skeleton(screens: list[dict]) -> dict:
    """expected.json pre-filled with the model's own answers, every entry "checked": false: the owner
    corrects each value that is wrong, then sets "checked" to true (only then does it count)."""
    return {s["file"]: {"checked": False, **s["fields"]} for s in screens if isinstance(s.get("fields"), dict) and not s.get("error")}


GATE_SHARE = 0.9   # a spec flips to tested at 90% of its checked values right ...
GATE_FRAMES = 5    # ... on at least this many checked frames


def spec_of(kind: str | None, key: str) -> str:
    """The spec a scored value belongs to: a side question's field (`level_up.coin_cost` on a facility
    frame) belongs to that side question's kind, everything else to the frame's own kind."""
    spec = SCREEN_KINDS.get(kind or "unknown", {})
    head = key.split(".", 1)[0]
    also = spec.get("also") or {}
    if head in also and "." in key:
        return also[head]
    return "facility_detail" if kind == "facility" else (kind or "unknown")


def gate_report(rows: list[dict]) -> dict[str, dict]:
    """{spec: {frames, correct, total, share, passes, tested}} over the scored rows. `passes`: at least
    GATE_FRAMES frames and GATE_SHARE of the values right, the bar for flipping the spec's "tested"
    (which stays a hand edit in SCREEN_KINDS)."""
    out: dict[str, dict] = {}
    for row in rows:
        seen = set()
        for key in row.get("keys", []):
            spec = spec_of(row.get("kind"), key)
            entry = out.setdefault(spec, {"frames": 0, "correct": 0, "total": 0})
            entry["total"] += 1
            entry["correct"] += 0 if key in row["wrong"] else 1
            seen.add(spec)
        for spec in seen:
            out[spec]["frames"] += 1
    for spec, entry in out.items():
        entry["share"] = entry["correct"] / entry["total"] if entry["total"] else 0.0
        entry["passes"] = entry["frames"] >= GATE_FRAMES and entry["share"] >= GATE_SHARE
        entry["tested"] = is_tested(spec)
    return out


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


def read_spec(spec: dict, ask, payload, names: dict | None = None, image=None, parent: dict | None = None) -> tuple[dict, dict]:
    """One screen kind on one frame: the main question, its follow-up (merged under the follow-up's
    field) and the extra kinds in `also` ({field: kind}), each read the same way on its own crop and
    merged under its field (None when its key is not written, e.g. no item card is open). An `also`
    kind named in `only_if` ({field: condition in ONLY_IF}) is asked only when that condition holds for
    this answer (the Level Up question only on the Level Up tab, ...); otherwise its field is left out.
    `ask(prompt, schema, image_b64)` asks the model; `payload(crop)` gives the frame (or that part of
    it) as base64; `names` (known_names) feeds the kind's validator, if it has one, and the conditions;
    `image` (the frame as a Pillow image, when Pillow is there) lets a kind's gate look for its subject
    first and skip the model when it is absent; `parent` is the answer this kind was asked beside (its
    fixed rules, RULES, compare with it). Returns (fields, errors): a failed side question costs only
    its field and is listed in errors by that field; a failed main question raises."""
    gate = GATES.get(spec.get("gate")) if image is not None else None
    if gate and not gate(image.crop(crop_box(image.size, spec["crop"])) if spec.get("crop") else image):
        return empty_answer(spec), {}
    check = VALIDATORS.get(spec.get("validate")) if names else None
    clean = (lambda a: check(unnull(a), names)) if check else unnull
    fields = clean(ask(spec["prompt"], spec["schema"], payload(spec.get("crop"))))
    errors: dict = {}
    if not isinstance(fields, dict):
        return fields, errors
    rule = RULES.get(spec.get("rules"))
    if rule:
        fields = rule(fields, parent)
    follow = spec.get("follow_up")
    if follow and key_present(spec, fields):  # no card read: no point asking about a second one
        try:
            answer = clean(ask(follow["prompt"], follow["schema"], payload(follow.get("crop"))))
        except ASK_ERRORS as e:
            answer, errors[follow["field"]] = None, str(e)
        attach_follow_up(fields, follow, answer)
    elif follow:
        fields[follow["field"]] = None
    conditions = spec.get("only_if") or {}
    for field, kind in (spec.get("also") or {}).items():
        condition = ONLY_IF.get(conditions.get(field)) if field in conditions else None
        if field in conditions and not (condition and condition(fields, names or {})):
            continue  # not this tab or facility: not asked, and no field for it
        extra_spec = SCREEN_KINDS[kind]
        try:
            extra, more = read_spec(extra_spec, ask, payload, names, image, parent=fields)
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
    """Did the model read the thing this kind is about? True when the kind has no key, else when its
    key_field holds written text (an item card's title, for example), or, for a kind with `key_any`,
    when one of those fields holds something other than null or false."""
    key, any_of = spec.get("key_field"), spec.get("key_any")
    if any_of:
        return any(fields.get(k) is not None and fields.get(k) is not False and fields.get(k) != "" for k in any_of)
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
    parser.add_argument("--expected", type=Path, help="JSON of hand-checked values per file, to score accuracy (only entries with \"checked\": true, or no \"checked\" key)")
    parser.add_argument("--expected-skeleton", type=Path, help="write this file pre-filled with the model's answers, every entry \"checked\": false (never overwrites)")
    parser.add_argument("--check", action="store_true", help="only check that Ollama and the model are available")
    args = parser.parse_args(argv)

    if args.expected_skeleton and args.expected_skeleton.exists():
        print(f"{args.expected_skeleton} already exists; it may hold your corrections, so it is not overwritten. Pick another name.")
        return 1
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
        for spec, g in sorted(gate_report(rows).items()):
            verdict = "already tested" if g["tested"] else ("passes the gate: set \"tested\": True in SCREEN_KINDS" if g["passes"]
                                                            else f"not yet (needs {GATE_FRAMES} checked frames at {GATE_SHARE:.0%})")
            print(f"  spec {spec}: {g['correct']}/{g['total']} values on {g['frames']} frames ({g['share']:.0%}); {verdict}")
    if args.expected_skeleton:
        args.expected_skeleton.write_text(json.dumps(skeleton(screens), indent=2), encoding="utf-8")
        print(f"Wrote {args.expected_skeleton}: correct each value by hand, then set \"checked\": true on that entry.")
    print("Next: on the site, Profile details -> Load screenshot reading, and confirm the diff.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

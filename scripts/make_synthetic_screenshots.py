#!/usr/bin/env python3
"""Make a few synthetic "screenshots" with known values, so read_screenshots.py can be exercised
before any real game screenshots exist. Plain text on a dark background: much easier than the
game's UI, so passing them proves the pipeline works, not that a model reads the game well.

Writes screenshots/synthetic/*.png and expected.json (gitignored with the rest of screenshots/).
Needs Pillow (already on this PC); nothing else.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent.parent / "screenshots" / "synthetic"

SCREENS = {
    "rv-home.png": (["Homeland", "RV Lv.7", "Home Coins 123 456"], {"rv": 7, "coins": "123 456"}),
    "home-management.png": (["Home Management", "Plot 4   Lv.2   Lv.5   Lv.1", "220 724"], {"coins": "220 724"}),
    "facility-farmland.png": (["Home Management", "Farmland (Level 3)", "Formula   Manage   Level Up"], {"facility": "Farmland", "count": None, "level": 3}),
    "facility-carousel-mill.png": (["Home Management", "Carousel Mill (Level 4)", "Formula   Manage   Level Up"], {"facility": "Carousel Mill", "count": None, "level": 4}),
    "modules-all.png": (["Upgrade Modules", "Ecological Module  Lv. 2", "Kitchen Module  Lv. 3", "Resource Detector  Lv. 1", "Crafting Module  Lv. 1"],
                        {"ecological_module": 2, "kitchen_module": 3, "resource_detector": 1, "crafting_module": 1}),
    "aniimo-page1.png": (["Aniimo", "Spark   Fire Lv.3   Playful", "Pebble   Earth Lv.2   Calm"],
                         {"aniimo": [{"name": "Spark", "abilities": [{"ability": "Fire", "level": 3}], "personalities": ["Playful"]},
                                     {"name": "Pebble", "abilities": [{"ability": "Earth", "level": 2}], "personalities": ["Calm"]}]}),
    "stock-wood-block.png": (["Wood Block", "Home materials", "Inventory: 3", "Homeland: 40"],
                             {"items": [{"name": "Wood Block", "inventory": 3, "homeland": 40, "owned": None}]}),
    "stock-shop.png": (["Shop", "Psyche Fruit", "Owned 24", "Buy  140.0 K"],
                       {"items": [{"name": "Psyche Fruit", "inventory": None, "homeland": None, "owned": 24}]}),
}


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    try:
        font = ImageFont.truetype("arial.ttf", 40)
        title_font = ImageFont.truetype("arialbd.ttf", 56)
    except OSError:
        font = ImageFont.load_default(40)
        title_font = ImageFont.load_default(56)
    expected = {}
    for name, (lines, truth) in SCREENS.items():
        image = Image.new("RGB", (1280, 720), (22, 25, 30))
        draw = ImageDraw.Draw(image)
        draw.rounded_rectangle((80, 60, 1200, 660), radius=24, fill=(34, 38, 46), outline=(108, 197, 164), width=3)
        y = 100
        for i, line in enumerate(lines):
            draw.text((130, y), line, fill=(240, 240, 240), font=title_font if i == 0 else font)
            y += 110 if i == 0 else 70
        image.save(OUT / name)
        expected[name] = truth
    (OUT / "expected.json").write_text(json.dumps(expected, indent=2), encoding="utf-8")
    print(f"Wrote {len(SCREENS)} images and expected.json to {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

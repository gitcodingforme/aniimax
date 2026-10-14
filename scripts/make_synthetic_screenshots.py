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
    "rv-home.png": (["Homeland", "RV Level 7", "Home Coins 123,456"], {"rv": 7, "coins": 123456}),
    "facility-farmland.png": (["Farmland", "Owned: 12", "Level 3"], {"facility": "Farmland", "count": 12, "level": 3}),
    "facility-carousel-mill.png": (["Carousel Mill", "Owned: 2", "Level 4"], {"facility": "Carousel Mill", "count": 2, "level": 4}),
    "modules-all.png": (["Upgrade Modules", "Ecological Module  Lv. 2", "Kitchen Module  Lv. 3", "Resource Detector  Lv. 1", "Crafting Module  Lv. 1"],
                        {"ecological_module": 2, "kitchen_module": 3, "resource_detector": 1, "crafting_module": 1}),
    "aniimo-page1.png": (["Aniimo", "Spark   Fire Lv.3   Playful", "Pebble   Earth Lv.2   Calm"],
                         {"aniimo": [{"name": "Spark", "abilities": [{"ability": "Fire", "level": 3}], "personalities": ["Playful"]},
                                     {"name": "Pebble", "abilities": [{"ability": "Earth", "level": 2}], "personalities": ["Calm"]}]}),
    "stock-materials.png": (["Storage", "Wood Block  x40", "Mineral Sand  x120", "Rough Lumber  x5"],
                            {"items": [{"name": "Wood Block", "amount": 40}, {"name": "Mineral Sand", "amount": 120}, {"name": "Rough Lumber", "amount": 5}]}),
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

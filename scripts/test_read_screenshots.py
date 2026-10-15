"""Tests for read_screenshots.py with a fake model (no Ollama needed). Run from the repository root:
    python -m unittest discover -s scripts -p "test_*.py"
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import read_screenshots as rs  # noqa: E402

NAMES = {"facilities": ["Farmland", "Carousel Mill", "Tidewhisper Sandcastle", "Chimney Kiln"], "items": ["wood_block", "mineral_sand", "rough_lumber"]}


class ReadScreenshotsTest(unittest.TestCase):
    def test_screen_kind_comes_from_the_file_prefix(self):
        self.assertEqual(rs.screen_kind(Path("rv-home.png")), "rv")
        self.assertEqual(rs.screen_kind(Path("Facility-farmland-2.PNG")), "facility")
        self.assertEqual(rs.screen_kind(Path("holiday.png")), "unknown")
        self.assertEqual(rs.screen_kind(Path("unknown-thing.png")), "unknown")

    def test_merge_builds_a_partial_setup_and_notes_fuzzy_names(self):
        screens = [
            {"file": "rv-1.png", "kind": "rv", "fields": {"rv": 7, "coins": 123456}},
            {"file": "facility-a.png", "kind": "facility", "fields": {"facility": "Carousel mill", "count": 2, "level": 3}},
            {"file": "facility-b.png", "kind": "facility", "fields": {"facility": "Tidewisper Sandcastle", "count": 1, "level": None}},
            {"file": "facility-c.png", "kind": "facility", "fields": {"facility": "Moon Base", "count": 1, "level": 1}},
            {"file": "facility-d.png", "kind": "facility", "fields": {"facility": "Chimney Kiln", "count": None, "level": 2}},
            {"file": "home-1.png", "kind": "home", "fields": {"coins": "220 724"}},
            {"file": "modules-1.png", "kind": "modules", "fields": {"ecological_module": 2, "kitchen_module": None, "resource_detector": 0, "crafting_module": 1}},
            {"file": "aniimo-1.png", "kind": "aniimo", "fields": {"aniimo": [
                {"name": "Spark", "abilities": [{"ability": "fire", "level": 3}, {"ability": "Laser", "level": 2}], "personalities": ["Playful"]},
                {"name": "Nobody", "abilities": [{"ability": "Water", "level": 9}], "personalities": []},
            ]}},
            {"file": "stock-1.png", "kind": "stock", "fields": {"items": [{"name": "Wood Blocks", "amount": 40}, {"name": "Mineral Sand", "amount": 12}, {"name": "Golden Egg", "amount": 1}]}},
            {"file": "stock-2.png", "kind": "stock", "fields": {"items": [{"name": "Rough Lumber", "inventory": 3, "homeland": 7, "owned": None}]}},
            {"file": "shot.png", "kind": "unknown", "fields": {"description": "a map"}},
            {"file": "facility-broken.png", "kind": "facility", "fields": None, "error": "timeout"},
        ]
        setup, actual, notes = rs.merge_screens(screens, NAMES)
        self.assertEqual(setup["home-level"], "7")
        self.assertEqual(actual, {"rv": 7, "coins": 220724}, "the later Home Management frame updates the coins")
        self.assertEqual(setup["facilityTiers"], {"Carousel Mill": [{"count": 2, "level": 3}], "Tidewhisper Sandcastle": [{"count": 1, "level": 1}],
                                                  "Chimney Kiln": [{"count": None, "level": 2}]})
        self.assertEqual(setup["ecological-module-level"], "2")
        self.assertEqual(setup["resource-detector-level"], "0")
        self.assertEqual(setup["crafting-module-level"], "1")
        self.assertNotIn("kitchen-module-level", setup)
        self.assertEqual(setup["roster"], [{"name": "Spark", "count": 1, "abilities": {"Fire": 3}, "personalities": ["Playful"]}])
        self.assertEqual(setup["levelUpStock"], {"wood_block": 40, "mineral_sand": 12, "rough_lumber": 7})
        joined = "\n".join(notes)
        self.assertIn("Tidewisper Sandcastle', taken as 'Tidewhisper Sandcastle'", joined)
        self.assertIn("Moon Base', which matches nothing", joined)
        self.assertIn("Laser', which matches nothing", joined)
        self.assertIn("Golden Egg', which matches nothing", joined)
        self.assertIn("Wood Blocks', taken as 'wood_block'", joined)

    def test_read_all_uses_the_prompt_for_each_kind_and_survives_errors(self):
        with tempfile.TemporaryDirectory() as d:
            folder = Path(d)
            for name in ["rv-home.png", "stock-bag.png", "weird.png"]:
                (folder / name).write_bytes(b"\x89PNG not really")
            asked = []

            def fake_ask(host, model, prompt, schema, image_b64):
                asked.append((prompt[:40], sorted(schema["properties"])))
                if "information card" in prompt:
                    raise ValueError("the model did not answer with JSON")
                return {"rv": 3, "coins": 10} if "RV level" in prompt else {"description": "x"}

            screens = rs.read_all(sorted(folder.glob("*.png")), "http://fake", "model", ask=fake_ask)
        self.assertEqual([s["kind"] for s in screens], ["rv", "stock", "unknown"])
        self.assertEqual(screens[0]["fields"], {"rv": 3, "coins": 10})
        self.assertIn("did not answer with JSON", screens[1]["error"])
        self.assertEqual(asked[0][1], ["coins", "rv"])
        self.assertEqual(asked[1][1], ["items"])

    def test_score_counts_fields_and_tolerates_name_spelling(self):
        screens = [
            {"file": "rv-1.png", "kind": "rv", "fields": {"rv": 7, "coins": 123000}, "seconds": 2.0},
            {"file": "facility-a.png", "kind": "facility", "fields": {"facility": "carousel mill", "count": 2, "level": 3}, "seconds": 3.0},
            {"file": "aniimo-1.png", "kind": "aniimo", "fields": {"aniimo": [{"name": "Spark", "abilities": [{"ability": "Fire", "level": 3}], "personalities": []}]}, "seconds": 4.0},
        ]
        expected = {"rv-1.png": {"rv": 7, "coins": 123456}, "facility-a.png": {"facility": "Carousel Mill", "count": 2, "level": 3},
                    "aniimo-1.png": {"aniimo": [{"name": "Spark", "abilities": [{"ability": "Fire", "level": 2}], "personalities": []}]}, "missing.png": {"rv": 1}}
        rows = rs.score(screens, expected)
        self.assertEqual([(r["file"], r["correct"], r["total"]) for r in rows], [("rv-1.png", 1, 2), ("facility-a.png", 3, 3), ("aniimo-1.png", 2, 3)])
        self.assertEqual(rows[0]["wrong"], {"coins": (123000, 123456)})
        self.assertEqual(rows[2]["wrong"], {"aniimo.0.abilities.0.level": (3, 2)})

    def test_count_from_reads_numbers_written_with_spaces_or_commas(self):
        self.assertEqual(rs.count_from("220 724"), 220724)
        self.assertEqual(rs.count_from("29,698,282"), 29698282)
        self.assertEqual(rs.count_from(42), 42)
        self.assertIsNone(rs.count_from(None))
        self.assertIsNone(rs.count_from("none"))
        self.assertIsNone(rs.count_from(True))

    def test_known_names_include_facilities_recipes_and_level_up_materials(self):
        names = rs.known_names(Path(__file__).resolve().parent.parent)
        self.assertIn("Farmland", names["facilities"])
        self.assertIn("Carousel Mill", names["facilities"])
        for item in ["wheat", "milled_rice", "wood_block", "mineral_sand", "rough_lumber"]:
            self.assertIn(item, names["items"])

    def test_check_server_explains_what_is_missing(self):
        original = rs.get_json
        try:
            rs.get_json = lambda url, timeout: {"models": [{"name": "llava:latest"}]}
            with self.assertRaisesRegex(SystemExit, "not pulled.*llava"):
                rs.check_server("http://fake", "qwen2.5vl:7b")
            self.assertIn("has llava", rs.check_server("http://fake", "llava"))

            def down(url, timeout):
                raise OSError("refused")
            rs.get_json = down
            with self.assertRaisesRegex(SystemExit, "not answering"):
                rs.check_server("http://fake", "llava")
        finally:
            rs.get_json = original

    def test_ask_model_sends_images_with_a_schema_and_parses_json(self):
        original = rs.post_json
        sent = {}
        try:
            def fake_post(url, body, timeout):
                sent.update(url=url, body=body)
                return {"message": {"content": json.dumps({"rv": 5, "coins": 1})}}
            rs.post_json = fake_post
            self.assertEqual(rs.ask_model("http://fake", "m", "prompt", {"type": "object"}, "AAAA"), {"rv": 5, "coins": 1})
            self.assertEqual(sent["url"], "http://fake/api/chat")
            self.assertEqual(sent["body"]["messages"][0]["images"], ["AAAA"])
            self.assertEqual(sent["body"]["format"], {"type": "object"})
            self.assertEqual(sent["body"]["options"], {"temperature": 0, "num_predict": 4096})
            rs.post_json = lambda url, body, timeout: {"message": {"content": "I cannot read this"}}
            with self.assertRaisesRegex(ValueError, "did not answer with JSON") as caught:
                rs.ask_model("http://fake", "m", "prompt", {}, "AAAA")
            self.assertEqual(caught.exception.content, "I cannot read this")
        finally:
            rs.post_json = original


if __name__ == "__main__":
    unittest.main()

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
        self.assertEqual(asked[0][1], ["coins", "next_rv_cost", "rv", "title"], "the RV prompt also asks for the title and the next level's cost")
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

    def test_item_card_files_are_their_own_kind(self):
        self.assertEqual(rs.screen_kind(Path("item_card-stock-20261015-105144.png")), "item_card")
        self.assertEqual(rs.screen_kind(Path("item-thing.png")), "unknown")

    def test_card_crop_is_measured_from_the_window_height_and_needs_no_shrink(self):
        self.assertEqual(rs.card_crop(3440, 1440), (1568, 0, 2792, 1440))
        self.assertLessEqual(2792 - 1568, rs.MAX_SIDE, "the card strip is sent at full detail")
        self.assertEqual(rs.card_crop(1920, 1080), (516, 0, 1434, 1080))

    def test_known_names_include_the_environments(self):
        names = rs.known_names(Path(__file__).resolve().parent.parent)
        for env in ["Cool", "Warm", "Scorching", "Adequate"]:
            self.assertIn(env, names["environments"])

    def test_validate_card_drops_what_cannot_be_a_card(self):
        names = {"facilities": ["Simmering Pot", "Farmland"], "items": ["rose"], "environments": ["Cool", "Warm"]}
        panel_as_card = {"item": "Simmering Pot", "facility": "Simmering Pot", "facility_level": 1, "time": "40m 0s", "workload": None, "environment": None}
        self.assertEqual(rs.validate_card(panel_as_card, names), {k: None for k in panel_as_card}, "a title that is a facility name means no card")
        stray = {"item": "Plain Rice Porridge", "facility": "Simmering Pot", "facility_level": 1, "time": "1m 48s", "workload": None, "environment": "Home Processing"}
        self.assertIsNone(rs.validate_card(stray, names)["environment"], "an environment the data does not know is dropped")
        self.assertEqual(rs.validate_card({**stray, "environment": "cool"}, names)["environment"], "cool", "a known one is kept as read")
        energy = {"item": "Moondew Radish Slices", "facility": "Blazing Stove", "facility_level": 1, "time": "2m 42s", "workload": 45280, "environment": None}
        self.assertIsNone(rs.validate_card(energy, names)["workload"], "a card shows Time or Workload, never both: the number was Provides Energy")
        keg = {"item": "Ginseng Water", "facility": "Bouncy Brew Keg", "facility_level": 3, "time": None, "workload": 162, "environment": None}
        self.assertEqual(rs.validate_card(keg, names)["workload"], 162)
        self.assertEqual(rs.unnull({"time": "null", "workload": None, "item": "Rose"}), {"time": None, "workload": None, "item": "Rose"})

    def test_read_spec_reads_a_card_beside_a_panel_and_asks_about_a_second_card_only_when_one_is_read(self):
        detail = rs.SCREEN_KINDS["facility_detail"]
        card = rs.SCREEN_KINDS["item_card"]
        names = {"facilities": ["Simmering Pot", "Farmland"], "items": ["rose", "rose_concentrate"], "environments": ["Cool"]}
        panel = {"facility": "Simmering Pot", "level": 4, "tab": "Formula", "recipe_status": "not set", "recipe": None, "recipe_time": None, "recipes_per_level": [], "coins": "220 724"}
        front = {"item": "Rose", "facility": "Farmland", "facility_level": 4, "time": "40m 0s", "workload": None, "environment": "Cool"}
        behind = {"item": "ose Concentrate", "facility": "Simmering Pot", "facility_level": 2, "time": "1m 48s"}
        answers = {id(detail["schema"]): panel, id(detail["follow_up"]["schema"]): {"facility_level": 5, "rv_level": 15},
                   id(card["schema"]): front, id(card["follow_up"]["schema"]): behind}
        asked = []

        def fake_ask(prompt, schema, image_b64):
            asked.append(id(schema))
            return dict(answers[id(schema)])
        fields, errors = rs.read_spec(detail, fake_ask, lambda crop: "img", names)
        self.assertEqual(errors, {})
        self.assertEqual(fields["facility"], "Simmering Pot")
        self.assertEqual(fields["upgrade_note"], {"facility_level": 5, "rv_level": 15})
        self.assertEqual(fields["card"], {**front, "behind": behind}, "the card and the one behind it ride along under `card`")
        self.assertEqual(len(asked), 4)
        # no card open: the card answer is all null, so `card` is None and the second-card question is not asked
        answers[id(card["schema"])] = {k: None for k in front}
        asked.clear()
        fields, _ = rs.read_spec(detail, fake_ask, lambda crop: "img", names)
        self.assertIsNone(fields["card"])
        self.assertEqual(len(asked), 3)
        # the side panel read as a card is caught by the validator, with the same effect
        answers[id(card["schema"])] = {**front, "item": "Simmering Pot", "facility": "Simmering Pot"}
        fields, _ = rs.read_spec(detail, fake_ask, lambda crop: "img", names)
        self.assertIsNone(fields["card"])
        # a failed card question costs only that field
        def flaky(prompt, schema, image_b64):
            if schema is card["schema"]:
                raise ValueError("the model did not answer with JSON")
            return dict(answers[id(schema)])
        fields, errors = rs.read_spec(detail, flaky, lambda crop: "img", names)
        self.assertEqual(fields["facility"], "Simmering Pot")
        self.assertIsNone(fields["card"])
        self.assertIn("did not answer", errors["card"])
        # a stock screen reads its counts and the same card
        answers[id(rs.SCREEN_KINDS["stock"]["schema"])] = {"items": [{"name": "Rose", "inventory": 0, "homeland": 520, "owned": None}]}
        answers[id(card["schema"])] = front
        fields, _ = rs.read_spec(rs.SCREEN_KINDS["stock"], fake_ask, lambda crop: "img", names)
        self.assertEqual(fields["items"][0]["homeland"], 520)
        self.assertEqual(fields["card"]["item"], "Rose")
        setup, _, _ = rs.merge_screens([{"file": "stock-1.png", "kind": "stock", "fields": fields}], names)
        self.assertEqual(setup["levelUpStock"], {"rose": 520}, "the stock reading still feeds the setup")

    def test_scoring_an_item_card_reading_counts_the_card_behind_too(self):
        screens = [{"file": "item_card-a.png", "kind": "item_card", "seconds": 5.0,
                    "fields": {"item": "Rose", "facility": "Farmland", "facility_level": 4, "time": "40m 0s", "workload": None, "environment": "Cool",
                               "behind": {"item": "Rose Concentrate", "facility": "Simmering Pot", "facility_level": 3, "time": "1m 48s"}}}]
        expected = {"item_card-a.png": {"item": "Rose", "facility": "Farmland", "facility_level": 4, "time": "40m 0s", "workload": None, "environment": "Cool",
                                        "behind": {"item": "Rose Concentrate", "facility": "Simmering Pot", "facility_level": 2, "time": "1m 48s"}}}
        rows = rs.score(screens, expected)
        self.assertEqual((rows[0]["correct"], rows[0]["total"]), (9, 10))
        self.assertEqual(rows[0]["wrong"], {"behind.facility_level": (3, 2)})

    def test_card_present_sees_a_card_header_and_nothing_else(self):
        try:
            from PIL import Image, ImageDraw
        except ImportError:
            self.skipTest("Pillow is not installed")
        strip = Image.new("RGB", (1224, 1440), (120, 190, 90))  # the grid green
        draw = ImageDraw.Draw(strip)
        draw.rectangle((50, 300, 400, 340), fill=(70, 120, 230))     # a Level N Facility heading: too small
        draw.rectangle((700, 100, 1224, 150), fill=(240, 150, 60))   # the Season Recipe bar: too flat
        draw.rectangle((60, 600, 620, 640), fill=(30, 160, 80))      # a green bar
        self.assertFalse(rs.card_present(strip))
        draw.rectangle((600, 120, 1130, 390), fill=(150, 90, 220))   # a purple card header, 530x270
        self.assertTrue(rs.card_present(strip))
        green_card = Image.new("RGB", (1224, 1440), (250, 250, 250))
        ImageDraw.Draw(green_card).rectangle((600, 120, 1130, 390), fill=(90, 200, 90))
        self.assertFalse(rs.card_present(green_card), "a green block is the grid, not a card")
        real = Path(__file__).resolve().parent.parent / "screenshots" / "auto"
        for name, want in [("stock-20261015-105144.png", True), ("facility-20261015-105113.png", False)]:
            if (real / name).is_file():
                image = rs.open_image(real / name)
                self.assertEqual(rs.card_present(image.crop(rs.crop_box(image.size, rs.card_crop))), want, name)

    def test_the_card_gate_skips_the_model_when_no_header_is_there(self):
        try:
            from PIL import Image, ImageDraw
        except ImportError:
            self.skipTest("Pillow is not installed")
        asked = []

        def fake_ask(prompt, schema, image_b64):
            asked.append(prompt[:30])
            return {"item": "Rose", "facility": "Farmland", "facility_level": 4, "time": "40m 0s", "workload": None, "environment": "Cool"}
        spec = rs.SCREEN_KINDS["item_card"]
        plain = Image.new("RGB", (1720, 720), (120, 190, 90))
        fields, errors = rs.read_spec(spec, fake_ask, lambda crop: "img", image=plain)
        self.assertEqual(fields, {"item": None, "facility": None, "facility_level": None, "time": None, "workload": None, "environment": None, "behind": None})
        self.assertEqual(asked, [])
        ImageDraw.Draw(plain).rectangle((820, 90, 1340, 360), fill=(70, 120, 230))
        fields, _ = rs.read_spec(spec, fake_ask, lambda crop: "img", image=plain)
        self.assertEqual(fields["item"], "Rose")
        self.assertEqual(len(asked), 2, "the card question and the one about a second card")


class SideQuestionsTest(unittest.TestCase):
    """Milestone 10: the side questions for screens no frame has shown, their gates and fixed rules."""

    ROOT = Path(__file__).resolve().parent.parent

    def test_known_names_give_each_facilitys_category_and_the_aux_facilities(self):
        names = rs.known_names(self.ROOT)
        self.assertEqual(names["categories"]["Farmland"], "Materials")
        self.assertEqual(names["categories"]["Chimney Kiln"], "Materials Processing")
        self.assertEqual(names["categories"]["Starfall Hammock"], "Aniimo Materials")
        self.assertEqual(set(names["categories"]), set(names["facilities"]), "every facility has its category")
        self.assertEqual(names["aux"], ["Crackle Generator", "Storage Unit"])

    def test_every_spec_states_tested_and_the_default_is_untested(self):
        for kind, spec in rs.SCREEN_KINDS.items():
            self.assertIn(spec.get("tested"), (True, False), f"{kind} states tested explicitly")
        self.assertFalse(rs.is_tested("no_such_kind"), "one default: untested")
        self.assertTrue(rs.is_tested("facility") and rs.is_tested("facility_detail"))

    def test_every_spec_written_without_a_frame_is_marked_untested(self):
        for kind in ("level_up", "pairs", "manage", "store", "emode", "food", "rv", "modules", "aniimo"):
            self.assertIs(rs.SCREEN_KINDS[kind].get("tested"), False, kind)
        for kind in ("facility_detail", "item_card", "stock", "home"):
            self.assertIs(rs.SCREEN_KINDS[kind].get("tested"), True, kind)
        self.assertIn("'Food'", rs.SCREEN_KINDS["facility_detail"]["prompt"], "Food is in the tab list")
        self.assertEqual(rs.screen_kind(Path("level_up-20990101-000000.png")), "level_up")
        self.assertEqual(rs.screen_kind(Path("food-20990101-000000.png")), "food")

    def ask_on(self, panel, names):
        """read_spec on a facility_detail answer; returns (fields, the side kinds asked)."""
        asked = []
        detail = rs.SCREEN_KINDS["facility_detail"]
        side = {id(rs.SCREEN_KINDS[k]["schema"]): k for k in ("level_up", "pairs", "manage", "store", "emode", "food")}
        answers = {"level_up": {"max_level": False, "next_level": 3, "coin_cost": "75 000", "rv_required": 14, "material_1_name": None,
                                "material_1_amount": None, "material_2_name": None, "material_2_amount": None},
                   "pairs": {"label_1": "Power Capacity", "value_1": "450/600 W", "label_2": None, "value_2": None, "label_3": "Supply rate",
                             "value_3": "100%", "label_4": None, "value_4": None, "supply_mode": None},
                   "manage": {"slots_total": 1, "slots_empty": 0, "first_name": "Sparky", "first_ability": "Fire", "emode_on": False},
                   "store": {"label": None, "held": 3, "cap": 5}, "emode": {"switch_visible": False, "emode_on": None, "power_draw": None},
                   "food": {"total_food_energy": "9 370", "working_aniimo": 2}}

        def fake_ask(prompt, schema, image_b64):
            if id(schema) in side:
                asked.append(side[id(schema)])
                return dict(answers[side[id(schema)]])
            if schema is detail["follow_up"]["schema"]:
                return {"facility_level": None, "rv_level": None}
            if schema is detail["schema"]:
                return dict(panel)
            return {k: None for k in schema["properties"]}
        fields, errors = rs.read_spec(detail, fake_ask, lambda crop: "img", names)
        self.assertEqual(errors, {})
        return fields, asked

    def test_only_if_routes_each_side_question_to_its_tab_and_facility(self):
        names = rs.known_names(self.ROOT)
        panel = {"facility": "Chimney Kiln", "level": 2, "tab": "Formula", "recipe_status": "not set", "recipe": None, "recipe_time": None,
                 "recipes_per_level": [], "coins": "182 204"}
        cases = [
            ({}, []),                                                           # a processor's Formula tab: nothing extra
            ({"tab": "Level Up"}, ["level_up"]),
            ({"tab": "Manage"}, ["manage", "emode"]),                           # a processor's Manage tab: workers and E-mode
            ({"tab": "Food"}, ["food"]),
            ({"facility": "Farmland"}, ["store"]),                              # a grower's Formula tab: its store
            ({"facility": "Farmland", "tab": "Manage"}, ["manage"]),            # no E-mode on a plot
            ({"facility": "Well", "tab": "Manage"}, ["manage", "emode"]),       # the Well and the Mine have E-mode rows
            ({"facility": "Crackle Generator", "tab": "Details"}, ["pairs"]),   # an aux panel
            ({"facility": "Crackle Generator", "tab": "Level Up"}, ["level_up"]),
            ({"tab": None}, []),
        ]
        for change, want in cases:
            fields, asked = self.ask_on({**panel, **change}, names)
            self.assertEqual(asked, want, change)
            for field in ("level_up", "pairs", "manage", "store", "emode", "food"):
                self.assertEqual(field in fields, field in want, f"{change}: a side question not asked leaves no field")
        fields, _ = self.ask_on({**panel, "tab": "Level Up"}, names)
        self.assertEqual(fields["level_up"]["coin_cost"], "75 000")
        fields, _ = self.ask_on({**panel, "facility": "Crackle Generator", "tab": "Details"}, names)
        self.assertEqual({k: fields["pairs"][k] for k in ("capacity", "in_use", "supply_rate")}, {"capacity": 600, "in_use": 450, "supply_rate": 100})
        fields, _ = self.ask_on({**panel, "facility": "Well", "tab": "Manage"}, names)
        self.assertEqual(fields["emode"], {"switch_visible": False, "emode_on": None, "power_draw": None}, "'no switch' is an answer, kept")

    def test_the_fixed_rules(self):
        up = {"max_level": False, "next_level": 2, "coin_cost": "182 204", "rv_required": 10}
        out = rs.rule_level_up(up, {"coins": "182 204", "level": 2})
        self.assertIsNone(out["coin_cost"], "a cost equal to the Home Coins balance is cleared")
        self.assertIsNone(out["next_level"], "next_level must exceed the panel's level")
        out = rs.rule_level_up({**up, "coin_cost": "16 300", "next_level": 3}, {"coins": "182 204", "level": 2})
        self.assertEqual((out["coin_cost"], out["next_level"]), ("16 300", 3))
        self.assertEqual(rs.rule_level_up(up, None)["coin_cost"], "182 204", "nothing to compare with on its own")
        rv = rs.rule_rv({"rv": 12, "coins": "320 000", "title": "Homeland", "next_rv_cost": "320 000"})
        self.assertIsNone(rv["coins"], "on the RV screen a balance equal to the next RV cost is the cost read twice")
        self.assertEqual(rs.rule_rv({"rv": 12, "coins": "5 000", "next_rv_cost": "320 000"})["coins"], "5 000")
        self.assertEqual(rs.rule_rv({"rv": 3, "coins": 10}), {"rv": 3, "coins": 10}, "an answer without the new fields is unchanged")
        pairs = rs.rule_pairs({"label_1": "Power Capacity", "value_1": "600 W", "label_2": "Power in use", "value_2": "450 W",
                               "label_3": "Supply Rate", "value_3": "120%", "label_4": "Level", "value_4": "2", "supply_mode": None})
        self.assertEqual((pairs["capacity"], pairs["in_use"], pairs["supply_rate"]), (600, 450, 120))
        self.assertEqual((pairs["label_4"], pairs["value_4"]), ("Level", "2"), "the raw pairs are kept")
        mode = rs.rule_pairs({**{f"label_{i}": None for i in range(1, 5)}, **{f"value_{i}": None for i in range(1, 5)}, "supply_mode": "100%"})
        self.assertEqual(mode["supply_rate"], 100, "the selected supply setting stands in for an unread rate")
        self.assertEqual([rs.pair_role(x) for x in ("Supply rate", "Power used", "Max capacity", "Level")], ["supply_rate", "in_use", "capacity", None])
        self.assertFalse(rs.key_present(rs.SCREEN_KINDS["level_up"], {"max_level": False, "next_level": None, "coin_cost": None, "rv_required": None}))
        self.assertTrue(rs.key_present(rs.SCREEN_KINDS["level_up"], {"max_level": True, "next_level": None, "coin_cost": None, "rv_required": None}))

    def test_the_skeleton_is_unchecked_and_only_checked_entries_are_scored(self):
        screens = [{"file": f"facility-2099010{i}-000000.png", "kind": "facility", "seconds": 1.0,
                    "fields": {"facility": "Chimney Kiln", "level": 2, "level_up": {"coin_cost": "75 000", "next_level": 3}}} for i in range(1, 7)]
        screens.append({"file": "facility-20990109-000000.png", "kind": "facility", "fields": None, "error": "timeout"})
        skeleton = rs.skeleton(screens)
        self.assertEqual(len(skeleton), 6, "a failed frame has no entry")
        self.assertTrue(all(entry["checked"] is False for entry in skeleton.values()))
        self.assertEqual(rs.score(screens, skeleton), [], "nothing counts until it is checked")
        expected = json.loads(json.dumps(skeleton))
        for name in list(expected)[:5]:
            expected[name]["checked"] = True
        expected["facility-20990101-000000.png"]["level_up"]["coin_cost"] = "81 000"  # the owner's correction: the model was wrong here
        rows = rs.score(screens, expected)
        self.assertEqual(len(rows), 5)
        self.assertNotIn("checked", rows[0]["wrong"])
        gate = rs.gate_report(rows)
        self.assertEqual((gate["level_up"]["frames"], gate["level_up"]["correct"], gate["level_up"]["total"]), (5, 9, 10))
        self.assertTrue(gate["level_up"]["passes"], "9 of 10 values on 5 frames is 90%: the bar")
        self.assertFalse(gate["level_up"]["tested"])
        self.assertTrue(gate["facility_detail"]["passes"] and gate["facility_detail"]["tested"])
        four = {k: v for k, v in list(expected.items())[:4]}
        self.assertFalse(rs.gate_report(rs.score(screens, four))["level_up"]["passes"], "fewer than 5 frames never pass")
        self.assertEqual(rs.score(screens, {"facility-20990101-000000.png": {"facility": "Chimney Kiln"}})[0]["correct"], 1,
                         "a hand-written entry without the key counts as checked")


if __name__ == "__main__":
    unittest.main()

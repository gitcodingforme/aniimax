"""Tests for verify_data.py with made-up observations. Run from the repository root:
    python -m unittest discover -s scripts -p "test_*.py"
"""
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import verify_data as vd  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


def unlock(facility, fl, rv, frame="facility-20261015-100000.png", t="2026-10-15T10:00:00Z"):
    return {"t": t, "frame": frame, "facility": facility, "level": 2, "fact": "unlock", "facility_level": fl, "rv_level": rv}


def recipe(facility, name, time_text, frame="facility-20261015-100100.png", t="2026-10-15T10:01:00Z"):
    return {"t": t, "frame": frame, "facility": facility, "level": 2, "fact": "recipe", "recipe": name, "time": time_text}


def card(facility, item, level, time_text=None, seconds=None, workload=None, environment=None, frame="stock-20261015-105144.png", t="2026-10-15T15:51:44Z", **extra):
    return {"t": t, "frame": frame, "facility": facility, "fact": "card", "item": item, "facility_level": level, "time": time_text,
            "time_seconds": seconds if seconds is not None else vd.parse_seconds(time_text), "workload": workload, "environment": environment, **extra}


def make_root(tmp: Path) -> Path:
    """A copy of the real facility config and data (so the checks run on real names), in a temp folder."""
    root = tmp / "repo"
    (root / "web").mkdir(parents=True)
    shutil.copy(ROOT / "web" / "facility-config.js", root / "web" / "facility-config.js")
    shutil.copytree(ROOT / "data", root / "data", ignore=shutil.ignore_patterns("overrides"))
    (root / "data" / "overrides").mkdir()
    return root


def run_with(root: Path, observations: list[dict], **kw) -> dict:
    log = root / "screenshots" / "observations.jsonl"
    log.parent.mkdir(exist_ok=True)
    log.write_text("".join(json.dumps(o) + "\n" for o in observations), encoding="utf-8")
    return vd.run(root, log, root / "screenshots" / "verification.md", root / "screenshots" / "verification.json", **kw)


class VerifyDataTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = make_root(Path(self._tmp.name))

    def report(self) -> str:
        return (self.root / "screenshots" / "verification.md").read_text(encoding="utf-8")

    def test_the_unlock_table_comes_from_the_site_config(self):
        files, unlocks = vd.load_facilities(self.root)
        self.assertEqual(files["Chimney Kiln"], "chimney_kiln.csv")
        self.assertEqual(files["Tidewhisper Sandcastle"], "tidewhisper_sandcastle.csv")
        self.assertEqual(unlocks["Chimney Kiln"][3], 14)
        self.assertEqual(unlocks["Simmering Pot"][5], 15)
        self.assertEqual(unlocks["Heat Furnace"], {1: 7}, "a one-level facility still has its entry")

    def test_agree_disagree_unknown_and_listed_times(self):
        summary = run_with(self.root, [
            unlock("Chimney Kiln", 3, 14),                                   # agree
            unlock("Chimney Kiln", 4, 19),                                   # unclear: off by one (table: RV 18), one frame
            unlock("Chimney Kiln", 4, 21),                                   # disagree: off by three
            unlock("Not A Facility", 2, 5),                                  # unknown facility
            unlock("Chimney Kiln", 9, 40),                                   # unknown level
            recipe("Chimney Kiln", "coarse_sifted_ore", "2s"),               # agree
            recipe("Chimney Kiln", "wheatmeal", "35s"),                      # disagree: it is a Carousel Mill recipe
            recipe("Chimney Kiln", "wood_block", None),                      # unknown: an ingredient, not a recipe row
        ])
        self.assertEqual((summary["observations"], summary["agree"], summary["disagree"], summary["unclear"], summary["unknown"]), (8, 2, 2, 1, 3))
        self.assertEqual(summary["format"], "aniimax-verification")
        self.assertEqual(summary["report"], "screenshots/verification.md")
        text = self.report()
        self.assertTrue(text.startswith("# Game data check\n"))
        self.assertEqual(len([l for l in text.splitlines()[:8] if l.startswith("- ")]), 5, "a 5-line summary comes first")
        self.assertIn("Screens observed: 2 (8 facts: 8 from facility panels, 0 from item cards)", text)
        self.assertIn("Last observation: 2026-10-15T10:01:00Z", text)
        self.assertIn("screen: Lv.4 needs RV 21; table says RV 18", text)
        unclear = text.split("## Unclear")[1].split("## Unknown")[0]
        self.assertIn("screen: Lv.4 needs RV 19; table says RV 18; off by one in a single frame: open the panel again", unclear)
        self.assertIn("Disagree with the data: 2 (plus 1 unclear", text)
        self.assertIn("carousel_mill.csv", text)
        self.assertIn("a row of chimney_kiln.csv", text)
        listed = text.split("## Seen, not comparable")[1]
        self.assertIn("| Chimney Kiln | coarse_sifted_ore | 2s |", listed)
        self.assertIn("| Chimney Kiln | wheatmeal | 35s |", listed, "times are listed, never judged")

    def test_the_proposed_override_fragment_is_correct_and_nothing_is_applied(self):
        run_with(self.root, [unlock("Simmering Pot", 5, 16, frame="facility-20261015-101010.png"),
                             unlock("Simmering Pot", 5, 16, frame="facility-20261015-101011.png")])  # off by one: two frames make it a disagreement
        text = self.report()
        fenced = text.split("```json")[1].split("```")[0]
        # the whole table, with level 5 corrected, because the site replaces the table with the override
        self.assertEqual(json.loads(fenced), {"facilities": {"Simmering Pot": {"unlocks": {"1": 5, "2": 7, "3": 9, "4": 12, "5": 16, "6": 18}}}})
        self.assertIn("facility-20261015-101010.png", text.split("```")[0])
        self.assertIn("2026-10-15", text.split("```")[0])
        self.assertFalse((self.root / "data" / "overrides" / "structure.json").exists(), "the report never writes the overrides")

    def test_a_deliberately_wrong_unlock_in_the_config_shows_up_as_a_disagreement(self):
        config = self.root / "web" / "facility-config.js"
        text = config.read_text(encoding="utf-8")
        wrong = text
        start = wrong.index("name: 'Chimney Kiln'")
        end = wrong.index("unlocks:", start)
        marker = wrong.index("3: 14", end)
        wrong = wrong[:marker] + "3: 13" + wrong[marker + len("3: 14"):]
        config.write_text(wrong, encoding="utf-8")
        summary = run_with(self.root, [unlock("Chimney Kiln", 3, 14), unlock("Chimney Kiln", 3, 14, frame="facility-20261015-100001.png")])
        self.assertEqual((summary["agree"], summary["disagree"]), (0, 2), "off by one, seen in two frames: a disagreement")
        fenced = self.report().split("```json")[1].split("```")[0]
        self.assertEqual(json.loads(fenced), {"facilities": {"Chimney Kiln": {"unlocks": {"1": 6, "2": 10, "3": 14, "4": 18}}}})
        self.assertIn("table says RV 13", self.report())

    def test_the_structure_override_wins_over_the_site_config(self):
        (self.root / "data" / "overrides" / "structure.json").write_text(
            json.dumps({"facilities": {"Chimney Kiln": {"unlocks": {"3": 13}}, "Mine": {"unlocks": {"7": 21}}}}), encoding="utf-8")
        summary = run_with(self.root, [unlock("Chimney Kiln", 3, 13), unlock("Chimney Kiln", 3, 14), unlock("Mine", 7, 21), unlock("Chimney Kiln", 2, 10)])
        self.assertEqual((summary["agree"], summary["disagree"], summary["unclear"], summary["unknown"]), (2, 0, 1, 1),
                         "the override replaces the table, as the site does: 3 -> 13 agrees, 14 is one off in one frame (unclear), Mine's new level agrees, and Chimney Kiln's level 2 is no longer in the table")

    def test_conflicting_sightings_of_one_line_are_flagged_and_disagreements_warn(self):
        summary = run_with(self.root, [unlock("Carousel Mill", 4, 13), unlock("Carousel Mill", 4, 12, frame="facility-20261015-100500.png"),
                                       unlock("Carousel Mill", 4, 12, frame="facility-20261015-100501.png")])
        self.assertEqual((summary["agree"], summary["disagree"]), (1, 2))
        text = self.report()
        self.assertIn("conflicting sightings of this line: RV 12, 13", text)
        self.assertIn("read the line yourself before pasting", text)

    def test_a_bad_override_is_skipped_like_the_site_skips_it(self):
        (self.root / "data" / "overrides" / "structure.json").write_text(
            json.dumps({"facilities": {"Chimney Kiln": {"unlocks": {"3": "13"}}, "Nowhere": {"unlocks": {"1": 1}}, "Mine": {"unlocks": []}}}), encoding="utf-8")
        _, unlocks = vd.load_facilities(self.root)
        self.assertEqual(vd.apply_structure_overrides(self.root, unlocks), unlocks, "a string RV, an unknown facility and a list change nothing")

    def test_partial_or_odd_observation_lines_are_skipped(self):
        path = self.root / "screenshots" / "observations.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n".join([
            json.dumps({"facility": "Chimney Kiln", "fact": "unlock", "facility_level": 3}),
            json.dumps({"facility": "Chimney Kiln", "fact": "unlock", "facility_level": [3], "rv_level": 14}),
            json.dumps({"facility": "Chimney Kiln", "fact": "recipe"}),
            json.dumps({"facility": "Chimney Kiln", "fact": "unlock", "facility_level": 3, "rv_level": 14}),
        ]) + "\n", encoding="utf-8")
        self.assertEqual(len(vd.load_observations(path)), 1)

    def test_a_seasonal_recipe_of_that_facility_agrees_and_says_so(self):
        seasonal = self.root / "data" / "harvest_moon_festival.csv"
        rows = vd.read_rows(seasonal)
        pick = next(r for r in rows if r["facility"] != "Farmland")
        files, _ = vd.load_facilities(self.root)
        own, _ = vd.load_recipes(self.root, files)
        if pick["name"] in own.get(pick["facility"], set()):
            self.skipTest("this seasonal recipe is also a regular row")
        run_with(self.root, [recipe(pick["facility"], pick["name"], "10s")])
        self.assertIn(f"a seasonal row of harvest_moon_festival.csv", self.report())

    def test_bad_lines_and_a_missing_log_are_survived(self):
        log = self.root / "screenshots" / "observations.jsonl"
        log.parent.mkdir()
        log.write_text('not json\n{"fact": "unlock"}\n' + json.dumps(unlock("Chimney Kiln", 3, 14)) + "\n", encoding="utf-8")
        summary = vd.run(self.root, log, self.root / "screenshots" / "verification.md", self.root / "screenshots" / "verification.json")
        self.assertEqual(summary["observations"], 1)
        empty = vd.run(self.root, self.root / "screenshots" / "nothing.jsonl", self.root / "screenshots" / "v2.md", self.root / "screenshots" / "v2.json")
        self.assertEqual(empty["observations"], 0)
        self.assertIn("Last observation: none yet", (self.root / "screenshots" / "v2.md").read_text(encoding="utf-8"))

    def test_the_json_summary_is_copied_for_the_site(self):
        web_json = self.root / "web" / "verification.json"
        run_with(self.root, [unlock("Chimney Kiln", 3, 14)], web_json=web_json)
        data = json.loads(web_json.read_text(encoding="utf-8"))
        self.assertEqual({k: data[k] for k in ("format", "version", "observations", "agree", "disagree", "unknown")},
                         {"format": "aniimax-verification", "version": 1, "observations": 1, "agree": 1, "disagree": 0, "unknown": 0})
        self.assertEqual(data, json.loads((self.root / "screenshots" / "verification.json").read_text(encoding="utf-8")))

    def test_the_real_repo_table_agrees_with_the_five_unlock_lines_seen_on_screen(self):
        files, unlocks = vd.load_facilities(ROOT)
        unlocks = vd.apply_structure_overrides(ROOT, unlocks)
        for name, fl, rv in [("Chimney Kiln", 3, 14), ("Simmering Pot", 5, 15), ("Joy Wheel Loom", 3, 15), ("Blazing Stove", 3, 13), ("Pickling Jar", 3, 13)]:
            self.assertEqual(unlocks[name][fl], rv, name)

    def test_parse_seconds_reads_the_games_time_format(self):
        self.assertEqual(vd.parse_seconds("40m 0s"), 2400)
        self.assertEqual(vd.parse_seconds("1m 48s"), 108)
        self.assertEqual(vd.parse_seconds("54s"), 54)
        self.assertEqual(vd.parse_seconds("1h 2m"), 3720)
        self.assertEqual(vd.parse_seconds("Time 2m 42s"), 162)
        self.assertIsNone(vd.parse_seconds("162"))
        self.assertIsNone(vd.parse_seconds(None))

    def test_item_cards_are_judged_column_by_column(self):
        summary = run_with(self.root, [
            card("Farmland", "rose", 4, "40m 0s", environment="Cool"),                                  # agree on level, time and environment
            card("Simmering Pot", "rose_concentrate", 2, "1m 48s"),                                     # processor: level judged, time listed
            card("Bouncy Brew Keg", "ginseng_water", 3, workload=162),                                  # a card that says Workload is judged
            card("Blazing Stove", "moondew_radish_slices", 1, "2m 42s"),                                # a seasonal row
            card("Farmland", "rose", 5, "41m 0s", environment="Warm", frame="x.png"),                   # disagree on three columns
            card("Farmland", "wheatmeal", 1, "54s", frame="x.png"),                                     # disagree: a Carousel Mill recipe
            card("Farmland", "moon_cheese", 1, "54s", frame="x.png"),                                   # unknown item
            card("Not A Facility", "rose", 4, "40m 0s", frame="x.png"),                                 # unknown facility
            card("Simmering Pot", "rose_concentrate", 2, "1m 48s", frame="y.png", behind=True),         # a half-hidden card
        ])
        self.assertEqual((summary["observations"], summary["agree"], summary["disagree"], summary["unknown"]), (9, 5, 2, 2))
        self.assertEqual(summary["cards"], {"seen": 9, "agree": 5, "disagree": 2, "unknown": 2, "unverified_confirmed": [], "unverified_total": 3})
        text = self.report()
        self.assertIn("Screens observed: 3 (9 facts: 0 from facility panels, 9 from item cards)", text)
        cards = text.split("## Item cards")[1].split("## Seen, not comparable")[0]
        self.assertIn("| rose | Farmland | 4 | 40m 0s | Cool | agree | a row of farmland.csv: facility_level 4 (data: 4); production_time 2400 (data: 2400); environment Cool (data: Cool) |", cards)
        self.assertIn("| rose_concentrate | Simmering Pot | 2 | 1m 48s |  | agree | a row of simmering_pot.csv: facility_level 2 (data: 2) |", cards)
        self.assertIn("| ginseng_water | Bouncy Brew Keg | 3 | Workload 162 |  | agree | a row of bouncy_brew_keg.csv: facility_level 3 (data: 3); workload 162 (data: 162) |", cards)
        self.assertIn("a row of harvest_moon_festival.csv: facility_level 1 (data: 1)", cards)
        self.assertIn("the data has wheatmeal under carousel_mill.csv, not farmland.csv", cards)
        self.assertIn("moon_cheese is not a row of farmland.csv", cards)
        self.assertIn("| rose | Not A Facility | 4 | 40m 0s |  | unknown | facility not in the table |", cards)
        self.assertIn("half-hidden card", cards)
        fenced = cards.split("```csv")[1].split("```")[0].strip().splitlines()
        self.assertEqual(fenced, ["file, match, column, value, upstream_value, verified_on, note",
                                  "farmland.csv, rose, facility_level, 5, 4, 2026-10-15, seen on the item card in x.png",
                                  "farmland.csv, rose, production_time, 2460, 2400, 2026-10-15, seen on the item card in x.png",
                                  "farmland.csv, rose, environment, Warm, Cool, 2026-10-15, seen on the item card in x.png"])
        self.assertIn("read the line yourself before pasting", cards)
        self.assertFalse((self.root / "data" / "overrides" / "values.csv").exists(), "the report never writes the overrides")
        self.assertIn("| scales | Floral Windmill | not seen on a card yet |", cards)

    def test_a_deliberately_wrong_csv_cell_shows_up_with_the_right_override_row(self):
        farm = self.root / "data" / "farmland.csv"
        text = farm.read_text(encoding="utf-8")
        self.assertIn("rose, 21, 39, 2400,", text)
        farm.write_text(text.replace("rose, 21, 39, 2400,", "rose, 21, 39, 2460,"), encoding="utf-8")
        summary = run_with(self.root, [card("Farmland", "rose", 4, "40m 0s", environment="Cool")])
        self.assertEqual((summary["agree"], summary["disagree"]), (0, 1))
        report = self.report()
        self.assertIn("screen: production_time 2400; farmland.csv says 2460", report)
        self.assertIn("farmland.csv, rose, production_time, 2400, 2460, 2026-10-15, seen on the item card in stock-20261015-105144.png", report)

    def test_unverified_rows_are_confirmed_only_by_a_complete_front_card(self):
        summary = run_with(self.root, [
            card("Starfall Hammock", "star", 1, "45m 0s", environment="Cool"),                 # every column the data holds: confirmed
            card("Floral Windmill", "scales", 1, "45m 0s"),                                      # environment not read: seen, not confirmed
            card("Floral Windmill", "quick_scales", 1, "45m 0s", environment="Adequate", behind=True),  # half hidden: not confirmed
        ])
        self.assertEqual(summary["cards"]["unverified_confirmed"], ["star"])
        rows = self.report().split("### Rows of data/unverified.csv")[1].split("## Seen, not comparable")[0]
        self.assertIn("| star | Starfall Hammock | confirmed: a row of starfall_hammock.csv: facility_level 1 (data: 1); environment Cool (data: Cool) |", rows)
        self.assertIn("| scales | Floral Windmill | seen, not confirmed (agree): a row of floral_windmill.csv: facility_level 1 (data: 1); environment not read (data: Adequate) |", rows)
        self.assertIn("| quick_scales | Floral Windmill | seen, not confirmed (agree):", rows)

    def write_emode(self, rows: list[tuple[str, str, str]]) -> None:
        path = self.root / "data" / "overrides" / "emode_times.csv"
        path.write_text("item, facility, emode_seconds, source, fetched_on\n# a comment line\n"
                        + "".join(f"{i}, {f}, {sec}, test, 2026-10-16\n" for i, f, sec in rows), encoding="utf-8")

    def test_a_processor_cards_time_is_judged_against_the_emode_table(self):
        self.write_emode([("wheatmeal", "Carousel Mill", "54"), ("cider_vinegar", "Pickling Jar", "54"), ("rose", "Farmland", "99"),
                          ("ginseng_water", "Bouncy Brew Keg", "108"), ("moondew_radish_slices", "Blazing Stove", "162"), ("tofu", "Carousel Mill", "x")])
        self.assertEqual(vd.load_emode_times(self.root)[("Carousel Mill", "wheatmeal")], 54)
        self.assertNotIn(("Carousel Mill", "tofu"), vd.load_emode_times(self.root), "a row without a whole number of seconds is skipped")
        summary = run_with(self.root, [
            card("Carousel Mill", "wheatmeal", 1, "54s"),                                   # agree: time = E-mode base time
            card("Blazing Stove", "moondew_radish_slices", 1, "2m 42s"),                    # agree: a seasonal row with an E-mode row
            card("Pickling Jar", "cider_vinegar", 2, "1m 48s", frame="x.png"),              # disagree: table says 54
            card("Simmering Pot", "rose_concentrate", 2, "1m 48s"),                         # no E-mode row: time listed, as before
            card("Bouncy Brew Keg", "ginseng_water", 3, workload=162),                      # a Workload card stays a workload judgement
            card("Farmland", "rose", 4, "40m 0s", environment="Cool"),                      # a crop is judged on production_time, never E-mode
        ])
        self.assertEqual((summary["observations"], summary["agree"], summary["disagree"], summary["unknown"]), (6, 5, 1, 0))
        cards = self.report().split("## Item cards")[1].split("## Seen, not comparable")[0]
        self.assertIn("| wheatmeal | Carousel Mill | 1 | 54s |  | agree | a row of carousel_mill.csv: facility_level 1 (data: 1); emode_seconds 54 (data: 54) |", cards)
        self.assertIn("| moondew_radish_slices | Blazing Stove | 1 | 2m 42s |  | agree | a row of harvest_moon_festival.csv: facility_level 1 (data: 1); emode_seconds 162 (data: 162) |", cards)
        self.assertIn("| cider_vinegar | Pickling Jar | 2 | 1m 48s |  | disagree | screen: emode_seconds 108; pickling_jar.csv says 54 |", cards)
        self.assertIn("| rose_concentrate | Simmering Pot | 2 | 1m 48s |  | agree | a row of simmering_pot.csv: facility_level 2 (data: 2) |", cards)
        self.assertIn("| ginseng_water | Bouncy Brew Keg | 3 | Workload 162 |  | agree | a row of bouncy_brew_keg.csv: facility_level 3 (data: 3); workload 162 (data: 162) |", cards)
        self.assertIn("production_time 2400 (data: 2400)", cards)
        self.assertNotIn("emode_seconds 2400", cards)
        self.assertIn("E-mode base time", cards)
        fenced = cards.split("```csv")[1].split("```")[0].strip().splitlines()
        self.assertEqual(fenced, ["item, facility, emode_seconds, source, fetched_on",
                                  "cider_vinegar, Pickling Jar, 108, seen on the item card in x.png (table said 54), 2026-10-15"])
        self.assertIn("replaces that item's row in data/overrides/emode_times.csv", cards)
        self.assertNotIn("Proposed row(s) for data/overrides/values.csv", cards, "an E-mode disagreement is not a values.csv row")
        self.assertEqual(vd.load_emode_times(self.root)[("Pickling Jar", "cider_vinegar")], 54, "the report never writes the table")

    def test_a_processor_card_whose_time_could_not_be_parsed_is_not_complete(self):
        self.write_emode([("wheatmeal", "Carousel Mill", "54")])
        verdict = vd.judge(vd.load_observations(self.write_log([card("Carousel Mill", "wheatmeal", 1, "fifty-four")])),
                           *self.tables())[0]
        self.assertEqual(verdict["status"], "agree")
        self.assertFalse(verdict["complete"])
        self.assertIn("emode_seconds not read (data: 54)", verdict["detail"])

    def write_log(self, observations: list[dict]) -> Path:
        log = self.root / "screenshots" / "observations.jsonl"
        log.parent.mkdir(exist_ok=True)
        log.write_text("".join(json.dumps(o) + "\n" for o in observations), encoding="utf-8")
        return log

    def tables(self) -> tuple:
        files, unlocks = vd.load_facilities(self.root)
        own, seasonal = vd.load_recipes(self.root, files)
        own_rows, seasonal_rows = vd.load_item_rows(self.root, files)
        return unlocks, files, own, seasonal, own_rows, seasonal_rows, vd.load_emode_times(self.root)

    def test_the_real_emode_table_matches_the_nine_cards_seen_on_screen(self):
        table = vd.load_emode_times(ROOT)
        self.assertGreater(len(table), 100)
        files, _ = vd.load_facilities(ROOT)
        own_rows, seasonal_rows = vd.load_item_rows(ROOT, files)
        for (facility, item) in table:
            self.assertIn(facility, files, item)
            self.assertTrue(item in own_rows.get(facility, {}) or item in seasonal_rows.get(facility, {}), f"{item} ({facility}) is not a fork row")
        for item, facility, seconds in [("wheatmeal", "Carousel Mill", 54), ("cotton_fabric", "Joy Wheel Loom", 54), ("cider_vinegar", "Pickling Jar", 54),
                                        ("plain_rice_porridge", "Simmering Pot", 108), ("rose_concentrate", "Simmering Pot", 108),
                                        ("ginseng_porridge", "Simmering Pot", 108), ("moondew_radish_slices", "Blazing Stove", 162),
                                        ("dried_ginseng", "Jukebox Dryer", 54), ("ginseng_water", "Bouncy Brew Keg", 108),
                                        ("coarse_sifted_ore", "Chimney Kiln", 27)]:
            self.assertEqual(table[(facility, item)], seconds, item)
        self.assertNotIn(("Starfall Hammock", "star"), table, "Leisure facilities have no E-mode")
        self.assertNotIn(("Farmland", "rose"), table, "plots have no E-mode")

    def test_card_lines_without_an_item_are_skipped_and_an_empty_log_says_no_card_yet(self):
        path = self.root / "screenshots" / "observations.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        lines = [json.dumps({"facility": "Farmland", "fact": "card", "facility_level": 4}), json.dumps(card("Farmland", "rose", 4, "40m 0s")), ""]
        path.write_text(chr(10).join(lines), encoding="utf-8")
        self.assertEqual(len(vd.load_observations(path)), 1)
        run_with(self.root, [unlock("Chimney Kiln", 3, 14)])
        self.assertIn("No item card seen yet", self.report())



class SummaryRowsTest(unittest.TestCase):
    """The per-value rows in verification.json, which the site's "How sure is this data?" card reads."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = make_root(Path(self._tmp.name))

    def test_rows_hold_no_frame_time_or_screen_value(self):
        summary = run_with(self.root, [
            card("Farmland", "rose", 4, "40m 0s", environment="Cool", frame="stock-secret-frame.png", t="2026-10-15T15:51:44Z"),
            card("Simmering Pot", "rose_concentrate", 2, "1m 48s", frame="stock-secret-frame.png"),   # time listed: no row for it
            unlock("Chimney Kiln", 3, 14, frame="facility-secret-frame.png", t="2026-10-14T09:08:07Z"),
            recipe("Chimney Kiln", "coarse_sifted_ore", "2s", frame="facility-secret-frame.png"),
            unlock("Not A Facility", 2, 5),                                                            # unknown: no row
        ])
        rows = summary["rows"]
        self.assertTrue(rows)
        for row in rows:
            self.assertEqual(set(row), {"facility", "item", "column", "key", "status", "day"}, row)
            self.assertRegex(row["day"], r"^\d{4}-\d{2}-\d{2}$")
        text = json.dumps(rows)
        for secret in ("secret-frame", "15:51", "09:08", "T1", "40m", "2400", "Cool", "1m 48s", '"14"', "frame", "screen"):
            self.assertNotIn(secret, text)
        self.assertIn({"facility": "Farmland", "item": "rose", "column": "production_time", "key": "", "status": "agree", "day": "2026-10-15"}, rows)
        self.assertIn({"facility": "Chimney Kiln", "item": "", "column": "unlock", "key": "3", "status": "agree", "day": "2026-10-14"}, rows)
        self.assertIn({"facility": "Chimney Kiln", "item": "coarse_sifted_ore", "column": "recipe", "key": "", "status": "agree", "day": "2026-10-15"}, rows)
        self.assertNotIn("facility", {r["column"] for r in rows}, "the facility column is never a row")
        self.assertNotIn("time", {r["column"] for r in rows}, "a listed column is never a row")
        self.assertNotIn("Not A Facility", {r["facility"] for r in rows})

    def test_a_value_seen_agreeing_and_disagreeing_becomes_a_conflict(self):
        summary = run_with(self.root, [
            card("Farmland", "rose", 4, "40m 0s", environment="Cool", t="2026-10-14T10:00:00Z"),
            card("Farmland", "rose", 4, "41m 0s", environment="Cool", t="2026-10-16T10:00:00Z"),   # production_time disagrees this time
            unlock("Carousel Mill", 4, 13), unlock("Carousel Mill", 4, 12, frame="facility-20261015-100500.png"),
            unlock("Carousel Mill", 4, 12, frame="facility-20261015-100501.png"),                  # a misread in two frames: one agrees, one does not
            unlock("Chimney Kiln", 4, 19), unlock("Chimney Kiln", 4, 19, frame="facility-20261016-080000.png", t="2026-10-16T08:00:00Z"),  # disagrees twice: stays disagree
            card("Farmland", "wheatmeal", 1, "54s"),                                               # another facility's row: a recipe disagreement
        ])
        by = {(r["facility"], r["item"], r["column"], r["key"]): r for r in summary["rows"]}
        self.assertEqual(by[("Farmland", "rose", "production_time", "")]["status"], "conflict")
        self.assertEqual(by[("Farmland", "rose", "production_time", "")]["day"], "2026-10-16", "the last day it was seen")
        self.assertEqual(by[("Farmland", "rose", "facility_level", "")]["status"], "agree")
        self.assertEqual(by[("Farmland", "rose", "environment", "")]["status"], "agree")
        self.assertEqual(by[("Carousel Mill", "", "unlock", "4")]["status"], "conflict")
        self.assertEqual(by[("Chimney Kiln", "", "unlock", "4")], {"facility": "Chimney Kiln", "item": "", "column": "unlock", "key": "4", "status": "disagree", "day": "2026-10-16"})
        self.assertEqual(by[("Farmland", "wheatmeal", "recipe", "")]["status"], "disagree")
        self.assertEqual(len(summary["rows"]), len(by), "one row per value")

    def test_the_web_copy_carries_the_rows_and_stays_version_1(self):
        web_json = self.root / "web" / "verification.json"
        run_with(self.root, [card("Bouncy Brew Keg", "ginseng_water", 3, workload=162), unlock("Chimney Kiln", 3, 14)], web_json=web_json)
        data = json.loads(web_json.read_text(encoding="utf-8"))
        self.assertEqual((data["format"], data["version"]), ("aniimax-verification", 1))
        self.assertEqual({(r["column"], r["status"]) for r in data["rows"]}, {("facility_level", "agree"), ("workload", "agree"), ("unlock", "agree")})
        self.assertEqual(data["rows"], json.loads((self.root / "screenshots" / "verification.json").read_text(encoding="utf-8"))["rows"])

    def test_summary_rows_survives_odd_verdicts(self):
        rows = vd.summary_rows([
            {"obs": {"fact": "card", "facility": "Farmland", "item": "rose", "t": "not a time"}, "status": "agree",
             "columns": [{"column": "facility_level", "screen": 4, "data": "4", "status": "agree"}]},
            {"obs": {"fact": "unlock", "facility": None, "facility_level": 2}, "status": "agree"},
            {"obs": {}, "status": "agree"},
        ])
        self.assertEqual(rows, [{"facility": "Farmland", "item": "rose", "column": "facility_level", "key": "", "status": "agree", "day": ""}])


def new_fact(fact, facility="", t="2099-01-01T00:00:00Z", frame="facility-20990101-000000.png", **values):
    return {"t": t, "frame": frame, "facility": facility, "fact": fact, "v": 2, "untested": True, **values}


class NewChecksTest(unittest.TestCase):
    """Milestone 10: unclear unlocks, upgrade costs and caps, the facts not judged yet, the questions block."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = make_root(Path(self._tmp.name))

    def report(self) -> str:
        return (self.root / "screenshots" / "verification.md").read_text(encoding="utf-8")

    def test_off_by_one_in_one_frame_is_unclear_two_frames_disagree_off_by_two_disagrees(self):
        summary = run_with(self.root, [
            unlock("Chimney Kiln", 3, 13, frame="facility-20990101-000000.png"),                                         # one off, one frame: unclear
            unlock("Chimney Kiln", 4, 19, frame="facility-20990101-000001.png"),                                         # one off ...
            unlock("Chimney Kiln", 4, 19, frame="facility-20990101-000002.png"),                                         # ... in two frames: disagree
            unlock("Simmering Pot", 5, 17, frame="facility-20990101-000003.png"),                                        # two off: disagree at once
            unlock("Joy Wheel Loom", 3, 16, frame="facility-20990101-000004.png"), unlock("Joy Wheel Loom", 3, 16, frame="facility-20990101-000004.png"),  # one frame twice: unclear
        ])
        self.assertEqual((summary["agree"], summary["disagree"], summary["unclear"], summary["unknown"]), (0, 3, 3, 0))
        text = self.report()
        unclear = text.split("## Unclear")[1].split("## Unknown")[0]
        self.assertIn("Lv.3 needs RV 13; table says RV 14; off by one in a single frame: open the panel again", unclear)
        disagree = text.split("## Disagree")[1].split("## Unclear")[0]
        self.assertNotIn("RV 13", disagree.replace("RV 13,", ""), "no override is proposed for an unclear line")
        fragments = [json.loads(f.split("```")[0]) for f in disagree.split("```json")[1:]]
        self.assertEqual([list(f["facilities"]) for f in fragments], [["Chimney Kiln"], ["Chimney Kiln"], ["Simmering Pot"]])
        self.assertNotIn("unlock", {r["column"] for r in summary["rows"] if r["facility"] == "Joy Wheel Loom"}, "unclear: no per-value row")
        self.assertEqual(len([l for l in text.splitlines()[:8] if l.startswith("- ")]), 5, "still a 5-line summary")

    def test_upgrade_costs_and_store_caps_are_judged_with_the_overrides(self):
        facts = [new_fact("level_up", "Chimney Kiln", level=2, next_level=3, coin_cost="75 000", rv_required=14, max_level=False, materials=[]),
                 new_fact("level_up", "Carousel Mill", level=3, next_level=4, coin_cost=None, rv_required=13, max_level=False, materials=[]),
                 new_fact("cap", "Farmland", level=1, held=5, cap=5),
                 new_fact("cap", "Woodland", level=2, held=3, cap=13)]
        run_with(self.root, facts)
        section = self.report().split("## Upgrade costs and store caps")[1].split("## Seen, not judged yet")[0]
        self.assertIn("| Chimney Kiln | upgrade cost | agree | Lv.3 costs 75000 (table says 75000) |", section)
        self.assertIn("| Carousel Mill | upgrade cost | listed |", section)
        self.assertIn("| Farmland | store cap | agree | Lv.1 holds 5 (table says 5) |", section)
        self.assertIn("| Woodland | store cap | disagree | screen: Lv.2 holds 13; table says 12 |", section)
        fenced = json.loads(section.split("```json")[1].split("```")[0])
        self.assertEqual(fenced, {"facilities": {"Woodland": {"outputCaps": [8, 13, 16, 20, 24, 28]}}}, "the whole list, as the site replaces it")
        (self.root / "data" / "overrides" / "structure.json").write_text(json.dumps({
            "upgradeCosts": {"Chimney Kiln": {"3": 80000}},
            "facilities": {"Farmland": {"outputCaps": [6, 10]}, "Woodland": {"outputCaps": [8, 13]}}}), encoding="utf-8")
        summary = run_with(self.root, facts)
        section = self.report().split("## Upgrade costs and store caps")[1].split("## Seen, not judged yet")[0]
        self.assertIn("| Chimney Kiln | upgrade cost | disagree | screen: Lv.3 costs 75000; table says 80000 |", section)
        self.assertIn('"upgradeCosts"', section)
        self.assertIn("| Farmland | store cap | disagree | screen: Lv.1 holds 5; table says 6 |", section)
        self.assertIn("| Woodland | store cap | agree |", section)
        self.assertEqual((summary["observations"], summary["agree"], summary["disagree"], summary["rows"]), (0, 0, 0, []),
                         "the new checks stay out of the counts and the site's rows")
        self.assertEqual(vd.load_upgrade_costs(self.root, vd.load_facilities(self.root)[0])["Chimney Kiln"], {2: 16300, 3: 80000, 4: 340000})

    def test_an_unlock_from_the_level_up_tab_is_judged_but_never_a_row_or_a_fragment(self):
        from_tab = {**unlock("Chimney Kiln", 4, 21), "v": 2, "untested": True, "source": "level_up"}
        summary = run_with(self.root, [from_tab, {**from_tab, "frame": "facility-20990101-000001.png"}, unlock("Chimney Kiln", 3, 14)])
        self.assertEqual((summary["disagree"], summary["agree"]), (2, 1), "still judged and counted")
        self.assertEqual([(r["key"], r["status"]) for r in summary["rows"] if r["column"] == "unlock"], [("3", "agree")], "no served row from an untested prompt")
        disagree = self.report().split("## Disagree")[1].split("## Unknown")[0]
        self.assertNotIn("```json", disagree, "no structure.json fragment")
        self.assertIn("No override is proposed: this line was read from the Level Up tab", disagree)

    def test_an_output_cap_override_for_an_unknown_facility_is_skipped(self):
        (self.root / "data" / "overrides" / "structure.json").write_text(json.dumps({
            "facilities": {"Moon Base": {"outputCaps": [1, 2]}, "Farmland": {"outputCaps": [6]}}}), encoding="utf-8")
        caps = vd.load_output_caps(self.root, vd.load_facilities(self.root)[0])
        self.assertNotIn("Moon Base", caps, "skipped, as web/overrides.js skips it")
        self.assertEqual(caps["Farmland"], {1: 6})
        self.assertEqual(caps["Well"], {1: 300, 2: 300, 3: 340, 4: 340, 5: 340}, "read by web_check's parser")

    def test_new_facts_stay_out_of_verdicts_and_rows(self):
        facts = [new_fact("panel", "Crackle Generator", level=2, tab="Details", capacity=600, in_use=450, supply_rate=120, supply_mode=None, pairs=[]),
                 new_fact("manage", "Chimney Kiln", level=2, slots_total=1, slots_empty=1, first_ability=None, named=False, emode_on=True),
                 new_fact("emode", "Well", level=1, switch_visible=False, emode_on=None, power_draw=None),
                 new_fact("food", total_food_energy="12 400", energy=12400, working_aniimo=3),
                 {**new_fact("tick", "Chimney Kiln", recipe="coarse_sifted_ore", time="2s", time_seconds=2), "untested": False},
                 new_fact("screen", screen="rv", read=True),
                 unlock("Chimney Kiln", 3, 14)]
        summary = run_with(self.root, facts)
        self.assertEqual((summary["observations"], summary["agree"]), (1, 1), "only the unlock is a verdict")
        self.assertEqual({r["column"] for r in summary["rows"]}, {"unlock"})
        self.assertEqual(len(vd.load_new_facts(self.root / "screenshots" / "observations.jsonl")), 6)
        seen = self.report().split("## Seen, not judged yet")[1].split("## Game questions")[0]
        self.assertIn("| panel | Crackle Generator | 2 | tab Details; capacity 600; in_use 450; supply_rate 120 |", seen)
        self.assertIn("| food |  |  | total_food_energy 12 400; working_aniimo 3 |", seen)
        self.assertIn("tick facts): 1.", seen)
        self.assertIn("(RV, modules, roster): rv.", seen)

    def test_a_processor_card_with_neither_time_nor_workload_is_not_complete(self):
        log = self.root / "screenshots" / "observations.jsonl"
        log.parent.mkdir(exist_ok=True)
        log.write_text(json.dumps(card("Bouncy Brew Keg", "ginseng_water", 3)) + "\n", encoding="utf-8")
        files, unlocks = vd.load_facilities(self.root)
        own, seasonal = vd.load_recipes(self.root, files)
        own_rows, seasonal_rows = vd.load_item_rows(self.root, files)
        verdict = vd.judge(vd.load_observations(log), unlocks, files, own, seasonal, own_rows, seasonal_rows, vd.load_emode_times(self.root))[0]
        self.assertEqual(verdict["status"], "agree")
        self.assertFalse(verdict["complete"])
        self.assertIn("workload not read (data: 162)", verdict["detail"])

    def test_the_json_summary_holds_only_question_counts(self):
        web_json = self.root / "web" / "verification.json"
        summary = run_with(self.root, [unlock("Carousel Mill", 4, 13, frame="facility-20990101-000000.png"),
                                       unlock("Carousel Mill", 4, 13, frame="facility-20990101-000001.png"),
                                       new_fact("food", total_food_energy="1 000", energy=1000, working_aniimo=1)], web_json=web_json)
        data = json.loads(web_json.read_text(encoding="utf-8"))
        self.assertEqual(set(data["questions"]), {"total", "answered", "evidence", "open"})
        self.assertTrue(all(type(v) is int for v in data["questions"].values()), data["questions"])
        self.assertEqual(data["questions"], {"total": 19, "answered": 1, "evidence": 1, "open": 17}, "CM answered by two frames, W1 has evidence")
        self.assertIs(type(data["unclear"]), int)
        self.assertEqual(data, summary)
        text = json.dumps(data)
        for word in ("CM", "W1", "Carousel Mill level 4", "1 000"):
            self.assertNotIn(word, text, "no question id, text or read value in the served file")
        questions = self.report().split("## Game questions")[1]
        self.assertIn("1 of 19 answered, 1 with evidence waiting for you, 17 open.", questions)
        self.assertIn("| CM | answered |", questions)
        status = {}
        run_with(self.root, [], question_status=status)
        self.assertEqual(len(status), 19)
        self.assertEqual(set(status.values()), {"open"})

    def test_questions_prints_the_table_and_writes_nothing(self):
        import contextlib
        import io
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(vd.main(["--root", str(self.root), "--questions"]), 0)
        lines = out.getvalue().splitlines()
        self.assertEqual(len([l for l in lines if l.split() and l.split()[1] in ("open", "evidence", "answered")]), 19)
        self.assertIn("0 of 19 answered, 0 with evidence waiting for you, 19 open.", out.getvalue())
        self.assertFalse((self.root / "screenshots" / "verification.md").exists())


if __name__ == "__main__":
    unittest.main()

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
            unlock("Chimney Kiln", 4, 19),                                   # disagree (table: RV 18)
            unlock("Not A Facility", 2, 5),                                  # unknown facility
            unlock("Chimney Kiln", 9, 40),                                   # unknown level
            recipe("Chimney Kiln", "coarse_sifted_ore", "2s"),               # agree
            recipe("Chimney Kiln", "wheatmeal", "35s"),                      # disagree: it is a Carousel Mill recipe
            recipe("Chimney Kiln", "wood_block", None),                      # unknown: an ingredient, not a recipe row
        ])
        self.assertEqual((summary["observations"], summary["agree"], summary["disagree"], summary["unknown"]), (7, 2, 2, 3))
        self.assertEqual(summary["format"], "aniimax-verification")
        self.assertEqual(summary["report"], "screenshots/verification.md")
        text = self.report()
        self.assertTrue(text.startswith("# Game data check\n"))
        self.assertEqual(len([l for l in text.splitlines()[:8] if l.startswith("- ")]), 5, "a 5-line summary comes first")
        self.assertIn("Screens observed: 2 (7 facts: 7 from facility panels, 0 from item cards)", text)
        self.assertIn("Last observation: 2026-10-15T10:01:00Z", text)
        self.assertIn("screen: Lv.4 needs RV 19; table says RV 18", text)
        self.assertIn("carousel_mill.csv", text)
        self.assertIn("a row of chimney_kiln.csv", text)
        listed = text.split("## Seen, not comparable")[1]
        self.assertIn("| Chimney Kiln | coarse_sifted_ore | 2s |", listed)
        self.assertIn("| Chimney Kiln | wheatmeal | 35s |", listed, "times are listed, never judged")

    def test_the_proposed_override_fragment_is_correct_and_nothing_is_applied(self):
        run_with(self.root, [unlock("Simmering Pot", 5, 16, frame="facility-20261015-101010.png")])
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
        summary = run_with(self.root, [unlock("Chimney Kiln", 3, 14)])
        self.assertEqual((summary["agree"], summary["disagree"]), (0, 1))
        fenced = self.report().split("```json")[1].split("```")[0]
        self.assertEqual(json.loads(fenced), {"facilities": {"Chimney Kiln": {"unlocks": {"1": 6, "2": 10, "3": 14, "4": 18}}}})
        self.assertIn("table says RV 13", self.report())

    def test_the_structure_override_wins_over_the_site_config(self):
        (self.root / "data" / "overrides" / "structure.json").write_text(
            json.dumps({"facilities": {"Chimney Kiln": {"unlocks": {"3": 13}}, "Mine": {"unlocks": {"7": 21}}}}), encoding="utf-8")
        summary = run_with(self.root, [unlock("Chimney Kiln", 3, 13), unlock("Chimney Kiln", 3, 14), unlock("Mine", 7, 21), unlock("Chimney Kiln", 2, 10)])
        self.assertEqual((summary["agree"], summary["disagree"], summary["unknown"]), (2, 1, 1),
                         "the override replaces the table, as the site does: 3 -> 13 agrees, 14 disagrees, Mine's new level agrees, and Chimney Kiln's level 2 is no longer in the table")

    def test_conflicting_sightings_of_one_line_are_flagged_and_disagreements_warn(self):
        summary = run_with(self.root, [unlock("Carousel Mill", 4, 13), unlock("Carousel Mill", 4, 12, frame="facility-20261015-100500.png")])
        self.assertEqual((summary["agree"], summary["disagree"]), (1, 1))
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

    def test_card_lines_without_an_item_are_skipped_and_an_empty_log_says_no_card_yet(self):
        path = self.root / "screenshots" / "observations.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        lines = [json.dumps({"facility": "Farmland", "fact": "card", "facility_level": 4}), json.dumps(card("Farmland", "rose", 4, "40m 0s")), ""]
        path.write_text(chr(10).join(lines), encoding="utf-8")
        self.assertEqual(len(vd.load_observations(path)), 1)
        run_with(self.root, [unlock("Chimney Kiln", 3, 14)])
        self.assertIn("No item card seen yet", self.report())


if __name__ == "__main__":
    unittest.main()

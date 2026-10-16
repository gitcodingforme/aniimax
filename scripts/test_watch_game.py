"""Tests for watch_game.py with fake frames and a fake model (no game, no Ollama needed). Run from the repository root:
    python -m unittest discover -s scripts -p "test_*.py"
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

try:
    from PIL import Image, ImageDraw
    HAS_PILLOW = True
except ImportError:  # the frame tests need Pillow; the pure-logic tests run anywhere
    HAS_PILLOW = False

sys.path.insert(0, str(Path(__file__).resolve().parent))
import watch_game as wg  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
needs_pillow = unittest.skipUnless(HAS_PILLOW, "Pillow is not installed")


def frame(colour, text=None):
    image = Image.new("RGB", (320, 180), colour)
    if text:
        ImageDraw.Draw(image).text((20, 20), text, fill=(255, 255, 255))
    return image


def card_frame(colour, header=(70, 120, 230)):
    """A frame with an item card's coloured header in the card strip (half the size of the real window),
    so the card gate lets the card question through."""
    image = Image.new("RGB", (1720, 720), colour)
    ImageDraw.Draw(image).rectangle((820, 90, 1340, 360), fill=header)
    return image


class WindowPickingTest(unittest.TestCase):
    def test_picks_the_game_not_a_browser_tab_or_terminal(self):
        windows = [
            {"hwnd": 1, "title": "Aniimo wiki - Google Chrome", "exe": "chrome.exe", "minimized": False, "rect": (0, 0, 1920, 1080)},
            {"hwnd": 2, "title": "Aniimo_Farmville - watch_game.py", "exe": "WindowsTerminal.exe", "minimized": False, "rect": (0, 0, 1000, 600)},
            {"hwnd": 3, "title": "Aniimo", "exe": "Aniimo.exe", "minimized": False, "rect": (0, 0, 3440, 1440)},
            {"hwnd": 4, "title": "Aniimo", "exe": "Aniimo.exe", "minimized": False, "rect": (0, 0, 100, 50)},
        ]
        self.assertEqual(wg.pick_window(windows, "Aniimo")["hwnd"], 3)
        self.assertEqual(wg.pick_window(windows, "aniimo", exe="aniimo.exe")["hwnd"], 3)
        self.assertIsNone(wg.pick_window(windows, "Aniimo", exe="Other.exe"))
        windows[2]["minimized"] = True
        self.assertIsNone(wg.pick_window(windows, "Aniimo"))

    def test_exact_title_beats_a_prefix(self):
        windows = [
            {"hwnd": 1, "title": "Aniimo Launcher", "exe": "launcher.exe", "minimized": False, "rect": (0, 0, 800, 600)},
            {"hwnd": 2, "title": "Aniimo", "exe": "game.exe", "minimized": False, "rect": (0, 0, 800, 600)},
        ]
        self.assertEqual(wg.pick_window(windows, "Aniimo")["hwnd"], 2)


class FrameLogicTest(unittest.TestCase):
    @needs_pillow
    def test_difference_is_zero_for_the_same_picture_and_large_for_different_ones(self):
        a, b = wg.fingerprint(frame((20, 20, 20))), wg.fingerprint(frame((200, 200, 200)))
        self.assertEqual(wg.difference(a, a), 0)
        self.assertEqual(wg.difference(a, b), 1.0)
        self.assertEqual(wg.difference(a, None), 1.0)
        c = wg.fingerprint(frame((20, 20, 20), "Farmland  Owned: 12  Level 3"))
        self.assertGreater(wg.difference(a, c), wg.CHANGED, "a line of text on the same background counts as a new picture")

    @needs_pillow
    def test_consider_waits_for_a_settled_new_picture(self):
        w = wg.Watcher(ROOT, "http://fake", "m", Path("unused"), None, ask=lambda *a: {"kind": "other"})
        dark, light = frame((10, 10, 10)), frame((240, 240, 240))
        self.assertFalse(w.consider(dark), "first frame: nothing to compare with yet")
        self.assertTrue(w.consider(dark), "same picture twice: settled and new")
        self.assertFalse(w.consider(dark), "already read")
        self.assertFalse(w.consider(light), "changed: wait for it to settle")
        self.assertTrue(w.consider(light))
        self.assertEqual(w.frames, 5)
        clock = [1000.0]
        w2 = wg.Watcher(ROOT, "http://fake", "m", Path("unused"), None, ask=lambda *a: {"kind": "other"}, now=lambda: clock[0])
        w2.consider(dark)
        self.assertTrue(w2.consider(dark))
        clock[0] += wg.REREAD_SECONDS - 1
        self.assertFalse(w2.consider(dark), "still picture, not yet due for another look")
        clock[0] += 2
        self.assertTrue(w2.consider(dark), "a still picture is looked at again after REREAD_SECONDS")

    def test_supersedes_same_screen_same_facility_or_superset_page(self):
        rv1, rv2 = {"kind": "rv", "fields": {"rv": 5}}, {"kind": "rv", "fields": {"rv": 6}}
        self.assertTrue(wg.supersedes(rv2, rv1))
        self.assertTrue(wg.supersedes({"kind": "home", "fields": {"coins": 2}}, {"kind": "home", "fields": {"coins": 1}}))
        farm_panel_a = {"kind": "facility", "fields": {"facility": "Farmland", "count": None, "level": 1}}
        farm_panel_b = {"kind": "facility", "fields": {"facility": "Farmland", "count": None, "level": 2}}
        self.assertTrue(wg.supersedes(farm_panel_b, farm_panel_a))
        farm_a = {"kind": "facility", "fields": {"facility": "Farmland", "count": 4, "level": 1}}
        farm_b = {"kind": "facility", "fields": {"facility": "farmland ", "count": 6, "level": 2}}
        mill = {"kind": "facility", "fields": {"facility": "Carousel Mill", "count": 1, "level": 1}}
        self.assertTrue(wg.supersedes(farm_b, farm_a))
        self.assertFalse(wg.supersedes(mill, farm_a))
        self.assertFalse(wg.supersedes(rv1, farm_a))
        page1 = {"kind": "aniimo", "fields": {"aniimo": [{"name": "Spark"}, {"name": "Pebble"}]}}
        page1_again = {"kind": "aniimo", "fields": {"aniimo": [{"name": "Spark"}, {"name": "Pebble"}, {"name": "Dew"}]}}
        page2 = {"kind": "aniimo", "fields": {"aniimo": [{"name": "Dew"}]}}
        self.assertTrue(wg.supersedes(page1_again, page1))
        self.assertFalse(wg.supersedes(page2, page1), "a different page keeps the first one")
        empty = {"kind": "stock", "fields": {"items": []}}
        self.assertFalse(wg.supersedes({"kind": "stock", "fields": {"items": [{"name": "Wood Block"}]}}, empty))


@needs_pillow
class PipelineTest(unittest.TestCase):
    def test_frames_are_classified_read_merged_and_written(self):
        answers = {
            "RV": ({"kind": "rv"}, {"rv": 7, "coins": 5000}),
            "FARM": ({"kind": "facility"}, {"facility": "Farmland", "count": 4, "level": 2}),
            "FARM2": ({"kind": "facility"}, {"facility": "Farmland", "count": 6, "level": 2}),
            "MAP": ({"kind": "other"}, None),
        }
        current = {"text": None}
        calls = []

        follow_schema = wg.rs.SCREEN_KINDS["facility_detail"]["follow_up"]["schema"]

        def fake_ask(prompt, schema, image_b64):
            calls.append(prompt[:60])
            classify, fields = answers[current["text"]]
            if schema is follow_schema:
                return {"facility_level": None, "rv_level": None}  # no grey upgrade line on these frames
            return classify if schema is wg.CLASSIFY_SCHEMA else fields

        with tempfile.TemporaryDirectory() as d:
            out_dir, web_dir = Path(d) / "auto", Path(d) / "web"
            web_dir.mkdir()
            w = wg.Watcher(ROOT, "http://fake", "m", out_dir, web_dir, ask=fake_ask, keep=1)
            shades = {"RV": (30, 30, 30), "FARM": (120, 120, 120), "FARM2": (200, 200, 200), "MAP": (60, 90, 60)}
            for text in ["RV", "RV", "FARM", "FARM", "MAP", "MAP", "FARM2", "FARM2"]:
                current["text"] = text
                w.handle(frame(shades[text], text), "frame.png")
            self.assertEqual([s["kind"] for s in w.screens], ["rv", "facility"], "the second Farmland reading replaced the first")
            self.assertEqual(w.screens[1]["fields"]["count"], 6)
            self.assertEqual(w.looked, 4, "each settled new picture was classified once")
            self.assertEqual(calls.count(wg.CLASSIFY_PROMPT[:60]), 4)
            self.assertEqual(len(calls), 9, "four classifications, three readings (the map was not read) and a follow-up for each facility panel; no card header in these frames, so the card question is never asked")
            reading = json.loads((Path(d) / "reading.json").read_text(encoding="utf-8"))
            self.assertEqual(reading["format"], "aniimax-screenshot-reading")
            self.assertEqual(reading["setup"]["home-level"], "7")
            self.assertEqual(reading["setup"]["facilityTiers"], {"Farmland": [{"count": 6, "level": 2}]})
            self.assertEqual(reading["actual"], {"rv": 7, "coins": 5000})
            self.assertEqual(reading["watcher"]["frames"], 8)
            self.assertEqual(json.loads((web_dir / "reading.json").read_text(encoding="utf-8"))["setup"], reading["setup"])
            saved = sorted(p.name for p in out_dir.glob("*.png"))
            self.assertEqual(len([n for n in saved if n.startswith("facility-")]), 1, "keep=1 pruned the older Farmland frame")
            self.assertEqual(len([n for n in saved if n.startswith("rv-")]), 1)
            self.assertEqual(len([n for n in saved if n.startswith("other-")]), 1, "the map frame is kept as 'other' for checking")

    def test_a_new_session_continues_from_the_previous_reading(self):
        with tempfile.TemporaryDirectory() as d:
            previous = {"format": "aniimax-screenshot-reading", "version": 1, "screens": [
                {"file": "rv-old.png", "kind": "rv", "fields": {"rv": 6, "coins": 1}},
                {"file": "stock-old.png", "kind": "stock", "fields": {"items": [{"name": "Wood Block", "amount": 3}]}},
                {"file": "bad.png", "kind": "facility", "fields": None, "error": "timeout"},
                {"file": "map.png", "kind": "other", "fields": None}]}
            (Path(d) / "reading.json").write_text(json.dumps(previous), encoding="utf-8")
            w = wg.Watcher(ROOT, "http://fake", "m", Path(d) / "auto", None,
                           ask=lambda prompt, schema, b64: {"kind": "rv"} if schema is wg.CLASSIFY_SCHEMA else {"rv": 7, "coins": 2})
            self.assertEqual([s["kind"] for s in w.screens], ["rv", "stock"], "errors and unknown screens are dropped")
            w.last_fp = wg.fingerprint(frame((5, 5, 5)))
            w.handle(frame((5, 5, 5)), "frame.png")
            reading = json.loads((Path(d) / "reading.json").read_text(encoding="utf-8"))
            self.assertEqual([s["kind"] for s in reading["screens"]], ["stock", "rv"], "the new RV reading replaced the old one")
            self.assertEqual(reading["setup"]["levelUpStock"], {"wood_block": 3})
            self.assertEqual(reading["actual"], {"rv": 7, "coins": 2})

    def test_a_model_error_is_kept_out_of_the_reading_but_saved_for_debugging(self):
        def failing_ask(prompt, schema, image_b64):
            if schema is wg.CLASSIFY_SCHEMA:
                return {"kind": "aniimo"}
            error = ValueError("the model did not answer with JSON")
            error.content = '{"aniimo": [{"name": "Pinkie", "abilities": ['
            raise error
        with tempfile.TemporaryDirectory() as d:
            w = wg.Watcher(ROOT, "http://fake", "m", Path(d) / "auto", None, ask=failing_ask)
            w.last_fp = wg.fingerprint(frame((5, 5, 5)))
            entry = w.handle(frame((5, 5, 5)), "frame.png")
            self.assertIn("did not answer", entry["error"])
            self.assertEqual(w.screens, [])
            self.assertFalse((Path(d) / "reading.json").exists())
            saved = sorted(p.name for p in (Path(d) / "auto").iterdir())
            self.assertEqual(len(saved), 2)
            self.assertTrue(saved[0].startswith("aniimo-") and saved[0].endswith("-error.png"), saved)
            self.assertTrue(saved[1].endswith("-error.txt"), saved)
            self.assertIn("Pinkie", (Path(d) / "auto" / saved[1]).read_text(encoding="utf-8"))

    def _coin_watcher(self, d, reads, clock=None):
        """A Watcher in temp dir d whose model answers with the next of `reads` ((kind, fields)) per frame."""
        queue = list(reads)
        state = {"current": None}

        def fake_ask(prompt, schema, image_b64):
            if schema is wg.CLASSIFY_SCHEMA:
                state["current"] = queue.pop(0)
                return {"kind": state["current"][0]}
            if schema is wg.rs.SCREEN_KINDS["facility_detail"]["follow_up"]["schema"]:
                return {"facility_level": None, "rv_level": None}
            return state["current"][1]
        w = wg.Watcher(ROOT, "http://fake", "m", Path(d) / "auto", Path(d) / "web", ask=fake_ask, now=clock)
        (Path(d) / "web").mkdir(exist_ok=True)
        return w

    def _feed(self, w, shades, source="frame.png", make=frame):
        for shade in shades:
            w.last_fp = wg.fingerprint(make(shade))
            w.handle(make(shade), source, save=False)

    def test_coins_are_logged_when_they_change_and_written_for_the_site(self):
        with tempfile.TemporaryDirectory() as d:
            clock = iter([1_700_000_000 + 100 * i for i in range(100)])
            w = self._coin_watcher(d, [
                ("facility", {"facility": "Farmland", "count": None, "level": 2, "coins": "182 204"}),
                ("home", {"coins": "220 724"}),
                ("home", {"coins": "220 724"}),
            ], clock=lambda: next(clock))
            self._feed(w, [(30, 30, 30), (120, 120, 120), (200, 200, 200)])
            lines = (Path(d) / "coins.jsonl").read_text(encoding="utf-8").splitlines()
            self.assertEqual(len(lines), 2, "the repeated 220 724 was not logged twice")
            logged = [json.loads(line) for line in lines]
            self.assertEqual([p["coins"] for p in logged], [182204, 220724])
            self.assertEqual([p["screen"] for p in logged], ["facility", "home"])
            self.assertTrue(logged[0]["t"].endswith("Z") and "T" in logged[0]["t"])
            for target in (Path(d) / "coins.json", Path(d) / "web" / "coins.json"):
                data = json.loads(target.read_text(encoding="utf-8"))
                self.assertEqual(data["format"], "aniimax-coin-log")
                self.assertEqual(data["version"], 1)
                self.assertEqual([p["coins"] for p in data["points"]], [182204, 220724])
                self.assertEqual(sorted(data["points"][0]), ["coins", "t"])
            # a new session continues from the log: the same value as the last line is not logged again
            w2 = self._coin_watcher(d, [("rv", {"rv": 9, "coins": "220 724"})])
            self._feed(w2, [(5, 5, 5)])
            self.assertEqual(len((Path(d) / "coins.jsonl").read_text(encoding="utf-8").splitlines()), 2)

    def test_a_damaged_coin_log_is_not_made_worse(self):
        with tempfile.TemporaryDirectory() as d:
            log = Path(d) / "coins.jsonl"
            # A last line that lost its newline (an interrupted write) must not swallow the next point.
            log.write_text('{"t": "2026-10-15T15:00:00Z", "coins": 1}', encoding="utf-8")
            w = self._coin_watcher(d, [("home", {"coins": "5"})])
            self.assertEqual(w.load_coins(), 1)
            self._feed(w, [(30, 30, 30)])
            logged = [json.loads(line) for line in log.read_text(encoding="utf-8").splitlines()]
            self.assertEqual([p["coins"] for p in logged], [1, 5])
            # A log that is not UTF-8 is skipped, not a crash.
            log.write_bytes(bytes([255, 254]) + b" not text")
            w2 = self._coin_watcher(d, [("home", {"coins": "7"})])
            self.assertEqual(w2.load_coins(), 0)

    def test_replay_order_is_by_frame_time_not_name(self):
        names = ["home-20261015-110000.png", "facility-20261015-120000.png", "facility-20261015-100000.png", "once.png"]
        self.assertEqual(sorted(names, key=lambda n: (wg.frame_time(n), n)), ["once.png", "facility-20261015-100000.png", "home-20261015-110000.png", "facility-20261015-120000.png"])

    def test_a_replayed_frame_is_stamped_with_the_time_in_its_file_name(self):
        from datetime import datetime, timezone
        with tempfile.TemporaryDirectory() as d:
            w = self._coin_watcher(d, [("facility", {"facility": "Farmland", "count": None, "level": 2, "coins": "182 204"})],
                                   clock=lambda: 1_700_000_000)
            self._feed(w, [(30, 30, 30)], source="facility-20261015-104746.png")
            point = json.loads((Path(d) / "coins.jsonl").read_text(encoding="utf-8").splitlines()[0])
            expected = datetime(2026, 10, 15, 10, 47, 46).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            self.assertEqual(point["t"], expected)
            self.assertEqual(point["file"], "facility-20261015-104746.png")
            self.assertNotEqual(point["t"], "2023-11-14T22:13:20Z", "not the clock's time")

    def _facility_watcher(self, d, reads, clock=None):
        """A Watcher whose model answers each facility frame with the next of `reads`: (panel fields, upgrade note)."""
        queue = list(reads)
        state = {"current": None}
        detail = wg.rs.SCREEN_KINDS["facility_detail"]

        def fake_ask(prompt, schema, image_b64):
            if schema is wg.CLASSIFY_SCHEMA:
                state["current"] = queue.pop(0)
                return {"kind": "facility"}
            return state["current"][1] if schema is detail["follow_up"]["schema"] else state["current"][0]
        (Path(d) / "web").mkdir(exist_ok=True)
        return wg.Watcher(ROOT, "http://fake", "m", Path(d) / "auto", Path(d) / "web", ask=fake_ask, now=clock)

    def _panel(self, facility="Chimney Kiln", recipe="Coarse-Sifted Ore", status="set", time_text="2s", level=2):
        return {"facility": facility, "level": level, "tab": "Formula", "recipe_status": status, "recipe": recipe,
                "recipe_time": time_text, "recipes_per_level": [], "coins": "182 204"}

    def _observations(self, d, ticks=False):
        """The logged facts; the recipe-box `tick` facts (one per reading, over time) only when asked for."""
        path = Path(d) / "observations.jsonl"
        logged = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()] if path.is_file() else []
        return logged if ticks else [o for o in logged if o["fact"] != "tick"]

    def test_a_facility_panel_logs_its_unlock_line_and_its_recipe(self):
        from datetime import datetime, timezone
        with tempfile.TemporaryDirectory() as d:
            w = self._facility_watcher(d, [(self._panel(), {"facility_level": 3, "rv_level": 14})])
            self._feed(w, [(30, 30, 30)], source="facility-20261015-104746.png")
            logged = self._observations(d)
            stamp = datetime(2026, 10, 15, 10, 47, 46).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            self.assertEqual(logged, [
                {"t": stamp, "frame": "facility-20261015-104746.png", "facility": "Chimney Kiln", "level": 2,
                 "fact": "unlock", "facility_level": 3, "rv_level": 14},
                {"t": stamp, "frame": "facility-20261015-104746.png", "facility": "Chimney Kiln", "level": 2,
                 "fact": "recipe", "recipe": "coarse_sifted_ore", "time": "2s"}])
            kept = json.loads((Path(d) / "observations.json").read_text(encoding="utf-8"))
            self.assertEqual((kept["format"], kept["version"], len(kept["observations"])), ("aniimax-observations", 1, 3), "the unlock, the recipe and its tick")
            tick = self._observations(d, ticks=True)[2]
            self.assertEqual({k: tick[k] for k in ("fact", "facility", "recipe", "time", "time_seconds", "v", "t")},
                             {"fact": "tick", "facility": "Chimney Kiln", "recipe": "coarse_sifted_ore", "time": "2s", "time_seconds": 2, "v": 2, "t": stamp})
            self.assertNotIn("untested", tick, "the recipe box is read with a tested prompt")
            for target in (Path(d) / "verification.json", Path(d) / "web" / "verification.json"):
                summary = json.loads(target.read_text(encoding="utf-8"))
                self.assertEqual((summary["observations"], summary["agree"], summary["disagree"]), (2, 2, 0))
            self.assertIn("Chimney Kiln", (Path(d) / "verification.md").read_text(encoding="utf-8"))
            self.assertEqual(w.screens[0]["kind"], "facility", "still a facility screen for the merge and the site diff")
            self.assertEqual(w.screens[0]["fields"]["upgrade_note"], {"facility_level": 3, "rv_level": 14})
            reading = json.loads((Path(d) / "reading.json").read_text(encoding="utf-8"))
            self.assertEqual(reading["setup"]["facilityTiers"], {"Chimney Kiln": [{"count": None, "level": 2}]})

    def test_an_invented_panel_logs_nothing_and_says_why(self):
        with tempfile.TemporaryDirectory() as d:
            w = self._facility_watcher(d, [
                (self._panel(facility="Shell Factory", recipe="Pinkie"), {"facility_level": 2, "rv_level": 5}),   # no such facility
                (self._panel(facility="Chimney Kiln", recipe="Pinkie"), {"facility_level": 3, "rv_level": 14}),   # real facility, made-up recipe
                (self._panel(facility=None, recipe=None, status="none", time_text=None, level=None), None),       # no panel at all
            ])
            self._feed(w, [(30, 30, 30), (120, 120, 120), (200, 200, 200)])
            self.assertEqual(self._observations(d), [])
            self.assertFalse((Path(d) / "verification.json").exists())
            text = " ".join(w.observation_notes)
            self.assertIn("Shell Factory", text)
            self.assertIn("Pinkie", text)
            self.assertIn("nothing logged", text)

    def test_a_repeated_panel_adds_no_duplicate_even_with_a_new_time(self):
        with tempfile.TemporaryDirectory() as d:
            note = {"facility_level": 3, "rv_level": 14}
            w = self._facility_watcher(d, [(self._panel(), note), (self._panel(), note), (self._panel(time_text="3s"), note)])
            self._feed(w, [(30, 30, 30), (120, 120, 120), (200, 200, 200)])
            logged = self._observations(d)
            # the time may be a countdown, so a recipe is one fact per facility, kept with its first time
            self.assertEqual([(o["fact"], o.get("time")) for o in logged], [("unlock", None), ("recipe", "2s")])
            # a new session continues from the log, refreshes the report at startup, and does not repeat itself
            (Path(d) / "web" / "verification.json").unlink()
            w2 = self._facility_watcher(d, [(self._panel(time_text="3s"), note)])
            self.assertEqual(len([o for o in w2.observations if o["fact"] != "tick"]), 2)
            self.assertTrue((Path(d) / "web" / "verification.json").exists(), "refreshed at startup")
            self._feed(w2, [(5, 5, 5)])
            self.assertEqual(len(self._observations(d)), 2)

    def test_skip_notes_reach_the_disk_and_a_failed_second_question_keeps_the_reading(self):
        with tempfile.TemporaryDirectory() as d:
            w = self._facility_watcher(d, [(self._panel(facility="Shell Factory"), {"facility_level": 2, "rv_level": 5})])
            self._feed(w, [(30, 30, 30)])
            notes = json.loads((Path(d) / "observations.json").read_text(encoding="utf-8"))["notes"]
            self.assertTrue(any("Shell Factory" in n for n in notes))
            detail = wg.rs.SCREEN_KINDS["facility_detail"]

            def flaky_ask(prompt, schema, image_b64):
                if schema is wg.CLASSIFY_SCHEMA:
                    return {"kind": "facility"}
                if schema is detail["follow_up"]["schema"]:
                    raise ValueError("the model did not answer with JSON")
                return self._panel()
            w3 = wg.Watcher(ROOT, "http://fake", "m", Path(d) / "auto", Path(d) / "web", ask=flaky_ask, now=lambda: 1_700_000_000)
            self._feed(w3, [(30, 30, 30)])
            screen = w3.screens[-1]
            self.assertNotIn("error", screen)
            self.assertIsNone(screen["fields"]["upgrade_note"])
            self.assertIn("did not answer", screen["follow_up_error"])
            self.assertEqual([o["fact"] for o in self._observations(d)], ["recipe"], "the recipe fact is still logged")

    def test_an_unlock_is_logged_from_two_different_frames_so_it_can_be_judged(self):
        with tempfile.TemporaryDirectory() as d:
            note = {"facility_level": 3, "rv_level": 13}  # the table says RV 14: one off
            w = self._facility_watcher(d, [(self._panel(status="not set", recipe=None, time_text=None), note)] * 4)
            self._feed(w, [(30, 30, 30)], source="facility-20990101-000000.png")
            summary = json.loads((Path(d) / "verification.json").read_text(encoding="utf-8"))
            self.assertEqual((summary["unclear"], summary["disagree"]), (1, 0), "one frame: unclear")
            self._feed(w, [(90, 90, 90)], source="facility-20990101-000000.png")   # the same frame again: nothing new
            self._feed(w, [(150, 150, 150)], source="facility-20990101-000001.png")  # a second frame: logged again
            self._feed(w, [(210, 210, 210)], source="facility-20990101-000002.png")  # a third: two frames are enough
            logged = self._observations(d)
            self.assertEqual([o["frame"] for o in logged], ["facility-20990101-000000.png", "facility-20990101-000001.png"])
            summary = json.loads((Path(d) / "verification.json").read_text(encoding="utf-8"))
            self.assertEqual((summary["unclear"], summary["disagree"]), (0, 2), "two frames: a disagreement")

    def test_a_panel_without_a_recipe_still_logs_its_unlock_line(self):
        with tempfile.TemporaryDirectory() as d:
            w = self._facility_watcher(d, [(self._panel(status="not set", recipe=None, time_text=None), {"facility_level": 3, "rv_level": 14})])
            self._feed(w, [(30, 30, 30)])
            self.assertEqual([o["fact"] for o in self._observations(d)], ["unlock"])

    def _card_watcher(self, d, reads, clock=None):
        """A Watcher whose model answers each frame from the next of `reads`: {kind, fields, note, card, behind, side};
        the card and second-card questions are answered from `card` and `behind` (all-null when absent), and a
        side question of kind K (level_up, pairs, manage, store, emode, food, stock) from side[K]."""
        queue = list(reads)
        state = {"current": None}
        detail = wg.rs.SCREEN_KINDS["facility_detail"]
        card = wg.rs.SCREEN_KINDS["item_card"]
        nothing = {"item": None, "facility": None, "facility_level": None, "time": None, "workload": None, "environment": None}
        asked_side = self.asked_side = []

        def fake_ask(prompt, schema, image_b64):
            if schema is wg.CLASSIFY_SCHEMA:
                state["current"] = queue.pop(0)
                return {"kind": state["current"]["kind"]}
            r = state["current"]
            for name, answer in (r.get("side") or {}).items():
                if schema is wg.rs.SCREEN_KINDS[name]["schema"]:
                    asked_side.append(name)
                    return dict(answer)
            if schema is detail["follow_up"]["schema"]:
                return r.get("note") or {"facility_level": None, "rv_level": None}
            if schema is card["schema"]:
                return dict(r.get("card") or nothing)
            if schema is card["follow_up"]["schema"]:
                return dict(r.get("behind") or {k: None for k in ("item", "facility", "facility_level", "time")})
            return r["fields"]
        (Path(d) / "web").mkdir(exist_ok=True)
        return wg.Watcher(ROOT, "http://fake", "m", Path(d) / "auto", Path(d) / "web", ask=fake_ask, now=clock)

    ROSE = {"item": "Rose", "facility": "Farmland", "facility_level": 4, "time": "40m 0s", "workload": None, "environment": "Cool"}

    def test_a_stock_frame_with_a_card_logs_a_card_fact_and_still_reads_the_counts(self):
        with tempfile.TemporaryDirectory() as d:
            w = self._card_watcher(d, [{"kind": "stock", "fields": {"items": [{"name": "Rose", "inventory": 0, "homeland": 520, "owned": None}]},
                                        "card": self.ROSE, "behind": {"item": "ose Concentrate", "facility": "Simmering Pot", "facility_level": 2, "time": "1m 48s"}}])
            self._feed(w, [(30, 30, 30)], source="stock-20261015-105144.png", make=card_frame)
            logged = self._observations(d)
            self.assertEqual([(o["fact"], o["item"], o["facility"]) for o in logged], [("card", "rose", "Farmland"), ("card", "rose_concentrate", "Simmering Pot")])
            self.assertEqual({k: logged[0][k] for k in ("facility_level", "time", "time_seconds", "workload", "environment")},
                             {"facility_level": 4, "time": "40m 0s", "time_seconds": 2400, "workload": None, "environment": "Cool"})
            self.assertNotIn("behind", logged[0])
            self.assertTrue(logged[1]["behind"], "the half-hidden card is marked")
            self.assertEqual(logged[1]["time_seconds"], 108)
            summary = json.loads((Path(d) / "web" / "verification.json").read_text(encoding="utf-8"))
            self.assertEqual((summary["cards"]["seen"], summary["cards"]["agree"]), (2, 2))
            reading = json.loads((Path(d) / "reading.json").read_text(encoding="utf-8"))
            self.assertEqual(reading["setup"]["levelUpStock"], {"rose": 520}, "the stock reading still works")
            self.assertEqual(reading["screens"][0]["fields"]["card"]["item"], "Rose")
            # the same card again adds nothing; a differing re-reading of it is a second fact (a conflict the report can show)
            w2 = self._card_watcher(d, [{"kind": "stock", "fields": {"items": []}, "card": self.ROSE},
                                        {"kind": "stock", "fields": {"items": []}, "card": {**self.ROSE, "facility_level": 5}}])
            self._feed(w2, [(60, 60, 60), (120, 120, 120)], make=card_frame)
            self.assertEqual(len(self._observations(d)), 3)

    def test_a_facility_frame_with_a_card_yields_the_panel_facts_and_the_card(self):
        with tempfile.TemporaryDirectory() as d:
            porridge = {"item": "Plain Rice Porridge", "facility": "Simmering Pot", "facility_level": 1, "time": "1m 48s", "workload": None, "environment": None}
            w = self._card_watcher(d, [{"kind": "facility", "fields": self._panel(facility="Simmering Pot", recipe="Rose Concentrate", time_text="20s", level=4),
                                        "note": {"facility_level": 5, "rv_level": 15}, "card": porridge}])
            self._feed(w, [(30, 30, 30)], source="facility-20261015-105135.png", make=card_frame)
            logged = self._observations(d)
            self.assertEqual([o["fact"] for o in logged], ["unlock", "recipe", "card"])
            self.assertEqual((logged[2]["item"], logged[2]["facility"], logged[2]["facility_level"], logged[2]["time_seconds"]), ("plain_rice_porridge", "Simmering Pot", 1, 108))
            summary = json.loads((Path(d) / "verification.json").read_text(encoding="utf-8"))
            self.assertEqual((summary["observations"], summary["agree"], summary["cards"]["seen"]), (3, 3, 1))
            self.assertEqual(w.screens[0]["kind"], "facility")
            # an untrusted panel does not take the card down with it
            w2 = self._card_watcher(d, [{"kind": "facility", "fields": self._panel(facility="Shell Factory"), "card": porridge}])
            self._feed(w2, [(90, 90, 90)], source="facility-20261015-105136.png", make=card_frame)
            self.assertEqual(len(self._observations(d)), 3, "the same card is not logged twice")
            w3 = self._card_watcher(d, [{"kind": "facility", "fields": self._panel(facility="Shell Factory"), "card": self.ROSE}])
            self._feed(w3, [(150, 150, 150)], source="facility-20261015-105137.png", make=card_frame)
            self.assertEqual([o["fact"] for o in self._observations(d)], ["unlock", "recipe", "card", "card"])
            self.assertTrue(any("Shell Factory" in n for n in w3.observation_notes))

    def test_an_invented_or_copied_card_is_dropped_with_a_note(self):
        with tempfile.TemporaryDirectory() as d:
            w = self._card_watcher(d, [
                {"kind": "stock", "fields": {"items": []}, "card": {**self.ROSE, "item": "Perfume of Dawn"}},                       # unknown item
                {"kind": "stock", "fields": {"items": []}, "card": {**self.ROSE, "facility": "Moon Base"}},                         # unknown facility
                {"kind": "stock", "fields": {"items": []}, "card": {"item": "Ginseng Water", "facility": "Bouncy Brew Keg", "facility_level": 3, "time": None, "workload": 162, "environment": None},
                 "behind": {"item": "Dried Ginseng", "facility": "Bouncy Brew Keg", "facility_level": 3, "time": "54s"}},           # behind copies the front card
            ])
            self._feed(w, [(30, 30, 30), (120, 120, 120), (200, 200, 200)], make=card_frame)
            logged = self._observations(d)
            self.assertEqual([(o["item"], o["workload"]) for o in logged], [("ginseng_water", 162)])
            notes = " ".join(w.observation_notes)
            self.assertIn("Perfume of Dawn", notes)
            self.assertIn("Moon Base", notes)
            self.assertIn("repeats the front card", notes)
            kept = json.loads((Path(d) / "observations.json").read_text(encoding="utf-8"))
            self.assertTrue(any("Moon Base" in n for n in kept["notes"]), "skip notes reach the disk")

    def test_a_front_card_time_that_repeats_the_card_behind_is_dropped(self):
        with tempfile.TemporaryDirectory() as d:
            w = self._card_watcher(d, [
                # the overlapping frame as the model reads it: Ginseng Water (really "Workload 162") given Dried Ginseng's 54s
                {"kind": "stock", "fields": {"items": []}, "card": {"item": "Ginseng Water", "facility": "Bouncy Brew Keg", "facility_level": 3, "time": "54s", "workload": None, "environment": None},
                 "behind": {"item": "Dried Ginseng", "facility": "Jukebox Dryer", "facility_level": 5, "time": "54s"}},
                # two different times: both kept
                {"kind": "stock", "fields": {"items": []}, "card": self.ROSE,
                 "behind": {"item": "Rose Concentrate", "facility": "Simmering Pot", "facility_level": 2, "time": "1m 48s"}},
                # one card open: the model answers the second-card question by repeating the front card; its time stays
                {"kind": "facility", "fields": self._panel(), "card": {"item": "Wheatmeal", "facility": "Carousel Mill", "facility_level": 1, "time": "54s", "workload": None, "environment": None},
                 "behind": {"item": "Wheatmeal", "facility": "Carousel Mill", "facility_level": 1, "time": "54s"}},
            ])
            self._feed(w, [(30, 30, 30), (120, 120, 120), (200, 200, 200)], make=card_frame)
            logged = [o for o in self._observations(d) if o["fact"] == "card"]
            self.assertEqual([(o["item"], o["time"], o["time_seconds"]) for o in logged],
                             [("ginseng_water", None, None), ("dried_ginseng", "54s", 54), ("rose", "40m 0s", 2400), ("rose_concentrate", "1m 48s", 108), ("wheatmeal", "54s", 54)])
            self.assertEqual(logged[0]["facility_level"], 3, "the rest of the front card is kept")
            self.assertIn("repeats the card behind's and is dropped", " ".join(w.observation_notes))

    def test_card_facts_survive_a_restart_and_a_failed_card_question_keeps_the_rest(self):
        with tempfile.TemporaryDirectory() as d:
            w = self._card_watcher(d, [{"kind": "stock", "fields": {"items": []}, "card": self.ROSE}])
            self._feed(w, [(30, 30, 30)], make=card_frame)
            w2 = self._card_watcher(d, [])
            self.assertEqual([o["fact"] for o in w2.observations], ["card"])
            card_schema = wg.rs.SCREEN_KINDS["item_card"]["schema"]

            def flaky_ask(prompt, schema, image_b64):
                if schema is wg.CLASSIFY_SCHEMA:
                    return {"kind": "facility"}
                if schema is card_schema:
                    raise ValueError("the model did not answer with JSON")
                if schema is wg.rs.SCREEN_KINDS["facility_detail"]["follow_up"]["schema"]:
                    return {"facility_level": 3, "rv_level": 14}
                return self._panel()
            w3 = wg.Watcher(ROOT, "http://fake", "m", Path(d) / "auto", Path(d) / "web", ask=flaky_ask)
            self._feed(w3, [(90, 90, 90)], make=card_frame)
            screen = w3.screens[-1]
            self.assertNotIn("error", screen)
            self.assertIsNone(screen["fields"]["card"])
            self.assertIn("card: the model did not answer", screen["follow_up_error"])
            self.assertEqual([o["fact"] for o in self._observations(d)], ["card", "unlock", "recipe"])

    def test_without_a_card_header_the_card_question_is_never_asked(self):
        with tempfile.TemporaryDirectory() as d:
            w = self._card_watcher(d, [{"kind": "facility", "fields": self._panel(), "card": self.ROSE}])
            self._feed(w, [(30, 30, 30)], source="facility-20261015-105113.png")
            self.assertEqual([o["fact"] for o in self._observations(d)], ["recipe"], "an invented card from a tile is never even asked for")
            self.assertIsNone(w.screens[0]["fields"]["card"])

    def test_a_bug_in_the_verification_never_stops_the_watcher(self):
        import verify_data
        original = verify_data.run
        verify_data.run = lambda *a, **k: 1 / 0
        try:
            with tempfile.TemporaryDirectory() as d:
                w = self._facility_watcher(d, [(self._panel(), {"facility_level": 3, "rv_level": 14})])
                self._feed(w, [(30, 30, 30)])
                self.assertEqual(len(self._observations(d)), 2, "the facts are still logged")
        finally:
            verify_data.run = original

    # --- Milestone 10: the facts the game questions need -------------------------------------------------

    def _generator(self, tab="Details", **extra):
        return {"facility": "Crackle Generator", "level": 2, "tab": tab, "recipe_status": "power", "recipe": None, "recipe_time": None,
                "recipes_per_level": [], "coins": "182 204", **extra}

    def test_a_generator_details_tab_logs_a_panel_fact_instead_of_a_skip(self):
        with tempfile.TemporaryDirectory() as d:
            pairs = {"label_1": "Power Capacity", "value_1": "600 W", "label_2": "Power in use", "value_2": "450 W",
                     "label_3": "Supply Rate", "value_3": "120%", "label_4": None, "value_4": None, "supply_mode": "120%"}
            w = self._card_watcher(d, [{"kind": "facility", "fields": self._generator(), "side": {"pairs": pairs}}])
            self._feed(w, [(30, 30, 30)], source="facility-20990101-000000.png")
            logged = self._observations(d)
            self.assertEqual([o["fact"] for o in logged], ["panel"])
            panel = logged[0]
            self.assertEqual({k: panel[k] for k in ("facility", "level", "tab", "capacity", "in_use", "supply_rate", "supply_mode", "v", "untested")},
                             {"facility": "Crackle Generator", "level": 2, "tab": "Details", "capacity": 600, "in_use": 450, "supply_rate": 120,
                              "supply_mode": "120%", "v": 2, "untested": True})
            self.assertEqual(panel["pairs"], [["Power Capacity", "600 W"], ["Power in use", "450 W"], ["Supply Rate", "120%"]], "the raw pairs are kept")
            self.assertFalse(any("nothing logged" in n for n in w.observation_notes), "no longer skipped")
            summary = json.loads((Path(d) / "verification.json").read_text(encoding="utf-8"))
            self.assertEqual(summary["observations"], 0, "a panel fact is never judged")
            self.assertIn("## Seen, not judged yet", (Path(d) / "verification.md").read_text(encoding="utf-8"))

    def test_a_level_up_tab_logs_level_up_and_unlock_and_a_cost_equal_to_the_balance_is_cleared(self):
        with tempfile.TemporaryDirectory() as d:
            up = {"max_level": False, "next_level": 3, "coin_cost": "182 204", "rv_required": 14,
                  "material_1_name": "Wood Block", "material_1_amount": 20, "material_2_name": None, "material_2_amount": None}
            w = self._card_watcher(d, [
                {"kind": "facility", "fields": self._panel(status="none", recipe=None, time_text=None) | {"tab": "Level Up"}, "side": {"level_up": up}},
                {"kind": "facility", "fields": self._panel(status="none", recipe=None, time_text=None) | {"tab": "Level Up"}, "side": {"level_up": {**up, "coin_cost": "75 000"}}},
            ])
            self._feed(w, [(30, 30, 30), (120, 120, 120)], source="facility-20990101-000000.png")
            self.assertEqual(self.asked_side, ["level_up", "level_up"], "only the Level Up question rides along on that tab")
            logged = self._observations(d)
            self.assertEqual([o["fact"] for o in logged], ["level_up", "unlock", "level_up"], "the same unlock is logged once")
            first, unlock = logged[0], logged[1]
            self.assertIsNone(first["coin_cost"], "a cost equal to the Home Coins balance is the balance: cleared")
            self.assertEqual((first["next_level"], first["rv_required"], first["materials"], first["untested"]), (3, 14, [["Wood Block", 20]], True))
            self.assertEqual({k: unlock[k] for k in ("facility", "facility_level", "rv_level", "source", "v", "untested")},
                             {"facility": "Chimney Kiln", "facility_level": 3, "rv_level": 14, "source": "level_up", "v": 2, "untested": True})
            self.assertEqual(logged[2]["coin_cost"], "75 000")
            summary = json.loads((Path(d) / "verification.json").read_text(encoding="utf-8"))
            self.assertEqual((summary["observations"], summary["agree"]), (1, 1), "the unlock is judged (and agrees); the Level Up facts are not counted")
            report = (Path(d) / "verification.md").read_text(encoding="utf-8")
            self.assertIn("| Chimney Kiln | upgrade cost | agree | Lv.3 costs 75000 (table says 75000) |", report)
            self.assertIn("read from the Level Up tab, an untested prompt", report)

    def test_side_questions_are_asked_only_on_their_tab(self):
        with tempfile.TemporaryDirectory() as d:
            store = {"label": "Storage", "held": 35, "cap": 35}
            emode = {"switch_visible": True, "emode_on": True, "power_draw": 45}
            manage = {"slots_total": 1, "slots_empty": 1, "first_name": "Sparky", "first_ability": "electric", "emode_on": True}
            sides = {"store": store, "emode": emode, "manage": manage, "level_up": {"next_level": 9}, "pairs": {"label_1": "x"}, "food": {"total_food_energy": "1"}}
            w = self._card_watcher(d, [
                {"kind": "facility", "fields": self._panel(), "side": sides},                                                   # processor, Formula
                {"kind": "facility", "fields": self._panel(facility="Farmland", recipe="Wheat", time_text="3m 10s", level=1), "side": sides},  # grower, Formula
                {"kind": "facility", "fields": self._panel(status="none", recipe=None, time_text=None) | {"tab": "Manage"}, "side": sides},    # processor, Manage
            ])
            self._feed(w, [(30, 30, 30), (120, 120, 120), (200, 200, 200)], source="facility-20990101-000000.png")
            self.assertEqual(self.asked_side, ["store", "manage", "emode"])
            logged = self._observations(d)
            cap = next(o for o in logged if o["fact"] == "cap")
            self.assertEqual((cap["facility"], cap["level"], cap["held"], cap["cap"], cap["untested"]), ("Farmland", 1, 35, 35, True))
            managed = next(o for o in logged if o["fact"] == "manage")
            self.assertEqual((managed["first_ability"], managed["named"], managed["emode_on"]), ("Electric", True, True))
            self.assertNotIn("Sparky", json.dumps(self._observations(d, ticks=True)), "an Aniimo's name never reaches the log")
            self.assertEqual(next(o for o in logged if o["fact"] == "emode")["power_draw"], 45)
            ticks = [o for o in self._observations(d, ticks=True) if o["fact"] == "tick"]
            self.assertEqual([(o["facility"], o["time_seconds"]) for o in ticks], [("Chimney Kiln", 2), ("Farmland", 190)])

    def test_a_food_fact_carries_the_frames_time(self):
        from datetime import datetime, timezone
        with tempfile.TemporaryDirectory() as d:
            w = self._card_watcher(d, [{"kind": "food", "fields": {"total_food_energy": "12 400", "working_aniimo": 3}},
                                       {"kind": "food", "fields": {"total_food_energy": None, "working_aniimo": None}}])
            import contextlib
            import io
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self._feed(w, [(30, 30, 30)], source="food-20990101-000000.png")
                self._feed(w, [(90, 90, 90)], source="food-20990101-010000.png")
            self.assertIn("game question W1: open -> evidence", out.getvalue(), "a status change gets a line")
            self.assertEqual(w.question_status["W1"], "evidence")
            logged = self._observations(d)
            self.assertEqual(len(logged), 1, "a Food tab with no number read logs nothing")
            stamp = datetime(2099, 1, 1, 0, 0, 0).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            self.assertEqual({k: logged[0][k] for k in ("t", "frame", "facility", "fact", "total_food_energy", "energy", "working_aniimo", "v", "untested")},
                             {"t": stamp, "frame": "food-20990101-000000.png", "facility": "", "fact": "food", "total_food_energy": "12 400",
                              "energy": 12400, "working_aniimo": 3, "v": 2, "untested": True})
            self.assertEqual(w.screens[-1]["kind"], "food")

    def test_roster_rv_and_modules_screens_log_only_that_they_were_read(self):
        with tempfile.TemporaryDirectory() as d:
            w = self._card_watcher(d, [
                {"kind": "aniimo", "fields": {"aniimo": [{"name": "Sparky", "abilities": [{"ability": "Electric", "level": 3}], "personalities": ["Calm"]}]}},
                {"kind": "rv", "fields": {"rv": 12, "coins": "5 000", "title": None, "next_rv_cost": None}},
                {"kind": "modules", "fields": {"ecological_module": None, "kitchen_module": None, "resource_detector": None, "crafting_module": None}},
            ])
            self._feed(w, [(30, 30, 30), (120, 120, 120), (200, 200, 200)])
            logged = self._observations(d)
            self.assertEqual([(o["fact"], o["screen"], o["read"]) for o in logged], [("screen", "aniimo", True), ("screen", "rv", True)],
                             "a modules screen with nothing read is not logged")
            text = (Path(d) / "observations.jsonl").read_text(encoding="utf-8")
            for value in ("Sparky", "Calm", "Electric", "5 000"):
                self.assertNotIn(value, text)

    def test_an_aniimo_frame_with_a_card_header_becomes_stock_and_a_real_roster_stays_aniimo(self):
        card_schema = wg.rs.SCREEN_KINDS["item_card"]["schema"]
        rows = {"fake": [{"name": "Rose", "abilities": [], "personalities": []}],
                "real": [{"name": "Sparky", "abilities": [{"ability": "Fire", "level": 2}], "personalities": []}]}
        current = {"which": "fake"}

        def fake_ask(prompt, schema, image_b64):
            if schema is wg.CLASSIFY_SCHEMA:
                return {"kind": "aniimo"}
            if schema is wg.rs.SCREEN_KINDS["aniimo"]["schema"]:
                return {"aniimo": rows[current["which"]]}
            if schema is wg.rs.SCREEN_KINDS["stock"]["schema"]:
                return {"items": [{"name": "Rose", "inventory": 0, "homeland": 520, "owned": None}]}
            if schema is card_schema:
                return dict(self.ROSE)
            return {k: None for k in ("item", "facility", "facility_level", "time")}
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "web").mkdir()
            w = wg.Watcher(ROOT, "http://fake", "m", Path(d) / "auto", Path(d) / "web", ask=fake_ask)
            self._feed(w, [(30, 30, 30)], make=card_frame)
            self.assertEqual(w.screens[-1]["kind"], "stock", "an item card read as a roster is read again as stock")
            self.assertEqual(w.screens[-1]["fields"]["items"][0]["homeland"], 520)
            self.assertEqual([o["fact"] for o in self._observations(d)], ["card"])
            current["which"] = "real"
            self._feed(w, [(120, 120, 120)], make=card_frame)
            self.assertEqual(w.screens[-1]["kind"], "aniimo", "a roster with a known ability stays a roster, card header or not")
            current["which"] = "fake"
            self._feed(w, [(200, 200, 200)])  # no card header: the model's answer stands
            self.assertEqual(w.screens[-1]["kind"], "aniimo")

    def test_frames_named_by_observations_survive_the_limit(self):
        with tempfile.TemporaryDirectory() as d:
            out = Path(d) / "auto"
            out.mkdir()
            for name in ("facility-20000101-000000.png", "facility-20000101-000001.png", "facility-20000101-000002.png"):
                frame((10, 10, 10)).save(out / name)
            w = wg.Watcher(ROOT, "http://fake", "m", out, None, ask=lambda *a: {"kind": "other"}, keep=1)
            w.observations = [{"t": "2000-01-01T00:00:00Z", "frame": "facility-20000101-000000.png", "facility": "Chimney Kiln", "fact": "card", "item": "x"},
                              {"t": "2000-01-01T00:00:01Z", "frame": "facility-20000101-000001.png", "facility": "Chimney Kiln", "fact": "tick", "recipe": "x", "v": 2}]
            saved = w.save_frame(frame((40, 40, 40)), {"kind": "facility", "fields": {}})
            left = sorted(p.name for p in out.glob("facility-*.png"))
            self.assertEqual(left, sorted(["facility-20000101-000000.png", saved.name]),
                             "the frame a card names stays; one only a tick names goes, like the unnamed one")

    def test_encode_crops_before_shrinking(self):
        import base64
        import io
        image = Image.new("RGB", (1000, 500), (255, 0, 0))
        ImageDraw.Draw(image).rectangle((800, 0, 1000, 500), fill=(0, 0, 255))
        out = Image.open(io.BytesIO(base64.b64decode(wg.encode(image, 4000, crop=(0.8, 0.0, 1.0, 1.0)))))
        self.assertEqual(out.size, (200, 500))
        self.assertEqual(out.getpixel((10, 10)), (0, 0, 255))
        self.assertEqual(Image.open(io.BytesIO(base64.b64decode(wg.encode(image, 4000)))).size, (1000, 500))

    def test_blank_frames_are_recognised(self):
        self.assertTrue(wg.is_blank(frame((0, 0, 0))))
        self.assertFalse(wg.is_blank(frame((0, 0, 0), "Farmland")))


def make_root(tmp: Path) -> Path:
    """A copy of the real facility config and data (overrides included: the E-mode table), so the
    offline commands run on real names without touching the real screenshots folder."""
    import shutil
    root = tmp / "repo"
    (root / "web").mkdir(parents=True)
    shutil.copy(ROOT / "web" / "facility-config.js", root / "web" / "facility-config.js")
    shutil.copytree(ROOT / "data", root / "data")
    (root / "screenshots" / "auto").mkdir(parents=True)
    return root


def card_line(item, facility, time_text, frame, **extra):
    import verify_data
    return {"t": "2099-01-01T00:00:00Z", "frame": frame, "facility": facility, "fact": "card", "item": item, "facility_level": 3,
            "time": time_text, "time_seconds": verify_data.parse_seconds(time_text), "workload": None, "environment": None, **extra}


class PruneTest(unittest.TestCase):
    """--prune-copied-times: rules R1, R1b and R2 on a made-up log (never the real one)."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = make_root(Path(self._tmp.name))
        self.log = self.root / "screenshots" / "observations.jsonl"
        lines = [
            json.dumps(card_line("ginseng_water", "Bouncy Brew Keg", "54s", "stock-20990101-000000.png")),            # 1: R2 (E-mode says 108, frame gone)
            json.dumps(card_line("wheatmeal", "Carousel Mill", "54s", "stock-20990101-000100.png")),                  # 2: a correct old time (54)
            '{"t": "2099-01-01T00:00:00Z",   "frame": "facility-20990101-000200.png", "facility": "Chimney Kiln", "level": 2, "fact": "unlock", "facility_level": 3, "rv_level": 14}',
            json.dumps(card_line("rose_concentrate", "Simmering Pot", "54s", "stock-20990101-000300.png")),           # 4: R1 (the card behind has the same time; its row says 108)
            json.dumps(card_line("dried_ginseng", "Jukebox Dryer", "54s", "stock-20990101-000300.png", behind=True)),
            json.dumps(card_line("ginseng_water", "Bouncy Brew Keg", "54s", "stock-20990101-000400.png", v=2)),        # 6: a new-format line: R2 never applies
            json.dumps(card_line("wheatmeal", "Carousel Mill", "54s", "stock-20990101-000700.png", v=2)),              # 7: two items that really share 54s:
            json.dumps(card_line("cotton_fabric", "Joy Wheel Loom", "54s", "stock-20990101-000700.png", v=2)),         # 8: R1 leaves both alone
        ]
        self.original = ("\r\n".join(lines[:3]) + "\n" + "\n".join(lines[3:]) + "\n").encode("utf-8")  # a CRLF stretch too
        self.log.write_bytes(self.original)
        (self.root / "screenshots" / "auto" / "stock-20990101-000400.png").write_bytes(b"not looked at")

    def prune(self, *args):
        import contextlib
        import io
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = wg.main(["--root", str(self.root), "--no-web", "--prune-copied-times", *args])
        return code, out.getvalue()

    def test_the_dry_run_lists_r1_and_r2_and_writes_nothing(self):
        code, out = self.prune()
        self.assertEqual(code, 0)
        self.assertEqual(self.log.read_bytes(), self.original, "a dry run writes nothing")
        self.assertEqual(list(self.log.parent.glob("*.bak-*")), [])
        self.assertIn("line 1: ginseng_water (Bouncy Brew Keg), time 54s, rule R2", out)
        self.assertIn("line 4: rose_concentrate (Simmering Pot), time 54s, rule R1", out)
        self.assertNotIn("line 2:", out, "a correct old time is untouched")
        self.assertNotIn("line 5:", out, "the card behind is never pruned")
        self.assertNotIn("line 6:", out)
        self.assertNotIn("line 7:", out, "a shared time that agrees with the item's own row is not a copy")
        self.assertNotIn("line 8:", out)
        self.assertIn("2 lines match (R1 1, R1b 0, R2 1).", out)
        for line in out.splitlines():  # only the line number, item, facility, time read and rule; never another value of the log
            self.assertRegex(line, r"^(line \d+: [a-z0-9_]+ \([A-Za-z ]+\), time [0-9hms ]+, rule (R1|R1b|R2)|\d+ lines? match .*|Dry run: .*)$")
        self.assertNotIn("time 1m 48s", out)
        for value in ("2099-01-01", "stock-2099", "rv_level", "14", "wheatmeal", "cotton_fabric"):
            self.assertNotIn(value, out)
        code, out = self.prune("--apply", "--dry-run")
        self.assertEqual(self.log.read_bytes(), self.original, "--dry-run wins over --apply")

    def test_apply_refuses_too_many_matches(self):
        code, out = self.prune("--apply")
        self.assertEqual(code, 1)
        self.assertIn("Refused: 2 matches is more than --max 1", out)
        self.assertEqual(self.log.read_bytes(), self.original)
        self.assertEqual(list(self.log.parent.glob("*.bak-*")), [], "no backup either")

    def test_apply_backs_up_clears_only_the_matches_and_a_second_run_finds_nothing(self):
        code, out = self.prune("--apply", "--max", "2")
        self.assertEqual(code, 0, out)
        backups = list(self.log.parent.glob("observations.jsonl.bak-*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), self.original, "the backup is the log as it was")
        before, after = self.original.split(b"\n"), self.log.read_bytes().split(b"\n")
        self.assertEqual(len(before), len(after))
        for i, (old, new) in enumerate(zip(before, after), start=1):
            if i in (1, 4):
                obj = json.loads(new.decode("utf-8"))
                self.assertEqual((obj["time"], obj["time_seconds"]), (None, None))
                self.assertEqual(obj["pruned"], "R2" if i == 1 else "R1")
                self.assertEqual(obj["facility_level"], 3, "only the time goes")
                self.assertTrue(new.endswith(b"\r") == old.endswith(b"\r"), "the line ending is kept")
            else:
                self.assertEqual(new, old, f"line {i} is byte-identical")
        self.assertIn("Check again:", out)
        self.assertTrue((self.root / "screenshots" / "verification.md").is_file(), "the check ran again")
        code, out = self.prune()
        self.assertIn("0 lines match", out, "a second run finds nothing")
        code, out = self.prune("--apply", "--max", "2")
        self.assertEqual(len(list(self.log.parent.glob("observations.jsonl.bak-*"))), 1, "nothing to apply: no second backup")

    def test_apply_refuses_when_the_log_changed_while_it_was_checked(self):
        original = wg.copied_time_matches

        def meanwhile(*a, **k):
            found = original(*a, **k)
            with self.log.open("ab") as f:
                f.write(b'{"fact": "recipe"}\n')  # the watcher appends a line meanwhile
            return found
        wg.copied_time_matches = meanwhile
        try:
            code, out = self.prune("--apply", "--max", "2")
        finally:
            wg.copied_time_matches = original
        self.assertEqual(code, 1)
        self.assertIn("the log changed while it was checked", out)
        self.assertEqual(self.log.read_bytes(), self.original + b'{"fact": "recipe"}\n', "the appended line is kept, nothing pruned")
        self.assertEqual(list(self.log.parent.glob("*.bak-*")), [])

    def test_r1b_uses_the_card_behind_stored_in_the_reading(self):
        self.log.write_text(json.dumps(card_line("ginseng_water", "Bouncy Brew Keg", "54s", "stock-20990101-000500.png", v=2)) + "\n"
                            + json.dumps(card_line("rose", "Farmland", "40m 0s", "stock-20990101-000600.png", v=2)) + "\n", encoding="utf-8")
        reading = {"format": "aniimax-screenshot-reading", "screens": [
            {"file": "stock-20990101-000500.png", "kind": "stock", "fields": {"card": {"item": "Ginseng Water", "behind": {"item": "Dried Ginseng", "time": "54s"}}}},
            {"file": "stock-20990101-000600.png", "kind": "stock", "fields": {"card": {"item": "Rose", "behind": {"item": "ose", "time": "40m 0s"}}}}]}
        (self.root / "screenshots" / "reading.json").write_text(json.dumps(reading), encoding="utf-8")
        code, out = self.prune()
        self.assertIn("line 1: ginseng_water (Bouncy Brew Keg), time 54s, rule R1b", out)
        self.assertIn("1 line match", out, "a card behind that is the front card repeated (a cut-off title) is no copy")


class OfflineCommandsTest(unittest.TestCase):
    def test_offline_commands_never_look_for_the_window_or_ollama(self):
        def refuse(*a, **k):
            raise AssertionError("an offline command looked for the game window or Ollama")
        saved = (wg.list_windows, wg.pick_window, wg.ensure_server)
        wg.list_windows = wg.pick_window = wg.ensure_server = refuse
        try:
            with tempfile.TemporaryDirectory() as d:
                root = make_root(Path(d))
                import contextlib
                import io
                out = io.StringIO()
                with contextlib.redirect_stdout(out):
                    self.assertEqual(wg.main(["--root", str(root), "--questions"]), 0)
                    self.assertEqual(wg.main(["--root", str(root), "--prune-copied-times"]), 0)
                    self.assertEqual(wg.main(["--root", str(root), "--prune-copied-times", "--apply"]), 0)
                text = out.getvalue()
                self.assertIn("0 of 19 answered", text)
                self.assertIn("nothing to prune", text)
                self.assertFalse((root / "screenshots" / "verification.json").exists(), "--questions writes nothing")
        finally:
            wg.list_windows, wg.pick_window, wg.ensure_server = saved


if __name__ == "__main__":
    unittest.main()

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
            self.assertEqual(len(calls), 9, "four classifications, three readings (the map was not read) and a follow-up for each facility panel")
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

    def _feed(self, w, shades, source="frame.png"):
        for shade in shades:
            w.last_fp = wg.fingerprint(frame(shade))
            w.handle(frame(shade), source, save=False)

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

    def _observations(self, d):
        path = Path(d) / "observations.jsonl"
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()] if path.is_file() else []

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
            self.assertEqual((kept["format"], kept["version"], len(kept["observations"])), ("aniimax-observations", 1, 2))
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
            self.assertEqual(len(w2.observations), 2)
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

    def test_a_panel_without_a_recipe_still_logs_its_unlock_line(self):
        with tempfile.TemporaryDirectory() as d:
            w = self._facility_watcher(d, [(self._panel(status="not set", recipe=None, time_text=None), {"facility_level": 3, "rv_level": 14})])
            self._feed(w, [(30, 30, 30)])
            self.assertEqual([o["fact"] for o in self._observations(d)], ["unlock"])

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


if __name__ == "__main__":
    unittest.main()

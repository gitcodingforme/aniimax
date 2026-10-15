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

        def fake_ask(prompt, schema, image_b64):
            calls.append(prompt[:60])
            classify, fields = answers[current["text"]]
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
            self.assertEqual(len(calls), 7, "four classifications and three readings (the map was not read)")
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

    def test_blank_frames_are_recognised(self):
        self.assertTrue(wg.is_blank(frame((0, 0, 0))))
        self.assertFalse(wg.is_blank(frame((0, 0, 0), "Farmland")))


if __name__ == "__main__":
    unittest.main()

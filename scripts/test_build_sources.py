"""Tests for build_sources.py. Run from the repository root:
    python -m unittest discover -s scripts -p "test_*.py"
"""
import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_sources as bs  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
WEB_HEADER = "kind, facility, key, column, value, source, url, checked_on\n"
VALUES_HEADER = "file, match, column, value, upstream_value, verified_on, note\n"
KILN = "https://wikily.gg/aniimo/homeland-crafting/facilities/chimney-kiln"


class BuildSourcesTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        (self.root / "data" / "sources").mkdir(parents=True)
        (self.root / "data" / "overrides").mkdir()

    def write(self, web: str = "", values: str = "") -> None:
        (self.root / "data" / "sources" / "web_sources.csv").write_text(WEB_HEADER + web, encoding="utf-8")
        (self.root / "data" / "overrides" / "values.csv").write_text(VALUES_HEADER + values, encoding="utf-8")

    def build(self) -> tuple[dict, list[str]]:
        warnings = []
        return bs.build(self.root, warn=warnings.append), warnings

    def test_the_committed_json_is_what_the_inputs_give(self):
        committed = (ROOT / "web" / "data-sources.json").read_text(encoding="utf-8")
        self.assertEqual(committed, bs.render(bs.build(ROOT, warn=self.fail)), "run python scripts/build_sources.py")
        doc = json.loads(committed)
        self.assertEqual((doc["format"], doc["version"]), ("aniimax-data-sources", 1))
        kinds = {}
        for row in doc["web"]:
            kinds[row["kind"]] = kinds.get(row["kind"], 0) + 1
        self.assertEqual(kinds, {"recipe": 310, "unlock": 84, "cap": 84, "upgrade_cost": 84, "rv_cost": 19})
        self.assertIn({"kind": "unlock", "facility": "Chimney Kiln", "key": "3", "column": "needs_rv", "value": 14, "source": "wikily.gg",
                       "url": KILN, "checked_on": "2026-10-16"}, doc["web"])
        self.assertTrue(all(r["url"].startswith("https://wikily.gg/") for r in doc["web"]))

    def test_rows_are_read_with_numbers_and_rv_rows_get_the_rv_facility(self):
        self.write(f"# a comment\nrecipe, Chimney Kiln, coarse_sifted_ore, workload, 34, wikily.gg, {KILN}, 2026-10-16\n"
                   f"rv_cost, , 6, coins, 32000, wikily.gg, {KILN}, 2026-10-16\n\n")
        doc, warnings = self.build()
        self.assertEqual(warnings, [])
        self.assertEqual([(r["kind"], r["facility"], r["key"], r["value"]) for r in doc["web"]],
                         [("recipe", "Chimney Kiln", "coarse_sifted_ore", 34), ("rv_cost", "RV", "6", 32000)])
        self.assertEqual(doc["generatedFrom"], ["data/sources/web_sources.csv", "data/overrides/values.csv"])

    def test_a_malformed_row_is_skipped_with_a_warning(self):
        self.write(f"unlock, Chimney Kiln, 3, needs_rv, 14, wikily.gg, {KILN}, 2026-10-16\n"
                   f"unlock, Chimney Kiln, 3, needs_rv, 14, wikily.gg, {KILN}\n"                 # 7 cells
                   f"guess, Chimney Kiln, 3, needs_rv, 14, wikily.gg, {KILN}, 2026-10-16\n"      # unknown kind
                   f"cap, Chimney Kiln, three, output_cap, 20, wikily.gg, {KILN}, 2026-10-16\n"  # a level that is not a number
                   f"cap, Chimney Kiln, 3, output_cap, , wikily.gg, {KILN}, 2026-10-16\n"        # no value
                   f"cap, Chimney Kiln, 3, output_cap, 20, wikily.gg, {KILN}, yesterday\n"       # not a date
                   f"cap, Chimney Kiln, 3, output_cap, 20, wikily.gg, http://example.com, 2026-10-16\n")
        doc, warnings = self.build()
        self.assertEqual(len(doc["web"]), 1)
        self.assertEqual(len(warnings), 6)
        self.assertTrue(all("web_sources.csv line" in w and "skipped" in w for w in warnings), warnings)
        self.assertIn("line 3: 7 cells", warnings[0])
        self.assertIn("unknown kind 'guess'", warnings[1])
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            bs.build(self.root)
        self.assertEqual(err.getvalue().count("warning:"), 6, "the default warning goes to stderr")

    def test_owner_rows_come_from_the_active_rows_of_values_csv(self):
        self.write(values="# farmland.csv, rose, production_time, 2400, 2400, 2026-10-14, a comment line\n"
                          "farmland.csv, rose, production_time, 2400, 2400, 2026-10-14, timed twice, with a stopwatch\n"
                          "grower_steps.csv, name=wheat;step=Sowing, workload, 12, , 2026-10-15,\n"
                          "farmland.csv, rose, production_time, fast, 2400, 2026-10-14, not a number\n")
        doc, warnings = self.build()
        self.assertEqual(doc["owner"], [
            {"file": "farmland.csv", "match": "rose", "column": "production_time", "value": 2400, "verified_on": "2026-10-14",
             "note": "timed twice, with a stopwatch"},
            {"file": "grower_steps.csv", "match": "name=wheat;step=Sowing", "column": "workload", "value": 12, "verified_on": "2026-10-15", "note": ""},
        ])
        self.assertEqual(len(warnings), 1)
        self.assertNotIn("upstream_value", doc["owner"][0])

    def test_missing_inputs_give_empty_lists(self):
        doc, warnings = self.build()
        self.assertEqual((doc["web"], doc["owner"], warnings), ([], [], []))

    def test_check_fails_when_the_file_is_stale_and_passes_after_a_build(self):
        self.write(f"unlock, Chimney Kiln, 3, needs_rv, 14, wikily.gg, {KILN}, 2026-10-16\n")
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            self.assertEqual(bs.main(["--root", str(self.root), "--check"]), 1)
            self.assertEqual(bs.main(["--root", str(self.root)]), 0)
            self.assertEqual(bs.main(["--root", str(self.root), "--check"]), 0)
        self.assertIn("run python scripts/build_sources.py", err.getvalue())
        raw = (self.root / "web" / "data-sources.json").read_bytes()
        self.assertTrue(raw.endswith(b"}\n") and b"\r\n" not in raw)
        self.assertTrue(raw.startswith(b'{\n  "format"'), "sorted keys, 2-space indent")


if __name__ == "__main__":
    unittest.main()

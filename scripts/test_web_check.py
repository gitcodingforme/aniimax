"""Tests for web_check.py. Run from the repository root:
    python -m unittest discover -s scripts -p "test_*.py"

Everything is offline: the pages are the synthetic fixtures in scripts/fixtures/web_check/ (written for
these tests, not copies of real pages) and HTTP goes through a fake urlopen.
"""
import contextlib
import email.message
import io
import json
import os
import sys
import tempfile
import time
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import web_check as wc  # noqa: E402

HERE = Path(__file__).resolve().parent
FIXTURES = HERE / "fixtures" / "web_check"
REPO = HERE.parent
KILN_URL = "https://wikily.gg/aniimo/homeland-crafting/facilities/chimney-kiln"

CONFIG = """// Synthetic facility-config.js for scripts/test_web_check.py.
export const FACILITIES = [
    {
        name: 'Farmland', slug: 'farmland', defaultCount: 1, category: 'Materials',
        unlocks: { 1: 1, 2: 2 },
    },
    {
        name: 'Chimney Kiln', slug: 'chimney-kiln', defaultCount: 0, category: 'Materials Processing',
        unlocks: { 1: 6, 2: 10, 3: 14 },
    },
];

export const LEVEL_UP_COSTS = {
    2: { coins: 140, items: [['wood_block', 3]] },
    6: { coins: 32000, items: [['wood_block', 1300], ['mineral_sand', 700]] },
    10: { coins: 510000, items: [['rough_lumber', 2000], ['coarse_sifted_ore', 2400]] },
};

export const OUTPUT_CAPS = {
    Farmland: [5, 10],
    'Chimney Kiln': [20, 20, 20],
};

export const FACILITY_UPGRADE_COSTS = {
    Farmland: { 2: 60 },
    'Chimney Kiln': { 2: 16300, 3: 75000 },
};
"""
FARMLAND = ("name, cost, sell_value, production_time, yield, energy, facility_level, module_requirement, environment\n"
            "wheat, 0, 1, 240, 5, , 1, ,\npotato, 1, 8, 640, 2, , 2, ,\n"
            "quick_wheat, 0, 1, 1200, 42, , 2, ecological_module:1,\ngrape, 30, 40, 2400, 9, , 2, ,\n")
KILN = ("name, raw_materials, required_amount, sell_value, sell_currency, workload, facility_level, module_requirement\n"
        "coarse_sifted_ore, mineral_sand, 8, 0, none, 34, 1,\nsintered_ore_brick, coarse_sifted_ore, 8, 0, none, 34, 2,\n"
        "refined_ore, sintered_ore_brick, 8, 0, none, 41, 3,\n")
EMODE = ("item, facility, emode_seconds, source, fetched_on\n# test rows\n"
         "coarse_sifted_ore, Chimney Kiln, 27, test, 2026-10-01\nsintered_ore_brick, Chimney Kiln, 27, test, 2026-10-01\n"
         "refined_ore, Chimney Kiln, 108, test, 2026-10-01\n")
PAGES = ("url, facility, kind, fixture\n# synthetic pages\n"
         f"{KILN_URL}, Chimney Kiln, facility, wikily-chimney-kiln\n"
         "https://wikily.gg/aniimo/homeland-crafting/facilities/farmland, Farmland, facility, wikily-farmland\n"
         "https://aniimotools.dev/systems/recipes/, , recipes, aniimotools-recipes\n")


def fixture(name: str) -> str:
    return (FIXTURES / f"{name}.html").read_text(encoding="utf-8")


class Root:
    """A temporary repository root whose data agrees with every fixture. Removed when `test` ends."""

    def __init__(self, test, kiln=KILN, structure='{"facilities": {}, "levelUpCosts": {}}', pages=PAGES):
        self.dir = tempfile.TemporaryDirectory()
        test.addCleanup(self.dir.cleanup)
        self.root = Path(self.dir.name)
        for rel, text in {"web/facility-config.js": CONFIG, "data/farmland.csv": FARMLAND, "data/chimney_kiln.csv": kiln,
                          "data/overrides/emode_times.csv": EMODE, "data/overrides/structure.json": structure, "pages.csv": pages,
                          "data/sources/aliases.csv": (REPO / "data" / "sources" / "aliases.csv").read_text(encoding="utf-8")}.items():
            (self.root / rel).parent.mkdir(parents=True, exist_ok=True)
            (self.root / rel).write_text(text, encoding="utf-8")

    def run(self, *extra, offline=FIXTURES):
        out, err = io.StringIO(), io.StringIO()
        args = ["--root", str(self.root), "--pages", str(self.root / "pages.csv"), "--report", str(self.root / "r.md"),
                "--json", str(self.root / "r.json"), "--today", "2026-10-20", *extra]
        if offline is not None:
            args += ["--offline", str(offline)]
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = wc.main(args)
        report = (self.root / "r.md").read_text(encoding="utf-8") if (self.root / "r.md").exists() else ""
        result = json.loads((self.root / "r.json").read_text(encoding="utf-8")) if (self.root / "r.json").exists() else {}
        return code, report, result, err.getvalue()


class FakeResponse:
    def __init__(self, body: str):
        self.body = body.encode("utf-8")
        self.headers = email.message.Message()
        self.headers["Content-Type"] = "text/html; charset=utf-8"

    def read(self, n=-1):
        return self.body if n < 0 else self.body[:n]

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def fake_web(pages: dict):
    """A urlopen stand-in: pages maps URL -> body, exception, or a list of those served in turn."""
    calls = []

    def urlopen(request, timeout=None):
        calls.append(request.full_url)
        assert request.get_header("User-agent") == wc.USER_AGENT
        value = pages[request.full_url]
        value = value.pop(0) if isinstance(value, list) else value
        if isinstance(value, Exception):
            raise value
        return FakeResponse(value)
    return urlopen, calls


def http_error(url: str, code: int, retry_after: str | None = None) -> urllib.error.HTTPError:
    headers = email.message.Message()
    if retry_after is not None:
        headers["Retry-After"] = retry_after
    return urllib.error.HTTPError(url, code, "test", headers, None)


class ParserTest(unittest.TestCase):
    def test_durations_and_numbers(self):
        self.assertEqual(wc.parse_duration("13m 20s"), 800)
        self.assertEqual([wc.parse_duration(t) for t in ("4m", "1h 30m", "54 s", "2 min", "27s")], [240, 5400, 54, 120, 27])
        for bad in ("", "real time", "30 min at Lv 1", "34 workload", None, 5):
            self.assertIsNone(wc.parse_duration(bad), bad)
        self.assertEqual(wc.parse_number("1,450,000"), 1450000)
        self.assertEqual([wc.parse_number(t) for t in ("×16,300.", "x8", "1,800 workload", "Home Coin ×4,200.")], [16300, 8, 1800, 4200])
        self.assertIsNone(wc.parse_number("none"))

    def test_pipe_text_drops_scripts_and_collapses_separators(self):
        text = wc.pipe_text("<p>A</p>\n  <script>x = '<b>B</b>'</script><!-- C --><span>D &times;2</span>")
        self.assertEqual(text.strip("|"), "A|D ×2")
        self.assertEqual(wc.pipe_text(None), "")

    def test_wikily_levels_recipes_and_rv_costs(self):
        data, problems = wc.parse_wikily_facility(fixture("wikily-chimney-kiln"))
        self.assertEqual(problems, [])
        self.assertEqual([(b["level"], b["needs_rv"], b["upgrade_cost"], b["output_capacity"], b["emode_power"]) for b in data["levels"]],
                         [(1, 6, 4200, 20, 15), (2, 10, 16300, 20, 30), (3, 14, 75000, 20, 45)])  # the decoy script is ignored
        recipes = {r["name"]: r for r in data["recipes"]}
        self.assertEqual(sorted(recipes), ["Coarse-Sifted Ore", "Refined Ore", "Sintered Ore Brick"])
        self.assertEqual(recipes["Refined Ore"], {"name": "Refined Ore", "method": "aniimo_work", "workload": 41, "seconds": None,
                                                  "emode_seconds": 108, "facility_level": 3})
        self.assertEqual(recipes["Sintered Ore Brick"]["facility_level"], 2)
        self.assertEqual(data["rv_costs"][10], {"coins": 510000, "items": {"rough_lumber": 2000, "coarse_sifted_ore": 2400}})

    def test_level1_block_fills_what_the_visible_block_lacks(self):
        stats, problems = wc.parse_level1_block(fixture("wikily-farmland"))
        self.assertEqual((stats, problems), ({"aniimo_slots": 1, "output_capacity": 5}, []))  # stops before craft-lv-2
        data, problems = wc.parse_wikily_facility(fixture("wikily-farmland"))
        self.assertEqual(problems, [])
        self.assertEqual((data["levels"][0]["needs_rv"], data["levels"][0]["output_capacity"]), (1, 5))
        growing = {r["name"]: (r["method"], r["seconds"], r["facility_level"]) for r in data["recipes"]}
        self.assertEqual(growing["Potato"], ("growing", 640, 2))
        self.assertEqual(growing["Quick Formula: Wheat"], ("growing", 1200, 2))
        self.assertEqual(wc.parse_level1_block(fixture("wikily-chimney-kiln"))[0], {"needs_rv": 6, "output_capacity": 20})

    def test_aniimotools_rows(self):
        data, problems = wc.parse_aniimotools(fixture("aniimotools-recipes"))
        self.assertEqual(problems, [])
        rows = {(r["facility"], r["name"]): r for r in data["recipes"]}
        ore = rows[("Chimney Kiln", "Sintered Ore Brick")]
        self.assertEqual((ore["ingredients"], ore["workload"], ore["emode_seconds"], ore["tier"]), ([["Coarse-Sifted Ore", 8]], 34, 27, 2))
        wheat = rows[("Farmland", "Wheat")]
        self.assertEqual((wheat["yield"], wheat["seconds"], wheat["workload"]), (5, 240, None))
        self.assertTrue(rows[("Farmland", "Quick Formula: Wheat")]["quick"])
        self.assertEqual(len(rows), 5)

    def test_changed_shape_is_reported_not_raised(self):
        page = fixture("wikily-changed-shape")
        for parse in (wc.parse_wikily_facility, wc.parse_aniimotools, wc.parse_level1_block):
            for html in (page, "", None, b"<html>", "<p>" * 5000, fixture("wikily-chimney-kiln")[:600]):
                data, problems = parse(html)
                self.assertEqual(data, {}, (parse.__name__, str(html)[:40]))
                self.assertTrue(problems and problems[0].startswith(wc.SHAPE), problems)
        data, problems = wc.parse_aniimotools(fixture("aniimotools-recipes").replace("<td>T2</td>", "<td>?</td>"))
        self.assertIn("could not parse: Chimney Kiln lists 4 rows, 2 read", problems)

    def test_names_map_through_the_aliases_file(self):
        aliases = wc.load_aliases(REPO / "data" / "sources" / "aliases.csv")
        cases = {"High-Speed Formula: Scales": "quick_scales", "Quick Recipe: Potato": "quick_potato", "Quick Formula: Wheat": "quick_wheat",
                 "Grapes": "grape", "Chestnut Purée": "chestnut_puree", "Coarse-Sifted Ore": "coarse_sifted_ore",
                 "Umbral Sweet & Spicy Sauce": "umbral_sweet_and_spicy_sauce", "Plain Fresh Water": "fresh_water"}
        for wiki, fork in cases.items():
            self.assertEqual(wc.fork_key(wiki, "Farmland", aliases), fork, wiki)
        self.assertEqual(wc.fork_key("Umbral Sweet Spicy Sauce", "Simmering Pot", aliases), "umbral_sweet_and_spicy_sauce")
        self.assertEqual(wc.fork_key("Umbral Sweet Spicy Sauce", "Farmland", aliases), "umbral_sweet_spicy_sauce")  # facility-specific row

    def test_sanitize(self):
        self.assertEqual(wc.sanitize("Star Fruit @here [x](y) <b>|"), "Star Fruit (at)here xy b")
        self.assertEqual(wc.sanitize("Purée's Mix: A-1"), "Puree's Mix: A-1")
        self.assertEqual(len(wc.sanitize("a" * 100)), 60)
        self.assertEqual(wc.sanitize("`code` **bold** ![img](http://x)"), "code bold imghttp:x")


class CompareTest(unittest.TestCase):
    def test_agreeing_data_exits_0(self):
        code, report, result, _ = Root(self).run()
        self.assertEqual(code, 0, report)
        self.assertIn("## Differences\n\nNone.", report)
        self.assertEqual(result["agree"], {"unlock RV levels": 5, "output caps": 5, "facility upgrade costs": 3, "recipe workloads and grow times": 7,
                                           "recipe facility levels": 7, "E-mode times": 3, "aniimotools workloads": 2,
                                           "aniimotools ingredient lists": 2, "RV level-up costs": 3})
        self.assertIn("- Farmland: Star Fruit (at)here xy (800 s, level 1)", report)
        self.assertNotIn("@", report)
        self.assertEqual(result["info"]["aniimotools rows at stations the data does not have"], 1)
        self.assertEqual(result["info"]["level 1 build costs read (the data has none)"], 2)

    def test_difference_is_reported_and_fingerprinted(self):
        root = Root(self, kiln=KILN.replace("41, 3,", "45, 3,"), structure='{"facilities": {"Chimney Kiln": {"outputCaps": [20, 25, 20]}}}')
        code, report, result, _ = root.run()
        self.assertEqual(code, 1)
        expected = ["Chimney Kiln level 2: output cap 25 in the data, 20 on wikily",
                    "Chimney Kiln refined_ore: workload 45 in the data, 41 on wikily"]
        self.assertEqual(result["differences"], expected)
        for line in expected:
            self.assertIn(f"- {line}\n", report)
        self.assertTrue(report.rstrip().endswith(f"<!-- web-check:{wc.fingerprint(expected)} -->"))
        self.assertEqual(result["fingerprint"], wc.fingerprint(expected))

    def test_fingerprint_ignores_order_and_repeats(self):
        lines = ["b difference", "a difference", "c"]
        self.assertEqual(wc.fingerprint(lines), wc.fingerprint(list(reversed(lines)) + ["c"]))
        self.assertNotEqual(wc.fingerprint(lines), wc.fingerprint(lines[:2]))
        self.assertRegex(wc.fingerprint([]), r"^[0-9a-f]{64}$")

    def test_exit_2_when_nothing_can_be_fetched_or_parsed(self):
        with tempfile.TemporaryDirectory() as empty:
            code, report, _, _ = Root(self).run(offline=empty)
        self.assertEqual(code, 2)
        self.assertIn(f"- Chimney Kiln ({KILN_URL}): no offline copy", report)
        shape = PAGES.splitlines()[:2] + [f"{KILN_URL}, Chimney Kiln, facility, wikily-changed-shape"]
        code, report, _, _ = Root(self, pages="\n".join(shape) + "\n").run()
        self.assertEqual(code, 2)
        self.assertIn(f"- Chimney Kiln: {wc.SHAPE}", report)

    def test_exit_2_when_the_rest_agrees_but_a_page_is_missing(self):
        # A rate-limited week must not read as clean: the workflow closes the issue only on exit 0.
        missing = "https://wikily.gg/aniimo/homeland-crafting/facilities/mine, Farmland, facility,\n"
        code, report, result, _ = Root(self, pages=PAGES + missing).run()
        self.assertEqual((code, result["differences"]), (2, []))
        self.assertIn("1 could not be fetched", report)
        code = Root(self, pages=PAGES + f"{KILN_URL}, Chimney Kiln, facility, wikily-changed-shape\n").run()[0]
        self.assertEqual(code, 2)  # a page that no longer parses counts too
        code = Root(self, kiln=KILN.replace("41, 3,", "45, 3,"), pages=PAGES + missing).run()[0]
        self.assertEqual(code, 1)  # differences still win, so the issue gets updated

    def test_fingerprint_covers_pages_that_could_not_be_read(self):
        kiln = KILN.replace("41, 3,", "45, 3,")
        _, report, full, _ = Root(self, kiln=kiln).run()
        missing = "https://wikily.gg/aniimo/homeland-crafting/facilities/mine, Farmland, facility,\n"
        code, report2, partial, _ = Root(self, kiln=kiln, pages=PAGES + missing).run()
        self.assertEqual((code, partial["differences"]), (1, full["differences"]))
        self.assertNotEqual(partial["fingerprint"], full["fingerprint"])
        lines = full["differences"] + [f"could not fetch: {x}" for x in partial["could_not_fetch"]]
        self.assertEqual(partial["fingerprint"], wc.fingerprint(lines))
        self.assertIn(f"<!-- web-check:{partial['fingerprint']} -->", report2)
        again = Root(self, kiln=kiln, pages=PAGES + missing).run()[2]
        self.assertEqual(again["fingerprint"], partial["fingerprint"])  # same missing page, same mark: no edit

    def test_bad_command_line_exits_3(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(wc.main(["--no-such-flag"]), 3)
            self.assertEqual(wc.main(["--report"]), 3)
            self.assertEqual(wc.main(["--help"]), 0)
        self.assertIn("unrecognized arguments", err.getvalue())

    def test_exit_3_on_a_crash_with_traceback(self):
        with mock.patch.object(wc, "run", side_effect=RuntimeError("boom")):
            code, _, _, err = Root(self).run()
        self.assertEqual(code, 3)
        self.assertIn("RuntimeError: boom", err)
        self.assertIn("Traceback", err)

    def test_write_sources_format(self):
        root = Root(self)
        out = root.root / "sources.csv"
        self.assertEqual(root.run("--write-sources", str(out))[0], 0)
        lines = out.read_text(encoding="utf-8").splitlines()
        self.assertEqual(lines[0], "kind, facility, key, column, value, source, url, checked_on")
        rows = [line.split(", ") for line in lines[1:]]
        self.assertTrue(all(len(r) == 8 and r[7] == "2026-10-20" for r in rows))
        self.assertEqual({r[0] for r in rows}, {"recipe", "unlock", "cap", "upgrade_cost", "rv_cost"})
        self.assertIn(f"unlock, Chimney Kiln, 2, needs_rv, 10, wikily.gg, {KILN_URL}, 2026-10-20", lines)
        self.assertIn("cap, Farmland, 1, output_cap, 5, wikily.gg, https://wikily.gg/aniimo/homeland-crafting/facilities/farmland, 2026-10-20", lines)
        self.assertIn(f"rv_cost, RV, 6, coins, 32000, wikily.gg, {KILN_URL}, 2026-10-20", lines)
        self.assertIn("recipe, Chimney Kiln, coarse_sifted_ore, raw_materials, mineral_sand, aniimotools.dev, https://aniimotools.dev/systems/recipes/, 2026-10-20", lines)
        self.assertEqual({r[5] for r in rows}, {"wikily.gg", "aniimotools.dev"})
        self.assertTrue(all(r[1] for r in rows))  # rv_cost rows name facility RV, as data/sources/web_sources.csv does


class FetcherTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.cache = Path(self.tmp.name) / "cache"
        sleep = mock.patch.object(wc.time, "sleep")
        self.sleep = sleep.start()
        self.addCleanup(sleep.stop)

    def test_offline_mode_never_touches_the_network(self):
        with mock.patch("urllib.request.urlopen", side_effect=AssertionError("network used")) as network:
            fetcher = wc.Fetcher(offline_dir=FIXTURES)
            text, problem = fetcher.get("https://wikily.gg/x/facilities/farmland", "wikily-farmland")
            self.assertIsNone(problem)
            self.assertIn("Star Fruit", text)
            self.assertEqual(fetcher.get("https://wikily.gg/x/facilities/chimney-kiln")[1], None)  # <site>-<slug>.html
            self.assertEqual(fetcher.get("https://wikily.gg/x/facilities/nothing-here"), (None, "no offline copy"))
            self.assertEqual(fetcher.get("https://wikily.gg/x/y", "../secret")[1], "no offline copy")
            self.assertEqual(Root(self).run()[0], 0)
        self.assertFalse(network.called)

    def test_robots_disallow_skips_the_page(self):
        urlopen, calls = fake_web({"https://example.test/robots.txt": "User-agent: *\nDisallow: /private/\n",
                                   "https://example.test/open": "<p>open</p>",
                                   "https://other.test/robots.txt": "User-agent: aniimax-fork-web-check\nDisallow: /\n"})
        with mock.patch("urllib.request.urlopen", urlopen):
            fetcher = wc.Fetcher(cache_dir=self.cache, delay=0)
            self.assertEqual(fetcher.get("https://example.test/private/page"), (None, "robots.txt disallows this page; skipped"))
            self.assertEqual(fetcher.get("https://example.test/open"), ("<p>open</p>", None))
            self.assertEqual(fetcher.get("https://other.test/page")[1], "robots.txt disallows this page; skipped")
        self.assertEqual(calls, ["https://example.test/robots.txt", "https://example.test/open", "https://other.test/robots.txt"])

    def test_missing_robots_allows_and_unreachable_robots_skips(self):
        urlopen, calls = fake_web({"https://a.test/robots.txt": http_error("https://a.test/robots.txt", 404), "https://a.test/p": "ok",
                                   "https://b.test/robots.txt": urllib.error.URLError("down")})
        with mock.patch("urllib.request.urlopen", urlopen):
            fetcher = wc.Fetcher(cache_dir=self.cache, delay=0)
            self.assertEqual(fetcher.get("https://a.test/p"), ("ok", None))
            self.assertEqual(fetcher.get("https://b.test/p")[1], "robots.txt could not be read; page skipped")

    def test_cache_ttl_is_honoured(self):
        pages = {"https://example.test/robots.txt": "", "https://example.test/p": ["first", "second"]}
        urlopen, calls = fake_web(pages)
        with mock.patch("urllib.request.urlopen", urlopen):
            self.assertEqual(wc.Fetcher(cache_dir=self.cache, ttl=100, delay=0).get("https://example.test/p"), ("first", None))
            self.assertEqual(wc.Fetcher(cache_dir=self.cache, ttl=100, delay=0).get("https://example.test/p"), ("first", None))
            self.assertEqual(len(calls), 2)  # robots.txt and the page, once
            old = time.time() - 200
            for path in self.cache.iterdir():
                os.utime(path, (old, old))
            self.assertEqual(wc.Fetcher(cache_dir=self.cache, ttl=100, delay=0).get("https://example.test/p"), ("second", None))
            self.assertEqual(len(calls), 4)
            pages["https://example.test/p"] = ["third"]
            self.assertEqual(wc.Fetcher(cache_dir=self.cache, ttl=100, delay=0, use_cache=False).get("https://example.test/p"), ("third", None))

    def test_retries_429_honouring_retry_after_and_waits_between_requests(self):
        url = "https://example.test/p"
        urlopen, calls = fake_web({"https://example.test/robots.txt": "", url: [http_error(url, 429, "500"), "ok"],
                                   "https://example.test/q": [http_error(url, 503)] * 3})
        with mock.patch("urllib.request.urlopen", urlopen):
            fetcher = wc.Fetcher(cache_dir=self.cache, delay=3.0)
            self.assertEqual(fetcher.get(url), ("ok", None))
            self.assertIn(mock.call(120.0), self.sleep.call_args_list)  # Retry-After 500 capped at 120 s
            self.assertTrue(any(0 < c.args[0] <= 3.0 for c in self.sleep.call_args_list))  # the polite gap
            self.assertEqual(fetcher.get("https://example.test/q"), (None, "HTTP 503"))
        self.assertEqual(calls.count("https://example.test/q"), 3)
        self.assertEqual(wc.retry_after("garbage", 3.0), 6.0)
        urlopen, calls = fake_web({"https://example.test/robots.txt": "", url: [http_error(url, 429, "120")] * 3})
        with mock.patch("urllib.request.urlopen", urlopen):
            fetcher = wc.Fetcher(cache_dir=self.cache, delay=0, use_cache=False)
            fetcher.retry_budget = 150.0
            self.assertEqual(fetcher.get(url), (None, "HTTP 429"))  # one retry fits the budget, the second does not
        self.assertEqual(calls.count(url), 2)

    def test_too_large_pages_are_refused(self):
        urlopen, _ = fake_web({"https://example.test/robots.txt": "", "https://example.test/big": "x" * 50})
        with mock.patch("urllib.request.urlopen", urlopen):
            self.assertEqual(wc.Fetcher(cache_dir=self.cache, delay=0, max_bytes=10).get("https://example.test/big"), (None, "larger than 10 bytes"))


class WorkflowTest(unittest.TestCase):
    def test_schedule_permissions_and_token(self):
        text = (REPO / ".github" / "workflows" / "web-check.yml").read_text(encoding="utf-8")
        for part in ("cron: '41 7 * * 2'", "workflow_dispatch:", "contents: read", "issues: write", "group: web-check",
                     "cancel-in-progress: false", "timeout-minutes: 20", "actions/checkout@v4", "GH_TOKEN: ${{ github.token }}",
                     "scripts/apply_overrides.py", "set +e", "GITHUB_STEP_SUMMARY", "::warning::sites unreachable or page shape changed"):
            self.assertIn(part, text)
        self.assertNotIn("secrets.", text)


if __name__ == "__main__":
    unittest.main()

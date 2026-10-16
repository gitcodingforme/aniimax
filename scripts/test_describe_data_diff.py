"""Tests for describe_data_diff.py with tiny made-up CSVs. Run from the repository root:
    python -m unittest discover -s scripts -p "test_*.py"
"""
import contextlib
import io
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import describe_data_diff as dd  # noqa: E402

FARM = ("name, cost, sell_value, production_time, yield, facility_level\n"
        "wheat, 0, 12, 240, 5, 2\n"
        "potato, 1, 8, 640, 2, 2\n")
STOVE = ("name, raw_materials, required_amount, sell_value, sell_currency, workload, facility_level, module_requirement\n"
         "soy_sauce, milled_rice;soy_sauce, 1;1, 1280, coins, 81, 1,\n")


def run_main(*argv) -> tuple[int, str, str]:
    """(exit code, stdout, stderr) of main(argv); a SystemExit from argparse becomes its code."""
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            code = dd.main(list(argv))
        except SystemExit as e:
            code = e.code
    return code, out.getvalue(), err.getvalue()


def cli(old: dict, new: dict, *extra) -> tuple[int, str, str]:
    """Write {file name: text} dicts to two temp folders and run `--old ... --new ...` on them."""
    with tempfile.TemporaryDirectory() as tmp:
        dirs = []
        for name, files in (("old", old), ("new", new)):
            folder = Path(tmp) / name
            folder.mkdir()
            for file, text in files.items():
                (folder / file).write_text(text, encoding="utf-8", newline="")
            dirs.append(str(folder))
        return run_main("--old", dirs[0], "--new", dirs[1], *extra)


def say(old: dict, new: dict, *extra) -> list[str]:
    """The output lines of a run that must succeed."""
    code, out, err = cli(old, new, *extra)
    assert code == 0 and not err, (code, err)
    return out.splitlines()


class ReadTableTest(unittest.TestCase):
    def test_skips_comments_and_blank_lines_and_the_space_after_commas(self):
        header, rows = dd.read_table("# note\nname, cost,  yield\n\n  # indented note\nwheat, 0, 5\n")
        self.assertEqual(header, ["name", "cost", "yield"])
        self.assertEqual(rows, [{"name": "wheat", "cost": "0", "yield": "5"}])

    def test_empty_and_short_rows(self):
        self.assertEqual(dd.read_table(""), ([], []))
        self.assertEqual(dd.read_table("# only a comment\n"), ([], []))
        self.assertEqual(dd.read_table("name, cost\nwheat\n")[1], [{"name": "wheat", "cost": ""}])


class DescribeTest(unittest.TestCase):
    def test_changed_value_with_percent(self):
        lines = say({"farmland.csv": FARM}, {"farmland.csv": FARM.replace("wheat, 0, 12, 240", "wheat, 0, 12, 210")})
        self.assertEqual(lines, ["1 file changed: 1 value", "",
                                 "- **Farmland**: Wheat grow time 240 s (4m 0s) → 210 s (3m 30s), 12% faster."])

    def test_slower_and_short_times(self):
        lines = say({"farmland.csv": FARM}, {"farmland.csv": FARM.replace("wheat, 0, 12, 240", "wheat, 0, 12, 300").replace("640", "30")})
        self.assertIn("- **Farmland**: Wheat grow time 240 s (4m 0s) → 300 s (5m 0s), 25% slower.", lines)
        self.assertIn("- **Farmland**: Potato grow time 640 s (10m 40s) → 30 s, 95% faster.", lines)

    def test_crop_columns(self):
        new = FARM.replace("wheat, 0, 12, 240, 5, 2", "wheat, 3, 15, 240, 6, 3")
        old = FARM.replace("wheat, 0, 12, 240, 5, 2", "wheat, 3, 12, 240, 5, 2")
        lines = say({"farmland.csv": old}, {"farmland.csv": new})
        self.assertEqual(lines[2:], ["- **Farmland**: Wheat sells for 12 → 15 coins.", "- **Farmland**: Wheat yield 5 → 6 per batch.",
                                     "- **Farmland**: Wheat needs facility Lv 2 → Lv 3."])
        lines = say({"farmland.csv": FARM}, {"farmland.csv": FARM.replace("wheat, 0,", "wheat, 4,")})
        self.assertEqual(lines[2], "- **Farmland**: Wheat seed cost 0 → 4 coins per seed.")

    def test_processor_columns(self):
        new = STOVE.replace("milled_rice;soy_sauce, 1;1, 1280, coins, 81, 1,", "milled_rice;water, 1;2, 1500, coins, 108, 2,")
        lines = say({"blazing_stove.csv": STOVE}, {"blazing_stove.csv": new})
        self.assertEqual([ln.split(": ", 1)[1] for ln in lines[2:]], [
            "Soy Sauce sells for 1280 → 1500 coins.", "Soy Sauce ingredients milled rice, soy sauce → milled rice, water.",
            "Soy Sauce amount needed 1, 1 → 1, 2 per batch.", "Soy Sauce workload 81 → 108, 33% more.", "Soy Sauce needs facility Lv 1 → Lv 2."])

    def test_sell_currency_wording(self):
        none = STOVE.replace("1280, coins", "0, none")
        self.assertEqual(say({"blazing_stove.csv": STOVE}, {"blazing_stove.csv": none})[2:], ["- **Blazing Stove**: Soy Sauce now not sold."])
        self.assertEqual(say({"blazing_stove.csv": none}, {"blazing_stove.csv": STOVE.replace("1280, coins", "5, aniimo_exp")})[2:],
                         ["- **Blazing Stove**: Soy Sauce now sells for 5 aniimo exp."])
        self.assertEqual(say({"blazing_stove.csv": STOVE}, {"blazing_stove.csv": STOVE.replace("1280, coins", "2, aniipods")})[2:],
                         ["- **Blazing Stove**: Soy Sauce sells for 1280 coins → 2 aniipods."])

    def test_added_row(self):
        lines = say({"farmland.csv": FARM}, {"farmland.csv": FARM + "wheat_x, 0, 20, 240, 5, 2\n"})
        self.assertEqual(lines, ["1 file changed: 1 new recipe", "", "- **Farmland**: new recipe Wheat X (grow time 4m 0s, sells for 20 coins, Farmland Lv 2)."])

    def test_removed_row(self):
        lines = say({"farmland.csv": FARM}, {"farmland.csv": FARM.replace("potato, 1, 8, 640, 2, 2\n", "")})
        self.assertEqual(lines, ["1 file changed: 1 removed", "", "- **Farmland**: Potato removed."])

    def test_rename_only_when_unambiguous(self):
        lines = say({"farmland.csv": FARM}, {"farmland.csv": FARM.replace("potato,", "golden_potato,")})
        self.assertEqual(lines, ["1 file changed: 1 renamed", "", "- **Farmland**: Potato renamed to Golden Potato."])
        same = "a, 0, 1, 60, 1, 1\nb, 0, 1, 60, 1, 1\n"  # two removed and two added rows with identical cells: no guessing
        head = "name, cost, sell_value, production_time, yield, facility_level\n"
        lines = say({"farmland.csv": head + same}, {"farmland.csv": head + same.replace("a,", "c,").replace("b,", "d,")})
        self.assertEqual(lines[0], "1 file changed: 2 new recipes, 2 removed")

    def test_new_column_is_one_line_per_file(self):
        new = FARM.replace("facility_level\n", "facility_level, emode_base_time\n").replace("2\npotato", "2, 90\npotato")
        new = new.replace("potato, 1, 8, 640, 2, 2\n", "potato, 1, 8, 640, 2, 2,\n")
        self.assertEqual(say({"farmland.csv": FARM}, {"farmland.csv": new}),
                         ["1 file changed: 1 new column", "", "- **Farmland**: new column emode_base_time, filled for 1 of 2 rows."])
        gone = say({"farmland.csv": new}, {"farmland.csv": FARM})
        self.assertEqual(gone[2:], ["- **Farmland**: column emode_base_time removed (it was filled for 1 of 2 rows)."])

    def test_comment_lines_and_spacing_are_not_changes(self):
        old = "# a note\nname,cost,sell_value,production_time,yield,facility_level\nwheat,0,12,240,5,2\n\n# trailing\n"
        new = "name, cost, sell_value, production_time, yield, facility_level\nwheat, 0, 12, 240, 5, 2\n"
        self.assertEqual(say({"farmland.csv": old}, {"farmland.csv": new}), ["No data changes."])

    def test_empty_file(self):
        lines = say({"farmland.csv": ""}, {"farmland.csv": FARM})
        self.assertEqual(lines[0], "1 file changed: 2 new recipes")  # rows only, no "new column" for every column
        self.assertEqual(say({"farmland.csv": FARM}, {"farmland.csv": ""})[0], "1 file changed: 2 removed")
        self.assertEqual(say({"farmland.csv": ""}, {"farmland.csv": "# nothing\n"}), ["No data changes."])

    def test_pair_coverage_is_never_diffed_row_by_row(self):
        old = "types, first, second, dx, dy, counts\nFarmland, 1, 2, 1, 0, 0;23\n"
        new = old + "Farmland, 1, 2, 1, 1, 2;21\nFarmland, 1, 2, 2, 1, 3;20\n"
        self.assertEqual(say({"pair_coverage.csv": old}, {"pair_coverage.csv": new}),
                         ["1 file changed: 1 layout table regenerated", "", "- **Pair Coverage**: layout table regenerated (1 rows → 3 rows)."])
        self.assertEqual(say({"pair_coverage.csv": old}, {"pair_coverage.csv": "# regenerated\n" + old}), ["No data changes."])

    def test_module_requirement_wording(self):
        base = "name, workload, facility_level, module_requirement\nwheat, 3, 1, {}\n"
        def mod(old, new):
            return say({"well.csv": base.format(old)}, {"well.csv": base.format(new)})[2]
        self.assertEqual(mod("", "resource_detector:4"), "- **Well**: Wheat now needs Resource Detector Lv 4.")
        self.assertEqual(mod("resource_detector:3", "resource_detector:4"), "- **Well**: Wheat needs Resource Detector Lv 3 → Lv 4.")
        self.assertEqual(mod("kitchen_module:2", "resource_detector:4"), "- **Well**: Wheat needs Resource Detector Lv 4 (was Kitchen Module Lv 2).")
        self.assertEqual(mod("kitchen_module:2", ""), "- **Well**: Wheat no longer needs a module (was Kitchen Module Lv 2).")
        self.assertEqual(mod("", "kitchen_module"), "- **Well**: Wheat now needs Kitchen Module.")  # a bare name, no level

    def test_unverified_wording(self):
        old, new = "name, facility\nstar, Starfall Hammock\nscales, Floral Windmill\n", "name, facility\nscales, Floral Windmill\npearl, Tidewhisper Sandcastle\n"
        self.assertEqual(say({"unverified.csv": old}, {"unverified.csv": new}), [
            "1 file changed: 1 marked unverified, 1 confirmed", "",
            "- **Unverified**: Pearl (Tidewhisper Sandcastle) now marked unverified.",
            "- **Unverified**: Star (Starfall Hammock) now confirmed (no longer unverified)."])

    def test_other_files_and_keys(self):
        steps = "name, facility, step, ability, min_level, workload\nwheat, Farmland, Sowing, Grass, 1, 3\nwheat, Farmland, Reaping, Dark, 1, 3\n"
        lines = say({"grower_steps.csv": steps}, {"grower_steps.csv": steps.replace("Dark, 1, 3", "Dark, 2, 4")})
        self.assertEqual(lines[2:], ["- **Grower Steps**: Wheat (Farmland, Reaping) Aniimo min level 1 → 2.",
                                     "- **Grower Steps**: Wheat (Farmland, Reaping) workload 3 → 4, 33% more."])
        req = "name, facility, ability, min_level\nbread, Claw Game Cooker, Fire, 2\n"
        lines = say({"aniimo_requirements.csv": ""}, {"aniimo_requirements.csv": req})
        self.assertEqual(lines[2], "- **Aniimo Requirements**: new Aniimo requirement Bread (Claw Game Cooker): Aniimo ability Fire, Aniimo min level 2.")

    def test_duplicate_keys_get_numbered(self):
        old = "name, workload\nwheat, 10\nwheat, 20\nrice, 5\n"
        lines = say({"well.csv": old}, {"well.csv": old.replace("wheat, 20", "wheat, 30")})
        self.assertEqual(lines[2:], ["- **Well**: Wheat#2 workload 20 → 30, 50% more."])
        self.assertEqual(say({"well.csv": old}, {"well.csv": old + "wheat, 40\n"})[2:], ["- **Well**: new recipe Wheat#3 (workload 40)."])

    def test_a_name_that_becomes_duplicated_keeps_its_first_row(self):
        single, double = "name, workload\nwheat, 10\n", "name, workload\nwheat, 12\nwheat, 40\n"
        self.assertEqual(say({"well.csv": single}, {"well.csv": double}),
                         ["1 file changed: 1 value, 1 new recipe", "", "- **Well**: Wheat#1 workload 10 → 12, 20% more.",
                          "- **Well**: new recipe Wheat#2 (workload 40)."])
        self.assertEqual(say({"well.csv": double}, {"well.csv": single.replace("10", "12")}), ["1 file changed: 1 removed", "", "- **Well**: Wheat#2 removed."])
        self.assertEqual(say({"well.csv": double}, {"well.csv": single})[2:], ["- **Well**: Wheat#1 workload 12 → 10, 17% less.", "- **Well**: Wheat#2 removed."])

    def test_a_newline_inside_a_quoted_cell_is_not_a_crash(self):
        old = 'name, workload, environment\n"whe\nat", 10, "Co\nol"\n'
        lines = say({"well.csv": old}, {"well.csv": old.replace("10", "20").replace("Co\nol", "Warm")})
        self.assertEqual(lines[2:], ["- **Well**: Whe At workload 10 → 20, 100% more.", "- **Well**: Whe At environment Co ol → Warm."])
        self.assertEqual(say({"well.csv": ""}, {"well.csv": old})[2], "- **Well**: new recipe Whe At (workload 10).")

    def test_files_present_on_one_side_only(self):
        lines = say({"well.csv": "name, workload\na, 1\nb, 2\n"}, {"mine.csv": "name, workload\nrock, 9\n"})
        self.assertEqual(lines, ["2 files changed: 1 file added, 1 file removed", "",
                                 "- **Mine**: facility file mine.csv added (1 rows).", "- **Well**: facility file well.csv removed (2 rows)."])

    def test_max_lines_truncates(self):
        old = "name, workload\n" + "".join(f"r{i}, 10\n" for i in range(5))
        new = old.replace(", 10", ", 20")
        lines = say({"well.csv": old}, {"well.csv": new}, "--max-lines", "2")
        self.assertEqual(lines[0], "1 file changed: 5 values")
        self.assertEqual(len(lines), 5)
        self.assertEqual(lines[-1], "... and 3 more changes")
        exact = say({"well.csv": old}, {"well.csv": old.replace("r0, 10", "r0, 20")}, "--max-lines", "1")
        self.assertEqual(len(exact), 3)  # as many changes as the limit: no "... and N more" line

    def test_text_format_has_no_markdown(self):
        lines = say({"farmland.csv": FARM}, {"farmland.csv": FARM.replace("640", "320")}, "--format", "text")
        self.assertEqual(lines[2], "Farmland: Potato grow time 640 s (10m 40s) → 320 s (5m 20s), 50% faster.")


class ArgumentTest(unittest.TestCase):
    def assert_usage_error(self, *argv):
        code, out, err = run_main(*argv)
        self.assertEqual((code, out), (2, ""))
        self.assertEqual(len(err.strip().splitlines()), 1, err)
        self.assertTrue(err.startswith("describe_data_diff: "))

    def test_bad_arguments_exit_2_with_one_line(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assert_usage_error()
            self.assert_usage_error("--old", tmp)
            self.assert_usage_error("--old", tmp, "--new", str(Path(tmp) / "missing"))
            self.assert_usage_error("--old", tmp, "--new", tmp, "--max-lines", "0")
            self.assert_usage_error("--old", tmp, "--new", tmp, "--max-lines", "many")
            self.assert_usage_error("--old", tmp, "--new", tmp, "--format", "html")
            self.assert_usage_error("--old", tmp, "--new", tmp, "--git", "HEAD~1", "HEAD")
            with self.assertRaises(dd.UsageError):  # a ref that looks like a git option is refused before git runs
                dd.read_git(Path(tmp), "--output=x")

    def test_unreadable_file_exits_2(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "farmland.csv").write_bytes(b"name\n\xff\xfe\n")
            self.assert_usage_error("--old", tmp, "--new", tmp)

    def test_only_top_level_csv_files_are_read(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "notes.txt").write_text("x", encoding="utf-8")
            (Path(tmp) / "sub").mkdir()
            (Path(tmp) / "sub" / "farmland.csv").write_text(FARM, encoding="utf-8")
            self.assertEqual(run_main("--old", tmp, "--new", tmp), (0, "No data changes.\n", ""))


@unittest.skipUnless(shutil.which("git"), "git is not on PATH")
class GitModeTest(unittest.TestCase):
    def git(self, repo: Path, *args: str):
        subprocess.run(["git", "-C", str(repo), "-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", *args],
                       check=True, capture_output=True)

    def test_compares_two_refs_without_touching_the_working_tree(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            repo = Path(tmp)
            data = repo / "data"
            (data / "overrides").mkdir(parents=True)
            self.git(repo, "init", "-q")
            (data / "farmland.csv").write_text(FARM, encoding="utf-8", newline="")
            (data / "overrides" / "values.csv").write_text("a, b\n1, 2\n", encoding="utf-8")  # nested: never read
            (data / "notes.txt").write_text("not a csv", encoding="utf-8")
            self.git(repo, "add", ".")
            self.git(repo, "commit", "-q", "-m", "first")
            (data / "farmland.csv").write_text(FARM.replace("640", "320"), encoding="utf-8", newline="")
            (data / "overrides" / "values.csv").write_text("a, b\n9, 9\n", encoding="utf-8")
            (data / "pair_coverage.csv").write_text("types, first\nFarmland, 1\n", encoding="utf-8")
            self.git(repo, "add", ".")
            self.git(repo, "commit", "-q", "-m", "second")
            (data / "farmland.csv").write_text(FARM.replace("wheat, 0, 12, 240", "wheat, 0, 12, 100"), encoding="utf-8", newline="")  # uncommitted
            code, out, err = run_main("--git", "HEAD~1", "HEAD", "--repo", str(repo))
            self.assertEqual((code, err), (0, ""))
            self.assertEqual(out.splitlines(), [
                "2 files changed: 1 value, 1 file added", "",
                "- **Farmland**: Potato grow time 640 s (10m 40s) → 320 s (5m 20s), 50% faster.",
                "- **Pair Coverage**: facility file pair_coverage.csv added (1 rows)."])
            self.assertIn("wheat, 0, 12, 100", (data / "farmland.csv").read_text(encoding="utf-8"))  # still as I left it
            self.assertEqual(run_main("--git", "HEAD", "HEAD", "--repo", str(repo)), (0, "No data changes.\n", ""))
            code, out, err = run_main("--git", "HEAD", "nope", "--repo", str(repo))
            self.assertEqual((code, out, len(err.strip().splitlines())), (2, "", 1))


if __name__ == "__main__":
    unittest.main()

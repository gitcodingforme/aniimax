"""Tests for apply_overrides.py. Run from the repository root:
    python -m unittest discover -s scripts -p "test_*.py"
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import apply_overrides as ao  # noqa: E402

FARMLAND = (
    "name, cost, sell_value, production_time, yield\n"
    "wheat, 0, 1, 240, 5\n"
    "rose, 10, 95, 2400, 1\n"
)
STEPS = (
    "name, facility, step, workload\n"
    "wheat, Farmland, Sowing, 3\n"
    "wheat, Farmland, Reaping, 3\n"
)
HEADER = ", ".join(ao.OVERRIDE_COLUMNS) + "\n"


class Workspace:
    def __init__(self, values: str, structure: str | None = None, farmland: str = FARMLAND):
        self.dir = tempfile.TemporaryDirectory()
        self.root = Path(self.dir.name)
        (self.root / "data" / "overrides").mkdir(parents=True)
        (self.root / "data" / "farmland.csv").write_text(farmland, encoding="utf-8", newline="")
        (self.root / "data" / "grower_steps.csv").write_text(STEPS, encoding="utf-8", newline="")
        (self.root / "data" / "overrides" / "values.csv").write_text(HEADER + values, encoding="utf-8", newline="")
        if structure is not None:
            (self.root / "data" / "overrides" / "structure.json").write_text(structure, encoding="utf-8")

    def read(self, name: str) -> str:
        return (self.root / "data" / name).read_bytes().decode("utf-8")  # keep line endings as written


class ApplyOverridesTest(unittest.TestCase):
    def test_applies_cells_and_is_idempotent(self):
        ws = Workspace("farmland.csv, rose, production_time, 2100, 2400, 2026-10-20, timed twice\n"
                       "# a comment line\n"
                       "grower_steps.csv, name=wheat;step=Reaping, workload, 4\n")
        result = ao.run(ws.root, write=True, record=False)
        self.assertEqual(len(result.applied), 2)
        self.assertEqual(result.conflicts, [])
        self.assertEqual(ws.read("farmland.csv"), FARMLAND.replace("rose, 10, 95, 2400, 1", "rose, 10, 95, 2100, 1"))
        self.assertEqual(ws.read("grower_steps.csv"), STEPS.replace("Reaping, 3", "Reaping, 4"))
        again = ao.run(ws.root, write=True, record=False)
        self.assertEqual(again.applied, [])
        self.assertEqual(len(again.unchanged), 2)

    def test_check_mode_writes_nothing(self):
        ws = Workspace("farmland.csv, rose, production_time, 2100\n")
        result = ao.run(ws.root, write=False, record=False)
        self.assertEqual(len(result.applied), 1)
        self.assertEqual(ws.read("farmland.csv"), FARMLAND)

    def test_keeps_crlf_files_crlf(self):
        ws = Workspace("farmland.csv, rose, production_time, 2100\n", farmland=FARMLAND.replace("\n", "\r\n"))
        ao.run(ws.root, write=True, record=False)
        text = ws.read("farmland.csv")
        self.assertIn("rose, 10, 95, 2100, 1\r\n", text)
        self.assertEqual(text.count("\n"), text.count("\r\n"))  # no bare LFs sneaked in

    def test_reports_conflict_when_upstream_moved(self):
        ws = Workspace("farmland.csv, rose, production_time, 2100, 2000, 2026-10-20, note\n")
        result = ao.run(ws.root, write=False, record=False)
        self.assertEqual(len(result.conflicts), 1)
        self.assertEqual(result.conflicts[0].upstream_now, "2400")
        report = ao.conflict_report(result)
        self.assertIn("| farmland.csv | rose | production_time | 2100 (2026-10-20) | 2000 | 2400 |", report)
        self.assertIn("No conflicts", ao.conflict_report(ao.Result()))

    def test_record_fills_upstream_value(self):
        ws = Workspace("farmland.csv, rose, production_time, 2100\n")
        result = ao.run(ws.root, write=True, record=True)
        self.assertEqual(len(result.recorded), 1)
        self.assertIn("farmland.csv, rose, production_time, 2100, 2400", ws.read("overrides/values.csv"))
        self.assertEqual(ao.run(ws.root, write=False, record=False).conflicts, [])

    def test_rejects_bad_references(self):
        for row, message in [
            ("nope.csv, rose, production_time, 1", "does not exist"),
            ("farmland.csv, tulip, production_time, 1", "0 rows matching"),
            ("farmland.csv, rose, colour, 1", "no column 'colour'"),
            ("farmland.csv, rose, production_time, fast", "not a number"),
            ("grower_steps.csv, wheat, workload, 4", "2 rows matching"),
            ("grower_steps.csv, name=wheat;step, workload, 4", "bad match"),
            ("../Cargo.toml, x, y, 1", "does not exist"),
        ]:
            with self.subTest(row=row):
                ws = Workspace(row + "\n")
                with self.assertRaisesRegex(ao.OverrideError, message):
                    ao.run(ws.root, write=False, record=False)

    def test_structure_file_is_copied_or_rejected(self):
        ws = Workspace("", structure=json.dumps({"facilities": {"Well": {"counts": [0, 1]}}}))
        result = ao.run(ws.root, write=True, record=False)
        self.assertIn("structure.json", result.structure)
        copied = json.loads((ws.root / "web" / "structure-overrides.json").read_text(encoding="utf-8"))
        self.assertEqual(copied["facilities"]["Well"]["counts"], [0, 1])
        bad = Workspace("", structure="{not json")
        with self.assertRaisesRegex(ao.OverrideError, "not valid JSON"):
            ao.run(bad.root, write=False, record=False)

    def test_main_check_exit_codes(self):
        ws = Workspace("farmland.csv, rose, production_time, 2100\n")
        self.assertEqual(ao.main(["--root", str(ws.root), "--check"]), 0)
        bad = Workspace("farmland.csv, rose, nope, 2100\n")
        self.assertEqual(ao.main(["--root", str(bad.root), "--check"]), 1)


if __name__ == "__main__":
    unittest.main()

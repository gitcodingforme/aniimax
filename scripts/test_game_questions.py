"""Tests for game_questions.py and game_questions.json with made-up facts. Run from the repository root:
    python -m unittest discover -s scripts -p "test_*.py"
"""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import game_questions as gq  # noqa: E402

IDS = ["Q1", "Q2", "Q3", "Q4", "Q6", "Q7", "Q9", "E1", "E2", "E3", "E4", "E5", "E6", "E7", "W1", "CM", "UC", "L1", "SC"]
CATEGORIES = {"Farmland": "Materials", "Well": "Materials", "Mine": "Materials", "Chimney Kiln": "Materials Processing",
              "Simmering Pot": "Materials Processing", "Carousel Mill": "Materials Processing"}
TESTED = {"level_up": {"tested": True}, "pairs": {"tested": True}, "manage": {"tested": True}, "food": {"tested": True}, "store": {"tested": True},
          "emode": {"tested": True}, "facility_detail": {"tested": True}, "item_card": {"tested": True},
          "rv": {"tested": True}, "modules": {"tested": True}, "aniimo": {"tested": True}}
UNTESTED = {k: {"tested": k in ("facility_detail", "item_card")} for k in TESTED}


def at(minutes=0, seconds=0):
    total = int(minutes * 60 + seconds)
    return f"2099-01-01T{total // 3600:02d}:{total // 60 % 60:02d}:{total % 60:02d}Z"


def fact(kind, facility="", t=None, frame=None, untested=True, **values):
    out = {"t": t or at(), "frame": frame or "facility-20990101-000000.png", "facility": facility, "fact": kind, "v": 2, **values}
    if untested:
        out["untested"] = True
    return out


class QuestionsFileTest(unittest.TestCase):
    def test_the_file_has_the_19_questions_with_unique_ids_and_only_the_allowed_keys(self):
        data = json.loads(gq.QUESTIONS_FILE.read_text(encoding="utf-8"))
        self.assertEqual(set(data), gq.FILE_KEYS, "the top-level keys are pinned")
        self.assertEqual(gq.QUESTION_KEYS, {"id", "source", "question", "screen", "minutes", "detector", "settle", "settled_by_doc"})
        self.assertEqual([q["id"] for q in data["questions"]], IDS)
        for q in data["questions"]:
            self.assertEqual(set(q), gq.QUESTION_KEYS, q["id"])
            self.assertIn(q["settle"], ("auto", "owner"), q["id"])
            self.assertIsInstance(q["minutes"], int, q["id"])
            self.assertIsNone(q["settled_by_doc"], f"{q['id']}: nothing is settled yet")
        self.assertEqual(gq.check_file(data), [])
        self.assertEqual({q["id"] for q in data["questions"] if q["settle"] == "owner"}, {"Q1", "Q2", "Q3", "Q4", "Q9", "E2"})
        self.assertEqual(len(gq.load_questions()), 19)

    def test_a_bad_file_is_refused(self):
        data = json.loads(gq.QUESTIONS_FILE.read_text(encoding="utf-8"))
        data["questions"][0]["value_read"] = 54
        data["questions"][1]["id"] = "Q1"
        data["questions"][2]["detector"] = {"type": "guess"}
        data["extra"] = 1
        problems = " ".join(gq.check_file(data))
        for bit in ("keys must be exactly", "duplicate id Q1", "unknown detector", "unknown top-level key extra"):
            self.assertIn(bit, problems)


class DetectorTest(unittest.TestCase):
    def status(self, qid, facts, kinds=None, unverified=None, settled=None):
        questions = gq.load_questions()
        if settled:
            questions = [{**q, "settled_by_doc": settled} if q["id"] == qid else q for q in questions]
        found = gq.evaluate(questions, facts, categories=CATEGORIES, unverified=unverified, kinds=kinds or UNTESTED)
        return next(q["status"] for q in found if q["id"] == qid)

    def assert_steps(self, qid, open_facts, evidence_facts, answered_facts, kinds=TESTED):
        self.assertEqual(self.status(qid, open_facts, kinds), "open", qid)
        self.assertEqual(self.status(qid, evidence_facts, UNTESTED), "evidence", qid)
        self.assertEqual(self.status(qid, answered_facts, kinds), "answered", qid)

    def test_nothing_captured_leaves_everything_open(self):
        found = gq.evaluate(gq.load_questions(), [], categories=CATEGORIES, unverified=[{"name": "star", "confirmed": [], "partial": []}])
        self.assertEqual({q["status"] for q in found}, {"open"})

    def test_fact_detectors_go_open_evidence_answered(self):
        up = fact("level_up", "Chimney Kiln", next_level=3, coin_cost="75 000", rv_required=14)
        self.assert_steps("Q7", [fact("level_up", "Chimney Kiln", next_level=3, coin_cost=None, rv_required=None)], [up], [up])
        details = fact("panel", "Crackle Generator", tab="Details", capacity=600, in_use=450, supply_rate=100)
        self.assert_steps("E1", [fact("panel", "Storage Unit", capacity=600)], [details], [details])
        draw = [fact("emode", "Chimney Kiln", level=2, power_draw=30), fact("emode", "Chimney Kiln", level=3, power_draw=45)]
        self.assertEqual(self.status("E3", draw[:1], TESTED), "evidence", "one level is a start, not an answer")
        self.assert_steps("E3", [], draw, draw)
        manage = fact("manage", "Chimney Kiln", emode_on=True, slots_empty=1)
        self.assert_steps("E6", [fact("manage", "Chimney Kiln", emode_on=False)], [manage], [manage])
        level_one = fact("cap", "Farmland", level=1, held=2, cap=5)
        self.assert_steps("L1", [fact("cap", "Farmland", level=2, held=2, cap=10), fact("cap", "Chimney Kiln", level=1, cap=20)], [level_one], [level_one])

    def test_owner_questions_stop_at_evidence_until_settled_by_doc(self):
        full = fact("cap", "Farmland", level=7, held=35, cap=35)
        self.assertEqual(self.status("Q9", [fact("cap", "Farmland", level=7, held=20, cap=35)], TESTED), "open", "not full")
        self.assertEqual(self.status("Q9", [full], TESTED), "evidence", "captured, but the answer needs the owner")
        self.assertEqual(self.status("Q9", [full], TESTED, settled="docs/DECISIONS.md 2099-01-02"), "answered")
        self.assertEqual(self.status("Q4", [fact("panel", "Storage Unit", tab="Details")], TESTED), "evidence")
        self.assertEqual(self.status("E2", [fact("level_up", "Crackle Generator", next_level=3)], TESTED), "evidence")
        self.assertEqual(self.status("Q2", [fact("tick", "Farmland", untested=False, recipe="wheat", time="3m 0s", time_seconds=180)]), "evidence")
        self.assertEqual(self.status("Q3", [fact("tick", "Farmland", untested=False, recipe="wheat", time="3m 0s")], TESTED), "open", "manual")
        self.assertEqual(self.status("Q3", [], settled="docs/DECISIONS.md 2099-01-02"), "answered")

    def test_q1_needs_a_reset_on_a_processor(self):
        def tick(sec, s):
            return fact("tick", "Chimney Kiln", t=at(seconds=sec), untested=False, recipe="coarse_sifted_ore", time=f"{s}s", time_seconds=s)
        self.assertEqual(self.status("Q1", [tick(0, 5), tick(3, 2)]), "open", "a countdown alone is not a restart")
        self.assertEqual(self.status("Q1", [tick(0, 5), tick(3, 2), tick(7, 6)]), "evidence", "the time went back up: a new batch (owner checks)")

    def test_the_food_rate_needs_two_readings_an_hour_apart_with_no_rise(self):
        def food(minutes, energy, untested=False):
            return fact("food", t=at(minutes=minutes), untested=untested, total_food_energy=f"{energy:,}".replace(",", " "), energy=energy)
        self.assertEqual(self.status("W1", [], TESTED), "open")
        self.assertEqual(self.status("W1", [food(0, 20000)], TESTED), "evidence", "one reading")
        self.assertEqual(self.status("W1", [food(0, 20000), food(30, 18200)], TESTED), "evidence", "30 minutes is too short")
        self.assertEqual(self.status("W1", [food(0, 20000), food(60, 16400)], TESTED), "answered", "60 minutes, no rise")
        self.assertEqual(self.status("W1", [food(0, 20000), food(30, 30000), food(60, 26400)], TESTED), "evidence", "food was added between")
        self.assertEqual(self.status("W1", [food(0, 20000, True), food(60, 16400, True)], UNTESTED), "evidence", "an untested prompt stops at evidence")
        self.assertEqual(self.status("W1", [food(0, 20000, True), food(60, 16400, True)], TESTED), "answered",
                         "old facts count once the food spec is flipped to tested")

    def test_a_countdown_read_twice_a_minute_apart_answers_q6(self):
        def tick(sec, s, recipe="coarse_sifted_ore", facility="Chimney Kiln"):
            return fact("tick", facility, t=at(seconds=sec), untested=False, recipe=recipe, time=f"{s}s", time_seconds=s)
        self.assertEqual(self.status("Q6", [tick(0, 90)]), "evidence")
        self.assertEqual(self.status("Q6", [tick(0, 90), tick(30, 60)]), "evidence", "30 seconds apart")
        self.assertEqual(self.status("Q6", [tick(0, 90), tick(70, 20)]), "answered", "70 seconds apart")
        self.assertEqual(self.status("Q6", [tick(0, 90), tick(70, 20, recipe="wheatmeal", facility="Carousel Mill")]), "evidence",
                         "two different boxes are not a pair")
        self.assertEqual(self.status("Q6", [tick(0, 20), tick(30, 50), tick(70, 30)]), "evidence", "a reset between spoils the pair")

    def test_carousel_mill_by_two_frames_or_by_its_level_up_tab(self):
        def mill(rv, frame):
            return fact("unlock", "Carousel Mill", untested=False, frame=frame, facility_level=4, rv_level=rv)
        self.assertEqual(self.status("CM", [mill(12, "facility-20990101-000000.png")]), "evidence")
        self.assertEqual(self.status("CM", [mill(12, "facility-20990101-000000.png"), mill(13, "facility-20990101-000001.png")]), "evidence", "two different numbers")
        self.assertEqual(self.status("CM", [mill(13, "facility-20990101-000000.png"), mill(13, "facility-20990101-000000.png")]), "evidence", "one frame twice")
        self.assertEqual(self.status("CM", [mill(13, "facility-20990101-000000.png"), mill(13, "facility-20990101-000001.png")]), "answered")
        up = fact("level_up", "Carousel Mill", next_level=4, rv_required=13)
        self.assertEqual(self.status("CM", [up], UNTESTED), "evidence")
        self.assertEqual(self.status("CM", [up], TESTED), "answered")

    def test_unverified_cards_and_screens(self):
        rows = lambda *states: [{"name": n, "confirmed": [1] if s == "c" else [], "partial": [1] if s == "p" else []}  # noqa: E731
                                for n, s in zip(("star", "scales", "quick_scales"), states)]
        self.assertEqual(self.status("UC", [], unverified=rows("", "", "")), "open")
        self.assertEqual(self.status("UC", [], unverified=rows("c", "p", "")), "evidence")
        self.assertEqual(self.status("UC", [], unverified=rows("c", "c", "c")), "answered")
        screens = [fact("screen", screen=s, read=True) for s in ("rv", "modules", "aniimo")]
        self.assert_steps("SC", [], screens[:2], screens)

    def test_e_mode_combinations(self):
        well = fact("emode", "Well", switch_visible=False)
        mine = fact("emode", "Mine", switch_visible=True)
        card = fact("card", "Well", untested=False, item="well_water", time="30m 0s")
        self.assertEqual(self.status("E5", [well, mine], TESTED), "evidence", "the card is still missing")
        self.assertEqual(self.status("E5", [well, mine, card], TESTED), "answered")
        self.assertEqual(self.status("E5", [well, mine, card], UNTESTED), "evidence")
        above = fact("panel", "Crackle Generator", capacity=600, in_use=520, supply_rate=100)
        self.assertEqual(self.status("E4", [fact("panel", "Crackle Generator", capacity=600, in_use=450, supply_rate=120)], TESTED), "evidence")
        self.assertEqual(self.status("E4", [above], TESTED), "answered", "520 x 1.2 is above 600")
        at_120 = fact("panel", "Crackle Generator", t=at(minutes=0), capacity=600, in_use=450, supply_rate=120)
        near = fact("card", "Simmering Pot", t=at(minutes=8), untested=False, item="rose_concentrate", time="1m 48s")
        late = fact("card", "Simmering Pot", t=at(minutes=25), untested=False, item="rose_concentrate", time="1m 48s")
        self.assertEqual(self.status("E7", [at_120, late], TESTED), "evidence")
        self.assertEqual(self.status("E7", [at_120, near], TESTED), "answered")
        self.assertEqual(self.status("E7", [at_120, near], UNTESTED), "evidence", "the generator reading's prompt is untested")


if __name__ == "__main__":
    unittest.main()

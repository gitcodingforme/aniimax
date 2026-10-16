#!/usr/bin/env python3
"""Watch the Aniimo game window while you play and keep the screenshot reading current.

Passive by design: it only captures what is on screen (the same thing the Windows screenshot key
does). It never sends clicks or keys to the game, never reads its memory, files or network, and
nothing leaves this PC: frames go to the Ollama server on localhost. The site still shows a diff
to confirm before anything is applied ("Load screenshot reading", or the hint that appears on the
local site when a new reading exists).

How it works, every --interval seconds:
  1. find the game window by title (--title, default "Aniimo") and grab just that window;
  2. skip frames that are still changing (menus sliding in) or identical to the last one read;
  3. ask the vision model which screen it is (RV, facility, modules, Aniimo roster, storage, other);
  4. for a known screen, read it with the same prompts as read_screenshots.py, save the frame to
     screenshots/auto/<kind>-<time>.png, and rewrite screenshots/reading.json (and web/reading.json
     for the local site). Newer readings of the same screen replace older ones;
  5. whenever a reading carries the Home Coins number and it changed, append it with the time to
     screenshots/coins.jsonl (kept across --fresh) and rewrite coins.json (and web/coins.json) for
     the History chart on the local site;
  6. for a facility panel, also note what the game shows about that facility (the RV level its next
     level needs, the recipe that is running and its time) in screenshots/observations.jsonl
     (kept across --fresh), compare those facts with the fork's data (scripts/verify_data.py) and
     rewrite screenshots/verification.md (and web/verification.json);
  7. for an item's information card (open beside a facility panel, or on its own as a "stock"
     screen), note the facility and level that make the item, its time or workload and its
     environment the same way: a "card" fact, judged against that item's CSV row;
  8. for the screens the game questions need (scripts/game_questions.json): a Level Up tab
     ("level_up", plus the unlock it states), the Crackle Generator and Storage Unit panels
     ("panel"), a Manage tab ("manage"), a plot's held/cap line ("cap"), an E-mode switch ("emode"),
     the Food tab ("food"), every set recipe box with its time ("tick"), and the RV, modules and
     roster screens ("screen", read: true only). Facts read with a prompt that has no checked frames
     carry "untested": true; all of these carry "v": 2.

Usage (from the repository root):
  python scripts/watch_game.py                    watch until Ctrl+C
  python scripts/watch_game.py --once             grab one frame, read it, exit (good for a test)
  python scripts/watch_game.py --replay DIR       treat the images in DIR as frames, then exit
  python scripts/watch_game.py --fresh --replay screenshots/auto
                                                  rebuild the reading from the saved frames (after a prompt change)
  python scripts/watch_game.py --check            confirm the window and the model can be found
  python scripts/watch_game.py --questions        print the game-question checklist (no game, no Ollama)
  python scripts/watch_game.py --prune-copied-times
                                                  list observation lines whose card time was probably copied
                                                  from another card (dry run: writes nothing; no game, no Ollama)
  python scripts/watch_game.py --prune-copied-times --apply --max 1
                                                  clear those times (refused above --max matches), after a
                                                  .bak-<date> copy of observations.jsonl; then re-run the check
Needs Pillow (present on this PC). Starts Ollama if it is installed but not running (--no-start to never do that).
"""
from __future__ import annotations

import argparse
import base64
import ctypes
import io
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import read_screenshots as rs  # noqa: E402  (prompts, model calls, merging)
import verify_data  # noqa: E402  (the data check, and the game's time format)

KINDS = ["rv", "home", "facility", "modules", "aniimo", "stock", "food"]
# Stock comes before aniimo: the model called item cards "aniimo" (a card's title read as a name), so
# the card is described first and a card with 'Inventory:' is named as stock outright. The food kind
# (the Food tab of Aniimo Management) is INFERRED: no frame of it exists yet.
CLASSIFY_PROMPT = (
    "This is a screenshot from the game Aniimo. Which screen is it? Answer with exactly one of: "
    "home (the Home Management screen: a green grid of white plot tiles with facility icons and 'Lv.' badges, with NO side panel open on the right), "
    "facility (the Home Management grid WITH a side panel open on the right whose heading is a facility name followed by '(Level N)', e.g. 'Chimney Kiln (Level 2)'; answer facility whenever such a panel is open, even if an item card or other window is also on screen), "
    "rv (a screen that writes the RV level as text, e.g. 'RV Lv.12'), "
    "modules (a screen listing Ecological Module, Kitchen Module, Resource Detector and Crafting Module with their levels), "
    "stock (an item's detail card: an item name as a title with 'Inventory:' and 'Homeland:' counts, or a shop item with 'Owned N'; a card with 'Inventory:' is stock, never aniimo), "
    "aniimo (the Aniimo roster: a list of several Aniimo, each with its name and ability levels written as text), "
    "food (the Food tab of Aniimo Management: a shared food bowl with a total food energy number), "
    "or other (anything else: the open world, a battle, a loading screen, a dialog, an egg hatching, daily orders, mail, "
    "or the Warehouse grid of item icons with numbers but no names). "
    "Choose 'stock' or 'aniimo' only when the names are written as text."
)
CLASSIFY_SCHEMA = {"type": "object", "properties": {"kind": {"type": "string", "enum": KINDS + ["other"]}}, "required": ["kind"]}
CLASSIFY_SIDE = 1000  # px; a smaller image is enough to tell screens apart and is faster

SETTLED = 0.010   # share of pixels that changed, below which the picture has stopped moving
CHANGED = 0.004   # above which it is a new picture compared with the last one read (a panel's text differs by about 1%)
REREAD_SECONDS = 60  # a still picture is looked at again this often, in case an animated background hid a change
FP_SIZE = (96, 54)
FP_LEVEL = 24     # a pixel counts as changed when its grey value moved by more than this (0-255)
COIN_KINDS = ("rv", "home", "facility")  # screens whose reading can carry the Home Coins number
OBSERVATION_FORMAT = "aniimax-observations"
# What the observation log holds (see verify_data.py). The first three are judged against the data;
# the rest are kept for the game questions (scripts/game_questions.py) and carry "v": 2.
FACTS = ("unlock", "recipe", "card", "level_up", "panel", "manage", "food", "cap", "emode", "tick", "screen")
FACT_VERSION = 2
UNLOCK_FRAMES = 2  # an unlock line is logged from this many different frames (verify_data.UNCLEAR_FRAMES)
FRAME_FACTS = ("card", "unlock", "level_up", "panel")  # facts whose frame is kept past the --keep limit
CARD_KINDS = ("facility", "stock")    # screens whose reading can carry an item card under `card`
SCREEN_FACT_KINDS = ("rv", "modules", "aniimo")  # logged as {fact: screen, read: true} only, never their values
OBSERVED_KINDS = CARD_KINDS + ("food",) + SCREEN_FACT_KINDS
COIN_POINTS = 2000  # how many points coins.json keeps for the chart
FILE_TIME = re.compile(r"^[a-z]+-(\d{8})-(\d{6})")  # <kind>-YYYYMMDD-HHMMSS, local time, as save_frame names frames


def frame_time(name: str) -> str:
    """'YYYYMMDDHHMMSS' from a saved frame's name, or '' for any other file (sorts first)."""
    match = FILE_TIME.match(name)
    return (match.group(1) + match.group(2)) if match else ""
OTHER_KEEP = 10   # how many frames the model called "other" to keep, so a wrong "other" can be checked
NOT_GAME = {"chrome.exe", "msedge.exe", "firefox.exe", "brave.exe", "opera.exe", "windowsterminal.exe", "conhost.exe",
            "cmd.exe", "powershell.exe", "pwsh.exe", "python.exe", "code.exe", "claude.exe", "explorer.exe", "mintty.exe"}


# --- the game window (Windows only; the pure functions are testable anywhere) ------------------------

def list_windows() -> list[dict]:
    """Every visible top-level window: title, exe name, rect (left, top, right, bottom), minimized."""
    import ctypes.wintypes
    user32, kernel32 = ctypes.windll.user32, ctypes.windll.kernel32
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)  # rects in real pixels, like the screen grab
    except Exception:
        pass
    windows = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    def callback(hwnd, _):
        if not user32.IsWindowVisible(hwnd):
            return True
        length = user32.GetWindowTextLengthW(hwnd)
        if length == 0:
            return True
        title = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, title, length + 1)
        rect = ctypes.wintypes.RECT()
        try:  # the frame without the invisible resize borders
            if ctypes.windll.dwmapi.DwmGetWindowAttribute(ctypes.c_void_p(hwnd), 9, ctypes.byref(rect), ctypes.sizeof(rect)) != 0:
                user32.GetWindowRect(hwnd, ctypes.byref(rect))
        except Exception:
            user32.GetWindowRect(hwnd, ctypes.byref(rect))
        pid = ctypes.c_ulong()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        exe = ""
        handle = kernel32.OpenProcess(0x1000, False, pid.value)  # PROCESS_QUERY_LIMITED_INFORMATION
        if handle:
            buffer = ctypes.create_unicode_buffer(1024)
            size = ctypes.c_ulong(1024)
            if kernel32.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)):
                exe = os.path.basename(buffer.value)
            kernel32.CloseHandle(handle)
        windows.append({"hwnd": hwnd, "title": title.value, "exe": exe, "minimized": bool(user32.IsIconic(hwnd)),
                        "rect": (rect.left, rect.top, rect.right, rect.bottom)})
        return True

    user32.EnumWindows(callback, 0)
    return windows


def pick_window(windows: list[dict], title: str, exe: str | None = None) -> dict | None:
    """The game window among all windows: the title starts with `title` (case does not matter),
    the process is not a browser, terminal or editor (they show the word in tab titles), and it is
    not minimized (a minimized window grabs as black). An exact title match wins over a prefix."""
    wanted = title.strip().lower()
    candidates = []
    for w in windows:
        t = w["title"].strip().lower()
        if not t.startswith(wanted) or w["minimized"]:
            continue
        if exe and w["exe"].lower() != exe.lower():
            continue
        if not exe and w["exe"].lower() in NOT_GAME:
            continue
        left, top, right, bottom = w["rect"]
        if right - left < 200 or bottom - top < 200:
            continue
        candidates.append(w)
    candidates.sort(key=lambda w: (w["title"].strip().lower() != wanted, w["exe"].lower() != "aniimo.exe"))
    return candidates[0] if candidates else None


def grab_window(window: dict):
    """The window's own picture, even when another window (this app, a browser) lies on top of it.
    PrintWindow with PW_RENDERFULLCONTENT asks Windows for the composed frame of just that window;
    if that comes back empty (some programs refuse), fall back to a plain screen grab of its area."""
    image = print_window(window["hwnd"])
    if image is not None and not is_blank(image):
        return image
    from PIL import ImageGrab
    return ImageGrab.grab(bbox=window["rect"], all_screens=True).convert("RGB")


def print_window(hwnd):
    import ctypes.wintypes as wt
    from PIL import Image
    user32, gdi32 = ctypes.windll.user32, ctypes.windll.gdi32
    rect = wt.RECT()
    user32.GetClientRect(hwnd, ctypes.byref(rect))
    width, height = rect.right - rect.left, rect.bottom - rect.top
    if width < 2 or height < 2:
        return None

    class BitmapInfoHeader(ctypes.Structure):
        _fields_ = [("biSize", wt.DWORD), ("biWidth", wt.LONG), ("biHeight", wt.LONG), ("biPlanes", wt.WORD), ("biBitCount", wt.WORD),
                    ("biCompression", wt.DWORD), ("biSizeImage", wt.DWORD), ("biXPelsPerMeter", wt.LONG), ("biYPelsPerMeter", wt.LONG),
                    ("biClrUsed", wt.DWORD), ("biClrImportant", wt.DWORD)]

    hdc = user32.GetWindowDC(hwnd)
    mdc = gdi32.CreateCompatibleDC(hdc)
    bmp = gdi32.CreateCompatibleBitmap(hdc, width, height)
    try:
        gdi32.SelectObject(mdc, bmp)
        if not user32.PrintWindow(hwnd, mdc, 2):  # 2 = PW_RENDERFULLCONTENT
            return None
        info = BitmapInfoHeader()
        info.biSize, info.biWidth, info.biHeight, info.biPlanes, info.biBitCount = ctypes.sizeof(info), width, -height, 1, 32
        buffer = ctypes.create_string_buffer(width * height * 4)
        if gdi32.GetDIBits(mdc, bmp, 0, height, buffer, ctypes.byref(info), 0) != height:
            return None
        return Image.frombuffer("RGB", (width, height), buffer, "raw", "BGRX", 0, 1).copy()
    finally:
        gdi32.DeleteObject(bmp)
        gdi32.DeleteDC(mdc)
        user32.ReleaseDC(hwnd, hdc)


def is_blank(image) -> bool:
    """All black (or all one shade): what a window gives when it refuses to be printed."""
    extrema = image.convert("L").resize(FP_SIZE).getextrema()
    return extrema[1] - extrema[0] < 8


# --- telling frames apart -----------------------------------------------------------------------------

def fingerprint(image) -> bytes:
    """A small grey version of the frame; two fingerprints compare in well under a millisecond."""
    return image.convert("L").resize(FP_SIZE).tobytes()


def difference(a: bytes | None, b: bytes | None) -> float:
    """Share of pixels that differ clearly between two fingerprints: 0 (same picture) to 1 (all changed)."""
    if a is None or b is None:
        return 1.0
    return sum(1 for x, y in zip(a, b) if abs(x - y) > FP_LEVEL) / len(a)


def supersedes(new: dict, old: dict) -> bool:
    """Does a newly read screen replace an older one? Same screen (RV, modules), the same facility,
    or a roster/storage page that shows everything the older page showed."""
    if new["kind"] != old["kind"]:
        return False
    if new["kind"] in ("rv", "home", "modules", "food"):
        return True
    nf, of = new.get("fields") or {}, old.get("fields") or {}
    if new["kind"] == "facility":
        return rs.slug(str(nf.get("facility") or "")) == rs.slug(str(of.get("facility") or ""))
    key = "aniimo" if new["kind"] == "aniimo" else "items"
    new_names = {rs.slug(str(e.get("name") or "")) for e in nf.get(key) or []}
    old_names = {rs.slug(str(e.get("name") or "")) for e in of.get(key) or []}
    return bool(old_names) and old_names <= new_names


def encode(image, max_side: int, crop=None) -> str:
    """The frame as base64 PNG, shrunk to max_side. `crop` (fractions of the frame, or a function of
    its size; see read_screenshots.crop_box) is cut out before shrinking so a panel's small text
    keeps its detail."""
    im = image
    if crop:
        im = im.crop(rs.crop_box(im.size, crop))
    if crop or max(im.size) > max_side:
        im = im.copy()
        im.thumbnail((max_side, max_side))
    out = io.BytesIO()
    im.save(out, format="PNG")
    return base64.b64encode(out.getvalue()).decode("ascii")


# --- the watcher ----------------------------------------------------------------------------------------

class Watcher:
    def __init__(self, root: Path, host: str, model: str, out_dir: Path, web_dir: Path | None, ask=None, now=None, keep=50):
        self.root, self.host, self.model = root, host, model
        self.out_dir, self.web_dir, self.keep = out_dir, web_dir, keep
        self.ask = ask or (lambda prompt, schema, image_b64: rs.ask_model(host, model, prompt, schema, image_b64, keep_alive="30m"))
        self.now = now or time.time
        self.names = rs.known_names(root)
        self.screens: list[dict] = []
        self.last_fp: bytes | None = None       # the previous frame, to see whether the picture has settled
        self.read_fp: bytes | None = None       # the last frame that was read
        self.read_at = 0.0                      # when it was read
        self.started = self.now()
        self.frames = self.looked = 0
        self.window_title = ""
        self.coins_path = out_dir.parent / "coins.jsonl"
        self.coin_points: list[dict] = []
        self.observations_path = out_dir.parent / "observations.jsonl"
        self.observations: list[dict] = []
        self.observation_notes: list[str] = []  # why a facility frame contributed nothing
        self.question_status: dict[str, str] = {}  # game question id -> status, to print a line when one changes
        self.load()
        self.load_coins()
        self.load_observations()
        if self.web_dir and self.observations:
            self.verify()  # the report reflects today's data and overrides, not the last fact's
        self.questions_baseline = True  # from here on, a game question whose status changes gets a line

    def load(self) -> int:
        """Continue from the previous reading, so a short session adds to it instead of replacing it."""
        path = self.out_dir.parent / "reading.json"
        try:
            data = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}
        except (OSError, ValueError):
            data = {}
        screens = data.get("screens") if data.get("format") == rs.READING_FORMAT else None
        self.screens = [s for s in screens or [] if isinstance(s, dict) and s.get("kind") in KINDS and not s.get("error")]
        return len(self.screens)

    def load_coins(self) -> int:
        """The coin log from earlier sessions (one JSON object per line; bad lines are skipped)."""
        self.coin_points = []
        try:
            lines = self.coins_path.read_text(encoding="utf-8").splitlines() if self.coins_path.is_file() else []
        except (OSError, ValueError):  # unreadable or not UTF-8: start the log afresh in memory
            lines = []
        for line in lines:
            try:
                point = json.loads(line)
            except ValueError:
                continue
            if isinstance(point, dict) and isinstance(point.get("t"), str) and isinstance(point.get("coins"), int):
                self.coin_points.append(point)
        return len(self.coin_points)

    def load_observations(self) -> int:
        """The observation log from earlier sessions (one JSON object per line; bad lines are skipped)."""
        self.observations = []
        try:
            lines = self.observations_path.read_text(encoding="utf-8").splitlines() if self.observations_path.is_file() else []
        except (OSError, ValueError):
            lines = []
        for line in lines:
            try:
                item = json.loads(line)
            except ValueError:
                continue
            if isinstance(item, dict) and isinstance(item.get("t"), str) and isinstance(item.get("facility"), str) and item.get("fact") in FACTS:
                self.observations.append(item)
        return len(self.observations)

    def point_time(self, source: str) -> str:
        """UTC time for a coin reading: the time in a saved frame's name (local time) when replaying, else now."""
        match = FILE_TIME.match(source)
        if match:
            try:
                local = datetime.strptime(match.group(1) + match.group(2), "%Y%m%d%H%M%S")
                return local.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            except ValueError:
                pass
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(self.now()))

    def log_coins(self, entry: dict, source: str) -> bool:
        """Append the Home Coins number to the coin log when this reading has one that differs from the last logged."""
        if entry.get("kind") not in COIN_KINDS:
            return False
        coins = rs.count_from((entry.get("fields") or {}).get("coins"))
        if coins is None or coins < 0:
            return False
        t = self.point_time(source)
        if self.coin_points and self.coin_points[-1]["coins"] == coins:
            return False
        if any(p["t"] == t and p["coins"] == coins for p in self.coin_points):  # replaying the same frames again
            return False
        point = {"t": t, "coins": coins, "screen": entry["kind"], "file": entry.get("file") or source}
        self.coins_path.parent.mkdir(parents=True, exist_ok=True)
        # A last line without its newline (an interrupted write, or an editor) must not swallow this one.
        needs_newline = self.coins_path.is_file() and self.coins_path.stat().st_size > 0 and not self.coins_path.read_bytes().endswith(b"\n")
        with self.coins_path.open("a", encoding="utf-8") as f:
            f.write(("\n" if needs_newline else "") + json.dumps(point) + "\n")
        self.coin_points.append(point)
        self.write_coins()
        print(f"{time.strftime('%H:%M:%S')} coins {coins} logged")
        return True

    def write_coins(self) -> list[Path]:
        """coins.json for the History chart: the newest points in time order, as {t, coins}."""
        points = sorted(({"t": p["t"], "coins": p["coins"]} for p in self.coin_points), key=lambda p: p["t"])[-COIN_POINTS:]
        text = json.dumps({"format": "aniimax-coin-log", "version": 1, "points": points})
        targets = [self.out_dir.parent / "coins.json"]
        if self.web_dir and self.web_dir.is_dir():
            targets.append(self.web_dir / "coins.json")
        for target in targets:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text, encoding="utf-8")
        return targets

    # The values that make a fact new, per type (after facility and type). A recipe leaves out its time
    # (it may be a countdown, and a new value every frame would swell the counts); a tick keeps it and
    # the time of the frame, because a series over time is what it is for; so does food.
    KEY_FIELDS = {
        "unlock": ("facility_level", "rv_level"),
        "card": ("item", "facility_level", "time_seconds", "workload", "environment"),  # a differing re-reading shows up as a second fact
        "recipe": ("recipe",),
        "level_up": ("level", "next_level", "coin_cost", "rv_required", "max_level"),
        "panel": ("tab", "level", "capacity", "in_use", "supply_rate", "supply_mode"),
        "manage": ("level", "slots_total", "slots_empty", "first_ability", "emode_on"),
        "food": ("t", "total_food_energy", "working_aniimo"),
        "cap": ("level", "held", "cap"),
        "emode": ("level", "switch_visible", "emode_on", "power_draw"),
        "tick": ("recipe", "time", "t"),
        "screen": ("screen",),
    }

    @staticmethod
    def observation_key(item: dict) -> tuple:
        fields = Watcher.KEY_FIELDS.get(item["fact"], Watcher.KEY_FIELDS["recipe"])
        return (item["facility"], item["fact"]) + tuple(item.get(k) for k in fields)

    @staticmethod
    def new_fact(base: dict, fact: str, spec: str, **values) -> dict:
        """A fact of a newer type: "v": 2, and "untested": true while `spec`'s prompt has no checked frames."""
        out = {**base, "fact": fact, "v": FACT_VERSION, **values}
        if not rs.is_tested(spec):
            out["untested"] = True
        return out

    def side_facts(self, fields: dict, base: dict) -> list[dict]:
        """The facts of the side questions read on a trusted panel (each asked only on its tab, see
        read_screenshots ONLY_IF): Level Up (plus the unlock it states), Manage, a plot's store, the
        E-mode switch and the Food tab."""
        found = []
        whole = lambda v: v if isinstance(v, int) and not isinstance(v, bool) and v > 0 else None  # noqa: E731
        up = fields.get("level_up")
        if isinstance(up, dict):
            materials = [[up.get(f"material_{i}_name"), up.get(f"material_{i}_amount")] for i in (1, 2) if up.get(f"material_{i}_name")]
            found.append(self.new_fact(base, "level_up", "level_up", max_level=up.get("max_level") is True, next_level=whole(up.get("next_level")),
                                       coin_cost=str(up["coin_cost"]).strip() if up.get("coin_cost") is not None else None,
                                       rv_required=whole(up.get("rv_required")), materials=materials))
            if whole(up.get("next_level")) and whole(up.get("rv_required")):
                found.append(self.new_fact(base, "unlock", "level_up", facility_level=up["next_level"], rv_level=up["rv_required"], source="level_up"))
        manage = fields.get("manage")
        if isinstance(manage, dict):
            ability = next((a for a in rs.ABILITIES if rs.slug(a) == rs.slug(manage.get("first_ability") or "")), None)
            # Not the Aniimo's name: only whether a slot holds one (names stay out of the log).
            found.append(self.new_fact(base, "manage", "manage", slots_total=manage.get("slots_total"), slots_empty=manage.get("slots_empty"),
                                       first_ability=ability, named=bool(manage.get("first_name")), emode_on=manage.get("emode_on")))
        store = fields.get("store")
        if isinstance(store, dict) and (isinstance(store.get("held"), int) or isinstance(store.get("cap"), int)):
            found.append(self.new_fact(base, "cap", "store", label=store.get("label"), held=store.get("held"), cap=store.get("cap")))
        emode = fields.get("emode")
        if isinstance(emode, dict) and any(emode.get(k) is not None for k in ("switch_visible", "emode_on", "power_draw")):
            found.append(self.new_fact(base, "emode", "emode", switch_visible=emode.get("switch_visible"), emode_on=emode.get("emode_on"),
                                       power_draw=emode.get("power_draw")))
        food = self.food_fact(fields.get("food"), base["frame"], base["t"])
        if food:
            found.append(food)
        return found

    def food_fact(self, read, frame: str, t: str) -> dict | None:
        """The Food tab's total food energy (as written and as a number) with the frame's time, or None."""
        if not isinstance(read, dict) or rs.count_from(read.get("total_food_energy")) is None:
            return None
        return self.new_fact({"t": t, "frame": frame, "facility": ""}, "food", "food", total_food_energy=str(read["total_food_energy"]).strip(),
                             energy=rs.count_from(read["total_food_energy"]), working_aniimo=read.get("working_aniimo"))

    def aux_facts(self, facility: str, fields: dict, frame: str, t: str) -> list[dict]:
        """A Crackle Generator or Storage Unit panel: a `panel` fact (tab, level and, from the pairs
        question, capacity, power in use and supply rate with the raw label/value pairs), plus what
        its other tabs show (Level Up, Manage)."""
        level = fields.get("level") if isinstance(fields.get("level"), int) and not isinstance(fields.get("level"), bool) else None
        base = {"t": t, "frame": frame, "facility": facility, "level": level}
        pairs = fields.get("pairs") if isinstance(fields.get("pairs"), dict) else {}
        raw = [[pairs.get(f"label_{i}"), pairs.get(f"value_{i}")] for i in range(1, 5) if pairs.get(f"label_{i}") is not None]
        panel = self.new_fact(base, "panel", "pairs", tab=fields.get("tab"), capacity=pairs.get("capacity"), in_use=pairs.get("in_use"),
                              supply_rate=pairs.get("supply_rate"), supply_mode=pairs.get("supply_mode"), pairs=raw)
        return [panel] + self.side_facts(fields, base)

    def panel_facts(self, fields: dict, frame: str, t: str, notes: list[str]) -> list[dict]:
        """The facts a facility panel shows: its unlock line and its set recipe (and that recipe's time
        as a `tick`), and what its side questions read (side_facts). The model sometimes invents a
        panel (a facility that does not exist, a recipe that is not an item), so the panel only counts
        when its facility is a known facility and, if a recipe is set, the recipe is a known item;
        otherwise nothing comes back and a note says why. A Crackle Generator or Storage Unit panel,
        which the site does not model, gives a `panel` fact (aux_facts) instead of a skip."""
        aux = rs.known_facility(fields.get("facility"), {"facilities": [], "aux": self.names.get("aux") or rs.AUX_FACILITIES})
        if aux:
            return self.aux_facts(aux, fields, frame, t)
        facility = rs.match_name(fields.get("facility"), self.names["facilities"], notes, f"{frame} facility")
        recipe = None
        if facility and fields.get("recipe_status") == "set":
            recipe = rs.match_name(fields.get("recipe"), self.names["items"], notes, f"{frame} recipe")
            if not recipe:
                if fields.get("recipe") in (None, ""):
                    notes.append(f"{frame}: a recipe is set but its name could not be read")
                facility = None  # a real facility name with a made-up recipe: probably no panel at all
        if not facility:
            if not notes:
                notes.append(f"{frame}: no facility name in the panel")
            notes.append(f"{frame}: nothing logged (the panel was not trusted)")
            return []
        level = fields.get("level") if isinstance(fields.get("level"), int) and not isinstance(fields.get("level"), bool) else None
        base = {"t": t, "frame": frame, "facility": facility, "level": level}
        found = []
        note = fields.get("upgrade_note")
        if isinstance(note, dict):
            fl, rv = note.get("facility_level"), note.get("rv_level")
            if all(isinstance(n, int) and not isinstance(n, bool) and n > 0 for n in (fl, rv)):
                found.append({**base, "fact": "unlock", "facility_level": fl, "rv_level": rv})
        if recipe:
            time_text = str(fields.get("recipe_time") or "").strip() or None
            found.append({**base, "fact": "recipe", "recipe": recipe, "time": time_text})
            if time_text:  # every reading of the box, over time (a countdown, or not: game question Q6)
                found.append(self.new_fact(base, "tick", "facility_detail", recipe=recipe, time=time_text, time_seconds=verify_data.parse_seconds(time_text)))
        return found + self.side_facts(fields, base)

    def card_facts(self, fields: dict, frame: str, t: str, notes: list[str]) -> list[dict]:
        """The facts an item's information card shows (`card` of a stock or facility reading, and the
        card half hidden behind it under `behind`): the item, the facility and level that make it, its
        time (and that time in seconds) or workload, and its environment. A card counts only when the
        item is a known item and the facility a known facility; otherwise a note says why."""
        found = []
        card = fields.get("card")
        for which, read in (("card", card), ("card behind", (card or {}).get("behind") if isinstance(card, dict) else None)):
            if not isinstance(read, dict):
                continue
            item = rs.match_name(read.get("item"), self.names["items"], notes, f"{frame} {which} item")
            facility = rs.match_name(read.get("facility"), self.names["facilities"], notes, f"{frame} {which} facility")
            if not item or not facility:
                if read.get("item") in (None, "") and read.get("facility") in (None, ""):
                    notes.append(f"{frame}: the {which} had no readable title or facility line")
                notes.append(f"{frame}: {which} not logged (item or facility not known)")
                continue
            whole = lambda v: v if isinstance(v, int) and not isinstance(v, bool) and v > 0 else None  # noqa: E731
            time_text = str(read.get("time") or "").strip() or None
            env = str(read.get("environment") or "").strip() or None
            fact = {"t": t, "frame": frame, "facility": facility, "fact": "card", "item": item,
                    "facility_level": whole(read.get("facility_level")), "time": time_text,
                    "time_seconds": verify_data.parse_seconds(time_text), "workload": whole(read.get("workload")), "environment": env}
            if which == "card behind":
                # The model copies the front card's facility line onto the half-hidden one (seen 2026-10-15:
                # Dried Ginseng given Ginseng Water's Bouncy Brew Keg Lv.3), so such a reading is dropped;
                # the rest is kept but marked, and the report treats it as a weaker sighting.
                front = found[0] if found else None
                # It also copies the half-hidden card's time onto the front card (the same frame: Ginseng
                # Water, which says "Workload 162", read as Dried Ginseng's 54s). The same time on two
                # different items is taken as copied: the front card's time is dropped (listed as not read,
                # never judged). With one card open the model answers the second-card question by repeating
                # the front card, item and all; that is not a copy, and the repeat is dropped below.
                if front and time_text and front["time"] == time_text and item != front["item"]:
                    notes.append(f"{frame}: the front card's time {time_text} repeats the card behind's and is dropped (probably copied)")
                    front["time"], front["time_seconds"] = None, None
                if front and (front["facility"], front["facility_level"]) == (facility, fact["facility_level"]):
                    notes.append(f"{frame}: card behind ({item}) not logged (its facility line repeats the front card's, probably copied)")
                    continue
                fact["behind"] = True
            found.append(fact)
        return found

    def log_observations(self, entry: dict, source: str) -> int:
        """Append what a facility panel and an item card show to the observation log, then refresh
        the verification. Facts already in the log (same facility, fact and values) are not added
        again, except an unlock seen in a new frame: it is logged again until UNLOCK_FRAMES different
        frames hold it, because the check needs two frames to judge an off-by-one line and the
        Carousel Mill question needs two to call it answered. Returns how many were added."""
        if entry.get("kind") not in OBSERVED_KINDS or not isinstance(entry.get("fields"), dict):
            return 0
        fields, frame, t = entry["fields"], entry.get("file") or source, self.point_time(source)
        notes: list[str] = []
        if entry["kind"] in CARD_KINDS:
            found = self.panel_facts(fields, frame, t, notes) if entry["kind"] == "facility" else []
            found += self.card_facts(fields, frame, t, notes)
        elif entry["kind"] == "food":
            found = [f for f in [self.food_fact(fields, frame, t)] if f]
        else:
            found = self.screen_facts(entry["kind"], fields, frame, t)
        if notes:
            self.observation_notes.extend(notes)
            print(f"{time.strftime('%H:%M:%S')} observations skipped: {'; '.join(notes)}")
        seen = {self.observation_key(o) for o in self.observations}
        added = []
        for o in found:
            key = self.observation_key(o)
            if key not in seen:
                added.append(o)
                seen.add(key)
            elif o["fact"] == "unlock":
                frames = {x.get("frame") for x in self.observations + added if x["fact"] == "unlock" and self.observation_key(x) == key}
                if o.get("frame") not in frames and len(frames) < UNLOCK_FRAMES:
                    added.append(o)
        if not added:
            if notes:
                self.write_observations()  # the notes reach the disk even when nothing was logged
            return 0
        self.observations_path.parent.mkdir(parents=True, exist_ok=True)
        needs_newline = self.observations_path.is_file() and self.observations_path.stat().st_size > 0 and not self.observations_path.read_bytes().endswith(b"\n")
        with self.observations_path.open("a", encoding="utf-8") as f:
            f.write(("\n" if needs_newline else "") + "".join(json.dumps(o) + "\n" for o in added))
        self.observations.extend(added)
        about = ", ".join(dict.fromkeys(o.get("item") or o["facility"] for o in added))
        print(f"{time.strftime('%H:%M:%S')} observed {len(added)} fact{'s' if len(added) != 1 else ''} about {about}")
        self.write_observations()
        self.verify()
        return len(added)

    def screen_facts(self, kind: str, fields: dict, frame: str, t: str) -> list[dict]:
        """An RV, modules or roster screen with something read on it: {fact: screen, screen, read: true}
        and nothing else, so the log never holds roster names or levels (the reading.json merge has them)."""
        read = {"rv": lambda f: isinstance(f.get("rv"), int),
                "modules": lambda f: any(isinstance(f.get(m), int) for m in rs.MODULES),
                "aniimo": lambda f: bool(f.get("aniimo"))}[kind](fields)
        return [self.new_fact({"t": t, "frame": frame, "facility": ""}, "screen", kind, screen=kind, read=True)] if read else []

    def write_observations(self) -> Path:
        path = self.out_dir.parent / "observations.json"
        path.write_text(json.dumps({"format": OBSERVATION_FORMAT, "version": 1, "observations": self.observations,
                                    "notes": self.observation_notes[-50:]}), encoding="utf-8")
        return path

    def verify(self) -> dict | None:
        """Compare the observations with the data (verify_data.py) and write verification.md/.json.
        Any problem here is printed, never raised: a bug in the check must not stop the watcher."""
        try:
            web_json = self.web_dir / "verification.json" if self.web_dir and self.web_dir.is_dir() else None
            before = dict(self.question_status)
            summary = verify_data.run(self.root, self.observations_path, self.out_dir.parent / "verification.md",
                                      self.out_dir.parent / "verification.json", web_json, question_status=self.question_status)
            if getattr(self, "questions_baseline", False):  # not during startup: that run only sets the baseline
                for qid, status in self.question_status.items():
                    if before.get(qid, "open") != status:
                        print(f"{time.strftime('%H:%M:%S')} game question {qid}: {before.get(qid, 'open')} -> {status}")
            return summary
        except Exception as e:  # noqa: BLE001
            print(f"{time.strftime('%H:%M:%S')} verification skipped: {e}")
            return None

    def consider(self, image) -> bool:
        """Is this frame worth reading? Settled (same as the previous frame) and new (differs from the last one read)."""
        self.frames += 1
        fp = fingerprint(image)
        settled = difference(fp, self.last_fp) < SETTLED
        self.last_fp = fp
        unchanged = difference(fp, self.read_fp) < CHANGED
        if not settled or (unchanged and self.now() - self.read_at < REREAD_SECONDS):
            return False
        self.read_fp = fp
        self.read_at = self.now()
        return True

    def read(self, image, source: str) -> dict | None:
        """Classify the frame and, for a known screen, read it. Returns the screen entry or None."""
        self.looked += 1
        started = self.now()
        entry = {"file": source, "kind": "other", "fields": None, "seconds": 0.0}
        try:
            kind = (self.ask(CLASSIFY_PROMPT, CLASSIFY_SCHEMA, encode(image, CLASSIFY_SIDE)) or {}).get("kind")
            if kind not in KINDS:
                print(f"{time.strftime('%H:%M:%S')} other screen (not read)")
                return None
            entry["kind"] = kind
            # A facility panel is read with the detailed prompt on a full-detail crop of the panel (a
            # second, smaller question for its grey upgrade line, and a third for an item card open
            # beside it), but stays a "facility" screen so the merge and the site's diff work unchanged.
            # A stock screen is read for its counts and, on the card crop, for the card's facility line.
            spec = rs.SCREEN_KINDS["facility_detail" if kind == "facility" else kind]
            entry["fields"], errors = rs.read_spec(spec, self.ask, lambda crop: encode(image, rs.MAX_SIDE, crop), self.names, image)
            if kind == "aniimo" and self.card_not_roster(entry["fields"], image):
                # An item card taken for the roster: no entry has a known ability and a card's header
                # is on screen, so the frame is read again as the stock screen it is.
                print(f"{time.strftime('%H:%M:%S')} aniimo: no known ability and an item card is open; read as stock")
                kind = entry["kind"] = "stock"
                entry["fields"], errors = rs.read_spec(rs.SCREEN_KINDS["stock"], self.ask, lambda crop: encode(image, rs.MAX_SIDE, crop), self.names, image)
            if errors:  # a failed side question costs only its field, not the coins, level and reading
                entry["follow_up_error"] = "; ".join(f"{k}: {v}" for k, v in errors.items())
                print(f"{time.strftime('%H:%M:%S')} {kind}: a side question failed: {entry['follow_up_error']}")
        except (urllib.error.URLError, OSError, ValueError) as e:
            entry["error"] = str(e)
            entry["raw"] = getattr(e, "content", "")  # the model's whole answer, saved beside the frame
        entry["seconds"] = round(self.now() - started, 1)
        if entry.get("error"):
            print(f"{time.strftime('%H:%M:%S')} {entry['kind']}: error: {entry['error']}")
            return entry
        self.screens = [s for s in self.screens if not supersedes(entry, s)] + [entry]
        print(f"{time.strftime('%H:%M:%S')} {entry['kind']} in {entry['seconds']}s: {json.dumps(entry['fields'])[:110]}")
        return entry

    @staticmethod
    def card_not_roster(fields, image) -> bool:
        """Is an "aniimo" reading really an item card? True when no entry names a known ability and
        the card gate (read_screenshots.card_present) finds a card's header in the card strip."""
        entries = (fields or {}).get("aniimo") if isinstance(fields, dict) else None
        known = {rs.slug(a) for a in rs.ABILITIES}
        if any(rs.slug(a.get("ability") or "") in known for e in entries or [] if isinstance(e, dict)
               for a in e.get("abilities") or [] if isinstance(a, dict)):
            return False
        if image is None:
            return False
        try:
            return rs.card_present(image.crop(rs.crop_box(image.size, rs.card_crop)))
        except Exception:  # noqa: BLE001  (no Pillow features: keep the model's answer)
            return False

    def save_frame(self, image, entry: dict | None, keep: int | None = None) -> Path:
        """Keep the frame on disk: known screens as <kind>-<time>.png, failed reads with -error and the
        model's raw answer beside them, and the last few 'other' frames so a wrong 'other' can be seen."""
        self.out_dir.mkdir(parents=True, exist_ok=True)
        kind = entry["kind"] if entry else "other"
        suffix = "-error" if entry and entry.get("error") else ""
        path = self.out_dir / f"{kind}-{time.strftime('%Y%m%d-%H%M%S')}{suffix}.png"
        image.save(path)
        if entry:
            entry["file"] = path.name
            if entry.get("error") and entry.get("raw"):
                path.with_suffix(".txt").write_text(entry["raw"], encoding="utf-8")
        keep = self.keep if keep is None else keep
        if keep:
            # A frame a card, unlock, Level Up or aux panel fact names is evidence for the report and the
            # game questions: never deleted (the Ginseng Water frame was lost to this limit). Ticks and
            # the other per-reading facts do not protect frames, or the limit would be off.
            named = {o.get("frame") for o in self.observations if o.get("fact") in FRAME_FACTS}  # not ticks: one per reading
            for stale in sorted(self.out_dir.glob(f"{kind}-*.png"))[:-keep]:
                if stale.name in named:
                    continue
                stale.unlink(missing_ok=True)
                stale.with_suffix(".txt").unlink(missing_ok=True)
        return path

    def reading(self) -> dict:
        setup, actual, notes = rs.merge_screens(self.screens, self.names)
        return {
            "format": rs.READING_FORMAT, "version": rs.READING_VERSION,
            "readAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(self.now())), "model": self.model,
            "screens": self.screens, "setup": setup, "actual": actual, "notes": notes,
            "watcher": {"startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(self.started)), "frames": self.frames,
                        "looked": self.looked, "window": self.window_title},
        }

    def write(self) -> list[Path]:
        text = json.dumps(self.reading(), indent=2)
        targets = [self.out_dir.parent / "reading.json"]
        if self.web_dir and self.web_dir.is_dir():
            targets.append(self.web_dir / "reading.json")
        for target in targets:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text, encoding="utf-8")
        return targets

    def handle(self, image, source: str, save: bool = True) -> dict | None:
        """One frame through the whole pipeline: consider, read, save, write, log coins. A source that
        looks like a saved frame name (replay) stamps the coin point with the time in the name, not the clock."""
        if not self.consider(image):
            return None
        entry = self.read(image, source)
        if save:
            self.save_frame(image, entry, keep=OTHER_KEEP if entry is None else None)
        if entry and not entry.get("error"):
            self.write()
            self.log_coins(entry, source)
            self.log_observations(entry, source)
        return entry


# --- pruning card times copied from another card (--prune-copied-times) -------------------------------------

def same_item(a, b) -> bool:
    """Two item readings are the same item: equal slugs, or one a cut-off title of the other
    ('ose Concentrate' for rose_concentrate), or very close."""
    x, y = rs.slug(a or ""), rs.slug(b or "")
    if not x or not y:
        return False
    return x == y or x.endswith(y) or y.endswith(x) or rs.difflib.SequenceMatcher(None, x, y).ratio() >= 0.85


def same_time(a, b) -> bool:
    if not a or not b:
        return False
    sa, sb = verify_data.parse_seconds(a), verify_data.parse_seconds(b)
    return str(a).strip() == str(b).strip() or (sa is not None and sa == sb)


def read_log_lines(raw: bytes) -> list[tuple[int, bytes, dict | None]]:
    """observations.jsonl's bytes as (line number from 1, the raw bytes of the line without its
    newline, the parsed object or None). Splitting on b"\n" keeps every byte, so unchanged lines are
    rewritten exactly as they were."""
    out = []
    for i, chunk in enumerate(raw.split(b"\n"), start=1):
        try:
            obj = json.loads(chunk.decode("utf-8")) if chunk.strip() else None
        except (UnicodeDecodeError, ValueError):
            obj = None
        out.append((i, chunk, obj if isinstance(obj, dict) else None))
    return out


def data_seconds(root: Path) -> dict[tuple[str, str], int]:
    """{(facility, item): the seconds the data gives a card's Time}: production_time for a crop (its
    own CSV or the seasonal file), else the E-mode base time (data/overrides/emode_times.csv)."""
    files, _ = verify_data.load_facilities(root)
    own, seasonal = verify_data.load_item_rows(root, files)
    table = dict(verify_data.load_emode_times(root))
    for rows in (own, seasonal):
        for facility, items in rows.items():
            for item, row in items.items():
                if str(row.get("production_time", "")).strip().isdigit():
                    table[(facility, item)] = int(row["production_time"])
    return table


def copied_time_matches(lines, reading_screens: list[dict], frames_dir: Path, emode: dict, own_seconds: dict | None = None) -> list[dict]:
    """The front-card lines whose time was probably copied from another card, by rule:
      R1   same frame: another card fact of a different item has the same time, and that time
           disagrees with the front card's own row (`own_seconds`, see data_seconds): two items that
           really share a time (Wheatmeal and Cotton Fabric, 54s) are left alone;
      R1b  same, with the card behind as stored in reading.json for that frame;
      R2   an old-format line (no "v") with a time but no workload, whose frame is gone from
           screenshots/auto, for an item whose E-mode row disagrees with that time.
    R2 is biased toward removing disagreements, so the prune only clears a time (the card's level and
    facility stay, and the checklist asks for that card again). Returns [{line, item, facility, time,
    rule}], the only things the dry run prints."""
    cards = [(n, o) for n, _, o in lines if o and o.get("fact") == "card"]
    by_frame: dict = {}
    for n, o in cards:
        by_frame.setdefault(o.get("frame"), []).append((n, o))
    behind: dict = {}
    for screen in reading_screens or []:
        card = ((screen or {}).get("fields") or {}).get("card") if isinstance((screen or {}).get("fields"), dict) else None
        back = card.get("behind") if isinstance(card, dict) else None
        if isinstance(back, dict) and screen.get("file"):
            behind[screen["file"]] = back
    matches = []
    for n, o in cards:
        if o.get("behind") or o.get("pruned") or not o.get("time"):
            continue
        frame, time_text, rule = o.get("frame"), o["time"], None
        own = (own_seconds or {}).get((o.get("facility"), o.get("item")))
        wrong = own is not None and verify_data.parse_seconds(time_text) is not None and verify_data.parse_seconds(time_text) != own
        if wrong and any(m != n and not same_item(other.get("item"), o.get("item")) and same_time(other.get("time"), time_text) for m, other in by_frame.get(frame, [])):
            rule = "R1"
        elif wrong and frame in behind and same_time(behind[frame].get("time"), time_text) and not same_item(behind[frame].get("item"), o.get("item")):
            rule = "R1b"
        elif o.get("workload") is None and "v" not in o and frame and not (frames_dir / str(frame)).is_file():
            seconds = verify_data.parse_seconds(time_text)
            table = emode.get((o.get("facility"), o.get("item")))
            if table is not None and seconds is not None and seconds != table:
                rule = "R2"
        if rule:
            matches.append({"line": n, "item": o.get("item"), "facility": o.get("facility"), "time": time_text, "rule": rule})
    return matches


def backup_path(path: Path, today: str) -> Path:
    candidate = path.with_name(f"{path.name}.bak-{today}")
    i = 2
    while candidate.exists():
        candidate = path.with_name(f"{path.name}.bak-{today}-{i}")
        i += 1
    return candidate


def prune_copied_times(root: Path, observations: Path, frames_dir: Path, apply: bool = False, max_matches: int = 1,
                       web_dir: Path | None = None, today: str | None = None) -> int:
    """--prune-copied-times: list (dry run) or clear (--apply) the copied card times. Prints only the
    line number, item, facility, time read and rule of each match. --apply refuses above max_matches,
    writes observations.jsonl.bak-<date> first, clears time and time_seconds on the matched lines only
    and marks them "pruned": <rule>; every other line stays byte-identical. Then the check runs again."""
    if not observations.is_file():
        print(f"No observation log at {observations}; nothing to prune.")
        return 0
    raw = observations.read_bytes()  # judged and rewritten from these same bytes
    lines = read_log_lines(raw)
    try:
        reading = json.loads((observations.parent / "reading.json").read_text(encoding="utf-8"))
        screens = reading.get("screens") if isinstance(reading, dict) else []
    except (OSError, ValueError):
        screens = []
    matches = copied_time_matches(lines, screens if isinstance(screens, list) else [], frames_dir, verify_data.load_emode_times(root), data_seconds(root))
    for m in matches:
        print(f"line {m['line']}: {m['item']} ({m['facility']}), time {m['time']}, rule {m['rule']}")
    by_rule = ", ".join(f"{r} {sum(1 for m in matches if m['rule'] == r)}" for r in ("R1", "R1b", "R2"))
    print(f"{len(matches)} line{'s' if len(matches) != 1 else ''} match ({by_rule}).")
    if not apply:
        print("Dry run: nothing written." + (f" To clear these times: --prune-copied-times --apply --max {len(matches)}" if matches else ""))
        return 0
    if not matches:
        print("Nothing to apply.")
        return 0
    if len(matches) > max_matches:
        print(f"Refused: {len(matches)} matches is more than --max {max_matches}. Check the dry run, then raise --max if that is right.")
        return 1
    if observations.read_bytes() != raw:
        print("Refused: the log changed while it was checked (is the watcher running?); nothing changed.")
        return 1
    backup = backup_path(observations, today or time.strftime("%Y%m%d"))
    backup.write_bytes(raw)
    if backup.read_bytes() != raw:
        print(f"Refused: the backup {backup} does not match the log; nothing changed.")
        return 1
    chunks = raw.split(b"\n")
    for m in matches:
        chunk = chunks[m["line"] - 1]
        obj = json.loads(chunk.decode("utf-8"))
        obj["time"], obj["time_seconds"], obj["pruned"] = None, None, m["rule"]
        chunks[m["line"] - 1] = json.dumps(obj).encode("utf-8") + (b"\r" if chunk.endswith(b"\r") else b"")
    observations.write_bytes(b"\n".join(chunks))
    print(f"Cleared the time on {len(matches)} line{'s' if len(matches) != 1 else ''}; backup: {backup.name}.")
    web_json = web_dir / "verification.json" if web_dir and web_dir.is_dir() else None
    summary = verify_data.run(root, observations, observations.parent / "verification.md", observations.parent / "verification.json", web_json)
    print(f"Check again: {summary['observations']} observations, {summary['agree']} agree, {summary['disagree']} disagree, "
          f"{summary.get('unclear', 0)} unclear, {summary['unknown']} unknown.")
    return 0


# --- Ollama ----------------------------------------------------------------------------------------------

def ollama_exe() -> Path | None:
    for folder in [os.environ.get("LOCALAPPDATA", ""), os.environ.get("PROGRAMFILES", "")]:
        for candidate in [Path(folder) / "Programs" / "Ollama" / "ollama.exe", Path(folder) / "Ollama" / "ollama.exe"]:
            if folder and candidate.is_file():
                return candidate
    return None


def ensure_server(host: str, model: str, start: bool) -> str:
    try:
        return rs.check_server(host, model)
    except SystemExit as e:
        if not start or "not answering" not in str(e):
            raise
    exe = ollama_exe()
    if not exe:
        raise SystemExit(f"Ollama is not answering at {host} and ollama.exe was not found. Start Ollama first.")
    print(f"Starting {exe} serve ...")
    subprocess.Popen([str(exe), "serve"], creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(30):
        time.sleep(1)
        try:
            return rs.check_server(host, model)
        except SystemExit as e:
            if "not answering" not in str(e):
                raise
    raise SystemExit(f"Ollama did not start within 30 s (looked at {host}).")


# --- main ------------------------------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--title", default="Aniimo", help="the game window's title (start of it)")
    parser.add_argument("--exe", help="only a window of this program, e.g. Aniimo.exe")
    parser.add_argument("--interval", type=float, default=2.0, help="seconds between looks at the screen")
    parser.add_argument("--host", default=rs.DEFAULT_HOST)
    parser.add_argument("--model", default=rs.DEFAULT_MODEL)
    parser.add_argument("--dir", type=Path, help="where frames go (default: <root>/screenshots/auto)")
    parser.add_argument("--no-web", action="store_true", help="do not also write web/reading.json for the local site")
    parser.add_argument("--no-start", action="store_true", help="never start Ollama; just fail if it is not running")
    parser.add_argument("--keep", type=int, default=50, help="frames to keep per screen kind (older ones are deleted)")
    parser.add_argument("--once", action="store_true", help="grab and read one frame, then exit")
    parser.add_argument("--replay", type=Path, help="read the images in this folder as if they were frames, then exit")
    parser.add_argument("--check", action="store_true", help="only report the window and the model")
    parser.add_argument("--fresh", action="store_true", help="start from an empty reading instead of continuing the previous one")
    parser.add_argument("--questions", action="store_true", help="print the game-question checklist and exit (no game window, no Ollama)")
    parser.add_argument("--prune-copied-times", action="store_true",
                        help="list observation lines whose card time was probably copied from another card, and exit (no game window, no Ollama)")
    parser.add_argument("--apply", action="store_true", help="with --prune-copied-times: clear those times (a .bak-<date> copy is written first)")
    parser.add_argument("--dry-run", action="store_true", help="with --prune-copied-times: only list (the default; wins over --apply)")
    parser.add_argument("--max", type=int, default=1, help="with --apply: refuse when more lines than this match (default 1)")
    args = parser.parse_args(argv)

    out_dir = args.dir or (args.root / "screenshots" / "auto")
    web_dir = None if args.no_web else args.root / "web"
    # Offline commands: they read the log only, so they exit before the window and Ollama lookups.
    if args.questions:
        return verify_data.print_questions(args.root, out_dir.parent / "observations.jsonl")
    if args.prune_copied_times:
        return prune_copied_times(args.root, out_dir.parent / "observations.jsonl", out_dir, apply=args.apply and not args.dry_run,
                                  max_matches=args.max, web_dir=web_dir)

    if args.check or not args.replay:
        window = pick_window(list_windows(), args.title, args.exe)
        print(f"Game window: '{window['title']}' ({window['exe']}, {window['rect']})" if window
              else f"No window titled '{args.title}...' found (browsers, terminals and editors are ignored). Is the game open and not minimized?")
    print(ensure_server(args.host, args.model, start=not args.no_start))
    if args.check:
        return 0

    watcher = Watcher(args.root, args.host, args.model, out_dir, web_dir, keep=args.keep)
    if args.fresh:
        watcher.screens = []
    if watcher.screens:
        print(f"Continuing from {out_dir.parent / 'reading.json'}: {len(watcher.screens)} screens already read.")
    if args.replay:
        from PIL import Image
        # In time order, not name order: names start with the screen kind, and the coin log keeps the
        # first time each value was seen.
        paths = sorted((p for p in args.replay.glob("*") if p.suffix.lower() in rs.IMAGE_SUFFIXES), key=lambda p: (frame_time(p.name), p.name))
        for path in paths:
            with Image.open(path) as im:
                frame = im.convert("RGB")
            watcher.last_fp = fingerprint(frame)  # a file is already settled
            watcher.handle(frame, path.name, save=False)
        written = watcher.write()
        print(f"Replayed {len(paths)} images: {len(watcher.screens)} screens kept; wrote {', '.join(str(w) for w in written)}")
        return 0

    print(f"Watching every {args.interval:g}s. Open the RV screen, each facility, the modules, the roster and storage as you play; Ctrl+C to stop.")
    missing_since = None
    try:
        while True:
            window = pick_window(list_windows(), args.title, args.exe)
            if not window:
                if missing_since is None:
                    missing_since = time.time()
                    print(f"{time.strftime('%H:%M:%S')} waiting for a window titled '{args.title}...'")
                time.sleep(max(args.interval, 2.0))
                continue
            missing_since = None
            watcher.window_title = window["title"]
            try:
                frame = grab_window(window)
            except OSError as e:
                print(f"{time.strftime('%H:%M:%S')} could not capture the window: {e}")
                time.sleep(args.interval)
                continue
            if args.once:
                watcher.last_fp = fingerprint(frame)
                entry = watcher.handle(frame, "once.png")
                print("Read: " + (json.dumps(entry) if entry else "not a known screen") + f"; wrote {', '.join(str(w) for w in watcher.write())}")
                return 0
            watcher.handle(frame, "frame.png")
            time.sleep(args.interval)
    except KeyboardInterrupt:
        pass
    written = watcher.write()
    print(f"\nStopped after {watcher.frames} frames, {watcher.looked} looked at, {len(watcher.screens)} screens kept; wrote {', '.join(str(w) for w in written)}")
    print("Next: on the local site the Profile box offers the new reading; elsewhere, Load screenshot reading and confirm the diff.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

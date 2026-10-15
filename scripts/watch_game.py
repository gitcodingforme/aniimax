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
     for the local site). Newer readings of the same screen replace older ones.

Usage (from the repository root):
  python scripts/watch_game.py                    watch until Ctrl+C
  python scripts/watch_game.py --once             grab one frame, read it, exit (good for a test)
  python scripts/watch_game.py --replay DIR       treat the images in DIR as frames, then exit
  python scripts/watch_game.py --check            confirm the window and the model can be found
Needs Pillow (present on this PC). Starts Ollama if it is installed but not running (--no-start to never do that).
"""
from __future__ import annotations

import argparse
import base64
import ctypes
import io
import json
import os
import subprocess
import sys
import time
import urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import read_screenshots as rs  # noqa: E402  (prompts, model calls, merging)

KINDS = ["rv", "facility", "modules", "aniimo", "stock"]
CLASSIFY_PROMPT = (
    "This is a screenshot from the game Aniimo. Which screen is it? Answer with exactly one of: "
    "rv (the Homeland screen showing the RV level and Home Coins), "
    "facility (one facility's panel with its name, how many are owned and their level), "
    "modules (the upgrade modules screen with Ecological Module, Kitchen Module, Resource Detector, Crafting Module), "
    "aniimo (the Aniimo roster listing Aniimo with abilities and personalities), "
    "stock (storage or inventory with item names and amounts), "
    "or other (anything else: the map, a battle, a loading screen, a dialog, an egg hatching, "
    "or a shop with prices and a Buy button, even if it says how many of an item are owned)."
)
CLASSIFY_SCHEMA = {"type": "object", "properties": {"kind": {"type": "string", "enum": KINDS + ["other"]}}, "required": ["kind"]}
CLASSIFY_SIDE = 1000  # px; a smaller image is enough to tell screens apart and is faster

SETTLED = 0.010   # share of pixels that changed, below which the picture has stopped moving
CHANGED = 0.004   # above which it is a new picture compared with the last one read (a panel's text differs by about 1%)
REREAD_SECONDS = 60  # a still picture is looked at again this often, in case an animated background hid a change
FP_SIZE = (96, 54)
FP_LEVEL = 24     # a pixel counts as changed when its grey value moved by more than this (0-255)
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
    from PIL import ImageGrab
    return ImageGrab.grab(bbox=window["rect"], all_screens=True).convert("RGB")


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
    if new["kind"] in ("rv", "modules"):
        return True
    nf, of = new.get("fields") or {}, old.get("fields") or {}
    if new["kind"] == "facility":
        return rs.slug(str(nf.get("facility") or "")) == rs.slug(str(of.get("facility") or ""))
    key = "aniimo" if new["kind"] == "aniimo" else "items"
    new_names = {rs.slug(str(e.get("name") or "")) for e in nf.get(key) or []}
    old_names = {rs.slug(str(e.get("name") or "")) for e in of.get(key) or []}
    return bool(old_names) and old_names <= new_names


def encode(image, max_side: int) -> str:
    im = image
    if max(im.size) > max_side:
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
        self.load()

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
                return None
            spec = rs.SCREEN_KINDS[kind]
            entry["kind"] = kind
            entry["fields"] = self.ask(spec["prompt"], spec["schema"], encode(image, rs.MAX_SIDE))
        except (urllib.error.URLError, OSError, ValueError) as e:
            entry["error"] = str(e)
        entry["seconds"] = round(self.now() - started, 1)
        if entry.get("error"):
            print(f"{time.strftime('%H:%M:%S')} {entry['kind']}: error: {entry['error']}")
            return entry
        self.screens = [s for s in self.screens if not supersedes(entry, s)] + [entry]
        print(f"{time.strftime('%H:%M:%S')} {entry['kind']} in {entry['seconds']}s: {json.dumps(entry['fields'])[:110]}")
        return entry

    def save_frame(self, image, entry: dict) -> Path:
        self.out_dir.mkdir(parents=True, exist_ok=True)
        path = self.out_dir / f"{entry['kind']}-{time.strftime('%Y%m%d-%H%M%S')}.png"
        image.save(path)
        entry["file"] = path.name
        if self.keep:
            for stale in sorted(self.out_dir.glob(f"{entry['kind']}-*.png"))[:-self.keep]:
                stale.unlink(missing_ok=True)
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
        """One frame through the whole pipeline: consider, read, save, write."""
        if not self.consider(image):
            return None
        entry = self.read(image, source)
        if entry and not entry.get("error"):
            if save:
                self.save_frame(image, entry)
            self.write()
        return entry


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
    args = parser.parse_args(argv)

    out_dir = args.dir or (args.root / "screenshots" / "auto")
    web_dir = None if args.no_web else args.root / "web"

    if args.check or not args.replay:
        window = pick_window(list_windows(), args.title, args.exe)
        print(f"Game window: '{window['title']}' ({window['exe']}, {window['rect']})" if window
              else f"No window titled '{args.title}...' found (browsers, terminals and editors are ignored). Is the game open and not minimized?")
    print(ensure_server(args.host, args.model, start=not args.no_start))
    if args.check:
        return 0

    watcher = Watcher(args.root, args.host, args.model, out_dir, web_dir, keep=args.keep)
    if watcher.screens:
        print(f"Continuing from {out_dir.parent / 'reading.json'}: {len(watcher.screens)} screens already read.")
    if args.replay:
        from PIL import Image
        paths = sorted(p for p in args.replay.glob("*") if p.suffix.lower() in rs.IMAGE_SUFFIXES)
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

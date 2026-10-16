#!/usr/bin/env python3
"""Weekly community cross-check: compare fan-site numbers with this fork's game data.

Reads the pages listed in data/sources/pages.csv (wikily.gg facility pages and the aniimotools.dev
recipes page), pulls the numbers out of them and compares them with the data as the site uses it:

  unlock   RV level each facility level needs      web/facility-config.js `unlocks` + structure.json
  cap      output capacity per facility level      OUTPUT_CAPS + structure.json `outputCaps`
  rv_cost  coins and items to reach each RV level  LEVEL_UP_COSTS + structure.json `levelUpCosts`
  recipe   workload or grow time, first facility   data/<facility>.csv (and harvest_moon_festival.csv)
           level, E-mode seconds                   data/overrides/emode_times.csv
           ingredients and amounts (aniimotools)   raw_materials / required_amount
  upgrade_cost  Home Coin per facility level       FACILITY_UPGRADE_COSTS when facility-config.js has it,
                                                   otherwise only read and counted

Run scripts/apply_overrides.py first so data/*.csv holds my verified values. Wiki names are mapped
to the CSV names by data/sources/aliases.csv (a trailing * matches the rest of a name). Fan sites
are not the game: a difference means "look in game", never "the data is wrong".

Usage (from the repository root):
  python scripts/web_check.py [--root R] [--report FILE.md] [--json FILE] [--offline DIR]
                              [--pages FILE] [--write-sources FILE] [--no-cache]

--offline DIR reads <DIR>/<fixture>.html, <DIR>/<slug>.html or <DIR>/<site>-<slug>.html (slug = the
URL's last path part, site = its host's first label, e.g. wikily-well.html) and never uses the network.
Live fetches send a named User-Agent, obey robots.txt, wait 3 s between requests, retry 429/503 twice
(honouring Retry-After, at most 120 s) and cache pages for a day in <temp>/aniimax-web-cache.

Exit codes: 0 every page read and no differences; 1 differences; 2 nothing could be fetched or parsed, or
no differences but some page could not be fetched or parsed (so a rate-limited week never reads as clean);
3 crash. --write-sources rows use the names of data/sources/web_sources.csv (needs_rv, output_cap, RV, wikily.gg).
Only our own names and numbers reach the report; a name seen only on a fan site is reduced to
letters, digits and " :'-", cut to 60 characters, with @ written as (at). Standard library only.
"""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
import sys
import tempfile
import time
import traceback
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser
from collections import Counter
from datetime import date, datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import verify_data as vd  # noqa: E402

USER_AGENT = "aniimax-fork-web-check/1 (+https://github.com/gitcodingforme/aniimax)"
SHAPE = "could not parse: page shape changed"
PAGES_FILE = Path("data") / "sources" / "pages.csv"
ALIASES_FILE = Path("data") / "sources" / "aliases.csv"
SOURCES_HEADER = ["kind", "facility", "key", "column", "value", "source", "url", "checked_on"]
SAFE = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 :'-")
SECTION_LIMIT = 150  # lines per report section; the fingerprint always covers every difference


# --- fetching ------------------------------------------------------------------------------------

class Fetcher:
    """Polite page reader. get() returns (text, None) or (None, problem) and never raises."""

    def __init__(self, cache_dir=None, ttl=86400, delay=3.0, timeout=30, max_bytes=8_000_000, offline_dir=None, use_cache=True):
        self.cache_dir = Path(cache_dir) if cache_dir else Path(tempfile.gettempdir()) / "aniimax-web-cache"
        self.ttl, self.delay, self.timeout, self.max_bytes = ttl, delay, timeout, max_bytes
        self.offline_dir = Path(offline_dir) if offline_dir is not None else None
        self.use_cache = use_cache
        self.robots: dict[str, urllib.robotparser.RobotFileParser | None] = {}
        self.last: float | None = None
        self.retry_budget = 300.0  # seconds of Retry-After waiting per run, so the CI job stays inside its timeout

    def get(self, url: str, fixture: str = "") -> tuple[str | None, str | None]:
        try:
            if self.offline_dir is not None:
                return self._offline(url, fixture)
            cached = self._cached(url)
            if cached is not None:
                return cached, None
            refusal = self._robots_refusal(url)
            if refusal:
                return None, refusal
            body, problem = self._download(url)
            if body is not None:
                self._store(url, body)
            return body, problem
        except Exception as e:  # a page problem must never stop the whole check
            return None, f"unexpected {type(e).__name__}"

    def _offline(self, url: str, fixture: str) -> tuple[str | None, str | None]:
        parts = urllib.parse.urlsplit(url)
        page_slug = [p for p in parts.path.split("/") if p][-1:] or [parts.hostname or "index"]
        site = (parts.hostname or "").split(".")[0]
        for name in (fixture, page_slug[0], f"{site}-{page_slug[0]}"):
            if name and re.fullmatch(r"[A-Za-z0-9._-]+", name):
                path = self.offline_dir / f"{name}.html"
                if path.is_file():
                    return path.read_text(encoding="utf-8", errors="replace"), None
        return None, "no offline copy"

    def _cache_path(self, url: str) -> Path:
        return self.cache_dir / (hashlib.sha256(url.encode("utf-8")).hexdigest() + ".html")

    def _cached(self, url: str) -> str | None:
        path = self._cache_path(url)
        try:
            if self.use_cache and path.is_file() and time.time() - path.stat().st_mtime < self.ttl:
                return path.read_text(encoding="utf-8")
        except OSError:
            pass
        return None

    def _store(self, url: str, body: str) -> None:
        if not self.use_cache:
            return
        try:
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            self._cache_path(url).write_text(body, encoding="utf-8")
        except OSError:
            pass

    def _robots_refusal(self, url: str) -> str | None:
        parts = urllib.parse.urlsplit(url)
        host = f"{parts.scheme}://{parts.netloc}"
        if host not in self.robots:
            body, problem = self._download(host + "/robots.txt")
            parser = urllib.robotparser.RobotFileParser(host + "/robots.txt")
            if body is not None:
                parser.parse(body.splitlines())
            elif problem in ("HTTP 401", "HTTP 403"):
                parser.disallow_all = True
            elif problem and problem.startswith("HTTP 4"):
                parser.allow_all = True
            else:
                parser = None
            self.robots[host] = parser
        parser = self.robots[host]
        if parser is None:
            return "robots.txt could not be read; page skipped"
        if not parser.can_fetch(USER_AGENT, url):
            return "robots.txt disallows this page; skipped"
        return None

    def _wait(self, seconds: float | None = None) -> None:
        if seconds is None and self.last is not None:
            seconds = self.delay - (time.monotonic() - self.last)
        if seconds and seconds > 0:
            time.sleep(seconds)

    def _download(self, url: str) -> tuple[str | None, str | None]:
        for attempt in range(3):
            self._wait()
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/html,text/plain;q=0.9,*/*;q=0.5"})
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    raw = response.read(self.max_bytes + 1)
                    charset = response.headers.get_content_charset() or "utf-8"
            except urllib.error.HTTPError as e:
                self.last = time.monotonic()
                wait = retry_after(e.headers.get("Retry-After") if e.headers else None, self.delay)
                if e.code in (429, 503) and attempt < 2 and wait <= self.retry_budget:
                    self.retry_budget -= wait
                    self._wait(wait)
                    continue
                return None, f"HTTP {e.code}"
            except (urllib.error.URLError, OSError, ValueError) as e:
                self.last = time.monotonic()
                return None, f"network error ({type(e).__name__})"
            self.last = time.monotonic()
            if len(raw) > self.max_bytes:
                return None, f"larger than {self.max_bytes} bytes"
            try:
                return raw.decode(charset, errors="replace"), None
            except LookupError:
                return raw.decode("utf-8", errors="replace"), None
        return None, "HTTP 429/503 after two retries"


def retry_after(value, default: float) -> float:
    """Seconds to wait from a Retry-After header (seconds or an HTTP date), at most 120."""
    seconds = default * 2
    if isinstance(value, str) and value.strip().isdigit():
        seconds = int(value.strip())
    elif isinstance(value, str) and value.strip():
        try:
            seconds = (parsedate_to_datetime(value) - datetime.now(timezone.utc)).total_seconds()
        except (TypeError, ValueError):
            pass
    return max(0.0, min(120.0, float(seconds)))


# --- small parsers -------------------------------------------------------------------------------

HIDDEN = re.compile(r"<(script|style|noscript|template)\b[^>]*>.*?</\1\s*>|<!--.*?-->", re.S | re.I)
NUMBER = re.compile(r"\d{1,3}(?:,\d{3})+(?!\d)|\d+")
DURATION_PART = re.compile(r"(\d+)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])")
UNIT = {"h": 3600, "m": 60, "s": 1}


def pipe_text(html_text) -> str:
    """The page's visible text with every tag turned into `|`, runs of separators collapsed."""
    if not isinstance(html_text, str):
        return ""
    text = html.unescape(re.sub(r"<[^>]+>", "|", HIDDEN.sub("|", html_text)))
    return re.sub(r"\|[\s|]*\|", "|", text)


def parse_number(text) -> int | None:
    """The first whole number in `text`: '1,450,000' -> 1450000, 'x16,300.' -> 16300; None if none."""
    if isinstance(text, int) and not isinstance(text, bool):
        return text
    if not isinstance(text, str):
        return None
    m = NUMBER.search(text)
    return int(m.group().replace(",", "")) if m else None


def parse_duration(text) -> int | None:
    """Seconds from '13m 20s' (800), '1h 30m', '54 s', '2 min'. None unless the whole text is a time."""
    if not isinstance(text, str):
        return None
    low = text.strip().lower()
    parts = DURATION_PART.findall(low)
    if not parts or DURATION_PART.sub("", low).strip(" ,"):
        return None
    return sum(int(n) * UNIT[unit[0]] for n, unit in parts)


def ascii_text(text) -> str:
    return unicodedata.normalize("NFKD", str(text)).encode("ascii", "ignore").decode("ascii")


def slug(text) -> str:
    """'Coarse-Sifted Ore' -> coarse_sifted_ore; accents dropped, & read as 'and'."""
    return re.sub(r"[^a-z0-9]+", "_", ascii_text(text).replace("&", " and ").lower()).strip("_")


def sanitize(name) -> str:
    """A fan-site name made safe to print: [A-Za-z0-9 :'-] only, @ as (at), at most 60 characters."""
    out = []
    for ch in ascii_text(name):
        out.append("(at)" if ch == "@" else ch if ch in SAFE else " " if ch.isspace() else "")
    return re.sub(r"\s+", " ", "".join(out)).strip()[:60]


# --- wikily.gg facility pages --------------------------------------------------------------------

STAT_LABELS = {"RV level": "needs_rv", "Aniimo slots": "aniimo_slots", "Output capacity": "output_capacity", "E-mode power": "emode_power"}
BLOCK = re.compile(r"(Build|Upgrade) requirements\|((?:[\d,]+\|[A-Za-z][A-Za-z -]*\|)+)(?:Build cost|Cost for this upgrade):\s*Home Coin\W*([\d,]+)[^|]*\|([^|]*)")
STAT = re.compile(r"([\d,]+)\|([A-Za-z][A-Za-z -]*)\|")
LEVEL_MARK = re.compile(r"Available at level (\d+)")
RV_NOTE = re.compile(r"Need RV level (\d+)\?((?:(?!Need RV level).){0,3000}?)RV upgrade cost:\s*([^|]*?)\.?\s*(?:RV upgrade time|\|)", re.S)
METHODS = {"Aniimo work": "aniimo_work", "Growing": "growing", "Quick recipe": "quick", "E-mode": "emode"}
COST_PART = re.compile(r"^(.*?)\s*[\u00d7x]?\s*(\d[\d,]*)$")


def parse_level1_block(html_text) -> tuple[dict, list[str]]:
    """Level 1 stats from the page's embedded data (`craft-lv-1-stats`, a stat grid of value/label
    pairs inside the Next.js payload): {needs_rv, aniimo_slots, output_capacity, emode_power}."""
    try:
        if not isinstance(html_text, str) or "craft-lv-1-stats" not in html_text:
            return {}, [SHAPE + " (no level 1 stats)"]
        start = html_text.index("craft-lv-1-stats")
        end = html_text.find("craft-lv-", start + 16)
        window = html_text[start: end if end > 0 else start + 8000][:8000].replace('\\"', '"')
        pairs = re.findall(r'"wgt-stat-value","children":\[(?:false,)?"([^"]*)"\]\}\],\["\$","dt",null,\{"className":"wgt-stat-label","children":"([^"]*)"', window)
        stats = {STAT_LABELS[label]: parse_number(value) for value, label in pairs if label in STAT_LABELS and parse_number(value) is not None}
        return (stats, []) if stats else ({}, [SHAPE + " (no level 1 stats)"])
    except Exception as e:
        return {}, [f"{SHAPE} ({type(e).__name__})"]


def parse_rv_cost(text: str) -> dict | None:
    """'Home Coin x32,000 . Wood Block x1,300' (separated by a middle dot) -> {coins, items}."""
    coins, items = None, {}
    for part in text.split("\u00b7"):
        m = COST_PART.match(part.strip())
        if not m:
            return None
        if slug(m.group(1)) == "home_coin":
            coins = parse_number(m.group(2))
        else:
            items[slug(m.group(1))] = parse_number(m.group(2))
    return {"coins": coins, "items": items} if coins is not None else None


def parse_wikily_facility(html_text) -> tuple[dict, list[str]]:
    """{levels: [{level, needs_rv, aniimo_slots, upgrade_cost, output_capacity, emode_power}],
    recipes: [{name, method, workload, seconds, emode_seconds, facility_level}], rv_costs: {rv: {coins, items}}}."""
    try:
        return _parse_wikily(html_text)
    except Exception as e:
        return {}, [f"{SHAPE} ({type(e).__name__})"]


def _parse_wikily(html_text) -> tuple[dict, list[str]]:
    text, problems = pipe_text(html_text), []
    levels: dict[int, dict] = {}
    for m in BLOCK.finditer(text):
        stats = {STAT_LABELS[label]: parse_number(v) for v, label in STAT.findall(m.group(2)) if label in STAT_LABELS}
        if m.group(1) == "Build":
            level = 1
        else:
            source = re.search(r"Upgrade from facility level (\d+)", m.group(4))
            if not source:
                problems.append(SHAPE + " (an upgrade block names no level)")
                continue
            level = int(source.group(1)) + 1
        block = {"level": level, "upgrade_cost": parse_number(m.group(3)), **stats}
        if level in levels and levels[level] != block:
            problems.append(f"could not parse: two different blocks for level {level}")
        levels.setdefault(level, block)
    first, _ = parse_level1_block(html_text)
    if first:
        base = levels.setdefault(1, {"level": 1, "upgrade_cost": None})
        for key, value in first.items():
            if base.get(key) is None:
                base[key] = value

    marks = [(m.start(), int(m.group(1))) for m in LEVEL_MARK.finditer(text)]
    run = [marks[0]] if marks else []
    for mark in marks[1:]:
        if mark[1] <= run[-1][1]:
            break  # the page repeats its sections further down; the first run is the one shown
        run.append(mark)
    recipes: dict[str, dict] = {}
    unreadable = 0
    for i, (pos, level) in enumerate(run):
        end = run[i + 1][0] if i + 1 < len(run) else text.find("Join the creator community", pos)
        tokens = [t.strip() for t in text[pos: end if end > pos else len(text)].split("|") if t.strip()]
        for k in range(len(tokens) - 2):
            method, name, value = METHODS.get(tokens[k + 1]), tokens[k], tokens[k + 2]
            if method is None or name in METHODS or not name[:1].isalpha() or len(name) > 80:
                continue
            workload = parse_number(value) if "workload" in value.lower() else None
            seconds = parse_duration(value) if workload is None else None
            if workload is None and seconds is None:
                unreadable += 1
                continue
            entry = recipes.setdefault(name, {"name": name, "method": None, "workload": None, "seconds": None, "emode_seconds": None, "facility_level": level})
            if method == "emode":
                entry["emode_seconds"] = entry["emode_seconds"] or seconds
            elif entry["method"] is None:
                entry.update(method="aniimo_work" if workload is not None else "growing", workload=workload, seconds=seconds)
    if unreadable:
        problems.append(f"could not parse: {unreadable} recipe values")

    rv_costs: dict[int, dict] = {}
    for m in RV_NOTE.finditer(text):
        cost = parse_rv_cost(" ".join(m.group(3).split()))
        if cost is None:
            problems.append(f"could not parse: RV {m.group(1)} upgrade cost")
        elif rv_costs.setdefault(int(m.group(1)), cost) != cost:
            problems.append(f"could not parse: two different costs for RV {m.group(1)}")
    if not levels and not recipes:
        return {}, [SHAPE]
    if not levels:
        problems.append(SHAPE + " (no level blocks)")
    if not recipes:
        problems.append(SHAPE + " (no recipes)")
    return {"levels": [levels[k] for k in sorted(levels)], "recipes": list(recipes.values()), "rv_costs": rv_costs}, problems


# --- aniimotools.dev recipes page ----------------------------------------------------------------

AMOUNT = re.compile(r"[\u00d7x]\s*\d[\d,]*")
WORK = re.compile(r"\d[\d,]* work")
TIER = re.compile(r"T\d{1,2}")


def parse_aniimotools(html_text) -> tuple[dict, list[str]]:
    """{recipes: [{facility, name, quick, yield, ingredients: [[name, amount]], workload, seconds,
    emode_seconds, tier}]}. Each station section says how many rows it lists; each row ends at `T<n>`."""
    try:
        tokens = [t.strip() for t in pipe_text(html_text).split("|") if t.strip()]
        heads = [i for i in range(len(tokens) - 3) if tokens[i + 1] in ("Production", "Growing")
                 and tokens[i + 2].isdigit() and tokens[i + 3].startswith("Open the station")]
        if not heads:
            return {}, [SHAPE]
        recipes: dict[tuple[str, str], dict] = {}
        problems = []
        for n, head in enumerate(heads):
            facility, expected = tokens[head], int(tokens[head + 2])
            end = heads[n + 1] if n + 1 < len(heads) else len(tokens)
            start = next((j + 1 for j in range(head, end) if tokens[j] == "From tier"), None)
            found, row = 0, []
            for tok in tokens[start or end: end]:
                if not TIER.fullmatch(tok):
                    row.append(tok)
                    continue
                found += _tools_row(facility, row, int(tok[1:]), recipes)
                row = []
                if found == expected:
                    break
            if found != expected:
                problems.append(f"could not parse: {sanitize(facility)} lists {expected} rows, {found} read")
        return {"recipes": list(recipes.values())}, problems
    except Exception as e:
        return {}, [f"{SHAPE} ({type(e).__name__})"]


def _tools_row(facility: str, row: list[str], tier: int, out: dict) -> int:
    """One row: name [xYield] [Quick|Electric|notes] (ingredient xN)...|nothing  cost  time  T<n>."""
    if len(row) < 3:
        return 0
    name, rest, yld = row[0], row[1:], None
    if AMOUNT.fullmatch(rest[0]):
        yld, rest = parse_number(rest[0]), rest[1:]
    electric = "Electric" in rest
    work_at = next((j for j, t in enumerate(rest) if WORK.fullmatch(t)), None)
    if electric or work_at is None:
        if "real time" not in rest or rest.index("real time") < 1:
            return 0
        cost_at = rest.index("real time") - 1
        seconds, workload = parse_duration(rest[cost_at]), None
        if seconds is None:
            return 0
    else:
        cost_at, seconds, workload = work_at, None, parse_number(rest[work_at])
    ingredients = [[rest[j], parse_number(rest[j + 1])] for j in range(cost_at - 1)
                   if AMOUNT.fullmatch(rest[j + 1]) and not AMOUNT.fullmatch(rest[j]) and rest[j] not in ("Quick", "Electric", "nothing")]
    entry = out.setdefault((facility, name), {"facility": facility, "name": name, "quick": "Quick" in rest, "yield": None, "ingredients": [],
                                              "workload": None, "seconds": None, "emode_seconds": None, "tier": tier})
    if electric:
        entry["emode_seconds"] = seconds
    else:
        entry.update({"yield": yld, "ingredients": ingredients, "workload": workload, "seconds": seconds, "tier": tier})
    return 1


# --- the fork's data -----------------------------------------------------------------------------

def read_table(path: Path, columns: int) -> list[list[str]]:
    """A small sources CSV without its header: comment and blank lines skipped, the last column keeps commas."""
    if not path.is_file():
        return []
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines()[1:]:
        if line.strip() and not line.lstrip().startswith("#"):
            cells = [c.strip() for c in line.split(",", columns - 1)]
            rows.append(cells + [""] * (columns - len(cells)))
    return rows


def load_pages(path: Path) -> list[dict]:
    return [{"url": u, "facility": f, "kind": k, "fixture": x} for u, f, k, x in read_table(path, 4) if u]


def load_aliases(path: Path) -> list[tuple[str, str, str]]:
    return [(" ".join(w.split()).lower(), f, n) for w, f, n, _ in read_table(path, 4) if w and n]


def fork_key(name: str, facility: str, aliases: list[tuple[str, str, str]]) -> str:
    """The CSV name for a fan-site name: an alias for this facility, then one for any facility
    (empty facility), then the plain slug. 'Quick Recipe: *' style rows keep the rest of the name."""
    norm = " ".join(str(name).split())
    low = norm.lower()
    for want in (facility, ""):
        for wiki, fac, fork in aliases:
            if fac != want:
                continue
            if wiki.endswith("*") and low.startswith(wiki[:-1]):
                return fork.replace("*", slug(norm[len(wiki) - 1:]))
            if wiki == low:
                return fork
    return slug(norm)


def js_block(config: str, name: str) -> str | None:
    m = re.search(rf"export const {name}\s*=\s*\{{", config)
    if not m:
        return None
    end = config.find("\n};", m.end())
    return re.sub(r"//[^\n]*", "", config[m.end(): end if end > 0 else len(config)])


def js_level_tables(block: str | None) -> dict[str, dict[int, int | None]] | None:
    """`Name: [a, b, null]` (index 0 = level 1) or `Name: { 2: a, 3: b }` -> {name: {level: value}}."""
    if block is None:
        return None
    tables = {}
    for m in re.finditer(r"(?:'([^']+)'|\"([^\"]+)\"|([A-Za-z_]\w*))\s*:\s*(\[[^\]]*\]|\{[^}]*\})", block):
        name, body = m.group(1) or m.group(2) or m.group(3), m.group(4)
        if body.startswith("["):
            cells = [c.strip() for c in body[1:-1].split(",") if c.strip()]
            tables[name] = {i + 1: (None if c == "null" else parse_number(c)) for i, c in enumerate(cells)}
        else:
            tables[name] = {int(k): int(v) for k, v in re.findall(r"(\d+)\s*:\s*(\d+)", body)}
    return tables


def load_fork(root: Path) -> dict:
    files, unlocks = vd.load_facilities(root)
    own, seasonal = vd.load_item_rows(root, files)
    config = (root / "web" / "facility-config.js").read_text(encoding="utf-8")
    caps = js_level_tables(js_block(config, "OUTPUT_CAPS")) or {}
    levelup = {}
    for m in re.finditer(r"(\d+)\s*:\s*\{\s*coins:\s*(\d+)\s*,\s*items:\s*\[(.*?)\]\s*\}", js_block(config, "LEVEL_UP_COSTS") or ""):
        items = {k: int(v) for k, v in re.findall(r"\[\s*'([a-z0-9_]+)'\s*,\s*(\d+)\s*\]", m.group(3))}
        levelup[int(m.group(1))] = {"coins": int(m.group(2)), "items": items}
    try:
        structure = json.loads((root / "data" / "overrides" / "structure.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        structure = {}
    structure = structure if isinstance(structure, dict) else {}
    for name, patch in (structure.get("facilities") or {}).items():  # same rules as web/overrides.js
        caps_patch = patch.get("outputCaps") if isinstance(patch, dict) else None
        if isinstance(caps_patch, list) and caps_patch and all(c is None or (isinstance(c, int) and not isinstance(c, bool) and c >= 0) for c in caps_patch):
            caps[name] = {i + 1: c for i, c in enumerate(caps_patch)}
    for level, patch in (structure.get("levelUpCosts") or {}).items():
        cost = levelup.get(int(level)) if str(level).isdigit() else None
        if cost and isinstance(patch, dict):
            if isinstance(patch.get("coins"), int) and patch["coins"] >= 0:
                cost["coins"] = patch["coins"]
            if isinstance(patch.get("items"), list) and all(isinstance(p, list) and len(p) == 2 and isinstance(p[0], str) and isinstance(p[1], int) for p in patch["items"]):
                cost["items"] = {k: v for k, v in patch["items"]}
    upgrade = js_level_tables(js_block(config, "FACILITY_UPGRADE_COSTS"))
    for name, levels in (structure.get("upgradeCosts") or {}).items():  # merged per level, like web/overrides.js
        if upgrade is not None and name in files and isinstance(levels, dict) and levels and all(
                str(k).isdigit() and int(k) >= 2 and isinstance(v, int) and not isinstance(v, bool) and v > 0 for k, v in levels.items()):
            upgrade[name] = {**upgrade.get(name, {}), **{int(k): v for k, v in levels.items()}}
    return {"files": files, "unlocks": vd.apply_structure_overrides(root, unlocks), "own": own, "seasonal": seasonal, "caps": caps,
            "levelup": levelup, "upgrade": upgrade, "emode": vd.load_emode_times(root)}


# --- comparing -----------------------------------------------------------------------------------

class Check:
    def __init__(self, today: str):
        self.today = today
        self.diffs: list[str] = []
        self.only: list[str] = []
        self.fetch_fail: list[str] = []
        self.parse_fail: list[str] = []
        self.agree: Counter = Counter()
        self.info: Counter = Counter()
        self.facts: list[list[str]] = []
        self.pages = self.pages_ok = 0

    def same(self, kind: str, ours, theirs, line: str) -> None:
        if ours == theirs:
            self.agree[kind] += 1
        else:
            self.diffs.append(line)

    def fact(self, kind, facility, key, column, value, source, url) -> None:
        self.facts.append([kind, facility, str(key), column, str(value), source, url, self.today])


def compare_wikily(check: Check, facility: str, url: str, page: dict, fork: dict, aliases) -> None:
    unlocks, caps, upgrade = fork["unlocks"].get(facility, {}), fork["caps"].get(facility, {}), fork["upgrade"]
    for block in page.get("levels", []):
        lv = block["level"]
        if block.get("needs_rv") is not None:
            rv = block["needs_rv"]
            check.fact("unlock", facility, lv, "needs_rv", rv, "wikily.gg", url)
            if unlocks.get(lv) is None:
                check.only.append(f"{facility} level {lv}: needs RV {rv} (no such level in the unlock table)")
            else:
                check.same("unlock RV levels", unlocks[lv], rv, f"{facility} level {lv}: needs RV {unlocks[lv]} in the data, RV {rv} on wikily")
        if block.get("output_capacity") is not None:
            cap = block["output_capacity"]
            check.fact("cap", facility, lv, "output_cap", cap, "wikily.gg", url)
            if caps.get(lv) is None:
                check.only.append(f"{facility} level {lv}: output cap {cap} (OUTPUT_CAPS has none)")
            else:
                check.same("output caps", caps[lv], cap, f"{facility} level {lv}: output cap {caps[lv]} in the data, {cap} on wikily")
        if block.get("upgrade_cost") is not None and lv == 1:
            check.fact("upgrade_cost", facility, lv, "build_coins", block["upgrade_cost"], "wikily.gg", url)
            check.info["level 1 build costs read (the data has none)"] += 1
        elif block.get("upgrade_cost") is not None:
            cost = block["upgrade_cost"]
            check.fact("upgrade_cost", facility, lv, "coins", cost, "wikily.gg", url)
            ours = (upgrade or {}).get(facility, {}).get(lv)
            if upgrade is None:
                check.info["facility upgrade costs read, not compared (no FACILITY_UPGRADE_COSTS yet)"] += 1
            elif ours is None:
                check.only.append(f"{facility} level {lv}: upgrade cost {cost} (FACILITY_UPGRADE_COSTS has none)")
            else:
                check.same("facility upgrade costs", ours, cost, f"{facility} level {lv}: upgrade cost {ours} in the data, {cost} on wikily")

    rows, season, seen = fork["own"].get(facility, {}), fork["seasonal"].get(facility, {}), set()
    for r in page.get("recipes", []):
        key = fork_key(r["name"], facility, aliases)
        row = rows.get(key) or season.get(key)
        value, column = (r["workload"], "workload") if r["workload"] is not None else (r["seconds"], "production_time")
        label = key if row else slug(sanitize(r["name"]))
        for col, val in ((column, value), ("facility_level", r["facility_level"]), ("emode_seconds", r["emode_seconds"])):
            if val is not None:
                check.fact("recipe", facility, label, col, val, "wikily.gg", url)
        if row is None:
            check.only.append(f"{facility}: {sanitize(r['name'])} ({value} {'workload' if column == 'workload' else 's'}, level {r['facility_level']})")
            continue
        seen.add(key)
        if r["method"] is not None:
            ours = parse_number(row.get(column, ""))
            if ours is None:
                check.diffs.append(f"{facility} {key}: {column} {value} on wikily, the data has no {column}")
            else:
                check.same("recipe workloads and grow times", ours, value, f"{facility} {key}: {column} {ours} in the data, {value} on wikily")
        level = parse_number(row.get("facility_level", ""))
        check.same("recipe facility levels", level, r["facility_level"], f"{facility} {key}: facility level {level} in the data, {r['facility_level']} on wikily")
        if r["emode_seconds"] is not None:
            ours = fork["emode"].get((facility, key))
            if ours is None:
                check.info["E-mode times on wikily with no row in emode_times.csv"] += 1
            else:
                check.same("E-mode times", ours, r["emode_seconds"], f"{facility} {key}: E-mode {ours} s in emode_times.csv, {r['emode_seconds']} s on wikily")
    check.info["data recipes a wikily page does not list"] += len(set(rows) - seen)


def compare_rv_costs(check: Check, rv_costs: dict[int, tuple[dict, str]], fork: dict) -> None:
    def show(cost):
        return f"{cost['coins']} coins" + "".join(f", {k} {v}" for k, v in sorted(cost["items"].items()))
    for rv, (cost, url) in sorted(rv_costs.items()):
        check.fact("rv_cost", "RV", rv, "coins", cost["coins"], "wikily.gg", url)
        for item, amount in sorted(cost["items"].items()):
            check.fact("rv_cost", "RV", rv, item, amount, "wikily.gg", url)
        ours = fork["levelup"].get(rv)
        if ours is None:
            check.only.append(f"RV {rv} level-up cost: {show(cost)} (LEVEL_UP_COSTS has none)")
        else:
            check.same("RV level-up costs", ours, cost, f"RV {rv} level-up cost: {show(ours)} in the data, {show(cost)} on wikily")


def compare_tools(check: Check, url: str, page: dict, fork: dict, aliases) -> None:
    for r in page.get("recipes", []):
        facility = r["facility"]
        if facility not in fork["files"]:
            check.info["aniimotools rows at stations the data does not have"] += 1
            continue
        key = fork_key(r["name"], facility, aliases)
        row = fork["own"].get(facility, {}).get(key) or fork["seasonal"].get(facility, {}).get(key)
        if row is None:
            check.only.append(f"{facility}: {sanitize(r['name'])} (aniimotools)")
            continue
        if r["workload"] is not None:
            check.fact("recipe", facility, key, "workload", r["workload"], "aniimotools.dev", url)
            if row.get("workload"):
                ours = parse_number(row["workload"])
                check.same("aniimotools workloads", ours, r["workload"], f"{facility} {key}: workload {ours} in the data, {r['workload']} on aniimotools")
        if r["ingredients"] and row.get("raw_materials"):
            theirs = {fork_key(n, "", aliases): a for n, a in r["ingredients"]}
            check.fact("recipe", facility, key, "raw_materials", ";".join(theirs), "aniimotools.dev", url)
            check.fact("recipe", facility, key, "required_amount", ";".join(str(a) for a in theirs.values()), "aniimotools.dev", url)
            ours = dict(zip(row["raw_materials"].split(";"), (parse_number(a) for a in row.get("required_amount", "").split(";"))))
            show = lambda d: " + ".join(f"{k} {v}" for k, v in sorted(d.items()))  # noqa: E731  (CSV names or slugs)
            check.same("aniimotools ingredient lists", ours, theirs, f"{facility} {key}: ingredients {show(ours)} in the data, {show(theirs)} on aniimotools")


# --- report --------------------------------------------------------------------------------------

def fingerprint(lines) -> str:
    return hashlib.sha256("\n".join(sorted(set(lines))).encode("utf-8")).hexdigest()


def render(check: Check) -> str:
    def section(title, lines):
        body = [f"- {line}" for line in sorted(set(lines))[:SECTION_LIMIT]] or ["None."]
        if len(set(lines)) > SECTION_LIMIT:
            body.append(f"- ... and {len(set(lines)) - SECTION_LIMIT} more (see --json)")
        return [f"## {title}", ""] + body + [""]
    out = ["# Web sources check", "",
           f"Checked {check.today}: {len(set(check.diffs))} differences; {check.pages} pages, {check.pages_ok} read, "
           f"{len(check.fetch_fail)} could not be fetched, {len(check.parse_fail)} parse problems. Fan sites, not the game: "
           "a difference means look in game before changing anything.", ""]
    out += section("Differences", check.diffs) + section("Could not fetch", check.fetch_fail)
    out += section("Could not parse", check.parse_fail) + section("Only on the wiki", check.only)
    out += section("Agree counts", [f"{k}: {v} agree" for k, v in check.agree.items()] + [f"{k}: {v}" for k, v in check.info.items()])
    return "\n".join(out) + f"<!-- web-check:{fingerprint(check.diffs)} -->\n"


def run(args) -> int:
    root = args.root
    check = Check(args.today or date.today().isoformat())
    pages = load_pages(args.pages or root / PAGES_FILE)
    aliases, fork = load_aliases(root / ALIASES_FILE), load_fork(root)
    fetcher = Fetcher(offline_dir=args.offline, use_cache=not args.no_cache)
    rv_costs: dict[int, tuple[dict, str]] = {}
    for page in pages:
        check.pages += 1
        url, facility, kind = page["url"], page["facility"], page["kind"]
        where = facility or url
        text, problem = fetcher.get(url, page["fixture"])
        if text is None:
            check.fetch_fail.append(f"{where} ({url}): {problem}")
            continue
        if kind == "facility" and facility not in fork["files"]:
            check.parse_fail.append(f"{where}: pages.csv names a facility web/facility-config.js does not have")
            continue
        if kind not in ("facility", "recipes"):
            check.parse_fail.append(f"{where}: unknown kind in pages.csv")
            continue
        data, problems = parse_wikily_facility(text) if kind == "facility" else parse_aniimotools(text)
        check.parse_fail += [f"{where}: {p}" for p in problems]
        if not data:
            continue
        check.pages_ok += 1
        if kind == "facility":
            compare_wikily(check, facility, url, data, fork, aliases)
            for rv, cost in data.get("rv_costs", {}).items():
                if rv_costs.setdefault(rv, (cost, url))[0] != cost:
                    check.parse_fail.append(f"{where}: RV {rv} cost differs from another wikily page")
        else:
            compare_tools(check, url, data, fork, aliases)
    compare_rv_costs(check, rv_costs, fork)

    report = render(check)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(report, encoding="utf-8")
    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps({"format": "aniimax-web-check", "checked_on": check.today, "fingerprint": fingerprint(check.diffs),
                                         "differences": sorted(set(check.diffs)), "could_not_fetch": check.fetch_fail, "could_not_parse": check.parse_fail,
                                         "only_on_wiki": sorted(set(check.only)), "agree": dict(check.agree), "info": dict(check.info),
                                         "facts": [dict(zip(SOURCES_HEADER, f)) for f in check.facts]}, indent=1), encoding="utf-8")
    if args.write_sources:
        args.write_sources.parent.mkdir(parents=True, exist_ok=True)
        lines = [", ".join(SOURCES_HEADER)] + [", ".join(c.replace(",", ";") for c in f) for f in check.facts]
        args.write_sources.write_text("\n".join(lines) + "\n", encoding="utf-8")
    if not args.report:
        print(report)
    print(f"{len(set(check.diffs))} differences, {sum(check.agree.values())} agreeing values, {check.pages_ok} of {check.pages} pages read.")
    if check.pages_ok == 0:
        return 2
    if check.diffs:
        return 1
    return 2 if check.fetch_fail or check.parse_fail else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent, help="repository root")
    parser.add_argument("--report", type=Path, help="write the Markdown report here (default: print it)")
    parser.add_argument("--json", type=Path, help="also write the results as JSON")
    parser.add_argument("--offline", type=Path, help="read saved pages from this folder instead of the network")
    parser.add_argument("--pages", type=Path, help="pages list (default data/sources/pages.csv)")
    parser.add_argument("--write-sources", type=Path, help="write every value read, one row each, to this CSV")
    parser.add_argument("--no-cache", action="store_true", help="neither read nor write the page cache")
    parser.add_argument("--today", help=argparse.SUPPRESS)
    try:
        return run(parser.parse_args(argv))
    except Exception:
        traceback.print_exc(file=sys.stderr)
        return 3


if __name__ == "__main__":
    sys.exit(main())

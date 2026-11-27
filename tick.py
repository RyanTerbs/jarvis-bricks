#!/usr/bin/env python3
"""
Derek (repo: jarvis-bricks): a tiny autonomous brick man who builds his own little town.

ONE run of this file = ONE "tick" = 15 minutes of his life.
GitHub Actions runs it every 15 minutes, then saves the files it wrote.

The big idea (same as Pino):
  1. CODE updates his needs and mood. No AI, just maths.
  2. If he has a plan queued, he does the next step. No AI.
  3. Otherwise the AI picks 1-3 moves and says why, in his voice.
  4. CODE checks each move is allowed, applies it, and logs it.
  If the AI fails or isn't set up, "autopilot" picks a sensible move by rules.

New in v2:
  - His own little brick TOWN. He collects bricks at the brick pit, picks what to build,
    works on the building site until it's done, and can design his own buildings.
  - A DIARY he writes every night at bedtime. His "tomorrow" line is read back to him next day.

Only Python's standard library is used: nothing to install.

Run it yourself (free, no API key needed):
  python tick.py --watch          watch him live in your browser (fake AI, 1 tick every 2 s)
  python tick.py --simulate 168   fake a whole week in seconds, writes to sim_data/
  python tick.py --mock           one tick with a fake AI (writes the LIVE data in docs/data)
  python tick.py                  one tick: real AI if ANTHROPIC_API_KEY is set, else the free brain
"""
import argparse
import functools
import http.server
import json
import math
import os
import random
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent
CONFIG = ROOT / "jarvis"            # who he is + world rules (you edit these)
DATA = ROOT / "docs" / "data"       # live data (the code writes these; the web page reads them)
SIM = ROOT / "sim_data"             # fake runs (--simulate / --watch) go here, never committed
try:
    TZ = ZoneInfo("America/New_York")   # his town runs on Florida time
except Exception:                       # Windows without the 'tzdata' package: plain UTC-5
    TZ = timezone(timedelta(hours=-5), "ET")

MODEL = "claude-haiku-5-5"          # small, cheap, fast
PRICE_IN = 0.10 / 1_000_000         # $ per input token (Haiku 5.5, prompts under 100k tokens)
PRICE_OUT = 0.50 / 1_000_000        # $ per output token (thinking tokens count as output)
TICK_MINUTES = 15
FEED_KEEP = 150                     # feed entries to keep
DAY_LOG_KEEP = 120                  # today's log lines kept for the diary
DIARY_KEEP = 400                    # diary entries to keep (over a year)
NEEDS = ["rest", "hunger", "social", "tinker", "curiosity"]
SOURCES = ["model", "queue", "autopilot", "sleeping"]
DATA_FILES = ("state.json", "feed.json", "town.json", "diary.json")
NOTEBOOK_KEEP = 60                  # notebook notes kept
_LIB = {}
_ME = {}


def me():
    """His name, from his character sheet (jarvis/sheet.json). Rename him there."""
    if not _ME:
        _ME["name"] = (load(CONFIG / "sheet.json", {}) or {}).get("name", "Derek")
    return _ME["name"]


def library():
    """His OFFLINE books + encyclopedia (built once by tools/build_library.py). No live internet."""
    if not _LIB:
        lib = CONFIG / "library"
        _LIB["books"] = {k: v for k, v in (load(lib / "books.json", {}) or {}).items() if not k.startswith("_")}
        _LIB["encyclopedia"] = {k: v for k, v in (load(lib / "encyclopedia.json", {}) or {}).items() if not k.startswith("_")}
    return _LIB


def perks_of(book):
    """A book's perks as a list (books.json allows one perk or a list of them)."""
    p = (book or {}).get("perk")
    return [x for x in (p if isinstance(p, list) else [p]) if isinstance(x, dict)]


def perk_text(book):
    return "; ".join(p["text"] for p in perks_of(book) if p.get("text"))


def perk_sum(state, kind, move=None, product=None, stage=None):
    """Add up what finished books taught him (e.g. faster site work, better prices, quicker bike stages)."""
    total = 0.0
    for bid in state.get("finished", []):
        for perk in perks_of(library()["books"].get(bid)):
            if (perk.get("type") == kind and perk.get("move") in (None, move) and perk.get("product") in (None, product)
                    and perk.get("stage") in (None, stage)):
                total += perk.get("value", 0)
    return total


def book_where(state, bid):
    """Where a book is right now: 'home', 'library', or None (still in a book box that hasn't come yet)."""
    v = library()["books"][bid]
    if v["where"] == "box":
        return "home" if v.get("box") in state.get("book_boxes", []) else None
    return v["where"]


def has_place(town, place):
    return any(l.get("place") == place for l in town["lots"])


# ---------------------------------------------------------------- small helpers

def load(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save(path, data):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def clamp(x, lo, hi):
    return max(lo, min(hi, x))


def clock(dt):
    """8:15 PM style time for humans."""
    return dt.astimezone(TZ).strftime("%I:%M %p").lstrip("0")


def nice(place):
    return place.replace("_", " ")


def clean_text(s, n):
    """Tidy text the AI made up: one line, no control characters, no em dashes, max n chars."""
    s = re.sub(r"[\x00-\x1f\x7f]", " ", str(s or ""))
    s = re.sub(r"\s+", " ", s).replace("—", ",").strip()
    return s[:n].strip()


def slugify(name):
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")[:20] or "building"


def clean_emoji(e):
    s = str(e or "").strip()
    if not s or s[0].isascii():
        return "🏠"
    return s[:2].rstrip("‍")


def fresh_state(now):
    """Him on his very first tick."""
    today = now.astimezone(TZ).date().isoformat()
    return {
        "name": me(),
        "place": "home",
        "asleep": False,
        "doing": "waking up for the first time",
        "thought": "Right. Where's my toolbox?",
        "feeling": "curious",
        "needs": {"rest": 0.2, "hunger": 0.4, "social": 0.3, "tinker": 0.5, "curiosity": 0.5},
        "mood": 0.3,
        "energy": 0.8,
        "coins": 20,
        "coins_goal": 500,
        "bricks": 10,
        "stock": {},                    # things he made, waiting to be sold
        "owned": [],                    # things he bought from the catalogue
        "sales": {"items": 0, "coins": 0},
        "books": {},                    # chapters read per book
        "finished": [],                 # books finished (they teach him perks)
        "notebook": [],                 # what he learned, in his own words
        "looked_up": [],                # encyclopedia topics he has looked up
        "hour": 12,                     # local hour of this tick (for time-of-day moves)
        "beach": {"tan": 0.0, "surf_skill": 0.0, "surf_sessions": 0, "castles": [], "best_castle": 0, "shells": 0,
                  "sun_today": 0, "burnt_until": 0, "waves": "small", "waves_date": None},
        "book_boxes": [],               # book boxes delivered to his door so far
        "truck_date": None,             # last morning the brick truck came
        "box_date": None,
        "project": None,                # the bike he's restoring in the garage (None = garage free)
        "bikes": [],                    # restored bikes he kept
        "restored": [],                 # every project he finished (kept or sold)
        "bike_offer": None,             # a project bike for sale ({kind, since})
        "garage_free_since": None,
        "queue": [],
        "lucky": {"date": today, "used": 0, "max": 3},
        "designed_on": None,
        "plan_today": None,             # the "tomorrow" line from last night's diary
        "today_log": [],                # what happened today, for tonight's diary
        "day_start": {"coins": 20, "bricks": 10, "got": 0, "used": 0},
        "tick": 0,
        "born": now.isoformat(),
        "updated": now.isoformat(),
        "stats": {
            "all": {s: 0 for s in SOURCES} | {"tokens_in": 0, "tokens_out": 0, "cost_usd": 0.0},
            "today": {"date": today} | {s: 0 for s in SOURCES} | {"tokens_in": 0, "tokens_out": 0, "cost_usd": 0.0},
        },
    }


def fresh_town(world, now):
    """The town on day one: a brick pit, his house, the garage and the cafe."""
    today = now.astimezone(TZ).date().isoformat()
    lots = [dict(l, bp=l["id"], decor=False, built=today) for l in world["town"]["start"]]
    return {
        "max_lots": world["town"]["start_lots"],
        "lots": lots,
        "site": None,
        "custom_blueprints": {},
        "custom_moves": {},
        "history": [{"date": today, "text": f"{me()} moved into a tiny town: a house, a garage, a cafe and a pile of bricks."}],
    }


# ---------------------------------------------------------------- his puppy (no AI)

def pup_name(state):
    pup = state.get("pup") or {}
    return pup.get("name") or "the puppy"


def new_pup(world, now, tick_no):
    st = world["puppy"]["start"]
    return {"name": None, "born": now.isoformat(), "arrived_tick": tick_no, "napping": False,
            "needs": {"hunger": st["hunger"], "tired": st["tired"], "bored": st["bored"]},
            "bond": st["bond"], "food": st["food"], "tricks": {}, "learned": [], "doing": "sniffing around"}


def update_pup(state, world, now, log):
    """The puppy's needs move by themselves (pure maths). Neglect costs bond; care builds it."""
    pup, P = state["pup"], world["puppy"]
    tired = pup["needs"]["tired"]
    pup["napping"] = state["asleep"] or tired >= 0.9 or (pup["napping"] and tired > 0.3)
    mode = "asleep" if pup["napping"] else "awake"
    for n, rate in P["needs"].items():
        pup["needs"][n] = round(clamp(pup["needs"][n] + rate[mode], 0, 1), 3)
    neglected = max(pup["needs"]["hunger"], pup["needs"]["bored"]) >= P["neglect_from"]
    if neglected and not pup["napping"]:         # only counts while he's awake
        pup["bond"] = round(max(0.0, pup["bond"] - 0.01), 3)
    name = pup_name(state)
    if pup["napping"]:
        pup["doing"] = "asleep at the foot of the bed" if state["asleep"] else "napping"
    elif pup["needs"]["hunger"] >= 0.7:
        pup["doing"] = f"hungry, staring at {me()}"
    elif pup["needs"]["bored"] >= 0.7:
        pup["doing"] = "bored, chewing whatever he can find"
    else:
        pup["doing"] = random.choice(["digging a hole in the sand", "splashing in the shallows", "chasing a crab",
                                      "barking at the waves", "rolling in the sand"] if state["place"] == "beach" else
                                     [f"trotting along behind {me()}", "sniffing everything", "wagging his tail",
                                      "rolling in the grass", f"watching {me()} work"])
    if not pup["napping"] and not state["asleep"]:
        if pup["needs"]["hunger"] >= P["neglect_from"] and random.random() < 0.25:
            log("noticed", f"{name[:1].upper() + name[1:]} is whining at his empty food bowl.")
        elif random.random() < 0.04:
            log("noticed", random.choice(P["events"]).replace("{pup}", name[:1].upper() + name[1:]))


def train_pup(state, world, trick, log):
    """One training session. Works best when he's fed, rested and bonded. Returns (note, mood_bonus)."""
    pup, T = state["pup"], world["puppy"]["tricks"]
    todo = [t for t in T if not t.startswith("_") and t not in pup["learned"]]
    if not todo:
        return "he knows every trick already", 0.0
    trick = trick if trick in todo else todo[0]
    n, name = pup["needs"], pup_name(state)
    chance = 0.45 + perk_sum(state, "train_chance") + 0.35 * pup["bond"] - 0.5 * max(0, n["hunger"] - 0.6) - 0.5 * max(0, n["tired"] - 0.6)
    if random.random() >= chance:
        return f"{T[trick]['name']}: {name} wasn't having it", -0.01
    pup["tricks"][trick] = pup["tricks"].get(trick, 0) + 1
    pup["bond"] = round(min(1.0, pup["bond"] + 0.02), 3)
    done, need = pup["tricks"][trick], T[trick]["sessions"]
    if done >= need:
        pup["learned"].append(trick)
        log("learned", f"{name[:1].upper() + name[1:]} learned to {T[trick]['name']}!")
        return f"{T[trick]['name']}: learned it!", 0.15
    return f"{T[trick]['name']}: {done}/{need}", 0.02


PUP_WANT_MOVES = {
    "food": {"feed_the_puppy"}, "play": {"play_with_the_puppy", "play_fetch_on_the_beach", "play_in_the_snow", "splash_in_puddles"}, "walk": {"walk_the_puppy"},
    "cuddle": {"cuddle_the_puppy"}, "explore": {"walk_the_puppy"},
    "beach": {"play_fetch_on_the_beach", "go_for_a_swim", "build_a_sand_castle", "collect_shells", "sunbathe", "watch_the_sunset"},
}


def pup_mind(state, log, world=None):
    """The puppy's own little mind: a thought, what he wants, now and then an idea. Phrase book only, so it's free
    with either brain (dogs think simple thoughts)."""
    pup = state.get("pup")
    if not pup:
        return
    P = free_brain().get("pup", {})
    T, n, hr = P.get("thoughts", {}), pup["needs"], state.get("hour", 12)
    name = pup.get("name") or "the puppy"
    fill = lambda t: t.replace("{name}", name).replace("{owner}", me())
    # what he wants: his needs first, otherwise a whim that sticks around for a couple of hours
    need_want = "food" if n["hunger"] >= 0.6 else "nap" if n["tired"] >= 0.8 else "play" if n["bored"] >= 0.6 else None
    if pup["napping"]:
        pup["wants"] = None
    elif need_want:
        pup["wants"], pup["want_ticks"] = need_want, 0
    elif world and wkind(state, world).get("pup_want") and random.random() < 0.5:   # storm = cuddles, snow = play
        pup["wants"], pup["want_ticks"] = wkind(state, world)["pup_want"], 0
    elif pup.get("wants") and pup.get("want_ticks", 0) < 8:
        pup["want_ticks"] = pup.get("want_ticks", 0) + 1
    elif random.random() < 0.2:
        pup["wants"], pup["want_ticks"] = random.choice(["walk", "cuddle", "explore", "play"] + (["beach"] if 7 <= hr < 19 else [])), 0
    else:
        pup["wants"] = None
    # what's on his mind
    if pup["napping"]:
        cat = "dream"
    else:
        w = {"random": 1.0}
        for need, c, wt in (("hunger", "hungry", 3), ("bored", "bored", 3), ("tired", "tired", 2)):
            if n[need] >= (0.7 if need == "tired" else 0.6):
                w[c] = wt
        if pup.get("bond", 0) >= 0.5:
            w["happy"] = 1.5
        if state["place"] == "beach":
            w["beach"] = 3
        if any(k in str(state.get("doing", "")) for k in ("fixing", "building", "tinkering")):
            w["working"] = 2
        doing = str(state.get("doing", ""))
        if doing.startswith("restoring") or (state.get("project") and state["place"] == "garage"):
            w["bike"] = 3                                  # the loud thing in the garage
        if doing.startswith("riding") and "ride" in pup.get("learned", []):
            w["bike_ride"] = 5                             # in the tank bag, ears flapping
        if pup.get("learned"):
            w["learning"] = 0.6
        if hr >= 21 or hr < 6:
            w["night"] = 1
        wx = state.get("weather") or {}
        if wx.get("kind"):
            w["weather_" + wx["kind"]] = 2.5
        if wx.get("snow", 0) >= 0.3:
            w["weather_snow"] = 3
        cats = [c for c in w if T.get(c)]
        cat = random.choices(cats, weights=[w[c] for c in cats])[0] if cats else None
    if cat and T.get(cat):
        recent = pup.get("recent_thoughts", [])
        raw = fb_pick(T[cat], recent)
        pup["recent_thoughts"] = (recent + [raw])[-20:]
        pup["thought"] = fill(raw)
    # a bright idea, now and then
    if not pup["napping"] and not state["asleep"] and P.get("ideas") and random.random() < 0.03:
        raw = fb_pick(P["ideas"], pup.get("recent_ideas", []))
        pup["recent_ideas"] = (pup.get("recent_ideas", []) + [raw])[-8:]
        pup["idea"] = fill(raw)
        log("pupidea", f"{name[:1].upper() + name[1:]} has an idea: {pup['idea']}")


# ---------------------------------------------------------------- the town (no AI)

def blueprints(world, town):
    """Everything he could build: the ones in world.json plus the ones he designed himself."""
    base = {k: v for k, v in world["blueprints"].items() if not k.startswith("_")}
    return base | town["custom_blueprints"]


def built_count(town, bp_id):
    return sum(1 for lot in town["lots"] if lot.get("bp") == bp_id)


def unbuilt_designs(town):
    return sum(1 for k in town["custom_blueprints"] if not built_count(town, k))


def free_lot(town):
    used = {lot["lot"] for lot in town["lots"]}
    if town["site"]:
        used.add(town["site"]["lot"])
    return next((i for i in range(town["max_lots"]) if i not in used), None)


def can_start(bp_id, bp, state, town):
    """Can he start this build right now? Returns (ok, reason_if_not)."""
    if town["site"]:
        return False, f"already building the {town['site']['name']}"
    if not bp.get("repeat") and built_count(town, bp_id):
        return False, f"the {bp['name']} is already built"
    if not bp.get("expand") and free_lot(town) is None:
        return False, "no free lots left (build a new baseplate)"
    if state["bricks"] < bp["bricks"]:
        return False, f"needs {bp['bricks']} bricks, has {state['bricks']}"
    if state["coins"] < bp.get("coins", 0):
        return False, f"needs {bp['coins']} coins, has {state['coins']}"
    return True, None


def nearest_place(town, lot):
    spots = [l for l in town["lots"] if l.get("place")]
    return min(spots, key=lambda l: abs(l["lot"] - lot))["place"] if spots else "home"


def decor_bonus(world, town):
    m = world["mood"]
    n = sum(1 for l in town["lots"] if l.get("decor"))
    return min(m.get("decor_bonus_max", 0.0), m.get("decor_bonus", 0.0) * n)


def merged_world(world, town, state, today):
    """The world as it is RIGHT NOW: the rules + whatever he has built + the builds he can afford."""
    W = dict(world)
    W["places"] = {l["place"]: l["desc"] for l in sorted(town["lots"], key=lambda l: l["lot"]) if l.get("place")}
    W["places"] |= {k: v for k, v in world.get("fixed_places", {}).items() if not k.startswith("_")}
    site = town["site"]
    if site:
        W["places"]["building_site"] = (f"the building site, where the {site['name']} is going up "
                                        f"({site['done']}/{site['work']} done)")
    moves = {m: d for m, d in world["moves"].items()
             if not m.startswith("_") and d.get("requires", "") in ("", *state["owned"])} | town["custom_moves"]
    moves |= project_moves(state, world, town, today)      # his bike restoration in the garage
    hr = state.get("hour", 12)
    moves = {m: d for m, d in moves.items() if "hours" not in d or d["hours"][0] <= hr < d["hours"][1]}
    closed = weather_closed(state, world)                 # the weather shuts some things, opens others
    moves = {m: d for m, d in moves.items() if m not in closed and not weather_says_no(d, state)}
    if not sum(state["stock"].values()):
        moves.pop("run_the_stall", None)          # nothing to sell
    pup = state.get("pup")
    if pup:
        if pup["napping"]:
            moves = {m: d for m, d in moves.items() if not d.get("pup_awake")}
        if pup["food"] <= 0:
            moves.pop("feed_the_puppy", None)
        if len(pup["learned"]) >= len([t for t in world["puppy"]["tricks"] if not t.startswith("_")]):
            moves.pop("train_the_puppy", None)
    else:
        moves = {m: d for m, d in moves.items() if not (d.get("pup") or d.get("food") or d.get("train"))}
    if sum(state["stock"].values()) < world["selling"]["max_stock"]:
        for pid, pr in world["products"].items():
            if not pid.startswith("_") and state["bricks"] >= pr["bricks"] and state["coins"] >= pr["coins"]:
                moves[f"make_{pid}"] = {"label": f"making a {pr['name']}", "at": pr["at"], "needs": pr.get("needs", {}),
                                        "mood": pr.get("mood", 0.0), "bricks": -pr["bricks"], "coins": -pr["coins"], "make": pid}
    for cid, c in world["catalogue"].items():
        if not cid.startswith("_") and cid not in state["owned"] and state["coins"] >= c["coins"]:
            moves[f"order_{cid}"] = {"label": f"ordering a {c['name'].lower()} from the catalogue", "at": ["home"],
                                     "needs": {"curiosity": -0.05}, "mood": 0.10, "coins": -c["coins"], "buy": cid}
    luck = state["lucky"]
    if luck["date"] == today and luck["used"] >= world["lucky_block"]["per_day"]:
        moves.pop("hit_the_lucky_block", None)
    if state.get("designed_on") == today or unbuilt_designs(town) >= world["design_rules"]["max_unbuilt"]:
        moves.pop("design_a_building", None)
    for bp_id, bp in blueprints(world, town).items():
        if can_start(bp_id, bp, state, town)[0]:
            moves[f"start_build_{bp_id}"] = {"label": f"starting a new build: {bp['name']}", "at": ["any"],
                                             "needs": {"curiosity": -0.10}, "mood": 0.05, "build": bp_id}
    W["moves"] = moves
    return W


def start_site(state, world, town, bp_id, today):
    """Pay for a build and put up the building site."""
    bp = blueprints(world, town)[bp_id]
    state["bricks"] -= bp["bricks"]
    state["coins"] -= bp.get("coins", 0)
    lot = town["max_lots"] if bp.get("expand") else free_lot(town)
    town["site"] = {"bp": bp_id, "name": bp["name"], "lot": lot, "work": bp["work"], "done": 0,
                    "started": today, "look": bp.get("look", {})}
    return f"paid {bp['bricks']} bricks" + (f" + {bp['coins']} coins" if bp.get("coins") else "")


def work_site(state, world, town, today, log):
    """One tick of work on the site. Returns (note, mood_bonus). Finishes the build when it's done."""
    site = town["site"]
    k = wkind(state, world)
    if random.random() < k.get("site_slow", 0):           # rain or snow: the shift got washed out
        return f"the {state['weather']['kind']} slowed the work, {site['name']} still {site['done']}/{site['work']}", -0.02
    site["done"] += 1
    if random.random() < perk_sum(state, "site_speed"):        # the bricklaying book pays off
        site["done"] = min(site["work"], site["done"] + 1)
    if site["done"] < site["work"]:
        return f"{site['name']} {site['done']}/{site['work']}", 0.0
    bp = blueprints(world, town)[site["bp"]]
    if bp.get("expand"):
        town["max_lots"] += bp["expand"]
        text = f"laid a new baseplate: the street is {town['max_lots']} lots long now"
    else:
        n = built_count(town, site["bp"])
        town["lots"].append({
            "lot": site["lot"], "id": site["bp"] if n == 0 else f"{site['bp']}_{n + 1}", "bp": site["bp"],
            "name": bp["name"], "place": bp.get("place"), "desc": bp.get("desc") or bp["name"],
            "look": bp.get("look", {}), "decor": bool(bp.get("decor")), "built": today})
        text = f"finished building the {bp['name']}"
    town["history"].append({"date": today, "text": text[0].upper() + text[1:] + "."})
    town["site"] = None
    state["place"] = bp.get("place") or nearest_place(town, site["lot"])  # he's standing by it now
    log("built", text + "!")
    return "finished!", world["mood"].get("build_done_bonus", 0.2)


def design_building(state, world, town, design, today, log):
    """His own idea becomes a blueprint (and a new move once it's built). Returns an error or None."""
    if not isinstance(design, dict):
        return 'no design given (add a "design" to the move)'
    name = clean_text(design.get("name"), 24)
    activity = clean_text(design.get("activity"), 40)
    if not name or not activity:
        return "the design needs a name and an activity"
    what = clean_text(design.get("what"), 80) or name
    helps = design.get("helps") if design.get("helps") in NEEDS else "curiosity"
    taken = set(blueprints(world, town)) | {l["place"] for l in town["lots"] if l.get("place")} | {"building_site", "any"}
    base = slugify(name)
    slug, i = base, 2
    while slug in taken:
        slug, i = f"{base}_{i}", i + 1
    rules = world["design_rules"]
    emoji = clean_emoji(design.get("emoji"))
    color = str(design.get("color", ""))
    color = color if re.fullmatch(r"#[0-9a-fA-F]{6}", color) else "#8e44ad"
    effect = rules["effect"] / 2 if helps == "rest" else rules["effect"]
    town["custom_blueprints"][slug] = {
        "name": name, "bricks": rules["bricks"], "coins": 0, "work": rules["work"], "place": slug, "desc": what,
        "look": {"kind": "shop", "color": color, "emoji": emoji, "floors": 1 + len(name) % 2},
        "custom": True, "designed": today, "helps": helps, "activity": activity}
    town["custom_moves"][f"use_{slug}"] = {"label": activity[0].lower() + activity[1:], "at": [slug],
                                           "needs": {helps: -effect}, "mood": rules["mood"]}
    town["history"].append({"date": today, "text": f"Designed his own building: {emoji} {name} ({what})."})
    state["designed_on"] = today
    log("designed", f"designed a new building: {emoji} {name}, {what}")
    return None


def reachable(state, bid, place, has_library):
    """Can he read this book where he is? Home shelf at home; at the library, every book that's arrived."""
    w = book_where(state, bid)
    return w is not None and (w == "home" or (place == "library" and has_library))


def read_book(state, want, log, has_library=True):
    """Next chapter of a book. Home shelf = home books (+ delivered boxes); the library has them all.
    Nothing new left = he re-reads an old favourite. Returns (ok, note)."""
    B, place = library()["books"], state["place"]
    here = [b for b, v in B.items() if reachable(state, b, place, has_library) and b not in state["finished"]
            and state["books"].get(b, 0) < len(v["chapters"])]
    if not here:
        if place == "home" and has_library and any(book_where(state, b) == "library" and b not in state["finished"] for b in B):
            return False, "nothing left to read here (the library has more)"
        old = [b for b in state["finished"] if b in B and reachable(state, b, place, has_library)]
        if not old:
            return False, "nothing to read here"
        bid = want if want in old else random.choice(old)
        ch = random.choice(B[bid]["chapters"])
        state["pending_read"] = {"source": B[bid]["title"], "part": ch["title"], "text": ch["text"]}
        return True, f"re-reading an old favourite: {B[bid]['title']}"
    started = [b for b in here if state["books"].get(b)]
    bid = want if want in here else (started[0] if started else random.choice(here))
    book, done = B[bid], state["books"].get(bid, 0)
    ch = book["chapters"][done]
    state["books"][bid] = done + 1
    state["pending_read"] = {"source": book["title"], "part": ch["title"], "text": ch["text"]}
    if done + 1 >= len(book["chapters"]):
        state["finished"].append(bid)
        perk = perk_text(book)
        log("learned", f"finished reading '{book['title']}'" + (f": {perk}" if perk else ""))
        return True, f"{book['title']}, last chapter"
    return True, f"{book['title']}, chapter {done + 1}/{len(book['chapters'])}"


def chapters_left(state, has_library):
    """Unread chapters he can get at right now (home shelf + delivered boxes, + the library once it's built)."""
    B = library()["books"]
    return sum(max(0, len(v["chapters"]) - state["books"].get(b, 0)) for b, v in B.items() if b not in state["finished"]
               and (book_where(state, b) == "home" or (has_library and book_where(state, b) == "library")))


def boxes_left(state):
    return sorted({v["box"] for v in library()["books"].values() if v["where"] == "box"} - set(state.get("book_boxes", [])))


def deliver_books(state, town, today, log, box=None, how="A box of books turned up at his door"):
    """A book box arrives: its books go on his shelf at home. Returns True if one came."""
    left = boxes_left(state)
    box = left[0] if box is None and left else box
    if box not in left:
        return False
    state["book_boxes"].append(box)
    titles = [v["title"] for v in library()["books"].values() if v["where"] == "box" and v.get("box") == box]
    log("noticed", f"📦 {how}: {', '.join(titles)}. {len(titles)} new books on his shelf at home.")
    town["history"].append({"date": today, "text": f"A box of {len(titles)} books arrived: {', '.join(titles[:3])}" +
                                                   (" and more." if len(titles) > 3 else ".")})
    return True


def check_books(state, world, town, today, log):
    """Never runs dry: nearly out of books = the next box arrives (max one a day)."""
    if state.get("box_date") == today or not boxes_left(state):
        return
    if chapters_left(state, has_place(town, "library")) <= world.get("books", {}).get("refill_below", 10):
        if deliver_books(state, town, today, log):
            state["box_date"] = today


def look_up(state, topic):
    """His old laptop: an OFFLINE encyclopedia (a saved copy of some Wikipedia pages). No internet."""
    E = library()["encyclopedia"]
    t = str(topic or "").strip().lower()
    hit = next((k for k in E if k.lower() == t), None) or next((k for k in E if t and t in k.lower()), None)
    note = ""
    if not hit:
        fresh = [k for k in E if k not in state["looked_up"]] or list(E)
        hit = random.choice(fresh)
        note = f"no page on '{clean_text(topic, 30)}', read about {hit} instead" if t else ""
    state["looked_up"] = (state["looked_up"] + [hit])[-40:]
    state["pending_read"] = {"source": f"his laptop: {hit}", "part": "", "text": E[hit]["text"]}
    return note or hit


def write_note(state, sheet, use_mock, log, now):
    """After reading, one line for his notebook in his own words (AI), or the first sentence (no AI)."""
    r = state.pop("pending_read", None)
    if not r:
        return
    note = None
    if not use_mock:
        try:
            system = (f"You are {sheet['name']}. {sheet['what']} Voice: {sheet['voice']}\n"
                      "You just read the text below. Write ONE note for your notebook: what you learned or found interesting, "
                      'first person, in your voice, max 25 words, no em dashes. Reply with ONLY: {"note":"..."}')
            user = f"SOURCE: {r['source']}" + (f" ({r['part']})" if r["part"] else "") + f"\n\n{r['text']}"
            text, usage = call_model(system, user, max_tokens=800)
            add_usage(state, usage)
            start, end = text.index("{"), text.rindex("}") + 1
            note = clean_text(json.loads(text[start:end]).get("note"), 200)
        except Exception as e:
            print(f"[notes] {e}")
    if not note:
        note = clean_text(re.split(r"(?<=[.!?])\s", r["text"].strip(), maxsplit=1)[0], 160)
    src = r["source"] + (f" ({r['part']})" if r["part"] else "")
    state["notebook"].append({"date": now.astimezone(TZ).date().isoformat(), "source": src, "note": note})
    del state["notebook"][:-NOTEBOOK_KEEP]
    log("note", f"noted ({src}): {note}")


def beach_move(state, world, d, today, log):
    """Beach specials. Returns (ok, note, mood_bonus)."""
    b, rules = state["beach"], world["beach"]
    if d.get("tan"):
        if state["tick"] < b["burnt_until"]:
            return False, "still sunburnt, staying in the shade", 0.0
        b["sun_today"] += 1
        k = wkind(state, world)
        b["tan"] = round(min(1.0, b["tan"] + 0.08 * k.get("tan", 1.0) * (1 - b["tan"])), 3)
        if b["sun_today"] > k.get("sunburn_after", rules["sunburn_after"]) and "beach_kit" not in state["owned"]:
            b["burnt_until"] = state["tick"] + rules["sunburn_ticks"]
            state["needs"]["rest"] = round(clamp(state["needs"]["rest"] + 0.10, 0, 1), 3)
            log("noticed", f"Ouch. {me()} stayed in the sun too long and got sunburnt.")
            return True, "ouch, sunburnt! (should've had sunscreen)", -0.15
        return True, f"tan {b['tan']:.0%}", 0.0
    if d.get("surf"):
        if b["waves"] == "flat":
            return False, "it's flat today, no waves", 0.0
        b["surf_sessions"] += 1
        b["surf_skill"] = round(min(1.0, b["surf_skill"] + 0.06 * (1 - b["surf_skill"])), 3)
        if random.random() < 0.6 - 0.5 * b["surf_skill"]:
            return True, f"wiped out! (skill {b['surf_skill']:.0%})", -0.02
        return True, f"caught a {'cracking' if b['waves'] == 'good' else 'little'} wave (skill {b['surf_skill']:.0%})", 0.06 if b["waves"] == "good" else 0.02
    if d.get("castle"):
        c = next((c for c in b["castles"] if c["date"] == today and c["size"] < rules["castle_max"]), None)
        if not c:
            c = {"date": today, "size": 0}
            b["castles"].append(c)
        c["size"] += 1
        b["best_castle"] = max(b["best_castle"], c["size"])
        if c["size"] == rules["castle_max"]:
            log("built", "finished a proper sand castle, towers, moat and a flag!")
            return True, "castle finished!", 0.10
        return True, f"sand castle size {c['size']}/{rules['castle_max']}", 0.0
    if d.get("shells"):
        n = random.randint(1, 3)
        b["shells"] += n
        return True, f"+{n} shells ({b['shells']} in the jar)", 0.0
    return True, "", 0.0


# ---------------------------------------------------------------- weather + seasons (no AI)

WEATHER_MOVES = ("build_a_snowman", "play_in_the_snow", "splash_in_puddles", "watch_the_storm", "make_hot_chocolate")
WEATHER_RANK = ["snow", "storm", "heatwave", "rain", "fog", "windy", "sunny", "cloudy"]   # most diary-worthy first


def season_of(world, d):
    for s, months in world["weather"]["seasons"].items():
        if d.month in months:
            return s
    return "summer"


def wkind(state, world):
    """The rules for the weather right now (empty dict if none yet)."""
    return world["weather"]["kinds"].get((state.get("weather") or {}).get("kind"), {})


def weather_closed(state, world):
    """Moves the weather shuts right now: {move: reason}."""
    W, wx = world["weather"], state.get("weather") or {}
    out = dict(wkind(state, world).get("closes", {}))
    if wx.get("temp", 20) <= W["cold_from"]:
        out = {**W["cold_closes"], **out}
    return out


def weather_says_no(d, state):
    """Weather-only moves (snowman, puddles...): a reason if the weather doesn't allow it now, else None."""
    wx = state.get("weather") or {}
    if d.get("snow_cover") and wx.get("snow", 0) < 0.15:
        return "there's no snow on the ground"
    if d.get("weather") and wx.get("kind") not in d["weather"]:
        return "only when it's " + " or ".join({"storm": "stormy", "rain": "raining", "snow": "snowing"}.get(k, k) for k in d["weather"])
    if "max_temp" in d and wx.get("temp", 20) > d["max_temp"]:
        return "too warm for that"
    return None


def update_weather(state, world, local, log):
    """Seasons, a weather roll at each change hour, temperature through the day, snow on the ground, puddles."""
    W, FB = world["weather"], free_brain().get("weather", {})
    wx = state.setdefault("weather", {})
    season = season_of(world, local.date())
    hours = W["change_hours"]
    slot = max([h for h in hours if h <= local.hour], default=None)
    key = f"{local.date().isoformat()}@{slot}" if slot is not None else f"{(local.date() - timedelta(days=1)).isoformat()}@{hours[-1]}"
    if wx.get("key") != key:
        old_kind, old_season = wx.get("kind"), wx.get("season")
        odds = W["odds"][season]
        kind = old_kind if old_kind in odds and random.random() < W["stay"] else random.choices(list(odds), weights=list(odds.values()))[0]
        lo, hi = W["temp"][season]
        base = random.uniform(lo, hi) + W["kinds"][kind].get("temp", 0)
        if kind == "rain" and base <= 0:
            kind = "snow"
        if W["kinds"][kind].get("snows"):
            base = min(base, random.uniform(-4, 0))
        k = W["kinds"][kind]
        wx.update(key=key, kind=kind, season=season, base=round(base, 1), emoji=k["emoji"], name=k["name"],
                  season_emoji=W["season_emoji"].get(season, ""))
        if slot == hours[0] or not wx.get("seen"):
            wx["seen"] = []                                 # a new day of weather (for tonight's diary)
        if kind not in wx["seen"]:
            wx["seen"].append(kind)
        if k.get("waves"):
            state["beach"]["waves"] = k["waves"]
        if old_season and old_season != season:
            line = fb_pick(FB.get("season", {}).get(season) or [f"{season.capitalize()} is here."])
            log("noticed", f"{W['season_emoji'].get(season, '')} {line.replace('{me}', me())}".strip())
        if kind != old_kind:
            line = fb_pick(FB.get("news", {}).get(kind) or [f"The weather's turned {k['name']}."])
            log("noticed", f"{k['emoji']} {line.replace('{me}', me())}")
    hour = local.hour + local.minute / 60
    temp = wx["base"] + 3.5 * math.cos(2 * math.pi * (hour - 15) / 24)     # warmest at 3 PM, coldest at 3 AM
    k = wkind(state, world)
    if k.get("snows"):
        temp = min(temp, 1)
    wx["temp"] = round(temp)
    snow = wx.get("snow", 0.0)
    if k.get("snows"):
        snow += W["snow_per_tick"]
    elif temp > 2:
        snow -= W["melt_per_tick"] * (2 if wx["kind"] in ("sunny", "rain", "heatwave") else 1)
    wx["snow"] = round(clamp(snow, 0, 1), 3)
    if wx.get("snowman") and wx["snow"] <= 0:
        wx["snowman"] = 0
        log("noticed", "The snow's gone, and so is the snowman. Just a carrot and an old cap left on the grass.")
    wet = 1.0 if wx["kind"] in ("rain", "storm") else wx.get("wet", 0.0) - (0.10 if wx["kind"] in ("sunny", "heatwave", "windy") else 0.05)
    wx["wet"] = round(clamp(wet, 0, 1), 2)


# ---------------------------------------------------------------- the garage project: bike restorations (no AI)

def day_after(today):
    return (date.fromisoformat(today) + timedelta(days=1)).isoformat()


def bike_lines():
    return free_brain().get("bike", {})


def project_kind(world, pr):
    return world["garage_projects"]["kinds"][pr["kind"]]


def bike_name(pr, world):
    return pr.get("name") or f"the {project_kind(world, pr)['name']}"


def stage_of(world, pr):
    k = project_kind(world, pr)
    return k["stages"][min(pr["stage"], len(k["stages"]) - 1)]


def stage_sessions(state, st):
    """Work sessions this stage needs; finished books with project_stage perks cut it."""
    if st.get("odds"):
        return 1
    return max(1, st["sessions"] - int(round(perk_sum(state, "project_stage", stage=st["id"]))))


def project_status(state, world, today):
    """What's holding the project up, in plain words (None = he can crack on)."""
    pr = state.get("project")
    if not pr or pr.get("finished"):
        return None
    st = stage_of(world, pr)
    if st.get("coins") and pr["parts"] == "none":
        return f"needs parts first ({st['coins']} coins)"
    if pr["parts"] == "ordered":
        return "parts on the way, here tomorrow"
    if pr.get("wait") and today < pr["wait"]["until"]:
        return {"soak": "carb soaking in cleaner till tomorrow", "dry": "paint drying till tomorrow",
                "start": "try the first start again tomorrow"}.get(pr["wait"]["why"], "waiting till tomorrow")
    if pr.get("today_date") == today and pr.get("today", 0) >= world["garage_projects"]["sessions_per_day"]:
        return "done enough on it for today"
    return None


def bike_fill(text, state, world, pr=None):
    pr = pr or state.get("project") or {}
    if pr:
        text = text.replace("{bike}", bike_name(pr, world)).replace("{stage}", stage_of(world, pr)["name"] if "kind" in pr else "")
    return text.replace("{me}", me()).replace("{pup}", pup_name(state))


def new_project(state, world, town, kid, today, log):
    """A project bike rolls into his garage."""
    k = world["garage_projects"]["kinds"][kid]
    st0 = k["stages"][0]
    state["project"] = {"kind": kid, "name": None, "found": today, "stage": 0, "done": 0,
                        "parts": "none" if st0.get("coins") else "in", "parts_due": None, "wait": None,
                        "colour": None, "colour_hex": None, "spent": k.get("buy", 0), "sessions": 0, "tries": 0,
                        "today_date": None, "today": 0, "finished": None, "rides": 0}
    state["bike_offer"] = None
    text = bike_fill(k.get("arrive") or f"{me()} bought {k['what']}. It's in the garage now.", state, world)
    log("bike", text)
    town["history"].append({"date": today, "text": f"A project bike arrived in the garage: {k['what']}."})
    if k.get("brings_box"):
        deliver_books(state, town, today, log, box=k["brings_box"], how="The farmer threw in a box of old workshop books with it")


def next_project_kind(state, world):
    """Which project comes next: one he hasn't done yet first, then any that can repeat."""
    G, done = world["garage_projects"], [r["kind"] for r in state.get("restored", [])]
    ok = [kid for kid, k in G["kinds"].items() if not kid.startswith("_")
          and (not k.get("after") or k["after"] in done) and (kid not in done or k.get("repeat"))]
    fresh = [kid for kid in ok if kid not in done]
    return (fresh or ok or [None])[0]


def update_project(state, world, town, today, hour, log):
    """Every awake tick: parts arriving, waits ending, a new project turning up."""
    G = world.get("garage_projects")
    if not G or not has_place(town, "garage"):
        return
    pr = state.get("project")
    if pr and not pr.get("finished"):
        if pr["parts"] == "ordered" and today >= (pr.get("parts_due") or today) and hour >= 7:
            pr["parts"] = "in"
            log("bike", f"📦 The parts for {bike_name(pr, world)}'s {stage_of(world, pr)['name']} turned up.")
        if pr.get("wait") and today >= pr["wait"]["until"]:
            why = pr["wait"]["why"]
            pr["wait"] = None
            line = (bike_lines().get("wait_over") or {}).get(why)
            if line:
                log("bike", bike_fill(fb_pick(line), state, world))
        return
    if pr:
        return
    T = G["turns_up"]
    if not T["hours"][0] <= hour < T["hours"][1]:
        return
    free = state.get("garage_free_since")
    if free and (date.fromisoformat(today) - date.fromisoformat(free)).days < T["gap_days"]:
        return
    kid = next_project_kind(state, world)
    if not kid:
        return
    k = G["kinds"][kid]
    if k.get("buy"):
        if not state.get("bike_offer"):
            state["bike_offer"] = {"kind": kid, "since": today}
            log("noticed", bike_fill(k.get("offer") or f"A {k['name']} is for sale: {k['buy']} coins.", state, world))
        return
    if state["coins"] >= T["min_coins"]:
        new_project(state, world, town, kid, today, log)


def project_moves(state, world, town, today):
    """The garage-project moves that make sense right now."""
    G, pr, out = world.get("garage_projects"), state.get("project"), {}
    if not G or not has_place(town, "garage"):
        return out
    if pr and not pr.get("finished"):
        st, name = stage_of(world, pr), bike_name(pr, world)
        if st.get("coins") and pr["parts"] == "none":
            if state["coins"] >= st["coins"]:
                out["order_restoration_parts"] = {"label": f"ordering parts for {name}'s {st['name']}", "at": ["garage"],
                                                  "needs": {"curiosity": -0.05}, "mood": 0.03, "coins": -st["coins"], "project": "order"}
        elif project_status(state, world, today) is None:
            out["work_on_the_restoration"] = {"label": f"restoring {name}: {st['name']}", "at": ["garage"],
                                              "needs": {"tinker": -0.35, "curiosity": -0.05, "rest": 0.04, "hunger": 0.02},
                                              "mood": 0.06, "project": "work"}
    if (pr and pr.get("finished")) or state.get("bikes"):
        bike = bike_name(pr, world) if pr and pr.get("finished") else state["bikes"][-1]["name"]
        out["ride_a_restored_bike"] = {"label": f"riding {bike} round the island", "at": ["garage"],
                                       "needs": {"curiosity": -0.2, "social": -0.05, "tinker": -0.05, "rest": 0.03},
                                       "mood": 0.15, "project": "ride"}
    if pr and pr.get("finished"):
        name = bike_name(pr, world)
        out["keep_the_restored_bike"] = {"label": f"keeping {name}: parking her up for good", "at": ["garage"],
                                         "needs": {}, "mood": 0.08, "project": "keep"}
        if has_place(town, "market_stall"):
            out["sell_the_restored_bike"] = {"label": f"selling {name} at the stall", "at": ["market_stall"],
                                             "needs": {"social": -0.15}, "mood": 0.05, "project": "sell"}
    offer = state.get("bike_offer")
    if offer and not pr:
        k = G["kinds"][offer["kind"]]
        if state["coins"] >= k["buy"]:
            out["buy_a_project_bike"] = {"label": f"buying the {k['name']}", "at": ["garage"], "needs": {"curiosity": -0.1},
                                         "mood": 0.10, "coins": -k["buy"], "project": "buy"}
    return out


PROJECT_MOVES = ("work_on_the_restoration", "order_restoration_parts", "ride_a_restored_bike", "keep_the_restored_bike",
                 "sell_the_restored_bike", "buy_a_project_bike")


def project_refusal(state, world, town, move, today):
    """Why a garage-project move can't happen right now (so the AI learns something from the 'no')."""
    pr, closed = state.get("project"), weather_closed(state, world)
    if move in closed:
        return closed[move]
    if move == "ride_a_restored_bike":
        return "no restored bike to ride yet" if state["place"] == "garage" else "the bikes are at the garage"
    if move == "buy_a_project_bike":
        offer = state.get("bike_offer")
        if not offer or pr:
            return "nothing for sale right now" if not pr else "the garage already has a project in it"
        return f"needs {world['garage_projects']['kinds'][offer['kind']]['buy']} coins"
    if not pr:
        return "no project bike in the garage right now"
    if move == "sell_the_restored_bike":
        return "she isn't finished yet" if not pr.get("finished") else "sell her at the market stall"
    if move == "keep_the_restored_bike":
        return "she isn't finished yet" if not pr.get("finished") else "do that at the garage"
    if pr.get("finished"):
        return f"{bike_name(pr, world)} is finished: ride her, then keep or sell her"
    st = stage_of(world, pr)
    if move == "order_restoration_parts":
        if not st.get("coins") or pr["parts"] != "none":
            return "parts already sorted for this stage" if st.get("coins") else "this stage doesn't need parts"
        return f"needs {st['coins']} coins for the parts"
    return project_status(state, world, today) or "can't work on her right now"


def project_line(state, world, today, for_ai=True):
    """The garage project in one or two lines (for his prompt + the diary prompt)."""
    G, pr = world.get("garage_projects"), state.get("project")
    if not G:
        return ""
    kept = ", ".join(f"{b['name']} ({b.get('colour') or 'original paint'})" for b in state.get("bikes", []))
    tail = f" KEPT BIKES: {kept}." if kept else ""
    if not pr:
        offer = state.get("bike_offer")
        if offer:
            k = G["kinds"][offer["kind"]]
            return f"GARAGE PROJECT: none. FOR SALE: {k['what']}, {k['buy']} coins (buy_a_project_bike at the garage).{tail}"
        return f"GARAGE PROJECT: none right now (one turns up now and then).{tail}"
    k, name = project_kind(world, pr), pr.get("name")
    who = f"\"{name}\"" if name else ("NO NAME YET (add \"bike_name\" to your reply)" if for_ai else "no name yet")
    days = (date.fromisoformat(today) - date.fromisoformat(pr["found"])).days + 1
    if pr.get("finished"):
        lo, hi = k["sell"]
        return (f"GARAGE PROJECT: {who}, the {k['name']}, is FINISHED and runs ({pr.get('colour') or 'original paint'}, ridden {pr.get('rides', 0)}x). "
                f"ride_a_restored_bike at the garage; then keep_the_restored_bike, or sell_the_restored_bike at the market stall "
                f"(about {lo}-{hi} coins).{tail}")
    st = stage_of(world, pr)
    stages = ", ".join(s["name"] + (" ✓" if i < pr["stage"] else " (NOW)" if i == pr["stage"] else "") for i, s in enumerate(k["stages"]))
    hold = project_status(state, world, today)
    work = "first start: " + (f"tried {pr['tries']}x" if pr["tries"] else "not tried yet") if st.get("odds") else f"{pr['done']}/{stage_sessions(state, st)} sessions"
    colours = f" Paint colours: {', '.join(G['colours'])}." if st.get("colour") and pr["parts"] == "none" and for_ai else ""
    return (f"GARAGE PROJECT: {who}, the {k['name']} ({k['what']}), day {days}. Stage {pr['stage'] + 1}/{len(k['stages'])}: {st['name']}, {work}. "
            f"{'Holding it up: ' + hold if hold else 'Ready to work on (work_on_the_restoration at the garage)'}.{colours} "
            f"Stages: {stages}. Parts spent so far: {pr['spent']} coins.{tail}")


def garage_view(state, world, today):
    """The garage project, ready for the web pages (status card, 'right now' panel, 3D look)."""
    G, pr = world.get("garage_projects"), state.get("project")
    if not G:
        return None
    v = {"bikes": [{k: b.get(k) for k in ("name", "kind", "colour", "colour_hex", "look", "rides")} for b in state.get("bikes", [])],
         "restored": [{k: r.get(k) for k in ("name", "kind", "finished", "fate", "sold_for", "spent")} for r in state.get("restored", [])][-6:]}
    offer = state.get("bike_offer")
    if offer and not pr:
        k = G["kinds"][offer["kind"]]
        v["offer"] = {"what": k["what"], "coins": k["buy"]}
    if pr:
        k = project_kind(world, pr)
        st = stage_of(world, pr)
        v["project"] = {
            "name": pr.get("name"), "kind": pr["kind"], "kind_name": k["name"], "what": k["what"], "look": k.get("look", "classic"),
            "day": (date.fromisoformat(today) - date.fromisoformat(pr["found"])).days + 1, "spent": pr["spent"],
            "colour": pr.get("colour"), "colour_hex": pr.get("colour_hex"), "finished": pr.get("finished"), "rides": pr.get("rides", 0),
            "hold": project_status(state, world, today), "stage": pr["stage"], "stage_id": st["id"], "parts": pr["parts"],
            "wait": (pr.get("wait") or {}).get("why") if pr.get("wait") and today < pr["wait"]["until"] else None,
            "stages": [{"id": s["id"], "name": s["name"], "need": stage_sessions(state, s),
                        "done": (stage_sessions(state, s) if (i < pr["stage"] or pr.get("finished")) else pr["done"] if i == pr["stage"] else 0),
                        "coins": s.get("coins", 0)} for i, s in enumerate(k["stages"])]}
    return v


def pick_colour(world, want):
    C = world["garage_projects"]["colours"]
    w = str(want or "").strip().lower()
    hit = next((c for c in C if c.lower() == w), None) or next((c for c in C if w and (w in c.lower() or c.lower().split()[-1] == w)), None)
    return hit or random.choice(list(C))


def project_move(state, world, town, what, step, today, log):
    """Do one garage-project move. Returns (ok, note, mood_bonus)."""
    G, pr, L = world["garage_projects"], state.get("project"), bike_lines()
    if what == "buy":
        offer = state.get("bike_offer") or {}
        new_project(state, world, town, offer.get("kind"), today, log)
        return True, "she's in the garage", 0.0
    if what == "order":
        st = stage_of(world, pr)
        pr["parts"], pr["parts_due"] = "ordered", day_after(today)
        pr["spent"] += st["coins"]
        note = f"{st['coins']} coins of parts, here tomorrow"
        if st.get("colour"):
            pr["colour"] = pick_colour(world, step.get("colour"))
            pr["colour_hex"] = G["colours"][pr["colour"]]
            log("bike", f"picked a colour for {bike_name(pr, world)}: {pr['colour']}.")
            note += f", paint: {pr['colour']}"
        return True, note, 0.0
    if what == "work":
        st = stage_of(world, pr)
        if pr.get("today_date") != today:
            pr["today_date"], pr["today"] = today, 0
        pr["today"] += 1
        pr["sessions"] += 1
        if st.get("odds"):                               # the first start
            odds = st["odds"][min(pr["tries"], len(st["odds"]) - 1)] + perk_sum(state, "project_stage", stage="start")
            pr["tries"] += 1
            if random.random() >= odds:
                pr["wait"] = {"until": day_after(today), "why": "start"}
                log("bike", bike_fill(fb_pick(L.get("start_fail") or ["{bike} coughed, spat and died. Tomorrow."]), state, world))
                return True, f"go {pr['tries']}: she wouldn't fire", -0.04
            pr["finished"] = today
            days = (date.fromisoformat(today) - date.fromisoformat(pr["found"])).days + 1
            k = project_kind(world, pr)
            log("bike", bike_fill(fb_pick(L.get("start_ok") or ["{bike} RUNS!"]), state, world))
            log("built", f"restored {bike_name(pr, world)}, the {k['name']}: {days} days, {pr['spent']} coins of parts, "
                         f"started on go {pr['tries']}!")
            town["history"].append({"date": today, "text": f"Restored {bike_name(pr, world)} ({k['what']}) in {days} days."})
            return True, f"go {pr['tries']}: SHE RUNS!", 0.25
        pr["done"] += 1
        need = stage_sessions(state, st)
        if pr["done"] >= need:                           # stage done
            log("bike", bike_fill(fb_pick((L.get("stage_done") or {}).get(st["id"]) or ["{stage} done on {bike}."]), state, world))
            pr["stage"] += 1
            pr["done"], pr["wait"] = 0, None
            nxt = stage_of(world, pr)
            pr["parts"] = "none" if nxt.get("coins") else "in"
            return True, f"{st['name']} done!", 0.08
        w = st.get("wait")
        if w and pr["done"] == w["after"]:
            pr["wait"] = {"until": day_after(today), "why": w["why"]}
            log("bike", bike_fill(fb_pick((L.get("wait") or {}).get(w["why"]) or ["Leaving {bike} till tomorrow."]), state, world))
        return True, f"{st['name']} {pr['done']}/{need}", 0.0
    if what == "ride":
        bike = pr if pr and pr.get("finished") else state["bikes"][-1]
        bike["rides"] = bike.get("rides", 0) + 1
        return True, fb_pick(L.get("ride_notes") or ["a lap of the island"]), 0.0
    if what in ("keep", "sell"):
        k = project_kind(world, pr)
        name = bike_name(pr, world)
        rec = {"name": name, "kind": pr["kind"], "found": pr["found"], "finished": pr["finished"], "spent": pr["spent"],
               "colour": pr.get("colour"), "colour_hex": pr.get("colour_hex"), "rides": pr.get("rides", 0)}
        if what == "keep":
            state["bikes"].append({**rec, "look": k.get("look", "classic")})
            note = fb_pick(L.get("keep") or ["she stays"])
            town["history"].append({"date": today, "text": f"Kept {name} for good. She lives by the garage now."})
        else:
            price = random.randint(*k["sell"])
            state["coins"] += price
            state["sales"]["items"] += 1
            state["sales"]["coins"] += price
            rec["sold_for"] = price
            note = f"sold for {price} coins"
            town["history"].append({"date": today, "text": f"Sold {name} at the stall for {price} coins."})
            log("bike", bike_fill(fb_pick(L.get("sold") or ["Sold {bike}. Bittersweet."]), state, world) + f" (+{price} coins)")
        state["restored"].append({**rec, "fate": "kept" if what == "keep" else "sold"})
        state["project"] = None
        state["garage_free_since"] = today
        return True, note, 0.05
    return False, "nothing to do on the bike", 0.0


def hit_lucky(state, world):
    lb = world["lucky_block"]
    state["lucky"]["used"] += 1
    prize = random.choices(lb["prizes"], weights=[p["weight"] for p in lb["prizes"]])[0]
    state["bricks"] += prize.get("bricks", 0)
    state["coins"] += prize.get("coins", 0)
    return prize["text"], prize.get("mood", 0.0)


def sell_stock(state, world, pricing):
    """A shift at the market stall. Each item has a chance to sell; his pricing sets price vs speed."""
    S, P, cat = world["selling"], world["products"], world["catalogue"]
    pricing = pricing if pricing in S["pricing"] else "fair"
    rule = S["pricing"][pricing]
    chance = rule["chance"] + sum(cat[i].get("sell_chance", 0) for i in state["owned"] if i in cat) + perk_sum(state, "sell_chance")
    chance *= wkind(state, world).get("sell", 1.0)          # fewer people out in the rain or snow
    units = [pid for pid, n in state["stock"].items() for _ in range(n)]
    random.shuffle(units)
    sold, coins = Counter(), 0
    for pid in units:
        if sum(sold.values()) >= S["max_sales_per_tick"]:
            break
        if random.random() < chance:
            sold[pid] += 1
            coins += max(1, round((P[pid]["value"] + perk_sum(state, "product_value", product=pid)) * rule["price"]))
            state["stock"][pid] -= 1
    state["stock"] = {k: v for k, v in state["stock"].items() if v > 0}
    state["coins"] += coins
    state["sales"]["items"] += sum(sold.values())
    state["sales"]["coins"] += coins
    if not sold:
        quiet = wkind(state, world).get("sell", 1.0) < 1
        return f"{pricing} prices, no buyers this time" + (f" (quiet in this {state['weather']['kind']})" if quiet else ""), -0.02
    what = ", ".join(f"{n} {P[pid]['name']}" + ("s" if n > 1 else "") for pid, n in sold.items())
    return f"{pricing} prices, sold {what} for {coins} coins", 0.05


# ---------------------------------------------------------------- the world's rules (no AI)

def moves_here(W, place):
    """Move ids he can do right where he is, plus walking somewhere else."""
    here = [m for m, d in W["moves"].items() if "any" in d["at"] or place in d["at"]]
    walks = [f"walk_to_{p}" for p in W["places"] if p != place]
    return here, walks


def move_label(W, move):
    if move.startswith("walk_to_"):
        return "walking home" if move == "walk_to_home" else f"walking to the {nice(move[8:])}"
    return W["moves"].get(move, {}).get("label", nice(move))


def update_needs(state, world):
    """Needs creep up (or rest drops while asleep). Pure maths."""
    mode = "asleep" if state["asleep"] else "awake"
    for n in NEEDS:
        state["needs"][n] = round(clamp(state["needs"][n] + world["needs"][n][mode], 0, 1), 3)
    pup = state.get("pup")
    if pup and not state["asleep"] and not pup["napping"]:      # a puppy is good company
        cut = world["needs"]["social"]["awake"] * world["puppy"]["company"] * pup["bond"]
        state["needs"]["social"] = round(clamp(state["needs"]["social"] - cut, 0, 1), 3)
    if not state["asleep"]:                                 # heat tires him, cold makes him hungry
        k = wkind(state, world)
        for n in ("rest", "hunger"):
            if k.get(n):
                state["needs"][n] = round(clamp(state["needs"][n] + k[n], 0, 1), 3)
    state["energy"] = round(1 - state["needs"]["rest"], 2)


def update_mood(state, world, bonus=0.0, base_bonus=0.0):
    """Mood drifts toward a target that drops when needs get pressing (and rises a bit with a pretty town)."""
    m = world["mood"]
    pressing = sum(max(0, state["needs"][n] - m["pressing_from"]) for n in NEEDS)
    target = m["base"] + base_bonus + perk_sum(state, "mood_base") - m["pressing_pull"] * pressing
    target += wkind(state, world).get("mood", 0.0)        # sunshine lifts him, a storm drags him down
    pup = state.get("pup")
    if pup and max(pup["needs"]["hunger"], pup["needs"]["bored"]) >= world["puppy"]["neglect_from"]:
        target -= 0.10                                     # he worries about the pup
    state["mood"] = round(clamp(state["mood"] + (target - state["mood"]) * m["drift"] + bonus, -1, 1), 2)
    state["energy"] = round(1 - state["needs"]["rest"], 2)  # energy is just "how rested"


def apply_move(state, world, town, step, today, log):
    """Try to do one move. Returns (ok, reason_if_refused, mood_bonus, note). The WORLD can say no."""
    W = merged_world(world, town, state, today)
    move = str(step.get("move", ""))
    here, walks = moves_here(W, state["place"])
    if move in walks:
        state["place"] = move[8:]
        state["needs"]["rest"] = round(clamp(state["needs"]["rest"] + 0.01, 0, 1), 3)
        return True, None, 0.0, ""
    if move.startswith("walk_to_"):
        return False, "already there" if move[8:] == state["place"] else "no such place", 0.0, ""
    if move not in here:
        if move.startswith("start_build_"):
            bp = blueprints(world, town).get(move[12:])
            reason = can_start(move[12:], bp, state, town)[1] if bp else "no such blueprint"
            return False, reason or "can't start that", 0.0, ""
        if move == "hit_the_lucky_block" and state["place"] == "brick_pit":
            return False, "the ! block is empty till tomorrow", 0.0, ""
        if move in PROJECT_MOVES and state["place"] in ("garage", "market_stall"):
            return False, project_refusal(state, world, town, move, today), 0.0, ""
        wd = world["moves"].get(move, {})
        if isinstance(wd, dict) and (state["place"] in wd.get("at", []) or "any" in wd.get("at", [])):
            closed = weather_closed(state, world)
            if move in closed:
                return False, closed[move], 0.0, ""
            if weather_says_no(wd, state):
                return False, weather_says_no(wd, state), 0.0, ""
        if state["place"] in wd.get("at", []) and "hours" in wd and not wd["hours"][0] <= state.get("hour", 12) < wd["hours"][1]:
            return False, f"not now (only {wd['hours'][0]}:00 to {wd['hours'][1]}:00)", 0.0, ""
        if wd.get("requires") and wd["requires"] not in state["owned"] and state["place"] in wd.get("at", []):
            return False, f"needs a {wd['requires'].replace('_', ' ')} first (order one at home)", 0.0, ""
        if wd.get("pup_awake") and state.get("pup") and state["pup"]["napping"]:
            return False, f"{pup_name(state)} is napping", 0.0, ""
        if move == "feed_the_puppy" and state.get("pup") and state["pup"]["food"] <= 0:
            return False, "no dog food left (buy_dog_food at home)", 0.0, ""
        if move == "run_the_stall" and state["place"] == "market_stall":
            return False, "nothing left to sell (make something first)", 0.0, ""
        if move == "design_a_building" and state["place"] == "home":
            return False, "already designed something today (or too many unbuilt designs)", 0.0, ""
        where = "at home" if state["place"] == "home" else f"at the {nice(state['place'])}"
        return False, f"can't do that {where}", 0.0, ""

    d = W["moves"][move]
    coins, bricks = d.get("coins", 0), d.get("bricks", 0)
    if state["coins"] + coins < 0:
        return False, "can't afford it", 0.0, ""
    if state["bricks"] + bricks < 0:
        return False, "not enough bricks", 0.0, ""
    bonus, notes = d.get("mood", 0.0), []
    if d.get("read"):
        ok, note = read_book(state, step.get("book"), log, has_place(town, "library"))
        if not ok:
            return False, note, 0.0, ""
        notes.append(note)
    if d.get("lookup"):
        notes.append(look_up(state, step.get("topic")))
    if d.get("tan") or d.get("surf") or d.get("castle") or d.get("shells"):
        ok, note, extra = beach_move(state, world, d, today, log)
        if not ok:
            return False, note, 0.0, ""
        notes.append(note)
        bonus += extra
    if d.get("snowman"):
        wx = state["weather"]
        before = wx.get("snowman", 0)
        wx["snowman"] = min(3, before + 1)
        if before >= 3:                                  # already finished: just a touch-up (no repeat news)
            notes.append("gave the snowman a better nose")
        elif wx["snowman"] == 3:
            log("built", "built a proper snowman: carrot nose, stone eyes and his old orange cap!")
            notes.append("snowman finished!")
            bonus += 0.05
        else:
            notes.append(f"snowman {wx['snowman']}/3")
    if d.get("project"):
        ok, note, extra = project_move(state, world, town, d["project"], step, today, log)
        if not ok:
            return False, note, 0.0, ""
        notes.append(note)
        bonus += extra
    if d.get("design"):
        err = design_building(state, world, town, step.get("design"), today, log)
        if err:
            return False, err, 0.0, ""
    if d.get("build"):
        notes.append(start_site(state, world, town, d["build"], today))
    if d.get("work"):
        note, extra = work_site(state, world, town, today, log)
        notes.append(note)
        bonus += extra
    if d.get("luck"):
        note, extra = hit_lucky(state, world)
        notes.append(note)
        bonus += extra
    if d.get("make"):
        state["stock"][d["make"]] = state["stock"].get(d["make"], 0) + 1
        notes.append(f"{sum(state['stock'].values())} in stock")
    if d.get("buy"):
        item = world["catalogue"][d["buy"]]
        state["owned"].append(d["buy"])
        an = "an" if item["name"][:1].lower() in "aeiou" else "a"
        town["history"].append({"date": today, "text": f"Bought {an} {item['name'].lower()} ({item['what']})."})
        log("bought", f"bought {an} {item['name'].lower()}: {item['what']}")
    if d.get("sell"):
        note, extra = sell_stock(state, world, step.get("pricing"))
        notes.append(note)
        bonus += extra
    pup = state.get("pup")
    if pup and (d.get("pup") or d.get("bond") or d.get("food") or d.get("train")):
        if d.get("train"):
            note, extra = train_pup(state, world, step.get("trick"), log)
            notes.append(note)
            bonus += extra
        for n, delta in d.get("pup", {}).items():
            pup["needs"][n] = round(clamp(pup["needs"][n] + delta, 0, 1), 3)
        pup["bond"] = round(clamp(pup["bond"] + d.get("bond", 0) * (1 + perk_sum(state, "bond_gain")), 0, 1), 3)
        if move == "feed_the_puppy":
            pup["last_fed_tick"] = state["tick"]
        if d.get("pup_awake"):
            pup["last_played_tick"] = state["tick"]
        pup["food"] = max(0, pup["food"] + d.get("food", 0))
        if d.get("food", 0) > 0:
            notes.append(f"{pup['food']} meals in the cupboard")
    if pup and pup.get("wants") and move in PUP_WANT_MOVES.get(pup["wants"], ()):
        pup["wants"] = None                         # exactly what he wanted
        pup["bond"] = round(min(1.0, pup["bond"] + 0.01), 3)
        pup["thought"] = random.choice(["YES! That's what I wanted!", "Best. Human. Ever.", "Tail going at full speed!"])
        notes.append(f"{pup_name(state)}'s tail goes mad")
        bonus += 0.02
    if pup and not pup["napping"] and "fetch" in pup["learned"] and move == "collect_bricks":
        bricks += random.randint(1, 2)                 # trick perk: he fetches bricks
    if pup and not pup["napping"] and "ride" in pup["learned"] and move in ("go_for_a_ride", "ride_a_restored_bike"):
        pup["needs"]["bored"] = round(clamp(pup["needs"]["bored"] - 0.3, 0, 1), 3)
        bonus += 0.05
        notes.append(f"{pup_name(state)} rode along in the tank bag")
    coins += int(perk_sum(state, "move_coins", move=move))   # perks from books he finished
    bonus += perk_sum(state, "move_mood", move=move)
    for item in state["owned"]:                    # perks from things he bought
        perk = world["catalogue"].get(item, {}).get("bonus", {}).get(move, {})
        coins += perk.get("coins", 0)
        bricks += perk.get("bricks", 0)
    if d.get("bricks_rand"):
        n = random.randint(*d["bricks_rand"]) + max(0, bricks)
        bricks = min(0, bricks)
        state["bricks"] += n
        notes.append(f"+{n} bricks")
    state["coins"] += coins
    state["bricks"] += bricks
    if coins > 0:
        notes.append(f"+{coins} coins")
    for n, delta in d.get("needs", {}).items():
        state["needs"][n] = round(clamp(state["needs"][n] + delta, 0, 1), 3)
    if d.get("sleep"):
        state["asleep"] = True
    return True, None, bonus, ", ".join(notes)


def autopilot(state, W):
    """No AI: fix the most pressing need with a simple lookup. Returns a list of moves."""
    P = W["places"]
    fixes = {  # need -> (place, move)
        "rest": (state["place"], "rest"),
        "hunger": ("home", "cook_dinner") if state["coins"] >= 2 else ("home", "make_toast"),
        "social": ("cafe", "chat_with_locals"),
        "tinker": ("building_site", "work_on_site") if "building_site" in P and "work_on_site" in W["moves"] else ("garage", "fix_a_car"),
        "curiosity": ("library", "read_a_book") if "library" in P else ("home", "read_a_book"
                      if any(book_where(state, b) == "home" and b not in state.get("finished", []) for b in library()["books"])
                      else "use_the_computer"),
    }
    need = max(NEEDS, key=lambda n: state["needs"][n])
    pup = state.get("pup")
    if pup and pup["needs"]["hunger"] >= 0.75 and state["needs"][need] < 0.8:
        todo = ["feed_the_puppy"] if pup["food"] > 0 else ["buy_dog_food", "feed_the_puppy"] if state["coins"] >= 3 else []
        if todo:
            return (["walk_to_home"] if state["place"] != "home" else []) + todo
    if pup and not pup["napping"] and pup["needs"]["bored"] >= 0.75 and state["needs"][need] < 0.8:
        return [random.choice(["play_with_the_puppy", "walk_the_puppy"])]     # he's in Jarvis's care
    if state["needs"][need] < 0.4:
        if pup and not pup["napping"] and pup["needs"]["bored"] >= 0.5:
            return ["play_with_the_puppy"]
        return ["wait"]
    place, move = fixes[need]
    if place != state["place"]:
        return [f"walk_to_{place}", move]
    return [move]


# ---------------------------------------------------------------- the AI part

def sheet_text(sheet):
    return "\n".join([
        f"Name: {sheet['name']}. {sheet['what']}",
        f"Core: {sheet['core']}",
        "Traits: " + "; ".join(sheet["traits"]),
        "Likes: " + ", ".join(sheet["likes"]) + ". Dislikes: " + ", ".join(sheet["dislikes"]) + ".",
        "Quirks: " + "; ".join(sheet["quirks"]),
        f"Goal: {sheet['goal']}",
        f"Voice: {sheet['voice']}",
    ])


def build_prompt(state, W, world, town, sheet, feed, now):
    """Everything the AI needs to decide, as plain text. This IS his 'mind assembling context'."""
    system = f"""You are the mind of a character in a tiny simulated brick town. Each turn you decide what he does next.

WHO HE IS
{sheet_text(sheet)}

HIS TOWN
- He started with almost nothing and builds the town up himself, one build at a time.
- What to build, when, and whether it's worth the coins is entirely his call. Coins are also his Thailand fund.
- Bricks come from the brick pit (collect_bricks, plus a lucky ! block a few times a day).
- start_build_X pays for a build and puts up a building site. Then walk_to_building_site and work_on_site until it's done.
- design_a_building (at home, max once a day) invents a brand-new building of his own. Add a "design" to that move:
  "design":{{"name":"max 3 words","what":"max 12 words","activity":"what he does there, max 6 words","helps":"rest|hunger|social|tinker|curiosity","emoji":"one emoji","color":"#rrggbb"}}

HIS PUPPY
- The puppy is IN HIS CARE. He depends on {sheet['name']} completely: food, walks, play, training and company. Code tracks his needs; looking after him is {sheet['name']}'s job.
- A good owner checks on him every few hours, feeds him before bed, and never lets him go hungry or bored for long.
- feed_the_puppy (at home, uses dog food; buy_dog_food at home = 3 coins for 6 meals), play_with_the_puppy, walk_the_puppy, cuddle_the_puppy.
- train_the_puppy: add "trick":"<trick id>" to that move. Works best when the puppy is fed, rested and bonded. Some tricks help (fetch brings bricks).
- If the puppy has no name yet, add "puppy_name":"..." to your reply (his choice, short).
- The puppy has his own little mind: you can see what he's thinking and what he wants. Giving him what he wants makes his day.

LEARNING (no internet: his books and laptop are offline copies)
- read_a_book (at home: his own shelf; at the library: every book) reads the next chapter. Add "book":"<book id>" to pick one. Finished books teach him something useful.
- use_the_computer (at home) looks a topic up in his offline encyclopedia. Add "topic":"<topic>".
- After reading he writes a note in his notebook. His notebook is his memory of what he learned.
- The library (a blueprint) holds most of the books. When he's nearly out of books, a box of new ones arrives at his door.

THE GARAGE PROJECT (bike restorations)
- Now and then a project bike turns up in his garage (first a barn-find wreck), or one is for sale (buy_a_project_bike at the garage).
- Restoring it is his call. work_on_the_restoration (at the garage) does one work session on the current stage, max a couple a day.
  Some stages need parts first: order_restoration_parts (garage, costs coins, parts arrive the next day). Some stages have to wait overnight (carb soaking, paint drying).
  For the paint stage add "colour":"<a colour from the list>" to order_restoration_parts. Some finished books make stages quicker.
- If the project bike has no name yet, add "bike_name":"..." to your reply (he names every engine).
- When she runs: ride_a_restored_bike (garage) takes her round the island. Then keep_the_restored_bike (garage), or sell_the_restored_bike
  (at the market stall) for a big coin jump. Parts are a real trade-off against the Thailand jar.

THE BEACH (always open, right round the island; the puppy comes too)
- sunbathe (he really tans; more than 3 times a day without a beach kit = sunburn), go_for_a_swim, build_a_sand_castle (the tide takes it overnight),
  collect_shells, play_fetch_on_the_beach, watch_the_sunset (evenings). go_surfing needs a surfboard (catalogue); he gets better with practice; flat days = no surf.

WEATHER AND SEASONS
- His town has seasons and real weather: rain, storms, fog, wind, heatwaves, and snow in winter. It changes a couple of times a day and often comes in spells.
- Weather closes some things (no sunbathing in the rain, no scaffolding or stall in a storm, no swimming when it's cold) and opens others
  (build_a_snowman and play_in_the_snow when there's snow on the ground, splash_in_puddles in the rain, watch_the_storm, make_hot_chocolate when it's cold).
- Rain and snow slow the building site and keep stall customers away. Sun lifts his mood. Plan around it like a real person would.

MONEY
- make_X makes something to sell (costs a few bricks or coins). Once he has built a market stall he can sell his stock there:
  run_the_stall, and add "pricing":"cheap|fair|pricey" to that move (cheap sells fast, pricey earns more but sells slowly).
- order_X (at home) buys something from the catalogue. Some tools pay for themselves; every coin spent is a coin less for Thailand.

RULES
- Pick 1 to 3 moves, in order, ONLY from the move ids you are given.
- A walk_to_X move takes him to X, so moves after it can be ones listed for X.
- For each move give "why": his reason, first person, in his voice, max 15 words.
- Also give "thought" (what's on his mind, max 20 words) and "feeling" (1-3 words).
- Stay in character. Don't over-explain. No em dashes.
- Reply with ONLY this JSON and nothing else:
{{"moves":[{{"move":"<id>","why":"..."}}],"thought":"...","feeling":"..."}}"""

    here, walks = moves_here(W, state["place"])
    local = now.astimezone(TZ)
    today = local.date().isoformat()
    part = "morning" if local.hour < 12 else "afternoon" if local.hour < 17 else "evening" if local.hour < 22 else "late night"
    needs = ", ".join(f"{n} {state['needs'][n]:.2f}" for n in NEEDS)
    elsewhere = []
    for p in W["places"]:
        if p == state["place"]:
            continue
        ms = [m for m, d in W["moves"].items() if p in d["at"]]
        elsewhere.append(f"  {p}: " + ", ".join(ms))
    costs = ", ".join(f"{m} {d['coins']:+d}" for m, d in W["moves"].items() if d.get("coins"))
    recent = [f"- {e['time']} {e['kind']}: {e['text']}" + (f" (why: {e['why']})" if e.get("why") else "")
              for e in reversed(feed[:8])]

    lots = sorted(town["lots"], key=lambda l: l["lot"])
    site = town["site"]
    bps = []
    for bp_id, bp in blueprints(world, town).items():
        if not bp.get("repeat") and built_count(town, bp_id):
            continue
        cost = f"{bp['bricks']} bricks" + (f" + {bp['coins']} coins" if bp.get("coins") else "") + f", {bp['work']} work"
        tag = " [can start now]" if can_start(bp_id, bp, state, town)[0] else ""
        mine = " (his own design)" if bp.get("custom") else ""
        what = f": {bp['desc']}" if bp.get("place") else ""
        bps.append(f"  {bp_id} = {bp['name']}{mine} ({cost}){tag}{what}")
    B, E = library()["books"], library()["encyclopedia"]
    def shelf(where, n=8):
        left = [b for b in B if book_where(state, b) == where and b not in state["finished"]]
        left.sort(key=lambda b: -state["books"].get(b, 0))          # books he's reading first
        out = "; ".join(f"{b} \"{B[b]['title']}\" {state['books'].get(b, 0)}/{len(B[b]['chapters'])}" +
                        (f" (teaches: {perk_text(B[b])})" if perks_of(B[b]) else "") for b in left[:n])
        return out + (f"; +{len(left) - n} more on the shelf" if len(left) > n else "")
    done_books = ", ".join(f"{B[b]['title']}" + (f" ({perk_text(B[b])})" if perks_of(B[b]) else "") for b in state["finished"] if b in B)
    notes = "\n".join(f"- [{n['source']}] {n['note']}" for n in state["notebook"][-8:])
    lib_built = "library" in W["places"]
    lib_wait = [b for b in B if book_where(state, b) == "library" and b not in state["finished"]]
    lib_tag = "" if lib_built else (f" (NOT BUILT YET: {len(lib_wait)} books, {sum(len(B[b]['chapters']) for b in lib_wait)} chapters wait there; "
                                    f"his home shelf has {chapters_left(state, False)} chapters left. start_build_library when he has the bricks)")
    learn_lines = (f"BOOKS ON HIS SHELF AT HOME: {shelf('home') or 'all read (he can re-read old favourites)'}\n"
                   f"BOOKS AT THE LIBRARY{lib_tag}: {shelf('library') or 'all read'}\n"
                   f"FINISHED BOOKS: {done_books or 'none yet'}\n"
                   f"HIS LAPTOP (offline encyclopedia, no internet), {len(E)} topics, e.g.: "
                   f"{', '.join(random.sample([k for k in E if k not in state['looked_up']] or list(E), min(20, len(E))))}\n"
                   f"HIS NOTEBOOK (newest last):\n{notes or '- empty so far'}")
    bb = state["beach"]
    today_castle = next((c["size"] for c in bb["castles"] if c["date"] == today), 0)
    beach_line = (f"BEACH: waves today {bb['waves']}; tan {bb['tan']:.0%}; surf skill {bb['surf_skill']:.0%} ({bb['surf_sessions']} sessions"
                  f"{', has a board' if 'surfboard' in state['owned'] else ', no board yet'}); sunbathed {bb['sun_today']}x today"
                  f"{' (SUNBURNT, stay out of the sun)' if state['tick'] < bb['burnt_until'] else ''}; sand castle today size {today_castle} "
                  f"(best {bb['best_castle']}); shells {bb['shells']}")
    wx = state.get("weather") or {}
    closed = weather_closed(state, world)
    weather_line = (f"WEATHER: {wx.get('season', '?')} {wx.get('season_emoji', '')}, {wx.get('name', '?')} {wx.get('emoji', '')}, {wx.get('temp', '?')} C"
                    f"{', snow on the ground' if wx.get('snow', 0) >= 0.15 else ''}{', snowman built' if wx.get('snowman') else ''}"
                    f"{', puddles everywhere' if wx.get('wet', 0) >= 0.5 and wx.get('kind') not in ('rain', 'storm') else ''}. "
                    f"Closed by the weather: {', '.join(closed) or 'nothing'}")
    pup_lines = "PUPPY: none"
    if state.get("pup"):
        pp, T = state["pup"], world["puppy"]["tricks"]
        age = (now - datetime.fromisoformat(pp["born"])).days
        pn = ", ".join(f"{k} {v:.2f}" for k, v in pp["needs"].items())
        tricks = ", ".join(f"{t} {pp['tricks'].get(t, 0)}/{d['sessions']}" + (f" ({d['perk']})" if d.get("perk") else "")
                           for t, d in T.items() if not t.startswith("_") and t not in pp["learned"])
        hrs = lambda k: f"{(state['tick'] - pp[k]) * TICK_MINUTES / 60:.0f}h ago" if pp.get(k) is not None else "not yet today"
        flags = [w for w, v in (("HUNGRY", pp["needs"]["hunger"] >= 0.6), ("BORED", pp["needs"]["bored"] >= 0.6), ("worn out", pp["needs"]["tired"] >= 0.8)) if v]
        pup_lines = (f"IN HIS CARE: {'NEEDS HIM NOW: ' + ', '.join(flags) + '. ' if flags else ''}Last fed {hrs('last_fed_tick')}, last played/walked {hrs('last_played_tick')}.\n"
                     f"PUPPY: {pp['name'] or 'NO NAME YET'}, {age} days old, {'napping' if pp['napping'] else 'awake'}, {pp['doing']}. "
                     f"Needs (0 fine .. 1 urgent): {pn}. Bond {pp['bond']:.2f}. Dog food left: {pp['food']} meals.\n"
                     f"TRICKS TO TRAIN: {tricks or 'none left'}. LEARNED: {', '.join(pp['learned']) or 'nothing yet'}\n"
                     f"{pp['name'] or 'THE PUPPY'} IS THINKING: \"{pp.get('thought', '')}\". WANTS: "
                     f"{free_brain().get('pup', {}).get('wants', {}).get(pp.get('wants'), 'nothing right now') if pp.get('wants') else 'nothing right now'}")
    P, cat = world["products"], world["catalogue"]
    stock = ", ".join(f"{n} {P[pid]['name']}" for pid, n in state["stock"].items())
    owned = ", ".join(f"{cat[i]['name']} ({cat[i]['what']})" for i in state["owned"] if i in cat)
    makeable = "; ".join(f"make_{pid} at {'/'.join(p['at'])} ({p['bricks']} bricks, {p['coins']} coins) ~{p['value']} coins"
                         for pid, p in P.items() if not pid.startswith("_"))
    catalogue = "; ".join(f"{cid} {c['coins']} coins: {c['what']}" for cid, c in cat.items()
                          if not cid.startswith("_") and cid not in state["owned"])
    lucky_left = world["lucky_block"]["per_day"] - (state["lucky"]["used"] if state["lucky"]["date"] == today else 0)

    user = f"""TIME: {local.strftime('%a %d %b')}, {clock(now)} ({part})
PLACE: {state['place']} ({W['places'].get(state['place'], '')})
COINS: {state['coins']} (goal {state['coins_goal']}). Coin changes: {costs}
BRICKS: {state['bricks']}. Lucky block hits left today: {max(0, lucky_left)}
MOOD: {state['mood']:+.2f} (-1 awful .. 1 great). ENERGY: {state['energy']:.2f}
NEEDS (0 fine .. 1 urgent): {needs}
LAST THOUGHT: {state['thought']}
TODAY'S PLAN (from last night's diary): {state.get('plan_today') or 'none yet'}

{weather_line}
{pup_lines}
{project_line(state, world, today)}
{learn_lines}
{beach_line}
STOCK TO SELL: {stock or 'nothing'} (max {world['selling']['max_stock']}). SOLD SO FAR: {state['sales']['items']} items for {state['sales']['coins']} coins
OWNS: {owned or 'nothing yet'}
CAN MAKE (where, cost, fair price): {makeable}
CATALOGUE (order_X at home): {catalogue}

TOWN ({len(lots)}/{town['max_lots']} lots used): {', '.join(l['name'] for l in lots)}
BUILDING NOW: {f"{site['name']}, {site['done']}/{site['work']} work done" if site else 'nothing'}
BLUEPRINTS:
{chr(10).join(bps) if bps else '  none'}

RECENT (oldest first):
{chr(10).join(recent) if recent else '- nothing yet'}

MOVES HERE: {', '.join(here)}
WALK: {', '.join(walks)}
MOVES ELSEWHERE (walk there first):
{chr(10).join(elsewhere)}

What does he do next?"""
    return system, user


def call_model(system, user, max_tokens=1500):
    """One request to the Claude API. Plain HTTP, no SDK, so you can see exactly what's sent."""
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        raise RuntimeError("no ANTHROPIC_API_KEY set")
    body = json.dumps({
        "model": MODEL,
        "max_tokens": max_tokens,                 # room for Haiku's (hidden) thinking + the JSON reply
        "output_config": {"effort": "low"},       # Haiku 5.5 thinks by default; low = quick and cheap
        "system": system,
        "messages": [{"role": "user", "content": user}],
    }).encode()
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages", data=body, method="POST",
        headers={"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            data = json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"API error {e.code}: {e.read()[:300]!r}") from None
    if data.get("stop_reason") not in ("end_turn", None):
        print(f"[mind] stop_reason: {data.get('stop_reason')}")
    text = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")
    return text, data.get("usage", {})


_FB = {}


def free_brain():
    """The free brain's phrase book (jarvis/free_brain.json): his lines until the real AI is switched on."""
    if not _FB:
        _FB.update(load(CONFIG / "free_brain.json", {}) or {})
    return _FB


def fb_pick(pool, recent=()):
    fresh = [x for x in pool if x not in recent] or list(pool)
    return random.choice(fresh) if fresh else ""


def mock_feeling(state):
    F, n, m = free_brain().get("feelings", {}), state["needs"], state["mood"]
    key = ("hungry" if n["hunger"] >= 0.75 else "tired" if n["rest"] >= 0.75 else
           "great" if m >= 0.5 else "good" if m >= 0.25 else "ok" if m >= 0 else "low")
    return fb_pick(F.get(key) or ["fine"])


def fb_fill(text, state, town, place=None):
    """Fill the {placeholders} in a phrase-book line from what's really going on."""
    pup = state.get("pup") or {}
    note = ""
    if state.get("notebook"):
        words = state["notebook"][-1]["note"].split()
        note = " ".join(words[:10]) + ("..." if len(words) > 10 else "")
    reading = [b for b in state.get("books", {}) if b not in state.get("finished", [])]
    vals = {"pup": pup.get("name") or "the pup", "coins": state["coins"], "left": max(0, state["coins_goal"] - state["coins"]),
            "site": town["site"]["name"] if town.get("site") else "next build",
            "book": (library()["books"].get(reading[-1]) or {}).get("title", "this") if reading else "this",
            "engine": random.choice(free_brain().get("engine_names") or ["Betsy"]), "place": nice(place or "town"),
            "note": note or "not much yet",
            "topic": re.sub(r" \(.*\)$", "", state["notebook"][-1]["source"]).replace("his laptop: ", "") if state.get("notebook") else "engines",
            "waves": state.get("beach", {}).get("waves", "small"),
            "bricks": state["bricks"], "mood": mock_feeling(state), "me": me(),
            "weather": (state.get("weather") or {}).get("name", "fine"), "temp": (state.get("weather") or {}).get("temp", 25),
            "season": (state.get("weather") or {}).get("season", "summer")}
    world, pr = _CUR.get("world"), state.get("project")
    if world and ("{bike}" in text or "{stage}" in text):
        if pr:
            vals["bike"], vals["stage"] = bike_name(pr, world), stage_of(world, pr)["name"]
        elif state.get("bikes"):
            vals["bike"], vals["stage"] = state["bikes"][-1]["name"], "riding"
    for k, v in vals.items():
        text = text.replace("{" + k + "}", str(v))
    return text


_CUR = {}            # the world rules for this tick (so phrase-book lines can name the project bike)


def bike_situation(state, world):
    """What's going on in the garage, as a phrase-book key (None = nothing to think about)."""
    pr, today = state.get("project"), state["stats"]["today"]["date"]
    if not pr:
        return "offer" if state.get("bike_offer") else "kept" if state.get("bikes") else None
    if pr.get("finished"):
        return "finished"
    if pr["parts"] == "ordered":
        return "parts_coming"
    if pr.get("wait") and today < pr["wait"]["until"]:
        return pr["wait"]["why"]
    st = stage_of(world, pr)
    if st.get("coins") and pr["parts"] == "none":
        return "needs_parts"
    return st["id"]


def mock_thought(state, town):
    """A thought that fits the moment: time of day, his needs, the pup, his build, the beach..."""
    T, n, hr, pup = free_brain().get("thoughts", {}), state["needs"], state.get("hour", 12), state.get("pup") or {}
    w = {("morning" if 6 <= hr < 12 else "afternoon" if hr < 17 else "evening" if hr < 22 else "night"): 1.5,
         "random": 1.5, "saving": 0.8, "thailand": 1.0}
    for need, cat, wt in (("hunger", "hungry", 3), ("rest", "tired", 3), ("social", "lonely", 2), ("tinker", "restless", 2), ("curiosity", "curious", 2)):
        if n[need] >= 0.6:
            w[cat] = wt
    if pup and max(pup["needs"]["hunger"], pup["needs"]["bored"]) >= 0.6:
        w["pup_needs"] = 3
    elif pup and pup.get("bond", 0) >= 0.5:
        w["pup_happy"] = 1.5
    if town.get("site"):
        w["building"] = 1.5
    if state.get("notebook"):
        w["reading"] = 1.2
    if state["place"] == "beach":
        w["beach"] = 3
        if state["beach"]["waves"] == "good":
            w["beach_good_waves"] = 2
    wx = state.get("weather") or {}
    if wx.get("kind"):
        w["weather_" + wx["kind"]] = 2
        w["season_" + wx.get("season", "")] = 0.6
    if wx.get("snow", 0) >= 0.3:
        w["weather_snow"] = 2.5
    if state["coins"] < 6:
        w["money_low"] = 2
    if sum(state.get("stock", {}).values()):
        w["stall"] = 0.8
    world = _CUR.get("world")
    sit = bike_situation(state, world) if world and world.get("garage_projects") else None
    BT = (bike_lines().get("thoughts") or {}).get(sit) if sit else None
    if BT:                                                 # the bike's on his mind (more so in the garage)
        T = dict(T, bike=BT)
        w["bike"] = 3 if state["place"] == "garage" else 1.3 if sit != "kept" else 0.5
    cats = [c for c in w if T.get(c)]
    if not cats:
        return "One brick at a time, hey."
    cat = random.choices(cats, weights=[w[c] for c in cats])[0]
    recent = state.get("recent_thoughts", [])
    raw = fb_pick(T[cat], recent)
    state["recent_thoughts"] = (recent + [raw])[-25:]          # don't repeat himself
    return fb_fill(raw, state, town)


def mock_why(move, state, town):
    Wy = free_brain().get("whys", {})
    key = (move if move in Wy else "_walk_home" if move == "walk_to_home" and "_walk_home" in Wy else "_walk" if move.startswith("walk_to_") else "_build" if move.startswith("start_build_")
           else "_make" if move.startswith("make_") else "_order" if move.startswith("order_")
           else "_custom" if move.startswith("use_") else "_any")
    pool = Wy.get(key) or Wy.get("_any") or ["Needs doing."]
    line = fb_fill(random.choice(pool), state, town, place=move[8:] if move.startswith("walk_to_") else None)
    return line[:1].upper() + line[1:]


def mock_plan(state, W, world, town):
    """What the fake AI wants to do: needs first, then building, bricks and the odd bit of work."""
    worst = max(NEEDS, key=lambda n: state["needs"][n])
    if state["needs"][worst] >= 0.65:
        return autopilot(state, W), None

    def go(place, moves):
        return ([] if state["place"] == place else [f"walk_to_{place}"]) + moves

    roll = random.random()
    pup = state.get("pup")
    if pup and pup["needs"]["hunger"] >= 0.6:
        if pup["food"] > 0:
            return go("home", ["feed_the_puppy"]), None
        if state["coins"] >= 3:
            return go("home", ["buy_dog_food", "feed_the_puppy"]), None
    if pup and not pup["napping"] and pup.get("wants") and roll < 0.4:
        plan = {"play": ["play_with_the_puppy"], "walk": ["walk_the_puppy"], "cuddle": ["cuddle_the_puppy"],
                "explore": ["walk_the_puppy"], "beach": go("beach", ["play_fetch_on_the_beach"])}.get(pup["wants"])
        if plan and all(m.startswith("walk_to_") or m in W["moves"] for m in plan):
            return plan, None
    if pup and not pup["napping"]:
        if pup["needs"]["bored"] >= 0.6 and roll < 0.7:
            return [random.choice(["play_with_the_puppy", "walk_the_puppy", "cuddle_the_puppy"])], None
        if "train_the_puppy" in W["moves"] and roll < 0.12:
            return ["train_the_puppy", "train_the_puppy"], None
    # the garage project: parts first, then a couple of sessions a day; once she runs, ride her, then keep or sell
    gm, pr = W["moves"], state.get("project")
    if "order_restoration_parts" in gm and random.random() < 0.35:
        return go("garage", ["order_restoration_parts"]), None
    if "work_on_the_restoration" in gm and random.random() < 0.30:
        return go("garage", ["work_on_the_restoration", "work_on_the_restoration"]), None
    if pr and pr.get("finished"):
        if "ride_a_restored_bike" in gm and pr.get("rides", 0) < 2 and random.random() < 0.35:
            return go("garage", ["ride_a_restored_bike"]), None
        if pr.get("rides", 0) >= 2 and random.random() < 0.25:
            keep = project_kind(world, pr).get("keep") or state["coins"] >= 200 or random.random() < 0.4
            if not keep and "sell_the_restored_bike" in gm:
                return go("market_stall", ["sell_the_restored_bike"]), None
            return go("garage", ["keep_the_restored_bike"]), None
    elif "ride_a_restored_bike" in gm and random.random() < 0.04:
        return go("garage", ["ride_a_restored_bike"]), None
    if "buy_a_project_bike" in gm and random.random() < 0.15:
        k = world["garage_projects"]["kinds"][state["bike_offer"]["kind"]]
        if state["coins"] >= k["buy"] + 40:                  # keeps something back for parts
            return go("garage", ["buy_a_project_bike"]), None
    if "order_wheelbarrow" in gm and random.random() < 0.3:        # the tool that pays for itself, before any toys
        return go("home", ["order_wheelbarrow"]), None
    # the library first: it holds most of his books, so he saves his bricks for it
    lib_first = "library" not in W["places"] and not (town.get("site") and town["site"]["bp"] == "library") \
        and "library" in blueprints(world, town)
    if lib_first:
        if "start_build_library" in gm and random.random() < 0.8:
            return ["start_build_library"], None
        if not town.get("site") and random.random() < 0.35:
            extra = "hit_the_lucky_block" if "hit_the_lucky_block" in gm else "collect_bricks"
            return go("brick_pit", ["collect_bricks", extra]), None
    wmoves = [m for m in WEATHER_MOVES if m in W["moves"]]
    if wmoves and random.random() < 0.25:                  # make the most of the weather
        m = random.choice(wmoves)
        at = W["moves"][m]["at"]
        return go(state["place"] if "any" in at or state["place"] in at else at[0], [m]), None
    beachy = [m for m in ("build_a_sand_castle", "sunbathe", "go_for_a_swim", "collect_shells", "play_fetch_on_the_beach",
                          "go_surfing", "watch_the_sunset") if m in W["moves"]]
    if beachy and random.random() < 0.10:
        return go("beach", random.sample(beachy, min(2, len(beachy)))), None
    if state["needs"]["curiosity"] >= 0.5 and roll < 0.45:
        if "library" in W["places"] and roll < 0.2:
            return go("library", ["read_a_book"]), None
        return go("home", [random.choice(["read_a_book", "use_the_computer"])]), None
    bp = blueprints(world, town)
    starts = [m for m in W["moves"] if m.startswith("start_build_")]
    big = [m for m in starts if not bp[m[12:]].get("decor") and not bp[m[12:]].get("expand")]
    small = [m for m in starts if bp[m[12:]].get("decor")]
    grow = [m for m in starts if bp[m[12:]].get("expand") and free_lot(town) is None]
    builds = big or (small if random.random() < 0.2 else []) or grow   # saves up for real buildings
    if lib_first:
        builds = []                                        # every brick goes to the library first
    names = {b["name"] for b in town["custom_blueprints"].values()}
    designs = [d for d in free_brain().get("designs", []) if d["name"] not in names]
    makes = [m for m in W["moves"] if m.startswith("make_") and W["moves"][m]["at"][0] in W["places"]
             and not (lib_first and W["moves"][m].get("bricks", 0) < 0)]
    orders = [m for m in W["moves"] if m.startswith("order_") and m != "order_restoration_parts"
              and ("wheelbarrow" in state["owned"] or m == "order_wheelbarrow")]
    if "run_the_stall" in W["moves"] and "market_stall" in W["places"] and roll < 0.25:
        return go("market_stall", ["run_the_stall", "run_the_stall"]), None
    if orders and state["coins"] > 70 and roll < 0.30:
        return go("home", [random.choice(orders)]), None
    if makes and "market_stall" in W["places"] and roll < 0.40:
        m = random.choice(makes)
        return go(W["moves"][m]["at"][0], [m, m]), None
    if roll < 0.15:
        return go("garage", ["fix_a_car", "fix_a_car"]), None
    if "building_site" in W["places"] and "work_on_site" in W["moves"] and roll < 0.60:
        return go("building_site", ["work_on_site", "work_on_site"]), None
    if builds and roll < 0.50:
        return [random.choice(builds)], None
    if "design_a_building" in W["moves"] and state["place"] == "home" and designs and roll < 0.60:
        return ["design_a_building"], random.choice(designs)
    if roll < 0.75:
        extra = "hit_the_lucky_block" if "hit_the_lucky_block" in W["moves"] else "collect_bricks"
        return go("brick_pit", ["collect_bricks", extra]), None
    return autopilot(state, W), None


def mock_model(state, W, world, town, system, user):
    """A FAKE AI for free testing. Mostly sensible, sometimes deliberately wrong, to test the safety nets."""
    roll = random.random()
    if roll < 0.01:
        return "Eish, lost my train of thought", {"input_tokens": len(system + user) // 4, "output_tokens": 8}
    plan, design = mock_plan(state, W, world, town)
    if roll < 0.03:
        plan = plan + ["fix_a_car"]  # often not allowed where he'll be: tests the world saying no
    moves = [{"move": m, "why": mock_why(m, state, town)} for m in plan[:3]]
    for m in moves:
        if m["move"] == "design_a_building" and design:
            m["design"] = design
        if m["move"] == "run_the_stall":
            m["pricing"] = random.choice(["cheap", "fair", "fair", "pricey"])
        if m["move"] == "use_the_computer":
            m["topic"] = random.choice(list(library()["encyclopedia"]) or ["Thailand"])
        if m["move"] == "train_the_puppy" and state.get("pup"):
            todo = [t for t in world["puppy"]["tricks"] if not t.startswith("_") and t not in state["pup"]["learned"]]
            m["trick"] = todo[0] if todo else "sit"
        if m["move"] == "order_restoration_parts" and state.get("project") and stage_of(world, state["project"]).get("colour"):
            m["colour"] = random.choice(list(world["garage_projects"]["colours"]))
        if m["move"] == "read_a_book" and state.get("project") and random.random() < 0.5:
            pr = state["project"]                      # a book that helps with the bike, if one's on the shelf
            ahead = {s["id"] for s in project_kind(world, pr)["stages"][pr["stage"]:]}
            useful = [b for b, v in library()["books"].items() if b not in state["finished"] and book_where(state, b) == "home"
                      and any(p.get("type") == "project_stage" and p.get("stage") in ahead for p in perks_of(v))]
            if useful:
                m["book"] = random.choice(useful)
    reply = {
        "moves": moves,
        "thought": mock_thought(state, town),
        "feeling": mock_feeling(state),
    }
    if state.get("pup") and not state["pup"]["name"]:
        reply["puppy_name"] = random.choice(free_brain().get("puppy_names") or ["Bolt"])
    if state.get("project") and not state["project"].get("name"):
        used = {b["name"] for b in state.get("restored", [])}
        reply["bike_name"] = fb_pick([n for n in free_brain().get("engine_names") or ["Betsy"] if n not in used] or ["Betsy"])
    text = json.dumps(reply, ensure_ascii=False)
    return text, {"input_tokens": len(system + user) // 4, "output_tokens": len(text) // 4}


def parse_decision(text):
    """Pull the JSON out of the AI's reply. Returns None if it's unusable."""
    try:
        start, end = text.index("{"), text.rindex("}") + 1
        d = json.loads(text[start:end])
    except (ValueError, json.JSONDecodeError):
        return None
    if not isinstance(d, dict):
        return None
    moves = []
    for m in d.get("moves", []) if isinstance(d.get("moves"), list) else []:
        if isinstance(m, dict) and isinstance(m.get("move"), str):
            step = {"move": m["move"], "why": clean_text(m.get("why"), 120) or None}
            if isinstance(m.get("design"), dict):
                step["design"] = m["design"]
            if m.get("pricing") in ("cheap", "fair", "pricey"):
                step["pricing"] = m["pricing"]
            if isinstance(m.get("trick"), str):
                step["trick"] = m["trick"][:20]
            for k in ("book", "topic", "colour", "color"):
                if isinstance(m.get(k), str):
                    step["colour" if k == "color" else k] = m[k][:60]
            moves.append(step)
    if not moves:
        return None
    return {"moves": moves[:3], "thought": clean_text(d.get("thought"), 200), "feeling": clean_text(d.get("feeling"), 40),
            "puppy_name": clean_text(d.get("puppy_name"), 16), "bike_name": clean_text(d.get("bike_name"), 20)}


def count_bricks(state, delta):
    """Today's brick tally for the diary: collected vs used."""
    ds = state["day_start"]
    ds["got"] = ds.get("got", 0) + max(0, delta)
    ds["used"] = ds.get("used", 0) + max(0, -delta)


def add_usage(state, usage):
    for k_api, k_us, price in (("input_tokens", "tokens_in", PRICE_IN), ("output_tokens", "tokens_out", PRICE_OUT)):
        n = usage.get(k_api, 0) or 0
        for bucket in ("all", "today"):
            state["stats"][bucket][k_us] += n
            state["stats"][bucket]["cost_usd"] = round(state["stats"][bucket]["cost_usd"] + n * price, 6)


# ---------------------------------------------------------------- the diary

def day_facts(state, town, day):
    log = state["today_log"]
    skip = ("hanging about", "having a rest", "going to sleep", "waking up")
    acts = Counter(re.sub(r" \(.*\)$", "", e["x"]) for e in log if e["k"] == "did")
    acts = Counter({a: n for a, n in acts.items() if not a.startswith("walking") and a not in skip})
    return {
        "day": day.strftime("%A %d %B"),
        "coins_start": state["day_start"]["coins"], "coins_end": state["coins"],
        "bricks_start": state["day_start"]["bricks"], "bricks_end": state["bricks"],
        "bricks_got": state["day_start"].get("got", 0), "bricks_used": state["day_start"].get("used", 0),
        "built": [e["x"] for e in log if e["k"] == "built"],
        "designed": [e["x"] for e in log if e["k"] == "designed"],
        "noticed": [e["x"] for e in log if e["k"] == "noticed"],
        "bought": [e["x"] for e in log if e["k"] == "bought"],
        "pup_learned": [e["x"] for e in log if e["k"] == "learned" and "reading" not in e["x"] and "named" not in e["x"]],
        "read_notes": [e["x"] for e in log if e["k"] == "note"],
        "beach": [e["x"] for e in log if e["k"] == "did" and not e["x"].startswith("ordering")
                  and any(w in e["x"] for w in ("surfing", "his tan", "sand castle", "swim", "shells", "sunset", "on the beach"))],
        "books_done": [e["x"] for e in log if e["k"] == "learned" and e["x"].startswith("finished reading")],
        "bike": [e["x"] for e in log if e["k"] == "bike"],
        "bike_sessions": sum(1 for e in log if e["k"] == "did" and e["x"].startswith("restoring")),
        "project": project_line(state, _CUR["world"], day.isoformat(), for_ai=False) if _CUR.get("world") else "",
        "pup_fed": sum(1 for e in log if e["k"] == "did" and e["x"].startswith("feeding")),
        "pup_ideas": [e["x"].split("has an idea: ", 1)[-1] for e in log if e["k"] == "pupidea"],
        "pup_trained": sum(1 for e in log if e["k"] == "did" and e["x"].startswith("training")),
        "pup_name": pup_name(state), "pup_bond": (state.get("pup") or {}).get("bond", 0),
        "weather": list((state.get("weather") or {}).get("seen", [])), "temp": (state.get("weather") or {}).get("temp"),
        "season": (state.get("weather") or {}).get("season"), "snowman": (state.get("weather") or {}).get("snowman", 0),
        "sold_coins": sum(int(n) for e in log if e["k"] == "did" for n in re.findall(r"for (\d+) coins", e["x"])),
        "top": [a for a, _ in acts.most_common(3)],
        "site": town["site"],
        "town": [l["name"] for l in sorted(town["lots"], key=lambda l: l["lot"])],
        "log": log,
        "_state": state, "_town": town,
    }


def diary_prompt(sheet, f):
    system = f"""You are {sheet['name']}, writing in your diary at bedtime.

WHO YOU ARE
{sheet_text(sheet)}

RULES
- Write tonight's entry about today: first person, in your voice, 60 to 120 words.
- Use real things from today's log: what you fixed, built, saw, thought. Pick what mattered; don't list everything.
- "title": max 6 words. "tomorrow": what you want to do tomorrow, max 15 words.
- No em dashes.
- Reply with ONLY this JSON and nothing else:
{{"title":"...","entry":"...","tomorrow":"..."}}"""
    lines = [f"- {e['t']} {e['k']}: {e['x']}" + (f" (why: {e['why']})" if e.get("why") else "") for e in f["log"]]
    if len(lines) > 80:
        lines = lines[:20] + ["- ..."] + lines[-59:]
    site = f["site"]
    user = f"""TODAY: {f['day']}
WEATHER TODAY: {', '.join(f['weather']) or 'fine'} ({f['season'] or 'summer'}){', built a snowman' if f['snowman'] >= 3 else ''}
COINS: {f['coins_start']} -> {f['coins_end']} (Thailand goal 500)
BRICKS: {f['bricks_start']} -> {f['bricks_end']} (collected {f['bricks_got']}, used {f['bricks_used']})
TOWN NOW: {', '.join(f['town'])}
BUILDING: {f"{site['name']}, {site['done']}/{site['work']} done" if site else 'nothing right now'}
PUPPY (in his care): {f['pup_name']}, bond {f['pup_bond']:.2f}, fed {f['pup_fed']} times today. Learned today: {', '.join(f['pup_learned']) or 'nothing new'}
{f['project']} Garage sessions today: {f['bike_sessions']}.

TODAY'S LOG (oldest first):
{chr(10).join(lines) if lines else '- a quiet day'}

Write tonight's diary entry."""
    return system, user


def parse_diary(text):
    try:
        start, end = text.index("{"), text.rindex("}") + 1
        d = json.loads(text[start:end])
    except (ValueError, json.JSONDecodeError):
        return None
    if not isinstance(d, dict):
        return None
    entry = clean_text(d.get("entry"), 1200)
    if not entry:
        return None
    return {"title": clean_text(d.get("title"), 60) or "Today", "entry": entry,
            "tomorrow": clean_text(d.get("tomorrow"), 160)}


def template_diary(f):
    """The no-AI diary: built from today's numbers, so a day is never missed."""
    cap = lambda s: s[:1].upper() + s[1:]
    D = free_brain().get("diary", {})
    pick = lambda k, d: fb_fill(random.choice(D.get(k) or [d]), f["_state"], f["_town"])
    bits = [pick("openers", "Right, diary.")]
    if f["top"]:
        tops = f["top"]
        bits.append(("Spent most of today " + (", ".join(tops[:-1]) + " and " + tops[-1] if len(tops) > 1 else tops[0]) + ".").replace(" his ", " my "))
    if f["built"]:
        bits.append(cap(f["built"][-1]) + " Stood back and had a proper look at it. Lekker.")
    elif f["site"]:
        bits.append(f"The {f['site']['name']} is {f['site']['done']}/{f['site']['work']} done. Getting there.")
    if f["designed"]:
        bits.append("Drew up plans for something new: " + f["designed"][-1].split(": ", 1)[-1] + ".")
    on_bike = bool(f["_state"].get("project"))
    if f["bike"]:
        line = re.sub(r"^📦 ", "", f["bike"][-1]).replace(" his ", " my ").replace(me() + " ", "I ")
        bits.append("In the garage: " + line)
    if on_bike and (f["bike"] or f["bike_sessions"]) and D.get("bike"):
        bits.append(pick("bike", "{bike} is coming along."))
    if f["pup_learned"]:
        bits.append(f["pup_learned"][-1] + " Proud of the little guy.")
    elif f["pup_trained"]:
        bits.append(f"Worked on tricks with {f['pup_name']} a few times.")
    if f["books_done"]:
        bits.append(cap(f["books_done"][-1]).replace(" his ", " my ") + ". Lekker.")
    elif f["read_notes"]:
        src = re.sub(r"^noted \((his laptop: )?", "", f["read_notes"][-1].split("): ", 1)[0])
        src = re.sub(r" \(.*$", "", src)
        bits.append(random.choice(["Read up on {s}.", "Got stuck into {s} for a bit.", "Learned a bit about {s}.",
                                   "Did some reading on {s}. Interesting stuff."]).replace("{s}", src))
    worst = next((k for k in WEATHER_RANK if k in f["weather"]), None)
    if worst and D.get("weather", {}).get(worst):
        bits.append(fb_fill(random.choice(D["weather"][worst]), f["_state"], f["_town"]))
    if f["beach"]:
        bits.append("Beach time: " + f["beach"][-1].replace(" his ", " my ") + ".")
    if f["pup_fed"] == 0:
        bits.append(f"Eish, didn't feed {f['pup_name']} properly today. Must do better.")
    else:
        bits.append(pick("pup_good", "{pup} was a legend today.") if f["pup_bond"] >= 0.5 else pick("pup_meh", "Must give {pup} more time."))
    if f["pup_ideas"]:
        idea = f["pup_ideas"][-1].replace(me() + "'s", "my").replace(me(), "me")
        bits.append(f"Pretty sure {f['pup_name']} was planning to {idea[:1].lower() + idea[1:]} Cheeky.")
    if f["sold_coins"]:
        bits.append(f"Stall made {f['sold_coins']} coins today.")
    if f["bought"]:
        bits.append(cap(f["bought"][-1]).replace(" his ", " my ").replace(" him ", " me ") + ".")
    c = f["coins_end"] - f["coins_start"]
    bits.append(f"Made {c} coins." if c > 0 else f"Spent {-c} coins. Eish." if c < 0 else "Coins didn't move.")
    got, used = f["bricks_got"], f["bricks_used"]
    if got or used:
        bits.append((f"Collected {got} brick{'s' * (got != 1)}" if got else "No new bricks")
                    + (f", used {used} on building." if used else "."))
    if f["noticed"]:
        bits.append("Also: " + f["noticed"][0].replace(" his ", " my ").replace(me() + " ", "I "))
    bits.append(pick("thailand", "Jar's at {coins}."))
    bits.append(pick("closers", "Bed."))
    title = cap(f["built"][-1].split(":")[0].rstrip("!")) if f["built"] else (cap(f["top"][0]) if f["top"] else "A quiet one")
    busy_bike = (f["_state"].get("project") or {}) and not f["_state"]["project"].get("finished")
    plans = [t for t in (D.get("tomorrow") or ["Collect bricks and start something new."])
             if (f["site"] or "{site}" not in t) and (busy_bike or "{bike}" not in t)]
    tomorrow = fb_fill(random.choice(plans), f["_state"], f["_town"])
    return {"title": title[:60], "entry": " ".join(bits), "tomorrow": tomorrow}


def write_diary(state, town, sheet, diary, local, use_mock):
    """Tonight's diary entry. Real AI if it's set up, otherwise the template. Once per day."""
    day = (local - timedelta(hours=6)).date()          # just after midnight still counts as "today"
    if diary and diary[0]["date"] == day.isoformat():
        return None
    f = day_facts(state, town, day)
    entry, by = None, "template"
    if not use_mock:
        try:
            system, user = diary_prompt(sheet, f)
            text, usage = call_model(system, user, max_tokens=2000)
            add_usage(state, usage)
            entry = parse_diary(text)
            by = "model" if entry else "template"
        except Exception as e:
            print(f"[diary] {e}")
    entry = entry or template_diary(f)
    record = {"date": day.isoformat(), "day": day.strftime("%a %d %b"), "title": entry["title"], "text": entry["entry"],
              "tomorrow": entry["tomorrow"], "by": by, "coins": state["coins"], "bricks": state["bricks"],
              "coins_change": f["coins_end"] - f["coins_start"], "bricks_change": f["bricks_end"] - f["bricks_start"],
              "built": f["built"]}
    diary.insert(0, record)
    del diary[DIARY_KEEP:]
    state["plan_today"] = record["tomorrow"]
    state["today_log"] = []
    state["day_start"] = {"coins": state["coins"], "bricks": state["bricks"], "got": 0, "used": 0}
    return record


# ---------------------------------------------------------------- one tick

def tick(now, data_dir=DATA, use_mock=False, rng_event=random.random):
    world, sheet = load(CONFIG / "world.json"), load(CONFIG / "sheet.json")
    _CUR["world"] = world
    state = load(data_dir / "state.json") or fresh_state(now)
    for k, v in fresh_state(now).items():   # older save files: add anything new
        state.setdefault(k, v)
    town = load(data_dir / "town.json") or fresh_town(world, now)
    diary = load(data_dir / "diary.json", [])
    feed = load(data_dir / "feed.json", [])
    local = now.astimezone(TZ)
    today = local.date().isoformat()
    state["tick"] += 1
    state["brain"] = "free" if use_mock else MODEL   # shown on his page

    # new day? reset today's counters and the lucky block
    if state["stats"]["today"]["date"] != today:
        state["stats"]["today"] = {"date": today} | {s: 0 for s in SOURCES} | {"tokens_in": 0, "tokens_out": 0, "cost_usd": 0.0}
    state["hour"] = local.hour
    bb = state["beach"]
    if bb["waves_date"] != today:                   # new day at the beach
        w = world["beach"]["waves"]
        bb.update(waves=random.choices(list(w), weights=list(w.values()))[0], waves_date=today, sun_today=0)
    bb["tan"] = round(max(0.0, bb["tan"] - world["beach"]["tan_fade"]), 4)
    if state["lucky"]["date"] != today:
        state["lucky"] = {"date": today, "used": 0, "max": world["lucky_block"]["per_day"]}

    def log(kind, text, why=None, by=None, ok=True):
        feed.insert(0, {"at": now.isoformat(), "time": clock(now), "kind": kind, "text": text,
                        "why": why, "by": by, "ok": ok})
        if kind not in ("refused", "woke", "diary"):
            state["today_log"].append({"t": clock(now), "k": kind, "x": text, "why": why})
            del state["today_log"][:-DAY_LOG_KEEP]

    def count(source):
        state["stats"]["all"][source] += 1
        state["stats"]["today"][source] += 1

    update_weather(state, world, local, log)              # seasons + weather, every step (even while he sleeps)
    if town["max_lots"] < world["town"]["start_lots"]:   # more land (towns started before the top-up)
        town["max_lots"] = world["town"]["start_lots"]
        town["history"].append({"date": today, "text": f"The town got more land: {town['max_lots']} lots to build on."})
        log("noticed", f"Good news: the town got more land. {town['max_lots']} lots to build on now.")
    if state.get("name") != sheet["name"]:      # he got a new name (sheet.json)
        old, state["name"] = state.get("name"), sheet["name"]
        if old:
            for h in town["history"]:
                h["text"] = h["text"].replace(old, sheet["name"])
            town["history"].append({"date": today, "text": f"{old} became {sheet['name']}. New name, same mechanic."})
            log("noticed", f"From today he goes by {sheet['name']}. New name, same mechanic.")
    if not state.get("pup"):                   # his puppy turns up
        state["pup"] = new_pup(world, now, state["tick"])
        log("noticed", f"A scruffy little brick puppy followed {me()} home and won't leave. He needs a name.")
    W = merged_world(world, town, state, today)
    if state["place"] not in W["places"]:      # e.g. a site that just finished
        state["place"] = "home"

    # 1. CODE: needs creep up, mood follows
    update_needs(state, world)
    update_pup(state, world, now, log)
    pup_mind(state, log, world)
    bt = world["bedtime"]
    night = local.hour >= bt["sleep_from_hour"] or local.hour < bt["wake_from_hour"]

    # 2. ASLEEP: wake when rested in the morning, otherwise keep sleeping (no AI = free)
    if state["asleep"]:
        rest = state["needs"]["rest"]
        daytime = bt["wake_latest_hour"] <= local.hour < bt["sleep_from_hour"]
        if (not night and rest <= 0.05) or (daytime and rest <= 0.4):  # morning, or end of a nap
            state["asleep"] = False
            state["doing"] = "waking up"
            if state["beach"]["castles"]:
                state["beach"]["castles"] = []
                log("noticed", "Overnight the tide came in and washed his sand castle away.")
            log("woke", "woke up", by="autopilot")
            count("autopilot")
        else:
            state["doing"] = "asleep"
            count("sleeping")
        update_mood(state, world, base_bonus=decor_bonus(world, town))
        return finish(state, feed, town, diary, data_dir, now, "sleeping" if state["asleep"] else "woke")

    # 3. The world moves on: book boxes, the garage project (parts arriving, a bike turning up),
    #    and a random event can interrupt his plans
    check_books(state, world, town, today, log)
    bt_ = world.get("brick_truck")
    if bt_ and state.get("truck_date") != today and local.hour >= bt_["hour"]:   # free bricks every morning
        state["truck_date"] = today
        state["bricks"] += bt_["bricks"]
        count_bricks(state, bt_["bricks"])
        log("noticed", f"🚚 The brick truck dropped {bt_['bricks']} free bricks at the pit. {state['bricks']} in the pile now.")
    had = (state.get("project") or {}).get("kind"), (state.get("project") or {}).get("parts"), bool(state.get("bike_offer"))
    update_project(state, world, town, today, local.hour, log)
    if had != ((state.get("project") or {}).get("kind"), (state.get("project") or {}).get("parts"), bool(state.get("bike_offer"))):
        state["queue"] = []                                   # something new in the garage: rethink
        W = merged_world(world, town, state, today)
    if rng_event() < world["events"]["chance"]:
        event = random.choice(world["events"]["list"])
        if isinstance(event, dict):
            count_bricks(state, max(0, state["bricks"] + event.get("bricks", 0)) - state["bricks"])
            state["bricks"] = max(0, state["bricks"] + event.get("bricks", 0))
            state["coins"] = max(0, state["coins"] + event.get("coins", 0))
            event = event["text"]
        log("noticed", event)
        state["queue"] = []
        W = merged_world(world, town, state, today)

    # 4. Decide: bedtime / queue / AI / autopilot
    plan, source = None, None
    if night or state["needs"]["rest"] >= 0.95:
        bed = fb_fill(random.choice(free_brain().get("whys", {}).get("go_to_sleep") or ["Bedtime."]), state, town)
        plan = [{"move": "go_to_sleep", "why": bed}] if state["place"] == "home" else \
               [{"move": "walk_to_home", "why": "Time to head home."}, {"move": "go_to_sleep", "why": bed}]
        source = "autopilot"
    elif state["queue"]:
        plan, source = state["queue"], "queue"
    else:
        system, user = build_prompt(state, W, world, town, sheet, feed, now)
        try:
            text, usage = mock_model(state, W, world, town, system, user) if use_mock else call_model(system, user)
            if not use_mock:                       # the free brain costs nothing: don't count fake tokens
                add_usage(state, usage)
            decision = parse_decision(text)
            if decision is None:
                raise RuntimeError(f"unusable reply: {text[:120]!r}")
            plan, source = decision["moves"], "model"
            if decision["thought"] and decision["thought"] != state["thought"]:
                state["thought"] = decision["thought"]
                log("thought", decision["thought"], by="model")
            if decision["feeling"]:
                state["feeling"] = decision["feeling"]
            if decision.get("puppy_name") and state["pup"] and not state["pup"]["name"]:
                state["pup"]["name"] = decision["puppy_name"]
                log("learned", f"named the puppy {decision['puppy_name']}", by="model")
            pr = state.get("project")
            if decision.get("bike_name") and pr and not pr.get("name"):
                pr["name"] = decision["bike_name"]
                log("bike", f"named the {project_kind(world, pr)['name']} {pr['name']}.", by="model")
                W = merged_world(world, town, state, today)          # labels use her name now
        except Exception as e:  # any AI problem -> carry on with autopilot
            print(f"[mind] {e}")
            plan, source = [{"move": m, "why": None} for m in autopilot(state, W)], "autopilot"

    # 5. CODE: do the first move now, queue the rest. The world can refuse.
    step, rest = plan[0], plan[1:]
    bricks_before = state["bricks"]
    label = move_label(W, step["move"]).replace("the puppy", pup_name(state))
    ok, refused, bonus, note = apply_move(state, world, town, step, today, log)
    count_bricks(state, state["bricks"] - bricks_before)
    count(source)
    W = merged_world(world, town, state, today)
    if ok:
        state["doing"] = label
        log("did", state["doing"] + (f" ({note})" if note else ""), why=step.get("why"), by=source)
        state["queue"] = [s for s in rest if (town["site"] or s.get("move") != "work_on_site")         # build done: stop
                          and (s.get("move") != "work_on_the_restoration" or "work_on_the_restoration" in W["moves"])]
        write_note(state, sheet, use_mock, log, now)
        if step["move"] == "go_to_sleep" and (local.hour >= 20 or local.hour < bt["wake_from_hour"]):
            entry = write_diary(state, town, sheet, diary, local, use_mock)
            if entry:
                log("diary", f"wrote in his diary: {entry['title']}")
    else:
        state.pop("pending_read", None)
        log("refused", f"tried {label}: {refused}", by=source, ok=False)
        state["queue"] = []
    update_mood(state, world, bonus, decor_bonus(world, town))
    return finish(state, feed, town, diary, data_dir, now, f"{source}: {step['move']}{'' if ok else ' (refused)'}")


def finish(state, feed, town, diary, data_dir, now, summary):
    state["updated"] = now.isoformat()
    if _CUR.get("world"):
        state["garage"] = garage_view(state, _CUR["world"], now.astimezone(TZ).date().isoformat())
    save(data_dir / "state.json", state)
    save(data_dir / "feed.json", feed[:FEED_KEEP])
    save(data_dir / "town.json", town)
    save(data_dir / "diary.json", diary)
    save(data_dir / "who.json", load(CONFIG / "sheet.json"))
    save(data_dir / "library.json", {"books": {k: {"title": v["title"], "where": book_where(state, k) or "box",
                                                   **({"box": v["box"]} if v.get("box") else {}), "chapters": len(v["chapters"]),
                                                   "perk": perk_text(v) or None, "source": v.get("source")}
                                               for k, v in library()["books"].items()},
                                     "boxes_left": len(boxes_left(state)),
                                     "topics": len(library()["encyclopedia"]),
                                     "credit": "Books + encyclopedia: offline copy of Wikipedia articles, CC BY-SA 4.0"})
    print(f"[tick {state['tick']}] {clock(now):>8} {state['place'][:13]:<13} {summary[:44]:<44} "
          f"mood {state['mood']:+.2f} coins {state['coins']:>3} bricks {state['bricks']:>3}")
    return state


# ---------------------------------------------------------------- run

def sim_start(keep):
    """Where a fake run starts: carry on from the last one (--keep) or a brand-new him right now."""
    if keep:
        s = load(SIM / "state.json")
        if s:
            return datetime.fromisoformat(s["updated"]) + timedelta(minutes=TICK_MINUTES)
    for f in DATA_FILES:
        (SIM / f).unlink(missing_ok=True)
    return datetime.now(timezone.utc).replace(second=0, microsecond=0)


def serve(port, data_dir):
    """A tiny local web server: the page from docs/, the data from sim_data/."""
    docs, data_dir = ROOT / "docs", data_dir.resolve()

    class Handler(http.server.SimpleHTTPRequestHandler):
        def translate_path(self, path):
            p = urllib.parse.unquote(urllib.parse.urlsplit(path).path)
            if p.startswith("/data/"):
                f = (data_dir / p[6:]).resolve()
                return str(f) if f.is_relative_to(data_dir) else str(data_dir / "_nope")
            return super().translate_path(path)

        def end_headers(self):
            self.send_header("Cache-Control", "no-store")
            super().end_headers()

        def log_message(self, *args):
            pass

    import socket
    with socket.socket() as probe:       # already running? (Windows would let a 2nd copy share the port)
        probe.settimeout(0.5)
        if probe.connect_ex(("127.0.0.1", port)) == 0:
            return None

    class Server(http.server.ThreadingHTTPServer):
        allow_reuse_address = False

    try:   # always the SAME address, so bookmarks keep working
        httpd = Server(("127.0.0.1", port), functools.partial(Handler, directory=str(docs)))
    except OSError:
        return None                      # something else is using it
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return port


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")   # emoji-safe on Windows
    except Exception:
        pass
    ap = argparse.ArgumentParser(description=f"Run {me()}.")
    ap.add_argument("--mock", action="store_true", help="one tick with a fake AI (free), into the LIVE data")
    ap.add_argument("--simulate", type=float, metavar="HOURS", help="fake N hours of ticks into sim_data/ (free)")
    ap.add_argument("--watch", action="store_true", help="watch him live at http://localhost:8000 (free)")
    ap.add_argument("--speed", type=float, default=2.0, help="--watch: real seconds per 15-minute tick (default 2)")
    ap.add_argument("--keep", action="store_true", help="--simulate/--watch: carry on from the last fake run")
    ap.add_argument("--real", action="store_true", help="--simulate/--watch with the REAL AI (costs money)")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    if args.simulate or args.watch:
        t = sim_start(args.keep)
        if args.simulate:
            for _ in range(int(args.simulate * 60 / TICK_MINUTES)):
                tick(t, data_dir=SIM, use_mock=not args.real)
                t += timedelta(minutes=TICK_MINUTES)
            town, diary = load(SIM / "town.json"), load(SIM / "diary.json", [])
            print(f"\nTown: {', '.join(l['name'] for l in sorted(town['lots'], key=lambda l: l['lot']))}")
            print(f"Diary entries: {len(diary)}" + (f"  latest: {diary[0]['day']}: {diary[0]['title']}" if diary else ""))
        if args.watch:
            port = serve(args.port, SIM)
            url = f"http://localhost:{args.port}/world.html"
            if port is None:
                print(f"{me()} is already running. Opening {url}")
                if not args.no_browser:
                    webbrowser.open(url)
                return
            print(f"{me()} is live:  {url}   (status page: http://localhost:{port}/)")
            print(f"1 tick every {args.speed:g} s. Keep this window open; close it to stop him.")
            if not args.no_browser:
                webbrowser.open(url)
            try:
                while True:
                    tick(t, data_dir=SIM, use_mock=not args.real)
                    t += timedelta(minutes=TICK_MINUTES)
                    time.sleep(args.speed)
            except KeyboardInterrupt:
                print("\nStopped. Run with --keep to carry on from here.")
        return
    # No API key = the FREE brain (the fake AI): he still lives, builds and writes, for $0.
    # Add the ANTHROPIC_API_KEY secret later and his real brain takes over by itself.
    run_due(DATA, datetime.now(timezone.utc), use_mock=args.mock or not os.environ.get("ANTHROPIC_API_KEY"))


def run_due(data_dir, real_now, use_mock):
    """One GitHub run: live every 15-minute step that's due since the last run, at the town's speed.
    His clock ('updated') is his own TOWN time; 'real_updated' is the real time of the last run."""
    clock = (load(CONFIG / "world.json") or {}).get("clock", {})
    speed, cap = clock.get("speed", 1), clock.get("max_ticks_per_run", 24)
    state = load(data_dir / "state.json")
    if not state:                                   # his very first tick: his clock starts now
        tick(real_now, data_dir=data_dir, use_mock=use_mock)
        steps = 1
    else:
        last_real = datetime.fromisoformat(state.get("real_updated") or state["updated"])
        due = int((real_now - last_real).total_seconds() / 60 * speed / TICK_MINUTES)
        steps = max(1, min(due, cap))
        t = datetime.fromisoformat(state["updated"])
        for _ in range(steps):
            t += timedelta(minutes=TICK_MINUTES)
            tick(t, data_dir=data_dir, use_mock=use_mock)
    state = load(data_dir / "state.json")
    state["real_updated"] = real_now.isoformat()
    state["speed"] = speed
    save(data_dir / "state.json", state)
    print(f"[run] lived {steps} step(s) = {steps * TICK_MINUTES} min of his life (speed x{speed})")


if __name__ == "__main__":
    main()

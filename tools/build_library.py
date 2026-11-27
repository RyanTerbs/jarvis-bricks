#!/usr/bin/env python3
"""
Builds Derek's OFFLINE library from Wikipedia, on your own computer.
Derek himself never touches the internet: he only reads the files this writes.

  python tools/build_library.py            -> fetches only NEW books/topics, keeps the rest exactly as they are
  python tools/build_library.py --refresh  -> fetches everything again (careful: chapter counts can change
                                              under a book he's halfway through)

Text: Wikipedia contributors, CC BY-SA 4.0 (each entry keeps its source link).
To add a book or a topic, add it to the lists below and run this again. Where it's shelved and what it
teaches him (perk) always come from the list below, so you can change those without fetching again.

Where: "home" = his own shelf, "library" = once he builds the library, "box:N" = book box N, delivered to his
door when he's nearly run out of things to read (box 1 comes with the first barn-find bike).
Perk: one dict or a list of dicts. "project_stage" perks help his garage project: stage "start" = better odds
on the first start, any other stage = that many fewer work sessions.
"""
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "jarvis" / "library"
API = "https://en.wikipedia.org/w/api.php"
UA = "DerekBricks/1.0 (personal learning project; builds a small offline copy once)"

# id, Wikipedia title, where it's shelved, what finishing it teaches him (perk)
BOOKS = [
    # ---- his own shelf at home: the dream first
    ("dog_training", "Dog training", "home", {"type": "train_chance", "value": 0.10, "text": "puppy training works more often"}),
    ("carburetor", "Carburetor", "home", [{"type": "product_value", "product": "rebuilt_carb", "value": 2, "text": "his rebuilt carbs sell for 2 coins more"},
                                          {"type": "project_stage", "stage": "carb", "value": 2, "text": "carb rebuilds on a project bike take 2 sessions less"}]),
    ("thailand", "Thailand", "home", {"type": "mood_base", "value": 0.03, "text": "knowing where he's going keeps him cheerful"}),
    ("tourism_thailand", "Tourism in Thailand", "home", None),
    ("bangkok", "Bangkok", "home", None),
    ("moto_touring", "Motorcycle touring", "home", {"type": "move_mood", "move": "go_for_a_ride", "value": 0.05, "text": "rides make him even happier"}),
    # ---- the library: Thailand + travel
    ("chiang_mai", "Chiang Mai", "library", None),
    ("phuket", "Phuket province", "library", None),
    ("krabi", "Krabi province", "library", None),
    ("thai_buddhism", "Buddhism in Thailand", "library", {"type": "mood_base", "value": 0.02, "text": "a calmer head"}),
    ("songkran", "Songkran", "library", None),
    ("thai_cuisine", "Thai cuisine", "library", {"type": "product_value", "product": "noodle_kit", "value": 1, "text": "his noodle kits sell for 1 coin more"}),
    ("thai_language", "Thai language", "library", None),
    ("muay_thai", "Muay Thai", "library", {"type": "move_mood", "move": "lift_weights", "value": 0.05, "text": "workouts feel better"}),
    ("surfing", "Surfing", "library", {"type": "move_mood", "move": "go_surfing", "value": 0.05, "text": "surf sessions make him happier"}),
    ("backpacking", "Backpacking (travel)", "library", None),
    ("travel", "Travel", "library", None),
    ("fire", "FIRE movement", "library", {"type": "move_mood", "move": "count_savings", "value": 0.05, "text": "counting the jar feels even better"}),
    # ---- the library: the work he knows
    ("construction_mgmt", "Construction management", "library", {"type": "site_speed", "value": 0.15, "text": "builds go faster"}),
    ("project_mgmt", "Project management", "library", {"type": "site_speed", "value": 0.10, "text": "builds go a bit faster"}),
    ("bricklayer", "Bricklayer", "library", {"type": "site_speed", "value": 0.25, "text": "1 in 4 building shifts count double"}),
    ("log_house", "Log house", "library", None),
    ("quality_control", "Quality control", "library", {"type": "product_value", "product": "model_bike", "value": 1, "text": "his model bikes sell for 1 coin more"}),
    ("event_mgmt", "Event management", "library", {"type": "sell_chance", "value": 0.05, "text": "draws more people to his stall"}),
    ("cost_estimate", "Cost estimate", "library", None),
    ("haggling", "Haggling", "library", {"type": "sell_chance", "value": 0.05, "text": "sells a bit more at his stall"}),
    ("pest_control", "Pest control", "library", None),
    ("auto_repair", "Automobile repair shop", "library", {"type": "move_coins", "move": "fix_a_car", "value": 1, "text": "+1 coin for every car he fixes"}),
    ("two_stroke", "Two-stroke engine", "library", [{"type": "move_coins", "move": "fix_a_car", "value": 1, "text": "+1 coin for every car he fixes"},
                                                    {"type": "project_stage", "stage": "engine", "value": 1, "text": "engine work on a project bike takes 1 session less"}]),
    ("motorcycle", "Motorcycle", "library", {"type": "move_mood", "move": "go_for_a_ride", "value": 0.05, "text": "rides make him happier"}),
    ("ktm", "KTM", "library", {"type": "move_mood", "move": "tinker_with_bike", "value": 0.05, "text": "tinkering with his bike feels even better"}),
    ("maserati", "Maserati", "library", None),
    # ---- the library: places + life
    ("south_africa", "South Africa", "library", None),
    ("rwanda", "Rwanda", "library", None),
    ("saudi_arabia", "Saudi Arabia", "library", None),
    ("riyadh", "Riyadh", "library", None),
    ("netherlands", "Netherlands", "library", None),
    ("florida", "Florida", "library", None),
    ("fitness", "Physical fitness", "library", {"type": "move_mood", "move": "lift_weights", "value": 0.05, "text": "workouts feel better"}),
    ("healthy_diet", "Healthy diet", "library", {"type": "move_mood", "move": "cook_dinner", "value": 0.05, "text": "a proper meal lifts him more"}),
    ("index_fund", "Index fund", "library", {"type": "move_mood", "move": "count_savings", "value": 0.05, "text": "counting the jar feels even better"}),
    ("gold_investment", "Gold as an investment", "library", None),
    ("puppy", "Puppy", "library", {"type": "bond_gain", "value": 0.5, "text": "looking after his pup builds the bond 50% faster"}),
    ("lego", "Lego", "library", None),
    # ---- book box 1: the garage box (the farmer throws it in with the barn-find bike)
    ("barn_find", "Barn find", "box:1", {"type": "move_mood", "move": "work_on_the_restoration", "value": 0.03, "text": "restoration work feels even better"}),
    ("vehicle_restoration", "Conservation and restoration of road vehicles", "box:1", {"type": "project_stage", "stage": "strip", "value": 1, "text": "stripping a project bike takes 1 session less"}),
    ("four_stroke", "Four-stroke engine", "box:1", {"type": "project_stage", "stage": "engine", "value": 2, "text": "engine work on a project bike takes 2 sessions less"}),
    ("spark_plug", "Spark plug", "box:1", [{"type": "project_stage", "stage": "start", "value": 0.2, "text": "a project bike is likelier to start first kick"},
                                           {"type": "project_stage", "stage": "electrics", "value": 1, "text": "electrics take 1 session less"}]),
    ("tire", "Tire", "box:1", {"type": "project_stage", "stage": "electrics", "value": 1, "text": "tyres + electrics take 1 session less"}),
    ("spray_painting", "Spray painting", "box:1", {"type": "project_stage", "stage": "paint", "value": 1, "text": "painting a project bike takes 1 session less"}),
    # ---- box 2: northern Thailand (the trip)
    ("pai", "Pai, Thailand", "box:2", None),
    ("mae_hong_son", "Mae Hong Son province", "box:2", None),
    ("chiang_rai", "Chiang Rai province", "box:2", None),
    ("golden_triangle", "Golden Triangle (Southeast Asia)", "box:2", None),
    ("isan", "Isan", "box:2", None),
    ("loy_krathong", "Loy Krathong", "box:2", {"type": "mood_base", "value": 0.01, "text": "a little extra cheer"}),
    # ---- box 3: more engines + riding
    ("welding", "Welding", "box:3", {"type": "project_stage", "stage": "strip", "value": 1, "text": "frame work on a project bike takes 1 session less"}),
    ("fuel_injection", "Fuel injection", "box:3", {"type": "move_coins", "move": "fix_a_car", "value": 1, "text": "+1 coin for every car he fixes"}),
    ("ignition", "Ignition system", "box:3", {"type": "project_stage", "stage": "start", "value": 0.1, "text": "project bikes start more easily"}),
    ("enduro", "Enduro", "box:3", {"type": "move_mood", "move": "ride_the_track", "value": 0.05, "text": "track laps feel even better"}),
    ("dual_sport", "Dual-sport motorcycle", "box:3", {"type": "move_mood", "move": "ride_a_restored_bike", "value": 0.05, "text": "rides on his restored bikes feel even better"}),
    ("motocross", "Motocross", "box:3", None),
    # ---- box 4: Thai islands + street life
    ("phi_phi", "Phi Phi Islands", "box:4", None),
    ("ko_tao", "Ko Tao", "box:4", None),
    ("thai_street_food", "Street food of Thailand", "box:4", {"type": "product_value", "product": "noodle_kit", "value": 1, "text": "his noodle kits sell for 1 coin more"}),
    ("khaosan", "Khaosan Road", "box:4", None),
    ("songthaew", "Songthaew", "box:4", None),
    ("thai_culture", "Culture of Thailand", "box:4", None),
    # ---- box 5: money
    ("dca", "Dollar-cost averaging", "box:5", {"type": "move_mood", "move": "count_savings", "value": 0.03, "text": "counting the jar feels even better"}),
    ("sp500", "S&P 500", "box:5", None),
    ("compound_interest", "Compound interest", "box:5", None),
    ("frugality", "Frugality", "box:5", None),
    ("retirement", "Retirement", "box:5", None),
    ("expatriate", "Expatriate", "box:5", None),
    # ---- box 6: the builder + places from Ryan's life
    ("scaffolding", "Scaffolding", "box:6", {"type": "site_speed", "value": 0.05, "text": "builds go a touch faster"}),
    ("masonry", "Masonry", "box:6", {"type": "site_speed", "value": 0.10, "text": "builds go a bit faster"}),
    ("punch_list", "Punch list", "box:6", None),
    ("site_safety", "Construction site safety", "box:6", None),
    ("eastern_cape", "Eastern Cape", "box:6", None),
    ("port_alfred", "Port Alfred", "box:6", None),
    ("everglades", "Everglades", "box:6", None),
    ("jet_ski", "Jet ski", "box:6", None),
    # ---- box 7: odds and ends
    ("rust", "Rust", "box:7", None),
    ("automotive_paint", "Automotive paint", "box:7", None),
    ("clutch", "Clutch", "box:7", None),
    ("off_roading", "Off-roading", "box:7", {"type": "move_mood", "move": "ride_a_restored_bike", "value": 0.03, "text": "rides feel a bit better"}),
    ("elephant_park", "Elephant Nature Park", "box:7", None),
    ("vlog", "Vlog", "box:7", None),
]
TOPICS = [
    "Bangkok", "Phuket", "Krabi", "Phang Nga Bay", "Songkran", "Loy Krathong", "Thai baht", "Auto rickshaw", "Pad thai",
    "Tom yum", "Mango sticky rice", "KTM", "Honda Super Cub", "Royal Enfield", "Four-stroke engine", "Spark plug",
    "Motorcycle helmet", "Torque wrench", "Mechanic", "Brick", "Mortar (masonry)", "Coffee", "Espresso", "Dog", "Saving",
    "Compound interest", "Piggy bank", "Bicycle", "Lighthouse", "Ocean", "Sunset", "Moon", "Rain", "Island", "Arecaceae",
    "Marketplace", "Library", "Diary", "South Africa", "Braai", "Port Alfred", "Muay Thai", "Elephant", "Monsoon",
    "Chiang Rai", "Pai, Thailand", "Ko Samui", "Ko Lanta", "Ko Pha-ngan", "Hua Hin", "Pattaya", "Ayutthaya (city)",
    "Sukhothai (city)", "Doi Inthanon", "Floating market", "Night market", "Thai boxing", "Tuk-tuk", "Mekong",
    "Andaman Sea", "Gulf of Thailand", "Kigali", "Amsterdam", "Rotterdam", "Fort Lauderdale", "Cape Town", "Johannesburg",
    "Biltong", "Rugby union", "Procore", "Bluebeam", "Building information modeling", "Gantt chart", "Critical path method",
]
SKIP = {"see also", "references", "external links", "further reading", "notes", "bibliography", "sources",
        "citations", "gallery", "footnotes", "explanatory notes", "works cited", "notes and references"}


def get(params):
    """One polite API call: retries with growing waits if Wikipedia says slow down (429)."""
    q = urllib.parse.urlencode({"action": "query", "format": "json", "redirects": 1, **params})
    for wait in (5, 15, 30, 60, 120):
        try:
            with urllib.request.urlopen(urllib.request.Request(f"{API}?{q}", headers={"User-Agent": UA}), timeout=30) as r:
                data = json.loads(r.read())
            time.sleep(1.5)
            return data
        except urllib.error.HTTPError as e:
            if e.code != 429:
                raise
            print(f"  (Wikipedia says slow down, waiting {wait}s)")
            time.sleep(wait)
    raise SystemExit("Wikipedia kept saying 429. Try again later.")


def fetch(title):
    page = next(iter(get({"prop": "extracts|info", "inprop": "url", "explaintext": 1, "titles": title})["query"]["pages"].values()))
    return page["title"], page.get("fullurl", ""), page.get("extract", "")


def fetch_intros(titles):
    """Intro paragraphs for up to 20 titles in one call."""
    data = get({"prop": "extracts|info", "inprop": "url", "explaintext": 1, "exintro": 1, "exlimit": 20, "titles": "|".join(titles)})
    return [(p["title"], p.get("fullurl", ""), p.get("extract", "")) for p in data["query"]["pages"].values() if "missing" not in p]


def trim(text, n):
    """Cut at a sentence end before n characters."""
    text = re.sub(r"\n{2,}", "\n", text).strip()
    if len(text) <= n:
        return text
    cut = text[:n]
    end = max(cut.rfind(". "), cut.rfind(".\n"))
    return cut[: end + 1] if end > n * 0.5 else cut.rstrip() + "…"


def split(extract):
    """Intro + top-level sections (== Title ==), sub-sections folded into their parent."""
    parts = re.split(r"\n== ([^=].*?) ==\n", "\n" + extract)
    intro, sections = parts[0], []
    for i in range(1, len(parts) - 1, 2):
        name, body = parts[i].strip(), re.sub(r"\n=== ?(.*?) ?===\n", r"\n\1: ", parts[i + 1])
        body = re.sub(r"\n==+ ?(.*?) ?==+\n", r"\n\1: ", body).strip()
        if name.lower() not in SKIP and len(body) > 200:
            sections.append((name, body))
    return intro.strip(), sections


def shelf(where):
    """'box:3' -> ('box', 3); 'home' -> ('home', None)."""
    if where.startswith("box:"):
        return "box", int(where[4:])
    return where, None


def load_old(name):
    try:
        return json.loads((OUT / name).read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def main():
    refresh = "--refresh" in sys.argv
    OUT.mkdir(parents=True, exist_ok=True)
    today = date.today().isoformat()
    old_books = {} if refresh else {k: v for k, v in load_old("books.json").items() if not k.startswith("_")}
    old_enc_all = {} if refresh else load_old("encyclopedia.json")
    old_enc = {k: v for k, v in old_enc_all.items() if not k.startswith("_")}
    books, encyclopedia, fetched = {}, dict(old_enc), 0
    for bid, title, where, perk in BOOKS:
        place, box = shelf(where)
        if bid in old_books:                     # keep the text exactly as he's been reading it
            b = old_books[bid]
        else:
            name, url, text = fetch(title)
            if not text.strip():
                print(f"skip  {title} (no Wikipedia page)")
                continue
            intro, sections = split(text)
            chapters = [{"title": "Introduction", "text": trim(intro, 2500)}] + \
                       [{"title": n, "text": trim(b, 2500)} for n, b in sections[:9]]
            b = {"title": name, "source": url, "chapters": chapters}
            encyclopedia.setdefault(name, {"text": trim(intro, 1800), "source": url})
            fetched += 1
            print(f"book  {name:<22} {len(chapters)} chapters ({where})")
        books[bid] = {"title": b["title"], "where": place, **({"box": box} if box else {}), "perk": perk,
                      "source": b["source"], "chapters": b["chapters"]}
    # topics: the first run (before 'asked' was kept) asked for every TOPIC already
    asked = set(old_enc_all.get("_meta", {}).get("asked", TOPICS if old_enc else []))
    todo = [t for t in TOPICS if t not in asked]
    for i in range(0, len(todo), 20):
        for name, url, text in fetch_intros(todo[i:i + 20]):
            if text.strip():
                encyclopedia.setdefault(name, {"text": trim(text, 1800), "source": url})
                print(f"topic {name}")
    meta = {"license": "CC BY-SA 4.0", "credit": "Text from Wikipedia contributors", "retrieved": today}
    (OUT / "books.json").write_text(json.dumps({"_meta": meta, **books}, indent=1, ensure_ascii=False), encoding="utf-8")
    (OUT / "encyclopedia.json").write_text(json.dumps({"_meta": {**meta, "asked": sorted(set(TOPICS) | asked)}, **encyclopedia},
                                                      indent=1, ensure_ascii=False), encoding="utf-8")
    (OUT / "README.md").write_text(
        "# Derek's offline library\n\n"
        f"A fixed copy of some Wikipedia articles, taken by `tools/build_library.py` (last run {today}). "
        "Derek reads these files only: **he has no live internet**.\n\n"
        "Text: Wikipedia contributors, licensed [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). "
        "Each book and entry keeps a link to its source article. Chapters are trimmed.\n", encoding="utf-8")
    boxes = sorted({v["box"] for v in books.values() if v.get("box")})
    print(f"\n{len(books)} books ({fetched} new, {len(boxes)} book boxes), {len(encyclopedia)} encyclopedia entries -> {OUT}")


if __name__ == "__main__":
    main()

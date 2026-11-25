#!/usr/bin/env python3
"""
Builds Jarvis's OFFLINE library from Wikipedia, once, on your own computer.
Jarvis himself never touches the internet: he only reads the files this writes.

  python tools/build_library.py      -> jarvis/library/books.json + encyclopedia.json + README.md

Text: Wikipedia contributors, CC BY-SA 4.0 (each entry keeps its source link).
To add a book or a topic, add it to the lists below and run this again.
"""
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "jarvis" / "library"
API = "https://en.wikipedia.org/w/api.php"
UA = "JarvisBricks/1.0 (personal learning project; builds a small offline copy once)"

# id, Wikipedia title, where it's shelved, what finishing it teaches him (perk)
BOOKS = [
    ("dog_training", "Dog training", "home", {"type": "train_chance", "value": 0.10, "text": "puppy training works more often"}),
    ("carburetor", "Carburetor", "home", {"type": "product_value", "product": "rebuilt_carb", "value": 2, "text": "his rebuilt carbs sell for 2 coins more"}),
    ("thailand", "Thailand", "home", {"type": "mood_base", "value": 0.03, "text": "knowing where he's going keeps him cheerful"}),
    ("puppy", "Puppy", "library", {"type": "bond_gain", "value": 0.5, "text": "looking after his pup builds the bond 50% faster"}),
    ("motorcycle", "Motorcycle", "library", {"type": "move_mood", "move": "go_for_a_ride", "value": 0.05, "text": "rides make him happier"}),
    ("two_stroke", "Two-stroke engine", "library", {"type": "move_coins", "move": "fix_a_car", "value": 1, "text": "+1 coin for every car he fixes"}),
    ("bricklayer", "Bricklayer", "library", {"type": "site_speed", "value": 0.25, "text": "1 in 4 building shifts count double"}),
    ("haggling", "Haggling", "library", {"type": "sell_chance", "value": 0.05, "text": "sells a bit more at his stall"}),
    ("thai_cuisine", "Thai cuisine", "library", {"type": "product_value", "product": "noodle_kit", "value": 1, "text": "his noodle kits sell for 1 coin more"}),
    ("chiang_mai", "Chiang Mai", "library", None),
    ("thai_language", "Thai language", "library", None),
    ("lego", "Lego", "library", None),
]
TOPICS = [
    "Bangkok", "Phuket", "Krabi", "Phang Nga Bay", "Songkran", "Loy Krathong", "Thai baht", "Auto rickshaw", "Pad thai",
    "Tom yum", "Mango sticky rice", "KTM", "Honda Super Cub", "Royal Enfield", "Four-stroke engine", "Spark plug",
    "Motorcycle helmet", "Torque wrench", "Mechanic", "Brick", "Mortar (masonry)", "Coffee", "Espresso", "Dog", "Saving",
    "Compound interest", "Piggy bank", "Bicycle", "Lighthouse", "Ocean", "Sunset", "Moon", "Rain", "Island", "Arecaceae",
    "Marketplace", "Library", "Diary", "South Africa", "Braai", "Port Alfred", "Muay Thai", "Elephant", "Monsoon",
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


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    today = date.today().isoformat()
    books, encyclopedia = {}, {}
    for bid, title, where, perk in BOOKS:
        name, url, text = fetch(title)
        intro, sections = split(text)
        chapters = [{"title": "Introduction", "text": trim(intro, 2500)}] + \
                   [{"title": n, "text": trim(b, 2500)} for n, b in sections[:9]]
        books[bid] = {"title": name, "where": where, "perk": perk, "source": url, "chapters": chapters}
        encyclopedia[name] = {"text": trim(intro, 1800), "source": url}
        print(f"book  {name:<22} {len(chapters)} chapters")
    for i in range(0, len(TOPICS), 20):
        for name, url, text in fetch_intros(TOPICS[i:i + 20]):
            if text.strip():
                encyclopedia[name] = {"text": trim(text, 1800), "source": url}
                print(f"topic {name}")
    meta = {"license": "CC BY-SA 4.0", "credit": "Text from Wikipedia contributors", "retrieved": today}
    (OUT / "books.json").write_text(json.dumps({"_meta": meta, **books}, indent=1, ensure_ascii=False), encoding="utf-8")
    (OUT / "encyclopedia.json").write_text(json.dumps({"_meta": meta, **encyclopedia}, indent=1, ensure_ascii=False), encoding="utf-8")
    (OUT / "README.md").write_text(
        "# Jarvis's offline library\n\n"
        f"A fixed copy of some Wikipedia articles, taken {today} by `tools/build_library.py`. "
        "Jarvis reads these files only: **he has no live internet**.\n\n"
        "Text: Wikipedia contributors, licensed [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). "
        "Each book and entry keeps a link to its source article. Chapters are trimmed.\n", encoding="utf-8")
    print(f"\n{len(books)} books, {len(encyclopedia)} encyclopedia entries -> {OUT}")


if __name__ == "__main__":
    main()

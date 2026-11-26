# Derek

A tiny autonomous brick-built man who lives in a little brick town he builds himself, decides what to do with an AI, writes a diary every night, and saves up for a motorbike trip across Thailand. Inspired by Pino (pinos.world).

## How he works

Every 15 minutes GitHub runs `tick.py` once:

1. **Code** updates his needs (rest, hunger, social, tinker, curiosity) and mood. No AI.
2. If he has a **queued plan**, he does the next step. No AI.
3. Otherwise the **AI** (Claude Haiku 5.5) picks 1–3 moves and says why, in his voice.
4. **Code** checks each move is allowed where he is, applies it, and logs it.

If the AI fails or isn't set up, **autopilot** fixes his most pressing need. At night he sleeps and the AI isn't called at all.

## His town

- Starts tiny: a brick pit (with a lucky **!** block), his house, the garage and the cafe.
- He collects bricks, picks a blueprint (library, gym, park, noodle stall, bike track, lookout tower, trees, lamps, fountain, more baseplate…), pays for it, then works on the building site until it's done.
- Once a day he can **design his own building** (name, look, what he does there). It becomes a real blueprint, and once built, a real place with its own move.
- Coins are also his Thailand fund, so every build is a choice.

## Money (in his world only)

- He can **make** things (brick model bikes, rebuilt carbs, postcards, brick lamps, noodle kits) and **sell** them at his market stall once he's built it. He picks the pricing: cheap sells fast, pricey earns more but slowly.
- He can **buy** from a catalogue (wheelbarrow, impact wrench, neon sign, coffee machine, hammock). Tools can pay for themselves; every coin spent is a coin less for Thailand.
- Brick coins only. Nothing here touches real money.

## His puppy

- A scruffy brick puppy follows him home on day one. **Derek names him himself** (the AI adds a name the first time it thinks).
- The puppy has his own needs (hunger, tired, bored) and a bond with Derek. Code moves them; looking after him is Derek's job: feed (dog food from home, 3 coins for 6 meals), play, walk, cuddle.
- **Training:** sit, give paw, stay, fetch, roll over, ride in the tank bag. Works best when he's fed, rested and bonded. Fetch brings extra bricks; ride means he comes along on bike rides.
- Neglect costs bond (and Derek worries). Company: a bonded puppy makes Derek less lonely.

## Books, laptop + notebook (offline, no internet)

- `jarvis/library/` holds a fixed offline copy of some Wikipedia articles (CC BY-SA 4.0, source link kept on each), built once by `python tools/build_library.py`. **Derek never touches the live internet.**
- **Books:** 3 on his shelf at home (Dog training, Carburetor, Thailand), 9 more at the library once he builds it. `read_a_book` reads the next chapter; finishing a book teaches him a perk (better puppy training, carbs sell for more, faster bricklaying, better haggling...).
- **His old laptop** (at home): `use_the_computer` looks a topic up in the offline encyclopedia (56 entries: Thailand, engines, dogs, money, the sea...).
- **Notebook:** after reading he writes one note in his own words (one small AI call). The last 8 notes go into his prompt, so what he learns sticks.

## The beach

The beach rings the whole island and is always open; the puppy comes along. Sunbathe (he really tans, and burns after 3 sessions a day without a beach kit), swim, build sand castles (they grow to 6 with towers, a moat and a flag; the tide takes them overnight), collect shells, play fetch with the pup, watch the sunset (evenings), and surf once he buys a board (skill grows with practice; waves are rolled daily: flat / small / good). In 3D he lies on his towel, swims, and rides his board while the pup waits on the shore.

## More land

The town starts with 24 lots (6 blocks) and a new baseplate adds 16 more. Older towns get topped up automatically.

## Open world (world.html)

Full-screen 3D like Pino's town: an island that grows in blocks of 4 lots with roads between, beach, palms, the sea and Thai limestone islands on the horizon. Derek walks the roads, the puppy trots behind. Needs bars for both at the top, a "right now" panel, a tap-to-jump minimap, WASD / arrows / on-screen pad to roam, and a Follow button.

## 3D

The page shows his town in 3D (three.js from a free CDN, nothing to install): drag to spin, pinch or scroll to zoom, the camera follows him. A 2D button switches to the flat picture, and the page falls back to 2D by itself if 3D can't load.

## His diary

When he goes to bed he writes a short diary entry about his day (one extra AI call a night). The "tomorrow" line is read back to him the next day. No AI? A template entry is written from the day's numbers so a day is never missed.

## Files

| File | What it is | Who writes it |
|---|---|---|
| `jarvis/sheet.json` | Who he is: personality, voice, goal | You |
| `jarvis/world.json` | World rules: moves, needs, blueprints, the starting town, events | You |
| `tick.py` | The engine: one tick of his life | You |
| `docs/data/state.json` | What he's doing right now | The tick |
| `docs/data/feed.json` | What he's done lately | The tick |
| `docs/data/town.json` | His town: what's built, the building site, his own designs | The tick |
| `docs/data/diary.json` | His diary | The tick |
| `docs/index.html` | His page (GitHub Pages) | You |
| `.github/workflows/tick.yml` | Runs a tick every 15 min | You |

## Try it free (no API key)

```
python tick.py --watch           # watch him live at http://localhost:8000 (fake AI, 1 tick every 2 s)
python tick.py --watch --speed 1 # faster
python tick.py --simulate 168    # fake a whole week in seconds (sim_data/), then:
python tick.py --watch --keep    # ...carry on watching from there
```

Add `?wide` to the page address to see the whole street at once.

## Go live

1. Get an API key at platform.claude.com (prepaid credits; leave auto-reload off so the credit is the spending cap).
2. Repo Settings > Secrets and variables > Actions > new secret `ANTHROPIC_API_KEY`.
3. Repo Settings > Pages > Deploy from branch `main`, folder `/docs`.
4. Actions > tick > Run workflow.

Page: `https://<user>.github.io/jarvis-bricks/`

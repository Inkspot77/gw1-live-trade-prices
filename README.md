# GW1 Live Trade Prices

<img width="1296" height="1190" alt="screenshot-2026-08-23_21-31-34" src="https://github.com/user-attachments/assets/80ad7a94-a20d-4257-a533-89455c2bd2d7" />
<img width="1238" height="1136" alt="screenshot-2026-08-23_21-31-58" src="https://github.com/user-attachments/assets/2d6471ae-841f-48de-95ed-098137446dc3" />
<img width="1291" height="1106" alt="screenshot-2026-08-23_21-32-51" src="https://github.com/user-attachments/assets/0c08fb11-bb8a-4e34-bf81-d3bd142124bb" />




A local dashboard that cross-references every public Guild Wars 1 price source
into one view, and tells you whether the price in front of you is a good deal —
**in both directions**. It will warn you when you are about to overpay, and it
will equally warn you when you are about to lowball the person on the other side.

Runs entirely on your machine. No accounts, no dependencies, no build step.

```bash
npm start                 # http://127.0.0.1:8787
npm run backfill          # also pull 90 days of NPC trader history (do this once)
npm test
```

Requires **Node 22.13+** (or 23.4+). It uses the built-in `node:sqlite`, which
needs `--experimental-sqlite` on 22.5-22.12 and is unflagged from 22.13.0 and
23.4.0 onward.

---

## What it reads

| Source | What it actually provides | How |
| --- | --- | --- |
| `kamadan.gwtoolbox.com` | Post-Searing trade chat, live | `GET /m`, `GET /s/<term>` |
| `ascalon.gwtoolbox.com` | Pre-Searing trade chat, live | same endpoints |
| GWToolbox trader feed | **In-game NPC material-trader buy/sell quotes**, plus ~90 days of history | inline `current_trader_quotes`, `GET /pricing_history/<id>/<from>/<to>` |
| `presearing.com/pricecheck` | ~400 Pre-Searing items with dated low/high bands back to 2019 | the public Google Sheet the page itself reads |
| `guildwarslegacy.com` board 12 | Price-check threads for unique weapons | board RSS feed |
| `wiki.guildwars.com` | Daily activities, Nicholas Sandford, Nicholas the Traveler | MediaWiki `action=parse` |

The wiki is not a price source — it is the *demand* source. Nicholas rotations
and Zaishen quests are the main predictable price movers in both economies, so
an item on today's list gets flagged as temporarily scarce.

## Why it stores data locally

No upstream source keeps a player-market price history. GWToolbox archives NPC
trader quotes only; the Pre-Searing sheet is a handful of manual snapshots; the
trade-chat endpoints are a live window a few hundred messages wide. Polling and
storing is what turns that into a baseline you can compare against, so **the
dashboard gets more useful the longer you leave it running.**

`npm run backfill` gives the 36 tradeable materials a real 90-day baseline
immediately rather than waiting three months for one to accumulate.

## How a price is judged

Three anchors, in decreasing order of authority:

1. **NPC trader quotes** — objective. The trader will always transact at these,
   so no player price outside them is ever worth taking. Buying above the
   trader's ask, or selling below its bid, is flagged outright regardless of
   what the statistics say.
2. **Player quotes** — the real market, but noisy and adversarial. Every
   statistic is robust (median, MAD, trimmed IQR) because one "WTS ecto 900k"
   must not move the baseline.
3. **Curated snapshots** — the Pre-Searing sheet's dated bands. Sparse, but the
   only multi-year record that exists for that economy.

The verdict compares your price to the side you would actually transact with —
buying means lifting someone's ask, selling means hitting someone's bid — and
reports the distance in robust standard deviations.

### The fair corridor

This is the anti-gouging guard, and it is deliberately symmetric.

- **Lower edge** — the 25th percentile of standing bids. Pay less than this and
  you are exploiting a seller who has not checked the market.
- **Upper edge** — the 75th percentile of standing asks. Ask more than this and
  you are charging a buyer above what the market is actually paying.
- Both edges are then clamped by the NPC trader, which nobody should transact
  outside of.

Trading inside the corridor is fair to both sides. The dashboard tells you when
you fall outside it **in either direction** — including when the unfair one is you.

## Valuing your own inventory

GWToolbox's **Account Inventory** window already exports everything you own to a
local file — no API, no upload, no account linking:

```
<Toolbox settings folder>/inventories/tmp<account-guid>.json
```

It rewrites that file on every outpost map load, on logout, and about a second
after any inventory change, and it covers every character, every bag, hero
inventories and the Xunlai chest. (The published docs still describe an older
per-character `.ini` layout; current builds write one JSON file per account.
Both shapes are read here.)

To use it: **Your inventory → choose the file.** If Guild Wars runs on a
different machine, copy the file over, or point a synced folder at it. There is
also a paste box for typing items by hand:

```
250 Glob of Ectoplasm
Obsidian Shard x88
Charr Salvage Kit, 3
```

### Watching a folder

Rather than re-dropping the file by hand, point the dashboard at a folder and it
re-imports whenever the export changes:

```bash
node bin/gw1-prices.mjs --watch /path/to/Toolbox/inventories
```

or set it in the UI under **Your inventory → watch a folder**. The path is
remembered, so it survives a restart.

If Guild Wars runs on another machine, point it at a synced copy of that folder
(Syncthing, Dropbox, or a mounted share). The newest export in the folder wins,
so multiple accounts are handled without configuration.

Two detection mechanisms run together, deliberately. `fs.watch` reacts instantly
where the OS supports it, and a stat poll every 10s is the fallback — **inotify
events do not cross CIFS or NFS mounts**, so a folder shared from a Windows box
can change without ever emitting an event. The status line says which mechanism
is actually live, so a stalled watch is diagnosable rather than mysterious.

Toolbox rewrites the file in place while you play, so a read can land mid-write.
A failed parse is retried briefly before being reported, and a partial file is
never imported. A byte-identical rewrite (which sync tools do routinely) is
detected by content hash and skipped, so it does not churn the alert engine.

### How items get identified

The file stores a numeric `model_id` and the item's *encoded* name, not English
text. Three routes are tried, in order:

1. **Model id** — resolves every material, dye and stackable outright.
2. **A fingerprint you have named before** — the encoded name is stable per item
   type, so naming an unknown item once teaches it permanently.
3. **Readable fragments** of the encoded name, matched against the item registry.

Anything still unidentified is **listed, not discarded**, with a box to name it.
The headline total therefore reads as an honest floor rather than a guess.

## Sell alerts

Once holdings are imported, the dashboard watches them and raises a **Sell now**
panel when something you own is fetching more than it usually does.

The judgement uses whichever evidence is stronger for that item:

- For an **NPC-traded material**, the trader's own price history. The ecto
  trader alone has swung between 11k and 26k over 90 days, so "is this a good
  moment to sell to the trader?" is a real and objectively answerable question.
- For **everything else**, the player market's bid side against its own longer
  baseline. Spot and baseline are always read from the same side of the book —
  comparing today's bids against last month's asks would manufacture a signal
  out of the bid/ask spread.

Alerts are **hysteretic**: one opens above 1.5σ and only closes below 1.0σ, so a
price hovering on the threshold cannot flap. While open, an alert remembers its
*peak*, so the list shows the best the moment got rather than wherever the price
happens to sit when you look. Selling the item clears its alert.

Ranking is by **total gold captured versus an average day** (edge × quantity),
not by raw unusualness — otherwise a single cupcake three sigma above baseline
would outrank a 250-stack of ectos.

The suggested price is **capped at the fair corridor**. A good moment to sell
means the market is paying well; it is not a licence to overcharge.

Evaluation runs on the poll loop, so alerts fire whether or not the dashboard is
open. Desktop notifications are opt-in via the button in the panel, and fire at
most once per alert.

## Running it on a server

Two ways to host this long-term: a container, or a systemd unit on bare metal.
Either way, **the dashboard has no authentication** and its POST endpoints
change stored state, so only bind it beyond loopback on a network you trust;
otherwise tunnel in over SSH or put a reverse proxy with auth in front.

### Docker

```bash
docker compose up -d --build
```

That's the whole setup — the image needs nothing else, since the app has no
dependencies to install. It binds `127.0.0.1:8787` on the host by default (not
the LAN; see the note at the top of `docker-compose.yml` to change that), and
the price history lives in a named volume so it survives rebuilds.

To watch a synced GWToolbox inventory folder, uncomment the two `# ` lines
near `WATCH_DIR` in `docker-compose.yml` and point the bind mount at wherever
your sync tool lands the export (see Part 2 of [DEPLOY.md](deploy/DEPLOY.md)
for Syncthing / CIFS / scheduled-push options — the container side is
identical either way).

To seed 90 days of NPC trader history once, before first use:

```bash
docker compose --profile tools run --rm backfill
```
(Ctrl-C, or `docker compose stop backfill`, once the log shows the backfill
summary line — the container keeps serving after the seed finishes, same as
the plain-Node version does.)

Two things worth knowing, both found by actually building and running this
rather than assumed:

- **The base image needs Node ≥22.13** for `node:sqlite` to load unflagged.
  The `Dockerfile` checks this at build time and fails loudly if it doesn't,
  rather than shipping an image that 500s on first request.
- **`init: true` is load-bearing, not decoration.** Without it, Node runs as
  PID 1 of the container's PID namespace, and a Linux kernel quirk means an
  *unhandled* SIGTERM is silently dropped instead of falling back to its
  default action (terminate) — `docker stop` then burns its full timeout and
  force-kills every time. Measured: 10s (killed) without `init: true`, 0.3s
  (clean exit) with it.

### Bare metal / systemd

`deploy/` holds a systemd unit, a preflight checker, and
[DEPLOY.md](deploy/DEPLOY.md) — a walkthrough for hosting the dashboard on an
Ubuntu box and syncing the inventory export from a Windows Guild Wars install
(Syncthing, a CIFS mount, or a scheduled push). The Windows-sync half of that
guide applies identically whichever way you run the dashboard itself.

## The two economies never mix

Post-Searing settles in ectos; Pre-Searing settles in Black Dye. Both rates
float and are read live (ecto from the NPC trader, Black Dye from the price
guide), and items are tagged by realm so a Pre-Searing price never contaminates
a Post-Searing baseline.

## Layout

```
bin/gw1-prices.mjs     entry point
src/
  server.mjs           HTTP server + JSON API (loopback only)
  poller.mjs           per-source schedules, isolated failures
  db.mjs               SQLite schema and queries
  analytics.mjs        robust statistics, deal scoring, the fair corridor
  parse/
    currency.mjs       "6 = 100k", "10a/stk", "2e", "1bd" -> gold
    items.mjs          item registry and the alias matcher
    trade.mjs          one chat line -> structured quotes
    inventory.mjs      GWToolbox account file / typed list -> your holdings
  valuation.mjs        per-item analysis, inventory pricing, the alert engine
  watcher.mjs          folder watch -> automatic inventory re-import
  sources/             one adapter per site
public/                dashboard (vanilla JS, inline SVG charts)
data/prices.db         your accumulated history + imported inventory
```

## Reading the dashboard

- **Reference** — the single number to quote, with its source and confidence.
- **Ask / Bid** — median of the last 3 days on each side.
- **Fair corridor** — the bullet chart. Green band is the corridor, green rules
  are the NPC bounds, dots are the live market.
- **Signal** — how far today sits from the item's own 60-day baseline.
- **Liquidity** — how much to trust it. `thin` means very few recent quotes.

Charts are paired with a table view, series are direct-labelled as well as
coloured, and the palette is validated for colour-vision deficiency in both
light and dark themes.

## Known limits

- Trade chat is genuinely ambiguous. "Cupcakes 14e" may mean per-item or per
  stack, and nothing in the message says which. The parser is conservative —
  it emits nothing rather than guess — and outliers that slip through are
  trimmed by the robust statistics, but a thin market can still mislead.
- Unique weapons (skin + requirement + mods) have no meaningful "market price".
  Those are surfaced as Guild Wars Legacy threads rather than as numbers.
- The GWToolbox endpoints are undocumented. They are polled gently, with backoff
  on rate limits, and every source fails independently — a red dot on the
  Sources panel means that one source is stale, not that the dashboard is down.

## Development

Branches are cheap; use one per change and merge back through a pull request:

```bash
git switch -c my-change
# ...edit, test, commit...
git push -u origin my-change
github.com/Inkspot77/gw1-live-trade-prices -> Compare & pull request
```

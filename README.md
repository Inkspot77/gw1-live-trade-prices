# GW1 Live Trade Prices

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js >=22.13](https://img.shields.io/badge/node-%3E%3D22.13-brightgreen.svg)](https://nodejs.org)
[![CI](https://github.com/Inkspot77/gw1-live-trade-prices/actions/workflows/docker-image.yml/badge.svg)](https://github.com/Inkspot77/gw1-live-trade-prices/actions/workflows/docker-image.yml)

<img width="1680" height="1210" alt="GWLP1" src="https://github.com/user-attachments/assets/9d4c27ff-7e49-44b0-8f46-ffc30873e8be" />

<img width="1662" height="1205" alt="GWLP2" src="https://github.com/user-attachments/assets/7b0fc157-c009-4c85-b4d3-e5d091a968e4" />

<img width="455" height="612" alt="GWLP3" src="https://github.com/user-attachments/assets/a64dac27-3722-430b-877e-addbedf3a4d0" />

<img width="450" height="1077" alt="GWLP4" src="https://github.com/user-attachments/assets/0e13c415-116c-437c-ae78-9a7a4c67faf0" />

<img width="456" height="491" alt="GWLP5" src="https://github.com/user-attachments/assets/eebc6e8d-c015-4703-a8cd-44be4847599c" />

## What this is

A price dashboard for Guild Wars 1, built for people who trade and don't want
to get ripped off — or to accidentally lowball someone else. It watches the
places players actually check prices (trade chat, the NPC material trader,
community price sheets, forum price-check threads), keeps a running history
of what things have actually sold for, and tells you plainly whether a price
in front of you is good, fair, or bad — **for whichever side of the deal
you're on.**

It runs entirely on your own computer (or a server you control). Nothing gets
uploaded anywhere, there's no account to make, and there's nothing to install
beyond Node.js itself.

## Getting started

If you just want it running — on a server, or on the same Windows PC you play
Guild Wars on — **[DEPLOY.md](deploy/DEPLOY.md)** walks through both, start to
finish, assuming no prior experience with servers or the command line.

For the short version, if you're already comfortable with a terminal:

```bash
npm start                 # opens the dashboard at http://127.0.0.1:8787
npm run backfill          # optional, once: pulls 90 days of price history immediately
npm test                  # runs the test suite
```

You'll need **Node.js version 22.13 or newer** (or 23.4+) — get it from
[nodejs.org](https://nodejs.org). Everything else is built in; there's no
separate install step and nothing else to download.

Want to change the port, turn on a password, or point it at a folder of
inventory exports? All of that is covered in
**[`.env.example`](.env.example)** — copy it to `.env`, fill in what you want,
and `npm start` picks it up automatically.

## What it actually watches

| Where | What it gets from there |
| --- | --- |
| Kamadan trade chat (Post-Searing) | Live "buying"/"selling" messages as players type them |
| Ascalon trade chat (Pre-Searing) | Same, for the Pre-Searing economy |
| The in-game NPC material trader | The official buy/sell price — and up to 90 days of how that price has moved |
| The Pre-Searing community price sheet | Long-running, hand-curated prices going back to 2019 |
| Guild Wars Legacy forum | Price-check discussion threads for one-of-a-kind weapons, which don't have a "market price" |
| The official wiki | Which items are in demand right now (daily quests, Nicholas rotations) |

That last one is worth calling out: the wiki isn't a price source, it's a
**demand** source. When the game itself is asking players to turn in a
particular item today, that item usually gets scarcer and pricier for a
while — so the dashboard flags it.

### Adding a source of your own

If you know a site that publishes prices as a plain JSON list, you don't need
to touch any code to use it — under **Sources → add your own source** in the
dashboard, give it the page's address and the names of the fields that hold
the item and the price (most JSON price feeds use something like `name` and
`price`, but you tell it what yours actually calls them). It's checked
immediately, so a typo shows up right away instead of silently doing nothing.
Item names it already recognizes (like "Ecto") line up with existing price
history automatically; anything it doesn't recognize still shows up under
its own name rather than being dropped.

## Why it remembers prices instead of just showing the latest one

None of the sources above keep a real history on their own. Trade chat is a
live, scrolling window — once a message scrolls past, it's gone. The NPC
trader's price moves over time, but nothing publishes that history except
here. So the dashboard quietly keeps its own record in the background, and
**gets more useful to you the longer you leave it running.**

If you don't want to wait weeks for that history to build up on its own, run
`npm run backfill` once — it pulls about 90 days of NPC trader history
immediately.

## How it decides whether a price is good

In order of how much it trusts each one:

1. **What the NPC trader will pay or charge.** This one's a hard fact, not an
   opinion — the trader will always buy or sell at that price, no negotiation.
   If a player is offering worse than that, it's flagged outright, full stop.
2. **What players are actually asking and offering**, gathered from trade
   chat. This is the real market, but it's noisy — some people list joke
   prices, some are just wrong, some are bots repeating the same line for
   hours. The dashboard is built to ignore that noise rather than get fooled
   by it, so one absurd price in the chat log doesn't skew everything.
3. **The community price sheet**, for the (mostly Pre-Searing) items that
   rarely show up in trade chat at all. Not live, but the only long-term
   record that exists for those items.

When you tell it a price you're considering, it compares that price against
whichever side of the deal you're actually on — a buyer competes with other
asking prices, a seller competes with other offers — and tells you how that
stacks up.

### Keeping it fair to both sides

This dashboard is built around one rule: it should never help you take
advantage of someone else, or let someone else take advantage of you. So the
same check runs both ways — if a price is unusually good *for you*, it also
asks whether that means you're **underpaying a seller** or **overcharging a
buyer**, and says so plainly if it does. A "great deal" that's only great
because the other person got shortchanged isn't treated as a win.

This runs quietly in the background on every price check and every sell
alert — it isn't a separate chart or number you have to go looking for, it's
just part of how "good deal" and "bad deal" get decided.

## Tracking what you own

GWToolbox (the popular Guild Wars helper tool) already writes out everything
in your account — every character, every bag, your Xunlai storage — to a
plain file on disk, automatically, while you play. No plugin, no upload,
nothing to configure in-game. The dashboard can read that file directly:

**Your inventory → choose the file.** That's the whole setup. If Guild Wars
runs on a different computer than the dashboard, either copy that file over
manually, or point the dashboard at a synced copy of the folder (see
[DEPLOY.md](deploy/DEPLOY.md) for a few easy ways to do that).

There's also a plain text box if you'd rather just type or paste a list:

```
250 Glob of Ectoplasm
Obsidian Shard x88
Charr Salvage Kit, 3
```

### Keeping it up to date automatically

Rather than re-selecting the file every time, you can point the dashboard at
the *folder* GWToolbox writes to, and it'll notice and re-import automatically
whenever that file changes — under **Your inventory → watch a folder** in the
dashboard, or with `--watch /path/to/inventories` on the command line.

Every item you own that isn't automatically recognized is still shown, with a
box to name it — nothing you own silently disappears from your total just
because the dashboard didn't recognize it at first glance.

Items are matched by their internal model id wherever possible — the visual
skin, which never changes even when an item rolls different stats — falling
back to a name you've taught it. A built-in table already covers materials,
dyes, and common consumables; an optional, weekly-refreshing catalog can
extend that to weapon and armor skins too (`COMMUNITY_CATALOG_URL` in
`.env.example` — off, and harmless to leave off, by default).

## Sell alerts: "you should probably sell this right now"

Once your inventory is loaded in, the dashboard keeps an eye on it and raises
a **Sell now** alert whenever something you own is fetching noticeably more
than it usually does — comparing the item against its *own* history, not
against some generic rule.

A few things make this genuinely useful rather than noisy:

- It compares like with like — the NPC trader's own price history for things
  the trader buys, or the player market's own recent history for everything
  else. It never compares today's buying price against last month's selling
  price, since that would manufacture a false signal out of nothing.
- An alert, once open, stays open until the price actually drops back down
  meaningfully — so a price bouncing right at the edge doesn't flicker the
  alert on and off every few minutes.
- If you own several things that are all fetching unusually good prices,
  they're ranked by how much extra gold selling today would actually put in
  your pocket — not by how statistically unusual the price is. A single rare
  item at a wild price won't outrank a full stack of materials that are each
  only a little bit up, if the stack adds up to more gold overall.
- The suggested selling price is capped at what the market is genuinely
  paying right now — a good moment to sell isn't licence to ask for more than
  that.

Alerts keep working even while the dashboard tab isn't open, since the
checking happens in the background. You can turn on desktop notifications
from the alerts panel if you want to be told the moment one fires.

## Running it long-term

The short version lives in [DEPLOY.md](deploy/DEPLOY.md) — it covers hosting
this on an Ubuntu server (with or without a password-protected LAN address)
and running it directly on a Windows PC, both in plain language, start to
finish.

A couple of things worth knowing regardless of where you run it:

- **There's no password by default.** Anyone who can reach the address can
  use it, including the parts that change what's stored (like importing
  inventory). That's fine on your own machine, or on a home network you
  trust completely — otherwise, turn on the optional password (`AUTH_USER` /
  `AUTH_PASS` in `.env.example`) or follow the LAN setup in DEPLOY.md, which
  adds both a password and a proper lock icon (HTTPS).
- **Docker is the easiest way to run this on a server.** `docker compose up
  -d --build` is the whole setup — no separate installs, since everything
  the app needs is baked into the container. DEPLOY.md walks through this
  exact command, plus how to add the password-protected LAN address.

## The two in-game economies stay separate

Guild Wars splits into two separate trading economies — Pre-Searing and
Post-Searing — with their own currencies (Black Dye and Globs of Ectoplasm,
respectively, since gold alone loses meaning at high prices). The dashboard
tracks both independently and never mixes a price from one into the other's
history.

## Reading the dashboard

- **Reference** — the one number to quote if someone asks "what's this
  worth", along with where that number came from and how confident it is.
- **Bid / Ask** — what the market's actually paying and asking right now.
- **NPC rate** — what the in-game trader will pay or charge, when it's a
  material the trader deals in. This one never lies.
- **30d** — whether today's price is notably higher or lower than this item's
  own history over the last 60 days.
- **Signal** — a quick read on how unusual the current price is, and how much
  data backs that up. Items with very few recent quotes are marked so you
  know to trust the number a little less.

Clicking any item opens its full detail — going rates broken out by NPC
trader, right now, last 14 days, and last 60 days, plus a chart of price
history over time and the individual quotes that fed into it.

## Known rough edges

- **Trade chat is genuinely ambiguous sometimes.** "Cupcakes 14e" doesn't say
  whether that's per item or per stack, and nothing forces players to be
  clear about it. The dashboard would rather show nothing than guess wrong,
  so some genuine listings just don't get picked up.
- **One-of-a-kind weapons don't have a real "market price."** A weapon's
  actual worth depends on its exact stats and mods, which vary too much for
  a single number to mean anything. Those show up as linked forum
  price-check discussions instead of a price.
- **The upstream sources aren't always up.** Every source is checked
  independently, so if one goes down or gets slow, only that one shows as
  stale — the rest of the dashboard keeps working normally.

---

## More documentation

- **[DEPLOY.md](deploy/DEPLOY.md)** — plain-language setup: an Ubuntu server, or running locally on Windows.
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — how the code is laid out, and how to work on it.
- **[CHANGELOG.md](CHANGELOG.md)** — what's changed, release by release.
- **[docs/OBSIDIAN-VIEW.md](docs/OBSIDIAN-VIEW.md)** — this repo also works as an Obsidian vault, if that's your thing.

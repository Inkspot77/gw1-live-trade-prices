# Changelog

All notable changes to GW1 Live Trade Prices will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.4.0] - 2026-09-11

### Added
- The optional community item catalog now covers far more than weapon/armor
  base skins: trophies, salvage-kit rewards, dyes, keys, kits, minipets,
  quest items, and the individual upgrade components (hafts, grips, pommels,
  insignias) that carry no fingerprint of their own. Real-world testing after
  v1.3.1 showed the packaging fix was working, but the catalog itself only
  ever drew from a fraction of what its upstream source actually documents —
  restricting it to weapon/armor types left the bulk of a typical inventory
  (trophies and materials, mostly) with no coverage at all. Regenerated from
  the same upstream feed using the same flattening rules (cross-type-ambiguous
  ids dropped, not guessed at; a small number of still-templated placeholder
  names dropped too) now used by the weekly refresh, so the two can never
  drift apart: 3,647 entries, up from 2,668.

## [1.3.1] - 2026-09-11

### Fixed
- The Windows installer never actually shipped
  `data/community-item-catalog.json` — the CI step that assembles the
  installer bundle only copied `data/gwtoolbox-items.json` into `dist/data`,
  so the v1.3.0 catalog feature added no identification coverage at all for
  anyone running the installer (Docker and source checkouts were unaffected,
  since those copy the whole repo). The bundling step now copies both files.

## [1.3.0] - 2026-09-11

### Added
- An optional, weekly-refreshing weapon/armor model-id catalog
  (`data/community-item-catalog.json`, refreshed via `COMMUNITY_CATALOG_URL` /
  `--catalog-url`) extends the built-in model-id table to cover the one
  category GWCA's `ItemIDs.h` has no general coverage for: weapon and armor
  base skin names. Off by default, additive only — it can only add coverage
  the built-in tables lack, never override an existing entry, and a missing
  or unreachable feed just leaves the catalog at whatever it was last.

### Fixed
- The inventory folder watcher could silently miss a genuine change: it
  gated on the file's mtime and size before ever reading it, and either can
  coincide between two rapid rewrites (a same-length quantity change leaves
  `size` identical, and two writes landing within one filesystem-clock tick
  can leave `mtimeMs` identical too — seen in practice on WSL2). It now reads
  and content-hashes the file on every check and trusts only that, the same
  hash comparison already used to skip a byte-identical rewrite.

## [1.2.2] - 2026-09-10

### Fixed
- Randomly-generated equipment (a weapon or armor piece rolled with a
  prefix/suffix/inherent mod — "Sundering", "Ebon", "of the Necromancer",
  etc.) never resolved to a name, even after being taught one, because
  GWToolbox's export embeds the item's *complete* name — mods included — in
  its encoded description. Two rolls of the same base item never share a
  fingerprint, so teaching one fingerprint never covered the next drop.
  Naming an item now also teaches its model id (which identifies the item's
  skin, not its rolled mods) when one is present, so one taught name covers
  every past and future drop of that same base item regardless of mods.

## [1.2.1] - 2026-09-09

### Fixed
- Inventory import identified almost nothing beyond the ~30 crafting
  materials: consumables, kits, keys and similar stackable goods had no
  decimal-model-id entry at all, and runes/insignias/dyes were sitting
  unused in `data/gwtoolbox-items.json` (only their names were pulled into
  the trade-chat registry; the exact fingerprints keying them were never
  read back for inventory rows). Added an `other_items` model-id table
  (sourced from GWCA's `ItemIDs.h` and cross-checked against the Guild Wars
  Wiki, kept out of the trade-chat alias matcher on purpose) and a new
  fingerprint-catalog resolution tier that wires up the existing
  runes/insignias/dyes data. On a real account export this roughly doubled
  the items identified without any manual naming.

## [1.2.0] - 2026-09-09

### Added
- User-added price sources: point the dashboard at any URL that returns a
  JSON list of prices, tell it which fields hold the item name and the
  price, and it's polled every 30 minutes alongside the built-in sources —
  no code change needed. Configured and managed entirely from the dashboard
  (Sources → add your own source); tested against the real URL immediately
  on add, so a typo is reported right away instead of failing silently on
  the next scheduled poll. Item names are matched through the same registry
  trade chat uses, so a recognized name lines up with existing history.
- A one-click Windows installer (Inno Setup): bundles a portable Node
  runtime with the app itself, installs to the user's own profile with no
  administrator prompt, and offers an optional "start with Windows"
  checkbox. Uninstalling never deletes `data\prices.db`. Built by CI on
  every push; pushing a `v*` tag now also publishes it as a GitHub Release,
  with the installer's own version and filename matching the tag.
- Automatic backups (`BACKUP_DIR` / `BACKUP_INTERVAL_MINUTES`, both opt-in):
  on a timer, checkpoints the database and copies it to a timestamped file,
  keeping the 24 most recent copies plus one per day for two more weeks.
- Startup catch-up: NPC trader history now backfills itself automatically
  after real downtime (no clean shutdown recorded, or the last one was more
  than 2 hours ago) instead of only when `--backfill` is passed explicitly
  — the backfill was already safe to re-run since it skips any material
  that already has real depth. Graceful `SIGINT`/`SIGTERM` handling records
  the clean-shutdown timestamp this depends on (there was none before).
- A dashboard banner surfacing real downtime: "Offline Xh — NPC trader
  history has been backfilled, trade chat quotes from that window couldn't
  be recovered."

### Fixed
- `.dockerignore` restored — without it, `docker build` would copy `.git/`
  and any local `data/prices.db*` into the image.
- GitHub issue templates were missing their opening `---` frontmatter
  delimiter, so GitHub never recognized `name:`/`about:` as template metadata.
- The CI workflow was GitHub's unmodified "Docker Image CI" scaffold: it
  built an image tagged `my-image-name:$(date +%s)` and never ran the test
  suite. It now runs `node --test` on Node 22.13 before attempting the build.
- `.env.example` documented config keys (`DATABASE_PATH`, `GUILD_NAME`,
  `TRADE_CHANNEL`, ...) that nothing in the app reads, and the app had no
  `.env` support at all. `PORT`/`HOST`/`WATCH_DIR`/`BACKFILL`/`NO_POLL` now
  have the same env-var fallback `AUTH_USER`/`AUTH_PASS` already had, and
  `npm start`/`npm run backfill` load `.env` via Node's built-in
  `--env-file-if-exists` — no dependency added.
- `test/integration.test.mjs` failed to import at all (`fileURLToPath` was
  imported from `node:path` instead of `node:url`) and, once fixed, one of
  its assertions was checking the wrong table (`activeItems()` reads trade-chat
  observations, not owned inventory — `inventory()` does). Also replaced two
  tests that built a throwaway inline `http.createServer` and called it an
  "integration test" with real requests against the actual `startServer()`,
  including the auth gate over the wire.
- `docs/OBSIDIAN-VIEW.md` claimed `.obsidian/` was gitignored; it wasn't
  (the exclusion was commented out). Since the whole point of that doc is a
  shared vault, the doc was wrong, not the intent — fixed the doc, and
  narrowed the actual exclusion to just `workspace.json` (per-session UI
  state that churns on every edit, with no shared meaning).
- The README's Node-version badge queried the npm registry for a package
  that isn't published (`private: true`); replaced with a static badge.

### Removed
- `test-runner.js` — a wrapper around `node --test` whose comments promised
  coverage reporting and watch mode that the code never implemented.
  `npm run test:watch` / `npm run test:coverage` now call Node's own
  `--watch` and `--experimental-test-coverage` directly.
- `test/.env.example` — referenced test config (`COVERAGE_THRESHOLD`,
  `TEST_TIMEOUT`, ...) that nothing reads.
- `Untitled.base` — an empty, unnamed Obsidian Bases file with no source
  folder or filters configured.

## [1.1.0] - 2026-09-06

### Added
- Opt-in HTTP Basic Auth (`--auth-user`/`--auth-pass` or `AUTH_USER`/
  `AUTH_PASS`), timing-safe, off by default, with an unauthenticated
  `/healthz` so container health checks don't need credentials wired in.
- Caddy LAN profile: terminates real TLS via an internal CA covering both a
  LAN hostname and a Tailscale MagicDNS name, with its own basic auth in
  front of the dashboard.

### Fixed
- `--no-poll --backfill` together was a silent no-op — `--backfill` only ran
  inside the same startup branch as the regular poll, so combining it with
  `--no-poll` contacted nothing and backfilled nothing.
- Docker containers took the full stop timeout (10s) and were force-killed on
  every `docker stop`. Node ran as PID 1 of the container's PID namespace
  with no SIGTERM handler; on Linux, an unhandled signal to PID 1 of a
  namespace is dropped rather than falling back to the default action
  (terminate). `init: true` in `docker-compose.yml` runs a proper init as
  PID 1 instead — measured 10s (killed) → 0.3s (clean exit).

## [1.0.0] - 2026-08-24

### Added
- Live trade chat monitoring for both Pre-Searing and Post-Searing economies,
  with a currency parser handling the shorthand players actually type
  (`6 = 100k`, `10a/stk`, `2e`, bundle pricing, stacks, per-unit markers).
- NPC trader quote tracking with 90-day historical backfill, used as the
  objective anchor for the fair-price corridor.
- Pre-Searing price sheet integration from presearing.com.
- Guild Wars Legacy board 12 price-check thread monitoring.
- Wiki demand calendar integration (Nicholas Sandford, Nicholas the
  Traveler, Zaishen quests) so temporary scarcity gets flagged.
- Fair price corridor calculations with robust statistics (median, MAD,
  trimmed IQR) — deliberately symmetric, flagging both overpaying and
  underpaying the other side.
- **Inventory tracking**: import a GWToolbox account-inventory export (or
  type items by hand), with three-tier item identification (model ID,
  learned fingerprint, name-hint matching) and a folder watcher that
  re-imports automatically when the export file changes.
- **Sell alerts**: a hysteretic alert engine that flags when something you
  own is fetching more than its own historical baseline, ranked by total
  gold captured rather than raw statistical unusualness.
- Docker deployment: Compose file, Dockerfile, and a one-shot deploy script
  for pushing to a remote host over SSH.
- Test suite covering the currency/item parsers, the analytics engine, the
  inventory importer, and the folder watcher.

### Technical
- Node.js 22.13+ with the built-in `node:sqlite` (no external database
  dependency).
- ES Modules throughout, zero runtime dependencies.
- A small JSON API served alongside the static dashboard from a single
  `node:http` server.
- SQLite in WAL mode for the accumulated price history — the one thing that
  can't be re-fetched, since upstream sources only expose a live window.

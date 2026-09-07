# Changelog

All notable changes to GW1 Live Trade Prices will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

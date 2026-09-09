# Contributing to GW1 Live Trade Prices

Thank you for your interest in contributing to GW1 Live Trade Prices! This document provides guidelines for contributing to the project.

## Getting Started

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Run tests to ensure everything works (`npm test`)
5. Submit a pull request

## Development Setup

1. Ensure you have Node.js 22.13+ or 23.4+ installed
2. Clone your fork
3. Install dependencies (if any external packages are added)
4. Run the application: `npm start`
5. Run backfill for full data: `npm run backfill`

## Project layout

```
bin/gw1-prices.mjs     entry point
src/
  server.mjs           HTTP server + JSON API (loopback only)
  poller.mjs           per-source schedules, isolated failures
  db.mjs               SQLite schema and queries
  analytics.mjs        robust statistics, deal scoring, the anti-gouging guardrail
  parse/
    currency.mjs       "6 = 100k", "10a/stk", "2e", "1bd" -> gold
    items.mjs          item registry and the alias matcher
    trade.mjs          one chat line -> structured quotes
    inventory.mjs      GWToolbox account file / typed list -> your holdings
  valuation.mjs        per-item analysis, inventory pricing, the alert engine
  watcher.mjs          folder watch -> automatic inventory re-import
  sources/             one adapter per site
public/                dashboard (vanilla JS, inline SVG charts)
data/prices.db         accumulated history + imported inventory
```

## Notes on hosting internals

These are implementation details behind [DEPLOY.md](deploy/DEPLOY.md)'s
plain-language steps — useful if you're changing the Docker setup or the
auth code, not needed just to run the app.

- **Authentication is opt-in Basic Auth** (`AUTH_USER`/`AUTH_PASS`), checked
  with a timing-safe comparison. Basic Auth sends credentials base64-encoded
  on every request — trivially decodable, not encrypted. It's fine over a
  transport that's already encrypted (an SSH tunnel, Tailscale, WireGuard, or
  the Caddy TLS profile in `docker-compose.yml`'s `lan` profile); it is not a
  substitute for TLS on the open internet. `GET /healthz` always answers
  `200` with no credentials required, so a container health check keeps
  working without the password wired into it.
- **The Docker image needs Node ≥22.13** for `node:sqlite` to load
  unflagged. The `Dockerfile` checks this at build time and fails loudly if
  it doesn't, rather than shipping an image that 500s on first request.
- **`init: true` in `docker-compose.yml` is load-bearing, not decoration.**
  Without it, Node runs as PID 1 of the container's PID namespace, and a
  Linux kernel quirk means an *unhandled* SIGTERM is silently dropped
  instead of falling back to its default action (terminate) — `docker stop`
  then burns its full timeout and force-kills every time. Measured: 10s
  (killed) without `init: true`, 0.3s (clean exit) with it.
- **A systemd unit exists as an alternative to Docker** —
  `deploy/gw1-prices.service` and `deploy/preflight.sh`, for running the
  plain Node process as a service on bare metal. Not currently walked
  through step by step anywhere; the comments in each file are the
  reference.

## Code Style

- Use JavaScript modules (ESM)
- Follow the existing code structure
- Keep code DRY and maintainable
- Add comments for complex logic

## Testing

All contributions should include tests where appropriate:

```bash
npm test
```

The test suite includes:
- Alert logic tests
- Authentication tests
- Parsing logic tests
- Watcher tests
- Integration tests (the real HTTP server, actually listening, hit with real requests)

`npm run test:watch` reruns on file change; `npm run test:coverage` prints a
per-file coverage report. Both use Node's own built-in test-runner flags —
no dependency, no separate config.

## Documentation

- Update README.md for new features
- Update CHANGELOG.md with version changes
- Add inline comments for complex logic

## Pull Request Process

1. Update README.md if you add new configuration options
2. Update CHANGELOG.md with your version
3. Ensure all tests pass
4. Your PR will be reviewed and merged if approved

## Cutting a release

`package.json`'s `version` and CHANGELOG.md's version headers should always
match the git tag that triggers a release — nothing enforces this
automatically, so it's on whoever cuts the release to keep them in sync:

1. Move `## [Unreleased]`'s contents into a new `## [vX.Y.Z] - YYYY-MM-DD`
   section (leave a fresh empty `## [Unreleased]` above it).
2. Bump `"version"` in `package.json` to match.
3. Commit that, then tag and push:
   ```bash
   git tag vX.Y.Z
   git push origin main vX.Y.Z
   ```
   Pushing the tag triggers CI to build the Windows installer (its own
   version and filename come from the tag itself, via Inno Setup's
   `/DMyAppVersion`) and publish it as a GitHub Release automatically — see
   the `release` job in `.github/workflows/docker-image.yml`.

## Community Guidelines

- Be respectful and inclusive
- Help newcomers
- Provide constructive feedback

## Questions?

Open an issue or reach out to the project maintainers.
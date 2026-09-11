/**
 * HTTP server: static dashboard plus a small read-only JSON API.
 *
 * Binds to loopback only. This reads other people's public endpoints on your
 * behalf and stores the result locally; it is not something to expose.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { openDatabase } from './db.mjs';
import { Poller } from './poller.mjs';
import { REALMS } from './parse/items.mjs';
import { parseToolboxInventory, parsePastedInventory } from './parse/inventory.mjs';
import {
  evaluatePrice, RATING_LABEL, WINDOWS, DAY, SELL_ALERT_Z, SELL_CLEAR_Z,
} from './analytics.mjs';
import {
  buildAnalysis, buildLookups, opportunityScore,
  valueInventory, importInventory, evaluateSellAlerts,
} from './valuation.mjs';
import { InventoryWatcher } from './watcher.mjs';
import { createAuthGate } from './auth.mjs';
import { fetchCustomSource } from './sources/custom.mjs';
import { Backup } from './backup.mjs';

// A boot more than this long after the last clean shutdown is treated as
// "real downtime" — worth an unprompted trader-history catch-up rather than
// waiting for --backfill to be asked for explicitly. Short gaps (a restart
// to pick up a new version, a crash caught within a couple of minutes) don't
// need it: pollAll() already re-syncs everything else on every boot.
const CATCH_UP_AFTER_MS = 2 * 60 * 60 * 1000;

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'cache-control': 'no-store', ...headers });
  res.end(body);
}

function sendJson(res, status, payload) {
  send(res, status, JSON.stringify(payload), { 'content-type': MIME['.json'] });
}

/** The dashboard's main table: everything with recent activity, ranked. */
function overview(store, { realm = null, now = Date.now() } = {}) {
  const active = store.activeItems(now - WINDOWS.recent * DAY, realm);
  const lookups = buildLookups(store);

  const rows = active.map((row) => {
    const analysis = buildAnalysis(store, row.realm, row.item, now, lookups);
    return {
      item: row.item,
      realm: row.realm,
      category: analysis.category ?? row.category,
      reference: analysis.reference,
      spotAsk: analysis.spot.ask?.median ?? null,
      spotBid: analysis.spot.bid?.median ?? null,
      fair: analysis.fair,
      trader: analysis.trader,
      trend: analysis.trend,
      liquidity: analysis.liquidity,
      demand: analysis.demand,
      warnings: analysis.warnings,
      lastSeen: analysis.lastSeen,
      sampleSize: analysis.sampleSize,
      // "Opportunity" ranks how far spot sits from the longer baseline: the
      // items where acting today differs most from acting on an average day.
      opportunity: opportunityScore(analysis),
    };
  });

  const seen = new Set(rows.map((r) => `${r.realm}|${r.item}`));

  const addRow = (analysis, item, itemRealm, category) => {
    seen.add(`${itemRealm}|${item}`);
    rows.push({
      item,
      realm: itemRealm,
      category: analysis.category ?? category,
      reference: analysis.reference,
      spotAsk: analysis.spot.ask?.median ?? null,
      spotBid: analysis.spot.bid?.median ?? null,
      fair: analysis.fair,
      trader: analysis.trader,
      trend: analysis.trend,
      liquidity: analysis.liquidity,
      demand: analysis.demand,
      warnings: analysis.warnings,
      lastSeen: analysis.lastSeen,
      sampleSize: analysis.sampleSize,
      opportunity: opportunityScore(analysis),
    });
  };

  // Materials the NPC trader quotes are the most objectively priced items in
  // the game and carry the deepest history, but chat rarely names them — so
  // they would otherwise never appear. Include them unconditionally.
  if (realm === null || realm === REALMS.POST) {
    for (const item of lookups.trader.keys()) {
      if (seen.has(`${REALMS.POST}|${item}`)) continue;
      addRow(buildAnalysis(store, REALMS.POST, item, now, lookups), item, REALMS.POST, 'Material');
    }
  }

  // Items known only from the Pre-Searing guide still deserve a row; they are
  // the bulk of that economy and chat rarely mentions them.
  if (realm === null || realm === REALMS.PRE) {
    for (const s of store.allSheetItems()) {
      const key = `${REALMS.PRE}|${s.item}`;
      if (seen.has(key)) continue;
      const analysis = buildAnalysis(store, REALMS.PRE, s.item, now, lookups);
      if (analysis.reference.value === null) continue;
      addRow(analysis, s.item, REALMS.PRE, s.category);
    }
  }

  // On a fresh database every opportunity score is 0, because the spot and
  // baseline windows still cover the same few hours. Falling back to activity
  // keeps the table useful from the first minute instead of showing noise.
  return rows.sort((a, b) => {
    const byOpportunity = Math.abs(b.opportunity) - Math.abs(a.opportunity);
    if (Math.abs(byOpportunity) > 0.01) return byOpportunity;
    const byActivity = b.sampleSize - a.sampleSize;
    if (byActivity !== 0) return byActivity;
    return a.item.localeCompare(b.item);
  });
}


/** Read and size-limit a JSON or text request body. */
async function readBody(req, limit = 12 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}


export async function startServer({
  port = 8787,
  host = '127.0.0.1',
  dbPath = join(ROOT, 'data', 'prices.db'),
  poll = true,
  backfill = false,
  watch = null,
  authUser = null,
  authPass = null,
  backupDir = null,
  backupIntervalMinutes = 60,
  catalogUrl = null,
} = {}) {
  // Half-configured auth (only a user, or only a password) is worse than
  // none: it looks protected but the gate below would never actually block
  // anything, since createAuthGate() only enables when both are present.
  if (Boolean(authUser) !== Boolean(authPass)) {
    throw new Error('--auth-user and --auth-pass must both be set, or neither.');
  }
  const auth = createAuthGate(authUser && authPass ? { user: authUser, pass: authPass } : null);

  const store = openDatabase(dbPath);
  const poller = new Poller(store, { catalogUrl });
  const watcher = new InventoryWatcher(store, poller);
  // Opt-in, like --watch and auth: only runs at all once a directory is given.
  const backup = backupDir ? new Backup(store, dbPath, backupDir) : null;

  const routes = {
    '/api/overview': (url) => overview(store, { realm: url.searchParams.get('realm') || null }),

    '/api/item': (url) => {
      const item = url.searchParams.get('item');
      const realm = url.searchParams.get('realm') || REALMS.POST;
      if (!item) return { error: 'item is required' };

      const analysis = buildAnalysis(store, realm, item);
      const since = Date.now() - WINDOWS.baseline * DAY;
      return {
        ...analysis,
        observations: store.observations(realm, item, since).slice(0, 200),
        traderHistory: store.traderHistory(item, since),
        threads: store.threadsFor([item]).slice(0, 12),
        ratingLabels: RATING_LABEL,
      };
    },

    '/api/evaluate': (url) => {
      const item = url.searchParams.get('item');
      const realm = url.searchParams.get('realm') || REALMS.POST;
      const price = Number(url.searchParams.get('price'));
      const intent = url.searchParams.get('intent') === 'sell' ? 'sell' : 'buy';
      if (!item) return { error: 'item is required' };
      const analysis = buildAnalysis(store, realm, item);
      const verdict = evaluatePrice(analysis, price, intent);
      return { item, realm, price, intent, ...verdict, label: RATING_LABEL[verdict.rating], fair: analysis.fair, reference: analysis.reference };
    },

    '/api/context': () => ({
      daily: store.getContext('daily'),
      sandford: store.getContext('sandford'),
      traveler: store.getContext('traveler'),
      rates: store.getContext('rates') ?? poller.rates,
      sourceStatus: store.getContext('sourceStatus') ?? {},
      stats: store.stats(),
      windows: WINDOWS,
      lastCleanShutdown: store.getContext('lastCleanShutdown'),
    }),

    '/api/threads': () => store.threadsFor(null),

    '/api/inventory': () => valueInventory(store, poller),

    '/api/inventory/watch': () => watcher.status(),

    /** Open alerts, newest peak first, plus the unseen count for the badge. */
    '/api/alerts': () => ({
      open: store.openAlerts(),
      recent: store.recentAlerts(20),
      unseen: store.unseenAlertCount(),
      thresholds: { fire: SELL_ALERT_Z, clear: SELL_CLEAR_Z },
    }),

    /** User-added sources, in whatever order they were added. */
    '/api/sources/custom': () => store.getContext('customSources') ?? [],

    '/api/search': (url) => {
      const q = String(url.searchParams.get('q') ?? '').toLowerCase().trim();
      if (q.length < 2) return [];
      const names = new Set();
      for (const item of poller.registry.list()) {
        if (item.name.toLowerCase().includes(q)) names.add(JSON.stringify({ item: item.name, realm: item.realm, category: item.category }));
      }
      return [...names].slice(0, 40).map((s) => JSON.parse(s));
    },
  };

  const postRoutes = {
    /**
     * Import holdings. Accepts either a GWToolbox account inventory file
     * (`inventories/tmp<account-guid>.json`) or free text you have typed.
     */
    '/api/inventory/import': (body, url) => {
      const mode = url.searchParams.get('mode');
      const trimmed = body.trim();
      if (!trimmed) return { error: 'nothing to import' };

      const looksLikeJson = trimmed.startsWith('{');
      const parsed = mode === 'text' || !looksLikeJson
        ? parsePastedInventory(trimmed)
        : parseToolboxInventory(trimmed);

      const source = parsed.owners[0] === 'Manual entry' ? 'typed' : 'GWToolbox file';
      const rows = importInventory(store, poller, parsed, source);
      // New holdings may already be sitting at a good price; say so immediately
      // rather than making the user wait for the next poll.
      const alerts = evaluateSellAlerts(store, poller);
      return {
        alerts: alerts.open.length,
        ok: true,
        source,
        stacks: parsed.items.length,
        items: rows.length,
        identified: rows.filter((r) => r.name).length,
        owners: parsed.owners,
      };
    },

    /** Teach the importer what an unidentified fingerprint actually is. */
    '/api/inventory/name': (body) => {
      const { fingerprint, item, modelId } = JSON.parse(body || '{}');
      if (!fingerprint || !item) return { error: 'fingerprint and item are both required' };
      store.learnFingerprint(String(fingerprint), String(item));
      // modelId (when present) identifies the item's skin rather than this one
      // roll's mods, so teaching it here also resolves every other drop of the
      // same base item - see resolveNames() for why the two are learned
      // separately rather than one covering the other.
      const parsedModelId = Number(modelId);
      const learnedModelId = Number.isFinite(parsedModelId) && parsedModelId > 0 ? parsedModelId : null;
      if (learnedModelId) store.learnModel(learnedModelId, String(item));
      return { ok: true, fingerprint, item, modelId: learnedModelId };
    },

    /** Re-run the alert engine now instead of waiting for the next poll. */
    '/api/alerts/check': () => {
      const result = evaluateSellAlerts(store, poller);
      return { ok: true, opened: result.opened.length, closed: result.closed.length, open: result.open };
    },

    '/api/alerts/seen': () => ({ ok: true, marked: store.markAlertsSeen() }),

    /** Point the watcher at a folder (or clear it by sending an empty path). */
    '/api/inventory/watch': async (body) => {
      const { path, enabled = true } = JSON.parse(body || '{}');
      return watcher.configure({ path, enabled });
    },

    /** Force a re-read even if the file looks unchanged. */
    '/api/inventory/watch/check': async () => {
      const result = await watcher.checkNow({ force: true });
      return { ok: true, imported: result, status: watcher.status() };
    },

    '/api/inventory/clear': () => {
      store.saveInventory([]);
      store.setContext('inventoryMeta', null);
      return { ok: true };
    },

    /**
     * Add a user-defined price source: a URL returning a JSON array, plus the
     * field names that mean "item" and "price" within each entry. Tested once
     * immediately so a typo in a field name is reported right away rather
     * than silently producing zero rows on the next scheduled poll.
     */
    '/api/sources/custom': async (body) => {
      const cfg = JSON.parse(body || '{}');
      const { name, url, itemField, priceField } = cfg;
      if (!name || !url || !itemField || !priceField) {
        return { error: 'name, url, itemField and priceField are all required' };
      }

      const entry = {
        id: randomUUID(),
        name: String(name).slice(0, 60),
        url: String(url),
        realm: cfg.realm === 'pre' ? 'pre' : 'post',
        path: String(cfg.path ?? ''),
        itemField: String(itemField),
        priceField: String(priceField),
        sideField: cfg.sideField ? String(cfg.sideField) : null,
        side: cfg.side === 'bid' ? 'bid' : 'ask',
        qtyField: cfg.qtyField ? String(cfg.qtyField) : null,
        enabled: true,
        addedAt: Date.now(),
      };

      let test;
      try {
        test = await fetchCustomSource(entry);
      } catch (error) {
        return { error: `Could not use this source: ${error.message}` };
      }

      const existing = store.getContext('customSources') ?? [];
      store.setContext('customSources', [...existing, entry]);
      // Poll every configured custom source now (not just this one) rather
      // than making the user wait up to 30 minutes to see it show up — cheap,
      // and pollCustomSources() already marks each source's own status.
      await poller.pollCustomSources();
      return { ok: true, source: entry, testedRows: test.rows.length, testedTotal: test.total };
    },

    '/api/sources/custom/remove': (body) => {
      const { id } = JSON.parse(body || '{}');
      const existing = store.getContext('customSources') ?? [];
      const next = existing.filter((s) => s.id !== id);
      store.setContext('customSources', next);
      return { ok: true, removed: existing.length - next.length };
    },
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // Unauthenticated on purpose: lets a container/orchestrator health check
    // confirm the process is alive without needing credentials wired through.
    // It reveals nothing beyond "the server is up", same as an open port would.
    if (url.pathname === '/healthz') {
      return send(res, 200, 'ok', { 'content-type': 'text/plain' });
    }

    if (auth.enabled && !auth.check(req)) {
      return auth.demandAuth(res);
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      const handler = postRoutes[url.pathname];
      if (!handler) return sendJson(res, 404, { error: 'no such endpoint' });
      try {
        const body = await readBody(req);
        return sendJson(res, 200, await handler(body, url));
      } catch (error) {
        return sendJson(res, 400, { error: error.message });
      }
    }

    if (url.pathname.startsWith('/api/')) {
      const handler = routes[url.pathname];
      if (!handler) return sendJson(res, 404, { error: 'no such endpoint' });
      try {
        return sendJson(res, 200, await handler(url));
      } catch (error) {
        return sendJson(res, 500, { error: error.message });
      }
    }

    // Static files, path-traversal guarded.
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const target = join(PUBLIC_DIR, normalize(rel));
    if (!target.startsWith(PUBLIC_DIR)) return send(res, 403, 'forbidden');
    try {
      const body = await readFile(target);
      return send(res, 200, body, { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' });
    } catch {
      return send(res, 404, 'not found');
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        reject(new Error(
          `Port ${port} is already in use — another copy may still be running. `
          + `Stop it, or start this one with --port <other>.`,
        ));
        return;
      }
      reject(error);
    });
    server.listen(port, host, resolve);
  });
  console.log(`EctoWatch -> http://${host}:${port}`);
  if (auth.enabled) {
    console.log(`Basic Auth: enabled (user "${authUser}")`);
  } else if (host !== '127.0.0.1' && host !== 'localhost') {
    console.log(
      `⚠ Basic Auth is NOT enabled and this server is bound to ${host}, not loopback. `
      + 'Set --auth-user/--auth-pass (or AUTH_USER/AUTH_PASS) before exposing this further.',
    );
  }

  // A path given on the command line wins over the stored one, so a shortcut
  // can pin the folder without editing anything through the UI.
  if (watch) {
    await watcher.configure({ path: watch, enabled: true });
  } else {
    watcher.start();
    await watcher.checkNow();
  }

  if (poll) {
    await poller.pollAll();
    // backfillTraderHistory() skips any material that already has real depth,
    // so it's safe to run unprompted after real downtime — no separate
    // gap-detection needed, just "was the last shutdown clean and recent?".
    const lastCleanShutdown = store.getContext('lastCleanShutdown');
    const realDowntime = !lastCleanShutdown || Date.now() - lastCleanShutdown > CATCH_UP_AFTER_MS;
    if (backfill || realDowntime) await poller.run('backfill', () => poller.backfillTraderHistory());
    poller.start();
  }

  if (backup) backup.start(backupIntervalMinutes);

  return {
    server, store, poller, watcher, backup,
  };
}

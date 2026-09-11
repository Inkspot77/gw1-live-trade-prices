/**
 * Storage. Uses node:sqlite (built into Node 22+), so the project has no
 * dependencies to install and the whole price history is one portable file.
 *
 * The point of persisting is that *no upstream source keeps a player-market
 * price history*. GWToolbox archives NPC trader quotes only; the Pre-Searing
 * sheet is a handful of manual snapshots. Everything else is a live window a
 * few hundred messages wide. Polling and storing is what turns that into the
 * historical baseline the deal scoring needs.
 */

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS observations (
  hash        TEXT PRIMARY KEY,
  ts          INTEGER NOT NULL,
  source      TEXT NOT NULL,
  realm       TEXT NOT NULL,
  item        TEXT NOT NULL,
  category    TEXT,
  side        TEXT NOT NULL,
  unit_gold   REAL NOT NULL,
  currency    TEXT NOT NULL,
  qty         INTEGER NOT NULL DEFAULT 1,
  confidence  REAL NOT NULL DEFAULT 1,
  seller      TEXT,
  raw         TEXT
);
CREATE INDEX IF NOT EXISTS idx_obs_item ON observations (realm, item, ts DESC);
CREATE INDEX IF NOT EXISTS idx_obs_ts   ON observations (ts DESC);

-- NPC material-trader quotes: the hard floor and ceiling of the economy.
CREATE TABLE IF NOT EXISTS trader_quotes (
  ts        INTEGER NOT NULL,
  model_id  TEXT NOT NULL,
  item      TEXT NOT NULL,
  side      TEXT NOT NULL,          -- 'ask' = you pay, 'bid' = trader pays you
  gold      REAL NOT NULL,
  PRIMARY KEY (ts, model_id, side)
);
CREATE INDEX IF NOT EXISTS idx_trader_item ON trader_quotes (item, ts DESC);

-- Dated low/high bands from the Pre-Searing community price sheet.
CREATE TABLE IF NOT EXISTS sheet_prices (
  item      TEXT NOT NULL,
  category  TEXT,
  realm     TEXT NOT NULL,
  as_of     INTEGER NOT NULL,
  low_gold  REAL,
  high_gold REAL,
  PRIMARY KEY (item, as_of)
);

-- Price-check threads from Guild Wars Legacy, linked to items where possible.
CREATE TABLE IF NOT EXISTS forum_threads (
  url        TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  posted_at  INTEGER,
  items      TEXT
);

-- Your own holdings. Replaced wholesale on each import: this is a snapshot of
-- what you have now, not a history of what you have owned.
CREATE TABLE IF NOT EXISTS inventory_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT,              -- null when the item could not be identified
  fingerprint TEXT,              -- stable per item type; the key we learn against
  model_id    INTEGER,
  hint        TEXT,              -- readable fragment of the encoded name, if any
  realm       TEXT NOT NULL,
  quantity    INTEGER NOT NULL,
  locations   TEXT NOT NULL      -- JSON: which character/bag each stack sits in
);
CREATE INDEX IF NOT EXISTS idx_inv_name ON inventory_items (name);

-- Fingerprints you have named by hand. This is what makes unidentified items a
-- one-time cost rather than a recurring one — for items whose encoded name has
-- no random component, so every instance shares one fingerprint forever.
CREATE TABLE IF NOT EXISTS item_fingerprints (
  fingerprint TEXT PRIMARY KEY,
  item        TEXT NOT NULL,
  learned_at  INTEGER NOT NULL
);

-- Model ids you have named by hand. A randomly-generated weapon or armor
-- piece's encoded description embeds its rolled prefix/suffix/inherent mods
-- right alongside the base name, so no two "Sundering X of Y" drops share a
-- fingerprint even when X is identical — teaching one by fingerprint alone
-- never generalizes. The model id, in contrast, identifies the item's visual
-- skin, which mods never change, so one taught name here covers every past
-- and future drop of that same base item regardless of what it rolls with.
CREATE TABLE IF NOT EXISTS item_models (
  model_id    INTEGER PRIMARY KEY,
  item        TEXT NOT NULL,
  learned_at  INTEGER NOT NULL
);

-- Sell alerts. One open row per item at a time: an alert fires when the price
-- crosses the threshold and closes when it falls back, so a price hovering on
-- the boundary cannot produce a stream of duplicates.
CREATE TABLE IF NOT EXISTS alerts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  item         TEXT NOT NULL,
  realm        TEXT NOT NULL,
  fired_at     INTEGER NOT NULL,
  cleared_at   INTEGER,
  seen_at      INTEGER,
  peak_z       REAL NOT NULL,
  peak_edge    REAL NOT NULL,
  quantity     INTEGER NOT NULL,
  suggested    REAL,
  basis        TEXT,
  reason       TEXT
);
CREATE INDEX IF NOT EXISTS idx_alerts_open ON alerts (cleared_at, fired_at DESC);

-- Small key/value store: wiki dailies, live currency rates, poll bookkeeping.
CREATE TABLE IF NOT EXISTS context (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Total holdings value over time, recorded periodically so "why did my
-- inventory swing" has a real answer instead of only ever showing the
-- current instant. 'items' is a trimmed copy of that moment's priced rows
-- (name/realm/quantity/unit/value/source) - enough to explain a later swing
-- without trying to reconstruct history that was never recorded. Never
-- backfilled: a fresh install starts this table empty rather than faking a
-- past that assumes today's holdings were also yesterday's.
CREATE TABLE IF NOT EXISTS inventory_snapshots (
  ts     INTEGER PRIMARY KEY,
  total  REAL NOT NULL,
  items  TEXT NOT NULL
);
`;

export function openDatabase(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec(SCHEMA);
  return new Store(db);
}

function safeParse(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** Stable identity for a quote so re-polling the same window is idempotent. */
function observationHash(o) {
  return createHash('sha1')
    .update([o.ts, o.source, o.item, o.side, Math.round(o.unitGold), o.seller ?? ''].join('|'))
    .digest('hex')
    .slice(0, 20);
}

export class Store {
  constructor(db) {
    this.db = db;
    this.stmt = {
      insertObservation: db.prepare(`
        INSERT OR IGNORE INTO observations
          (hash, ts, source, realm, item, category, side, unit_gold, currency, qty, confidence, seller, raw)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      insertTrader: db.prepare(`
        INSERT OR REPLACE INTO trader_quotes (ts, model_id, item, side, gold)
        VALUES (?, ?, ?, ?, ?)`),
      insertSheet: db.prepare(`
        INSERT OR REPLACE INTO sheet_prices (item, category, realm, as_of, low_gold, high_gold)
        VALUES (?, ?, ?, ?, ?, ?)`),
      insertThread: db.prepare(`
        INSERT OR REPLACE INTO forum_threads (url, title, posted_at, items)
        VALUES (?, ?, ?, ?)`),
      setContext: db.prepare(`
        INSERT OR REPLACE INTO context (key, value, updated_at) VALUES (?, ?, ?)`),
      getContext: db.prepare('SELECT value, updated_at FROM context WHERE key = ?'),
      insertInventory: db.prepare(`
        INSERT INTO inventory_items (name, fingerprint, model_id, hint, realm, quantity, locations)
        VALUES (?, ?, ?, ?, ?, ?, ?)`),
      learnFingerprint: db.prepare(`
        INSERT OR REPLACE INTO item_fingerprints (fingerprint, item, learned_at)
        VALUES (?, ?, ?)`),
      learnModel: db.prepare(`
        INSERT OR REPLACE INTO item_models (model_id, item, learned_at)
        VALUES (?, ?, ?)`),
    };
  }

  /** @returns {number} how many rows were genuinely new */
  saveObservations(rows) {
    let inserted = 0;
    this.db.exec('BEGIN');
    try {
      for (const o of rows) {
        const result = this.stmt.insertObservation.run(
          observationHash(o), o.ts, o.source, o.realm, o.item, o.category ?? null,
          o.side, o.unitGold, o.currency, o.qty ?? 1, o.confidence ?? 1,
          o.seller ?? null, o.raw ?? null,
        );
        inserted += result.changes;
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return inserted;
  }

  saveTraderQuotes(rows) {
    this.db.exec('BEGIN');
    try {
      for (const q of rows) {
        this.stmt.insertTrader.run(q.ts, q.modelId, q.item, q.side, q.gold);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return rows.length;
  }

  saveSheetPrices(rows) {
    this.db.exec('BEGIN');
    try {
      for (const r of rows) {
        this.stmt.insertSheet.run(r.item, r.category ?? null, r.realm, r.asOf, r.lowGold, r.highGold);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return rows.length;
  }

  saveThreads(rows) {
    for (const t of rows) {
      this.stmt.insertThread.run(t.url, t.title, t.postedAt ?? null, JSON.stringify(t.items ?? []));
    }
    return rows.length;
  }

  setContext(key, value) {
    this.stmt.setContext.run(key, JSON.stringify(value), Date.now());
  }

  getContext(key, fallback = null) {
    const row = this.stmt.getContext.get(key);
    if (!row) return fallback;
    try {
      return JSON.parse(row.value);
    } catch {
      return fallback;
    }
  }

  /** Every observation for one item, newest first. */
  observations(realm, item, sinceMs) {
    return this.db.prepare(`
      SELECT ts, source, side, unit_gold AS unitGold, currency, qty, confidence, seller, raw
      FROM observations WHERE realm = ? AND item = ? AND ts >= ?
      ORDER BY ts DESC`).all(realm, item, sinceMs);
  }

  /** Items with recent activity, most active first. */
  activeItems(sinceMs, realm = null) {
    const where = realm ? 'WHERE ts >= ? AND realm = ?' : 'WHERE ts >= ?';
    const args = realm ? [sinceMs, realm] : [sinceMs];
    return this.db.prepare(`
      SELECT item, realm, category, COUNT(*) AS n,
             MAX(ts) AS lastSeen,
             SUM(CASE WHEN side = 'ask' THEN 1 ELSE 0 END) AS asks,
             SUM(CASE WHEN side = 'bid' THEN 1 ELSE 0 END) AS bids
      FROM observations ${where}
      GROUP BY realm, item ORDER BY n DESC`).all(...args);
  }

  traderHistory(item, sinceMs) {
    return this.db.prepare(`
      SELECT ts, side, gold FROM trader_quotes WHERE item = ? AND ts >= ?
      ORDER BY ts ASC`).all(item, sinceMs);
  }

  latestTraderQuotes() {
    return this.db.prepare(`
      SELECT t.item, t.side, t.gold, t.ts, t.model_id AS modelId
      FROM trader_quotes t
      JOIN (SELECT item, side, MAX(ts) AS ts FROM trader_quotes GROUP BY item, side) m
        ON m.item = t.item AND m.side = t.side AND m.ts = t.ts`).all();
  }

  sheetHistory(item) {
    return this.db.prepare(`
      SELECT as_of AS asOf, low_gold AS lowGold, high_gold AS highGold
      FROM sheet_prices WHERE item = ? ORDER BY as_of ASC`).all(item);
  }

  allSheetItems() {
    return this.db.prepare(`
      SELECT item, category, realm, MAX(as_of) AS asOf
      FROM sheet_prices GROUP BY item ORDER BY item`).all();
  }

  threadsFor(items) {
    if (!items?.length) {
      return this.db.prepare(
        'SELECT url, title, posted_at AS postedAt, items FROM forum_threads ORDER BY posted_at DESC LIMIT 40',
      ).all();
    }
    const rows = this.db.prepare(
      'SELECT url, title, posted_at AS postedAt, items FROM forum_threads ORDER BY posted_at DESC LIMIT 400',
    ).all();
    const wanted = new Set(items);
    return rows.filter((r) => {
      try {
        return JSON.parse(r.items).some((i) => wanted.has(i));
      } catch {
        return false;
      }
    });
  }

  /** The currently-open alert for an item, if any. */
  openAlert(item, realm) {
    return this.db.prepare(
      'SELECT * FROM alerts WHERE item = ? AND realm = ? AND cleared_at IS NULL LIMIT 1',
    ).get(item, realm) ?? null;
  }

  openAlerts() {
    return this.db.prepare(
      'SELECT * FROM alerts WHERE cleared_at IS NULL ORDER BY peak_edge DESC',
    ).all();
  }

  recentAlerts(limit = 40) {
    return this.db.prepare(
      'SELECT * FROM alerts ORDER BY fired_at DESC LIMIT ?',
    ).all(limit);
  }

  fireAlert(alert) {
    const result = this.db.prepare(`
      INSERT INTO alerts (item, realm, fired_at, peak_z, peak_edge, quantity, suggested, basis, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      alert.item, alert.realm, Date.now(), alert.z, alert.edgeTotal,
      alert.quantity, alert.suggested ?? null, alert.basis ?? null, alert.reason ?? null,
    );
    return Number(result.lastInsertRowid);
  }

  /** Keep an open alert showing the best it has been, not merely the latest. */
  updateAlertPeak(id, { z, edgeTotal, suggested, reason }) {
    this.db.prepare(`
      UPDATE alerts
      SET peak_z = MAX(peak_z, ?), peak_edge = MAX(peak_edge, ?), suggested = ?, reason = ?
      WHERE id = ?`).run(z, edgeTotal, suggested ?? null, reason ?? null, id);
  }

  clearAlert(id) {
    this.db.prepare('UPDATE alerts SET cleared_at = ? WHERE id = ?').run(Date.now(), id);
  }

  markAlertsSeen() {
    const result = this.db.prepare(
      'UPDATE alerts SET seen_at = ? WHERE seen_at IS NULL',
    ).run(Date.now());
    return result.changes;
  }

  unseenAlertCount() {
    return this.db.prepare(
      'SELECT COUNT(*) AS n FROM alerts WHERE seen_at IS NULL AND cleared_at IS NULL',
    ).get().n;
  }

  /** Replace the stored inventory wholesale. */
  saveInventory(rows) {
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM inventory_items');
      for (const r of rows) {
        this.stmt.insertInventory.run(
          r.name ?? null, r.fingerprint ?? null, r.modelId ?? null, r.hint ?? null,
          r.realm ?? 'post', r.quantity, JSON.stringify(r.locations ?? []),
        );
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return rows.length;
  }

  inventory() {
    return this.db.prepare(`
      SELECT name, fingerprint, model_id AS modelId, hint, realm, quantity, locations
      FROM inventory_items ORDER BY quantity DESC`).all()
      .map((r) => ({ ...r, locations: safeParse(r.locations, []) }));
  }

  /** Record one point in the inventory's value-over-time history. */
  saveInventorySnapshot({ ts, total, items }) {
    this.db.prepare(`
      INSERT OR REPLACE INTO inventory_snapshots (ts, total, items) VALUES (?, ?, ?)
    `).run(ts, total, JSON.stringify(items ?? []));
  }

  /** Just the totals, oldest first — all the value-over-time chart needs. */
  inventorySnapshotTotals(sinceMs) {
    return this.db.prepare(`
      SELECT ts, total FROM inventory_snapshots WHERE ts >= ? ORDER BY ts ASC
    `).all(sinceMs);
  }

  /** The recorded snapshot at exactly this timestamp, if one exists. */
  inventorySnapshotAt(ts) {
    const row = this.db.prepare(
      'SELECT ts, total, items FROM inventory_snapshots WHERE ts = ?',
    ).get(ts);
    return row ? { ...row, items: safeParse(row.items, []) } : null;
  }

  /** The snapshot immediately before `ts` — the other half of "what changed". */
  inventorySnapshotBefore(ts) {
    const row = this.db.prepare(
      'SELECT ts, total, items FROM inventory_snapshots WHERE ts < ? ORDER BY ts DESC LIMIT 1',
    ).get(ts);
    return row ? { ...row, items: safeParse(row.items, []) } : null;
  }

  /**
   * Keep fine-grained snapshots for the recent window and thin anything older
   * to one per calendar day, so a self-hosted instance doesn't accumulate this
   * forever. Idempotent: a day already thinned to one row has nothing left to
   * delete, so this is safe to call often.
   */
  pruneInventorySnapshots(olderThanMs) {
    const cutoff = Date.now() - olderThanMs;
    const keep = this.db.prepare(`
      SELECT MIN(ts) AS ts FROM inventory_snapshots
      WHERE ts < ? GROUP BY CAST(ts / 86400000 AS INTEGER)
    `).all(cutoff).map((r) => r.ts);
    if (!keep.length) return 0;
    const placeholders = keep.map(() => '?').join(',');
    const result = this.db.prepare(`
      DELETE FROM inventory_snapshots WHERE ts < ? AND ts NOT IN (${placeholders})
    `).run(cutoff, ...keep);
    return result.changes;
  }

  /** Teach the importer that a fingerprint is a particular item. */
  learnFingerprint(fingerprint, item) {
    this.stmt.learnFingerprint.run(fingerprint, item, Date.now());
    // Apply it to anything already imported, so the fix is visible immediately.
    this.db.prepare('UPDATE inventory_items SET name = ? WHERE fingerprint = ?')
      .run(item, fingerprint);
  }

  learnedFingerprints() {
    const rows = this.db.prepare('SELECT fingerprint, item FROM item_fingerprints').all();
    return new Map(rows.map((r) => [r.fingerprint, r.item]));
  }

  /**
   * Teach the importer that a model id — the item's visual skin, not its
   * exact rolled mods — is a particular item. See item_models in the schema
   * for why this exists alongside learnFingerprint rather than instead of it.
   */
  learnModel(modelId, item) {
    this.stmt.learnModel.run(modelId, item, Date.now());
    this.db.prepare('UPDATE inventory_items SET name = ? WHERE model_id = ?')
      .run(item, modelId);
  }

  learnedModels() {
    const rows = this.db.prepare('SELECT model_id AS modelId, item FROM item_models').all();
    return new Map(rows.map((r) => [r.modelId, r.item]));
  }

  /**
   * Fold the write-ahead log back into the database file. A bulk backfill can
   * leave a WAL larger than the database itself; this keeps the on-disk
   * footprint honest without giving up WAL's concurrency during normal use.
   */
  checkpoint() {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  }

  stats() {
    const one = (sql) => this.db.prepare(sql).get();
    return {
      observations: one('SELECT COUNT(*) AS n FROM observations').n,
      traderQuotes: one('SELECT COUNT(*) AS n FROM trader_quotes').n,
      sheetPrices: one('SELECT COUNT(*) AS n FROM sheet_prices').n,
      threads: one('SELECT COUNT(*) AS n FROM forum_threads').n,
      oldest: one('SELECT MIN(ts) AS t FROM observations').t,
      newest: one('SELECT MAX(ts) AS t FROM observations').t,
    };
  }
}

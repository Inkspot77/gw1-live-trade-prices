/**
 * Watch a folder for GWToolbox inventory exports and re-import them.
 *
 * Two mechanisms run together, deliberately:
 *
 *   - `fs.watch` gives an instant reaction where the OS supports it.
 *   - A stat poll every few seconds is the fallback, and on some setups it is
 *     the *only* thing that works. inotify events do not cross CIFS or NFS
 *     mounts, so a folder shared from the Windows box running Guild Wars can
 *     change without ever emitting an event. Dropbox and Syncthing write into
 *     a local directory and do fire events, but relying on that alone would
 *     silently fail for anyone using a network share.
 *
 * Toolbox rewrites the file in place while the game is running, so a read can
 * land mid-write. Rather than treat that as an error, a failed parse is retried
 * a few times before being reported.
 */

import { watch } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { parseToolboxInventory } from './parse/inventory.mjs';
import { importInventory, evaluateSellAlerts } from './valuation.mjs';

/** Toolbox names its exports `tmp<account-guid>.json`. */
const CANONICAL = /^tmp[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i;

const DEFAULT_POLL_MS = 10_000;
const DEBOUNCE_MS = 600;
const PARSE_RETRIES = 4;
const PARSE_RETRY_MS = 300;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export class InventoryWatcher {
  constructor(store, poller, { log = console.log, pollMs = DEFAULT_POLL_MS } = {}) {
    this.store = store;
    this.poller = poller;
    this.log = log;
    this.pollMs = pollMs;

    this.watcher = null;
    this.timer = null;
    this.debounce = null;
    this.busy = false;

    this.lastError = null;
    this.lastImport = null;
    this.lastChecked = null;
  }

  get config() {
    return this.store.getContext('inventoryWatch') ?? { path: null, enabled: false };
  }

  status() {
    const { path, enabled } = this.config;
    return {
      path: path ?? null,
      enabled: Boolean(enabled && path),
      running: Boolean(this.timer),
      // `fs.watch` silently no-ops on some filesystems; say which mechanism is
      // actually live so a stalled watch is diagnosable rather than mysterious.
      events: Boolean(this.watcher),
      pollSeconds: Math.round(this.pollMs / 1000),
      lastChecked: this.lastChecked,
      lastImport: this.lastImport,
      lastError: this.lastError,
    };
  }

  /** Persist a new path and restart the watch. Returns the fresh status. */
  async configure({ path, enabled = true }) {
    const cleaned = typeof path === 'string' && path.trim() ? path.trim() : null;
    this.store.setContext('inventoryWatch', { path: cleaned, enabled: Boolean(cleaned && enabled) });
    this.contentHash = null;
    this.lastError = null;
    this.stop();
    if (cleaned && enabled) {
      this.start();
      // Import immediately rather than making the user wait for the first tick.
      await this.checkNow({ force: true });
    }
    return this.status();
  }

  start() {
    const { path, enabled } = this.config;
    if (!path || !enabled || this.timer) return;

    this.timer = setInterval(() => { this.checkNow(); }, this.pollMs);
    this.timer.unref?.();

    // Best-effort: a missing folder or an unsupported filesystem must not throw.
    try {
      this.watcher = watch(path, { persistent: false }, () => {
        clearTimeout(this.debounce);
        this.debounce = setTimeout(() => this.checkNow(), DEBOUNCE_MS);
      });
      this.watcher.on('error', () => {
        this.watcher?.close();
        this.watcher = null;      // the stat poll carries on regardless
      });
    } catch {
      this.watcher = null;
    }
    this.log(`[watch] inventory folder: ${path}`);
  }

  stop() {
    clearInterval(this.timer);
    clearTimeout(this.debounce);
    this.timer = null;
    this.debounce = null;
    this.watcher?.close();
    this.watcher = null;
  }

  /**
   * Resolve the configured path to an actual file. A directory is the normal
   * case — Toolbox's folder holds one export per account, so the most recently
   * written canonical file is the one to read.
   */
  async resolveFile() {
    const { path } = this.config;
    if (!path) throw new Error('no watch folder configured');

    const info = await stat(path);
    if (info.isFile()) return path;

    const names = await readdir(path);
    const candidates = names.filter((n) => CANONICAL.test(n));
    const pool = candidates.length ? candidates : names.filter((n) => n.toLowerCase().endsWith('.json'));
    if (!pool.length) throw new Error('no inventory .json file in that folder');

    const stats = await Promise.all(pool.map(async (name) => {
      const full = join(path, name);
      return { full, mtimeMs: (await stat(full)).mtimeMs };
    }));
    stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return stats[0].full;
  }

  /**
   * Import if the file has genuinely changed.
   *
   * Content hash is the *only* signal trusted for "did anything actually
   * change" — mtime/size looked like a cheap way to skip a redundant read,
   * but is not reliable enough to gate on: a same-length rewrite (a quantity
   * changing from one 3-digit number to another, say) can leave `size`
   * identical, and two rewrites landing within one filesystem-clock tick can
   * leave `mtimeMs` identical too (seen in practice on WSL2, whose clock
   * resolution can be coarser than native Linux) — either way a real change
   * would then look exactly like no change at all and silently never import.
   * Reading and hashing a personal inventory export on every poll tick is
   * cheap enough that there is no real cost to just always doing it.
   * @param {{force?: boolean}} opts
   */
  async checkNow({ force = false } = {}) {
    const { path, enabled } = this.config;
    if (!path || !enabled || this.busy) return null;

    this.busy = true;
    try {
      const file = await this.resolveFile();
      this.lastChecked = Date.now();

      const text = await this.readStable(file);

      // A synced file (or, here, coincidence) can rewrite byte-identically;
      // hashing avoids an import (and an alert re-evaluation) that would
      // change nothing.
      const hash = createHash('sha1').update(text).digest('hex');
      if (!force && hash === this.contentHash) {
        this.lastError = null;
        return null;
      }

      const parsed = parseToolboxInventory(text);
      const rows = importInventory(this.store, this.poller, parsed, 'watched folder');
      const alerts = evaluateSellAlerts(this.store, this.poller);

      this.contentHash = hash;
      this.lastError = null;
      this.lastImport = {
        at: Date.now(),
        file,
        items: rows.length,
        identified: rows.filter((r) => r.name).length,
        owners: parsed.owners.length,
        alertsOpened: alerts.opened.length,
      };
      this.log(`[watch] imported ${rows.length} item types from ${file}`
        + (alerts.opened.length ? ` (+${alerts.opened.length} new alert)` : ''));
      return this.lastImport;
    } catch (error) {
      // A folder that does not exist yet is a normal state for a share that is
      // not mounted, so this is recorded rather than thrown.
      this.lastError = { at: Date.now(), message: describeError(error) };
      return null;
    } finally {
      this.busy = false;
    }
  }

  /**
   * Read a file that another process may be writing. Toolbox rewrites in place,
   * so a read can catch a truncated document; retry briefly before giving up.
   */
  async readStable(file) {
    let lastError = null;
    for (let attempt = 0; attempt < PARSE_RETRIES; attempt += 1) {
      const text = await readFile(file, 'utf8');
      try {
        JSON.parse(text);
        return text;
      } catch (error) {
        lastError = error;
        await sleep(PARSE_RETRY_MS);
      }
    }
    throw new Error(`file kept changing while being read (${lastError?.message ?? 'invalid JSON'})`);
  }
}

function describeError(error) {
  if (error?.code === 'ENOENT') return 'That path does not exist yet.';
  if (error?.code === 'EACCES') return 'Permission denied reading that path.';
  if (error?.code === 'ENOTDIR') return 'That path is not a folder.';
  return error?.message ?? String(error);
}

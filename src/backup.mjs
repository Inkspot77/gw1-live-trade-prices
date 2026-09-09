/**
 * Periodic backups of the price database.
 *
 * `store.checkpoint()` and `copyFileSync` are both synchronous, so nothing can
 * write to the database in the gap between them — the checkpoint folds the
 * WAL back into the main file, and the copy that follows is a complete,
 * consistent snapshot rather than a half-written one.
 */

import { copyFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const FILE_RE = /^prices-(\d{4}-\d{2}-\d{2})T\d{4}\.db$/;

// Keep every backup from the last day, plus one per day going back further —
// enough to recover from "the disk died this morning" or "I didn't notice
// for three weeks" without the folder growing forever.
const KEEP_RECENT = 24;
const KEEP_DAILY = 14;

function timestamp(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    + `T${pad(now.getHours())}${pad(now.getMinutes())}`;
}

export class Backup {
  constructor(store, dbPath, dir, { log = console.log } = {}) {
    this.store = store;
    this.dbPath = dbPath;
    this.dir = dir;
    this.log = log;
    this.timers = [];
  }

  /** Checkpoint, copy, rotate. Returns the path of the new backup file. */
  run() {
    mkdirSync(this.dir, { recursive: true });
    this.store.checkpoint();
    const file = join(this.dir, `prices-${timestamp()}.db`);
    copyFileSync(this.dbPath, file);
    this.rotate();
    return file;
  }

  /**
   * Simple count-based rotation: keep the most recent KEEP_RECENT backups
   * outright, then thin anything older to one survivor per calendar day,
   * for the KEEP_DAILY most recent such days. Everything past that is
   * deleted.
   */
  rotate() {
    const files = readdirSync(this.dir)
      .filter((f) => FILE_RE.test(f))
      .sort(); // filenames sort chronologically, oldest first

    const recentCount = Math.min(files.length, KEEP_RECENT);
    const older = files.slice(0, files.length - recentCount);
    const kept = new Set(files.slice(files.length - recentCount));

    // Walk oldest-of-the-rest backward (newest first) so the survivor kept
    // for a given day is the one closest to the recent window, and only the
    // KEEP_DAILY most recent distinct days are considered at all.
    const seenDays = new Set();
    for (let i = older.length - 1; i >= 0; i -= 1) {
      const [, day] = FILE_RE.exec(older[i]);
      if (seenDays.has(day)) continue;
      if (seenDays.size >= KEEP_DAILY) break;
      seenDays.add(day);
      kept.add(older[i]);
    }

    for (const f of files) {
      if (!kept.has(f)) unlinkSync(join(this.dir, f));
    }
  }

  start(intervalMinutes) {
    const every = (ms, name, task) => {
      const timer = setInterval(() => {
        try {
          const file = task();
          this.log(`[${name}] wrote ${file}`);
        } catch (error) {
          this.log(`[${name}] FAILED: ${error.message}`);
        }
      }, ms);
      timer.unref?.();
      this.timers.push(timer);
    };
    every(intervalMinutes * 60_000, 'backup', () => this.run());
  }

  stop() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }
}

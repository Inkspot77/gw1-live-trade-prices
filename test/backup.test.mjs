/**
 * Backup tests. `run()` is exercised against a real on-disk database, since
 * the whole point is a real file copy; `rotate()` is exercised against bare
 * filenames in a temp directory, since rotation only ever looks at names.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { openDatabase } from '../src/db.mjs';
import { Backup } from '../src/backup.mjs';

async function tempDir(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

test('run() checkpoints and copies the database to a timestamped file', async () => {
  const dir = await tempDir('gw1-backup-src-');
  const backupDir = await tempDir('gw1-backup-dst-');
  try {
    const dbPath = join(dir, 'prices.db');
    const store = openDatabase(dbPath);
    store.setContext('sentinel', { hello: 'world' });

    const backup = new Backup(store, dbPath, backupDir, { log: () => {} });
    const file = backup.run();

    assert.match(file, /prices-\d{4}-\d{2}-\d{2}T\d{4}\.db$/);
    const copy = openDatabase(file);
    assert.deepEqual(copy.getContext('sentinel'), { hello: 'world' });
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(backupDir, { recursive: true, force: true });
  }
});

test('run() creates the backup directory if it does not exist yet', async () => {
  const dir = await tempDir('gw1-backup-src-');
  const backupDir = join(dir, 'nested', 'backups');
  try {
    const dbPath = join(dir, 'prices.db');
    const store = openDatabase(dbPath);
    const backup = new Backup(store, dbPath, backupDir, { log: () => {} });

    const file = backup.run();
    assert.equal(dirname(file), backupDir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rotate() keeps the most recent backups outright', async () => {
  const dir = await tempDir('gw1-backup-rotate-');
  try {
    const names = [];
    for (let h = 0; h < 10; h += 1) {
      const name = `prices-2026-01-1${Math.floor(h / 10)}T${String(h).padStart(2, '0')}00.db`;
      names.push(name);
      await writeFile(join(dir, name), '');
    }
    const backup = new Backup({}, join(dir, 'prices.db'), dir, { log: () => {} });
    backup.rotate();

    const remaining = await readdir(dir);
    assert.equal(remaining.length, names.length, 'fewer than KEEP_RECENT files are all kept');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rotate() thins older backups to one per day and drops the rest', async () => {
  const dir = await tempDir('gw1-backup-rotate-');
  try {
    // 24 "recent" files on 2026-02-10, one per hour — all within KEEP_RECENT.
    for (let h = 0; h < 24; h += 1) {
      await writeFile(join(dir, `prices-2026-02-10T${String(h).padStart(2, '0')}00.db`), '');
    }

    // 20 distinct earlier days, one file each, oldest to newest.
    for (let d = 1; d <= 20; d += 1) {
      const day = `2026-01-${String(21 - d).padStart(2, '0')}`; // 2026-01-20 down to 2026-01-01
      await writeFile(join(dir, `prices-${day}T0900.db`), '');
    }
    // A second, later backup on the newest of those older days — the survivor
    // for that day should be this one, not the 09:00 one.
    await writeFile(join(dir, 'prices-2026-01-20T2200.db'), '');

    const backup = new Backup({}, join(dir, 'prices.db'), dir, { log: () => {} });
    backup.rotate();

    const remaining = new Set(await readdir(dir));
    assert.equal(remaining.size, 24 + 14, '24 recent + 14 daily survivors');

    for (let h = 0; h < 24; h += 1) {
      assert.ok(remaining.has(`prices-2026-02-10T${String(h).padStart(2, '0')}00.db`));
    }
    // The 14 most recent distinct older days survive (2026-01-07 .. 2026-01-20).
    assert.ok(remaining.has('prices-2026-01-20T2200.db'), 'later same-day backup wins');
    assert.ok(!remaining.has('prices-2026-01-20T0900.db'), 'earlier same-day backup is dropped');
    assert.ok(remaining.has('prices-2026-01-07T0900.db'), '14th most recent day survives');
    assert.ok(!remaining.has('prices-2026-01-06T0900.db'), '15th most recent day is dropped');
    assert.ok(!remaining.has('prices-2026-01-01T0900.db'), 'oldest day is dropped');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('start() schedules run() on an interval and stop() cancels it', async () => {
  const dir = await tempDir('gw1-backup-src-');
  const backupDir = await tempDir('gw1-backup-dst-');
  try {
    const dbPath = join(dir, 'prices.db');
    const store = openDatabase(dbPath);
    const backup = new Backup(store, dbPath, backupDir, { log: () => {} });

    backup.start(1 / 1200); // ~50ms
    await new Promise((resolve) => { setTimeout(resolve, 220); });
    backup.stop();

    const filesAfterStop = await readdir(backupDir);
    assert.ok(filesAfterStop.length >= 1, 'at least one backup ran');

    await new Promise((resolve) => { setTimeout(resolve, 150); });
    const filesLater = await readdir(backupDir);
    assert.equal(filesLater.length, filesAfterStop.length, 'stop() actually stops the timer');
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(backupDir, { recursive: true, force: true });
  }
});

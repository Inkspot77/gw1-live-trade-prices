/**
 * Watcher tests. These use a real temporary directory and real files, because
 * the behaviour that matters is all filesystem behaviour: picking the right
 * file, noticing a genuine change, ignoring a non-change, and surviving a read
 * that lands mid-write.
 *
 * The stat-poll path is exercised directly via `checkNow()` rather than waiting
 * on `fs.watch` events, which are timing-dependent and unavailable on some
 * filesystems anyway.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDatabase } from '../src/db.mjs';
import { createRegistry } from '../src/parse/items.mjs';
import { InventoryWatcher } from '../src/watcher.mjs';

const GUID_A = 'tmp0f8fad5b-d9cb-469f-a165-70867728950e.json';
const GUID_B = 'tmp1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d.json';

const inventoryFile = (ectos) => JSON.stringify({
  id: '0f8fad5b-d9cb-469f-a165-70867728950e',
  rc: 'Alan',
  c: { b: { 6: { 0: { m: 930, q: ectos, d: '0a3e010aa8a0' } } } },
  ch: { Alan: { b: { 1: { 0: { m: 945, q: 10, d: '0a3f010aa8b0' } } } } },
});

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'gw1-watch-'));
  const store = openDatabase(':memory:');
  const poller = { registry: createRegistry(), rates: {} };
  const watcher = new InventoryWatcher(store, poller, { log: () => {} });
  await watcher.configure({ path: dir, enabled: true });
  return { dir, store, watcher, cleanup: () => { watcher.stop(); return rm(dir, { recursive: true, force: true }); } };
}

test('a folder with no inventory file reports the problem rather than throwing', async () => {
  const h = await harness();
  try {
    const result = await h.watcher.checkNow({ force: true });
    assert.equal(result, null);
    assert.match(h.watcher.status().lastError.message, /no inventory .* file/i);
  } finally { await h.cleanup(); }
});

test('a missing path is reported plainly, not as a crash', async () => {
  const store = openDatabase(':memory:');
  const watcher = new InventoryWatcher(store, { registry: createRegistry() }, { log: () => {} });
  await watcher.configure({ path: join(tmpdir(), 'gw1-definitely-not-here'), enabled: true });
  assert.equal(watcher.status().lastError.message, 'That path does not exist yet.');
  watcher.stop();
});

test('an export in the folder is imported automatically', async () => {
  const h = await harness();
  try {
    await writeFile(join(h.dir, GUID_A), inventoryFile(250));
    const imported = await h.watcher.checkNow();

    assert.ok(imported, 'should import');
    assert.equal(imported.items, 2);
    const ecto = h.store.inventory().find((r) => r.name === 'Glob of Ectoplasm');
    assert.equal(ecto.quantity, 250);
  } finally { await h.cleanup(); }
});

test('an unchanged file is not re-imported', async () => {
  const h = await harness();
  try {
    await writeFile(join(h.dir, GUID_A), inventoryFile(250));
    assert.ok(await h.watcher.checkNow(), 'first read imports');
    assert.equal(await h.watcher.checkNow(), null, 'second read is a no-op');
  } finally { await h.cleanup(); }
});

test('a rewrite with identical content is not re-imported', async () => {
  const h = await harness();
  try {
    const file = join(h.dir, GUID_A);
    await writeFile(file, inventoryFile(250));
    await h.watcher.checkNow();

    // A sync tool can rewrite a file byte-for-byte; the mtime moves but nothing
    // has actually changed, and re-importing would churn the alert engine.
    const later = new Date(Date.now() + 60_000);
    await utimes(file, later, later);
    assert.equal(await h.watcher.checkNow(), null);
  } finally { await h.cleanup(); }
});

test('a genuine change is picked up', async () => {
  const h = await harness();
  try {
    const file = join(h.dir, GUID_A);
    await writeFile(file, inventoryFile(250));
    await h.watcher.checkNow();

    await writeFile(file, inventoryFile(400));
    assert.ok(await h.watcher.checkNow(), 'changed content re-imports');
    assert.equal(h.store.inventory().find((r) => r.name === 'Glob of Ectoplasm').quantity, 400);
  } finally { await h.cleanup(); }
});

test('the newest export wins when several accounts are present', async () => {
  const h = await harness();
  try {
    await writeFile(join(h.dir, GUID_A), inventoryFile(100));
    const older = new Date(Date.now() - 600_000);
    await utimes(join(h.dir, GUID_A), older, older);

    await writeFile(join(h.dir, GUID_B), inventoryFile(999));
    await h.watcher.checkNow({ force: true });

    assert.equal(h.store.inventory().find((r) => r.name === 'Glob of Ectoplasm').quantity, 999);
  } finally { await h.cleanup(); }
});

test('unrelated files in the folder are ignored', async () => {
  const h = await harness();
  try {
    await writeFile(join(h.dir, 'GWToolbox.ini'), 'not json');
    await writeFile(join(h.dir, GUID_A), inventoryFile(250));
    const imported = await h.watcher.checkNow({ force: true });
    assert.ok(imported);
    assert.ok(imported.file.endsWith(GUID_A));
  } finally { await h.cleanup(); }
});

test('a truncated file is reported, not imported as garbage', async () => {
  const h = await harness();
  try {
    // Toolbox rewrites in place, so a read can catch a half-written document.
    await writeFile(join(h.dir, GUID_A), inventoryFile(250).slice(0, 40));
    const result = await h.watcher.checkNow({ force: true });
    assert.equal(result, null);
    assert.match(h.watcher.status().lastError.message, /kept changing|JSON/i);
    assert.equal(h.store.inventory().length, 0, 'nothing partial is stored');
  } finally { await h.cleanup(); }
});

test('pointing directly at a file works as well as at a folder', async () => {
  const h = await harness();
  try {
    const file = join(h.dir, GUID_A);
    await writeFile(file, inventoryFile(250));
    await h.watcher.configure({ path: file, enabled: true });
    assert.equal(h.store.inventory().find((r) => r.name === 'Glob of Ectoplasm').quantity, 250);
  } finally { await h.cleanup(); }
});

test('stopping the watch disables it without losing the path', async () => {
  const h = await harness();
  try {
    const status = await h.watcher.configure({ path: h.dir, enabled: false });
    assert.equal(status.enabled, false);
    assert.equal(status.path, h.dir, 'the path is remembered for next time');
    assert.equal(status.running, false);
  } finally { await h.cleanup(); }
});

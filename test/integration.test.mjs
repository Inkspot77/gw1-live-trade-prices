/**
 * Integration tests: the real HTTP server, actually listening, actually hit
 * with real requests — as opposed to the other test files, which exercise
 * individual modules directly. This is the one place that would catch a
 * route wired up wrong, an auth gate that doesn't actually block a live
 * request, or a startup option that silently does nothing.
 *
 * Each server binds `port: 0` (the OS picks a free ephemeral port) against an
 * in-memory database, with polling off so no test ever makes a real network
 * call to the price sources.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from '../src/server.mjs';
import { openDatabase } from '../src/db.mjs';
import { createRegistry } from '../src/parse/items.mjs';

/** Start a throwaway server and return its base URL plus a matching teardown. */
async function bootServer(opts = {}) {
  const { server, store, poller, watcher } = await startServer({
    port: 0,
    host: '127.0.0.1',
    dbPath: ':memory:',
    poll: false,
    ...opts,
  });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const close = async () => {
    poller.stop();
    watcher.stop();
    await new Promise((resolve) => { server.close(resolve); });
  };
  return { baseUrl, store, close };
}

test('/healthz answers without touching the database or requiring auth', async () => {
  const { baseUrl, close } = await bootServer({ authUser: 'alan', authPass: 'nickset2e' });
  try {
    const response = await fetch(`${baseUrl}/healthz`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'ok');
  } finally {
    await close();
  }
});

test('/api/context serves real JSON with no upstream calls (poll: false)', async () => {
  const { baseUrl, close } = await bootServer();
  try {
    const response = await fetch(`${baseUrl}/api/context`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.rates, 'rates block is present');
    assert.ok(body.stats, 'stats block is present');
    assert.equal(body.stats.observations, 0, 'fresh in-memory db has no observations yet');
  } finally {
    await close();
  }
});

test('an unknown route is a real 404, not a silent 200', async () => {
  const { baseUrl, close } = await bootServer();
  try {
    const response = await fetch(`${baseUrl}/api/does-not-exist`);
    assert.equal(response.status, 404);
  } finally {
    await close();
  }
});

test('with no auth configured, every route is open', async () => {
  const { baseUrl, close } = await bootServer();
  try {
    const response = await fetch(`${baseUrl}/api/context`);
    assert.equal(response.status, 200);
  } finally {
    await close();
  }
});

test('with auth configured, an unauthenticated request is rejected', async () => {
  const { baseUrl, close } = await bootServer({ authUser: 'alan', authPass: 'nickset2e' });
  try {
    const response = await fetch(`${baseUrl}/api/context`);
    assert.equal(response.status, 401);
    assert.match(response.headers.get('www-authenticate') ?? '', /^Basic realm=/);
  } finally {
    await close();
  }
});

test('with auth configured, correct Basic credentials get through', async () => {
  const { baseUrl, close } = await bootServer({ authUser: 'alan', authPass: 'nickset2e' });
  try {
    const credentials = Buffer.from('alan:nickset2e').toString('base64');
    const response = await fetch(`${baseUrl}/api/context`, {
      headers: { authorization: `Basic ${credentials}` },
    });
    assert.equal(response.status, 200);
  } finally {
    await close();
  }
});

test('the dashboard\'s own HTML is served at /', async () => {
  const { baseUrl, close } = await bootServer();
  try {
    const response = await fetch(`${baseUrl}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await response.text(), /EctoWatch/);
  } finally {
    await close();
  }
});

/* --------------------------------------------------------------- database */

test('database operations work correctly', async () => {
  const store = openDatabase(':memory:');
  const now = Date.now();

  const quotes = [
    { ts: now, modelId: 'test', item: 'Glob of Ectoplasm', side: 'bid', gold: 15000 },
    { ts: now, modelId: 'test', item: 'Glob of Ectoplasm', side: 'ask', gold: 19000 },
  ];
  store.saveTraderQuotes(quotes);

  const retrieved = store.traderHistory('Glob of Ectoplasm', now - 86400000);
  assert.equal(retrieved.length, 2);
});

test('database stores inventory correctly', async () => {
  const store = openDatabase(':memory:');

  const inventory = [
    { name: 'Glob of Ectoplasm', realm: 'post', quantity: 250, locations: [{ owner: 'Chest' }] },
    { name: 'Obsidian Shard', realm: 'post', quantity: 50, locations: [{ owner: 'Character' }] },
  ];
  store.saveInventory(inventory);

  // Regression: activeItems() queries the `observations` table (trade chat
  // quotes) — it has no idea what you own. inventory() is the real accessor.
  const items = store.inventory();
  assert.ok(items.some((i) => i.name === 'Glob of Ectoplasm' && i.quantity === 250));
  assert.ok(items.some((i) => i.name === 'Obsidian Shard' && i.quantity === 50));
});

test('learning a model id retroactively names every unidentified row sharing it', () => {
  const store = openDatabase(':memory:');

  // Two rolls of the same weapon, imported before either was ever named:
  // same model id, different fingerprint (different rolled mods each time).
  store.saveInventory([
    { modelId: 45000, fingerprint: 'sundering-of-fortitude', realm: 'post', quantity: 1, locations: [] },
    { modelId: 45000, fingerprint: 'vampiric-of-enchanting', realm: 'post', quantity: 1, locations: [] },
  ]);
  assert.ok(store.inventory().every((i) => !i.name), 'both start unnamed');

  store.learnModel(45000, 'Totem Axe');

  const items = store.inventory();
  assert.equal(items.length, 2);
  assert.ok(items.every((i) => i.name === 'Totem Axe'), 'both rolls resolve from one taught model id');
  assert.deepEqual(store.learnedModels(), new Map([[45000, 'Totem Axe']]));
});

test('registry creates items correctly', () => {
  const registry = createRegistry();

  assert.ok(registry.items.size > 0);

  const item = [...registry.items.values()].find((i) => i.name === 'Glob of Ectoplasm');
  assert.ok(item);
});

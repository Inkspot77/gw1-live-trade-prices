/**
 * The optional weekly weapon/armor catalog refresh: fetch + flatten logic
 * only. `fetch` is stubbed per test rather than hitting a real network —
 * these tests are about the parsing/flattening rules, not about any
 * particular feed being up. Writing the result to disk and wiring it into
 * the poll loop is covered by hand in poller.mjs; nothing here touches disk.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchCommunityCatalog, SKIN_TYPES } from '../src/sources/community-catalog.mjs';

const realFetch = globalThis.fetch;

function stubFetch(body, { status = 200, ok = status < 400 } = {}) {
  globalThis.fetch = async () => ({
    ok,
    status,
    arrayBuffer: async () => new TextEncoder().encode(
      typeof body === 'string' ? body : JSON.stringify(body),
    ).buffer,
  });
}

test.afterEach(() => { globalThis.fetch = realFetch; });

test('flattens weapon/armor buckets to a plain model-id -> name map', async () => {
  stubFetch({
    Sword: { 31170: { name: 'Ascalon Razor' }, 1571: { name: 'Broadblade Scimitar' } },
    Staff: { 355: { name: 'Accursed Staff' } },
  });
  const { catalog, count, ambiguous, unnamed } = await fetchCommunityCatalog('https://example.com/items.json');
  assert.deepEqual(catalog, {
    31170: 'Ascalon Razor', 1571: 'Broadblade Scimitar', 355: 'Accursed Staff',
  });
  assert.equal(count, 3);
  assert.equal(ambiguous, 0);
  assert.equal(unnamed, 0);
});

test('a bare string entry is accepted as well as {name: ...}', async () => {
  stubFetch({ Sword: { 31170: 'Ascalon Razor' } });
  const { catalog } = await fetchCommunityCatalog('https://example.com');
  assert.deepEqual(catalog, { 31170: 'Ascalon Razor' });
});

test('a model id reused across two different types is dropped as ambiguous, not guessed at', async () => {
  stubFetch({
    Wand: { 1957: { name: 'Some Wand' } },
    Staff: { 1957: { name: 'Some Staff' } },
    Sword: { 31170: { name: 'Ascalon Razor' } },
  });
  const { catalog, count, ambiguous } = await fetchCommunityCatalog('https://example.com');
  assert.deepEqual(catalog, { 31170: 'Ascalon Razor' });
  assert.equal(count, 1);
  assert.equal(ambiguous, 2);
});

test('an entry with no name is dropped, not stored as undefined/null', async () => {
  stubFetch({ Sword: { 31170: { name: 'Ascalon Razor' }, 999: {}, 1000: { name: '' } } });
  const { catalog, unnamed } = await fetchCommunityCatalog('https://example.com');
  assert.deepEqual(catalog, { 31170: 'Ascalon Razor' });
  assert.equal(unnamed, 2);
});

test('buckets outside the recognised weapon/armor types are ignored entirely', async () => {
  stubFetch({
    Sword: { 31170: { name: 'Ascalon Razor' } },
    Potion: { 5: { name: 'Some Potion' } },
  });
  assert.equal(SKIN_TYPES.has('Potion'), false);
  const { catalog, count } = await fetchCommunityCatalog('https://example.com');
  assert.deepEqual(catalog, { 31170: 'Ascalon Razor' });
  assert.equal(count, 1);
});

test('an HTTP error status is reported with the status code, existing file left alone', async () => {
  stubFetch('', { status: 503, ok: false });
  await assert.rejects(() => fetchCommunityCatalog('https://example.com'), /503/);
});

test('a non-JSON response is reported plainly', async () => {
  stubFetch('<html>not json</html>');
  await assert.rejects(() => fetchCommunityCatalog('https://example.com'), /json/i);
});

test('a JSON response that is not an object of buckets is reported plainly', async () => {
  stubFetch([1, 2, 3]);
  await assert.rejects(() => fetchCommunityCatalog('https://example.com'), /object/i);
});

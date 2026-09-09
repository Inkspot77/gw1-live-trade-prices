/**
 * User-added price sources: a generic JSON-feed reader configured by field
 * names rather than code. `fetch` is stubbed per test rather than hitting a
 * real network — these tests are about the parsing/mapping logic, not about
 * any particular external site being up.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getByPath, fetchCustomSource } from '../src/sources/custom.mjs';

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

test('getByPath walks a dot path, and an empty path returns the value itself', () => {
  const value = { data: { items: [1, 2, 3] } };
  assert.deepEqual(getByPath(value, 'data.items'), [1, 2, 3]);
  assert.equal(getByPath(value, ''), value);
  assert.equal(getByPath(value, 'data.missing'), undefined);
  assert.equal(getByPath(null, 'data.items'), undefined);
});

test('a root-array JSON feed maps item/price fields with the default side', async () => {
  stubFetch([
    { name: 'Glob of Ectoplasm', gold: 18000 },
    { name: 'Obsidian Shard', gold: 6500 },
  ]);
  const { rows, total, skipped } = await fetchCustomSource({
    url: 'https://example.com/prices.json', itemField: 'name', priceField: 'gold',
  });
  assert.equal(total, 2);
  assert.equal(skipped, 0);
  assert.deepEqual(rows, [
    { itemRaw: 'Glob of Ectoplasm', side: 'ask', unitGold: 18000, qty: 1 },
    { itemRaw: 'Obsidian Shard', side: 'ask', unitGold: 6500, qty: 1 },
  ]);
});

test('a nested list is found via the configured path', async () => {
  stubFetch({ data: { listings: [{ item: 'Ecto', price: 100 }] } });
  const { rows } = await fetchCustomSource({
    url: 'https://example.com/api', path: 'data.listings', itemField: 'item', priceField: 'price',
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].itemRaw, 'Ecto');
});

test('a side field is read and normalised; a configured fixed side is the fallback', async () => {
  stubFetch([
    { item: 'A', price: 1, kind: 'selling' },
    { item: 'B', price: 2, kind: 'WTB' },
    { item: 'C', price: 3, kind: 'unrecognisable' },
  ]);
  const { rows } = await fetchCustomSource({
    url: 'https://example.com', itemField: 'item', priceField: 'price', sideField: 'kind', side: 'bid',
  });
  assert.equal(rows.find((r) => r.itemRaw === 'A').side, 'ask');
  assert.equal(rows.find((r) => r.itemRaw === 'B').side, 'bid');
  // "unrecognisable" matches neither pattern, so it falls back to the
  // configured fixed side rather than being dropped.
  assert.equal(rows.find((r) => r.itemRaw === 'C').side, 'bid');
});

test('rows with no name or a non-numeric/non-positive price are skipped, not fatal', async () => {
  stubFetch([
    { item: 'Good', price: 100 },
    { item: '', price: 50 },
    { item: 'No price', price: 'lots' },
    { item: 'Zero', price: 0 },
    { item: 'Negative', price: -5 },
  ]);
  const { rows, total, skipped } = await fetchCustomSource({
    url: 'https://example.com', itemField: 'item', priceField: 'price',
  });
  assert.equal(total, 5);
  assert.equal(skipped, 4);
  assert.deepEqual(rows.map((r) => r.itemRaw), ['Good']);
});

test('a quantity field multiplies out; without one every row is quantity 1', async () => {
  stubFetch([{ item: 'Stack', price: 100, count: 10 }]);
  const { rows } = await fetchCustomSource({
    url: 'https://example.com', itemField: 'item', priceField: 'price', qtyField: 'count',
  });
  assert.equal(rows[0].qty, 10);
});

test('missing required config is reported clearly, not as a network error', async () => {
  await assert.rejects(
    () => fetchCustomSource({ url: 'https://example.com' }),
    /item field.*price field|url.*item.*price/i,
  );
});

test('a non-http(s) URL is rejected before any request is made', async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; throw new Error('should not be called'); };
  await assert.rejects(
    () => fetchCustomSource({ url: 'file:///etc/passwd', itemField: 'a', priceField: 'b' }),
    /http/i,
  );
  assert.equal(called, false);
});

test('an HTTP error status is reported with the status code', async () => {
  stubFetch('', { status: 503, ok: false });
  await assert.rejects(
    () => fetchCustomSource({ url: 'https://example.com', name: 'Flaky', itemField: 'a', priceField: 'b' }),
    /503/,
  );
});

test('a non-JSON response is reported plainly', async () => {
  stubFetch('<html>not json</html>');
  await assert.rejects(
    () => fetchCustomSource({ url: 'https://example.com', itemField: 'a', priceField: 'b' }),
    /json/i,
  );
});

test('a response that is not an array at the configured path is reported plainly', async () => {
  stubFetch({ items: 'not a list' });
  await assert.rejects(
    () => fetchCustomSource({ url: 'https://example.com', path: 'items', itemField: 'a', priceField: 'b' }),
    /array/i,
  );
});

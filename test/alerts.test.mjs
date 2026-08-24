/**
 * Alert-engine tests. These drive a real (in-memory) database rather than
 * mocks, because the behaviour under test is mostly about state transitions:
 * firing once, not repeatedly, and clearing only after a genuine fall-back.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../src/db.mjs';
import { createRegistry } from '../src/parse/items.mjs';
import { evaluateSellAlerts, valueInventory } from '../src/valuation.mjs';
import { sellOpportunity, analyseItem, SELL_ALERT_Z } from '../src/analytics.mjs';

const ITEM = 'Glob of Ectoplasm';
const fakePoller = () => ({ registry: createRegistry(), rates: { ecto: 19000, blackDye: 17500 } });

/**
 * A store holding 250 ectos, 90 days of stable trader history, and whatever
 * "current" trader price the test asks for.
 */
function seed(currentBid, { quantity = 250 } = {}) {
  const store = openDatabase(':memory:');
  const now = Date.now();

  const history = [];
  for (let i = 1; i < 500; i += 1) {
    // A steady baseline around 15k with mild, regular variation.
    history.push({ ts: now - i * 3_600_000, modelId: '0b03a2', item: ITEM, side: 'bid', gold: 15_000 + (i % 5) * 200 });
    history.push({ ts: now - i * 3_600_000, modelId: '0b03a2', item: ITEM, side: 'ask', gold: 19_000 + (i % 5) * 200 });
  }
  history.push({ ts: now, modelId: '0b03a2', item: ITEM, side: 'bid', gold: currentBid });
  history.push({ ts: now, modelId: '0b03a2', item: ITEM, side: 'ask', gold: currentBid + 4000 });
  store.saveTraderQuotes(history);

  store.saveInventory([{ name: ITEM, realm: 'post', quantity, locations: [{ owner: 'Chest' }] }]);
  return store;
}

test('a price sitting at its baseline raises no alert', () => {
  const store = seed(15_400);
  const { opened, open } = evaluateSellAlerts(store, fakePoller());
  assert.equal(opened.length, 0);
  assert.equal(open.length, 0);
});

test('an unusually high trader bid opens exactly one alert', () => {
  const store = seed(21_000);
  const poller = fakePoller();

  const first = evaluateSellAlerts(store, poller);
  assert.equal(first.opened.length, 1, 'should fire');
  assert.equal(first.opened[0].item, ITEM);
  assert.ok(first.opened[0].z >= SELL_ALERT_Z);

  // Re-running must not produce a duplicate; the open alert is updated in place.
  const second = evaluateSellAlerts(store, poller);
  assert.equal(second.opened.length, 0, 'must not re-fire while still open');
  assert.equal(second.open.length, 1);
});

test('an open alert remembers its peak, not its latest value', () => {
  const store = seed(21_000);
  const poller = fakePoller();
  evaluateSellAlerts(store, poller);
  const peak = store.openAlerts()[0].peak_edge;

  // Price eases back, but stays above the clear threshold.
  store.saveTraderQuotes([{ ts: Date.now() + 1000, modelId: '0b03a2', item: ITEM, side: 'bid', gold: 18_000 }]);
  evaluateSellAlerts(store, poller);

  const [alert] = store.openAlerts();
  assert.ok(alert, 'alert stays open inside the hysteresis band');
  assert.equal(alert.peak_edge, peak, 'peak is retained');
});

test('an alert clears once the price genuinely falls back', () => {
  const store = seed(21_000);
  const poller = fakePoller();
  evaluateSellAlerts(store, poller);
  assert.equal(store.openAlerts().length, 1);

  store.saveTraderQuotes([{ ts: Date.now() + 2000, modelId: '0b03a2', item: ITEM, side: 'bid', gold: 15_000 }]);
  const { closed } = evaluateSellAlerts(store, poller);
  assert.equal(closed.length, 1);
  assert.equal(store.openAlerts().length, 0);
});

test('selling the item clears its alert', () => {
  const store = seed(21_000);
  const poller = fakePoller();
  evaluateSellAlerts(store, poller);
  assert.equal(store.openAlerts().length, 1);

  store.saveInventory([]);
  const { closed } = evaluateSellAlerts(store, poller);
  assert.equal(store.openAlerts().length, 0);
  assert.equal(closed[0]?.reason, 'no longer held');
});

test('unseen alerts are counted, then cleared by marking them seen', () => {
  const store = seed(21_000);
  evaluateSellAlerts(store, fakePoller());
  assert.equal(store.unseenAlertCount(), 1);
  store.markAlertsSeen();
  assert.equal(store.unseenAlertCount(), 0);
});

test('the suggested price never exceeds the fair corridor', () => {
  // Player asks are wild, but the corridor is capped by the NPC ask.
  const analysis = analyseItem({
    item: ITEM,
    realm: 'post',
    observations: [
      ...[900_000, 880_000, 910_000].map((unitGold) => ({ unitGold, side: 'ask', ts: Date.now() })),
      ...[16_000, 16_500].map((unitGold) => ({ unitGold, side: 'bid', ts: Date.now() })),
    ],
    traderQuotes: [{ side: 'ask', gold: 19_000 }, { side: 'bid', gold: 15_000 }],
  });
  const opportunity = sellOpportunity(analysis, 1);
  assert.ok(
    opportunity.suggested === null || opportunity.suggested <= analysis.fair.high,
    'a good moment to sell is not licence to overcharge',
  );
});

test('ranking favours total gold captured, not the largest z', () => {
  const store = seed(21_000, { quantity: 250 });
  // A tiny holding of something equally "hot" must not outrank the big stack.
  store.saveInventory([
    { name: ITEM, realm: 'post', quantity: 250, locations: [] },
    { name: 'Feather', realm: 'post', quantity: 1, locations: [] },
  ]);
  const valued = valueInventory(store, fakePoller());
  if (valued.opportunities.length > 1) {
    const [first, second] = valued.opportunities;
    assert.ok(first.opportunity.edgeTotal >= second.opportunity.edgeTotal);
  }
  assert.ok(valued.opportunities.every((o) => o.opportunity.actionable));
});

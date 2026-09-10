/**
 * Parser tests, built from real trade-chat lines captured from Kamadan and
 * Ascalon. Every case here is one that previously produced a wrong answer.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createRegistry } from '../src/parse/items.mjs';
import { parseTradeMessage } from '../src/parse/trade.mjs';
import {
  extractPrices, detectBundleQty, detectStack, isPerUnit, formatGold,
} from '../src/parse/currency.mjs';
import {
  median, percentile, summarise, analyseItem, evaluatePrice, RATING,
} from '../src/analytics.mjs';
import { parseCsv, parseSheetPrice } from '../src/sources/presearing.mjs';
import {
  parseToolboxInventory, parsePastedInventory, resolveNames, aggregate,
  nameFingerprint, readableHint,
} from '../src/parse/inventory.mjs';

const RATES = { ecto: 19000, blackDye: 17500, arm: 110000, zkey: 5000 };
const registry = createRegistry();
const parse = (message) => parseTradeMessage(message, registry, { rates: RATES });
const only = (message) => {
  const quotes = parse(message);
  assert.equal(quotes.length, 1, `expected exactly one quote from ${JSON.stringify(message)}`);
  return quotes[0];
};

test('currency units resolve to gold', () => {
  assert.equal(extractPrices('100k', RATES)[0].gold, 100_000);
  assert.equal(extractPrices('2e', RATES)[0].gold, 38_000);
  assert.equal(extractPrices('250g', RATES)[0].gold, 250);
  assert.equal(extractPrices('1bd', RATES)[0].gold, 17_500);
  assert.equal(extractPrices('2 arms', RATES)[0].gold, 220_000);
});

test('sub-10g tokens are placeholders, not prices', () => {
  assert.deepEqual(extractPrices('WTS shield 1g obo', RATES), []);
});

test('bundle quantities are detected, mod notation is not', () => {
  assert.equal(detectBundleQty('wts ectos 6 = 100k').qty, 6);
  assert.equal(detectBundleQty('6/100k ectos').qty, 6);
  assert.equal(detectBundleQty('wtb 5 ectos for 90k').qty, 5);
  // Weapon mods look identical but name no currency after the separator.
  assert.equal(detectBundleQty('q9 20/20 staff'), null);
  assert.equal(detectBundleQty('-5/20% shield'), null);
  assert.equal(detectBundleQty('10/10 vs charr'), null);
});

test('stacks and per-unit markers', () => {
  assert.equal(detectStack('10a/stk'), 250);
  assert.equal(detectStack('9a/stack'), 250);
  assert.equal(isPerUnit('1k/ea'), true);
  assert.equal(isPerUnit('5k each'), true);
  // "per stack" is a quantity, not a per-unit marker.
  assert.equal(isPerUnit('10 arms per stack'), false);
});

test('a bundle price is divided into a unit price', () => {
  assert.equal(only('WTS ectos 6 = 100k').unitGold, 100_000 / 6);
  assert.equal(only('WTB 5 ectos for 90k').unitGold, 90_000 / 5);
});

test('stack pricing is consistent across phrasings', () => {
  const perStack = 10 * RATES.arm / 250;
  assert.equal(only('WTS Consets 10a/stk').unitGold, perStack);
  assert.equal(only('wts consets 250=10a').unitGold, perStack);
});

test('currency mentions are not mistaken for goods', () => {
  const quote = only('wts styg gems 1 ecto each');
  assert.equal(quote.item, 'Stygian Gem');
  assert.equal(quote.unitGold, RATES.ecto);
});

test('a quantity of the currency item is still the goods', () => {
  const quote = only('WTB 5 ectos for 90k');
  assert.equal(quote.item, 'Glob of Ectoplasm');
  assert.equal(quote.side, 'bid');
});

test('one line carrying both directions keeps them apart', () => {
  const quotes = parse('WTB nick set 2e WTS Obsidian Shard 5e');
  const bid = quotes.find((q) => q.item === 'Gift of the Traveler');
  const ask = quotes.find((q) => q.item === 'Obsidian Shard');
  assert.equal(bid.side, 'bid');
  assert.equal(ask.side, 'ask');
});

test('separate listings do not share a price', () => {
  const quotes = parse('WTS Pbeacons 2e | Dcakes 1e');
  assert.equal(quotes.find((q) => q.item === 'Party Beacon').unitGold, 38_000);
  assert.equal(quotes.find((q) => q.item === 'Delicious Cake').unitGold, 19_000);
});

test('a comma-separated listing does not inherit the next per-unit marker', () => {
  // Regression: "5e/ea" belongs to the second listing, not to the Black Dye.
  const quote = only('WTS Black Dye 25=5e, Primeval Armor Remnants 5e/ea,');
  assert.equal(quote.item, 'Black Dye');
  assert.equal(quote.unitGold, (5 * RATES.ecto) / 25);
});

test('"BDS" is a weapon abbreviation, not Black Dye', () => {
  // Regression: this once produced Black Dye at 11 million gold.
  assert.deepEqual(parse('WTS: * Q9 BDS Prot // * BDS Q9 Heal -PM Offer- Unded Polar Bear 100a'), []);
});

test('a trailing "(stacks)" qualifies every listing on the line', () => {
  const quote = parse('WTB Cupcakes 7e/ea Pie 20e/ea (stacks)')
    .find((q) => q.item === 'Birthday Cupcake');
  assert.equal(quote.unitGold, (7 * RATES.ecto) / 250);
});

test('non-offers produce nothing', () => {
  assert.deepEqual(parse('WTT ectos for shards'), []);
  assert.deepEqual(parse('PC q9 froggy'), []);
  assert.deepEqual(parse('WTB Green staff for monk'), []);
  assert.deepEqual(parse(''), []);
});

test('generic words never become item aliases', () => {
  // "Blue" is a dye name in the Pre-Searing sheet and would otherwise match
  // every message containing the word.
  const loose = registry.aliasIndex.filter((a) => a.alias === 'blue');
  assert.equal(loose.length, 0);
});

/* ------------------------------------------------------------- analytics */

test('median and percentile', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(median([]), null);
});

test('summarise trims outliers', () => {
  const observations = [10, 11, 12, 11, 10, 12, 11, 900]
    .map((unitGold) => ({ unitGold, side: 'ask', ts: Date.now() }));
  const stats = summarise(observations);
  assert.ok(stats.median < 20, `median ${stats.median} should ignore the 900 outlier`);
});

const buildAnalysis = (overrides = {}) => {
  const now = Date.now();
  const observations = [
    ...[18_000, 19_000, 18_500, 19_500, 18_800].map((unitGold) => ({
      unitGold, side: 'ask', ts: now - 3600_000, source: 'Kamadan',
    })),
    ...[16_000, 16_500, 15_800, 16_200].map((unitGold) => ({
      unitGold, side: 'bid', ts: now - 3600_000, source: 'Kamadan',
    })),
  ];
  return analyseItem({
    item: 'Glob of Ectoplasm', realm: 'post', observations, now, ...overrides,
  });
};

test('a price far below the market reads as a strong deal when buying', () => {
  const verdict = evaluatePrice(buildAnalysis(), 12_000, 'buy');
  assert.equal(verdict.rating, RATING.STRONG_BUY);
});

test('the same price reads badly when selling', () => {
  const verdict = evaluatePrice(buildAnalysis(), 12_000, 'sell');
  assert.equal(verdict.rating, RATING.OVERPRICED);
});

test('the NPC trader overrides the statistical read', () => {
  const analysis = buildAnalysis({
    traderQuotes: [{ side: 'ask', gold: 19_000 }, { side: 'bid', gold: 15_000 }],
  });
  const verdict = evaluatePrice(analysis, 25_000, 'buy');
  assert.equal(verdict.rating, RATING.OVERPRICED);
  assert.ok(verdict.flags.includes('worse-than-npc'));
});

test('the fair corridor warns you when you are the one gouging', () => {
  const analysis = buildAnalysis();
  const high = analysis.fair.high * 1.8;
  const verdict = evaluatePrice(analysis, high, 'sell');
  assert.ok(verdict.flags.includes('gouging'), 'selling far above the corridor should flag');

  const low = analysis.fair.low * 0.4;
  const buying = evaluatePrice(analysis, low, 'buy');
  assert.ok(buying.flags.includes('lowballing'), 'buying far below the corridor should flag');
});

test('an unknown item is reported as unknown, not guessed', () => {
  const analysis = analyseItem({ item: 'Nothing', realm: 'post', observations: [] });
  assert.equal(evaluatePrice(analysis, 1000, 'buy').rating, RATING.UNKNOWN);
});

/* ------------------------------------------------------------ sheet parsing */

test('CSV reader handles quoted fields and embedded commas', () => {
  const rows = parseCsv('"a","b,c"\n"d","e""f"\n');
  assert.deepEqual(rows, [['a', 'b,c'], ['d', 'e"f']]);
});

test('sheet prices convert Black Dye to gold', () => {
  assert.equal(parseSheetPrice('15k', 17_500), 15_000);
  assert.equal(parseSheetPrice('250g', 17_500), 250);
  assert.equal(parseSheetPrice('2BD', 17_500), 35_000);
  assert.equal(parseSheetPrice('', 17_500), null);
});

test('gold formatting', () => {
  assert.equal(formatGold(250), '250g');
  assert.equal(formatGold(15_000), '15k');
  assert.equal(formatGold(1_500_000), '1,500k');
  assert.equal(formatGold(null), '—');
});

test('an implausible ask/bid spread is reported as a unit mismatch', () => {
  const now = Date.now();
  // Real case: "WTS Lockpicks 25e" vs "WTB Lockpick Stack 22e" — the second
  // names a stack, the first does not, so the two are 250x apart.
  const analysis = analyseItem({
    item: 'Lockpick',
    realm: 'post',
    now,
    observations: [
      ...[475_000, 470_000, 480_000].map((unitGold) => ({ unitGold, side: 'ask', ts: now })),
      ...[1700, 1650, 1720].map((unitGold) => ({ unitGold, side: 'bid', ts: now })),
    ],
  });
  assert.equal(analysis.warnings[0].code, 'unit-mismatch');
  assert.ok(evaluatePrice(analysis, 400_000, 'buy').flags.includes('unit-mismatch'));
});

test('a healthy book produces no warnings', () => {
  assert.deepEqual(buildAnalysis().warnings, []);
});

test('with no player quotes the NPC spread becomes the fair corridor', () => {
  const analysis = analyseItem({
    item: 'Glob of Ectoplasm',
    realm: 'post',
    observations: [],
    traderQuotes: [{ side: 'ask', gold: 19_000 }, { side: 'bid', gold: 15_000 }],
  });
  assert.equal(analysis.fair.low, 15_000);
  assert.equal(analysis.fair.high, 19_000);
});

/* ------------------------------------------------------------- inventory */

const TOOLBOX_FILE = {
  id: '0f8fad5b-d9cb-469f-a165-70867728950e',
  rc: 'Alan Stormcaller',
  c: { b: { 6: { 0: { m: 930, q: 210, d: '0a3e010aa8a0' } } } },
  ch: {
    'Alan Stormcaller': {
      b: { 1: { 0: { m: 930, q: 40, d: '0a3e010aa8a0' }, 1: { m: 945, q: 12, d: '0a3f010aa8b0' } } },
      h: { 12: { 0: { m: 945, q: 5, d: '0a3f010aa8b0' } } },
    },
  },
};

test('a Toolbox inventory file is read across chest, characters and heroes', () => {
  const parsed = parseToolboxInventory(TOOLBOX_FILE);
  assert.equal(parsed.account, '0f8fad5b-d9cb-469f-a165-70867728950e');
  assert.deepEqual(parsed.owners, ['Xunlai Chest', 'Alan Stormcaller', 'Alan Stormcaller - hero 12']);
  assert.equal(parsed.items.length, 4);
});

test('model ids resolve to item names and stacks aggregate across bags', () => {
  const parsed = parseToolboxInventory(TOOLBOX_FILE);
  const rows = aggregate(resolveNames(parsed.items, { registry }));
  const ecto = rows.find((r) => r.name === 'Glob of Ectoplasm');
  const shard = rows.find((r) => r.name === 'Obsidian Shard');
  assert.equal(ecto.quantity, 250, 'chest 210 + backpack 40');
  assert.equal(ecto.resolvedVia, 'model-id');
  assert.equal(shard.quantity, 17, 'character 12 + hero 5');
});

test('other_items model ids (kits, keys, consumables) resolve like materials', () => {
  const items = [{ modelId: 22751, quantity: 2, fingerprint: 'zz', hint: null }];
  const [row] = resolveNames(items, { registry });
  assert.equal(row.name, 'Lockpick');
  assert.equal(row.resolvedVia, 'model-id');
});

test('runes and insignias resolve by their built-in fingerprint catalog', () => {
  const items = [{
    modelId: null,
    quantity: 1,
    fingerprint: nameFingerprint('08038225300423000201020002aaaa'),
    hint: null,
  }];
  const [row] = resolveNames(items, { registry });
  assert.equal(row.name, 'Rune of Attunement');
  assert.equal(row.resolvedVia, 'catalog');
});

test('a learned fingerprint still outranks the built-in catalog', () => {
  const items = [{
    modelId: null,
    quantity: 1,
    fingerprint: nameFingerprint('08038225300423000201020002aaaa'),
    hint: null,
  }];
  const learned = new Map([[items[0].fingerprint, 'Corrected Name']]);
  const [row] = resolveNames(items, { registry, learned });
  assert.equal(row.name, 'Corrected Name');
  assert.equal(row.resolvedVia, 'learned');
});

test('the name fingerprint ignores the stat text that follows it', () => {
  // Two items of the same type with different stats share a name fingerprint.
  const a = nameFingerprint('0a3e010a000201020002aaaa');
  const b = nameFingerprint('0a3e010a000201020002bbbb');
  assert.equal(a, b);
  assert.equal(a, '0a3e010a');
});

test('literal text inside an encoded name is surfaced as a hint', () => {
  // "Fiery Badger" as UTF-16 code units, 4 hex each.
  const encoded = [...'Fiery Badger']
    .map((c) => c.charCodeAt(0).toString(16).padStart(4, '0')).join('');
  assert.equal(readableHint(encoded), 'Fiery Badger');
});

test('a learned fingerprint outranks every other resolution route', () => {
  const items = [{ modelId: 930, quantity: 1, fingerprint: 'abc', hint: null }];
  const learned = new Map([['abc', 'Obsidian Shard']]);
  const [row] = resolveNames(items, { registry, learned });
  assert.equal(row.name, 'Obsidian Shard');
  assert.equal(row.resolvedVia, 'learned');
});

test('unidentified items are kept, not dropped', () => {
  const items = [{ modelId: 99999, quantity: 3, fingerprint: 'zzz', hint: null }];
  const rows = aggregate(resolveNames(items, { registry }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, null);
  assert.equal(rows[0].quantity, 3);
});

test('typed inventory lines parse in the forms people actually write', () => {
  const { items } = parsePastedInventory(
    '250 Glob of Ectoplasm\nObsidian Shard x88\nCharr Salvage Kit, 3\n# a comment\n\nBlack Dye',
  );
  const rows = aggregate(resolveNames(items, { registry }));
  const byName = Object.fromEntries(rows.map((r) => [r.name, r.quantity]));
  assert.equal(byName['Glob of Ectoplasm'], 250);
  assert.equal(byName['Obsidian Shard'], 88);
  assert.equal(byName['Charr Salvage Kit'], 3);
  assert.equal(byName['Black Dye'], 1);
});

test('an empty or unparseable import fails loudly rather than silently', () => {
  assert.throws(() => parsePastedInventory('   \n\n# only comments'));
  assert.throws(() => parseToolboxInventory({ ch: {} }));
});

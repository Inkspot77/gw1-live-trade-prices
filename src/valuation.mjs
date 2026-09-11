/**
 * Valuation: turning stored observations into a judgement about one item, and
 * turning your inventory into a ranked list of things worth acting on.
 *
 * This lives apart from the HTTP layer because the poller needs it too - alerts
 * have to fire whether or not anyone has the dashboard open.
 */

import { REALMS } from './parse/items.mjs';
import { resolveNames, aggregate } from './parse/inventory.mjs';
import {
  analyseItem, sellOpportunity, rankOpportunities, SELL_CLEAR_Z, WINDOWS, DAY,
} from './analytics.mjs';

/**
 * Is this item under a live demand event? Nicholas rotations are the main
 * predictable price mover in both economies.
 */
export function demandFor(store, item, realm) {
  if (realm === REALMS.PRE) {
    const sandford = store.getContext('sandford');
    if (sandford && itemMatches(item, sandford.item)) {
      return { active: true, reason: `Nicholas Sandford is collecting ${sandford.item} today — demand is temporarily elevated.` };
    }
  } else {
    const traveler = store.getContext('traveler');
    if (traveler && itemMatches(item, traveler.item)) {
      return {
        active: true,
        reason: `Nicholas the Traveler wants ${traveler.qtyPerGift}× ${traveler.item} this week `
          + `(${traveler.nicksetQty} per nickset) — demand is elevated until the rotation moves.`,
      };
    }
  }
  return { active: false, reason: null };
}

/** Wiki names are plural/singular-loose against our canonical names. */
export function itemMatches(a, b) {
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '').replace(/s$/, '');
  return norm(a) === norm(b);
}

/**
 * Table-wide lookups, resolved once per request.
 *
 * These used to be queried inside `buildAnalysis`, which made the overview
 * O(items x table): 400 items each triggering a full join over a quarter of a
 * million trader rows. node:sqlite is synchronous, so that did not merely make
 * the endpoint slow — it blocked the whole server for the duration.
 */
export function buildLookups(store) {
  const trader = new Map();
  for (const q of store.latestTraderQuotes()) {
    const entry = trader.get(q.item) ?? [];
    entry.push(q);
    trader.set(q.item, entry);
  }
  const sheetMeta = new Map();
  for (const s of store.allSheetItems()) sheetMeta.set(s.item, s);
  return { trader, sheetMeta };
}

export function buildAnalysis(store, realm, item, now = Date.now(), lookups = null, opts = {}) {
  const l = lookups ?? buildLookups(store);
  const since = now - WINDOWS.baseline * DAY;
  const observations = store.observations(realm, item, since);
  const traderQuotes = l.trader.get(item) ?? [];
  const sheetHistory = store.sheetHistory(item);
  const category = observations[0]?.category ?? l.sheetMeta.get(item)?.category ?? null;

  // Trader history runs to thousands of rows per material. Worth paying for on
  // the handful of items you actually own; ruinous across the whole overview.
  const traderHistory = opts.withTraderHistory && traderQuotes.length
    ? store.traderHistory(item, since)
    : [];

  return analyseItem({
    item,
    realm,
    category,
    observations,
    traderQuotes,
    traderHistory,
    sheetHistory,
    demand: demandFor(store, item, realm),
    now,
  });
}

/**
 * How unusual today's price is, in robust sigmas, signed so that positive means
 * "cheaper than usual" (a buying opportunity).
 */
export function opportunityScore(analysis) {
  const spot = analysis.spot.ask ?? analysis.spot.bid;
  const base = analysis.baseline.ask ?? analysis.baseline.bid;
  if (!spot || !base || !base.sigma) return 0;
  return (base.median - spot.median) / base.sigma;
}

/**
 * Price the holdings.
 *
 * Items we cannot value are kept and reported separately rather than dropped:
 * the total is then an honest floor, and nothing you own silently disappears
 * from the picture.
 */
export function valueInventory(store, poller, now = Date.now()) {
  const rows = store.inventory();
  const lookups = buildLookups(store);

  const priced = [];
  const unpriced = [];
  let total = 0;

  for (const row of rows) {
    if (!row.name) {
      unpriced.push({ ...row, reason: 'unidentified' });
      continue;
    }
    const analysis = buildAnalysis(store, row.realm, row.name, now, lookups, {
      withTraderHistory: true,
    });
    const unit = analysis.reference.value;
    if (unit === null) {
      unpriced.push({ ...row, reason: 'no price data' });
      continue;
    }
    const value = unit * row.quantity;
    total += value;
    priced.push({
      ...row,
      unit,
      value,
      reference: analysis.reference,
      fair: analysis.fair,
      trader: analysis.trader,
      liquidity: analysis.liquidity,
      demand: analysis.demand,
      warnings: analysis.warnings,
      opportunity: sellOpportunity(analysis, row.quantity),
    });
  }

  priced.sort((a, b) => b.value - a.value);
  return {
    total,
    priced,
    unpriced,
    opportunities: rankOpportunities(priced, { limit: 5 }),
    counts: { priced: priced.length, unpriced: unpriced.length, stacks: rows.length },
    meta: store.getContext('inventoryMeta'),
    rates: store.getContext('rates') ?? poller.rates,
  };
}

/**
 * Record the current total holdings value, so the dashboard can chart how it
 * moves over time instead of only ever showing the current instant.
 *
 * Stores just the priced rows, trimmed to what a later comparison actually
 * needs (name/realm/quantity/unit/value/source) — everything else in
 * `valueInventory`'s output is re-derivable live and would only bloat a table
 * meant to be kept indefinitely.
 */
export function snapshotInventoryValue(store, poller, now = Date.now()) {
  const { total, priced } = valueInventory(store, poller, now);
  const items = priced.map((r) => ({
    name: r.name,
    realm: r.realm,
    quantity: r.quantity,
    unit: r.unit,
    value: r.value,
    source: r.reference.source,
  }));
  store.saveInventorySnapshot({ ts: now, total, items });
  return { total, count: items.length };
}

/**
 * Explain the difference between two recorded snapshots: which items moved,
 * how much, and whether that was a price move, a change in how much you hold,
 * or the item being gained or dropped entirely.
 *
 * `before` may be null (the `after` snapshot is the oldest one recorded) — the
 * caller is expected to treat that as "nothing to compare yet" rather than a
 * swing from zero.
 */
export function compareSnapshots(before, after, { limit = 10 } = {}) {
  const rows = new Map();
  for (const r of before?.items ?? []) rows.set(`${r.realm}|${r.name}`, { before: r, after: null });
  for (const r of after?.items ?? []) {
    const key = `${r.realm}|${r.name}`;
    const entry = rows.get(key) ?? { before: null, after: null };
    entry.after = r;
    rows.set(key, entry);
  }

  const movers = [...rows.values()].map(({ before: b, after: a }) => {
    const delta = (a?.value ?? 0) - (b?.value ?? 0);
    const label = a ?? b;
    let reason;
    if (!b) {
      reason = `Newly held: ${a.quantity} × ${formatWhole(a.unit)}g`;
    } else if (!a) {
      reason = `No longer held (was ${b.quantity} × ${formatWhole(b.unit)}g)`;
    } else if (b.quantity !== a.quantity && b.unit !== a.unit) {
      reason = `Holdings ${b.quantity} → ${a.quantity}, and ${a.source} price ${formatWhole(b.unit)}g → ${formatWhole(a.unit)}g`;
    } else if (b.quantity !== a.quantity) {
      reason = `Holdings changed: ${b.quantity} → ${a.quantity}`;
    } else {
      const pct = b.unit ? ((a.unit - b.unit) / b.unit) * 100 : 0;
      reason = `${a.source} price moved ${formatWhole(b.unit)}g → ${formatWhole(a.unit)}g (${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%)`;
    }
    return {
      item: label.name,
      realm: label.realm,
      delta,
      before: b ? { quantity: b.quantity, unit: b.unit, value: b.value } : null,
      after: a ? { quantity: a.quantity, unit: a.unit, value: a.value } : null,
      reason,
    };
  }).filter((m) => Math.abs(m.delta) > 0.5);

  movers.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));

  return {
    beforeTs: before?.ts ?? null,
    afterTs: after?.ts ?? null,
    beforeTotal: before?.total ?? 0,
    afterTotal: after?.total ?? 0,
    totalDelta: (after?.total ?? 0) - (before?.total ?? 0),
    movers: movers.slice(0, limit),
  };
}

function formatWhole(gold) {
  return Math.round(gold ?? 0).toLocaleString('en-US');
}

/** Shared by the file-import and paste paths. */
export function importInventory(store, poller, parsed, source) {
  const learned = store.learnedFingerprints();
  const learnedModels = store.learnedModels();
  const resolved = resolveNames(parsed.items, { registry: poller.registry, learned, learnedModels });
  const rows = aggregate(resolved).map((row) => ({
    ...row,
    realm: row.name
      ? (poller.registry.items.get(row.name)?.realm ?? REALMS.POST)
      : REALMS.POST,
  }));

  store.saveInventory(rows);
  store.setContext('inventoryMeta', {
    importedAt: Date.now(),
    source,
    account: parsed.account,
    representing: parsed.representing,
    owners: parsed.owners,
    stacks: parsed.items.length,
  });
  return rows;
}



/* ------------------------------------------------------------------ alerts */

/**
 * Fire and clear sell alerts for the things you own.
 *
 * Deliberately hysteretic: an alert opens once the price clears the alert
 * threshold and only closes when it falls back below the lower clear
 * threshold. Without that gap a price sitting on the boundary would open and
 * close an alert on every poll, burying the real signal in churn.
 *
 * While an alert is open its *peak* is tracked rather than its latest value,
 * so the list tells you the best the moment got rather than wherever the price
 * happens to be at the instant you look.
 *
 * @returns {{opened:Array, closed:Array, open:Array}}
 */
export function evaluateSellAlerts(store, poller, now = Date.now()) {
  const inventory = store.inventory().filter((row) => row.name);
  const opened = [];
  const closed = [];
  const held = new Set(inventory.map((r) => `${r.realm}|${r.name}`));

  // Note: no early return on an empty inventory. Selling everything is exactly
  // the case where stale alerts must be cleared, and returning early here once
  // left them open forever.
  const lookups = inventory.length ? buildLookups(store) : null;

  for (const row of inventory) {
    const analysis = buildAnalysis(store, row.realm, row.name, now, lookups, {
      withTraderHistory: true,
    });
    const opportunity = sellOpportunity(analysis, row.quantity);
    const existing = store.openAlert(row.name, row.realm);

    if (opportunity.actionable) {
      if (existing) {
        store.updateAlertPeak(existing.id, opportunity);
      } else {
        store.fireAlert({ item: row.name, realm: row.realm, quantity: row.quantity, ...opportunity });
        opened.push({ item: row.name, realm: row.realm, ...opportunity });
      }
      continue;
    }

    // Only close once it has genuinely fallen back, not merely dipped.
    if (existing && (opportunity.z === null || opportunity.z < SELL_CLEAR_Z)) {
      store.clearAlert(existing.id);
      closed.push({ item: row.name, realm: row.realm, reason: 'price fell back' });
    }
  }

  // An item you no longer own cannot still be an opportunity.
  for (const alert of store.openAlerts()) {
    if (!held.has(`${alert.realm}|${alert.item}`)) {
      store.clearAlert(alert.id);
      closed.push({ item: alert.item, realm: alert.realm, reason: 'no longer held' });
    }
  }

  return { opened, closed, open: store.openAlerts() };
}

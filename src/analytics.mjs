/**
 * Valuation and deal scoring.
 *
 * Trade chat is a noisy, adversarial sample: it contains hopeful asks nobody
 * pays, lowball bids nobody accepts, typos, and bots repeating one line for
 * hours. Every statistic here is therefore a *robust* one — medians, MAD, IQR —
 * because a single "WTS ecto 900k" must not move the baseline.
 *
 * Three anchors are combined, in decreasing order of authority:
 *   1. NPC trader quotes  — objective. A hard ceiling and floor you can always
 *                           transact against, so no player price outside them
 *                           is ever worth taking.
 *   2. Player quotes      — the actual market, wide and noisy.
 *   3. Curated snapshots  — the Pre-Searing sheet's dated bands; sparse but
 *                           the only multi-year record that exists.
 */

const MAD_TO_SIGMA = 1.4826;
const IQR_TO_SIGMA = 1.349;

export const DAY = 86_400_000;

/** Windows, in days. Spot is deliberately short: the market moves. */
export const WINDOWS = { spot: 3, recent: 14, baseline: 60 };

export const RATING = {
  STRONG_BUY: 'strong-buy',
  GOOD_BUY: 'good-buy',
  FAIR: 'fair',
  ABOVE_MARKET: 'above-market',
  OVERPRICED: 'overpriced',
  UNKNOWN: 'unknown',
};

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (sorted.length - 1) * p;
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

/** Median absolute deviation — the outlier-proof spread. */
export function mad(values, centre = null) {
  if (values.length < 2) return null;
  const m = centre ?? median(values);
  return median(values.map((v) => Math.abs(v - m)));
}

/**
 * A usable sigma even when MAD collapses to zero, which happens whenever a bot
 * repeats one price often enough to dominate the sample.
 */
function robustSigma(values) {
  const centre = median(values);
  if (centre === null) return null;
  const m = mad(values, centre);
  if (m && m > 0) return m * MAD_TO_SIGMA;
  const iqr = percentile(values, 0.75) - percentile(values, 0.25);
  if (iqr > 0) return iqr / IQR_TO_SIGMA;
  // Last resort: assume a 15% band, which is roughly how wide GW1 quotes run.
  return centre * 0.15;
}

/**
 * Drop the tails before computing anything. Trade chat routinely carries prices
 * off by a factor of ten (a missing "k", a bundle read as a unit).
 */
function trim(values, keep = 0.9) {
  if (values.length < 5) return values;
  const lo = percentile(values, (1 - keep) / 2);
  const hi = percentile(values, 1 - (1 - keep) / 2);
  const kept = values.filter((v) => v >= lo && v <= hi);
  return kept.length >= 3 ? kept : values;
}

/** Same statistics as `summarise`, for a bare list of numbers. */
export function summariseValues(values) {
  const usable = trim(values.filter((v) => Number.isFinite(v) && v > 0));
  if (!usable.length) return null;
  return {
    n: values.length,
    median: median(usable),
    p25: percentile(usable, 0.25),
    p75: percentile(usable, 0.75),
    min: Math.min(...usable),
    max: Math.max(...usable),
    sigma: robustSigma(usable),
  };
}

export function summarise(observations) {
  const values = trim(observations.map((o) => o.unitGold).filter((v) => v > 0));
  if (!values.length) return null;
  return {
    n: observations.length,
    median: median(values),
    p25: percentile(values, 0.25),
    p75: percentile(values, 0.75),
    min: Math.min(...values),
    max: Math.max(...values),
    sigma: robustSigma(values),
  };
}

function within(observations, days, now) {
  const cutoff = now - days * DAY;
  return observations.filter((o) => o.ts >= cutoff);
}

/**
 * Build the full picture for one item.
 *
 * @param {object} input
 * @param {Array}  input.observations  player quotes, any age
 * @param {Array}  input.traderQuotes  latest NPC quotes for this item, if any
 * @param {Array}  input.traderHistory archived {ts, side, gold} NPC quotes
 * @param {Array}  input.sheetHistory  dated {asOf, lowGold, highGold} bands
 * @param {object} input.demand        { active: boolean, reason: string }
 */
export function analyseItem({
  item, realm, category,
  observations = [], traderQuotes = [], traderHistory = [], sheetHistory = [],
  demand = null, now = Date.now(),
}) {
  const asks = observations.filter((o) => o.side === 'ask');
  const bids = observations.filter((o) => o.side === 'bid');

  const spot = {
    ask: summarise(within(asks, WINDOWS.spot, now)),
    bid: summarise(within(bids, WINDOWS.spot, now)),
  };
  const recent = {
    ask: summarise(within(asks, WINDOWS.recent, now)),
    bid: summarise(within(bids, WINDOWS.recent, now)),
  };
  const baseline = {
    ask: summarise(within(asks, WINDOWS.baseline, now)),
    bid: summarise(within(bids, WINDOWS.baseline, now)),
  };

  // NPC quotes are absolute: the trader will always transact at these.
  const traderAsk = traderQuotes.find((q) => q.side === 'ask')?.gold ?? null;
  const traderBid = traderQuotes.find((q) => q.side === 'bid')?.gold ?? null;

  // The trader's own price moves — ecto has swung between 11k and 26k over 90
  // days — so "is this a good moment to sell to the trader?" is a real question,
  // and the archive answers it far more reliably than trade chat ever could.
  const traderBaseline = {
    ask: summariseValues(traderHistory.filter((h) => h.side === 'ask').map((h) => h.gold)),
    bid: summariseValues(traderHistory.filter((h) => h.side === 'bid').map((h) => h.gold)),
  };

  // The curated sheet is the long memory for Pre-Searing, where chat is thin.
  const sheetLatest = sheetHistory.length ? sheetHistory[sheetHistory.length - 1] : null;
  const sheetBand = sheetLatest && (sheetLatest.lowGold ?? sheetLatest.highGold) !== null
    ? {
      low: sheetLatest.lowGold ?? sheetLatest.highGold,
      high: sheetLatest.highGold ?? sheetLatest.lowGold,
      asOf: sheetLatest.asOf,
    }
    : null;

  const reference = pickReference({ spot, recent, baseline, traderAsk, traderBid, sheetBand });

  return {
    item,
    realm,
    category,
    spot,
    recent,
    baseline,
    trader: { ask: traderAsk, bid: traderBid, baseline: traderBaseline },
    sheet: { band: sheetBand, history: sheetHistory },
    reference,
    warnings: sanityChecks({ spot, traderAsk, traderBid }),
    fair: fairBand({ spot, recent, baseline, traderAsk, traderBid, sheetBand }),
    trend: trend({ asks, bids, now }),
    liquidity: liquidity({ asks, bids, now }),
    demand,
    lastSeen: observations.length ? Math.max(...observations.map((o) => o.ts)) : null,
    sampleSize: observations.length,
  };
}

/**
 * The single number to quote when someone asks "what's it worth". Prefers the
 * tightest evidence available and always says where it came from, so a thin
 * estimate is never mistaken for a firm one.
 */
function pickReference({ spot, recent, baseline, traderAsk, traderBid, sheetBand }) {
  const mid = (a, b) => (a !== null && b !== null ? (a + b) / 2 : (a ?? b));

  const playerMid = mid(spot.ask?.median ?? recent.ask?.median ?? baseline.ask?.median ?? null,
    spot.bid?.median ?? recent.bid?.median ?? baseline.bid?.median ?? null);

  if (traderAsk !== null && traderBid !== null) {
    return {
      value: mid(traderAsk, traderBid),
      source: 'NPC trader',
      confidence: 'high',
      note: 'Set by the in-game material trader; you can always transact here.',
    };
  }
  if (playerMid !== null) {
    const n = (spot.ask?.n ?? 0) + (spot.bid?.n ?? 0);
    return {
      value: playerMid,
      source: 'Player market',
      confidence: n >= 8 ? 'high' : n >= 3 ? 'medium' : 'low',
      note: `Midpoint of ${n} quote${n === 1 ? '' : 's'} in the last ${WINDOWS.spot} days.`,
    };
  }
  if (sheetBand) {
    return {
      value: (sheetBand.low + sheetBand.high) / 2,
      source: 'Pre-Searing price guide',
      confidence: 'low',
      note: `Community snapshot from ${new Date(sheetBand.asOf).toISOString().slice(0, 10)}; no live quotes.`,
    };
  }
  return { value: null, source: 'none', confidence: 'none', note: 'No price evidence yet.' };
}

/**
 * Cheap consistency checks that catch the failure mode statistics cannot: the
 * two sides of the book being quoted in *different units*.
 *
 * "WTS Lockpicks 25e" and "WTB Lockpick Stack 22e" are both true, but only the
 * second says "stack". Parsed literally they imply a 280x spread, which is not
 * a market — it is a unit mismatch, and saying so is more useful than
 * confidently reporting the midpoint of two incomparable numbers.
 */
function sanityChecks({ spot, traderAsk, traderBid }) {
  const warnings = [];
  const ask = spot.ask?.median;
  const bid = spot.bid?.median;

  if (ask > 0 && bid > 0) {
    const ratio = Math.max(ask / bid, bid / ask);
    if (ratio > 20) {
      warnings.push({
        code: 'unit-mismatch',
        message: `Asks and bids differ by ${Math.round(ratio)}x, which usually means one side `
          + 'was quoted per stack and the other per item. Treat this price as unreliable.',
      });
    } else if (bid > ask * 1.15) {
      warnings.push({
        code: 'inverted-book',
        message: 'Buyers are offering more than sellers are asking — either a genuine squeeze, '
          + 'or two different qualities of the same item being quoted together.',
      });
    }
  }

  if (traderAsk > 0 && traderBid > 0 && traderBid > traderAsk) {
    warnings.push({ code: 'trader-inverted', message: 'NPC trader quotes look inverted; ignore them for now.' });
  }
  return warnings;
}

/**
 * The corridor inside which a trade is fair to *both* sides.
 *
 * The lower edge protects the person you are buying from: pay less than the
 * quartile of standing bids and you are exploiting a seller who has not checked
 * the market. The upper edge protects the person you are selling to. This is
 * the anti-gouging guard, and it is deliberately symmetric — it will tell you
 * off in both directions.
 */
function fairBand({ spot, recent, baseline, traderAsk, traderBid, sheetBand }) {
  const askStats = spot.ask ?? recent.ask ?? baseline.ask;
  const bidStats = spot.bid ?? recent.bid ?? baseline.bid;

  let low = bidStats?.p25 ?? askStats?.p25 ?? sheetBand?.low ?? null;
  let high = askStats?.p75 ?? bidStats?.p75 ?? sheetBand?.high ?? null;

  // With only one side quoted, widen symmetrically rather than pretend to a
  // precision the sample does not support.
  if (low !== null && high === null) high = low * 1.25;
  if (high !== null && low === null) low = high * 0.8;
  if (low !== null && high !== null && low > high) [low, high] = [high, low];

  // With no player quotes at all, the NPC spread *is* the fair corridor: the
  // trader defines both what you can always pay and what you can always get.
  if (low === null && high === null && traderBid !== null && traderAsk !== null) {
    low = traderBid;
    high = traderAsk;
  }

  // Otherwise the NPC trader clamps both edges: nobody should transact outside it.
  if (traderBid !== null && low !== null) low = Math.max(low, traderBid);
  if (traderAsk !== null && high !== null) high = Math.min(high, traderAsk);
  if (low !== null && high !== null && low > high) [low, high] = [high, low];

  return { low, high };
}

/** Direction of travel: spot median against the longer baseline, in percent. */
function trend({ asks, bids, now }) {
  const side = asks.length >= bids.length ? asks : bids;
  const recentMedian = median(trim(within(side, WINDOWS.spot, now).map((o) => o.unitGold)));
  const olderCutoffHigh = now - WINDOWS.spot * DAY;
  const olderCutoffLow = now - WINDOWS.baseline * DAY;
  const older = side.filter((o) => o.ts < olderCutoffHigh && o.ts >= olderCutoffLow);
  const olderMedian = median(trim(older.map((o) => o.unitGold)));
  if (recentMedian === null || olderMedian === null || olderMedian === 0) {
    return { pct: null, direction: 'flat' };
  }
  const pct = ((recentMedian - olderMedian) / olderMedian) * 100;
  return {
    pct,
    direction: pct > 5 ? 'up' : pct < -5 ? 'down' : 'flat',
    from: olderMedian,
    to: recentMedian,
  };
}

/** How confidently you can act: quotes per day and whether both sides are live. */
function liquidity({ asks, bids, now }) {
  const recentAsks = within(asks, WINDOWS.recent, now).length;
  const recentBids = within(bids, WINDOWS.recent, now).length;
  const perDay = (recentAsks + recentBids) / WINDOWS.recent;
  const twoSided = recentAsks > 0 && recentBids > 0;
  const level = perDay >= 3 ? 'high' : perDay >= 0.5 ? 'moderate' : perDay > 0 ? 'thin' : 'none';
  return { perDay, twoSided, level, asks: recentAsks, bids: recentBids };
}

/**
 * Score a concrete price you are considering.
 *
 * @param {object} analysis  output of analyseItem
 * @param {number} price     the price on the table, in gold
 * @param {'buy'|'sell'} intent
 */
export function evaluatePrice(analysis, price, intent) {
  if (!Number.isFinite(price) || price <= 0) {
    return { rating: RATING.UNKNOWN, reasons: ['Enter a price to evaluate.'] };
  }

  const buying = intent === 'buy';
  // Compare against the side you would actually transact with: buying means
  // lifting someone's ask, selling means hitting someone's bid.
  const stats = buying
    ? (analysis.spot.ask ?? analysis.recent.ask ?? analysis.baseline.ask)
    : (analysis.spot.bid ?? analysis.recent.bid ?? analysis.baseline.bid);

  const reasons = [];
  const flags = [];

  // Hard anchors first — these override any statistical read.
  if (buying && analysis.trader.ask !== null && price > analysis.trader.ask) {
    return {
      rating: RATING.OVERPRICED,
      z: null,
      reasons: [`The in-game trader sells this for ${Math.round(analysis.trader.ask)}g. Never pay a player more.`],
      flags: ['worse-than-npc'],
    };
  }
  if (!buying && analysis.trader.bid !== null && price < analysis.trader.bid) {
    return {
      rating: RATING.OVERPRICED,
      z: null,
      reasons: [`The in-game trader pays ${Math.round(analysis.trader.bid)}g. Never accept less from a player.`],
      flags: ['worse-than-npc'],
    };
  }

  if (!stats || stats.sigma === null || stats.sigma === 0) {
    const ref = analysis.reference.value;
    if (ref === null) return { rating: RATING.UNKNOWN, reasons: ['No price history for this item yet.'], flags: [] };
    const delta = ((price - ref) / ref) * 100;
    reasons.push(`No usable spread yet; compared against the ${analysis.reference.source.toLowerCase()} reference.`);
    return {
      rating: Math.abs(delta) < 15 ? RATING.FAIR
        : (buying ? (delta < 0 ? RATING.GOOD_BUY : RATING.ABOVE_MARKET)
          : (delta > 0 ? RATING.GOOD_BUY : RATING.ABOVE_MARKET)),
      z: null,
      deltaPct: delta,
      reasons,
      flags,
    };
  }

  // Positive z always means "worse for you", whichever side you are on.
  const raw = (price - stats.median) / stats.sigma;
  const z = buying ? raw : -raw;

  const rating = z <= -1.5 ? RATING.STRONG_BUY
    : z <= -0.5 ? RATING.GOOD_BUY
      : z < 0.5 ? RATING.FAIR
        : z < 1.5 ? RATING.ABOVE_MARKET
          : RATING.OVERPRICED;

  const deltaPct = ((price - stats.median) / stats.median) * 100;
  reasons.push(
    `${buying ? 'Asks' : 'Bids'} over the last ${WINDOWS.spot} days centre on ${Math.round(stats.median)}g `
    + `(${stats.n} quote${stats.n === 1 ? '' : 's'}); this is ${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(0)}%.`,
  );

  // The anti-gouging guard: symmetric, and it fires against the user.
  const { low, high } = analysis.fair;
  if (buying && low !== null && price < low) {
    flags.push('lowballing');
    reasons.push(
      `Below the fair corridor (${Math.round(low)}g). This is a good price for you, but it undercuts standing bids — `
      + 'expect to be turned down, and consider offering nearer the corridor.',
    );
  }
  if (!buying && high !== null && price > high) {
    flags.push('gouging');
    reasons.push(
      `Above the fair corridor (${Math.round(high)}g). You may find a buyer, but this is priced above what the `
      + 'market is actually paying.',
    );
  }
  if (analysis.liquidity.level === 'thin' || analysis.liquidity.level === 'none') {
    flags.push('thin-market');
    reasons.push('Thin market — few recent quotes, so treat the estimate loosely.');
  }
  if (analysis.demand?.active) {
    flags.push('demand-event');
    reasons.push(analysis.demand.reason);
  }
  for (const warning of analysis.warnings ?? []) {
    flags.push(warning.code);
    reasons.push(warning.message);
  }

  return { rating, z, deltaPct, reasons, flags };
}


/* ------------------------------------------------------------ opportunities */

/** How far above its own baseline a price must sit before it is worth acting on. */
export const SELL_ALERT_Z = 1.5;
/** Dropping back below this clears the alert, so a price hovering on the
 *  threshold cannot flap on and off. */
export const SELL_CLEAR_Z = 1.0;

/**
 * Is now an unusually good moment to sell something you already own?
 *
 * Two very different questions hide behind that, and they need different
 * evidence:
 *
 *   - For an NPC-traded material, the trader's *own* price history is the
 *     answer. It is objective, deep, and the trader will always transact.
 *   - For everything else, it is the player market's bid side versus its own
 *     longer baseline.
 *
 * Whichever path is taken, spot and baseline are always read from the SAME
 * side of the book — comparing a bid today against asks last month would
 * manufacture signal out of the bid/ask spread.
 *
 * The suggested price is capped at the fair corridor. A good moment to sell
 * means the market is paying well, not that it is a good moment to overcharge.
 */
export function sellOpportunity(analysis, quantity = 1) {
  const none = {
    actionable: false, z: null, edgePerUnit: null, edgeTotal: null,
    suggested: null, basis: 'none', reason: 'Not enough history to judge.',
  };

  const traderBid = analysis.trader?.bid ?? null;
  const traderBaseline = analysis.trader?.baseline?.bid ?? null;

  let spot = null;
  let base = null;
  let basis = null;

  if (traderBid !== null && traderBaseline?.sigma) {
    spot = traderBid;
    base = traderBaseline;
    basis = 'NPC trader';
  } else {
    // Prefer bids: selling means hitting someone's bid. Fall back to asks only
    // when both spot and baseline have them, so the comparison stays honest.
    const side = (analysis.spot.bid && analysis.baseline.bid?.sigma) ? 'bid'
      : (analysis.spot.ask && analysis.baseline.ask?.sigma) ? 'ask' : null;
    if (!side) return none;
    spot = analysis.spot[side].median;
    base = analysis.baseline[side];
    basis = side === 'bid' ? 'Player bids' : 'Player asks';
  }

  if (!Number.isFinite(spot) || !base?.sigma) return none;

  const edgePerUnit = spot - base.median;
  const z = edgePerUnit / base.sigma;
  const edgeTotal = edgePerUnit * quantity;

  // Never suggest a price above what the market is actually paying.
  const corridorHigh = analysis.fair?.high;
  const suggested = Number.isFinite(corridorHigh) ? Math.min(spot, corridorHigh) : spot;

  // A one-sided, barely-quoted market will happily produce a large z from
  // noise. Require either objective NPC pricing or a market with real depth.
  const thin = analysis.liquidity?.level === 'thin' || analysis.liquidity?.level === 'none';
  const trustworthy = basis === 'NPC trader' || !thin;

  return {
    actionable: z >= SELL_ALERT_Z && trustworthy && edgeTotal > 0,
    z,
    edgePerUnit,
    edgeTotal,
    suggested,
    basis,
    baselineMedian: base.median,
    spot,
    trustworthy,
    reason: describeOpportunity({ z, basis, edgePerUnit, base, thin, demand: analysis.demand }),
  };
}

/** Reads naturally in a sentence, unlike the bare basis label. */
const BASIS_PHRASE = {
  'NPC trader': 'The NPC trader is paying',
  'Player bids': 'Player bids are',
  'Player asks': 'Player asks are',
};

function describeOpportunity({ z, basis, edgePerUnit, base, thin, demand }) {
  const pct = base.median ? (edgePerUnit / base.median) * 100 : 0;
  const direction = z >= 0 ? 'above' : 'below';
  const parts = [
    `${BASIS_PHRASE[basis] ?? basis} ${Math.abs(pct).toFixed(0)}% ${direction} this item's own `
    + `${WINDOWS.baseline}-day baseline (${Math.round(base.median)}g).`,
  ];
  if (demand?.active) parts.push(demand.reason);
  if (thin) parts.push('Thin market, so treat the size of the move loosely.');
  return parts.join(' ');
}

/**
 * Rank holdings by how much extra gold acting today would actually capture.
 *
 * Ranking by z alone over-promotes a single cupcake at three sigma; ranking by
 * value alone just lists your biggest stack every day. The product — total
 * edge — is what you would genuinely gain versus selling on an average day.
 */
export function rankOpportunities(rows, { limit = 5, minZ = SELL_ALERT_Z } = {}) {
  return rows
    .filter((r) => r.opportunity?.actionable && r.opportunity.z >= minZ)
    .sort((a, b) => b.opportunity.edgeTotal - a.opportunity.edgeTotal)
    .slice(0, limit);
}

export const RATING_LABEL = {
  [RATING.STRONG_BUY]: 'Strong deal',
  [RATING.GOOD_BUY]: 'Good deal',
  [RATING.FAIR]: 'Fair price',
  [RATING.ABOVE_MARKET]: 'Off market',
  [RATING.OVERPRICED]: 'Bad deal',
  [RATING.UNKNOWN]: 'Unknown',
};

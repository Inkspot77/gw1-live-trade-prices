/**
 * Guild Wars 1 trade chat speaks in a mix of gold, platinum and commodity
 * currencies. Everything here normalises down to a single unit: raw gold.
 *
 * Post-Searing settles in ectos ("e"); Pre-Searing settles in Black Dye ("bd").
 * Those two rates float, so they are injected rather than hard-coded.
 */

/** Multipliers that never move. */
const FIXED_UNITS = {
  g: 1,
  gold: 1,
  gp: 1,
  k: 1000,
  plat: 1000,
  platinum: 1000,
};

/** Units priced in a commodity, resolved against live rates. */
const COMMODITY_UNITS = {
  e: 'ecto',
  ec: 'ecto',
  ecto: 'ecto',
  ectos: 'ecto',
  ectoplasm: 'ecto',
  bd: 'blackDye',
  bds: 'blackDye',
  blackdye: 'blackDye',
  blackdyes: 'blackDye',
  dye: 'blackDye',
  a: 'arm',
  arm: 'arm',
  arms: 'arm',
  armbrace: 'arm',
  armbraces: 'arm',
  z: 'zkey',
  zkey: 'zkey',
  zkeys: 'zkey',
  zaishenkey: 'zkey',
};

/** Fallbacks used only until a live rate lands. All in gold. */
export const DEFAULT_RATES = {
  ecto: 19000,
  blackDye: 17500,
  arm: 110000,
  zkey: 5000,
};

export const CURRENCY_LABEL = {
  ecto: 'Glob of Ectoplasm',
  blackDye: 'Black Dye',
  arm: 'Armbrace of Truth',
  zkey: 'Zaishen Key',
};

/** "1.5" / "1,5" / "250" -> Number. Trade chat mixes both decimal marks. */
function toNumber(raw) {
  const cleaned = String(raw).replace(/,(?=\d{3}\b)/g, '').replace(',', '.');
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Resolve one "<number><unit>" token to gold.
 * A bare number is ambiguous: "100" usually means 100k when large-ish in
 * context, so callers pass `bareUnit` to say how to read it.
 */
export function amountToGold(value, unit, rates = DEFAULT_RATES, bareUnit = 'g') {
  const u = String(unit || bareUnit).toLowerCase().replace(/[\s.]/g, '');
  if (u in FIXED_UNITS) return { gold: value * FIXED_UNITS[u], currency: 'gold' };
  const commodity = COMMODITY_UNITS[u];
  if (commodity) {
    const rate = rates[commodity] ?? DEFAULT_RATES[commodity];
    return { gold: value * rate, currency: commodity, commodityQty: value };
  }
  return null;
}

/** Every unit token we recognise, longest-first so "ecto" beats "e". */
const UNIT_ALTERNATION = [
  ...Object.keys(FIXED_UNITS),
  ...Object.keys(COMMODITY_UNITS),
].sort((a, b) => b.length - a.length).join('|');

/** A number carrying a currency unit, anchored at the start of a slice. */
const BUNDLE_PRICE_FOLLOWS = new RegExp(
  String.raw`^\d+(?:[.,]\d+)?\s*(?:${UNIT_ALTERNATION})\b`,
  'i',
);

const PRICE_TOKEN = new RegExp(
  String.raw`(\d+(?:[.,]\d+)?)\s*(${UNIT_ALTERNATION})\b`,
  'gi',
);

/**
 * Pull every price-looking token out of a message.
 * Returns [{ gold, currency, raw, index }] in order of appearance.
 */
export function extractPrices(text, rates = DEFAULT_RATES) {
  const out = [];
  for (const m of String(text).matchAll(PRICE_TOKEN)) {
    const value = toNumber(m[1]);
    if (value === null || value <= 0) continue;
    const resolved = amountToGold(value, m[2], rates);
    if (!resolved) continue;
    // A bare "1g"-style token below 10 gold is nearly always a typo or a
    // placeholder ("1g" = "make me an offer"), not a real quote.
    if (resolved.currency === 'gold' && resolved.gold < 10) continue;
    out.push({ ...resolved, raw: m[0].trim(), index: m.index });
  }
  return out;
}

/**
 * Bundle pricing: "6 = 100k", "6 for 100k", "6/100k", "3 x 5k".
 * Returns the divisor to apply to the price that follows, or null.
 *
 * The hard part is weapon-mod notation, which looks identical: "20/20",
 * "-5/20%", "15^50". The lookbehind rejects a number glued to a mod prefix and
 * the `%` guard rejects the trailing half of a mod pair.
 */
const BUNDLE = /(?<![-+^/\d.,%])(\d{1,3})\s*(?:=|for|\/|x)\s*(?=\d)/gi;

/** The spelled-out form: "5 ectos for 90k", "10 stygian gems for 2e". */
const BUNDLE_WORDY = /(?<![-+^/\d.,%])(\d{1,3})\s+[a-z][a-z' ]{0,24}?\s+(?:for|=)\s*(?=\d)/gi;

export function detectBundleQty(text) {
  const str = String(text);
  // Scan every candidate rather than only the first: mod notation earlier in
  // the message must not mask a real bundle later in it.
  for (const pattern of [BUNDLE, BUNDLE_WORDY]) {
    pattern.lastIndex = 0;
    for (const m of str.matchAll(pattern)) {
      const qty = Number.parseInt(m[1], 10);
      if (!Number.isFinite(qty) || qty <= 1 || qty > 250) continue;
      // The decisive test: a bundle is followed by a *price*. "20/20 staff"
      // and "10/10 vs Charr" are mods precisely because no unit follows.
      const rest = str.slice(m.index + m[0].length);
      if (!BUNDLE_PRICE_FOLLOWS.test(rest)) continue;
      return { qty, index: m.index, end: m.index + m[0].length };
    }
  }
  return null;
}

/** "5k/ea", "5k each", "5k per", "5k a piece" -> price is already per-unit. */
const PER_UNIT = /\b(?:ea|each|apiece|a\s?piece|pc)\b|\/ea?\b|\bper\b(?!\s*stack)/i;

export function isPerUnit(text) {
  return PER_UNIT.test(String(text));
}

/** "stack" is 250 in Guild Wars, and traders quote stacks constantly. */
export function detectStack(text) {
  return /\b(?:stacks?|stks?)\b/i.test(String(text)) ? 250 : null;
}

/** Human-readable gold: 1234567 -> "1,234k". */
export function formatGold(gold) {
  if (!Number.isFinite(gold)) return '—';
  if (gold < 1000) return `${Math.round(gold)}g`;
  const k = gold / 1000;
  if (k < 1000) return `${k >= 100 ? Math.round(k) : k.toFixed(k < 10 ? 1 : 0)}k`;
  return `${Math.round(k).toLocaleString('en-US')}k`;
}

/** Same number expressed in the economy's reserve currency. */
export function formatInCurrency(gold, currency, rates = DEFAULT_RATES) {
  const rate = rates[currency];
  if (!rate || !Number.isFinite(gold)) return null;
  const n = gold / rate;
  const suffix = currency === 'ecto' ? 'e' : currency === 'blackDye' ? 'bd' : currency;
  return `${n < 10 ? n.toFixed(1) : Math.round(n)}${suffix}`;
}

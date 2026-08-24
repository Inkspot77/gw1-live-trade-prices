/**
 * Turns one line of trade chat into zero or more structured quotes.
 *
 * A quote is: someone is willing to BUY or SELL a named item at a unit price.
 * Everything downstream (baselines, deal scoring, fair-price bands) is built on
 * quotes, so this module is deliberately conservative: when it cannot be
 * confident about item, side and price together, it emits nothing.
 */

import {
  extractPrices, detectBundleQty, isPerUnit, detectStack, DEFAULT_RATES,
} from './currency.mjs';

export const SIDE = { ASK: 'ask', BID: 'bid' };

/** Openers, longest-first so "wtb" is not swallowed by a looser pattern. */
const SIDE_MARKERS = [
  [/\b(?:wts|selling|s>|for\s+sale)\b/i, SIDE.ASK],
  [/\b(?:wtb|buying|b>|looking\s+to\s+buy)\b/i, SIDE.BID],
];

/** Lines we deliberately drop: they carry no usable price signal. */
const NOISE = [
  /\bwtt\b/i,                       // trades, not priced sales
  /\b(?:pc|price\s*check)\b/i,      // asking, not offering
  /\b(?:guild|gh|recruit|lfg|lfp|looking\s+for\s+(?:group|players))\b/i,
  /\b(?:rune\s*trader|mat\s*trader)\b/i,
];

/**
 * Lowercase and flatten punctuation while preserving the characters the
 * currency parser needs (`/ % . , =`). Item aliases never contain those, so one
 * prepared string can serve both matchers and their offsets stay aligned.
 */
export function prepare(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9%/.,= ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Explicit separators between listings.
 *
 * Commas split unconditionally. A comma inside one listing ("Q9 sword, 15^50,
 * +30hp 5e") costs us that quote, but a comma *between* listings that we fail
 * to split attaches one item's price to another — and a wrong price is far
 * worse than a missing one.
 *
 * The slash rule is the subtle one. Players use "/" both to separate listings
 * ("Smiting Staff 15k / Gold Hammer 4k") and inside mod notation ("20/20",
 * "-5/20%", "10a/stk", "1k/ea"). Requiring whitespace on at least one side
 * splits the first kind and leaves the second intact.
 */
const SEPARATORS = /\s*(?:\||;|\/\/|,)\s*|\s+or\s+|\s+\/\s*|\s*\/\s+/i;

/** A parenthesised trailing qualifier: "... 7e/ea Pie 20e/ea (stacks)". */
const LINE_STACK_QUALIFIER = /\((?:per\s+)?stacks?\)|\bper\s+stack\b/i;

/** A new WTS/WTB opener starts a new listing, whatever came before it. */
const SIDE_BOUNDARY = /(?=\b(?:wts|wtb|selling|buying)\b)/i;

/**
 * Split a multi-listing line ("WTS a 2e | b 1e") into independent segments.
 *
 * Splitting on side markers matters as much as on punctuation: a single line
 * often carries both directions ("WTB runes 1k ... WTS staff 15k"), and without
 * this the whole line inherits whichever marker was seen first.
 */
function segments(raw) {
  return String(raw)
    .split(SEPARATORS)
    .flatMap((part) => part.split(SIDE_BOUNDARY))
    .map((s) => s.trim())
    .filter(Boolean);
}

function detectSide(text, inherited = null) {
  for (const [pattern, side] of SIDE_MARKERS) {
    if (pattern.test(text)) return side;
  }
  return inherited;
}

/**
 * @param {string} message  raw trade chat line
 * @param {import('./items.mjs').ItemRegistry} registry
 * @param {object} opts
 * @returns {Array<{item:string, category:string, side:string, unitGold:number,
 *                  currency:string, qty:number, confidence:number, segment:string}>}
 */
export function parseTradeMessage(message, registry, opts = {}) {
  const { realm = null, rates = DEFAULT_RATES } = opts;
  const raw = String(message ?? '');
  if (!raw.trim()) return [];
  if (NOISE.some((pattern) => pattern.test(raw))) return [];

  const lineSide = detectSide(raw);
  if (!lineSide) return [];

  const lineStack = LINE_STACK_QUALIFIER.test(raw) ? 250 : null;

  const quotes = [];
  for (const segment of segments(raw)) {
    const text = prepare(segment);
    if (!text) continue;

    const side = detectSide(segment, lineSide);
    const items = registry.match(text, realm);
    if (!items.length) continue;

    const bundle = detectBundleQty(text);
    // A trailing "(stacks)" qualifies every listing on the line, which is how
    // consumable sellers quote. A bare "stack" only ever binds to its own
    // segment, or it would divide unrelated prices by 250.
    const stack = detectStack(text) ?? lineStack;
    const perUnit = isPerUnit(text);

    // Text inside the bundle span is the *quantity* ("5 ectos for 90k"), so it
    // must not also be read as a price — and the item it names is the goods.
    const inBundle = (i) => bundle && i >= bundle.index && i < bundle.end;
    const prices = extractPrices(text, rates).filter((p) => !inBundle(p.index));
    if (!prices.length) continue;

    // A price token can itself name an item ("1 ecto each") — that mention is
    // the currency, not the goods. Drop any item whose span sits inside one.
    const priceSpans = prices.map((p) => [p.index, p.index + p.raw.length]);
    const subjects = items.filter(
      ({ at, name }) => !priceSpans.some(([s, e]) => at >= s && at < e)
        && (inBundle(at) || !isCurrencyWord(name, text, at)),
    );
    if (!subjects.length) continue;

    for (const subject of subjects) {
      // Pair the item with the first price stated after it; fall back to the
      // last price before it for trailing-item phrasings ("2e for nick set").
      const after = prices.find((p) => p.index > subject.at);
      const before = [...prices].reverse().find((p) => p.index < subject.at);
      const price = after ?? before;
      if (!price) continue;

      // An explicit stack wins: it is the least ambiguous quantity in chat.
      const divisor = stack ?? (perUnit ? 1 : (bundle?.qty ?? 1));
      const unitGold = price.gold / divisor;
      if (!Number.isFinite(unitGold) || unitGold <= 0) continue;

      quotes.push({
        item: subject.name,
        category: subject.category,
        side,
        unitGold,
        currency: price.currency,
        qty: divisor,
        confidence: scoreConfidence({
          subjects: subjects.length,
          prices: prices.length,
          usedFallback: !after,
          explicitQty: Boolean(bundle || stack || perUnit),
        }),
        segment: segment.trim(),
      });
    }
  }
  return dedupe(quotes);
}

/**
 * "2e", "1 ecto", "5 bd" name the settlement currency. If the item mention sits
 * immediately after a bare number it is being counted as money, not sold.
 */
const CURRENCY_ITEMS = new Set(['Glob of Ectoplasm', 'Black Dye', 'Armbrace of Truth', 'Zaishen Key']);

function isCurrencyWord(name, text, at) {
  if (!CURRENCY_ITEMS.has(name)) return false;
  return /\d\s*$/.test(text.slice(Math.max(0, at - 6), at));
}

/**
 * Confidence is a blunt 0–1 signal used to weight quotes in the baseline. A
 * line naming one item and one price is the clean case; more of either means
 * the pairing was a guess.
 */
function scoreConfidence({ subjects, prices, usedFallback, explicitQty }) {
  let score = 1;
  if (subjects > 1) score -= 0.15 * (subjects - 1);
  if (prices > 1) score -= 0.1 * (prices - 1);
  if (usedFallback) score -= 0.25;
  if (explicitQty) score += 0.05;
  return Math.max(0.1, Math.min(1, score));
}

/** One message quoting the same item/side twice adds no information. */
function dedupe(quotes) {
  const seen = new Map();
  for (const q of quotes) {
    const key = `${q.item}|${q.side}|${Math.round(q.unitGold)}`;
    const prior = seen.get(key);
    if (!prior || q.confidence > prior.confidence) seen.set(key, q);
  }
  return [...seen.values()];
}

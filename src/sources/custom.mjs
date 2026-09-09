/**
 * User-added price sources.
 *
 * Every other adapter in this folder is hand-written for one specific site's
 * shape. This one is the opposite: a small, generic reader for "a URL that
 * returns a JSON array of prices", configured by the user rather than by
 * code, so a future site with a plain JSON feed doesn't need a code change
 * and a redeploy to be added.
 *
 * Deliberately narrow. Sites that need real protocol work (auth, pagination,
 * WebSockets) are out of scope for this — the point is covering the common
 * case cheaply, not becoming a general-purpose scraper.
 */

const UA = { 'user-agent': 'gw1-price-dashboard (personal, low-rate, user-added source)' };
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 5000;

/** Dot-path into a parsed JSON value. Empty path means "the value itself". */
export function getByPath(value, path) {
  if (!path) return value;
  let cur = value;
  for (const key of path.split('.').filter(Boolean)) {
    if (cur == null) return undefined;
    cur = cur[key];
  }
  return cur;
}

function normaliseSide(raw) {
  const s = String(raw ?? '').toLowerCase();
  if (/\b(ask|sell|selling|wts)\b/.test(s)) return 'ask';
  if (/\b(bid|buy|buying|wtb)\b/.test(s)) return 'bid';
  return null;
}

/**
 * One user-configured source -> raw {itemRaw, side, unitGold, qty} rows.
 * Never throws for a malformed *entry* — a bad row is skipped and counted,
 * not allowed to abort the whole source, since one typo in someone's feed
 * shouldn't cost every other row in it.
 */
export async function fetchCustomSource(config) {
  const { url, path = '', itemField, priceField, sideField = null, side: fixedSide = 'ask', qtyField = null } = config;
  if (!url || !itemField || !priceField) {
    throw new Error('a custom source needs at least a URL, an item field, and a price field');
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`not a valid URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('only http/https URLs are supported');
  }

  const response = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`${config.name ?? url} -> HTTP ${response.status}`);

  const buf = await response.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) {
    throw new Error(`response too large (${Math.round(buf.byteLength / 1024)}KB, limit ${MAX_BYTES / 1024}KB)`);
  }

  let body;
  try {
    body = JSON.parse(Buffer.from(buf).toString('utf8'));
  } catch {
    throw new Error('response was not valid JSON');
  }

  const list = getByPath(body, path);
  if (!Array.isArray(list)) {
    throw new Error(path ? `"${path}" did not point at an array` : 'the response was not a JSON array');
  }

  const rows = [];
  let skipped = 0;
  for (const entry of list.slice(0, MAX_ROWS)) {
    const itemRaw = entry?.[itemField];
    const priceRaw = entry?.[priceField];
    const unitGold = Number(priceRaw);
    if (!itemRaw || !Number.isFinite(unitGold) || unitGold <= 0) { skipped += 1; continue; }

    const side = (sideField ? normaliseSide(entry?.[sideField]) : null) ?? fixedSide ?? 'ask';
    const qty = qtyField ? Math.max(1, Number(entry?.[qtyField]) || 1) : 1;
    rows.push({ itemRaw: String(itemRaw), side, unitGold, qty });
  }

  return { rows, total: list.length, skipped };
}

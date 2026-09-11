/**
 * Optional weekly refresh for the extended weapon/armor model-id catalog.
 *
 * `data/community-item-catalog.json` fills a real gap: GWCA's `ItemIDs.h` (the
 * source behind `other_items` in gwtoolbox-items.json) has no general
 * weapon/armor coverage at all, just a handful of named green weapons. A
 * community-maintained catalog of base skin names, keyed by model id, closes
 * that gap - and because a project like that keeps growing as more players
 * contribute data, this refreshes the local copy periodically instead of
 * leaving it frozen at whatever it looked like on the day it was first added.
 *
 * Off by default, and entirely optional: nothing here runs unless
 * COMMUNITY_CATALOG_URL is set (see .env.example). Without it,
 * inventory.mjs's model index just uses whatever data/community-item-catalog.json
 * already has on disk (or nothing, if it's never been generated).
 *
 * The expected feed shape is item-type buckets of model-id -> entry:
 *
 *   { "<ItemType>": { "<model_id>": { "name": "...", ... }, ... }, ... }
 *
 * This flattens the weapon/armor buckets down to the plain `model_id -> name`
 * map inventory.mjs's buildModelIndex() reads, dropping:
 *   - any bucket outside the weapon/armor types this project actually uses
 *     the catalog for (see SKIN_TYPES below)
 *   - a model id that appears under more than one type in the feed - kept
 *     ambiguous rather than guessed at, since a raw model id is scoped per
 *     item type in the underlying game data, not globally unique
 *   - an entry with no name
 */

const UA = { 'user-agent': 'gw1-price-dashboard (personal, low-rate, optional weekly refresh)' };
const MAX_BYTES = 10 * 1024 * 1024;

/** The item-type buckets treated as weapon/armor "skins". */
export const SKIN_TYPES = new Set([
  'Axe', 'Bow', 'Daggers', 'Hammer', 'Offhand', 'Scythe', 'Shield', 'Spear',
  'Staff', 'Sword', 'Wand', 'Headpiece', 'Chestpiece', 'Gloves', 'Leggings', 'Boots',
]);

/**
 * Fetch the feed and flatten it. Throws on any network or shape problem
 * rather than returning a partial result - a stale catalog on disk is fine
 * (it just misses whatever changed upstream since), a corrupted one is not,
 * so the caller should leave the existing file untouched on failure.
 */
export async function fetchCommunityCatalog(url) {
  const response = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`community catalog -> HTTP ${response.status}`);

  const buf = await response.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) {
    throw new Error(`community catalog response too large (${Math.round(buf.byteLength / 1024)}KB)`);
  }

  let body;
  try {
    body = JSON.parse(Buffer.from(buf).toString('utf8'));
  } catch {
    throw new Error('community catalog response was not valid JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('community catalog response was not a JSON object of item-type buckets');
  }

  // Count how many distinct types each model id appears under across the
  // *whole* feed, not just the buckets this project reads - an id the feed
  // itself reuses across two types is a sign it's type-scoped there too.
  const typesByModel = new Map();
  for (const [type, entries] of Object.entries(body)) {
    if (!entries || typeof entries !== 'object') continue;
    for (const modelKey of Object.keys(entries)) {
      const modelId = Number(modelKey);
      if (!Number.isFinite(modelId)) continue;
      const seen = typesByModel.get(modelId) ?? new Set();
      seen.add(type);
      typesByModel.set(modelId, seen);
    }
  }

  const catalog = {};
  let ambiguous = 0;
  let unnamed = 0;
  for (const [type, entries] of Object.entries(body)) {
    if (!SKIN_TYPES.has(type) || !entries || typeof entries !== 'object') continue;
    for (const [modelKey, entry] of Object.entries(entries)) {
      const modelId = Number(modelKey);
      if (!Number.isFinite(modelId)) continue;
      if ((typesByModel.get(modelId)?.size ?? 0) > 1) { ambiguous += 1; continue; }
      const name = typeof entry === 'string' ? entry : entry?.name;
      if (!name || typeof name !== 'string') { unnamed += 1; continue; }
      catalog[modelId] = name;
    }
  }

  return {
    catalog, count: Object.keys(catalog).length, ambiguous, unnamed,
  };
}

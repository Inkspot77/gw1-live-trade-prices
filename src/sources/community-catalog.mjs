/**
 * Optional weekly refresh for the extended item-name catalog.
 *
 * `data/community-item-catalog.json` fills a real gap: the built-in tables
 * (GWCA's `ItemIDs.h`, exposed as `other_items` in gwtoolbox-items.json, plus
 * the runes/insignias/dyes fingerprint catalog) cover crafting materials and a
 * handful of named green weapons, but nothing else - no general weapon/armor
 * base skins, and nothing at all for trophies, salvage rewards, keys, kits,
 * minipets, quest items, or the individual upgrade components (hafts, grips,
 * pommels, insignias) that don't carry a distinct fingerprint of their own. A
 * community-maintained catalog keyed by model id closes that gap across all
 * of those categories at once - and because a project like that keeps growing
 * as more players contribute data, this refreshes the local copy periodically
 * instead of leaving it frozen at whatever it looked like on the day it was
 * first added.
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
 * This flattens the recognised buckets down to the plain `model_id -> name`
 * map inventory.mjs's buildModelIndex() reads, dropping:
 *   - any bucket outside the known, reviewed item types this project reads
 *     from the catalog (see CATALOG_TYPES below) - a deliberate allowlist, so
 *     a brand-new upstream category shows up as "ignored" rather than being
 *     absorbed sight unseen
 *   - a model id that appears under more than one type anywhere in the *whole*
 *     feed (not just the recognised buckets) - kept ambiguous rather than
 *     guessed at, since a raw model id is scoped per item type in the
 *     underlying game data, not globally unique
 *   - an entry with no name (including a still-templated placeholder name
 *     such as "{0} Dagger Tang", which the feed uses for a handful of
 *     upgrade components before their subtype is filled in)
 */

const UA = { 'user-agent': 'gw1-price-dashboard (personal, low-rate, optional weekly refresh)' };
const MAX_BYTES = 10 * 1024 * 1024;

/**
 * The item-type buckets this project reads from the feed: weapon/armor base
 * skins, plus every other everyday category the same community catalog
 * happens to cover - trophies, salvage-kit rewards, dyes, keys, kits,
 * scrolls, usable consumables, crafting materials/Zcoins, minipets, quest
 * items, festival presents, costumes, and the individual upgrade components
 * (hafts, grips, pommels, insignias, runes) that have no fingerprint of their
 * own. Deliberately an explicit allowlist rather than "everything" - a
 * category the feed adds later shows up as ignored, not silently absorbed.
 */
export const CATALOG_TYPES = new Set([
  'Axe', 'Bow', 'Daggers', 'Hammer', 'Offhand', 'Scythe', 'Shield', 'Spear',
  'Staff', 'Sword', 'Wand', 'Headpiece', 'Chestpiece', 'Gloves', 'Leggings', 'Boots',
  'Trophy', 'Salvage', 'Dye', 'Key', 'Kit', 'Scroll', 'Usable', 'Materials_Zcoins',
  'Minipet', 'Quest_Item', 'Present', 'Costume', 'Costume_Headpiece', 'Bag',
  'CC_Shards', 'Storybook', 'Bundle', 'Gold_Coin', 'Rune_Mod',
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
    if (!CATALOG_TYPES.has(type) || !entries || typeof entries !== 'object') continue;
    for (const [modelKey, entry] of Object.entries(entries)) {
      const modelId = Number(modelKey);
      if (!Number.isFinite(modelId)) continue;
      if ((typesByModel.get(modelId)?.size ?? 0) > 1) { ambiguous += 1; continue; }
      const name = typeof entry === 'string' ? entry : entry?.name;
      // A still-templated placeholder ("{0} Dagger Tang") is as good as no
      // name - a small handful of upgrade components ship that way upstream.
      if (!name || typeof name !== 'string' || name.includes('{')) { unnamed += 1; continue; }
      catalog[modelId] = name;
    }
  }

  return {
    catalog, count: Object.keys(catalog).length, ambiguous, unnamed,
  };
}

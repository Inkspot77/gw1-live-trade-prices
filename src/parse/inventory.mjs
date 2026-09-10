/**
 * Reading your own inventory.
 *
 * GWToolbox's Account Inventory window persists everything it has seen to
 *
 *   <Toolbox settings folder>/inventories/tmp<account-guid>.json
 *
 * rewritten on every outpost map load, on logout, and about a second after any
 * inventory change. It is a purely local file - no API, no upload - which makes
 * it the natural bridge into this dashboard. (The published docs still describe
 * an older per-character `.ini` layout; current builds write one JSON file per
 * account. Both shapes are accepted here.)
 *
 * The schema uses terse keys to keep the file small:
 *
 *   { id, rc, c: {b: {bag: {slot: ITEM}}},           // Xunlai chest
 *         ch: { "<char>": { b: {...}, h: {...} } } }  // characters + heroes
 *   ITEM = { m: model_id, f: model_file_id, i: interaction,
 *            q: quantity, e: equipped?, d: "<encoded description>" }
 *
 * `d` is the game's wide string encoded as fixed-width 4-hex code units: the
 * item's encoded *name*, then a `0002 0102 0002` separator, then shorthand
 * stats. An encoded name cannot be turned into English without the game's
 * string tables, but it is stable per item type - so it works as a fingerprint
 * that can be learned once and reused forever.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Bag ids, from GWToolbox's own BAG_NAME table. */
export const BAG_NAMES = [
  '', 'Backpack', 'Belt Pouch', 'Bag 1', 'Bag 2', 'Equipment Pack',
  'Material Storage', 'Unclaimed Items', 'Storage 1', 'Storage 2', 'Storage 3',
  'Storage 4', 'Storage 5', 'Storage 6', 'Storage 7', 'Storage 8', 'Storage 9',
  'Storage 10', 'Storage 11', 'Storage 12', 'Storage 13', 'Storage 14',
  'Equipped Items',
];

export function bagName(id) {
  return BAG_NAMES[Number(id)] ?? `Bag ${id}`;
}

/** The separator Toolbox writes between the encoded name and the stat text. */
const NAME_STAT_SEPARATOR = '000201020002';

/**
 * Model ids are the reliable identifier. Build the lookup once from the same
 * dictionary the trade-chat parser uses: keys are `<type><model>` in hex, so
 * "0b03a2" is item type 0x0b, model 0x03a2 - Glob of Ectoplasm, model 930.
 *
 * `other_items` covers stackable goods outside that materials/Zcoins item
 * type - consumables, kits, keys - that have no natural place in the
 * trade-chat price registry (they're not priced there) but are still worth
 * naming on sight. It's a plain decimal model id -> name map, sourced from
 * GWCA's ItemIDs.h (gwdevhub's community-maintained internal item ids,
 * https://github.com/GregLando113/GWCA) and cross-checked against the Guild
 * Wars Wiki for display spelling. Deliberately excluded from
 * items.mjs#loadGwToolbox(), so it cannot feed the alias matcher that
 * attributes trade-chat mentions to a price series - a wrong entry here only
 * mislabels a row in your own inventory, not someone else's price history.
 */
function buildModelIndex() {
  const raw = JSON.parse(readFileSync(`${ROOT}data/gwtoolbox-items.json`, 'utf8'));
  const byModel = new Map();
  for (const [key, name] of Object.entries(raw.materials ?? {})) {
    if (key.length < 6) continue;
    const modelId = Number.parseInt(key.slice(2, 6), 16);
    if (Number.isFinite(modelId) && !byModel.has(modelId)) byModel.set(modelId, name);
  }
  for (const [key, name] of Object.entries(raw.other_items ?? {})) {
    const modelId = Number(key);
    if (Number.isFinite(modelId) && !byModel.has(modelId)) byModel.set(modelId, name);
  }
  return byModel;
}

let MODEL_INDEX = null;
export function modelIndex() {
  MODEL_INDEX ??= buildModelIndex();
  return MODEL_INDEX;
}

/**
 * Runes, insignias and dyes carry no distinct decimal model id (a rune's
 * model id only says "rune"; the attribute and tier live in its stats), so
 * `data/gwtoolbox-items.json`'s `runes_insignias` keys them instead by their
 * exact name-fingerprint - the same hex head `nameFingerprint()` derives from
 * an item's encoded `d` field. Built once and reused as a second, still
 * built-in, identification tier alongside model id.
 */
function buildFingerprintCatalog() {
  const raw = JSON.parse(readFileSync(`${ROOT}data/gwtoolbox-items.json`, 'utf8'));
  return new Map(Object.entries(raw.runes_insignias ?? {}));
}

let FINGERPRINT_CATALOG = null;
export function fingerprintCatalog() {
  FINGERPRINT_CATALOG ??= buildFingerprintCatalog();
  return FINGERPRINT_CATALOG;
}

/**
 * The encoded-name prefix, used as a stable per-item-type key. Anything after
 * the separator is stats, which differ between two otherwise identical items,
 * so only the head is kept.
 */
export function nameFingerprint(encoded) {
  const hex = String(encoded ?? '').toLowerCase().replace(/[^0-9a-f]/g, '');
  if (!hex) return null;
  const cut = hex.indexOf(NAME_STAT_SEPARATOR);
  const head = cut === -1 ? hex : hex.slice(0, cut);
  return head || null;
}

/**
 * Some encoded names embed literal text (custom-named or inscribed items).
 * Surfacing that gives you something recognisable to map a fingerprint by,
 * instead of a wall of hex.
 */
export function readableHint(encoded) {
  const hex = String(encoded ?? '').toLowerCase().replace(/[^0-9a-f]/g, '');
  let run = '';
  const runs = [];
  for (let i = 0; i + 4 <= hex.length; i += 4) {
    const code = Number.parseInt(hex.slice(i, i + 4), 16);
    if (code >= 0x20 && code <= 0x7e) {
      run += String.fromCharCode(code);
    } else {
      if (run.length >= 3) runs.push(run);
      run = '';
    }
  }
  if (run.length >= 3) runs.push(run);
  return runs.join(' ').trim() || null;
}

function normaliseItem(raw, location) {
  const quantity = Number(raw.q ?? raw.quantity ?? 1);
  const modelId = Number(raw.m ?? raw.model_id);
  const encoded = raw.d ?? raw.description ?? '';
  return {
    modelId: Number.isFinite(modelId) ? modelId : null,
    modelFileId: Number(raw.f ?? raw.model_file_id) || null,
    interaction: Number(raw.i ?? raw.interaction) || 0,
    quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
    equipped: Boolean(raw.e ?? raw.equipped),
    fingerprint: nameFingerprint(encoded),
    hint: readableHint(encoded),
    ...location,
  };
}

function readBags(bags, location, out) {
  for (const [bagId, slots] of Object.entries(bags ?? {})) {
    for (const [slot, item] of Object.entries(slots ?? {})) {
      if (!item || typeof item !== 'object') continue;
      out.push(normaliseItem(item, {
        ...location,
        bag: bagName(bagId),
        bagId: Number(bagId),
        slot: Number(slot),
      }));
    }
  }
}

/**
 * @param {object|string} input  the parsed file, or its raw text
 * @returns {{account:string|null, representing:string|null, items:Array, owners:string[]}}
 */
export function parseToolboxInventory(input) {
  const json = typeof input === 'string' ? JSON.parse(input) : input;
  if (!json || typeof json !== 'object') throw new Error('not a Toolbox inventory file');

  const items = [];

  // Xunlai chest - shared across the whole account.
  readBags(json.c?.b ?? json.chest?.bags, { owner: 'Xunlai Chest', ownerKind: 'chest' }, items);

  const characters = json.ch ?? json.characters ?? {};
  for (const [name, character] of Object.entries(characters)) {
    if (!character || typeof character !== 'object') continue;
    readBags(character.b ?? character.bags, { owner: name, ownerKind: 'character' }, items);
    // Heroes carry real, sellable inventory too, and it is easy to forget.
    for (const [heroId, slots] of Object.entries(character.h ?? character.heroes ?? {})) {
      readBags({ 0: slots }, { owner: `${name} - hero ${heroId}`, ownerKind: 'hero' }, items);
    }
  }

  if (!items.length) throw new Error('inventory file parsed, but contained no items');

  return {
    account: json.id ?? json.account ?? null,
    representing: json.rc ?? json.representing_character ?? null,
    items,
    owners: [...new Set(items.map((i) => i.owner))],
  };
}

/**
 * The manual path: lines a person would actually type.
 *   "5 Glob of Ectoplasm"   "Glob of Ectoplasm x5"   "Glob of Ectoplasm, 5"
 *   "Glob of Ectoplasm"     (assumed 1)
 * Blank lines, bullets and # comments are ignored.
 */
export function parsePastedInventory(text) {
  const items = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.replace(/^[\s*\-]+/, '').trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    let name = trimmed;
    let quantity = 1;

    let m = /^(\d{1,4})\s*[x]?\s+(.+)$/i.exec(trimmed);
    if (m) {
      quantity = Number.parseInt(m[1], 10);
      name = m[2];
    } else if ((m = /^(.+?)[\s,]+[x]?\s*(\d{1,4})$/i.exec(trimmed))) {
      name = m[1];
      quantity = Number.parseInt(m[2], 10);
    }

    name = name.replace(/[,;]+$/, '').trim();
    if (!name) continue;
    items.push({
      modelId: null,
      quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
      equipped: false,
      fingerprint: null,
      hint: null,
      owner: 'Manual entry',
      ownerKind: 'manual',
      bag: 'Manual entry',
      declaredName: name,
    });
  }
  if (!items.length) throw new Error('no items found in the pasted text');
  return { account: null, representing: null, items, owners: ['Manual entry'] };
}

/**
 * Attach a canonical item name to each row.
 *
 * Order matters: a name you typed wins, then anything you have previously
 * taught us about this fingerprint (a correction, so it outranks every built-in
 * source), then the model id, then the built-in rune/insignia/dye fingerprint
 * catalog, then the registry's alias matcher against any readable hint. Rows
 * that stay unresolved are kept - they are still your property, and dropping
 * them would understate what you own.
 */
export function resolveNames(items, { registry = null, learned = new Map() } = {}) {
  const models = modelIndex();
  const catalog = fingerprintCatalog();
  return items.map((item) => {
    let name = null;
    let via = null;

    if (item.declaredName) {
      const matched = registry?.match(item.declaredName) ?? [];
      name = matched[0]?.name ?? item.declaredName;
      via = 'typed';
    }
    if (!name && item.fingerprint && learned.has(item.fingerprint)) {
      name = learned.get(item.fingerprint);
      via = 'learned';
    }
    if (!name && item.modelId !== null && models.has(item.modelId)) {
      name = models.get(item.modelId);
      via = 'model-id';
    }
    if (!name && item.fingerprint && catalog.has(item.fingerprint)) {
      name = catalog.get(item.fingerprint);
      via = 'catalog';
    }
    if (!name && item.hint && registry) {
      const matched = registry.match(item.hint);
      if (matched.length === 1) {
        name = matched[0].name;
        via = 'name-hint';
      }
    }
    return { ...item, name, resolvedVia: via };
  });
}

/** Collapse identical items scattered across bags into one row per item. */
export function aggregate(items) {
  const groups = new Map();
  let anonymous = 0;
  for (const item of items) {
    const key = item.name ?? `?${item.fingerprint ?? item.modelId ?? `anon-${anonymous++}`}`;
    const entry = groups.get(key) ?? {
      name: item.name,
      fingerprint: item.fingerprint,
      modelId: item.modelId,
      hint: item.hint,
      resolvedVia: item.resolvedVia,
      quantity: 0,
      locations: [],
    };
    entry.quantity += item.quantity;
    entry.locations.push({
      owner: item.owner, bag: item.bag, slot: item.slot, quantity: item.quantity,
    });
    groups.set(key, entry);
  }
  return [...groups.values()].sort((a, b) => b.quantity - a.quantity);
}

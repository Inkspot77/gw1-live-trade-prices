/**
 * Canonical item registry plus the alias matcher that maps trade-chat
 * shorthand ("ecto", "nickset", "styg gems") onto real items.
 *
 * Items come from three places:
 *   1. the GWToolbox bundle (materials, runes, insignias) -> data/gwtoolbox-items.json
 *   2. the Pre-Searing price sheet, loaded at runtime
 *   3. the curated shorthand table below, the only hand-written part
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Economies are tracked separately; a price in one says nothing about the other. */
export const REALMS = { POST: 'post', PRE: 'pre' };

/**
 * Trade-chat shorthand. Keys are canonical item names; values are the strings
 * players actually type. Kept deliberately small and high-confidence — a wrong
 * alias silently poisons a price series.
 */
const ALIASES = {
  'Glob of Ectoplasm': ['ecto', 'ectos', 'ectoplasm', 'globs'],
  'Obsidian Shard': ['shard', 'shards', 'obby shard', 'obsi shard'],
  'Stygian Gem': ['styg gem', 'styg gems', 'stygian gems', 'stygs'],
  'Armbrace of Truth': ['armbrace', 'armbraces', 'arm brace'],
  'Zaishen Key': ['zkey', 'zkeys', 'z key', 'z keys', 'zaishen keys'],
  'Lockpick': ['lockpick', 'lockpicks', 'picks'],
  'Gift of the Traveler': ['nick set', 'nicksets', 'nickset', 'nick sets', 'nicks'],
  'Consumable Set': ['conset', 'consets', 'cons set', 'cons sets'],
  'Essence of Celerity': ['essence', 'essences'],
  'Grail of Might': ['grail', 'grails'],
  'Armor of Salvation': ['armor of salv', 'aos'],
  'Birthday Cupcake': ['cupcake', 'cupcakes', 'bcakes'],
  'Delicious Cake': ['dcake', 'dcakes', 'delicious cakes'],
  'Powerstone of Courage': ['powerstone', 'powerstones', 'pstones'],
  'Party Beacon': ['pbeacon', 'pbeacons', 'party beacons'],
  'Golden Egg': ['golden egg', 'golden eggs', 'geggs'],
  // 'bd'/'bds' are deliberately absent: they are a currency unit (handled in
  // currency.mjs) and, in Post-Searing, a common weapon-skin abbreviation.
  'Black Dye': ['black dye', 'black dyes'],
  'Unidentified Gold Item': ['unid', 'unids', 'unided golds', 'gold unids'],
  'Elonian Leather Square': ['elonian leather', 'ele leather'],
  'Deldrimor Steel Ingot': ['deldrimor steel', 'deld steel'],
  'Monstrous Claw': ['claws', 'monster claws'],
  'Pile of Glittering Dust': ['dust', 'glittering dust'],
  'Tanned Hide Square': ['tanned hides', 'hides'],
  'Bolt of Damask': ['damask'],
  'Bolt of Silk': ['silk'],
  'Bolt of Linen': ['linen'],
  'Roll of Vellum': ['vellum'],
  'Spiritwood Plank': ['spiritwood'],
  'Amber Chunk': ['amber'],
  'Jadeite Shard': ['jadeite', 'jade'],
  'Ruby': ['rubies'],
  'Sapphire': ['sapphires'],
  'Diamond': ['diamonds'],
  'Onyx Gemstone': ['onyx'],
  'Lump of Charcoal': ['charcoal'],
  'Steel Ingot': ['steel'],
  'Iron Ingot': ['iron'],
  'Granite Slab': ['granite'],
  'Chitin Fragment': ['chitin'],
  'Fur Square': ['fur', 'furs'],
  'Vial of Ink': ['ink'],
  // Pre-Searing shorthand
  'Charr Salvage Kit': ['charr kit', 'charr kits'],
  'Charr Bag': ['charr bag', 'charr bags'],
  'Fiery Dragon Sword': ['fds', 'fiery dragon'],
  'Rockmolder': ['rockmolder'],
  'Iris Flower': ['iris', 'irises'],
  'Red Iris Flower': ['red iris'],
};

/** Only meaningful in Pre-Searing; keeps the two economies from bleeding. */
const PRE_ONLY = new Set([
  'Charr Salvage Kit', 'Charr Bag', 'Fiery Dragon Sword', 'Rockmolder',
  'Iris Flower', 'Red Iris Flower',
]);

/** Only meaningful in Post-Searing. */
const POST_ONLY = new Set([
  'Glob of Ectoplasm', 'Obsidian Shard', 'Stygian Gem', 'Armbrace of Truth',
  'Zaishen Key', 'Gift of the Traveler', 'Consumable Set', 'Amber Chunk',
  'Jadeite Shard', 'Elonian Leather Square', 'Deldrimor Steel Ingot',
  'Spiritwood Plank', 'Unidentified Gold Item',
]);

/** Collapsing form — used to build alias keys, where spacing is irrelevant. */
function normaliseAlias(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Length-preserving form — used on the text being searched. Every character
 * maps to exactly one character, so a match offset here is also a valid offset
 * into the string the currency parser saw. Callers pass text already flattened
 * by `prepare()`, so no whitespace collapsing is needed (or permitted).
 */
function normaliseHaystack(text) {
  return ` ${String(text).toLowerCase().replace(/[^a-z0-9]/g, ' ')} `;
}

/**
 * Words too generic to identify an item on their own. A loose alias here is
 * worse than a missing one: it silently attributes unrelated chat to an item
 * and poisons that item's whole price series.
 */
const TOO_GENERIC = new Set([
  'blue', 'red', 'green', 'white', 'black', 'grey', 'gray', 'purple', 'orange',
  'yellow', 'brown', 'pink', 'silver', 'gold', 'common', 'rare', 'uncommon',
  'none', 'other', 'misc', 'dye', 'dyes', 'set', 'sets', 'kit', 'kits', 'bag',
  'bags', 'item', 'items', 'price', 'notes', 'name', 'image', 'total', 'basic',
]);

/** Multi-word names are safe; single words must be long and not generic. */
function isDistinctive(name) {
  const normalised = normaliseAlias(name);
  if (!normalised) return false;
  const words = normalised.split(' ').filter(Boolean);
  if (words.some((w) => TOO_GENERIC.has(w)) && words.length === 1) return false;
  if (words.length >= 2) return true;
  return words[0].length >= 6;
}

export class ItemRegistry {
  constructor() {
    /** @type {Map<string, {name:string, category:string, realm:string|null, modelId?:string}>} */
    this.items = new Map();
    /** @type {Array<{alias:string, name:string}>} sorted longest-first */
    this.aliasIndex = [];
  }

  add(name, { category = 'Other', realm = null, modelId = null, aliasable = true } = {}) {
    if (!name) return;
    const existing = this.items.get(name);
    if (existing) {
      if (modelId && !existing.modelId) existing.modelId = modelId;
      // A name reachable from a precise source stays matchable.
      if (aliasable) existing.aliasable = true;
      return;
    }
    this.items.set(name, { name, category, realm, modelId, aliasable });
  }

  /** Load materials / runes / insignias extracted from the GWToolbox bundle. */
  loadGwToolbox() {
    const raw = JSON.parse(readFileSync(`${ROOT}data/gwtoolbox-items.json`, 'utf8'));
    const rare = new Set(raw.rare_materials);
    const common = new Set(raw.common_materials);
    for (const [modelId, name] of Object.entries(raw.materials)) {
      const category = rare.has(modelId) ? 'Rare Material'
        : common.has(modelId) ? 'Common Material' : 'Material';
      this.add(name, { category, realm: REALMS.POST, modelId });
    }
    for (const name of Object.values(raw.runes_insignias)) {
      this.add(name, { category: name.includes('Insignia') ? 'Insignia' : 'Rune' });
    }
    return this;
  }

  /**
   * Pre-Searing sheet rows arrive as {name, category}. Sheet names are column
   * labels, not full item names — "Blue" is a dye, "Smiting" is a rune — so the
   * vague ones are stored for display but kept out of the chat matcher.
   */
  loadPreSearing(rows) {
    for (const row of rows) {
      this.add(row.name, {
        category: row.category,
        realm: REALMS.PRE,
        aliasable: isDistinctive(row.name),
      });
    }
    return this;
  }

  /** Must run after every load; folds aliases in and sorts the match index. */
  build() {
    for (const name of Object.keys(ALIASES)) {
      if (!this.items.has(name)) {
        const realm = PRE_ONLY.has(name) ? REALMS.PRE
          : POST_ONLY.has(name) ? REALMS.POST : null;
        this.add(name, { category: 'Tradeable', realm });
      }
    }
    // Realm hints from the curated sets win over whatever a source guessed.
    for (const [name, item] of this.items) {
      if (PRE_ONLY.has(name)) item.realm = REALMS.PRE;
      else if (POST_ONLY.has(name)) item.realm = REALMS.POST;
    }

    const index = [];
    for (const [name, item] of this.items) {
      if (item.aliasable === false) continue;
      const base = normaliseAlias(name);
      index.push({ alias: base, name });
      index.push({ alias: `${base}s`, name });
    }
    for (const [name, aliases] of Object.entries(ALIASES)) {
      for (const alias of aliases) index.push({ alias: normaliseAlias(alias), name });
    }
    // Longest alias first so "obsidian shard" beats "shard".
    const seen = new Set();
    this.aliasIndex = index
      .filter(({ alias }) => alias.length >= 2)
      .sort((a, b) => b.alias.length - a.alias.length)
      .filter(({ alias, name }) => {
        const key = `${alias} ${name}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    return this;
  }

  /**
   * Find every item mentioned in a message. Matches are non-overlapping and
   * longest-first, so a span of text is only ever attributed to one item.
   */
  match(text, realm = null) {
    const hay = normaliseHaystack(text);
    const claimed = [];
    const found = [];
    for (const { alias, name } of this.aliasIndex) {
      const item = this.items.get(name);
      if (realm && item.realm && item.realm !== realm) continue;
      const needle = ` ${alias} `;
      let from = 0;
      for (;;) {
        const at = hay.indexOf(needle, from);
        if (at === -1) break;
        const start = at + 1;
        const end = start + alias.length;
        if (!claimed.some(([s, e]) => start < e && end > s)) {
          claimed.push([start, end]);
          found.push({ name, category: item.category, at: start });
        }
        from = at + 1;
      }
    }
    return found.sort((a, b) => a.at - b.at);
  }

  list() {
    return [...this.items.values()];
  }
}

export function createRegistry() {
  return new ItemRegistry().loadGwToolbox().build();
}

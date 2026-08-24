/**
 * GWToolbox trade-chat mirrors — the live player market.
 *
 *   kamadan.gwtoolbox.com  -> Post-Searing (Kamadan AE1 trade chat)
 *   ascalon.gwtoolbox.com  -> Pre-Searing  (Ascalon AE1 trade chat)
 *
 * Three undocumented but stable endpoints are used:
 *   GET /m                              latest ~100 messages, [{t,s,m,r}]
 *   GET /s/<term>                       search back through the archive
 *   GET /pricing_history/<id>/<from>/<to>  NPC trader quote history
 *
 * The homepage also ships `window.current_trader_quotes` inline, which is the
 * only live source of in-game material-trader prices anywhere.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { REALMS } from '../parse/items.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ITEM_DATA = JSON.parse(readFileSync(`${ROOT}data/gwtoolbox-items.json`, 'utf8'));

export const MIRRORS = {
  [REALMS.POST]: { host: 'https://kamadan.gwtoolbox.com', label: 'Kamadan' },
  [REALMS.PRE]: { host: 'https://ascalon.gwtoolbox.com', label: 'Ascalon' },
};

const UA = { 'user-agent': 'gw1-price-dashboard (personal, low-rate)' };

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * These are someone else's servers and they do rate-limit. Back off on 429 and
 * 503 rather than hammering, honouring Retry-After when it is offered.
 */
async function getJson(url, { timeout = 20_000, retries = 4 } = {}) {
  let wait = 1500;
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeout) });
    if (response.ok) return response.json();

    const retryable = response.status === 429 || response.status === 503;
    if (!retryable || attempt >= retries) {
      throw new Error(`${url} -> HTTP ${response.status}`);
    }
    const header = Number(response.headers.get('retry-after'));
    await sleep(Number.isFinite(header) && header > 0 ? header * 1000 : wait);
    wait *= 2;
  }
}

/** Latest trade-chat messages for one realm. */
export async function fetchMessages(realm) {
  const mirror = MIRRORS[realm];
  if (!mirror) throw new Error(`unknown realm ${realm}`);
  const raw = await getJson(`${mirror.host}/m`);
  return raw.map((m) => ({
    ts: Number(m.t),
    seller: String(m.s ?? '').trim(),
    message: String(m.m ?? '').trim(),
    realm,
    source: mirror.label,
  })).filter((m) => Number.isFinite(m.ts) && m.message);
}

/** Search the archive — reaches much further back than /m. */
export async function searchMessages(realm, term) {
  const mirror = MIRRORS[realm];
  if (!mirror) throw new Error(`unknown realm ${realm}`);
  const url = `${mirror.host}/s/${encodeURIComponent(term)}`;
  const raw = await getJson(url);
  const rows = Array.isArray(raw) ? raw : (raw.results ?? []);
  return rows.map((m) => ({
    ts: Number(m.t),
    seller: String(m.s ?? '').trim(),
    message: String(m.m ?? '').trim(),
    realm,
    source: mirror.label,
  })).filter((m) => Number.isFinite(m.ts) && m.message);
}

/**
 * Pull a JSON object literal out of an inline `<script>` assignment.
 *
 * A non-greedy regex cannot do this: the payload is deeply nested, so the first
 * `};` it finds is inside a child object. Counting braces (while respecting
 * string literals and escapes) is the only correct way.
 */
function extractInlineObject(html, assignee, isUsable = () => true) {
  // The page assigns the name twice: an empty `{}` placeholder, then the real
  // payload. Walk every occurrence and take the first one the caller accepts.
  let marker = html.indexOf(assignee);
  while (marker !== -1) {
    const start = html.indexOf('{', marker);
    if (start === -1) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;
    let parsed = null;
    for (let i = start; i < html.length; i += 1) {
      const ch = html[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            parsed = JSON.parse(html.slice(start, i + 1));
          } catch {
            parsed = null;
          }
          break;
        }
      }
    }
    if (parsed && isUsable(parsed)) return parsed;
    marker = html.indexOf(assignee, marker + assignee.length);
  }
  return null;
}

const MATERIAL_NAMES = ITEM_DATA.materials;

/**
 * Live NPC material-trader quotes, scraped from the inline bootstrap on the
 * Kamadan homepage. `buy` is what you pay the trader; `sell` is what it pays you.
 */
export async function fetchTraderQuotes() {
  const response = await fetch(MIRRORS[REALMS.POST].host, {
    headers: UA,
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`trader quotes -> HTTP ${response.status}`);
  const html = await response.text();

  const payload = extractInlineObject(
    html,
    'window.current_trader_quotes',
    (o) => Object.keys(o.buy ?? {}).length > 0 || Object.keys(o.sell ?? {}).length > 0,
  );
  if (!payload) throw new Error('trader quotes: inline bootstrap not found or unparseable');

  const out = [];
  // GWToolbox's "buy"/"sell" are from the player's point of view; our schema
  // uses order-book terms, where the trader's offer to sell is the ask.
  for (const [key, side] of [['buy', 'ask'], ['sell', 'bid']]) {
    for (const entry of Object.values(payload[key] ?? {})) {
      const modelId = String(entry.m ?? '');
      const item = MATERIAL_NAMES[modelId];
      const gold = Number(entry.p);
      const ts = Number(entry.t) * 1000;
      if (!item || !Number.isFinite(gold) || !Number.isFinite(ts)) continue;
      out.push({ ts, modelId, item, side, gold });
    }
  }
  return out;
}

/** Archived trader quotes for one material, used to draw the long baseline. */
export async function fetchTraderHistory(modelId, fromMs, toMs) {
  const url = `${MIRRORS[REALMS.POST].host}/pricing_history/${modelId}/${Math.round(fromMs)}/${Math.round(toMs)}`;
  const raw = await getJson(url, { timeout: 30_000 });
  const item = MATERIAL_NAMES[modelId];
  return raw.map((row) => ({
    ts: Number(row.t) * 1000,
    modelId,
    item,
    // An `s` flag marks the trader's sell-to-player list; absent means buy.
    side: row.s ? 'bid' : 'ask',
    gold: Number(row.p),
  })).filter((r) => r.item && Number.isFinite(r.gold) && Number.isFinite(r.ts));
}

/** Materials worth charting: the rare ones plus the commons players actually trade. */
export function trackedMaterials() {
  return [...ITEM_DATA.rare_materials, ...ITEM_DATA.common_materials]
    .map((modelId) => ({ modelId, item: MATERIAL_NAMES[modelId] }))
    .filter((m) => m.item);
}

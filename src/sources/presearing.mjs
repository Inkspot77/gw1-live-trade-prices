/**
 * presearing.com/pricecheck — the Pre-Searing community price guide.
 *
 * The page itself is a Wix shell that renders a single embedded HTML app; that
 * app reads a public Google Sheet. Going straight to the sheet skips two layers
 * of rendering and, more importantly, exposes the dated low/high columns the
 * rendered page only shows one of.
 *
 * Each worksheet is laid out as:
 *   <category> | <name> | <description> | <image> | Price Low <d> | Price High <d> | ...
 * with one Low/High pair per historical snapshot, going back to 2019 —
 * the deepest price history available for either economy.
 */

import { REALMS } from '../parse/items.mjs';

const SHEET_ID = '1u8-n_EJe9Nfl1twUHExLeuuYNT0Szo_7ss4HmmNytqk';
const WORKSHEETS = ['Runes', 'Insignias', 'Consumables', 'Inscriptions', 'Minipets', 'Weapon Mods'];

const UA = { 'user-agent': 'ectowatch (personal, low-rate)' };

/** Minimal RFC-4180 CSV reader; the sheet quotes every field. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { value += '"'; i += 1; } else { quoted = false; }
      } else value += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(value); value = ''; }
    else if (ch === '\n') { row.push(value); rows.push(row); row = []; value = ''; }
    else if (ch !== '\r') value += ch;
  }
  if (value || row.length) { row.push(value); rows.push(row); }
  return rows;
}

/**
 * The sheet writes prices the way players speak: "15k", "250g", "1BD", "2 BD".
 * BD is Black Dye, Pre-Searing's reserve currency, so it needs a live rate.
 */
export function parseSheetPrice(raw, blackDyeGold) {
  const text = String(raw ?? '').trim().toLowerCase();
  if (!text || text === '-' || text === 'n/a') return null;
  const m = /^([\d.,]+)\s*(bds?|k|g|p)?$/.exec(text.replace(/\s+/g, ' '));
  if (!m) return null;
  const value = Number.parseFloat(m[1].replace(/,(?=\d{3}\b)/g, '').replace(',', '.'));
  if (!Number.isFinite(value)) return null;
  switch (m[2]) {
    case 'k': case 'p': return value * 1000;
    case 'bd': case 'bds': return value * blackDyeGold;
    default: return value;
  }
}

/** "Price Low 21/07/2026" -> epoch ms. The sheet is day/month/year. */
function parseColumnDate(header) {
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(header);
  if (!m) return null;
  return Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
}

async function fetchWorksheet(name) {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq`
    + `?tqx=out:csv&sheet=${encodeURIComponent(name)}`;
  const response = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${name} -> HTTP ${response.status}`);
  const text = await response.text();
  if (/^\s*<!doctype html|^\s*<html/i.test(text)) {
    throw new Error(`${name}: sheet is not publicly readable`);
  }
  return parseCsv(text);
}

/**
 * Locate the name column. Layout drifts between worksheets — most lead with a
 * category column, but Consumables puts Description second and Inscriptions
 * names its first column outright.
 */
function findNameColumn(header) {
  const named = header.findIndex((h) => /^(item\s*name|name)$/i.test(h.trim()));
  if (named >= 0) return named;
  // Fall back to the column just before Description/Image.
  const marker = header.findIndex((h) => /^(description|image|notes|rarity)$/i.test(h.trim()));
  return marker > 0 ? marker - 1 : 1;
}

/**
 * @returns {{items: Array, prices: Array}} items for the registry, prices for
 * the sheet_prices table (one row per item per dated snapshot).
 */
export async function fetchPreSearingSheet(blackDyeGold) {
  const items = [];
  const prices = [];
  const errors = [];

  for (const worksheet of WORKSHEETS) {
    let rows;
    try {
      rows = await fetchWorksheet(worksheet);
    } catch (error) {
      errors.push(`${worksheet}: ${error.message}`);
      continue;
    }
    if (rows.length < 2) continue;

    const header = rows[0];
    const nameCol = findNameColumn(header);

    // Pair up "Price Low <date>" / "Price High <date>" columns by date.
    const snapshots = new Map();
    header.forEach((cell, index) => {
      const asOf = parseColumnDate(cell);
      if (asOf === null) return;
      const entry = snapshots.get(asOf) ?? { asOf, low: null, high: null };
      if (/low/i.test(cell)) entry.low = index;
      else if (/high/i.test(cell)) entry.high = index;
      snapshots.set(asOf, entry);
    });

    let category = worksheet;
    for (const row of rows.slice(1)) {
      // Column 0 carries a sub-category that only appears on its first row.
      if (row[0]?.trim() && nameCol !== 0) category = row[0].trim();
      const name = row[nameCol]?.trim();
      if (!name) continue;

      items.push({ name, category: `${worksheet} / ${category}`, realm: REALMS.PRE });

      for (const snap of snapshots.values()) {
        const low = snap.low === null ? null : parseSheetPrice(row[snap.low], blackDyeGold);
        const high = snap.high === null ? null : parseSheetPrice(row[snap.high], blackDyeGold);
        if (low === null && high === null) continue;
        prices.push({
          item: name,
          category: `${worksheet} / ${category}`,
          realm: REALMS.PRE,
          asOf: snap.asOf,
          lowGold: low,
          highGold: high,
        });
      }
    }
  }

  return { items, prices, errors };
}

/**
 * Black Dye anchors every "BD" price in Pre-Searing, so it is read from the
 * sheet's own Consumables/Dyes row before anything else is converted.
 */
export async function fetchBlackDyeRate(fallback) {
  try {
    const rows = await fetchWorksheet('Consumables');
    const header = rows[0];
    const nameCol = findNameColumn(header);
    const dated = header
      .map((cell, index) => ({ asOf: parseColumnDate(cell), index, cell }))
      .filter((c) => c.asOf !== null)
      .sort((a, b) => b.asOf - a.asOf);

    const row = rows.slice(1).find((r) => /^black$/i.test(r[nameCol]?.trim() ?? ''));
    if (!row) return fallback;

    // Newest snapshot that actually has numbers; midpoint of the band.
    for (const { asOf } of dated) {
      const low = dated.find((c) => c.asOf === asOf && /low/i.test(c.cell));
      const high = dated.find((c) => c.asOf === asOf && /high/i.test(c.cell));
      const lowGold = low ? parseSheetPrice(row[low.index], fallback) : null;
      const highGold = high ? parseSheetPrice(row[high.index], fallback) : null;
      if (lowGold !== null && highGold !== null) return (lowGold + highGold) / 2;
      if (lowGold !== null) return lowGold;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

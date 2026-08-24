/**
 * wiki.guildwars.com — the demand calendar.
 *
 * The wiki holds no market prices, but it holds the thing that *moves* them:
 * which items the game is asking players for today. Nicholas Sandford (Pre) and
 * Nicholas the Traveler (Post) each want a specific collectable, and Zaishen
 * quests drive demand for keys, consumables and specific areas' drops. An item
 * on today's list is temporarily scarce; the same item next week is not.
 *
 * `action=parse` is used rather than `prop=wikitext` because both pages express
 * their rotation through `{{Cycle}}` template variables that only resolve when
 * the page is rendered.
 */

const API = 'https://wiki.guildwars.com/api.php';
const UA = { 'user-agent': 'gw1-price-dashboard (personal, low-rate)' };

async function parsePage(title) {
  const url = `${API}?action=parse&page=${encodeURIComponent(title)}`
    + '&prop=text&format=json&formatversion=2';
  const response = await fetch(url, { headers: UA, signal: AbortSignal.timeout(25_000) });
  if (!response.ok) throw new Error(`wiki ${title} -> HTTP ${response.status}`);
  const json = await response.json();
  if (json.error) throw new Error(`wiki ${title} -> ${json.error.info}`);
  return json.parse.text;
}

function stripTags(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The daily activities table, one row per day. Today's row is the one that
 * matters; the surrounding days let the UI show what is arriving and leaving.
 */
export async function fetchDailyActivities() {
  const html = await parsePage('Daily activities');
  const rows = [...html.matchAll(/<tr[\s\S]*?<\/tr>/g)]
    .map((m) => [...m[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => stripTags(c[1])))
    .filter((cells) => cells.length >= 8);

  if (!rows.length) throw new Error('daily activities: no table rows parsed');

  const header = rows[0];
  const days = rows.slice(1)
    .map((cells) => {
      const date = Date.parse(`${cells[0]} UTC`);
      if (!Number.isFinite(date)) return null;
      const day = {};
      header.forEach((key, i) => { day[key] = cells[i] ?? ''; });
      return { date, ...day };
    })
    .filter(Boolean)
    .sort((a, b) => a.date - b.date);

  // The wiki rolls over at 16:00 UTC, not midnight.
  const now = Date.now();
  const cutoff = now - 16 * 3600 * 1000;
  const todayKey = new Date(cutoff).toISOString().slice(0, 10);
  const today = days.find((d) => new Date(d.date).toISOString().slice(0, 10) === todayKey)
    ?? days.findLast((d) => d.date <= now);

  return { header, days, today, fetchedAt: now };
}

/**
 * Nicholas the Traveler's current week: location plus the item and the quantity
 * he wants per gift. A "nickset" — five gifts' worth — is what Kamadan actually
 * trades, so the multiple is computed here rather than in the UI.
 */
export async function fetchNicholasTheTraveler() {
  const text = stripTags(await parsePage('Nicholas the Traveler'));

  const week = /week beginning\s+(\d{1,2}\s+\w+\s+\d{4})/i.exec(text);
  const collecting = /\(collecting\s+(\d+)\s+(.+?)\s+per gift\)/i.exec(text);
  if (!collecting) return null;

  const qtyPerGift = Number.parseInt(collecting[1], 10);
  // The location is the last place name before the "(collecting ...)" clause.
  const before = text.slice(Math.max(0, collecting.index - 160), collecting.index).trim();
  const location = before.split(/\s{2,}|\)\s*/).pop()?.trim() || null;

  return {
    weekBeginning: week ? Date.parse(`${week[1]} UTC`) : null,
    location,
    item: collecting[2].trim(),
    qtyPerGift,
    // Five gifts per week is the full set players trade as a unit.
    nicksetQty: qtyPerGift * 5,
  };
}

/** Nicholas Sandford (Pre-Searing) rotates daily and appears in the same table. */
export function nicholasSandfordFrom(daily) {
  const column = daily?.header?.find((h) => /sandford/i.test(h));
  if (!column || !daily.today) return null;
  const item = daily.today[column]?.trim();
  return item ? { item, date: daily.today.date } : null;
}

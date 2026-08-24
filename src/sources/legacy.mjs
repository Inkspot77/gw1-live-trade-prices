/**
 * guildwarslegacy.com "Price check" board (forum 12).
 *
 * This board is where players appraise *individual* rare weapons — the things
 * that never appear in a materials table because each one is unique (skin,
 * requirement, inherent mods). No structured price lives here, so it is treated
 * as evidence rather than data: threads are indexed, linked to items where the
 * title allows, and surfaced beside the numeric sources for context.
 */

const RSS_URL = 'https://guildwarslegacy.com/forum/thread-list-rss-feed/12/';
const BOARD_URL = 'https://guildwarslegacy.com/forum/board/12-price-check/';
const UA = { 'user-agent': 'gw1-price-dashboard (personal, low-rate)' };

function decodeEntities(text) {
  return String(text)
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&')
    .trim();
}

function tag(xml, name) {
  const m = new RegExp(`<${name}[^>]*>(.*?)</${name}>`, 's').exec(xml);
  return m ? decodeEntities(m[1]) : null;
}

/**
 * Prefer the board's RSS feed; fall back to scraping thread links off the board
 * page if the feed is unavailable, so a feed outage does not blank the panel.
 */
export async function fetchPriceCheckThreads(registry) {
  let threads = [];
  try {
    threads = await fetchFromRss();
  } catch {
    threads = [];
  }
  if (!threads.length) threads = await fetchFromBoard();

  return threads.map((t) => ({
    ...t,
    // Weapon names in titles ("Eternal Shield q8", "Paper Fan r9") are the only
    // link back to the item vocabulary; many will legitimately match nothing.
    items: registry ? [...new Set(registry.match(t.title).map((m) => m.name))] : [],
  }));
}

async function fetchFromRss() {
  const response = await fetch(RSS_URL, { headers: UA, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`legacy rss -> HTTP ${response.status}`);
  const xml = await response.text();

  const out = [];
  for (const m of xml.matchAll(/<item[^>]*>(.*?)<\/item>/gs)) {
    const block = m[1];
    const title = tag(block, 'title');
    const url = tag(block, 'link') ?? tag(block, 'guid');
    if (!title || !url) continue;
    const date = tag(block, 'pubDate') ?? tag(block, 'dc:date');
    const postedAt = date ? Date.parse(date) : null;
    out.push({ title, url, postedAt: Number.isFinite(postedAt) ? postedAt : null });
  }
  return out;
}

async function fetchFromBoard() {
  const response = await fetch(BOARD_URL, { headers: UA, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`legacy board -> HTTP ${response.status}`);
  const html = await response.text();

  const seen = new Map();
  for (const m of html.matchAll(/href="(https:\/\/guildwarslegacy\.com\/forum\/thread\/(\d+)-([^/"]+)\/)"/g)) {
    const [, url, id, slug] = m;
    if (url.includes('action=')) continue;
    if (seen.has(id)) continue;
    // Titles are only present as slugs here; de-slug them for display.
    const title = slug.replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
    seen.set(id, { title, url, postedAt: null });
  }
  return [...seen.values()];
}

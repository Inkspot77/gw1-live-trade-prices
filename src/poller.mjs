/**
 * The collection loop.
 *
 * Sources are polled on independent schedules matched to how fast each one
 * actually changes: trade chat moves every few seconds, the NPC trader every
 * half hour or so, the wiki once a day, the Pre-Searing sheet almost never.
 * Every source is isolated — one failing never stops the others, and the last
 * error is recorded so the dashboard can show what is stale.
 */

import { createRegistry, REALMS } from './parse/items.mjs';
import { parseTradeMessage } from './parse/trade.mjs';
import { DEFAULT_RATES } from './parse/currency.mjs';
import * as gwtoolbox from './sources/gwtoolbox.mjs';
import * as presearing from './sources/presearing.mjs';
import * as legacy from './sources/legacy.mjs';
import * as wiki from './sources/wiki.mjs';
import * as custom from './sources/custom.mjs';
import { evaluateSellAlerts } from './valuation.mjs';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const SCHEDULE = {
  chat: 2 * MINUTE,
  trader: 20 * MINUTE,
  wiki: 6 * HOUR,
  sheet: 12 * HOUR,
  forum: 30 * MINUTE,
  custom: 30 * MINUTE,
};

export class Poller {
  constructor(store, { log = console.log } = {}) {
    this.store = store;
    this.log = log;
    this.registry = createRegistry();
    this.rates = { ...DEFAULT_RATES, ...(store.getContext('rates') ?? {}) };
    this.status = store.getContext('sourceStatus') ?? {};
    this.timers = [];
  }

  /** Record per-source health so the UI can be honest about staleness. */
  mark(source, ok, detail = null) {
    this.status[source] = {
      ok,
      at: Date.now(),
      detail: detail === null ? null : String(detail).slice(0, 300),
    };
    this.store.setContext('sourceStatus', this.status);
  }

  async run(name, task) {
    try {
      const detail = await task();
      this.mark(name, true, detail);
      this.log(`[poll] ${name}: ${detail ?? 'ok'}`);
    } catch (error) {
      this.mark(name, false, error.message);
      this.log(`[poll] ${name} FAILED: ${error.message}`);
    }
  }

  /** Trade chat for one realm -> parsed quotes -> observations. */
  async pollChat(realm) {
    const messages = await gwtoolbox.fetchMessages(realm);
    const rows = [];
    for (const m of messages) {
      for (const quote of parseTradeMessage(m.message, this.registry, { rates: this.rates, realm })) {
        rows.push({
          ts: m.ts,
          source: m.source,
          realm,
          item: quote.item,
          category: quote.category,
          side: quote.side,
          unitGold: quote.unitGold,
          currency: quote.currency,
          qty: quote.qty,
          confidence: quote.confidence,
          seller: m.seller,
          raw: m.message,
        });
      }
    }
    const inserted = this.store.saveObservations(rows);
    return `${messages.length} messages, ${rows.length} quotes, ${inserted} new`;
  }

  /** Live NPC trader quotes; also refreshes the ecto rate the parser uses. */
  async pollTrader() {
    const quotes = await gwtoolbox.fetchTraderQuotes();
    this.store.saveTraderQuotes(quotes);

    const ecto = quotes.find((q) => q.item === 'Glob of Ectoplasm' && q.side === 'ask');
    if (ecto?.gold > 0) {
      this.rates = { ...this.rates, ecto: ecto.gold };
      this.store.setContext('rates', this.rates);
    }
    return `${quotes.length} trader quotes (ecto ${Math.round(this.rates.ecto)}g)`;
  }

  /**
   * Backfill NPC trader history. Cheap and one-shot: it gives every material a
   * real 90-day baseline on first run instead of waiting three months for the
   * live poller to build one.
   */
  async backfillTraderHistory(days = 90) {
    const to = Date.now();
    const from = to - days * 86_400_000;
    let total = 0;
    let skipped = 0;

    for (const { modelId, item } of gwtoolbox.trackedMaterials()) {
      // Resumable: a material that already has real depth is left alone, so a
      // rate-limited run can simply be repeated until it completes.
      if (this.store.traderHistory(item, from).length > 100) {
        skipped += 1;
        continue;
      }
      try {
        const rows = await gwtoolbox.fetchTraderHistory(modelId, from, to);
        total += this.store.saveTraderQuotes(rows);
      } catch (error) {
        this.log(`[backfill] ${item ?? modelId}: ${error.message}`);
      }
      // Deliberately unhurried: this is someone else's server, and the whole
      // job only needs to succeed once.
      await new Promise((resolve) => { setTimeout(resolve, 1500); });
    }
    this.store.checkpoint();
    return `${total} historical trader quotes (${skipped} already complete)`;
  }

  /** Pre-Searing price guide: item vocabulary plus dated historical bands. */
  async pollSheet() {
    const blackDye = await presearing.fetchBlackDyeRate(this.rates.blackDye);
    if (blackDye > 0) {
      this.rates = { ...this.rates, blackDye };
      this.store.setContext('rates', this.rates);
    }

    const { items, prices, errors } = await presearing.fetchPreSearingSheet(blackDye);
    this.store.saveSheetPrices(prices);

    // Fold the sheet's vocabulary into the matcher so Ascalon chat can name
    // items that only the guide knows about.
    this.registry.loadPreSearing(items).build();

    const suffix = errors.length ? ` (${errors.length} worksheet errors)` : '';
    return `${items.length} items, ${prices.length} dated prices, BD=${Math.round(blackDye)}g${suffix}`;
  }

  /**
   * Armbraces and Zaishen Keys are quoted as currency ("10a/stk", "18zkey") but
   * unlike ectos they have no NPC trader to anchor them, so a hard-coded rate
   * goes stale and silently distorts every price quoted in them. They are
   * themselves traded items, so the market tells us what they are worth.
   */
  refreshDerivedRates() {
    const since = Date.now() - 14 * 24 * 3600 * 1000;
    // Both sides count: for a currency item the mid is what we want, and asks
    // alone are often too sparse to clear the sample floor.
    const derive = (item) => {
      const values = this.store.observations(REALMS.POST, item, since)
        .map((o) => o.unitGold)
        .filter((v) => v > 0)
        .sort((a, b) => a - b);
      if (values.length < 3) return null;
      return values[values.length >> 1];
    };

    const arm = derive('Armbrace of Truth');
    const zkey = derive('Zaishen Key');
    const next = { ...this.rates };
    if (arm > 0) next.arm = arm;
    if (zkey > 0) next.zkey = zkey;

    this.rates = next;
    this.store.setContext('rates', next);
    return `arm=${Math.round(next.arm)}g zkey=${Math.round(next.zkey)}g`;
  }

  /**
   * Re-evaluate sell alerts against current holdings. Runs on the poll loop so
   * an alert fires whether or not the dashboard is open in a browser.
   */
  checkSellAlerts() {
    const { opened, closed, open } = evaluateSellAlerts(this.store, this);
    for (const alert of opened) {
      this.log(`[alert] ${alert.item}: ${alert.reason}`);
    }
    return `${open.length} open (+${opened.length} new, -${closed.length} cleared)`;
  }

  async pollWiki() {
    const daily = await wiki.fetchDailyActivities();
    this.store.setContext('daily', daily);

    const sandford = wiki.nicholasSandfordFrom(daily);
    if (sandford) this.store.setContext('sandford', sandford);

    let traveler = null;
    try {
      traveler = await wiki.fetchNicholasTheTraveler();
      if (traveler) this.store.setContext('traveler', traveler);
    } catch (error) {
      this.log(`[poll] traveler: ${error.message}`);
    }

    return `daily ok (Sandford: ${sandford?.item ?? '?'}, Traveler: ${traveler?.item ?? '?'})`;
  }

  async pollForum() {
    const threads = await legacy.fetchPriceCheckThreads(this.registry);
    this.store.saveThreads(threads);
    return `${threads.length} price-check threads`;
  }

  /**
   * User-added sources, each polled and tracked independently — the same
   * "one failing never stops the others" rule as every built-in source, so a
   * mistyped URL in a source someone added shows a red dot on that one entry
   * rather than breaking the poll loop.
   */
  async pollCustomSources() {
    const configs = this.store.getContext('customSources') ?? [];
    const enabled = configs.filter((c) => c.enabled !== false);
    if (!enabled.length) return '0 custom sources configured';

    let totalNew = 0;
    for (const cfg of enabled) {
      const label = `custom:${cfg.name || cfg.id}`;
      try {
        const { rows, total, skipped } = await custom.fetchCustomSource(cfg);
        const realm = cfg.realm === 'pre' ? 'pre' : 'post';
        const observations = rows.map((r) => {
          // Reuse the same alias/registry matching trade chat gets, so a
          // user-added source's "Ecto" lands on the same item as everything
          // else instead of becoming its own disconnected entry. A name the
          // registry doesn't know is kept as-is rather than dropped — same
          // "show it, don't discard it" rule inventory import follows.
          const match = this.registry.match(r.itemRaw, realm)[0];
          return {
            ts: Date.now(),
            source: label,
            realm,
            item: match?.name ?? r.itemRaw,
            category: match?.category ?? null,
            side: r.side,
            unitGold: r.unitGold,
            currency: 'gold',
            qty: r.qty,
            confidence: 1,
            seller: null,
            raw: null,
          };
        });
        const inserted = this.store.saveObservations(observations);
        totalNew += inserted;
        this.mark(label, true, `${total} rows, ${inserted} new${skipped ? `, ${skipped} skipped` : ''}`);
      } catch (error) {
        this.mark(label, false, error.message);
        this.log(`[poll] ${label} FAILED: ${error.message}`);
      }
    }
    return `${enabled.length} custom source${enabled.length === 1 ? '' : 's'}, ${totalNew} new quotes`;
  }

  /** One pass over everything, in dependency order. */
  async pollAll() {
    // The sheet sets the Black Dye rate and extends the item vocabulary, so it
    // runs before anything that parses Pre-Searing chat.
    await this.run('sheet', () => this.pollSheet());
    await this.run('trader', () => this.pollTrader());
    await this.run('kamadan', () => this.pollChat(REALMS.POST));
    await this.run('ascalon', () => this.pollChat(REALMS.PRE));
    // Needs chat data to exist first, and feeds the next parse round.
    await this.run('rates', () => this.refreshDerivedRates());
    await this.run('alerts', () => this.checkSellAlerts());
    await this.run('wiki', () => this.pollWiki());
    await this.run('forum', () => this.pollForum());
    await this.run('custom', () => this.pollCustomSources());
    this.store.checkpoint();
  }

  start() {
    const every = (ms, name, task) => {
      const timer = setInterval(() => { this.run(name, task); }, ms);
      timer.unref?.();
      this.timers.push(timer);
    };
    every(SCHEDULE.chat, 'kamadan', () => this.pollChat(REALMS.POST));
    every(SCHEDULE.chat, 'ascalon', () => this.pollChat(REALMS.PRE));
    every(SCHEDULE.trader, 'trader', () => this.pollTrader());
    every(SCHEDULE.trader, 'rates', () => this.refreshDerivedRates());
    // Alerts ride the chat cadence: prices move on chat, not on the wiki.
    every(SCHEDULE.chat, 'alerts', () => this.checkSellAlerts());
    every(SCHEDULE.wiki, 'wiki', () => this.pollWiki());
    every(SCHEDULE.sheet, 'sheet', () => this.pollSheet());
    every(SCHEDULE.forum, 'forum', () => this.pollForum());
    every(SCHEDULE.custom, 'custom', () => this.pollCustomSources());
    this.log('[poll] schedules started');
  }

  stop() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }
}

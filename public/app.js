/**
 * Dashboard front end. No framework and no build step — the whole app is this
 * file plus inline SVG charts, so it stays readable and starts instantly.
 */

const state = {
  realm: '',
  query: '',
  overview: [],
  context: null,
  selected: null,
  inventory: null,
  alerts: null,
  collapsed: {},
  startCollapsed: true,
  allCollapsed: true,
};

/** Opportunities are grouped by item type; sheet categories are "Sheet / Sub". */
const groupKey = (row) => {
  const category = row.category ?? 'Other';
  return category.includes('/') ? category.split('/')[0].trim() : category;
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child) node.append(child);
  }
  return node;
};

/**
 * `replaceChildren` coerces a nullish argument to the string "null", so
 * conditional children must be filtered rather than passed through.
 */
const mount = (node, ...children) => node.replaceChildren(...children.flat().filter(Boolean));

const svgEl = (tag, attrs = {}) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v);
  }
  return node;
};

/* ------------------------------------------------------------------ format */

function formatGold(gold) {
  if (gold === null || gold === undefined || !Number.isFinite(gold)) return '—';
  if (gold < 1000) return `${Math.round(gold)}g`;
  const k = gold / 1000;
  if (k < 1000) return `${k >= 100 ? Math.round(k) : k.toFixed(k < 10 ? 1 : 0)}k`;
  return `${Math.round(k).toLocaleString('en-US')}k`;
}

/** The same number in the economy's reserve currency, which is how players quote. */
function formatNative(gold, realm) {
  const rates = state.context?.rates;
  if (!rates || !Number.isFinite(gold)) return null;
  if (realm === 'pre') {
    if (!rates.blackDye || gold < rates.blackDye * 0.5) return null;
    const n = gold / rates.blackDye;
    return `${n < 10 ? n.toFixed(1) : Math.round(n)} bd`;
  }
  if (!rates.ecto || gold < rates.ecto * 0.5) return null;
  const n = gold / rates.ecto;
  return `${n < 10 ? n.toFixed(1) : Math.round(n)}e`;
}

function relativeTime(ts) {
  if (!ts) return 'never';
  const seconds = Math.round((Date.now() - ts) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

/** Accepts the same shorthand players type: "18k", "2e", "1.5bd", "250g". */
function parsePriceInput(text) {
  const rates = state.context?.rates ?? {};
  const m = /^\s*([\d.,]+)\s*(k|g|e|ecto|ectos|bd|bds|a|arm|arms|z|zkey|zkeys)?\s*$/i
    .exec(String(text));
  if (!m) return null;
  const value = Number.parseFloat(m[1].replace(/,(?=\d{3}\b)/g, '').replace(',', '.'));
  if (!Number.isFinite(value)) return null;
  switch ((m[2] ?? '').toLowerCase()) {
    case 'k': return value * 1000;
    case 'e': case 'ecto': case 'ectos': return value * (rates.ecto ?? 19000);
    case 'bd': case 'bds': return value * (rates.blackDye ?? 17500);
    case 'a': case 'arm': case 'arms': return value * (rates.arm ?? 110000);
    case 'z': case 'zkey': case 'zkeys': return value * (rates.zkey ?? 5000);
    default: return value;
  }
}

/* ----------------------------------------------------------------- tooltip */

const tooltip = $('#tooltip');

function showTooltip(event, title, rows) {
  tooltip.replaceChildren(
    el('div', { class: 'tt-title', text: title }),
    ...rows.map(([label, value]) => el('div', { class: 'tt-row' }, [
      el('span', { text: label }),
      el('span', { text: value }),
    ])),
  );
  tooltip.hidden = false;
  const pad = 14;
  const rect = tooltip.getBoundingClientRect();
  let x = event.clientX + pad;
  let y = event.clientY + pad;
  if (x + rect.width > window.innerWidth - 8) x = event.clientX - rect.width - pad;
  if (y + rect.height > window.innerHeight - 8) y = event.clientY - rect.height - pad;
  tooltip.style.left = `${Math.max(8, x)}px`;
  tooltip.style.top = `${Math.max(8, y)}px`;
}

function hideTooltip() { tooltip.hidden = true; }

/* --------------------------------------------------------- NPC rate cell */

/** Plain text, not a chart — this is the one number that never moves with
 *  sentiment: the trader will always transact at it. */
function npcRateCell(trader) {
  const bid = trader?.bid;
  const ask = trader?.ask;
  if (!Number.isFinite(bid) && !Number.isFinite(ask)) {
    return [el('span', { class: 'muted', text: '—' })];
  }
  return [
    el('div', { class: 'item-meta', text: `Buys ${formatGold(bid)}` }),
    el('div', { class: 'item-meta', text: `Sells ${formatGold(ask)}` }),
  ];
}

/* --------------------------------------------------------- history chart */

/**
 * Time series of NPC trader quotes with player quotes overlaid as dots.
 * One y-axis, always: both are prices in gold for the same item.
 */
/**
 * Collapse a dense series to one point per bucket, using the median so a spike
 * cannot drag the line. The NPC trader is sampled every few minutes, which is
 * thousands of points across 90 days — far more than a 600px axis can show
 * honestly, and the excess reads as noise rather than detail.
 */
function downsample(points, targetBuckets = 180) {
  if (points.length <= targetBuckets * 1.5) return points;
  const sorted = [...points].sort((a, b) => a.ts - b.ts);
  const from = sorted[0].ts;
  const span = sorted[sorted.length - 1].ts - from;
  if (span <= 0) return sorted;

  const width = span / targetBuckets;
  const buckets = new Map();
  for (const p of sorted) {
    const key = Math.floor((p.ts - from) / width);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(p.gold);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([key, values]) => {
      values.sort((a, b) => a - b);
      return { ts: from + (key + 0.5) * width, gold: values[values.length >> 1] };
    });
}

function historyChart(rawSeries, observations, { width = 640, height = 240 } = {}) {
  const series = rawSeries.map((s) => ({ ...s, points: downsample(s.points) }));
  const points = [
    ...series.flatMap((s) => s.points),
    ...observations.map((o) => ({ ts: o.ts, gold: o.unitGold })),
  ].filter((p) => Number.isFinite(p.gold) && Number.isFinite(p.ts));

  if (points.length < 2) {
    return el('div', { class: 'empty', text: 'Not enough history yet — the collector needs more time.' });
  }

  const pad = { left: 56, right: 16, top: 12, bottom: 26 };
  const t0 = Math.min(...points.map((p) => p.ts));
  const t1 = Math.max(...points.map((p) => p.ts));
  const v0 = Math.min(...points.map((p) => p.gold));
  const v1 = Math.max(...points.map((p) => p.gold));
  const vSpan = (v1 - v0) || Math.max(v1 * 0.1, 1);
  const yMin = Math.max(0, v0 - vSpan * 0.1);
  const yMax = v1 + vSpan * 0.1;

  const x = (ts) => pad.left + ((ts - t0) / ((t1 - t0) || 1)) * (width - pad.left - pad.right);
  const y = (v) => height - pad.bottom - ((v - yMin) / (yMax - yMin)) * (height - pad.top - pad.bottom);

  const svg = svgEl('svg', {
    width: '100%', height, viewBox: `0 0 ${width} ${height}`,
    role: 'img', 'aria-label': 'Price history',
  });

  // Recessive grid, four horizontal steps.
  for (let i = 0; i <= 4; i += 1) {
    const value = yMin + ((yMax - yMin) * i) / 4;
    svg.append(svgEl('line', {
      x1: pad.left, x2: width - pad.right, y1: y(value), y2: y(value), class: 'gridline',
    }));
    const label = svgEl('text', { x: pad.left - 8, y: y(value) + 4, class: 'tick', 'text-anchor': 'end' });
    label.textContent = formatGold(value);
    svg.append(label);
  }
  svg.append(svgEl('line', {
    x1: pad.left, x2: width - pad.right, y1: height - pad.bottom, y2: height - pad.bottom, class: 'axisline',
  }));

  for (const [i, tick] of [t0, (t0 + t1) / 2, t1].entries()) {
    const label = svgEl('text', {
      x: x(tick), y: height - 8, class: 'tick',
      'text-anchor': i === 0 ? 'start' : i === 2 ? 'end' : 'middle',
    });
    label.textContent = new Date(tick).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    svg.append(label);
  }

  // Player quotes underneath: they are the noisy sample, not the trend.
  for (const o of observations) {
    if (!Number.isFinite(o.unitGold)) continue;
    svg.append(svgEl('circle', {
      cx: x(o.ts), cy: y(o.unitGold), r: 4,
      fill: o.side === 'ask' ? 'var(--series-ask)' : 'var(--series-bid)',
      'fill-opacity': 0.55, stroke: 'var(--surface-1)', 'stroke-width': 1.5,
    }));
  }

  for (const s of series) {
    if (s.points.length < 2) continue;
    const d = s.points
      .map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(p.ts).toFixed(1)} ${y(p.gold).toFixed(1)}`)
      .join(' ');
    svg.append(svgEl('path', {
      d, fill: 'none', stroke: s.colour, 'stroke-width': 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round',
      'stroke-dasharray': s.dashed ? '5 4' : null,
    }));
    // Direct label at the series end, so identity never rests on colour alone.
    const last = s.points[s.points.length - 1];
    const label = svgEl('text', { x: x(last.ts) - 4, y: y(last.gold) - 7, class: 'tick', 'text-anchor': 'end' });
    label.textContent = s.label;
    label.setAttribute('fill', 'var(--text-secondary)');
    svg.append(label);
  }

  // Crosshair + tooltip.
  const crosshair = svgEl('line', {
    y1: pad.top, y2: height - pad.bottom, stroke: 'var(--axis)', 'stroke-width': 1, opacity: 0,
  });
  svg.append(crosshair);
  const capture = svgEl('rect', {
    x: pad.left, y: pad.top, width: width - pad.left - pad.right,
    height: height - pad.top - pad.bottom, fill: 'transparent',
  });
  svg.append(capture);

  capture.addEventListener('mousemove', (event) => {
    const box = svg.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * width;
    const ts = t0 + ((px - pad.left) / (width - pad.left - pad.right)) * (t1 - t0);
    crosshair.setAttribute('x1', px);
    crosshair.setAttribute('x2', px);
    crosshair.setAttribute('opacity', 1);

    const rows = [];
    for (const s of series) {
      const nearest = s.points.reduce(
        (best, p) => (Math.abs(p.ts - ts) < Math.abs(best.ts - ts) ? p : best), s.points[0],
      );
      if (nearest) rows.push([s.label, formatGold(nearest.gold)]);
    }
    const nearby = observations.filter((o) => Math.abs(o.ts - ts) < (t1 - t0) / 40);
    if (nearby.length) rows.push([`${nearby.length} player quote${nearby.length === 1 ? '' : 's'}`, formatGold(nearby[0].unitGold)]);
    showTooltip(event, new Date(ts).toLocaleString(), rows);
  });
  capture.addEventListener('mouseleave', () => {
    crosshair.setAttribute('opacity', 0);
    hideTooltip();
  });

  return svg;
}

/* ------------------------------------------------------------------ render */

function ratingBadge(rating, label) {
  return el('span', { class: 'badge', 'data-rating': rating }, [
    el('span', { class: 'dot' }),
    el('span', { text: label }),
  ]);
}

function signalFor(row) {
  const score = row.opportunity ?? 0;
  if (!row.sampleSize) return ratingBadge('unknown', 'No live quotes');
  if (score >= 1.5) return ratingBadge('strong-buy', 'Cheap vs history');
  if (score >= 0.5) return ratingBadge('good-buy', 'Below usual');
  if (score <= -1.5) return ratingBadge('overpriced', 'Expensive vs history');
  if (score <= -0.5) return ratingBadge('above-market', 'Above usual');
  return ratingBadge('fair', 'Normal');
}

function renderStrip() {
  const ctx = state.context;
  const box = $('#strip');
  if (!ctx) return;

  const inventory = state.inventory;
  const open = state.alerts?.open ?? [];
  const edge = open.reduce((total, a) => total + (a.peak_edge ?? 0), 0);

  const cells = [
    {
      label: 'Portfolio',
      value: inventory?.total ? formatGold(inventory.total) : '—',
      note: inventory?.total ? (formatNative(inventory.total, 'post') ?? '') : 'no inventory imported',
    },
    {
      label: 'Sell now',
      value: String(open.length),
      note: open.length ? `+${formatGold(edge)} above an average day` : 'nothing unusual right now',
      good: open.length > 0,
    },
    { label: 'Ecto', value: formatGold(ctx.rates?.ecto), note: 'NPC trader' },
    { label: 'Black Dye', value: formatGold(ctx.rates?.blackDye), note: 'price guide' },
    {
      label: 'Nicholas',
      value: ctx.sandford?.item ?? '—',
      note: ctx.traveler ? `traveler: ${ctx.traveler.item}` : 'rotates daily',
    },
  ];

  box.replaceChildren(...cells.map((c) => el('div', { class: 'strip-cell' }, [
    el('span', { class: 'label', text: c.label }),
    el('span', { class: c.good ? 'value good' : 'value', text: c.value }),
    el('span', { class: 'note', text: c.note }),
  ])));
}

function overviewRow(row) {
  const trendClass = row.trend?.direction === 'up' ? 'trend-up'
    : row.trend?.direction === 'down' ? 'trend-down' : 'trend-flat';
  const trendText = row.trend?.pct === null || row.trend?.pct === undefined
    ? '—'
    : `${row.trend.pct >= 0 ? '▲' : '▼'}${Math.abs(row.trend.pct).toFixed(0)}%`;

  const native = formatNative(row.reference?.value, row.realm);
  const score = row.opportunity ?? 0;

  const tr = el('tr', { class: 'row', tabindex: '0' }, [
    el('td', {}, [
      el('div', { class: 'item-name', text: row.item }),
      el('div', {
        class: 'item-meta',
        text: `${row.realm === 'pre' ? 'Pre' : 'Post'} · ${row.liquidity?.quotes ?? 0} quotes · ${row.liquidity?.level ?? 'none'}`,
      }),
    ]),
    el('td', { class: 'num' }, [
      el('div', { text: formatGold(row.reference?.value) }),
      native ? el('div', { class: 'item-meta', text: native }) : null,
    ]),
    el('td', { class: 'num spread' }, [
      el('span', { class: 'bid', text: formatGold(row.spotBid) }),
      el('span', { class: 'sep', text: ' / ' }),
      el('span', { class: 'ask', text: formatGold(row.spotAsk) }),
    ]),
    el('td', {}, npcRateCell(row.trader)),
    el('td', { class: `num ${trendClass}`, text: trendText }),
    el('td', {}, [
      el('span', { style: 'display:inline-flex;align-items:center;gap:6px' }, [
        signalFor(row),
        row.sampleSize ? el('span', { class: 'sigma', text: `${score >= 0 ? '+' : ''}${score.toFixed(1)}σ` }) : null,
      ]),
      row.demand?.active ? el('span', { class: 'chip', 'data-tone': 'demand', text: '★ in demand' }) : null,
      row.warnings?.length
        ? el('span', {
          class: 'chip', 'data-tone': 'warn', title: row.warnings.map((w) => w.message).join(' '),
          text: '⚠ unreliable',
        })
        : null,
    ]),
  ]);

  tr.addEventListener('click', () => openDetail(row));
  tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') openDetail(row); });
  return tr;
}

/**
 * One tbody per item type. The header row answers "is there anything in here?"
 * without expanding it: how many items are cheap, how many are expensive, and
 * which single item carries the strongest signal.
 */
function groupBody(name, items) {
  const collapsed = state.collapsed[name] ?? state.startCollapsed;
  const sorted = [...items].sort((a, b) => Math.abs(b.opportunity ?? 0) - Math.abs(a.opportunity ?? 0));
  const cheap = items.filter((r) => (r.opportunity ?? 0) >= 0.5).length;
  const rich = items.filter((r) => (r.opportunity ?? 0) <= -0.5).length;
  const top = sorted[0];

  const header = el('tr', { class: 'group' }, [
    el('td', { colspan: '3' }, [
      el('span', { class: 'group-name' }, [
        el('span', { class: 'caret', text: collapsed ? '▶' : '▼' }),
        el('span', { class: 'title', text: name }),
        el('span', { class: 'count', text: `${items.length} item${items.length === 1 ? '' : 's'}` }),
      ]),
    ]),
    el('td', { colspan: '3', class: 'num' }, [
      el('span', { class: 'group-summary' }, [
        cheap ? el('span', { class: 'pill' }, [el('span', { class: 'dot cheap' }), el('span', { text: `${cheap} cheap` })]) : null,
        rich ? el('span', { class: 'pill' }, [el('span', { class: 'dot rich' }), el('span', { text: `${rich} expensive` })]) : null,
        top ? el('span', {
          class: 'best',
          text: `strongest: ${top.item} ${(top.opportunity ?? 0) >= 0 ? '+' : ''}${(top.opportunity ?? 0).toFixed(1)}σ`,
        }) : null,
      ]),
    ]),
  ]);
  header.addEventListener('click', () => {
    state.collapsed[name] = !collapsed;
    renderOverview();
  });

  return el('tbody', {}, [header, ...(collapsed ? [] : sorted.slice(0, 200).map(overviewRow))]);
}

function renderOverview() {
  const table = $('#overview');
  const query = state.query.toLowerCase();
  const rows = state.overview.filter((r) => {
    if (state.realm && r.realm !== state.realm) return false;
    if (query && !r.item.toLowerCase().includes(query)) return false;
    return true;
  });

  $('#overview-empty').hidden = rows.length > 0;
  for (const body of [...table.tBodies]) body.remove();

  const groups = new Map();
  for (const row of rows) {
    const key = groupKey(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  // Loudest group first: the point of the page is what moved, not the alphabet.
  const ordered = [...groups.entries()].sort(
    (a, b) => Math.max(...b[1].map((r) => Math.abs(r.opportunity ?? 0)))
      - Math.max(...a[1].map((r) => Math.abs(r.opportunity ?? 0))),
  );
  for (const [name, items] of ordered) table.append(groupBody(name, items));
}

function renderCalendar() {
  const ctx = state.context;
  const box = $('#calendar');
  if (!ctx?.daily?.today) {
    box.replaceChildren(el('div', { class: 'muted', text: 'Waiting for the wiki…' }));
    return;
  }
  const today = ctx.daily.today;
  const entries = ctx.daily.header
    .filter((h) => h !== 'Date')
    .map((h) => [h, today[h]])
    .filter(([, v]) => v);

  mount(
    box,
    el('div', { class: 'muted', style: 'margin-bottom:8px', text: today.Date ?? '' }),
    ...entries.map(([key, value]) => el('div', { class: 'tt-row', style: 'padding:3px 0' }, [
      el('span', { class: 'muted', text: key }),
      el('span', { text: value }),
    ])),
    ctx.traveler ? el('div', { style: 'margin-top:10px;padding-top:10px;border-top:1px solid var(--grid)' }, [
      el('div', { class: 'muted', text: 'Nicholas the Traveler' }),
      el('div', { text: `${ctx.traveler.qtyPerGift}× ${ctx.traveler.item} per gift` }),
      el('div', { class: 'muted', text: ctx.traveler.location ?? '' }),
    ]) : null,
  );
}

function renderThreads(threads) {
  $('#threads').replaceChildren(...threads.slice(0, 12).map((t) => el('li', {}, [
    el('a', { href: t.url, target: '_blank', rel: 'noopener noreferrer', text: t.title }),
    el('time', { text: t.postedAt ? relativeTime(t.postedAt) : '' }),
  ])));
}

function renderSources() {
  const status = state.context?.sourceStatus ?? {};
  const stats = state.context?.stats ?? {};
  const entries = Object.entries(status);
  const stale = entries.filter(([, s]) => !s.ok).length;

  $('#sources').replaceChildren(...entries.map(([name, s]) => el('div', {
    class: 'source', 'data-ok': String(Boolean(s.ok)), title: s.detail ?? '',
  }, [
    el('span', { class: 'dot' }),
    el('span', { text: name }),
    el('span', { class: 'when', text: relativeTime(s.at) }),
  ])));

  const summary = $('#sources-summary');
  summary.textContent = stale ? `${stale} stale` : 'all live';
  summary.dataset.ok = String(stale === 0);

  $('#db-stats').textContent = `${(stats.observations ?? 0).toLocaleString('en-US')} player · `
    + `${(stats.traderQuotes ?? 0).toLocaleString('en-US')} trader · `
    + `${(stats.sheetPrices ?? 0).toLocaleString('en-US')} guide prices`;
}

/* ------------------------------------------------------------------ detail */

/**
 * Plain rows, nothing derived — the objective NPC rate first (it's the one
 * number that always transacts), then what the player market is actually
 * doing over three progressively longer windows.
 */
function goingRatesRows(data) {
  const row = (label, bid, ask) => {
    if (!Number.isFinite(bid) && !Number.isFinite(ask)) return null;
    return el('div', { class: 'tt-row', style: 'padding:3px 0' }, [
      el('span', { class: 'muted', text: label }),
      el('span', { text: `Buys ${formatGold(bid)} · Sells ${formatGold(ask)}` }),
    ]);
  };

  const rows = [
    row('NPC trader', data.trader?.bid, data.trader?.ask),
    row('Right now', data.spot?.bid?.median, data.spot?.ask?.median),
    row('Last 14 days', data.recent?.bid?.median, data.recent?.ask?.median),
    row('Last 60 days', data.baseline?.bid?.median, data.baseline?.ask?.median),
  ].filter(Boolean);

  return rows.length ? rows : [el('div', { class: 'hero-note', text: 'No rates recorded yet.' })];
}

async function openDetail(row) {
  const dialog = $('#detail');
  $('#detail-title').textContent = row.item;
  $('#detail-sub').textContent = `${row.realm === 'pre' ? 'Pre-Searing' : 'Post-Searing'} · ${row.category ?? ''}`;
  $('#detail-body').replaceChildren(el('div', { class: 'empty', text: 'Loading…' }));
  dialog.showModal();

  const data = await fetchJson(`/api/item?item=${encodeURIComponent(row.item)}&realm=${row.realm}`);
  if (data.error) {
    $('#detail-body').replaceChildren(el('div', { class: 'empty', text: data.error }));
    return;
  }

  const askLine = data.traderHistory.filter((h) => h.side === 'ask').map((h) => ({ ts: h.ts, gold: h.gold }));
  const bidLine = data.traderHistory.filter((h) => h.side === 'bid').map((h) => ({ ts: h.ts, gold: h.gold }));
  const sheetLine = (data.sheet?.history ?? [])
    .filter((s) => s.lowGold !== null || s.highGold !== null)
    .map((s) => ({ ts: s.asOf, gold: ((s.lowGold ?? s.highGold) + (s.highGold ?? s.lowGold)) / 2 }));

  const series = [
    askLine.length > 1 ? { label: 'NPC sells', colour: 'var(--series-npc)', points: askLine } : null,
    bidLine.length > 1 ? { label: 'NPC pays', colour: 'var(--series-npc)', points: bidLine, dashed: true } : null,
    sheetLine.length > 1 ? { label: 'Price guide', colour: 'var(--text-muted)', points: sheetLine, dashed: true } : null,
  ].filter(Boolean);

  const ref = data.reference;

  mount(
    $('#detail-body'),
    el('div', { class: 'two-col' }, [
      el('div', {}, [
        el('div', { class: 'hero', text: formatGold(ref.value) }),
        el('div', { class: 'hero-note', text: `${ref.source} · ${ref.confidence} confidence` }),
        el('div', { class: 'hero-note', text: ref.note }),
        el('div', { style: 'margin-top:16px' }, [
          el('div', { class: 'label muted', style: 'font-size:12px;text-transform:uppercase', text: 'Going rates' }),
          ...goingRatesRows(data),
        ]),
        data.warnings?.length ? el('div', { class: 'verdict', style: 'margin-top:14px' }, [
          el('h3', {}, [el('span', { text: '⚠' }), el('span', { text: 'Read with care' })]),
          el('ul', {}, data.warnings.map((w) => el('li', { text: w.message }))),
        ]) : null,
        data.demand?.active ? el('div', { class: 'verdict', style: 'margin-top:14px' }, [
          el('h3', {}, [el('span', { text: '★' }), el('span', { text: 'Demand event' })]),
          el('div', { class: 'muted', text: data.demand.reason }),
        ]) : null,
      ]),
      el('figure', {}, [
        historyChart(series, data.observations),
        el('figcaption', { text: series.length
          ? 'Lines are objective NPC trader quotes; dots are individual player quotes from trade chat.'
          : 'Dots are individual player quotes from trade chat.' }),
      ]),
    ]),

    el('h3', { style: 'margin:22px 0 8px;font-size:14px', text: 'Recent quotes' }),
    quotesTable(data.observations),

    data.threads?.length ? el('div', {}, [
      el('h3', { style: 'margin:22px 0 8px;font-size:14px', text: 'Related price checks' }),
      el('ul', { class: 'thread-list' }, data.threads.map((t) => el('li', {}, [
        el('a', { href: t.url, target: '_blank', rel: 'noopener noreferrer', text: t.title }),
      ]))),
    ]) : null,
  );
}

/** The table view. Required as the accessible alternative to every chart above. */
function quotesTable(observations) {
  if (!observations.length) {
    return el('div', { class: 'empty', text: 'No player quotes captured yet.' });
  }
  return el('table', {}, [
    el('thead', {}, [el('tr', {}, [
      el('th', { scope: 'col', text: 'When' }),
      el('th', { scope: 'col', text: 'Side' }),
      el('th', { scope: 'col', class: 'num', text: 'Unit price' }),
      el('th', { scope: 'col', text: 'Source' }),
      el('th', { scope: 'col', text: 'Message' }),
    ])]),
    el('tbody', {}, observations.slice(0, 60).map((o) => el('tr', {}, [
      el('td', { text: relativeTime(o.ts) }),
      el('td', {}, [el('span', {
        class: 'chip',
        style: `border-color:${o.side === 'ask' ? 'var(--series-ask)' : 'var(--series-bid)'}`,
        text: o.side === 'ask' ? 'selling' : 'buying',
      })]),
      el('td', { class: 'num', text: formatGold(o.unitGold) }),
      el('td', { class: 'muted', text: o.source }),
      el('td', { class: 'muted', text: (o.raw ?? '').slice(0, 90) }),
    ]))),
  ]);
}

/* ----------------------------------------------------------------- checker */

async function runCheck() {
  const item = $('#check-item').value.trim();
  const realm = $('#check-realm').value;
  const intent = $('#check-intent').value;
  const price = parsePriceInput($('#check-price').value);
  const box = $('#verdict');

  if (!item) {
    box.replaceChildren(el('div', { class: 'muted', text: 'Pick an item first.' }));
    return;
  }
  if (price === null) {
    box.replaceChildren(el('div', { class: 'muted', text: 'Enter a price — "18k", "2e", "250g" and "1.5bd" all work.' }));
    return;
  }

  const data = await fetchJson(
    `/api/evaluate?item=${encodeURIComponent(item)}&realm=${realm}&price=${price}&intent=${intent}`,
  );
  if (data.error) {
    box.replaceChildren(el('div', { class: 'muted', text: data.error }));
    return;
  }

  mount(box, el('div', { class: 'verdict' }, [
    el('h3', {}, [ratingBadge(data.rating, data.label)]),
    el('div', { class: 'muted', text: `${intent === 'buy' ? 'Paying' : 'Asking'} ${formatGold(price)} for ${item}` }),
    el('ul', {}, (data.reasons ?? []).map((r) => el('li', { text: r }))),
    (data.flags ?? []).includes('gouging') || (data.flags ?? []).includes('lowballing')
      ? el('div', { class: 'chip', 'data-tone': 'warn', text: '⚠ Unfair to the other side' })
      : null,
  ]));
}


/* --------------------------------------------------------------- inventory */

/**
 * Your holdings, priced against the same market data as everything else.
 * Unpriced rows are shown rather than dropped, so the total reads as an honest
 * floor and nothing you own quietly disappears from the picture.
 */
function renderInventory(data) {
  const summary = $('#inv-summary');
  const body = $('#inv-body');

  if (!data || data.error || !data.counts?.stacks) {
    mount(summary);
    mount(body, el('div', { class: 'empty', text: 'No inventory imported yet.' }));
    return;
  }

  const meta = data.meta ?? {};
  mount(
    summary,
    el('div', { class: 'inv-total' }, [
      el('span', { class: 'figure', text: formatGold(data.total) }),
      el('span', { class: 'sub-figure', text: formatNative(data.total, 'post') ?? '' }),
      el('span', { class: 'sub-figure', text:
        `${data.counts.priced} priced · ${data.counts.unpriced} unpriced · ${data.counts.stacks} item types` }),
    ]),
    el('div', { class: 'sub', text: meta.importedAt
      ? `From ${meta.source ?? 'import'}${meta.owners?.length ? ` · ${meta.owners.length} location${meta.owners.length === 1 ? '' : 's'}` : ''} · ${relativeTime(meta.importedAt)}`
      : '' }),
  );

  const rows = data.priced.map((r) => {
    const sell = r.sellSignal ?? 0;
    const verdict = sell >= 1.5 ? ['strong-buy', 'Good time to sell']
      : sell >= 0.5 ? ['good-buy', 'Above usual']
        : sell <= -1.5 ? ['overpriced', 'Poor time to sell']
          : sell <= -0.5 ? ['above-market', 'Below usual']
            : ['fair', 'Normal'];

    return el('tr', {}, [
      el('td', {}, [
        el('div', { class: 'item-name', text: r.name }),
        el('div', { class: 'item-meta', text: r.locations
          .map((l) => `${l.owner}${l.bag ? ` / ${l.bag}` : ''}`).join(' · ').slice(0, 90) }),
      ]),
      el('td', { class: 'num', text: r.quantity.toLocaleString('en-US') }),
      el('td', { class: 'num', text: formatGold(r.unit) }),
      el('td', { class: 'num' }, [
        el('div', { text: formatGold(r.value) }),
        el('div', { class: 'item-meta', text: formatNative(r.value, r.realm) ?? '' }),
      ]),
      el('td', { class: 'muted', text: r.reference?.source ?? '' }),
      el('td', {}, [
        ratingBadge(verdict[0], verdict[1]),
        r.demand?.active ? el('span', { class: 'chip', 'data-tone': 'demand', text: '★' }) : null,
        r.warnings?.length
          ? el('span', { class: 'chip', 'data-tone': 'warn', title: r.warnings.map((w) => w.message).join(' '), text: '⚠' })
          : null,
      ]),
    ]);
  });

  const table = el('table', {}, [
    el('thead', {}, [el('tr', {}, [
      el('th', { scope: 'col', text: 'Item' }),
      el('th', { scope: 'col', class: 'num', text: 'Qty' }),
      el('th', { scope: 'col', class: 'num', text: 'Unit' }),
      el('th', { scope: 'col', class: 'num', text: 'Value' }),
      el('th', { scope: 'col', text: 'Priced from' }),
      el('th', { scope: 'col', text: 'Sell now?' }),
    ])]),
    el('tbody', {}, rows),
  ]);

  const unpriced = data.unpriced.length
    ? el('details', { open: '' }, [
      el('summary', { class: 'muted', text: `${data.unpriced.length} item${data.unpriced.length === 1 ? '' : 's'} not included in the total` }),
      el('table', {}, [
        el('thead', {}, [el('tr', {}, [
          el('th', { scope: 'col', text: 'Item' }),
          el('th', { scope: 'col', class: 'num', text: 'Qty' }),
          el('th', { scope: 'col', text: 'Why' }),
          el('th', { scope: 'col', text: 'Name it' }),
        ])]),
        el('tbody', {}, data.unpriced.map((r) => el('tr', {}, [
          el('td', { text: r.name ?? r.hint ?? `unknown (${(r.fingerprint ?? '').slice(0, 12)}…)` }),
          el('td', { class: 'num', text: String(r.quantity) }),
          el('td', { class: 'muted', text: r.reason }),
          el('td', {}, [r.fingerprint && !r.name ? nameItControl(r.fingerprint) : el('span', { class: 'muted', text: '—' })]),
        ]))),
      ]),
    ])
    : null;

  mount(body, table, unpriced);
}

/**
 * Naming an unidentified item once teaches the importer permanently: the same
 * fingerprint resolves on every future import.
 */
function nameItControl(fingerprint) {
  const input = el('input', { type: 'text', list: 'item-options', placeholder: 'Item name' });
  const save = el('button', { class: 'icon-button', type: 'button', text: 'Save' });
  const wrap = el('div', { class: 'name-it' }, [input, save]);

  const submit = async () => {
    const item = input.value.trim();
    if (!item) return;
    save.disabled = true;
    await fetch('/api/inventory/name', {
      method: 'POST',
      body: JSON.stringify({ fingerprint, item }),
    });
    await refreshInventory();
  };
  save.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  return wrap;
}

async function refreshInventory() {
  await refreshAlerts();
  await refreshWatchStatus();
}

async function importInventory(body, mode) {
  const status = $('#inv-status');
  status.textContent = 'Importing…';
  const response = await fetch(`/api/inventory/import${mode ? `?mode=${mode}` : ''}`, {
    method: 'POST',
    body,
  });
  const result = await response.json();
  if (result.error) {
    status.textContent = `Could not import: ${result.error}`;
    return;
  }
  status.textContent = `Imported ${result.items} item types from ${result.source}`
    + ` — ${result.identified} identified.`;
  await refreshInventory();
}


/* ------------------------------------------------------------ sell alerts */

/** Fingerprints of alerts already announced, so a desktop notification fires once. */
const announced = new Set();

/**
 * The headline answer to "is there anything I should be selling right now?".
 *
 * Ranked by total gold captured versus an average day rather than by raw
 * unusualness, because a single cupcake three sigma above its baseline is not
 * worth interrupting anyone for.
 */
function renderAlerts(alerts, inventory) {
  const panel = $('#alerts-panel');
  const body = $('#alerts-body');
  const open = alerts?.open ?? [];

  if (!open.length) {
    panel.hidden = true;
    $('#alerts-headline').textContent = '';
    document.title = 'GW1 Live Trade Prices';
    return;
  }
  panel.hidden = false;

  const edge = open.reduce((total, a) => total + (a.peak_edge ?? 0), 0);
  $('#alerts-headline').textContent = `${open.length} item${open.length === 1 ? '' : 's'}`
    + ` · +${formatGold(edge)} above an average day`;

  // Pair each alert with the live opportunity row, which carries the richer
  // detail; the stored alert only holds the peak.
  const byName = new Map((inventory?.priced ?? []).map((r) => [`${r.realm}|${r.name}`, r]));

  mount(body, ...open.map((alert) => {
    const live = byName.get(`${alert.realm}|${alert.item}`);
    const opportunity = live?.opportunity;
    const suggested = opportunity?.suggested ?? alert.suggested;

    return el('div', { class: 'opp' }, [
      el('div', {}, [
        el('div', { class: 'who', text: alert.item }),
        el('div', { class: 'cap', text: `${alert.quantity.toLocaleString('en-US')} held · ${alert.basis ?? ''}` }),
      ]),
      el('div', {}, [
        el('div', { class: 'figure-sm', text: `+${formatGold(alert.peak_edge)}` }),
        el('div', { class: 'cap', text: 'vs an average day' }),
      ]),
      el('div', {}, [
        el('div', { class: 'figure-sm', text: formatGold(suggested) }),
        el('div', { class: 'cap', text: 'suggested, each' }),
      ]),
      el('div', {}, [
        el('div', { class: 'why', text: opportunity?.reason ?? alert.reason ?? '' }),
        alert.seen_at ? null : el('span', { class: 'chip', 'data-tone': 'demand', text: 'new' }),
      ]),
    ]);
  }));

  const unseen = alerts.unseen ?? 0;
  document.title = unseen ? `(${unseen}) GW1 Live Trade Prices` : 'GW1 Live Trade Prices';

  const button = $('#alerts-seen');
  mount(button, el('span', { text: 'Mark seen' }),
    unseen ? el('span', { class: 'badge-count', text: String(unseen) }) : null);

  notify(open);
}

/**
 * Desktop notifications, opt-in and strictly once per alert. The page only
 * asks for permission when the button is clicked — an unprompted permission
 * dialog on load is obnoxious and usually gets denied for good.
 */
function notify(open) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  for (const alert of open) {
    const key = `${alert.realm}|${alert.item}|${alert.fired_at}`;
    if (announced.has(key)) continue;
    announced.add(key);
    if (alert.seen_at) continue;
    new Notification(`Good time to sell ${alert.item}`, {
      body: `+${formatGold(alert.peak_edge)} versus an average day.`
        + (alert.suggested ? ` Suggested: ${formatGold(alert.suggested)} each.` : ''),
      tag: `${alert.realm}|${alert.item}`,
    });
  }
}

async function refreshAlerts() {
  const [alerts, inventory] = await Promise.all([
    fetchJson('/api/alerts'),
    fetchJson('/api/inventory'),
  ]);
  renderInventory(inventory);
  renderAlerts(alerts, inventory);
}


/* --------------------------------------------------------- watched folder */

/**
 * Report what the watcher is actually doing.
 *
 * The event/poll distinction matters: `fs.watch` silently does nothing on some
 * filesystems (notably network shares), so saying which mechanism is live turns
 * a mysteriously stale inventory into a diagnosable one.
 */
function renderWatchStatus(status) {
  const box = $('#inv-watch-status');
  if (!status || status.error) {
    mount(box);
    return;
  }

  const state = !status.enabled ? 'off' : status.lastError ? 'error' : 'watching';
  box.dataset.state = state;

  const lines = [];
  if (!status.enabled) {
    lines.push('Not watching any folder.');
  } else {
    lines.push(status.events
      ? `Watching for changes, and re-checking every ${status.pollSeconds}s.`
      : `Re-checking every ${status.pollSeconds}s (this filesystem sends no change events).`);
  }
  if (status.lastImport) {
    const i = status.lastImport;
    lines.push(`Last import ${relativeTime(i.at)}: ${i.items} item types`
      + ` (${i.identified} identified) from ${i.owners} location${i.owners === 1 ? '' : 's'}.`);
  }
  if (status.lastError) {
    lines.push(`Problem: ${status.lastError.message}`);
  } else if (status.enabled && status.lastChecked && !status.lastImport) {
    lines.push(`Checked ${relativeTime(status.lastChecked)}; nothing imported yet.`);
  }

  mount(box, ...lines.map((text, i) => el('div', { class: 'line' }, [
    i === 0 ? el('span', { class: 'dot' }) : el('span', { style: 'width:8px' }),
    el('span', { class: i === 0 ? '' : 'detail', text }),
  ])));

  if (status.path && !$('#inv-watch-path').value) $('#inv-watch-path').value = status.path;
}

async function refreshWatchStatus() {
  renderWatchStatus(await fetchJson('/api/inventory/watch'));
}

async function saveWatchFolder(enabled) {
  const path = $('#inv-watch-path').value.trim();
  const box = $('#inv-watch-status');
  mount(box, el('div', { class: 'line', text: enabled ? 'Starting…' : 'Stopping…' }));

  const response = await fetch('/api/inventory/watch', {
    method: 'POST',
    body: JSON.stringify({ path, enabled }),
  });
  renderWatchStatus(await response.json());
  await refreshInventory();
}

/* -------------------------------------------------------------------- boot */

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) return { error: `Request failed (${response.status})` };
  return response.json();
}

async function refresh() {
  const [context, overview, threads] = await Promise.all([
    fetchJson('/api/context'),
    fetchJson(`/api/overview${state.realm ? `?realm=${state.realm}` : ''}`),
    fetchJson('/api/threads'),
  ]);
  state.context = context;
  state.overview = Array.isArray(overview) ? overview : [];
  renderStrip();
  renderOverview();
  renderCalendar();
  renderSources();
  renderThreads(Array.isArray(threads) ? threads : []);
  $('#clock').textContent = `updated ${new Date().toLocaleTimeString()}`;

  const options = [...new Set(state.overview.map((r) => r.item))].slice(0, 400);
  $('#item-options').replaceChildren(...options.map((name) => el('option', { value: name })));

  await refreshInventory();
}

function wire() {
  for (const button of document.querySelectorAll('.segmented button')) {
    button.addEventListener('click', () => {
      state.realm = button.dataset.realm;
      for (const b of document.querySelectorAll('.segmented button')) {
        b.setAttribute('aria-pressed', String(b === button));
      }
      renderOverview();
    });
  }

  $('#search').addEventListener('input', (e) => {
    state.query = e.target.value;
    renderOverview();
  });

  $('#refresh').addEventListener('click', refresh);

  const collapseAll = $('#collapse-all');
  collapseAll.addEventListener('click', () => {
    state.allCollapsed = !state.allCollapsed;
    state.startCollapsed = state.allCollapsed;
    state.collapsed = {};
    collapseAll.textContent = state.allCollapsed ? 'Expand all' : 'Collapse all';
    renderOverview();
  });
  collapseAll.textContent = state.allCollapsed ? 'Expand all' : 'Collapse all';

  $('#inv-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (file) await importInventory(await file.text());
    e.target.value = '';
  });
  $('#inv-paste-go').addEventListener('click', () => {
    importInventory($('#inv-text').value, 'text');
  });
  $('#inv-watch-save').addEventListener('click', () => saveWatchFolder(true));
  $('#inv-watch-path').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveWatchFolder(true);
  });
  $('#inv-watch-stop').addEventListener('click', () => saveWatchFolder(false));

  $('#alerts-notify').addEventListener('click', async () => {
    if (typeof Notification === 'undefined') {
      $('#alerts-notify').textContent = 'Not supported here';
      return;
    }
    const permission = await Notification.requestPermission();
    $('#alerts-notify').textContent = permission === 'granted'
      ? 'Notifications on'
      : 'Notifications blocked';
  });
  $('#alerts-seen').addEventListener('click', async () => {
    await fetch('/api/alerts/seen', { method: 'POST' });
    await refreshAlerts();
  });

  $('#inv-clear').addEventListener('click', async () => {
    await fetch('/api/inventory/clear', { method: 'POST' });
    $('#inv-status').textContent = '';
    await refreshInventory();
  });
  $('#check-go').addEventListener('click', runCheck);
  $('#check-price').addEventListener('keydown', (e) => { if (e.key === 'Enter') runCheck(); });
  $('#detail-close').addEventListener('click', () => $('#detail').close());

  const themeButton = $('#theme-toggle');
  themeButton.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    themeButton.textContent = next === 'dark' ? 'Light' : 'Dark';
    localStorage.setItem('gw1-theme', next);
  });
  // Precedence: explicit ?theme= (handy for screenshots), then the stored
  // choice, then nothing at all — which lets the OS preference decide.
  const requested = new URLSearchParams(location.search).get('theme');
  // Dark is the default here, so the page opens in the theme it was designed in
  // rather than flashing light on a fresh browser.
  const theme = requested === 'light' || requested === 'dark'
    ? requested
    : localStorage.getItem('gw1-theme') ?? 'dark';
  document.documentElement.dataset.theme = theme;
  themeButton.textContent = theme === 'dark' ? 'Light' : 'Dark';
}

wire();
await refresh();

// Deep link: /?item=Glob%20of%20Ectoplasm&realm=post opens straight to detail.
const params = new URLSearchParams(location.search);
const deepItem = params.get('item');
if (deepItem) {
  const match = state.overview.find(
    (r) => r.item.toLowerCase() === deepItem.toLowerCase()
      && (!params.get('realm') || r.realm === params.get('realm')),
  );
  // The detail view only needs a name and a realm, so a link to an item that
  // is not on today's table still resolves rather than silently doing nothing.
  await openDetail(match ?? { item: deepItem, realm: params.get('realm') || 'post', category: null });
}

setInterval(refresh, 60_000);

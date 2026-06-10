const { kvGet, kvSet } = require('./kv');
const { fetchMovers, fetchTrades } = require('./activity');

const EVENT_HISTORY_KEY = 'vault:event_history';
const RECENT_FIRED_KEY = 'vault:recent_fired';
const PORTFOLIO_KEY = 'vault:portfolio';
const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const TTL_MS = 48 * HOUR_MS;
const MAX_ITEMS = 1000;

function parseJson(raw, fallback) {
  if (!raw) return fallback;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { return fallback; }
}

function cleanText(value) {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function oddsCents(price) {
  const cents = Number(price) * 100;
  if (!Number.isFinite(cents)) return '?';
  if (cents > 0 && cents < 0.1) return '<0.1c';
  return cents.toFixed(cents < 1 ? 2 : 1).replace(/\.0$/, '') + 'c';
}

const MONTH_INDEX = { jan:0,january:0,feb:1,february:1,mar:2,march:2,apr:3,april:3,may:4,jun:5,june:5,jul:6,july:6,aug:7,august:7,sep:8,sept:8,september:8,oct:9,october:9,nov:10,november:10,dec:11,december:11 };
const MONTH_RE = Object.keys(MONTH_INDEX).sort((a,b)=>b.length-a.length).join('|');

function inferPmEndDate(title, now=new Date()) {
  const s = cleanText(title).toLowerCase();
  const by = s.match(new RegExp('\\b(?:by|before|through|until)?\\s*(' + MONTH_RE + ')\\s+([1-3]?\\d)(?:st|nd|rd|th)?(?:,?\\s*(20\\d{2}))?'));
  if (by) {
    let y = Number(by[3]) || now.getUTCFullYear();
    let d = new Date(Date.UTC(y, MONTH_INDEX[by[1]], Number(by[2]), 23, 59, 59));
    if (!by[3] && d.getTime() < now.getTime() - DAY_MS) d = new Date(Date.UTC(y + 1, MONTH_INDEX[by[1]], Number(by[2]), 23, 59, 59));
    return d;
  }
  const endMonth = s.match(new RegExp('\\bend\\s+of\\s+(' + MONTH_RE + ')(?:,?\\s*(20\\d{2}))?'));
  if (endMonth) {
    let y = Number(endMonth[2]) || now.getUTCFullYear();
    let d = new Date(Date.UTC(y, MONTH_INDEX[endMonth[1]] + 1, 0, 23, 59, 59));
    if (!endMonth[2] && d.getTime() < now.getTime() - DAY_MS) d = new Date(Date.UTC(y + 1, MONTH_INDEX[endMonth[1]] + 1, 0, 23, 59, 59));
    return d;
  }
  const beforeYear = s.match(/\bbefore\s+(20\d{2})\b/);
  if (beforeYear) return new Date(Date.UTC(Number(beforeYear[1]) - 1, 11, 31, 23, 59, 59));
  const year = s.match(/\b(?:in|during|end of)?\s*(20\d{2})\b/);
  return year ? new Date(Date.UTC(Number(year[1]), 11, 31, 23, 59, 59)) : null;
}

function pmNoOddsFromMover(m) {
  const price = Number(m?.curPrice ?? m?.currentPrice ?? m?.price ?? 0);
  if (!Number.isFinite(price) || price <= 0 || price >= 1) return null;
  return /^no$/i.test(m?.outcome || '') ? price : 1 - price;
}

function pmPriceMoveText(m, maxTitle=70) {
  const up = Number(m?.pctChange || 0) >= 0;
  const current = Number(m?.curPrice ?? m?.currentPrice ?? m?.price ?? 0);
  let extra = Number.isFinite(current) && current > 0 ? ` to ${oddsCents(current)}` : '';
  const no = pmNoOddsFromMover(m);
  if (no && no > 0.80) {
    const end = inferPmEndDate(m?.title || '');
    if (end && end.getTime() > Date.now()) {
      const days = Math.max(1, Math.ceil((end.getTime() - Date.now()) / DAY_MS));
      const apy = Math.pow(1 / no, 365 / days) - 1;
      if (Number.isFinite(apy)) extra += ` (${(apy * 100).toFixed(1)}% APY if NO wins)`;
    }
  }
  return `${(m.title || '').slice(0, maxTitle)} (${m.outcome || ''}): ${up ? '+' : ''}${Number(m.pctChange || 0).toFixed(1)}% in 24h${extra}`;
}

function parseTelegramTime(block) {
  const dtMatch = String(block || '').match(/<time[^>]*datetime="([^"]+)"/i);
  if (!dtMatch) return null;
  const ts = new Date(dtMatch[1]).getTime();
  return Number.isFinite(ts) ? ts : null;
}

function pmMarketUrlFromFields(obj) {
  const direct = String(obj?.marketUrl || obj?.url || '').trim();
  if (/^https?:\/\//i.test(direct)) return direct;
  const child = String(obj?.marketSlug || obj?.market_slug || obj?.slug || '').trim();
  const eventSlug = String(obj?.eventSlug || obj?.event_slug || '').trim();
  if (eventSlug && child && eventSlug !== child) {
    return `https://polymarket.com/event/${encodeURIComponent(eventSlug)}/${encodeURIComponent(child)}`;
  }
  if (child) return `https://polymarket.com/event/${encodeURIComponent(child)}`;
  return '';
}

function event(kind, text, ts, opts = {}) {
  const defaults = {
    'Alert Triggered': ['bell', 'var(--red)', 'rgba(244,63,94,0.13)'],
    'Order Filled': ['fill', 'var(--green)', 'rgba(34,197,94,0.12)'],
    'PM Price Move': ['up', 'var(--green)', 'rgba(34,197,94,0.12)'],
    'DeFi Health Warning': ['shield', 'var(--red)', 'rgba(244,63,94,0.13)'],
    'Position Expiring': ['hourglass', 'var(--amber)', 'rgba(245,158,11,0.13)'],
    'Position Expired': ['hourglass', 'var(--amber)', 'rgba(245,158,11,0.13)'],
    'Unlock Scheduled': ['hourglass', 'var(--amber)', 'rgba(245,158,11,0.13)'],
    'Kobeissi BREAKING': ['lightning', 'var(--amber)', 'rgba(245,158,11,0.14)'],
    'PM Resolved':       ['flag',      'var(--green)', 'rgba(34,197,94,0.12)'],
  }[kind] || ['bell', 'var(--t3)', 'rgba(148,163,184,0.12)'];
  return {
    kind,
    icon: opts.icon || defaults[0],
    color: opts.color || defaults[1],
    alpha: opts.alpha || defaults[2],
    text: String(text || '').trim(),
    ts: Number(ts || Date.now()),
    key: opts.key || null,
    windowMs: opts.windowMs || null,
    sourceTs: opts.sourceTs || false,
    hover: opts.hover || '',
    marketUrl: opts.marketUrl || '',
    marketTitle: opts.marketTitle || '',
  };
}

function defaultWindowMs(kind) {
  if (kind === 'Order Filled') return 2 * HOUR_MS;
  if (kind === 'PM Price Move') return DAY_MS;
  if (kind === 'DeFi Health Warning') return 2 * DAY_MS;
  if (kind === 'Position Expiring' || kind === 'Position Expired' || kind === 'Unlock Scheduled') return DAY_MS;
  return 0;
}

function tradeRemainingShares(t) {
  const fields = [
    t?.remainingSize, t?.remaining, t?.openSize, t?.unfilledSize, t?.sizeRemaining,
    t?.makerAmountRemaining, t?.remainingAmount, t?.orderRemaining, t?.unfilledAmount,
  ];
  for (const value of fields) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function orderFillHoverText(g) {
  const fills = g.orders || 0;
  const line = `${fills} fill${fills === 1 ? '' : 's'} in this 2h group.`;
  if (Number.isFinite(Number(g.remainingShares)) && Number(g.remainingShares) > 0) {
    return `${line} Still open: ${Number(g.remainingShares).toLocaleString('en-US', { maximumFractionDigits: 2 })} shares.`;
  }
  return `${line} Active-order remainder was not reported by the Polymarket activity feed.`;
}

function groupTradesByFillWindow(trades, groupMs = 2 * HOUR_MS) {
  const byKey = new Map();
  for (const t of trades || []) {
    const title = t.title || 'Unknown market';
    const outcome = t.outcome || '';
    const side = String(t.side || '').toUpperCase() || 'TRADE';
    const key = `${title}||${outcome}||${side}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push({ ...t, title, outcome, side });
  }
  const groups = [];
  for (const list of byKey.values()) {
    list.sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
    let g = null;
    let prevTs = 0;
    for (const t of list) {
      const ts = Number(t.timestamp || 0) * 1000;
      if (!g || Math.abs(prevTs - ts) > groupMs) {
        g = {
          title: t.title,
          outcome: t.outcome,
          side: t.side,
          slug: t.slug || t.marketSlug || t.market_slug || '',
          eventSlug: t.eventSlug || t.event_slug || '',
          marketUrl: pmMarketUrlFromFields(t),
          latestTs: ts || 0,
          earliestTs: ts || 0,
          totalShares: 0,
          totalCost: 0,
          orders: 0,
          remainingShares: 0,
        };
        groups.push(g);
      }
      const size = Number(t.size || 0);
      const price = Number(t.price || 0);
      g.totalShares += Number.isFinite(size) ? size : 0;
      g.totalCost += Number.isFinite(size * price) ? size * price : 0;
      g.orders += 1;
      g.latestTs = Math.max(g.latestTs, ts || 0);
      g.earliestTs = Math.min(g.earliestTs || ts || 0, ts || 0);
      const remaining = tradeRemainingShares(t);
      if (remaining !== null) g.remainingShares += remaining;
      prevTs = ts;
    }
  }
  return groups.sort((a, b) => Number(b.latestTs || 0) - Number(a.latestTs || 0));
}

function eventKey(e) {
  if (e?.key) return e.key;
  const kind = e?.kind || 'Event';
  const text = cleanText(e?.text).toLowerCase();
  if (kind === 'PM Price Move') {
    const market = text.split(/\s+\([^)]*\):/)[0] || text;
    const outcome = (text.match(/\(([^)]*)\):/) || [])[1] || '';
    return `pm-move:${market}:${outcome}`;
  }
  if (kind === 'Order Filled') {
    const market = text.split(/\s+(?:-|—)\s+/)[0] || text;
    const side = (text.match(/\b(BUY|SELL|TRADE)\b/i) || [])[1] || '';
    const outcome = (text.match(/\b(YES|NO)\b/i) || [])[1] || '';
    return `order:${market}:${outcome}:${side}`.toLowerCase();
  }
  if (kind === 'DeFi Health Warning') {
    const subject = text.split(/\s+(?:-|—)\s+/)[0].replace(/\s+health\s+[\d.]+.*$/, '');
    return `health:${subject}`;
  }
  if (kind === 'Alert Triggered' || kind === 'Position Expired') {
    return `${kind}:${text}`;
  }
  return `${kind}:${text}`;
}

function shouldReplaceEvent(prev, next) {
  if (!prev) return true;
  if (next.kind === 'Order Filled' || next.kind === 'PM Price Move') {
    return Number(next.ts || 0) >= Number(prev.ts || 0);
  }
  if (next.kind === 'Kobeissi BREAKING') {
    if (prev.sourceTs && !next.sourceTs) return false;
    return Number.isFinite(Number(next.ts || 0)) && (next.sourceTs || !prev.sourceTs);
  }
  if (next.kind === 'DeFi Health Warning') return false;
  if (next.kind === 'Position Expiring' || next.kind === 'Position Expired' || next.kind === 'Unlock Scheduled') return false;
  return Number(next.ts || 0) >= Number(prev.ts || 0);
}

function dedupeAndTrim(items) {
  const cutoff = Date.now() - TTL_MS;
  const out = [];
  const open = new Map();
  const sorted = (items || [])
    .filter(e => e && e.text && Number(e.ts || 0) > cutoff)
    .sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));

  for (const raw of sorted) {
    const e = { ...raw, key: eventKey(raw), windowMs: Number(raw.windowMs || defaultWindowMs(raw.kind) || 0) };
    const k = e.key || `${e.kind}:${cleanText(e.text).toLowerCase()}`;
    const prevIdx = open.get(k);
    if (prevIdx !== undefined) {
      const prev = out[prevIdx];
      const win = Number(e.windowMs || prev.windowMs || 0);
      if (!win || Math.abs(Number(e.ts || 0) - Number(prev.ts || 0)) <= win) {
        if (shouldReplaceEvent(prev, e)) out[prevIdx] = e;
        continue;
      }
    }
    open.set(k, out.length);
    out.push(e);
  }

  return out
    .sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0))
    .slice(-MAX_ITEMS);
}

function dateFromText(value) {
  const s = String(value || '');
  let m = s.match(/\b(20\d{2})[\/-](\d{1,2})[\/-](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?\b/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
  m = s.match(/\b(\d{1,2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|SEPT|OCT|NOV|DEC)(20\d{2})\b/i);
  if (m) {
    const months = { JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,SEPT:8,OCT:9,NOV:10,DEC:11 };
    return new Date(+m[3], months[m[2].toUpperCase()], +m[1]);
  }
  m = s.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})(?:,\s*(20\d{2}))?\b/i);
  if (m) {
    const months = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,sept:8,oct:9,nov:10,dec:11 };
    return new Date(+(m[3] || new Date().getFullYear()), months[m[1].toLowerCase()], +m[2]);
  }
  return null;
}

function scanPortfolioEvents(portfolio, now) {
  const items = [];
  for (const proto of (Array.isArray(portfolio?.protocols) ? portfolio.protocols : [])) {
    let minHealth = Infinity;
    const chainHealth = String(proto.chain || '').match(/Health:\s*([\d.]+)/i);
    if (chainHealth) minHealth = Math.min(minHealth, Number(chainHealth[1]));

    const sections = Array.isArray(proto.sections) ? proto.sections : [];
    const positions = sections.length
      ? sections.flatMap(sec => (sec.positions || []).map(pos => ({ sec, pos })))
      : [{ sec: {}, pos: proto }];

    for (const { sec, pos } of positions) {
      if (sec.health) minHealth = Math.min(minHealth, Number(sec.health));
      if (pos.health) minHealth = Math.min(minHealth, Number(pos.health));
      const label = [proto.name, pos.pool || pos.name || sec.type].filter(Boolean).join(' ');
      const raw = [
        proto.name, proto.chain, proto.notes, proto.type,
        sec.type, sec.label, sec.notes,
        pos.pool, pos.name, pos.sub, pos.notes, pos.unlockDate, pos.unlockTime,
        pos.unlock, pos.unlockAt, pos.unlocksAt, pos.unlockTimestamp,
        ...(Array.isArray(pos.tokens) ? pos.tokens : []),
      ].filter(Boolean).join(' ');
      const hasLock = /\b(lock|locked|unlock|unlocking|vest|vesting|cliff|expire|expires|expiry)\b/i.test(raw);
      const dt = dateFromText(raw);
      if (hasLock && dt && Number.isFinite(dt.getTime()) && dt.getTime() <= now + DAY_MS) {
        const date = dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        const expired = dt.getTime() <= now;
        items.push(event(expired ? 'Position Expired' : 'Position Expiring', `${label} ${expired ? 'expired/unlocked on' : 'expires/unlocks on'} ${date}`, now, {
          key: `position-expiry:${proto.name}:${label}:${dt.toISOString().slice(0, 10)}`,
          windowMs: DAY_MS,
        }));
      }
    }

    if (minHealth <= 1.01 && Number.isFinite(minHealth)) {
      items.push(event('DeFi Health Warning', `${proto.name} health ${minHealth.toFixed(2)} - liquidation risk`, now, {
        key: `health:${proto.name}`,
        windowMs: 2 * DAY_MS,
      }));
    }
  }
  return items;
}

async function fetchKobeissiPosts(sinceMs = 0) {
  const byKey = new Map();
  const since = Number(sinceMs || 0);
  for (const handle of ['kobeissiletters', 'KobeissiLetters']) {
    try {
      const r = await fetch(`https://t.me/s/${handle}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VaultBot/1.0)', Accept: 'text/html' },
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) continue;
      const html = await r.text();
      const blocks = [...html.matchAll(/<div class="tgme_widget_message_wrap[^"]*">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/g)].map(m => m[0]);
      for (const block of blocks.slice(-25)) {
        const textMatch = block.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
        if (!textMatch) continue;
        const text = cleanText(textMatch[1]);
        if (!text || text.length < 12) continue;
        const ts = parseTelegramTime(block);
        if (!ts || (since > 0 && ts < since)) continue;
        const headline = text.split(/(?<=[.!?])\s+/)[0].slice(0, 180);
        if (!headline || headline.length < 12) continue;
        if (!/\bBREAKING\b/i.test(text)) continue;
        const key = `Kobeissi BREAKING:${headline.toLowerCase()}`;
        if (!byKey.has(key)) {
          byKey.set(key, event('Kobeissi BREAKING', headline, ts, {
            key: `kobeissi:${headline.toLowerCase()}`,
            sourceTs: true,
          }));
        }
      }
    } catch {}
  }
  return [...byKey.values()].sort((a, b) => b.ts - a.ts).slice(0, 15);
}

async function buildPolymarketActivity(now) {
  const items = [];
  try {
    const [movers, trades] = await Promise.all([fetchMovers(), fetchTrades()]);
    groupTradesByFillWindow(trades || []).slice(0, 8).forEach(g => {
      const avg = g.totalShares > 0 ? g.totalCost / g.totalShares : 0;
      const isBuy = g.side === 'BUY';
      const keyTitle = cleanText(g.title).toLowerCase();
      const keyOutcome = cleanText(g.outcome).toLowerCase();
      const marketTitle = g.title.slice(0, 70);
      items.push(event('Order Filled', `${marketTitle} - ${g.outcome ? `${g.outcome} ` : ''}${g.side} ${g.totalShares.toFixed(0)} shares @ ${(avg * 100).toFixed(1)}c`, g.latestTs || now, {
        color: isBuy ? 'var(--green)' : 'var(--red)',
        alpha: isBuy ? 'rgba(34,197,94,0.12)' : 'rgba(244,63,94,0.12)',
        key: `order:${keyTitle}:${keyOutcome}:${g.side}:${Math.floor((g.latestTs || now) / (2 * HOUR_MS))}`,
        windowMs: 2 * HOUR_MS,
        hover: orderFillHoverText(g),
        marketTitle,
        marketUrl: g.marketUrl || pmMarketUrlFromFields(g),
      }));
    });
    (movers || []).slice(0, 8).forEach(m => {
      const up = Number(m.pctChange || 0) >= 0;
      const keyTitle = cleanText(m.title).toLowerCase();
      const keyOutcome = cleanText(m.outcome).toLowerCase();
      const marketTitle = (m.title || '').slice(0, 70);
      items.push(event('PM Price Move', pmPriceMoveText(m, 70), now - 15 * 60000, {
        icon: up ? 'up' : 'down',
        color: up ? 'var(--green)' : 'var(--red)',
        alpha: up ? 'rgba(34,197,94,0.12)' : 'rgba(244,63,94,0.12)',
        key: `pm-move:${keyTitle}:${keyOutcome}`,
        windowMs: DAY_MS,
        marketTitle,
        marketUrl: pmMarketUrlFromFields(m),
      }));
    });
  } catch (e) {
    console.error('[event-log] Polymarket activity error:', e.message);
  }
  return items;
}


async function checkPmResolved(portfolio, now) {
  const items = [];
  const predMarkets = Array.isArray(portfolio?.predictionMarkets) ? portfolio.predictionMarkets : [];
  const candidates = predMarkets.filter(pm => Number(pm.size || 0) > 500);
  await Promise.all(candidates.map(async pm => {
    const mid = pm.marketId || pm.market_id || pm.conditionId || null;
    if (!mid) return;
    try {
      const r = await fetch(`https://gamma-api.polymarket.com/markets?id=${encodeURIComponent(mid)}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VaultBot/1.0)', Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) return;
      const arr = await r.json();
      const mkt = Array.isArray(arr) ? arr[0] : arr;
      if (!mkt) return;
      if (mkt.closed !== true && mkt.resolved !== true) return;
      const winPct = Number(pm.currentPrice || 0);
      const result = winPct >= 0.5 ? 'settled ✓' : 'expired worthless';
      const col = winPct >= 0.5 ? 'var(--green)' : 'var(--t3)';
      const alp = winPct >= 0.5 ? 'rgba(34,197,94,0.12)' : 'rgba(100,116,139,0.15)';
      items.push(event('PM Resolved', `${(pm.title || '').slice(0, 55)} — ${pm.outcome || ''} ${result} (${Number(pm.size).toFixed(0)} shares)`, now, {
        icon: 'flag',
        color: col,
        alpha: alp,
        key: `pm-resolved:${cleanText(pm.title || '').toLowerCase()}:${cleanText(pm.outcome || '').toLowerCase()}`,
        windowMs: 2 * DAY_MS,
      }));
    } catch {}
  }));
  return items;
}

const COLLECT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

async function collectEvents({ force = false } = {}) {
  const now = Date.now();
  const [historyRaw, firedRaw, portfolioRaw, lastCheckRaw] = await Promise.all([
    kvGet(EVENT_HISTORY_KEY),
    kvGet(RECENT_FIRED_KEY),
    kvGet(PORTFOLIO_KEY),
    kvGet('vault:last_event_log_check'),
  ]);

  // Skip expensive fetches (PM + Telegram) if called too recently, unless forced
  const lastCheck = Number(lastCheckRaw || 0);
  const tooSoon = !force && (now - lastCheck) < COLLECT_COOLDOWN_MS;
  if (tooSoon) {
    const history = parseJson(historyRaw, []);
    return { items: history, added: 0, cached: true };
  }
  const fresh = [];
  for (const r of parseJson(firedRaw, [])) {
    if (!r || typeof r !== 'object') continue;
    const kind = r.reason === 'ended' ? 'Position Expired' : 'Alert Triggered';
    const label = r.label || r.symbol || 'Alert triggered';
    fresh.push(event(kind, label, Number(r.at || now), {
      key: `${kind}:${cleanText(label).toLowerCase()}`,
    }));
  }
  fresh.push(...scanPortfolioEvents(parseJson(portfolioRaw, {}), now));
  fresh.push(...await buildPolymarketActivity(now));
  const kobeissiSince = lastCheck > 0 ? Math.max(0, lastCheck - 60000) : now - DAY_MS;
  fresh.push(...await fetchKobeissiPosts(kobeissiSince));
  fresh.push(...await checkPmResolved(parseJson(portfolioRaw, {}), now));
  const merged = dedupeAndTrim([...parseJson(historyRaw, []), ...fresh]);
  await kvSet(EVENT_HISTORY_KEY, JSON.stringify(merged));
  await kvSet('vault:last_event_log_check', String(now));
  return { items: merged, added: fresh.length };
}

module.exports = { collectEvents, dateFromText, scanPortfolioEvents, dedupeAndTrim };

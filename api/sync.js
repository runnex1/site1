/**
 * POST /api/sync-portfolio
 *
 * Receives full portfolio snapshot from browser and stores in KV.
 * Called by the browser every time saveData() runs.
 *
 * Stores:
 *   vault:portfolio   — tokens, protocols, ETFs, prediction markets, watchlist
 *   vault:watchlist   — watchlist entries with prices
 *   vault:snapshots   — weekly portfolio snapshots
 *   vault:aavemarkets — Aave cap markets being monitored
 *   vault:customtokens— custom token definitions
 */

const { kvGet, kvSet } = require('../lib/kv');
const { mergeLoopSnapshotStores, ensureUsdeUsdmSnapshotsPurged } = require('../lib/loop-snapshots');
const { collectEvents } = require('../lib/event-log');
const { fetchPolymarketWalletBalances } = require('../lib/polymarket-balance');
const https = require('https');

const SYNC_SECRET = process.env.SYNC_SECRET || '';
const ALERTS_KEY = 'vault:alerts';
const ALERT_HARD_LIMIT = 200;
const POLYMARKET_PNL_BASE = 'https://user-pnl-api.polymarket.com/user-pnl';
const MARKET_MOVES_CACHE_MS = 5 * 60 * 1000;
const MARKET_MOVES_ASSET_LIMIT = 40;
const MARKET_MOVES_CONCURRENCY = 8;
const PM_POSITIONS_CACHE_MS = 5 * 60 * 1000;
const PM_BALANCES_CACHE_MS = 2 * 60 * 1000;
const PM_METADATA_CONCURRENCY = 4;
const marketMovesCache = new Map();
const polymarketPositionsCache = new Map();
const polymarketBalancesCache = new Map();

async function statusFetch(url, timeout=6000) {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const r = await fetch(url, { headers:{ Accept:'application/json' }, signal:controller.signal });
    return { ok:r.ok, status:r.status, ms:Date.now() - start };
  } catch(e) {
    return { ok:false, ms:Date.now() - start, error:e.message };
  } finally {
    clearTimeout(timer);
  }
}

async function statusFetchCoinGecko(timeout = 6000) {
  const start = Date.now();
  try {
    const result = await fetchCoinGeckoWithFailover(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
      { timeout },
    );
    return {
      ok: result.ok,
      status: result.status || (result.ok ? 200 : 0),
      ms: Date.now() - start,
      error: result.error,
    };
  } catch (e) {
    return { ok: false, ms: Date.now() - start, error: e.message };
  }
}

function parseJson(raw, fallback) {
  if (!raw) return fallback;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch(e) { return fallback; }
}

function mergeVariationalHedgeRows(existing, incoming) {
  const byKey = new Map((existing || []).map((h) => {
    const key = String(h?.id || `${h?.symbol}|${h?.trackedVenue}`);
    return [key, h];
  }));
  for (const hedge of incoming || []) {
    const key = String(hedge?.id || `${hedge?.symbol}|${hedge?.trackedVenue}`);
    if (!key) continue;
    const prev = byKey.get(key);
    byKey.set(key, prev ? {
      ...prev,
      ...hedge,
      openedAt: Number(hedge?.openedAt) || Number(prev?.openedAt) || null,
      variationalEntryPx: Number(hedge?.variationalEntryPx) || Number(prev?.variationalEntryPx) || null,
      variationalSize: hedge?.variationalSize ?? prev?.variationalSize,
      trackedSize: hedge?.trackedSize ?? prev?.trackedSize,
    } : hedge);
  }
  return [...byKey.values()].sort((a, b) => (Number(b?.openedAt) || 0) - (Number(a?.openedAt) || 0));
}

const GECKO_SERVER_SAVE_MIN_USD = 10000;

async function mergeGeckoSymbolIds(incoming) {
  const existing = parseJson(await kvGet('vault:gecko_symbol_ids'), {});
  const next = { ...existing };
  let changed = false;
  for (const [sym, entry] of Object.entries(incoming || {})) {
    const upper = String(sym || '').trim().toUpperCase();
    const id = String(entry?.id || '').trim().toLowerCase();
    const valueUsd = Number(entry?.valueUsd);
    if (!upper || !id || !Number.isFinite(valueUsd) || valueUsd < GECKO_SERVER_SAVE_MIN_USD) continue;
    const prev = next[upper];
    if (!prev || prev.id !== id || valueUsd >= Number(prev.valueUsd || 0)) {
      next[upper] = { id, ts: Date.now(), valueUsd };
      changed = true;
    }
  }
  if (changed) await kvSet('vault:gecko_symbol_ids', JSON.stringify(next));
  return next;
}

function ageLabel(ts) {
  const n = Number(ts);
  if (!n) return 'never';
  const sec = Math.max(0, Math.round((Date.now() - n) / 1000));
  if (sec < 90) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 120) return `${min}m ago`;
  const hr = Math.round(min / 60);
  return `${hr}h ago`;
}

function activeAlertCount(alerts) {
  return (Array.isArray(alerts) ? alerts : []).filter(a => !a.triggered && a.type !== 'event' && !a.condition).length;
}

function statusLine(name, r) {
  return `${r?.ok ? 'OK' : 'failed'}${r?.status ? ` (${r.status})` : ''}${r?.ms != null ? ` · ${r.ms}ms` : ''}${r?.error ? ` · ${r.error}` : ''}`;
}

async function getSystemStatusText() {
  const now = Date.now();
  await kvSet('vault:last_status_check', String(now));
  const [roundtrip, lastCronRaw, lastSummaryRaw, alertsRaw, gamma, clob, coingecko, yahoo] = await Promise.all([
    kvGet('vault:last_status_check'),
    kvGet('vault:last_cron_ok'),
    kvGet('vault:last_alert_check_summary'),
    kvGet(ALERTS_KEY),
    statusFetch('https://gamma-api.polymarket.com/markets?limit=1'),
    statusFetch('https://clob.polymarket.com/markets?limit=1'),
    statusFetchCoinGecko(),
    statusFetch('https://query1.finance.yahoo.com/v8/finance/chart/SPY?range=1d&interval=1d'),
  ]);
  const alerts = parseJson(alertsRaw, []);
  const summary = parseJson(lastSummaryRaw, null);
  const kvOk = String(roundtrip) === String(now);
  const cronOk = Number(lastCronRaw) && now - Number(lastCronRaw) < 5 * 60 * 1000;
  const vercelUrl = process.env.VERCEL_URL || process.env.URL || '';
  const lines = [
    '🩺 System status',
    `Status checked: ${new Date(now).toUTCString()}`,
    '',
    `${kvOk ? '✅' : '❌'} KV / alerts storage: ${kvOk ? 'OK' : 'failed'}`,
    `${cronOk ? '✅' : '⚠️'} Cron: last alert check ${ageLabel(lastCronRaw)}`,
    summary ? `Last check: ${Number(summary.checked || 0)} checked · ${Number(summary.fired || 0)} fired · ${new Date(Number(summary.timestamp || lastCronRaw || now)).toUTCString()}` : 'Last check: no summary saved yet',
    `Active alerts: ${activeAlertCount(alerts)}/${ALERT_HARD_LIMIT}`,
    `✅ Vercel / webhook: this function is responding${vercelUrl ? ' · ' + vercelUrl : ''}`,
    '',
    `${gamma.ok ? '✅' : '❌'} Polymarket Gamma: ${statusLine('Polymarket Gamma', gamma)}`,
    `${clob.ok ? '✅' : '❌'} Polymarket CLOB: ${statusLine('Polymarket CLOB', clob)}`,
    `${coingecko.ok ? '✅' : '❌'} CoinGecko: ${statusLine('CoinGecko', coingecko)}`,
    `${yahoo.ok ? '✅' : '❌'} Yahoo Finance: ${statusLine('Yahoo Finance', yahoo)}`,
    `${process.env.GROQ_API_KEY ? '✅' : '⚠️'} Groq parser: ${process.env.GROQ_API_KEY ? 'configured' : 'not configured'}`,
    `${process.env.TG_BOT_TOKEN && process.env.TG_CHAT_ID ? '✅' : '❌'} Telegram: ${process.env.TG_BOT_TOKEN && process.env.TG_CHAT_ID ? 'configured' : 'missing config'}`,
  ];
  return { text: lines.join('\n'), checkedAt: now };
}

function pnlWalletList(raw) {
  return String(raw || '')
    .split(',')
    .map(w => w.trim())
    .filter(w => /^0x[a-fA-F0-9]{40}$/.test(w))
    .filter((w, i, arr) => arr.findIndex(x => x.toLowerCase() === w.toLowerCase()) === i)
    .slice(0, 12);
}

function pnlParam(raw, allowed, fallback) {
  const value = String(raw || fallback).toLowerCase();
  return allowed.includes(value) ? value : fallback;
}

async function resolveHost(hostname) {
  const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`, {
    headers: { accept: 'application/dns-json' }
  });
  if (!response.ok) throw new Error(`DNS fallback returned HTTP ${response.status}`);
  const payload = await response.json();
  const ip = (payload.Answer || []).map(answer => answer.data).find(data => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(data));
  if (!ip) throw new Error(`Could not resolve ${hostname}`);
  return ip;
}

async function fetchJsonViaResolvedIp(url, timeoutMs=18000) {
  const ip = await resolveHost(url.hostname);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: ip,
      servername: url.hostname,
      path: url.pathname + url.search,
      method: 'GET',
      timeout: timeoutMs,
      headers: { host: url.hostname, accept: 'application/json' }
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Polymarket PNL fallback returned HTTP ${response.statusCode}`));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch(e) { reject(new Error('Polymarket PNL fallback returned invalid JSON')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Polymarket fallback timed out')));
    req.on('error', reject);
    req.end();
  });
}

async function fetchWalletPnl(wallet, interval, fidelity) {
  const url = new URL(POLYMARKET_PNL_BASE);
  url.searchParams.set('user_address', wallet);
  url.searchParams.set('interval', interval);
  url.searchParams.set('fidelity', fidelity);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 18000);
  try {
    let rows;
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`Polymarket PNL returned HTTP ${response.status}`);
      rows = await response.json();
    } catch(e) {
      rows = await fetchJsonViaResolvedIp(url);
    }
    if (!Array.isArray(rows)) throw new Error('Polymarket PNL returned an invalid payload');
    return rows
      .map(row => ({ t: Number(row.t), p: Number(row.p) }))
      .filter(row => Number.isFinite(row.t) && Number.isFinite(row.p))
      .sort((a, b) => a.t - b.t);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchPolymarketJson(url, timeoutMs=12000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`Polymarket returned HTTP ${response.status}`);
      return await response.json();
    } catch(e) {
      return await fetchJsonViaResolvedIp(url, timeoutMs);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return out;
}

async function fetchMarketMovePositions(wallets) {
  const allPositions = [];
  for (const wallet of wallets) {
    let offset = 0;
    let pages = 0;
    while (pages < 8) {
      const url = new URL('https://data-api.polymarket.com/positions');
      url.searchParams.set('user', wallet);
      url.searchParams.set('limit', '100');
      url.searchParams.set('offset', String(offset));
      url.searchParams.set('sizeThreshold', '0.01');
      const page = await fetchPolymarketJson(url, 12000);
      if (!Array.isArray(page) || !page.length) break;
      allPositions.push(...page.map(p => ({ ...p, _wallet: wallet })));
      if (page.length < 100) break;
      offset += 100;
      pages++;
    }
  }
  return allPositions;
}

function pmFirstString(...values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
}

function pmGammaMarket(payload) {
  if (Array.isArray(payload)) return payload[0] || null;
  if (Array.isArray(payload?.markets)) return payload.markets[0] || null;
  return payload && typeof payload === 'object' ? payload : null;
}

function pmGammaIcon(market) {
  return pmFirstString(
    market?.icon,
    market?.image,
    market?.eventIcon,
    market?.event?.icon,
    market?.event?.image,
    market?.events?.[0]?.icon,
    market?.events?.[0]?.image,
  );
}

function pmGammaEventSlug(market) {
  return pmFirstString(
    market?.eventSlug,
    market?.event_slug,
    market?.event?.slug,
    market?.events?.[0]?.slug,
  );
}

function pmGammaSlug(market) {
  return pmFirstString(market?.marketSlug, market?.market_slug, market?.slug);
}

function pmMarketUrlFrom(pos, market) {
  const direct = pmFirstString(pos?.marketUrl, pos?.url, market?.marketUrl, market?.url);
  if (/^https?:\/\//i.test(direct)) return direct;
  const child = pmFirstString(pos?.marketSlug, pos?.market_slug, pos?.slug, pmGammaSlug(market));
  const event = pmFirstString(pos?.eventSlug, pos?.event_slug, pmGammaEventSlug(market));
  if (event && child && event !== child) {
    return `https://polymarket.com/event/${encodeURIComponent(event)}/${encodeURIComponent(child)}`;
  }
  if (child) return `https://polymarket.com/event/${encodeURIComponent(child)}`;
  return '';
}

async function fetchGammaMarketForPosition(pos) {
  const slug = pmFirstString(pos?.marketSlug, pos?.market_slug, pos?.slug);
  if (slug) {
    const url = new URL('https://gamma-api.polymarket.com/markets');
    url.searchParams.set('slug', slug);
    const market = pmGammaMarket(await fetchPolymarketJson(url, 10000));
    if (market) return market;
  }
  const title = pmFirstString(pos?.title, pos?.marketTitle, pos?.question);
  if (title) {
    const url = new URL('https://gamma-api.polymarket.com/markets');
    url.searchParams.set('active', 'true');
    url.searchParams.set('closed', 'false');
    url.searchParams.set('limit', '10');
    url.searchParams.set('search', title);
    const rows = await fetchPolymarketJson(url, 10000);
    const markets = Array.isArray(rows) ? rows : Array.isArray(rows?.markets) ? rows.markets : [];
    const wanted = title.toLowerCase().replace(/\s+/g, ' ').trim();
    return markets.find(m => String(m?.question || m?.title || '').toLowerCase().replace(/\s+/g, ' ').trim() === wanted)
      || markets[0]
      || null;
  }
  return null;
}

async function enrichPolymarketPositions(positions) {
  const needs = new Map();
  for (const pos of positions || []) {
    const hasIcon = pmFirstString(pos?.marketIcon, pos?.icon, pos?.image, pos?.eventIcon, pos?.thumbnail, pos?.logo);
    const hasUrl = pmFirstString(pos?.marketUrl, pos?.url);
    if (hasIcon && hasUrl) continue;
    const key = pmFirstString(pos?.marketSlug, pos?.market_slug, pos?.slug, pos?.marketId, pos?.conditionId, pos?.asset, pos?.title).toLowerCase();
    if (key && !needs.has(key)) needs.set(key, pos);
  }
  const metadata = new Map();
  await mapLimit(Array.from(needs.entries()), PM_METADATA_CONCURRENCY, async ([key, pos]) => {
    try {
      metadata.set(key, await fetchGammaMarketForPosition(pos));
    } catch(e) {
      metadata.set(key, null);
    }
  });
  return (positions || []).map(pos => {
    const key = pmFirstString(pos?.marketSlug, pos?.market_slug, pos?.slug, pos?.marketId, pos?.conditionId, pos?.asset, pos?.title).toLowerCase();
    const market = metadata.get(key) || null;
    return {
      ...pos,
      marketIcon: pmFirstString(pos?.marketIcon, pos?.icon, pos?.image, pos?.eventIcon, pos?.thumbnail, pos?.logo, pmGammaIcon(market)),
      marketUrl: pmMarketUrlFrom(pos, market),
      slug: pmFirstString(pos?.slug, pmGammaSlug(market)),
      marketSlug: pmFirstString(pos?.marketSlug, pos?.market_slug, pmGammaSlug(market)),
      eventSlug: pmFirstString(pos?.eventSlug, pos?.event_slug, pmGammaEventSlug(market)),
      marketId: pmFirstString(pos?.marketId, pos?.market_id, pos?.conditionId, pos?.condition_id, market?.conditionId, market?.condition_id),
    };
  });
}

async function getPolymarketBalances(query) {
  const wallets = pnlWalletList(query.wallets);
  if (!wallets.length) return { status: 400, body: { error: 'No valid Polymarket wallet addresses provided' } };
  const key = wallets.map(w => w.toLowerCase()).sort().join('|');
  const cached = polymarketBalancesCache.get(key);
  if (cached && Date.now() - cached.ts < PM_BALANCES_CACHE_MS) {
    return { status: 200, body: { ok: true, cached: true, ...cached.body } };
  }
  try {
    const result = await fetchPolymarketWalletBalances(wallets);
    const body = { ok: true, cached: false, ...result };
    polymarketBalancesCache.set(key, { ts: Date.now(), body });
    return { status: 200, body };
  } catch (e) {
    if (cached?.body) {
      return {
        status: 200,
        body: {
          ok: true,
          cached: true,
          stale: true,
          ...cached.body,
          error: e.message || 'Polymarket balances refresh failed',
        },
      };
    }
    return { status: 502, body: { error: e.message || 'Polymarket balances refresh failed' } };
  }
}

async function getPolymarketPositions(query) {
  const wallets = pnlWalletList(query.wallets);
  if (!wallets.length) return { status: 400, body: { error: 'No valid Polymarket wallet addresses provided' } };
  const key = wallets.map(w => w.toLowerCase()).sort().join('|');
  const cached = polymarketPositionsCache.get(key);
  if (cached && Date.now() - cached.ts < PM_POSITIONS_CACHE_MS) {
    return { status: 200, body: { ok: true, cached: true, ...cached.body } };
  }
  try {
    const positions = await enrichPolymarketPositions(await fetchMarketMovePositions(wallets));
    const body = { wallets: wallets.length, positionCount: positions.length, partial: false, positions };
    polymarketPositionsCache.set(key, { ts: Date.now(), body });
    return { status: 200, body: { ok: true, cached: false, ...body } };
  } catch(e) {
    if (cached?.body) {
      return { status: 200, body: { ok: true, cached: true, stale: true, ...cached.body, error: e.message || 'Polymarket positions refresh failed' } };
    }
    return { status: 502, body: { error: e.message || 'Polymarket positions refresh failed' } };
  }
}

async function getPolymarketMarketMoves(query) {
  const wallets = pnlWalletList(query.wallets);
  if (!wallets.length) return { status: 400, body: { error: 'No valid Polymarket wallet addresses provided' } };
  const key = wallets.map(w => w.toLowerCase()).sort().join('|');
  const cached = marketMovesCache.get(key);
  if (cached && Date.now() - cached.ts < MARKET_MOVES_CACHE_MS) {
    return { status: 200, body: { ok: true, cached: true, ...cached.body } };
  }

  try {
    const allPositions = await fetchMarketMovePositions(wallets);
    if (!allPositions.length) {
      const body = { wallets: wallets.length, checkedAssets: 0, failedAssets: 0, partial: false, movers: [] };
      marketMovesCache.set(key, { ts: Date.now(), body });
      return { status: 200, body: { ok: true, cached: false, ...body } };
    }

    const byAsset = new Map();
    for (const pos of allPositions) {
      const asset = String(pos.asset || '').trim();
      if (!asset) continue;
      const size = Number(pos.size || 0);
      const currentValue = Number(pos.currentValue || 0);
      const existing = byAsset.get(asset) || {
        asset,
        title: pos.title || 'Unknown Market',
        outcome: pos.outcome || '',
        slug: pos.slug || pos.marketSlug || pos.market_slug || '',
        eventSlug: pos.eventSlug || pos.event_slug || '',
        marketUrl: pos.marketUrl || pos.url || '',
        size: 0,
        currentValue: 0
      };
      existing.size += Number.isFinite(size) ? size : 0;
      existing.currentValue += Number.isFinite(currentValue) ? currentValue : 0;
      if (!existing.title && pos.title) existing.title = pos.title;
      if (!existing.outcome && pos.outcome) existing.outcome = pos.outcome;
      if (!existing.slug && (pos.slug || pos.marketSlug || pos.market_slug)) {
        existing.slug = pos.slug || pos.marketSlug || pos.market_slug;
      }
      if (!existing.eventSlug && (pos.eventSlug || pos.event_slug)) {
        existing.eventSlug = pos.eventSlug || pos.event_slug;
      }
      if (!existing.marketUrl && (pos.marketUrl || pos.url)) {
        existing.marketUrl = pos.marketUrl || pos.url;
      }
      byAsset.set(asset, existing);
    }

    const candidates = Array.from(byAsset.values())
      .filter(pos => pos.asset && pos.size > 0 && pos.currentValue > 0)
      .sort((a, b) => b.currentValue - a.currentValue)
      .slice(0, MARKET_MOVES_ASSET_LIMIT);
    const since24h = Math.floor(Date.now() / 1000) - 86400;
    let failedAssets = 0;
    const rows = await mapLimit(candidates, MARKET_MOVES_CONCURRENCY, async pos => {
      try {
        const url = new URL('https://clob.polymarket.com/prices-history');
        url.searchParams.set('market', pos.asset);
        url.searchParams.set('startTs', String(since24h));
        url.searchParams.set('resolution', '1h');
        const hist = await fetchPolymarketJson(url, 10000);
        const first = Array.isArray(hist?.history) && hist.history.length ? hist.history[0] : null;
        const price24hAgo = Number(first?.p ?? first?.price ?? 0);
        const curPrice = pos.size > 0 ? pos.currentValue / pos.size : 0;
        if (!price24hAgo || !curPrice) return null;
        const pctChange = ((curPrice - price24hAgo) / price24hAgo) * 100;
        if (Math.abs(pctChange) < 5) return null;
        return {
          title: pos.title || 'Unknown Market',
          outcome: pos.outcome || '',
          asset: pos.asset,
          slug: pos.slug || '',
          eventSlug: pos.eventSlug || '',
          marketUrl: pmMarketUrlFrom(pos, null),
          curPrice,
          price24hAgo,
          pctChange,
          currentValue: pos.currentValue,
          size: pos.size
        };
      } catch(e) {
        failedAssets++;
        return null;
      }
    });
    const movers = rows
      .filter(Boolean)
      .sort((a, b) => Math.abs(b.pctChange) - Math.abs(a.pctChange))
      .slice(0, 12);
    const body = {
      wallets: wallets.length,
      positionCount: allPositions.length,
      checkedAssets: candidates.length,
      failedAssets,
      partial: failedAssets > 0,
      movers
    };
    marketMovesCache.set(key, { ts: Date.now(), body });
    return { status: 200, body: { ok: true, cached: false, ...body } };
  } catch(e) {
    if (cached?.body) {
      return { status: 200, body: { ok: true, cached: true, stale: true, ...cached.body, error: e.message || 'Market moves refresh failed' } };
    }
    return { status: 502, body: { error: e.message || 'Market moves refresh failed' } };
  }
}

function aggregatePnlSeries(seriesByWallet) {
  const timestamps = Array.from(new Set(seriesByWallet.flatMap(series => series.map(point => point.t)))).sort((a, b) => a - b);
  const indexes = seriesByWallet.map(() => 0);
  const latest = seriesByWallet.map(() => 0);
  return timestamps.map(t => {
    let sum = 0;
    seriesByWallet.forEach((series, walletIndex) => {
      while (indexes[walletIndex] < series.length && series[indexes[walletIndex]].t <= t) {
        latest[walletIndex] = series[indexes[walletIndex]].p;
        indexes[walletIndex]++;
      }
      sum += latest[walletIndex];
    });
    return { t, p: sum };
  });
}

async function getPolymarketPnlSeries(query) {
  const wallets = pnlWalletList(query.wallets);
  if (!wallets.length) return { status: 400, body: { error: 'No valid Polymarket wallet addresses provided' } };
  const interval = pnlParam(query.interval, ['1d', '1w', '1m', 'all'], '1m');
  const fidelity = pnlParam(query.fidelity, ['1h', '1d'], '1h');
  const settled = await Promise.allSettled(wallets.map(wallet => fetchWalletPnl(wallet, interval, fidelity)));
  const fulfilled = settled
    .filter(result => result.status === 'fulfilled' && result.value.length)
    .map(result => result.value);
  if (!fulfilled.length) {
    const reason = settled.find(result => result.status === 'rejected')?.reason;
    return { status: 502, body: { error: reason?.message || 'No PNL points returned' } };
  }
  return {
    status: 200,
    body: {
      ok: true,
      wallets: wallets.length,
      loadedWallets: fulfilled.length,
      interval,
      fidelity,
      points: aggregatePnlSeries(fulfilled)
    }
  };
}

const runCheckAlerts = require('../lib/check-alerts-run');
const { runDueJobs, getCronStatus } = require('../lib/cron-runner');

function expectedCronSyncSecret() {
  return process.env.SYNC_SECRET || '';
}

function providedCronSyncSecret(req) {
  return String(
    req.headers['x-sync-secret']
    || req.query?.secret
    || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    || '',
  );
}

async function handleCronTick(req, res) {
  const expected = expectedCronSyncSecret();
  if (!expected || providedCronSyncSecret(req) !== expected) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  const maxJobs = Math.min(2, Math.max(1, parseInt(req.query?.maxJobs || '1', 10) || 1));
  try {
    return res.status(200).json(await runDueJobs({ maxJobs }));
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || 'Cron tick failed' });
  }
}

async function handleCronStatus(req, res) {
  try {
    return res.status(200).json(await getCronStatus());
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || 'Cron status failed' });
  }
}

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-sync-secret, x-cron-secret, authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.query?.checkAlerts === '1') {
    return runCheckAlerts(req, res);
  }
  if (req.query?.cronTick === '1') {
    return handleCronTick(req, res);
  }
  if (req.query?.cronStatus === '1') {
    return handleCronStatus(req, res);
  }

  // ── GET — load all vault data back to the browser ─────────────────────────
  if (req.method === 'GET') {
    try {
      if (req.query?.status === '1') {
        return res.status(200).json({ ok: true, ...(await getSystemStatusText()) });
      }
      if (req.query?.eventLog === '1') {
        const result = await collectEvents({ force: req.query.force === '1' });
        return res.status(200).json({ ok: true, ...result });
      }
      if (req.query?.polymarketPnl === '1') {
        const result = await getPolymarketPnlSeries(req.query || {});
        return res.status(result.status).json(result.body);
      }
      if (req.query?.polymarketPositions === '1') {
        const result = await getPolymarketPositions(req.query || {});
        return res.status(result.status).json(result.body);
      }
      if (req.query?.polymarketBalances === '1') {
        const result = await getPolymarketBalances(req.query || {});
        return res.status(result.status).json(result.body);
      }
      if (req.query?.marketMoves === '1') {
        const result = await getPolymarketMarketMoves(req.query || {});
        return res.status(result.status).json(result.body);
      }
      if (req.query?.perpsConfig === '1') {
        const savedConfig = parseJson(await kvGet('vault:perps_config'), {});
        const portfolio = parseJson(await kvGet('vault:portfolio'), {});
        const portfolioConfig = portfolio?.perpsArb && typeof portfolio.perpsArb === 'object'
          ? portfolio.perpsArb
          : {};
        const perpsConfig = /^0x[a-fA-F0-9]{40}$/.test(String(savedConfig.hyperliquid || ''))
          ? savedConfig
          : portfolioConfig;
        return res.status(200).json({ ok: true, perpsConfig });
      }
      if (req.query?.perpsSnapshots === '1') {
        const perpsSnapshots = parseJson(await kvGet('vault:perps_snapshots'), {});
        return res.status(200).json({ ok: true, perpsSnapshots });
      }
      if (req.query?.perpsAux === '1') {
        const [perpsSnapshotsRaw, perpsVariationalHedgesRaw, perpsClosedPairsRaw] = await Promise.all([
          kvGet('vault:perps_snapshots'),
          kvGet('vault:perps_variational_hedges'),
          kvGet('vault:perps_closed_pairs'),
        ]);
        return res.status(200).json({
          ok: true,
          perpsSnapshots: parseJson(perpsSnapshotsRaw, {}),
          perpsVariationalHedges: parseJson(perpsVariationalHedgesRaw, []),
          perpsClosedPairs: parseJson(perpsClosedPairsRaw, []),
        });
      }
      if (req.query?.loopSnapshots === '1') {
        await ensureUsdeUsdmSnapshotsPurged({ kvGet, kvSet, parseJson });
        const loopSnapshots = parseJson(await kvGet('vault:loop_snapshots'), {});
        return res.status(200).json({ ok: true, loopSnapshots });
      }
      if (req.query?.logoCache === '1') {
        const logoCache = parseJson(await kvGet('vault:logo_cache'), {});
        return res.status(200).json({ ok: true, logoCache });
      }
      if (req.query?.geckoSymbolIds === '1') {
        const geckoSymbolIds = parseJson(await kvGet('vault:gecko_symbol_ids'), {});
        return res.status(200).json({ ok: true, geckoSymbolIds });
      }

      const parse = (raw, fallback) => {
        if (!raw) return fallback;
        try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch(e) { return fallback; }
      };

      // Heavy aux only (~500KB): snapshots, logos, perps history, event log cache.
      // Fetched in background after portfolio-first paint.
      if (req.query?.auxHeavy === '1') {
        const [snapshotsRaw, perpsSnapshotsRaw, perpsVariationalHedgesRaw, perpsClosedPairsRaw, logoCacheRaw, eventHistoryRaw] = await Promise.all([
          kvGet('vault:snapshots'),
          kvGet('vault:perps_snapshots'),
          kvGet('vault:perps_variational_hedges'),
          kvGet('vault:perps_closed_pairs'),
          kvGet('vault:logo_cache'),
          kvGet('vault:event_history'),
        ]);
        const result = {
          _snapshots:      parse(snapshotsRaw, {}),
          _perpsSnapshots: parse(perpsSnapshotsRaw, {}),
          _perpsVariationalHedges: parse(perpsVariationalHedgesRaw, []),
          _perpsClosedPairs: parse(perpsClosedPairsRaw, []),
          _logoCache:      parse(logoCacheRaw, {}),
          _eventHistory:   parse(eventHistoryRaw, []),
        };
        return res.status(200).json({ ok: true, result: JSON.stringify(result) });
      }

      const portfolioOnly = req.query?.portfolioOnly === '1';
      const [
        portfolioRaw, watchlistRaw, watcherWalletsRaw, watcherLinksRaw,
        snapshotsRaw, aaveMarketsRaw, customTokensRaw,
        opinionWalletsRaw, tgChannelsRaw, pmWalletsRaw, opportunityMonitorsRaw,
        eventHistoryRaw, dismissedMarketsRaw, perpsConfigRaw, perpsSnapshotsRaw,
        perpsVariationalHedgesRaw, perpsClosedPairsRaw, logoCacheRaw,
        geckoSymbolIdsRaw,
      ] = await Promise.all([
        kvGet('vault:portfolio'),
        kvGet('vault:watchlist'),
        kvGet('vault:watcherwallets'),
        kvGet('vault:watcherlinks'),
        portfolioOnly ? null : kvGet('vault:snapshots'),
        kvGet('vault:aavemarkets'),
        kvGet('vault:customtokens'),
        kvGet('vault:opinion_wallets'),
        kvGet('vault:feed_channels'),
        kvGet('vault:pm_wallets'),
        kvGet('vault:opportunitymonitors'),
        portfolioOnly ? null : kvGet('vault:event_history'),
        kvGet('vault:dismissed_markets'),
        kvGet('vault:perps_config'),
        portfolioOnly ? null : kvGet('vault:perps_snapshots'),
        portfolioOnly ? null : kvGet('vault:perps_variational_hedges'),
        portfolioOnly ? null : kvGet('vault:perps_closed_pairs'),
        portfolioOnly ? null : kvGet('vault:logo_cache'),
        kvGet('vault:gecko_symbol_ids'),
      ]);

      const portfolio      = parse(portfolioRaw, { tokens: [], protocols: [], etfs: [], predictionMarkets: [], opinionMarkets: [], polymarketWallets: [] });
      const watchlist      = parse(watchlistRaw, []);
      const watcherWallets = parse(watcherWalletsRaw, []);
      const watcherLinks   = parse(watcherLinksRaw, []);
      const snapshots      = parse(snapshotsRaw, {});
      const aaveMarkets    = parse(aaveMarketsRaw, []);
      const customTokens   = parse(customTokensRaw, {});
      const opinionWallets = parse(opinionWalletsRaw, []);
      const tgChannels     = parse(tgChannelsRaw, []);
      const pmWallets      = parse(pmWalletsRaw, []);
      const opportunityMonitors = parse(opportunityMonitorsRaw, { pegTokens: [], includePmNoApy: true });
      const eventHistory        = parse(eventHistoryRaw, []);
      const dismissedMarkets    = parse(dismissedMarketsRaw, []);
      const perpsConfig         = parse(perpsConfigRaw, {});
      const perpsSnapshots      = parse(perpsSnapshotsRaw, {});
      const perpsVariationalHedges = parse(perpsVariationalHedgesRaw, []);
      const perpsClosedPairs    = parse(perpsClosedPairsRaw, []);
      const logoCache           = parse(logoCacheRaw, {});
      const geckoSymbolIds      = parse(geckoSymbolIdsRaw, {});

      if (Array.isArray(pmWallets)) {
        const seen = new Set();
        portfolio.polymarketWallets = pmWallets
          .map(w => String(w || '').trim())
          .filter(Boolean)
          .filter(w => {
            const key = w.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
      } else if (!Array.isArray(portfolio.polymarketWallets)) {
        portfolio.polymarketWallets = [];
      }

      // Embed auxiliary data as _ keys inside the portfolio object.
      // The browser's loadData() extracts and deletes these before setting data = parsed.
      const result = {
        ...portfolio,
        _watchlist:      watchlist,
        _watcherWallets: watcherWallets,
        _watcherLinks:   watcherLinks,
        _aaveMarkets:    aaveMarkets,
        _customTokens:   customTokens,
        _opinionConfig:  { wallets: opinionWallets, walletAddress: opinionWallets[0] || '' },
        _tgChannels:     tgChannels,
        _opportunityMonitors: opportunityMonitors,
        _dismissedMarkets:    dismissedMarkets,
        _perpsConfig:         perpsConfig,
        _geckoSymbolIds:      geckoSymbolIds,
      };
      if (!portfolioOnly) {
        result._snapshots = snapshots;
        result._eventHistory = eventHistory;
        result._perpsSnapshots = perpsSnapshots;
        result._perpsVariationalHedges = perpsVariationalHedges;
        result._perpsClosedPairs = perpsClosedPairs;
        result._logoCache = logoCache;
      }

      return res.status(200).json({ ok: true, result: JSON.stringify(result) });
    } catch (e) {
      console.error('[sync] GET error:', e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Auth
  if (SYNC_SECRET) {
    const provided = req.headers['x-sync-secret'];
    // Browser portfolio sync predates cron auth and intentionally sends no secret.
    // Reject an explicitly supplied wrong credential without breaking dashboard saves.
    if (provided && provided !== SYNC_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) {
      return res.status(400).json({ error: 'Invalid JSON' });
    }
  }

  const saved = {};

  try {
    // Portfolio data (tokens, protocols, ETFs, prediction markets)
    if (body.portfolio) {
      await kvSet('vault:portfolio', JSON.stringify(body.portfolio));
      saved.portfolio = true;
      const portfolioHedges = body.portfolio?.perpsArb?.variationalHedges;
      if (Array.isArray(portfolioHedges) && portfolioHedges.length) {
        const existing = parseJson(await kvGet('vault:perps_variational_hedges'), []);
        const merged = mergeVariationalHedgeRows(existing, portfolioHedges);
        await kvSet('vault:perps_variational_hedges', JSON.stringify(merged));
        saved.perpsVariationalHedges = true;
      }
    }

    // Watchlist
    if (body.watchlist) {
      await kvSet('vault:watchlist', JSON.stringify(body.watchlist));
      saved.watchlist = true;
    }

    // Weekly snapshots
    if (body.snapshots) {
      await kvSet('vault:snapshots', JSON.stringify(body.snapshots));
      saved.snapshots = true;
    }

    // Aave markets being monitored
    if (body.aaveMarkets) {
      await kvSet('vault:aavemarkets', JSON.stringify(body.aaveMarkets));
      saved.aaveMarkets = true;
    }

    // Custom token definitions
    if (body.customTokens) {
      await kvSet('vault:customtokens', JSON.stringify(body.customTokens));
      saved.customTokens = true;
    }

    if (body.logoCache && typeof body.logoCache === 'object') {
      await kvSet('vault:logo_cache', JSON.stringify(body.logoCache));
      saved.logoCache = true;
    }

    if (body.geckoSymbolIds && typeof body.geckoSymbolIds === 'object') {
      await mergeGeckoSymbolIds(body.geckoSymbolIds);
      saved.geckoSymbolIds = true;
    }

    if (body.opportunityMonitors) {
      await kvSet('vault:opportunitymonitors', JSON.stringify(body.opportunityMonitors));
      saved.opportunityMonitors = true;
    }

    if (body.eventHistory) {
      // Keep only last 48h. Event-log dedupe happens server-side in lib/event-log.
      const cutoff = Date.now() - 48 * 3600 * 1000;
      const trimmed = (Array.isArray(body.eventHistory) ? body.eventHistory : [])
        .filter(e => (e.ts || 0) > cutoff).slice(-1000);
      await kvSet('vault:event_history', JSON.stringify(trimmed));
      saved.eventHistory = true;
    }

    if (body.dismissedMarkets) {
      await kvSet('vault:dismissed_markets', JSON.stringify(body.dismissedMarkets));
      saved.dismissedMarkets = true;
    }

    // Watcher wallets
    if (body.watcherWallets) {
      await kvSet('vault:watcherwallets', JSON.stringify(body.watcherWallets));
      saved.watcherWallets = true;
    }

    // Polymarket wallet addresses — also available inside body.portfolio
    const pmWallets = body.polymarketWallets || body.portfolio?.polymarketWallets;
    if (pmWallets) {
      await kvSet('vault:pm_wallets', JSON.stringify(pmWallets));
      saved.pmWallets = true;
    }

    // Watcher links
    if (body.watcherLinks) {
      await kvSet('vault:watcherlinks', JSON.stringify(body.watcherLinks));
      saved.watcherLinks = true;
    }

    // Opinion.trade wallet addresses (no API key stored)
    if (body.opinionWallets) {
      await kvSet('vault:opinion_wallets', JSON.stringify(body.opinionWallets));
      saved.opinionWallets = true;
    }

    // Portfolio snapshots
    if (body.snapshots) {
      await kvSet('vault:snapshots', JSON.stringify(body.snapshots));
      saved.snapshots = true;
    }

    // Chart comparison tickers
    if (body.chartTickers) {
      await kvSet('vault:chart_tickers', JSON.stringify(body.chartTickers));
      saved.chartTickers = true;
    }

    // TG / news feed channel handles
    if (body.tgChannels) {
      await kvSet('vault:feed_channels', JSON.stringify(body.tgChannels));
      saved.tgChannels = true;
    }

    // Perps arb wallets + equity snapshots (ignore empty payloads that would erase saved wallets)
    if (body.perpsConfig && /^0x[a-fA-F0-9]{40}$/.test(String(body.perpsConfig.hyperliquid || ''))) {
      await kvSet('vault:perps_config', JSON.stringify(body.perpsConfig));
      saved.perpsConfig = true;
    }
    if (body.perpsSnapshots) {
      await kvSet('vault:perps_snapshots', JSON.stringify(body.perpsSnapshots));
      saved.perpsSnapshots = true;
    }
    if (Array.isArray(body.perpsVariationalHedges) && body.perpsVariationalHedges.length) {
      const existing = parseJson(await kvGet('vault:perps_variational_hedges'), []);
      const merged = mergeVariationalHedgeRows(existing, body.perpsVariationalHedges);
      await kvSet('vault:perps_variational_hedges', JSON.stringify(merged));
      saved.perpsVariationalHedges = true;
    }
    if (Array.isArray(body.perpsClosedPairs) && body.perpsClosedPairs.length) {
      const existing = parseJson(await kvGet('vault:perps_closed_pairs'), []);
      const byKey = new Map((existing || []).map((p) => {
        const symbol = String(p?.symbol || '').trim().toUpperCase();
        const closeTime = Number(p?.closeTime || 0);
        const longVenue = p?.longLeg?.venue || '';
        const shortVenue = p?.shortLeg?.venue || '';
        return [`${symbol}|${closeTime}|${longVenue}|${shortVenue}`, p];
      }));
      for (const pair of body.perpsClosedPairs) {
        const symbol = String(pair?.symbol || '').trim().toUpperCase();
        const closeTime = Number(pair?.closeTime || 0);
        const longVenue = pair?.longLeg?.venue || '';
        const shortVenue = pair?.shortLeg?.venue || '';
        const key = `${symbol}|${closeTime}|${longVenue}|${shortVenue}`;
        if (!key || key === '||0||') continue;
        const prev = byKey.get(key);
        byKey.set(key, prev ? { ...prev, ...pair } : pair);
      }
      await kvSet('vault:perps_closed_pairs', JSON.stringify([...byKey.values()].sort((a, b) => (Number(b?.closeTime) || 0) - (Number(a?.closeTime) || 0))));
      saved.perpsClosedPairs = true;
    }
    if (body.grvtStateCache?.subAccountId && Array.isArray(body.grvtStateCache.positions) && body.grvtStateCache.positions.length) {
      await kvSet(`vault:grvt_state:${String(body.grvtStateCache.subAccountId).trim()}`, JSON.stringify({
        subAccountId: String(body.grvtStateCache.subAccountId).trim(),
        fetchedAt: Number(body.grvtStateCache.fetchedAt) || Date.now(),
        accountValue: Number(body.grvtStateCache.accountValue) || 0,
        positions: body.grvtStateCache.positions,
      }));
      saved.grvtStateCache = true;
    }

    if (body.loopSnapshots && typeof body.loopSnapshots === 'object') {
      await ensureUsdeUsdmSnapshotsPurged({ kvGet, kvSet, parseJson });
      const existing = parseJson(await kvGet('vault:loop_snapshots'), {});
      const merged = mergeLoopSnapshotStores(existing, body.loopSnapshots);
      await kvSet('vault:loop_snapshots', JSON.stringify(merged));
      saved.loopSnapshots = true;
    }

    // Timestamp of last sync
    await kvSet('vault:portfolio_synced_at', Date.now().toString());

    return res.status(200).json({ ok: true, saved });
  } catch (e) {
    console.error('[sync-portfolio] KV error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};

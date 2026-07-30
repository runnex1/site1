/**
 * Phoenix Eternal (Solana) perps adapters.
 * Public REST: https://perp-api.phoenix.trade
 * Docs: https://docs.phoenix.trade/api
 *
 * Trader reads use the Solana authority pubkey (no API key).
 * Funding interval is hourly (fundingIntervalSeconds=3600) — convert to 8h for spreads.
 */

const PHOENIX_API = 'https://perp-api.phoenix.trade';
const PHOENIX_QUOTE_DECIMALS = 6;
const PHOENIX_FUNDING_INTERVAL_HOURS = 1;
const PHOENIX_HISTORY_MAX_PAGES = 40;
const PHOENIX_MARKETS_CACHE_MS = 5 * 60 * 1000;

function isSolanaAddress(v) {
  const s = String(v || '').trim();
  if (!s || s.startsWith('0x')) return false;
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}

/** Phoenix public demo / docs sample authority — never treat as a user wallet. */
const PHOENIX_BLOCKED_AUTHORITIES = new Set([
  '3ctHNWw9NtU2Vwnx2fAhLpcgHHqjEV4nY9BQvxSrtuFr',
]);

function isBlockedPhoenixAuthority(v) {
  return PHOENIX_BLOCKED_AUTHORITIES.has(String(v || '').trim());
}

/** Solana pubkey that is safe to use as a configured Phoenix trading wallet. */
function isUsablePhoenixWallet(v) {
  return isSolanaAddress(v) && !isBlockedPhoenixAuthority(v);
}

function phoenixParseTs(value) {
  if (value == null || value === '') return 0;
  if (typeof value === 'number' && Number.isFinite(value)) {
    // seconds vs ms
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : 0;
}

function phoenixNum(value, fallback = 0) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object' && value !== null) {
    if (value.ui != null && value.ui !== '') {
      const ui = parseFloat(value.ui);
      if (Number.isFinite(ui)) return ui;
    }
    if (value.value != null && value.decimals != null) {
      const raw = Number(value.value);
      const dec = Number(value.decimals);
      if (Number.isFinite(raw) && Number.isFinite(dec)) return raw / (10 ** dec);
    }
    if (value.price != null) {
      const px = parseFloat(value.price);
      if (Number.isFinite(px)) return px;
    }
  }
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Quote lots (USDC, 6 decimals) → USD. */
function phoenixQuoteLotsToUsd(lots) {
  const n = Number(lots);
  if (!Number.isFinite(n)) return 0;
  return n / (10 ** PHOENIX_QUOTE_DECIMALS);
}

/** Convert Phoenix price ticks → USD using market tickSize (price = ticks / tickSize). */
function phoenixTicksToUsd(ticks, tickSize) {
  const t = Number(ticks);
  const denom = Number(tickSize);
  if (!Number.isFinite(t) || !Number.isFinite(denom) || denom === 0) return null;
  const px = t / denom;
  return Number.isFinite(px) && px > 0 ? px : null;
}

function phoenixActiveTriggerPx(triggers, tickSize, entryPriceTicks, entryPriceUsd) {
  const rows = Array.isArray(triggers) ? triggers : [];
  for (const row of rows) {
    const status = String(row?.status || '').toLowerCase();
    if (status && status !== 'active' && status !== 'open' && status !== 'pending') continue;
    const ticks = row?.trigger?.triggerPriceTicks ?? row?.triggerPriceTicks;
    let px = phoenixTicksToUsd(ticks, tickSize);
    if (px == null) {
      // Fallback: derive tick→USD from the position's own entry ticks/USD.
      const entryTicks = Number(entryPriceTicks);
      const entryUsd = Number(entryPriceUsd);
      if (Number.isFinite(Number(ticks)) && Number.isFinite(entryTicks) && entryTicks !== 0
        && Number.isFinite(entryUsd) && entryUsd > 0) {
        px = Number(ticks) * (entryUsd / entryTicks);
      }
    }
    if (px != null) return px;
  }
  return null;
}

function phoenixTpslFromPositionRow(row, tickSize) {
  const tpPx = phoenixActiveTriggerPx(
    row?.takeProfitTriggers,
    tickSize,
    row?.entryPriceTicks,
    row?.entryPriceUsd,
  );
  const slPx = phoenixActiveTriggerPx(
    row?.stopLossTriggers,
    tickSize,
    row?.entryPriceTicks,
    row?.entryPriceUsd,
  );
  return { tpPx, slPx };
}

/** Exact Phoenix position uPNL: virtualQuoteUsd + size * liveMark. */
function phoenixPositionUnrealizedPnl({ virtualQuoteLots, size, markPx, entryPx }) {
  // Missing quote lots must NOT become $0 — that turns uPNL into ±notional.
  const hasQuoteLots = virtualQuoteLots != null && virtualQuoteLots !== ''
    && Number.isFinite(Number(virtualQuoteLots));
  if (hasQuoteLots && Number.isFinite(markPx) && Number.isFinite(size)) {
    return phoenixQuoteLotsToUsd(virtualQuoteLots) + size * markPx;
  }
  if (Number.isFinite(markPx) && Number.isFinite(entryPx) && Number.isFinite(size)) {
    return size * (markPx - entryPx);
  }
  return 0;
}

function phoenixBaseLotsToSize(lots, baseLotsDecimals) {
  const n = Number(lots);
  const dec = Number(baseLotsDecimals);
  if (!Number.isFinite(n)) return 0;
  if (!Number.isFinite(dec) || dec < 0) return n;
  return n / (10 ** dec);
}

/**
 * Phoenix `fundingRatePercentage` is percent units (e.g. -0.000137 → -1.37e-6 fraction).
 * Prefer amountPerUnit/mark when available (same fraction, avoids naming ambiguity).
 */
function phoenixHourlyRateFromPoint(point) {
  if (!point || typeof point !== 'object') return null;
  const mark = phoenixNum(point.markPrice, NaN);
  const amount = phoenixNum(point.fundingAmountPerUnit, NaN);
  if (Number.isFinite(mark) && mark > 0 && Number.isFinite(amount)) {
    return amount / mark;
  }
  const pct = phoenixNum(
    point.fundingRatePercentage ?? point.funding_rate_percentage,
    NaN,
  );
  if (Number.isFinite(pct)) return pct / 100;
  return null;
}

function createPhoenixApi({ fetchWithTimeout, withTimeout, errorMessage, toBaseSymbol, timeoutMs }) {
  const optionalMs = timeoutMs || 25000;
  let _marketsCache = null;
  let _marketsCacheAt = 0;

  async function phoenixGet(path, params = {}, label = 'Phoenix') {
    const url = new URL(`${PHOENIX_API}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value == null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
    const res = await fetchWithTimeout(
      url.toString(),
      { headers: { accept: 'application/json' } },
      optionalMs,
      label,
    );
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
    return { ok: res.ok, status: res.status, data, text };
  }

  async function phoenixPaginate(path, {
    listKey = 'data',
    windowStartMs = 0,
    limit = 200,
    label = 'Phoenix history',
    timeOf = (row) => phoenixParseTs(row?.timestamp),
  } = {}) {
    const rows = [];
    let cursor = '';
    for (let page = 0; page < PHOENIX_HISTORY_MAX_PAGES; page++) {
      const params = { limit };
      if (cursor) params.cursor = cursor;
      const res = await phoenixGet(path, params, `${label} p${page + 1}`);
      if (!res.ok) {
        if (res.status === 404) break;
        throw new Error(res.data?.error || res.text?.slice(0, 200) || `${label} failed (${res.status})`);
      }
      const batch = Array.isArray(res.data?.[listKey])
        ? res.data[listKey]
        : (Array.isArray(res.data?.events) ? res.data.events : []);
      if (!batch.length) break;
      rows.push(...batch);
      const oldest = Math.min(...batch.map(timeOf).filter((t) => t > 0));
      if (windowStartMs && Number.isFinite(oldest) && oldest < windowStartMs) break;
      if (!res.data?.hasMore || !res.data?.nextCursor) break;
      cursor = res.data.nextCursor;
    }
    return rows;
  }

  async function fetchPhoenixMarketsMeta() {
    if (_marketsCache && Date.now() - _marketsCacheAt < PHOENIX_MARKETS_CACHE_MS) {
      return _marketsCache;
    }
    const res = await phoenixGet('/v1/view/exchange/markets', {}, 'Phoenix markets');
    if (!res.ok) throw new Error(res.data?.error || 'Phoenix markets unavailable');
    const markets = Array.isArray(res.data?.markets)
      ? res.data.markets
      : (Array.isArray(res.data) ? res.data : []);
    const bySymbol = {};
    for (const m of markets) {
      const symbol = toBaseSymbol(m.symbol || m.marketSymbol || '');
      if (!symbol) continue;
      bySymbol[symbol] = {
        symbol,
        baseLotsDecimals: Number(m.baseLotsDecimals ?? m.base_lots_decimals ?? 2),
        tickSize: Number(m.tickSize ?? m.tick_size ?? 0) || null,
        fundingIntervalSeconds: Number(m.fundingIntervalSeconds ?? m.funding_interval_seconds ?? 3600),
        marketStatus: m.marketStatus || m.market_status || null,
      };
    }
    _marketsCache = bySymbol;
    _marketsCacheAt = Date.now();
    return bySymbol;
  }

  async function fetchPhoenixRates(bases = []) {
    const res = await phoenixGet('/v1/funding/overview', {}, 'Phoenix funding overview');
    if (!res.ok) return [];
    const series = Array.isArray(res.data?.series) ? res.data.series : [];
    const want = new Set(
      (Array.isArray(bases) ? bases : [])
        .map((s) => toBaseSymbol(s))
        .filter(Boolean),
    );
    const out = [];
    for (const row of series) {
      const symbol = toBaseSymbol(row.symbol);
      if (!symbol) continue;
      if (want.size && !want.has(symbol)) continue;
      const points = Array.isArray(row.points) ? row.points : [];
      const last = points[points.length - 1];
      if (!last) continue;
      const hourly = phoenixHourlyRateFromPoint(last);
      if (hourly == null || !Number.isFinite(hourly)) continue;
      const markPx = phoenixNum(last.markPrice, NaN);
      out.push({
        venue: 'phoenix',
        symbol,
        fundingRateHourly: hourly,
        fundingRate8h: hourly * (8 / PHOENIX_FUNDING_INTERVAL_HOURS),
        fundingRateInterval: hourly,
        fundingIntervalHours: PHOENIX_FUNDING_INTERVAL_HOURS,
        markPx: Number.isFinite(markPx) && markPx > 0 ? markPx : null,
      });
    }
    return out;
  }

  /**
   * Phoenix uPNL is NOT size*(mark-entry) — entryPriceUsd is rounded.
   * Exact cashflow form (matches TraderView.unrealizedPnl):
   *   virtualQuoteLots/1e6 + size * liveMark
   */
  function mapPhoenixPositionsFromState(snapshot, marketsMeta, markBySymbol = {}) {
    const subaccounts = Array.isArray(snapshot?.subaccounts) ? snapshot.subaccounts : [];
    const positions = [];
    for (const sub of subaccounts) {
      for (const row of sub?.positions || []) {
        const symbol = toBaseSymbol(row.symbol);
        if (!symbol) continue;
        const decimals = marketsMeta[symbol]?.baseLotsDecimals ?? 2;
        const tickSize = marketsMeta[symbol]?.tickSize ?? null;
        const size = phoenixBaseLotsToSize(row.basePositionLots, decimals);
        if (!Number.isFinite(size) || Math.abs(size) < 1e-12) continue;
        const entryPx = phoenixNum(row.entryPriceUsd, NaN);
        const markPx = markBySymbol[symbol] ?? null;
        const virtualQuote = phoenixQuoteLotsToUsd(row.virtualQuotePositionLots);
        const positionValue = Number.isFinite(markPx) ? size * markPx : null;
        const unrealizedPnl = phoenixPositionUnrealizedPnl({
          virtualQuoteLots: row.virtualQuotePositionLots,
          size,
          markPx,
          entryPx,
        });
        const notional = positionValue != null
          ? Math.abs(positionValue)
          : Math.abs(virtualQuote);
        const { tpPx, slPx } = phoenixTpslFromPositionRow(row, tickSize);
        positions.push({
          venue: 'phoenix',
          symbol,
          size,
          side: size >= 0 ? 'long' : 'short',
          entryPx: Number.isFinite(entryPx) ? entryPx : null,
          markPx: Number.isFinite(markPx) ? markPx : null,
          liquidationPx: null,
          tpPx,
          slPx,
          notional,
          unrealizedPnl,
          fundingSinceOpen: phoenixQuoteLotsToUsd(row.accumulatedFundingQuoteLots),
          leverage: null,
        });
      }
    }
    return positions;
  }

  async function fetchPhoenixState(authority) {
    const empty = {
      venue: 'phoenix',
      wallet: authority || null,
      exists: false,
      configured: false,
      accountValue: 0,
      balance: 0,
      positions: [],
    };
    const wallet = String(authority || '').trim();
    if (!isSolanaAddress(wallet)) return empty;

    const [stateRes, marketsMeta, rates] = await Promise.all([
      phoenixGet(`/v1/trader/state/${encodeURIComponent(wallet)}`, {}, 'Phoenix trader state'),
      fetchPhoenixMarketsMeta().catch(() => ({})),
      fetchPhoenixRates().catch(() => []),
    ]);

    if (stateRes.status === 404) {
      return {
        ...empty,
        configured: true,
        exists: false,
        fetchedAt: Date.now(),
      };
    }
    if (!stateRes.ok) {
      return {
        ...empty,
        configured: true,
        exists: false,
        fetchedAt: Date.now(),
        error: stateRes.data?.error || stateRes.text?.slice(0, 200) || `Phoenix state ${stateRes.status}`,
        accountValue: NaN,
      };
    }

    // Funding-overview marks are last-interval snapshots — too stale for uPNL.
    // Prefer live /v1/market/{symbol}/mark-price for every open position.
    const markBySymbol = Object.fromEntries(
      (rates || []).filter((r) => r.markPx != null).map((r) => [r.symbol, r.markPx]),
    );
    const snapshot = stateRes.data?.snapshot || {};
    const openSymbols = [];
    for (const sub of snapshot.subaccounts || []) {
      for (const row of sub.positions || []) {
        const sym = toBaseSymbol(row.symbol);
        if (sym && Math.abs(Number(row.basePositionLots) || 0) > 0) openSymbols.push(sym);
      }
    }
    await Promise.all([...new Set(openSymbols)].slice(0, 24).map(async (symbol) => {
      try {
        const markRes = await phoenixGet(
          `/v1/market/${encodeURIComponent(symbol)}/mark-price`,
          {},
          `Phoenix mark ${symbol}`,
        );
        const px = phoenixNum(markRes.data?.markPrice, NaN);
        if (Number.isFinite(px) && px > 0) markBySymbol[symbol] = px;
      } catch (_) { /* keep overview fallback */ }
    }));

    const positions = mapPhoenixPositionsFromState(snapshot, marketsMeta, markBySymbol);
    const sub0 = snapshot.subaccounts?.[0];
    const collateral = phoenixQuoteLotsToUsd(sub0?.collateral);
    const upnl = positions.reduce((sum, p) => sum + (p.unrealizedPnl || 0), 0);
    // Matches TraderView.effectiveCollateral / portfolioValue.
    const accountValue = collateral + upnl;

    return {
      venue: 'phoenix',
      wallet,
      configured: true,
      exists: accountValue > 0 || positions.length > 0 || collateral > 0,
      fetchedAt: Date.now(),
      accountValue,
      balance: collateral,
      unrealizedPnl: upnl,
      traderPdaIndex: stateRes.data?.traderPdaIndex ?? 0,
      positions,
    };
  }

  async function fetchPhoenixEquity(authority) {
    if (!isSolanaAddress(authority)) {
      return { venue: 'phoenix', configured: false, accountValue: 0 };
    }
    const state = await fetchPhoenixState(authority);
    return {
      venue: 'phoenix',
      configured: true,
      fetchedAt: state.fetchedAt || Date.now(),
      accountValue: state.accountValue,
      error: state.error || null,
    };
  }

  async function fetchPhoenixFunding(authority, days = 30) {
    const empty = { venue: 'phoenix', wallet: authority, days, payments: [], totalFunding: 0 };
    const wallet = String(authority || '').trim();
    if (!isSolanaAddress(wallet)) return empty;

    const windowStart = Date.now() - days * 86400000;
    let rows = [];
    try {
      rows = await phoenixPaginate(`/v1/trader/${encodeURIComponent(wallet)}/funding-history`, {
        listKey: 'events',
        windowStartMs: windowStart,
        limit: 200,
        label: 'Phoenix funding',
      });
    } catch (e) {
      return { ...empty, error: errorMessage(e) };
    }

    const payments = rows
      .map((row) => {
        const time = phoenixParseTs(row.timestamp);
        const usdc = phoenixNum(row.fundingPayment, 0);
        return {
          venue: 'phoenix',
          time,
          symbol: toBaseSymbol(row.symbol),
          usdc: Number.isFinite(usdc) ? usdc : 0,
          size: phoenixNum(row.positionSize, null),
          fundingRate: phoenixHourlyRateFromPoint({
            fundingRatePercentage: row.fundingRatePercentage,
          }),
          intervalHours: PHOENIX_FUNDING_INTERVAL_HOURS,
        };
      })
      .filter((p) => p.time >= windowStart && p.symbol);

    payments.sort((a, b) => b.time - a.time);
    return {
      venue: 'phoenix',
      wallet,
      days,
      payments,
      totalFunding: payments.reduce((s, p) => s + p.usdc, 0),
    };
  }

  async function fetchPhoenixFills(authority, days = 30) {
    const empty = {
      venue: 'phoenix',
      wallet: authority,
      days,
      fills: [],
      totalFees: 0,
      totalRealized: 0,
    };
    const wallet = String(authority || '').trim();
    if (!isSolanaAddress(wallet)) return empty;

    const windowStart = Date.now() - days * 86400000;
    let rows = [];
    try {
      rows = await phoenixPaginate(`/v1/trader/${encodeURIComponent(wallet)}/trades-history`, {
        listKey: 'data',
        windowStartMs: windowStart,
        limit: 200,
        label: 'Phoenix fills',
      });
    } catch (e) {
      return { ...empty, error: errorMessage(e) };
    }

    const fills = [];
    const seen = new Set();
    for (const row of rows) {
      const time = phoenixParseTs(row.timestamp);
      if (time < windowStart) continue;
      const symbol = toBaseSymbol(row.marketSymbol || row.symbol);
      const delta = phoenixNum(row.baseLotsDelta, NaN);
      if (!symbol || !Number.isFinite(delta) || delta === 0) continue;
      const key = `${time}:${row.fillId || row.signature || ''}:${symbol}:${delta}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const side = delta > 0 ? 'buy' : 'sell';
      const fee = Math.abs(phoenixNum(row.fees, 0));
      const closedPnl = phoenixNum(row.realizedPnl, 0);
      fills.push({
        venue: 'phoenix',
        time,
        symbol,
        px: phoenixNum(row.price, 0),
        sz: Math.abs(delta),
        side,
        fee,
        closedPnl,
        oid: row.fillId || row.signature || null,
      });
    }

    fills.sort((a, b) => b.time - a.time);
    return {
      venue: 'phoenix',
      wallet,
      days,
      fills,
      totalFees: fills.reduce((s, f) => s + f.fee, 0),
      totalRealized: fills.reduce((s, f) => s + f.closedPnl, 0),
    };
  }

  async function fetchPhoenixCapitalFlows(authority) {
    const empty = { venue: 'phoenix', wallet: authority, payments: [], netDeposits: 0 };
    const wallet = String(authority || '').trim();
    if (!isSolanaAddress(wallet)) return empty;

    let rows = [];
    try {
      rows = await phoenixPaginate(`/v1/trader/${encodeURIComponent(wallet)}/collateral-history`, {
        listKey: 'data',
        windowStartMs: 0,
        limit: 200,
        label: 'Phoenix collateral',
      });
    } catch (e) {
      return { ...empty, error: errorMessage(e) };
    }

    const payments = [];
    for (const row of rows) {
      const time = phoenixParseTs(row.timestamp);
      const amountUsd = phoenixQuoteLotsToUsd(row.amount);
      if (!time || !Number.isFinite(amountUsd) || amountUsd === 0) continue;
      const type = String(row.eventType || '').toLowerCase();
      let usdc = 0;
      let kind = null;
      if (type === 'deposit') {
        kind = 'deposit';
        usdc = Math.abs(amountUsd);
      } else if (type === 'withdrawal' || type === 'withdraw') {
        kind = 'withdraw';
        usdc = -Math.abs(amountUsd);
      } else continue;
      payments.push({
        venue: 'phoenix',
        time,
        usdc,
        kind,
        // Keep type for older clients; PnL filters must see kind like HL/Nado/GRVT/Ext.
        type: kind === 'withdraw' ? 'withdrawal' : type,
      });
    }
    payments.sort((a, b) => b.time - a.time);
    return {
      venue: 'phoenix',
      wallet,
      payments,
      netDeposits: payments.reduce((s, p) => s + p.usdc, 0),
    };
  }

  return {
    isSolanaAddress,
    isBlockedPhoenixAuthority,
    isUsablePhoenixWallet,
    phoenixHourlyRateFromPoint,
    phoenixQuoteLotsToUsd,
    fetchPhoenixMarketsMeta,
    fetchPhoenixRates,
    fetchPhoenixState,
    fetchPhoenixEquity,
    fetchPhoenixFunding,
    fetchPhoenixFills,
    fetchPhoenixCapitalFlows,
  };
}

module.exports = {
  PHOENIX_API,
  PHOENIX_FUNDING_INTERVAL_HOURS,
  PHOENIX_BLOCKED_AUTHORITIES,
  isSolanaAddress,
  isBlockedPhoenixAuthority,
  isUsablePhoenixWallet,
  phoenixParseTs,
  phoenixNum,
  phoenixHourlyRateFromPoint,
  phoenixQuoteLotsToUsd,
  phoenixTicksToUsd,
  phoenixTpslFromPositionRow,
  phoenixPositionUnrealizedPnl,
  createPhoenixApi,
};

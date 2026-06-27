/**
 * Variational funding settlement clock (browser + Node).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.VariationalFundingClock = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
const BYBIT_LINEAR_TICKERS = 'https://api.bybit.com/v5/market/tickers?category=linear';
const BINANCE_PREMIUM_INDEX = 'https://fapi.binance.com/fapi/v1/premiumIndex';

function cexBaseFromUsdtSymbol(symbol) {
  return String(symbol || '').toUpperCase().replace(/USDT$/i, '');
}

function cexUsdtSymbol(base) {
  return `${String(base || '').toUpperCase()}USDT`;
}

/** Step forward on the infinite grid anchored at `anchorNextMs` with fixed `intervalMs`. */
function nextFundingOnAnchorGrid(anchorNextMs, intervalMs, now = Date.now()) {
  const anchor = Number(anchorNextMs);
  const step = Number(intervalMs);
  if (!Number.isFinite(anchor) || !Number.isFinite(step) || step <= 0) return null;
  let t = anchor;
  const end = Number(now);
  while (t <= end) t += step;
  return t;
}

/** Completed settlement timestamps on the anchor grid strictly after open and <= end. */
function fundingSettlementsOnAnchorGrid(openedAtMs, endAtMs, intervalMs, anchorNextMs) {
  const anchor = Number(anchorNextMs);
  const step = Number(intervalMs);
  const openedAt = Number(openedAtMs);
  const endAt = Number(endAtMs);
  if (!Number.isFinite(anchor) || !Number.isFinite(step) || step <= 0) return [];
  if (!Number.isFinite(openedAt) || !Number.isFinite(endAt) || endAt < openedAt) return [];

  let first = anchor + Math.ceil((openedAt - anchor) / step) * step;
  if (first <= openedAt) first += step;

  const times = [];
  for (let t = first; t <= endAt; t += step) times.push(t);
  return times;
}

function pickFundingClockForBase(base, bybitByBase, binanceByBase) {
  const key = String(base || '').toUpperCase();
  const bybit = bybitByBase?.[key];
  if (bybit?.nextFundingMs) {
    return {
      source: 'bybit',
      nextFundingMs: bybit.nextFundingMs,
      referenceIntervalS: bybit.intervalS ?? null,
      referenceFundingRateInterval: bybit.fundingRateInterval ?? null,
      referenceSymbol: bybit.symbol,
    };
  }
  const binance = binanceByBase?.[key];
  if (binance?.nextFundingMs) {
    return {
      source: 'binance',
      nextFundingMs: binance.nextFundingMs,
      referenceIntervalS: binance.intervalS ?? null,
      referenceFundingRateInterval: binance.fundingRateInterval ?? null,
      referenceSymbol: binance.symbol,
    };
  }
  return null;
}

function attachVariationalFundingClock(listing, clock, fetchedAt = Date.now()) {
  if (!listing || !clock?.nextFundingMs) return listing;
  const out = { ...listing };
  out.fundingNextAtMs = clock.nextFundingMs;
  out.fundingClockSource = clock.source;
  out.fundingClockReference = clock.referenceSymbol || null;
  out.fundingClockFetchedAt = fetchedAt;
  if (clock.referenceIntervalS && out.fundingIntervalS
    && clock.referenceIntervalS !== out.fundingIntervalS) {
    out.fundingClockIntervalMismatch = true;
  }
  if (Number.isFinite(clock.referenceFundingRateInterval)
    && clock.referenceIntervalS
    && clock.referenceIntervalS === out.fundingIntervalS) {
    out.referenceFundingRateInterval = clock.referenceFundingRateInterval;
    out.referenceFundingIntervalS = clock.referenceIntervalS;
  }
  return out;
}

async function fetchBybitFundingClockByBase(fetchFn, timeoutMs = 12000) {
  const byBase = {};
  try {
    const res = await fetchFn(BYBIT_LINEAR_TICKERS, {}, timeoutMs, 'Bybit funding clock');
    const data = await res.json().catch(() => ({}));
    for (const row of data?.result?.list || []) {
      const base = cexBaseFromUsdtSymbol(row.symbol);
      const nextFundingMs = Number(row.nextFundingTime);
      const intervalHours = Number(row.fundingIntervalHour);
      if (!base || !Number.isFinite(nextFundingMs) || nextFundingMs <= 0) continue;
      const fundingRateInterval = parseFloat(row.fundingRate);
      byBase[base] = {
        symbol: row.symbol,
        nextFundingMs,
        intervalS: Number.isFinite(intervalHours) && intervalHours > 0 ? intervalHours * 3600 : null,
        fundingRateInterval: Number.isFinite(fundingRateInterval) ? fundingRateInterval : null,
      };
    }
  } catch {
    // optional enrichment — caller may fall back to Binance
  }
  return byBase;
}

async function fetchBinanceFundingClockByBase(fetchFn, timeoutMs = 12000) {
  const byBase = {};
  try {
    const res = await fetchFn(BINANCE_PREMIUM_INDEX, {}, timeoutMs, 'Binance funding clock');
    const rows = await res.json().catch(() => []);
    const list = Array.isArray(rows) ? rows : [rows];
    for (const row of list) {
      const base = cexBaseFromUsdtSymbol(row.symbol);
      const nextFundingMs = Number(row.nextFundingTime);
      if (!base || !Number.isFinite(nextFundingMs) || nextFundingMs <= 0) continue;
      byBase[base] = {
        symbol: row.symbol,
        nextFundingMs,
        intervalS: null,
      };
    }
  } catch {
    // optional enrichment
  }
  return byBase;
}

/**
 * Resolve live funding settlement clocks for Variational bases (Bybit → Binance waterfall).
 */
async function fetchVariationalFundingClocks(bases, fetchFn, timeoutMs = 12000) {
  const wanted = [...new Set((bases || []).map((b) => String(b || '').toUpperCase()).filter(Boolean))];
  if (!wanted.length) return {};

  const [bybitByBase, binanceByBase] = await Promise.all([
    fetchBybitFundingClockByBase(fetchFn, timeoutMs),
    fetchBinanceFundingClockByBase(fetchFn, timeoutMs),
  ]);

  const clocks = {};
  for (const base of wanted) {
    const clock = pickFundingClockForBase(base, bybitByBase, binanceByBase);
    if (clock) clocks[base] = clock;
  }
  return clocks;
}

return {
  BYBIT_LINEAR_TICKERS,
  BINANCE_PREMIUM_INDEX,
  cexUsdtSymbol,
  nextFundingOnAnchorGrid,
  fundingSettlementsOnAnchorGrid,
  pickFundingClockForBase,
  attachVariationalFundingClock,
  fetchVariationalFundingClocks,
  fetchBybitFundingClockByBase,
  fetchBinanceFundingClockByBase,
};
});

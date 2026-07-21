/**
 * Variational manual hedge helpers — synthetic leg pairing + funding estimates.
 * Public stats API: omni-client-api.prod.ap-northeast-1.variational.io
 */

const VARIATIONAL_STATS_API = 'https://omni-client-api.prod.ap-northeast-1.variational.io/metadata/stats';
const FUNDING_INTERVAL_8H_S = 28800;
const _variationalFundingClock = (typeof require !== 'undefined')
  ? require('./variational-funding-clock')
  : (typeof globalThis !== 'undefined' ? globalThis.VariationalFundingClock : null);
const _closedLegReconstruct = (typeof require !== 'undefined')
  ? require('./closed-leg-reconstruct')
  : (typeof globalThis !== 'undefined' ? globalThis.ClosedLegReconstruct : null);
const _positionPeakWindow = (typeof require !== 'undefined')
  ? require('./position-peak-window')
  : (typeof globalThis !== 'undefined' ? globalThis.PositionPeakWindow : null);
const {
  buildClosedLegsForVenue,
  fundingForClosedLeg,
  CLOSED_SYNTHETIC_CLOSE_CLUSTER_MS,
  CLOSED_ROUND_EPS,
} = _closedLegReconstruct || {};
const { applyPeakToCloseMetrics, computeLegPeakWindow } = _positionPeakWindow || {};
const {
  nextFundingOnAnchorGrid,
  fundingSettlementsOnAnchorGrid,
  attachVariationalFundingClock,
  fetchVariationalFundingClocks,
} = _variationalFundingClock || {};

function toBaseSymbol(ticker) {
  return String(ticker || '')
    .trim()
    .toUpperCase()
    .replace(/-PERP$/i, '')
    .replace(/USDT$/i, '')
    .replace(/USD$/i, '');
}

function venueShortLabel(venue) {
  return {
    hyperliquid: 'HL',
    nado: 'Nado',
    grvt: 'GRVT',
    extended: 'Ext',
    variational: 'Var',
  }[venue] || venue;
}

function netFundingSpread8h(sizeA, rateA, sizeB, rateB) {
  if (rateA == null || rateB == null || !Number.isFinite(rateA) || !Number.isFinite(rateB)) return null;
  const signA = Math.sign(sizeA || 0);
  const signB = Math.sign(sizeB || 0);
  if (!signA || !signB) return null;
  return (-signA * rateA) + (-signB * rateB);
}

function venueRate8hFromSpread(spread, venue) {
  if (!spread || !venue) return null;
  const key = {
    hyperliquid: 'hyperliquid8h',
    nado: 'nado8h',
    grvt: 'grvt8h',
    extended: 'extended8h',
    variational: 'variational8h',
  }[venue];
  const val = key ? spread[key] : null;
  return val != null && Number.isFinite(val) ? val : null;
}

function parseVariationalListing(listing) {
  if (!listing?.ticker) return null;
  const symbol = toBaseSymbol(listing.ticker);
  // Stats API funding_rate is an annualized funding yield (decimal APY).
  // e.g. 0.1095 = 10.95%/yr — matches HL hourly funding × 8760, not per-interval rate.
  const fundingRateAnnual = parseFloat(listing.funding_rate);
  const fundingIntervalS = parseInt(listing.funding_interval_s, 10) || FUNDING_INTERVAL_8H_S;
  const fundingIntervalHours = fundingIntervalS / 3600;
  const intervalsPerYear = Number.isFinite(fundingIntervalHours) && fundingIntervalHours > 0
    ? (365 * 24) / fundingIntervalHours
    : 365 * 3;
  const fundingRateInterval = Number.isFinite(fundingRateAnnual)
    ? fundingRateAnnual / intervalsPerYear
    : null;
  const fundingRate8h = Number.isFinite(fundingRateAnnual)
    ? fundingRateAnnual / (365 * 3)
    : null;
  const markPx = parseFloat(listing.mark_price);
  return {
    venue: 'variational',
    symbol,
    ticker: listing.ticker,
    markPx: Number.isFinite(markPx) ? markPx : null,
    fundingRateAnnual: Number.isFinite(fundingRateAnnual) ? fundingRateAnnual : null,
    fundingRateInterval,
    fundingIntervalS,
    fundingRate8h,
    fundingIntervalHours,
  };
}

function parseVariationalListings(stats) {
  const bySymbol = {};
  for (const listing of stats?.listings || []) {
    const row = parseVariationalListing(listing);
    if (!row?.symbol) continue;
    bySymbol[row.symbol] = row;
  }
  return bySymbol;
}

function variationalFundingPaymentPerInterval(size, markPx, rateInterval) {
  const notional = Math.abs(size) * markPx;
  const side = Math.sign(size);
  if (!side || !notional || !Number.isFinite(rateInterval)) return 0;
  return (side > 0 ? -1 : 1) * notional * rateInterval;
}

/** Signed Variational size — always opposite the tracked exchange leg when live size is known. */
function resolveVariationalSignedSize(hedge, trackedLegOrSize = null) {
  const liveTracked = typeof trackedLegOrSize === 'object'
    ? Number(trackedLegOrSize?.size)
    : Number(trackedLegOrSize);
  if (Number.isFinite(liveTracked) && liveTracked !== 0) {
    const expected = -liveTracked;
    const storedVar = Number(hedge?.variationalSize);
    if (Number.isFinite(storedVar) && storedVar !== 0 && Math.sign(storedVar) === Math.sign(expected)) {
      return storedVar;
    }
    return expected;
  }
  const storedVar = Number(hedge?.variationalSize);
  if (Number.isFinite(storedVar) && storedVar !== 0) return storedVar;
  const storedTracked = Number(hedge?.trackedSize);
  if (Number.isFinite(storedTracked) && storedTracked !== 0) return -storedTracked;
  return 0;
}

/** Funding estimates must hedge against the live tracked leg (correct sign, live magnitude). */
function resolveVariationalFundingSize(hedge, trackedLegOrSize = null) {
  const liveTracked = typeof trackedLegOrSize === 'object'
    ? Number(trackedLegOrSize?.size)
    : Number(trackedLegOrSize);
  if (Number.isFinite(liveTracked) && liveTracked !== 0) return -liveTracked;
  return resolveVariationalSignedSize(hedge, null);
}

function variationalHedgeOpenedAtMs(hedge) {
  const openedAt = Number(hedge?.openedAt ?? hedge?._pairOpenedAtMs);
  return Number.isFinite(openedAt) && openedAt > 0 ? openedAt : null;
}

function variationalFundingOverrideUsd(hedge) {
  if (hedge?.variationalFundingUsdOverride == null) return null;
  const n = Number(hedge.variationalFundingUsdOverride);
  return Number.isFinite(n) ? n : null;
}

function variationalResolveEntryPx(hedge, listing) {
  const direct = Number(hedge?.variationalEntryPx);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const pairLeg = Number(hedge?._pairVarEntryPx);
  if (Number.isFinite(pairLeg) && pairLeg > 0) return pairLeg;
  const snap = Number(hedge?.trackedLastSnapshot?.entryPx);
  if (Number.isFinite(snap) && snap > 0) return snap;
  const mark = variationalLiveMarkPx(listing);
  if (mark != null) return mark;
  return null;
}

function normalizeVariationalListing(listing) {
  if (!listing) return null;
  const out = { ...listing };
  const hours = Number(out.fundingIntervalHours) || (out.fundingIntervalS ? out.fundingIntervalS / 3600 : 8);
  if (out.fundingIntervalS == null) out.fundingIntervalS = hours * 3600;
  out.fundingIntervalHours = hours;
  if (out.fundingRateAnnual == null && out.fundingRate8h != null) {
    out.fundingRateAnnual = out.fundingRate8h * 365 * 3;
  }
  if (out.fundingRateInterval == null) {
    if (out.fundingRateAnnual != null) {
      const intervalsPerYear = (365 * 24) / hours;
      out.fundingRateInterval = out.fundingRateAnnual / intervalsPerYear;
    } else if (out.fundingRate8h != null) {
      out.fundingRateInterval = out.fundingRate8h * (hours / 8);
    }
  }
  if (out.fundingRateInterval != null && out.fundingRate8h != null && hours !== 8
    && Math.abs(out.fundingRateInterval - out.fundingRate8h) < Math.max(Math.abs(out.fundingRate8h) * 1e-9, 1e-15)) {
    out.fundingRateInterval = out.fundingRate8h * (hours / 8);
  }
  if (out.fundingNextAtMs != null) out.fundingNextAtMs = Number(out.fundingNextAtMs);
  return out;
}

/** Native per-interval funding rate + interval metadata (never treat fundingRate8h as native rate). */
function resolveVariationalNativeRate(listing) {
  const normalized = normalizeVariationalListing(listing);
  if (!normalized) return { rateDecimal: null, intervalHours: 8, intervalS: FUNDING_INTERVAL_8H_S };
  const hours = normalized.fundingIntervalHours || 8;
  const intervalS = normalized.fundingIntervalS || hours * 3600;
  let rateDecimal = normalized.fundingRateInterval;
  if (rateDecimal == null && normalized.fundingRateAnnual != null) {
    rateDecimal = normalized.fundingRateAnnual / ((365 * 24) / hours);
  } else if (rateDecimal == null && normalized.fundingRate8h != null) {
    rateDecimal = normalized.fundingRate8h * (hours / 8);
  }
  return {
    rateDecimal: Number.isFinite(rateDecimal) ? rateDecimal : null,
    intervalHours: hours,
    intervalS,
  };
}

/** Payment rate for the listing's native funding interval. Null when unknown (never invent 0). */
function resolveVariationalFundingRateInterval(listing) {
  const rate = resolveVariationalNativeRate(listing).rateDecimal;
  return Number.isFinite(rate) ? rate : null;
}

function variationalListingHasExplicitZeroRate(listing) {
  const normalized = normalizeVariationalListing(listing);
  if (!normalized) return false;
  const candidates = [
    normalized.fundingRateInterval,
    normalized.fundingRateAnnual,
    normalized.fundingRate8h,
  ];
  return candidates.some((v) => v === 0 || v === '0');
}

async function fetchVariationalListingsWithClocks(fetchFn, timeoutMs = 12000) {
  if (!fetchFn || !fetchVariationalFundingClocks) return [];
  const res = await fetchFn(VARIATIONAL_STATS_API, {}, timeoutMs, 'Variational rates');
  const data = await res.json().catch(() => ({}));
  const bySymbol = parseVariationalListings(data);
  const bases = Object.keys(bySymbol);
  const clocks = await fetchVariationalFundingClocks(bases, fetchFn, timeoutMs);
  const fetchedAt = Date.now();
  for (const base of bases) {
    bySymbol[base] = attachVariationalFundingClock
      ? attachVariationalFundingClock(bySymbol[base], clocks[base], fetchedAt)
      : bySymbol[base];
  }
  return Object.values(bySymbol);
}

function variationalHedgeFromPair(pair, hedge = null) {
  const trackedVenue = pair?.venueA || pair?.crossLegA?.venue;
  const varLeg = pair?.crossLegB?.venue === 'variational' ? pair.crossLegB
    : pair?.crossLegA?.venue === 'variational' ? pair.crossLegA
      : null;
  const trackedLeg = pair?.crossLegA?.venue === trackedVenue ? pair.crossLegA : pair?.crossLegB;
  return {
    ...(hedge || {}),
    id: hedge?.id || pair?.variationalHedgeId || null,
    symbol: pair?.symbol || hedge?.symbol,
    trackedVenue: hedge?.trackedVenue || trackedVenue,
    status: hedge?.status || 'open',
    openedAt: hedge?.openedAt || pair?.pairOpenedAtMs || null,
    variationalEntryPx: hedge?.variationalEntryPx ?? varLeg?.entryPx ?? null,
    variationalSize: resolveVariationalSignedSize(hedge, trackedLeg),
    trackedSize: hedge?.trackedSize ?? trackedLeg?.size,
    variationalFundingUsdOverride: hedge?.variationalFundingUsdOverride ?? null,
    trackedLastSnapshot: hedge?.trackedLastSnapshot ?? null,
    _pairOpenedAtMs: pair?.pairOpenedAtMs ?? null,
    _pairVarEntryPx: varLeg?.entryPx ?? null,
  };
}

function variationalFundingIntervalMs(intervalSOrListing) {
  const intervalS = typeof intervalSOrListing === 'number'
    ? intervalSOrListing
    : (intervalSOrListing?.fundingIntervalS || FUNDING_INTERVAL_8H_S);
  return intervalS * 1000;
}

function variationalFundingClockAnchorMs(listing) {
  const anchor = Number(listing?.fundingNextAtMs);
  return Number.isFinite(anchor) && anchor > 0 ? anchor : null;
}

function variationalFundingSettlementsBetween(openedAt, endAt, listing) {
  const anchor = variationalFundingClockAnchorMs(listing);
  const intervalMs = variationalFundingIntervalMs(listing);
  if (!anchor || !fundingSettlementsOnAnchorGrid) return [];
  return fundingSettlementsOnAnchorGrid(openedAt, endAt, intervalMs, anchor);
}

/** Next Variational settlement from the live reference-exchange clock (Bybit → Binance). */
function variationalNextFundingAtMs(_hedge, listing, now = Date.now()) {
  const anchor = variationalFundingClockAnchorMs(listing);
  if (!anchor || !nextFundingOnAnchorGrid) return null;
  return nextFundingOnAnchorGrid(anchor, variationalFundingIntervalMs(listing), now);
}

/** Sample mark/rate/size this many ms before each settlement boundary (e.g. 15:00 → 14:59:50). */
const VARIATIONAL_SETTLEMENT_SAMPLE_LEAD_MS = 10 * 1000;
/** Live listing may freeze a settlement only if observed near the T−10s sample instant. */
const VARIATIONAL_FREEZE_FRESH_MS = 2 * 60 * 1000;
/** Prefer Variational listing samples taken within this window of sampleAt. */
const VARIATIONAL_RATE_SAMPLE_MATCH_MS = 60 * 60 * 1000;
/** Keep this many listing samples per symbol (newest first). */
const VARIATIONAL_RATE_SAMPLE_LIMIT = 96;
/** Keep rate samples for recently closed Var hedges briefly so near-close freezes can catch up. */
const VARIATIONAL_RATE_SAMPLE_SYMBOL_GRACE_MS = 7 * 86400000;
/** Drop closed hedge records (and their settlements) after this age. */
const VARIATIONAL_CLOSED_HEDGE_RETENTION_MS = 90 * 86400000;

function variationalSettlementSampleAtMs(settlementTime) {
  const t = Number(settlementTime);
  if (!Number.isFinite(t)) return null;
  return t - VARIATIONAL_SETTLEMENT_SAMPLE_LEAD_MS;
}

function isVariationalCatchUpFreeze(record, freshMs = VARIATIONAL_FREEZE_FRESH_MS) {
  if (!record?.frozen) return false;
  if (record.freezeSource === 'catchup' || record.catchUp === true) return true;
  if (record.freezeSource === 'sample' || record.freezeSource === 'live' || record.freezeSource === 'reference-history') {
    // Explicit high-quality sources are trusted unless the payload is a corrupt $0 freeze.
    if (Number(record.rate) === 0
      && Number(record.usdc) === 0
      && Number(record.size) !== 0
      && Number(record.markPx) > 0
      && record.explicitZeroRate !== true) {
      return true;
    }
    return false;
  }
  // Null/unknown rates used to be coerced to 0 and frozen as "live" — treat as corrupt.
  if (record.rate == null
    || (Number(record.rate) === 0
      && Number(record.usdc) === 0
      && Number(record.size) !== 0
      && Number(record.markPx) > 0
      && record.explicitZeroRate !== true)) {
    return true;
  }
  const sampleAt = Number(record.sampleAtMs ?? variationalSettlementSampleAtMs(record.time));
  const frozenAt = Number(record.frozenAt ?? record.capturedAt);
  if (!Number.isFinite(sampleAt) || !Number.isFinite(frozenAt)) return true;
  return frozenAt > sampleAt + Number(freshMs || VARIATIONAL_FREEZE_FRESH_MS);
}

function variationalFreezeQuality(record) {
  if (!record?.frozen) return 0;
  // Corrupt / catch-up freezes are always low quality, even if tagged freezeSource=live.
  if (isVariationalCatchUpFreeze(record)) return 1;
  if (record.freezeSource === 'sample') return 4;
  if (record.freezeSource === 'live') return 3;
  if (record.freezeSource === 'reference-history') return 2;
  return 2;
}

function normalizeVariationalRateSamples(samplesBySymbol) {
  const out = {};
  if (!samplesBySymbol || typeof samplesBySymbol !== 'object') return out;
  for (const [rawSym, rows] of Object.entries(samplesBySymbol)) {
    const symbol = toBaseSymbol(rawSym);
    if (!symbol || !Array.isArray(rows)) continue;
    const byAt = new Map();
    for (const row of rows) {
      const atMs = Number(row?.atMs ?? row?.time);
      const markPx = Number(row?.markPx);
      const rate = Number(row?.rate ?? row?.fundingRateInterval);
      if (!Number.isFinite(atMs) || !Number.isFinite(markPx) || !Number.isFinite(rate)) continue;
      const intervalS = Number(row?.intervalS) || FUNDING_INTERVAL_8H_S;
      const prev = byAt.get(atMs);
      if (prev && Number(prev.atMs) === atMs) continue;
      byAt.set(atMs, {
        atMs,
        symbol,
        markPx,
        rate,
        intervalS,
        intervalHours: intervalS / 3600,
        fundingRate8h: Number.isFinite(Number(row?.fundingRate8h))
          ? Number(row.fundingRate8h)
          : rate * (8 / (intervalS / 3600)),
        source: row?.source || 'variational',
      });
    }
    out[symbol] = [...byAt.values()]
      .sort((a, b) => b.atMs - a.atMs)
      .slice(0, VARIATIONAL_RATE_SAMPLE_LIMIT);
  }
  return out;
}

function mergeVariationalRateSamples(existing, incoming) {
  const merged = normalizeVariationalRateSamples(existing);
  const add = normalizeVariationalRateSamples(incoming);
  for (const [symbol, rows] of Object.entries(add)) {
    const byAt = new Map((merged[symbol] || []).map((r) => [r.atMs, r]));
    for (const row of rows) byAt.set(row.atMs, row);
    merged[symbol] = [...byAt.values()]
      .sort((a, b) => b.atMs - a.atMs)
      .slice(0, VARIATIONAL_RATE_SAMPLE_LIMIT);
  }
  return merged;
}

function recordVariationalListingSample(samplesBySymbol, listing, atMs = Date.now(), opts = {}) {
  const normalized = normalizeVariationalListing(listing);
  const symbol = toBaseSymbol(normalized?.symbol || listing?.symbol || listing?.ticker);
  const markPx = variationalLiveMarkPx(listing) || Number(normalized?.markPx);
  const rate = resolveVariationalFundingRateInterval(listing);
  const observedAt = Number(atMs);
  if (!symbol || !Number.isFinite(markPx) || !Number.isFinite(rate) || !Number.isFinite(observedAt)) {
    return samplesBySymbol || {};
  }
  const intervalS = normalized?.fundingIntervalS || FUNDING_INTERVAL_8H_S;
  const sample = {
    atMs: observedAt,
    symbol,
    markPx,
    rate,
    intervalS,
    intervalHours: intervalS / 3600,
    fundingRate8h: normalized?.fundingRate8h ?? null,
    source: opts.source || 'variational',
  };
  return mergeVariationalRateSamples(samplesBySymbol, { [symbol]: [sample] });
}

function recordVariationalListingSamples(samplesBySymbol, listings, atMs = Date.now(), opts = {}) {
  let next = samplesBySymbol || {};
  const list = Array.isArray(listings)
    ? listings
    : (listings && typeof listings === 'object' ? Object.values(listings) : []);
  const allow = opts.symbols instanceof Set
    ? opts.symbols
    : (Array.isArray(opts.symbols) ? new Set(opts.symbols.map(toBaseSymbol)) : null);
  for (const listing of list) {
    const sym = toBaseSymbol(listing?.symbol || listing?.ticker);
    if (allow && sym && !allow.has(sym)) continue;
    next = recordVariationalListingSample(next, listing, atMs, opts);
  }
  if (allow && allow.size) {
    const pruned = {};
    for (const sym of allow) {
      if (next[sym]) pruned[sym] = next[sym];
    }
    next = pruned;
  }
  return next;
}

/**
 * Symbols that need Variational rate samples for settlement freezes.
 * Open / pending_close hedges, plus recently closed (grace) — never live-cross-only symbols.
 */
function variationalRateSampleKeepSymbols(hedges, now = Date.now()) {
  const keep = new Set();
  const t = Number(now) || Date.now();
  for (const h of hedges || []) {
    if (!h?.symbol) continue;
    const sym = toBaseSymbol(h.symbol);
    if (!sym) continue;
    const st = String(h.status || '');
    if (st === 'open' || st === 'pending_close') {
      keep.add(sym);
      continue;
    }
    if (st === 'closed') {
      const closedAt = Number(h.closedAt) || 0;
      if (closedAt > 0 && (t - closedAt) < VARIATIONAL_RATE_SAMPLE_SYMBOL_GRACE_MS) {
        keep.add(sym);
      }
    }
  }
  return keep;
}

/** Drop symbols we no longer trade so localStorage cannot grow to multi‑MB. */
function pruneVariationalRateSamples(samplesBySymbol, keepSymbols) {
  const allow = keepSymbols instanceof Set
    ? keepSymbols
    : new Set((keepSymbols || []).map(toBaseSymbol).filter(Boolean));
  if (!samplesBySymbol || typeof samplesBySymbol !== 'object') return {};
  if (!allow.size) return {};
  // Only normalize kept symbols — never walk the full historical map (can be 500+ symbols).
  const subset = {};
  for (const sym of allow) {
    if (Array.isArray(samplesBySymbol[sym])) subset[sym] = samplesBySymbol[sym];
  }
  return normalizeVariationalRateSamples(subset);
}

/** Remove closed Variational hedges older than retention (default 90d). */
function pruneVariationalHedgesByClosedAge(hedges, opts = {}) {
  const maxAgeMs = Number(opts.maxAgeMs ?? VARIATIONAL_CLOSED_HEDGE_RETENTION_MS);
  const now = Number(opts.now) || Date.now();
  return (Array.isArray(hedges) ? hedges : []).filter((h) => {
    if (String(h?.status || '') !== 'closed') return true;
    const closedAt = Number(h.closedAt) || 0;
    if (!closedAt) return true;
    return (now - closedAt) < maxAgeMs;
  });
}

/** Drop settlement arrays whose hedge id is no longer present. */
function pruneVariationalSettlementsForHedges(settlements, hedges) {
  if (!settlements || typeof settlements !== 'object') return {};
  const ids = new Set((hedges || []).map((h) => h?.id).filter(Boolean));
  const out = {};
  for (const [hedgeId, rows] of Object.entries(settlements)) {
    if (!hedgeId || !ids.has(hedgeId)) continue;
    if (Array.isArray(rows)) out[hedgeId] = rows;
  }
  return out;
}

/** Nearest Variational listing sample to sampleAt within matchMs (default 1h). */
function resolveVariationalListingSampleAt(samplesBySymbol, symbol, sampleAtMs, opts = {}) {
  const key = toBaseSymbol(symbol);
  const target = Number(sampleAtMs);
  const matchMs = Number(opts.matchMs ?? VARIATIONAL_RATE_SAMPLE_MATCH_MS);
  if (!key || !Number.isFinite(target) || !Number.isFinite(matchMs)) return null;
  const rows = normalizeVariationalRateSamples(samplesBySymbol)[key] || [];
  let best = null;
  let bestDist = Infinity;
  for (const row of rows) {
    const dist = Math.abs(Number(row.atMs) - target);
    if (dist > matchMs) continue;
    if (dist < bestDist) {
      best = row;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * Resolve mark/rate for freezing a settlement.
 * Prefer stored Variational samples near T−10s; otherwise live Variational listing only when
 * freshly observed near sampleAt.
 *
 * Do NOT use Bybit/Binance funding history as the payment rate — those exchanges only supply
 * Variational's settlement clock. Their rates often diverge (even sign-flip) from Variational's
 * own funding_rate, and the browser cannot fetch Bybit history (no CORS).
 */
function resolveVariationalFreezeMarketInputs({
  listing,
  symbol,
  sampleAtMs,
  now = Date.now(),
  listingFetchedAt = null,
  rateSamplesBySymbol = null,
} = {}) {
  const sampleAt = Number(sampleAtMs);
  if (!Number.isFinite(sampleAt)) return null;

  const stored = resolveVariationalListingSampleAt(rateSamplesBySymbol, symbol, sampleAt);
  if (stored) {
    return {
      markPx: stored.markPx,
      rate: stored.rate,
      intervalS: stored.intervalS,
      freezeSource: 'sample',
      rateSource: 'variational-sample',
      observedAtMs: stored.atMs,
    };
  }

  const observedAt = Number(listingFetchedAt);
  const liveAt = Number.isFinite(observedAt) ? observedAt : Number(now);
  if (Number.isFinite(liveAt) && Math.abs(liveAt - sampleAt) <= VARIATIONAL_FREEZE_FRESH_MS) {
    const markPx = variationalLiveMarkPx(listing);
    const rate = resolveVariationalFundingRateInterval(listing);
    const normalized = normalizeVariationalListing(listing);
    if (markPx && Number.isFinite(rate)) {
      return {
        markPx,
        rate,
        intervalS: normalized?.fundingIntervalS || FUNDING_INTERVAL_8H_S,
        freezeSource: 'live',
        rateSource: 'variational-live',
        observedAtMs: liveAt,
      };
    }
  }

  return null;
}

/** Settlement times whose T−10s sample window has opened (includes the upcoming boundary). */
function variationalSettlementsReadyForSample(openedAt, endAt, listing, now = Date.now()) {
  const opened = Number(openedAt);
  const end = endAt == null ? null : Number(endAt);
  const at = Number(now);
  if (!Number.isFinite(opened) || !Number.isFinite(at)) return [];
  const lead = VARIATIONAL_SETTLEMENT_SAMPLE_LEAD_MS;
  const gridEnd = Math.max(
    Number.isFinite(end) ? end : at,
    at + lead,
  );
  const times = variationalFundingSettlementsBetween(opened, gridEnd, listing);
  return times.filter((t) => {
    if (!(t > opened)) return false;
    if (Number.isFinite(end) && t > end) return false;
    const sampleAt = variationalSettlementSampleAtMs(t);
    return sampleAt != null && sampleAt <= at;
  });
}

function buildVariationalFundingEvents(hedge, listing, opts = {}) {
  const sinceMs = Number(opts.sinceMs || 0);
  const now = Number(opts.now || Date.now());
  const openedAt = variationalHedgeOpenedAtMs(hedge);
  if (!openedAt) return [];

  const override = variationalFundingOverrideUsd(hedge);
  if (override != null) {
    const endAt = hedge?.status === 'closed' ? Number(hedge?.closedAt || now) : now;
    return [{
      venue: 'variational',
      time: endAt,
      usdc: override,
      symbol: hedge.symbol,
      intervalHours: (listing?.fundingIntervalHours ?? 8),
      fundingEstimated: true,
    }];
  }

  const size = Number.isFinite(Number(opts.variationalSize)) && Number(opts.variationalSize) !== 0
    ? Number(opts.variationalSize)
    : resolveVariationalFundingSize(hedge, opts.trackedLeg ?? opts.trackedSize);
  const entryPx = variationalResolveEntryPx(hedge, listing);
  if (!size || !Number.isFinite(entryPx)) return [];

  const normalized = normalizeVariationalListing(listing);
  const intervalS = normalized?.fundingIntervalS || FUNDING_INTERVAL_8H_S;
  const rate = resolveVariationalFundingRateInterval(listing);
  const markPx = variationalLiveMarkPx(listing) || entryPx;
  if (!Number.isFinite(rate) || !markPx) return [];
  const endAt = hedge?.status === 'closed' ? Number(hedge?.closedAt || now) : now;
  const events = [];
  for (const t of variationalFundingSettlementsBetween(openedAt, endAt, normalized || listing)) {
    if (sinceMs && t < sinceMs) continue;
    events.push({
      venue: 'variational',
      time: t,
      usdc: variationalFundingPaymentPerInterval(size, markPx, rate),
      symbol: hedge.symbol,
      intervalHours: intervalS / 3600,
      fundingEstimated: true,
    });
  }
  return events;
}

function normalizeVariationalSizeHistory(hedge) {
  if (!hedge) return hedge;
  if (!Array.isArray(hedge.sizeHistory)) hedge.sizeHistory = [];
  if (!hedge.sizeHistory.length) {
    const openedAt = variationalHedgeOpenedAtMs(hedge);
    const storedVar = Number(hedge.variationalSize);
    const storedTracked = Number(hedge.trackedSize);
    const size = Number.isFinite(storedVar) && storedVar !== 0
      ? storedVar
      : (Number.isFinite(storedTracked) && storedTracked !== 0 ? -storedTracked : 0);
    if (openedAt && size) hedge.sizeHistory.push({ atMs: openedAt, size });
  }
  return hedge;
}

function recordVariationalSizeChange(hedge, signedSize, atMs) {
  if (!hedge) return hedge;
  normalizeVariationalSizeHistory(hedge);
  const size = Number(signedSize);
  const ts = Number(atMs) || Date.now();
  if (!Number.isFinite(size) || size === 0) return hedge;
  const hist = hedge.sizeHistory;
  const last = hist[hist.length - 1];
  const lastMag = last ? Math.abs(Number(last.size)) : null;
  const newMag = Math.abs(size);
  if (lastMag != null && Math.abs(lastMag - newMag) / Math.max(lastMag, newMag, 1) < 1e-9) return hedge;
  hist.push({ atMs: ts, size });
  return hedge;
}

function resolveVariationalFundingSizeAt(hedge, atMs, trackedLeg = null) {
  if (!hedge) return 0;
  normalizeVariationalSizeHistory(hedge);
  const t = Number(atMs) || 0;
  const hist = [...hedge.sizeHistory].sort((a, b) => Number(a.atMs) - Number(b.atMs));
  if (!hist.length) return resolveVariationalFundingSize(hedge, trackedLeg);
  let effective = null;
  for (const entry of hist) {
    if (Number(entry.atMs) <= t) effective = entry.size;
    else break;
  }
  if (effective == null) return resolveVariationalFundingSize(hedge, trackedLeg);
  return Number(effective) || resolveVariationalFundingSize(hedge, trackedLeg);
}

function freezeVariationalSettlementRecord({
  hedgeId,
  hedge,
  settlementTime,
  listing,
  trackedLeg,
  sizeAtTime,
  now = Date.now(),
  markPx: markPxOverride = null,
  rate: rateOverride = null,
  intervalS: intervalSOverride = null,
  freezeSource = null,
  rateSource = null,
  observedAtMs = null,
}) {
  const normalized = normalizeVariationalListing(listing);
  const sampleAtMs = variationalSettlementSampleAtMs(settlementTime);
  const markPx = Number.isFinite(Number(markPxOverride))
    ? Number(markPxOverride)
    : (variationalLiveMarkPx(listing) || variationalResolveEntryPx(hedge, listing));
  const rate = Number.isFinite(Number(rateOverride))
    ? Number(rateOverride)
    : resolveVariationalFundingRateInterval(listing);
  const size = Number.isFinite(Number(sizeAtTime))
    ? Number(sizeAtTime)
    : resolveVariationalFundingSizeAt(hedge, sampleAtMs ?? settlementTime, trackedLeg);
  const intervalS = Number(intervalSOverride)
    || normalized?.fundingIntervalS
    || FUNDING_INTERVAL_8H_S;
  // Require a real rate. Missing rates used to coerce to 0 and lock $0 freezes forever.
  if (!markPx || !Number.isFinite(rate) || !size) return null;
  if (rate === 0 && !variationalListingHasExplicitZeroRate(listing) && rateOverride == null) return null;
  const frozenAt = Number(now) || Date.now();
  const source = freezeSource
    || (isVariationalCatchUpFreeze({ frozen: true, sampleAtMs, frozenAt }) ? 'catchup' : 'live');
  return {
    hedgeId: String(hedgeId || hedge?.id || ''),
    symbol: hedge?.symbol || null,
    time: settlementTime,
    sampleAtMs,
    markPx,
    rate,
    size,
    intervalS,
    intervalHours: intervalS / 3600,
    usdc: variationalFundingPaymentPerInterval(size, markPx, rate),
    capturedAt: frozenAt,
    frozenAt,
    observedAtMs: Number.isFinite(Number(observedAtMs)) ? Number(observedAtMs) : frozenAt,
    venue: 'variational',
    fundingEstimated: true,
    frozen: true,
    freezeSource: source,
    rateSource: rateSource || source,
    catchUp: source === 'catchup',
    explicitZeroRate: rate === 0,
  };
}

function captureVariationalSettlementsDue(hedge, listing, storedSettlements = [], opts = {}) {
  const now = Number(opts.now || Date.now());
  const hedgeId = hedge?.id;
  const openedAt = variationalHedgeOpenedAtMs(hedge);
  if (!openedAt || !hedgeId) return storedSettlements || [];

  if (variationalFundingOverrideUsd(hedge) != null) return storedSettlements || [];

  const normalized = normalizeVariationalListing(listing);
  // Open hedges: no hard end — include the next boundary once its T−10s window opens.
  // Closed hedges: never sample settlements after close.
  const endAt = hedge?.status === 'closed' ? Number(hedge?.closedAt || now) : null;
  const settlementTimes = variationalSettlementsReadyForSample(
    openedAt,
    endAt,
    normalized || listing,
    now,
  );
  const existingByTime = new Map((storedSettlements || []).map((s) => [Number(s.time), s]));
  const trackedLeg = opts.trackedLeg ?? opts.trackedSize;
  const rateSamplesBySymbol = opts.rateSamplesBySymbol || opts.rateSamples || null;
  const listingFetchedAt = opts.listingFetchedAt ?? opts.fetchedAt ?? now;
  const allowCatchUp = opts.allowCatchUp === true;
  const next = [...(storedSettlements || [])];
  let changed = false;

  for (const t of settlementTimes) {
    const existing = existingByTime.get(t);
    const existingQuality = variationalFreezeQuality(existing);
    // Keep high-quality freezes; rewrite catch-up / missing when we have period-correct inputs.
    if (existingQuality >= 3) continue;

    const sampleAt = variationalSettlementSampleAtMs(t);
    const market = resolveVariationalFreezeMarketInputs({
      listing,
      symbol: hedge?.symbol,
      sampleAtMs: sampleAt,
      now,
      listingFetchedAt,
      rateSamplesBySymbol,
    });

    let freezeInputs = market;
    if (!freezeInputs && allowCatchUp) {
      // Explicit opt-in only — never the default. Stamps today's live rate onto past intervals.
      const markPx = variationalLiveMarkPx(listing) || variationalResolveEntryPx(hedge, listing);
      const rate = resolveVariationalFundingRateInterval(listing);
      if (markPx && Number.isFinite(rate)) {
        freezeInputs = {
          markPx,
          rate,
          intervalS: normalized?.fundingIntervalS || FUNDING_INTERVAL_8H_S,
          freezeSource: 'catchup',
          rateSource: 'variational-live-catchup',
          observedAtMs: now,
        };
      }
    }
    if (!freezeInputs) continue;

    const nextQuality = variationalFreezeQuality({
      frozen: true,
      freezeSource: freezeInputs.freezeSource,
      sampleAtMs: sampleAt,
      frozenAt: now,
      rate: freezeInputs.rate,
      usdc: 1, // non-zero sentinel so quality uses freezeSource, not corrupt-$0 heuristic
      size: 1,
      markPx: freezeInputs.markPx,
      explicitZeroRate: freezeInputs.rate === 0,
    });
    if (existing && nextQuality <= existingQuality) continue;

    const record = freezeVariationalSettlementRecord({
      hedgeId,
      hedge,
      settlementTime: t,
      listing,
      trackedLeg,
      sizeAtTime: resolveVariationalFundingSizeAt(hedge, sampleAt, trackedLeg),
      now,
      markPx: freezeInputs.markPx,
      rate: freezeInputs.rate,
      intervalS: freezeInputs.intervalS,
      freezeSource: freezeInputs.freezeSource,
      rateSource: freezeInputs.rateSource,
      observedAtMs: freezeInputs.observedAtMs,
    });
    if (!record) continue;

    if (existing) {
      const idx = next.findIndex((s) => Number(s.time) === t);
      if (idx >= 0) next[idx] = record;
      else next.push(record);
    } else {
      next.push(record);
    }
    existingByTime.set(t, record);
    changed = true;
  }

  if (!changed) return storedSettlements || [];
  return next.sort((a, b) => Number(b.time) - Number(a.time)).slice(0, 1000);
}

function buildVariationalFundingEventsFrozen(hedge, listing, storedSettlements = [], opts = {}) {
  const sinceMs = Number(opts.sinceMs || 0);
  const now = Number(opts.now || Date.now());
  const openedAt = variationalHedgeOpenedAtMs(hedge);
  if (!openedAt) return [];

  const override = variationalFundingOverrideUsd(hedge);
  if (override != null) {
    const endAt = hedge?.status === 'closed' ? Number(hedge?.closedAt || now) : now;
    return [{
      venue: 'variational',
      time: endAt,
      usdc: override,
      symbol: hedge.symbol,
      intervalHours: (listing?.fundingIntervalHours ?? 8),
      fundingEstimated: true,
    }];
  }

  const normalized = normalizeVariationalListing(listing);
  const trackedLeg = opts.trackedLeg ?? opts.trackedSize;
  const endAt = hedge?.status === 'closed' ? Number(hedge?.closedAt || now) : now;
  const effectiveSince = sinceMs > 0 ? Math.max(openedAt, sinceMs) : openedAt;
  let settlements = storedSettlements || [];
  // Freeze when T−10s is due AND we have period-correct mark/rate (sample/live/reference).
  // Never default-catch-up past intervals with today's live rate.
  if (opts.captureMissing !== false) {
    settlements = captureVariationalSettlementsDue(hedge, listing, settlements, {
      ...opts,
      now,
      allowCatchUp: opts.allowCatchUp === true,
    });
  }
  const settledByTime = new Map((settlements || []).map((s) => [Number(s.time), s]));
  const events = [];
  const lead = VARIATIONAL_SETTLEMENT_SAMPLE_LEAD_MS;
  const gridEnd = Math.max(endAt, now + lead);
  const settlementTimes = variationalFundingSettlementsBetween(openedAt, gridEnd, normalized || listing);

  for (const t of settlementTimes) {
    if (effectiveSince && t < effectiveSince) continue;
    if (Number.isFinite(endAt) && hedge?.status === 'closed' && t > endAt) continue;
    const sampleAt = variationalSettlementSampleAtMs(t);
    if (sampleAt == null) continue;

    // Before T−10s: live preview only (not frozen).
    if (now < sampleAt) {
      const size = resolveVariationalFundingSize(hedge, trackedLeg);
      const markPx = variationalLiveMarkPx(listing) || variationalResolveEntryPx(hedge, listing);
      const rate = resolveVariationalFundingRateInterval(listing);
      if (!size || !markPx || !Number.isFinite(rate)) continue;
      events.push({
        venue: 'variational',
        time: t,
        usdc: variationalFundingPaymentPerInterval(size, markPx, rate),
        symbol: hedge.symbol,
        intervalHours: normalized?.fundingIntervalHours || 8,
        fundingEstimated: true,
        isUnsettled: true,
        rate,
        markPx,
        sampleAtMs: sampleAt,
      });
      continue;
    }

    const stored = settledByTime.get(t);
    if (stored && !isVariationalCatchUpFreeze(stored)) {
      events.push({
        venue: 'variational',
        time: t,
        usdc: stored.usdc,
        symbol: hedge.symbol,
        intervalHours: stored.intervalHours || (stored.intervalS / 3600),
        fundingEstimated: stored.fundingEstimated !== false,
        frozen: true,
        size: stored.size,
        markPx: stored.markPx,
        rate: stored.rate ?? null,
        freezeSource: stored.freezeSource || null,
        rateSource: stored.rateSource || null,
        sampleAtMs: stored.sampleAtMs ?? sampleAt,
        frozenAt: stored.frozenAt ?? stored.capturedAt ?? null,
        isUnsettled: false,
      });
      continue;
    }

    // Due window but not yet accurately frozen — preview with best available inputs.
    // Prefer stored catch-up USD only when nothing better exists (still marked catchUp).
    const market = resolveVariationalFreezeMarketInputs({
      listing,
      symbol: hedge?.symbol,
      sampleAtMs: sampleAt,
      now,
      listingFetchedAt: opts.listingFetchedAt ?? opts.fetchedAt ?? now,
      rateSamplesBySymbol: opts.rateSamplesBySymbol || opts.rateSamples || null,
    });
    if (market) {
      const size = resolveVariationalFundingSizeAt(hedge, sampleAt, trackedLeg);
      if (!size) continue;
      events.push({
        venue: 'variational',
        time: t,
        usdc: variationalFundingPaymentPerInterval(size, market.markPx, market.rate),
        symbol: hedge.symbol,
        intervalHours: (market.intervalS || FUNDING_INTERVAL_8H_S) / 3600,
        fundingEstimated: true,
        isUnsettled: false,
        pendingFreeze: true,
        rate: market.rate,
        markPx: market.markPx,
        freezeSource: market.freezeSource,
        rateSource: market.rateSource,
        sampleAtMs: sampleAt,
      });
      continue;
    }
    if (stored && isVariationalCatchUpFreeze(stored)) {
      const corruptZero = Number(stored.usdc) === 0
        && Number(stored.rate) === 0
        && Number(stored.size) !== 0
        && stored.explicitZeroRate !== true;
      if (!corruptZero) {
        events.push({
          venue: 'variational',
          time: t,
          usdc: stored.usdc,
          symbol: hedge.symbol,
          intervalHours: stored.intervalHours || (stored.intervalS / 3600),
          fundingEstimated: true,
          frozen: true,
          catchUp: true,
          size: stored.size,
          markPx: stored.markPx,
          rate: stored.rate ?? null,
          freezeSource: stored.freezeSource || 'catchup',
          rateSource: stored.rateSource || 'variational-live-catchup',
          sampleAtMs: stored.sampleAtMs ?? sampleAt,
          frozenAt: stored.frozenAt ?? stored.capturedAt ?? null,
          isUnsettled: false,
        });
        continue;
      }
    }

    const size = resolveVariationalFundingSizeAt(hedge, sampleAt, trackedLeg);
    const markPx = variationalLiveMarkPx(listing) || variationalResolveEntryPx(hedge, listing);
    const rate = resolveVariationalFundingRateInterval(listing);
    if (!size || !markPx || !Number.isFinite(rate)) continue;
    events.push({
      venue: 'variational',
      time: t,
      usdc: variationalFundingPaymentPerInterval(size, markPx, rate),
      symbol: hedge.symbol,
      intervalHours: normalized?.fundingIntervalHours || 8,
      fundingEstimated: true,
      isUnsettled: false,
      pendingFreeze: true,
      missingRateSample: true,
      rate,
      markPx,
      sampleAtMs: sampleAt,
    });
  }
  return events;
}

/** Estimated Variational funding at each completed native interval since hedge open. */
function buildVariationalFundingEventsScheduled(hedge, listing, opts = {}) {
  const openedAt = variationalHedgeOpenedAtMs(hedge);
  if (!openedAt) return [];
  const normalized = normalizeVariationalListing(listing);
  const sinceMs = Number(opts.sinceMs) > 0 ? Math.max(openedAt, Number(opts.sinceMs)) : openedAt;
  return buildVariationalFundingEvents(hedge, normalized, { ...opts, sinceMs });
}

/** @deprecated Use buildVariationalFundingEventsScheduled — ignores tracked-exchange timestamps. */
function buildVariationalFundingEventsAligned(hedge, listing, _trackedEvents, opts = {}) {
  return buildVariationalFundingEventsScheduled(hedge, listing, opts);
}

function estimateVariationalFundingUsd(hedge, listing, now = Date.now()) {
  const override = variationalFundingOverrideUsd(hedge);
  if (override != null) return override;
  return buildVariationalFundingEventsScheduled(hedge, listing, { now })
    .reduce((sum, ev) => sum + (ev.usdc || 0), 0);
}

function isPositivePx(px) {
  const n = Number(px);
  return Number.isFinite(n) && n > 0;
}

function variationalLegPnl(size, entryPx, markOrExitPx) {
  if (!size || !isPositivePx(entryPx) || !isPositivePx(markOrExitPx)) return null;
  const abs = Math.abs(size);
  return size > 0 ? (markOrExitPx - entryPx) * abs : (entryPx - markOrExitPx) * abs;
}

function resolveVariationalExitPx(hedge, trackedCloseLeg = null, data = null) {
  if (trackedCloseLeg) {
    const hlClosePx = trackedCloseLegExitPx(trackedCloseLeg, data, hedge);
    const trackedSigned = trackedCloseLeg.side === 'short'
      ? -Math.abs(Number(trackedCloseLeg.size || 0))
      : Math.abs(Number(trackedCloseLeg.size || 0));
    const varSize = resolveVariationalSignedSize(hedge, {
      size: trackedSigned,
      side: trackedCloseLeg.side,
    });
    const derived = deriveVariationalExitPx(hlClosePx, varSize);
    if (derived) return derived;
  }
  return isPositivePx(hedge?.variationalExitPx) ? Number(hedge.variationalExitPx) : null;
}

function trackedCloseLegExitPx(leg, data = null, hedge = null) {
  for (const key of ['avgClosePx', 'exitPx']) {
    const px = Number(leg?.[key]);
    if (isPositivePx(px)) return px;
  }
  if (data && hedge) {
    const fromFills = trackedCloseFillVwap(data, hedge, leg);
    if (fromFills) return fromFills;
  }
  return null;
}

function trackedCloseFillVwap(data, hedge, trackedCloseLeg) {
  const venue = hedge?.trackedVenue;
  const symbol = toBaseSymbol(hedge?.symbol);
  if (!venue || !symbol) return null;
  const fills = (dashboardFillSources(data)[venue] || [])
    .filter((f) => toBaseSymbol(f.symbol) === symbol)
    .filter((f) => !hedge.openedAt || (Number(f.time || 0) >= Number(hedge.openedAt) - 60000));
  const side = trackedCloseLeg?.side || 'long';
  const closing = fills.filter((f) => {
    const raw = String(f.side || '').toUpperCase();
    if (side === 'long') return raw === 'A' || raw === 'S' || raw === 'SELL';
    return raw === 'B' || raw === 'BUY';
  });
  const closeTime = Number(trackedCloseLeg?.closeTime || 0);
  let pool = closing;
  if (closeTime) {
    const near = closing.filter((f) => Math.abs(Number(f.time || 0) - closeTime) <= 6 * 3600000);
    if (near.length) pool = near;
  }
  let notional = 0;
  let size = 0;
  for (const f of pool) {
    const sz = Number(f.sz ?? f.size ?? 0);
    const px = Number(f.px ?? 0);
    if (sz > 0 && px > 0) {
      notional += sz * px;
      size += sz;
    }
  }
  return size > 0 ? notional / size : null;
}

function enrichTrackedCloseLegPx(data, hedge, leg) {
  if (!leg) return leg;
  if (trackedCloseLegExitPx(leg)) return leg;
  const px = trackedCloseFillVwap(data, hedge, leg);
  return px ? { ...leg, avgClosePx: px } : leg;
}

function deriveVariationalExitPx(trackedClosePx, variationalSignedSize) {
  if (!isPositivePx(trackedClosePx)) return null;
  const signed = Number(variationalSignedSize || 0);
  if (!signed) return null;
  if (signed < 0) return trackedClosePx * (1 + VARIATIONAL_VS_TRACKED_CLOSE_SLIPPAGE_PCT);
  return trackedClosePx * (1 - VARIATIONAL_VS_TRACKED_CLOSE_SLIPPAGE_PCT);
}

/** Closed Variational leg PnL = adverse 0.12% of peak position margin in the 24h window before close. */
function variationalCloseSlippageFromPeakMargin(peakMargin) {
  const margin = Number(peakMargin);
  if (!Number.isFinite(margin) || margin <= 0) return null;
  return -margin * VARIATIONAL_VS_TRACKED_CLOSE_SLIPPAGE_PCT;
}

/** Closed Variational leg offsets tracked exchange price PnL; net close slippage ≈ adverse 0.12% only. */
function computeVariationalClosedLegPnl(trackedRealized, slipPnl) {
  const tracked = Number(trackedRealized);
  const slip = Number(slipPnl);
  if (Number.isFinite(tracked) && Number.isFinite(slip)) return -tracked + slip;
  if (Number.isFinite(slip)) return slip;
  return null;
}

function resolveVariationalCloseSlippagePnl(data, hedge, trackedLeg, closeTime, fallbackSize, hlClosePx) {
  if (computeLegPeakWindow && data && hedge) {
    const fillSources = dashboardFillSources(data);
    const venue = trackedLeg?.venue || hedge.trackedVenue;
    const symbol = hedge.symbol || trackedLeg?.symbol;
    const fills = fillSources[venue] || [];
    const openedAt = Number(hedge.openedAt || 0);
    const peak = computeLegPeakWindow(
      fills,
      symbol,
      closeTime,
      openedAt > 0
        ? { lookbackStartMs: openedAt, lookbackMs: Math.max(Number(closeTime) - openedAt, 60 * 1000) }
        : undefined,
    );
    const slip = variationalCloseSlippageFromPeakMargin(peak.peakMargin);
    if (slip != null) return { slip, peakMargin: peak.peakMargin };
  }
  const size = Math.abs(Number(fallbackSize || hedge?.trackedSize || trackedLeg?.size || 0));
  if (isPositivePx(hlClosePx) && size > 0) {
    const margin = size * hlClosePx;
    const slip = variationalCloseSlippageFromPeakMargin(margin);
    if (slip != null) return { slip, peakMargin: margin };
  }
  return null;
}

/** Legacy fallback: adverse 0.12% vs HL close price × hedge size (when peak margin is unavailable). */
function variationalLegCloseSlippagePnl(varSignedSize, hlClosePx, derivedExitPx) {
  if (!varSignedSize || !isPositivePx(hlClosePx) || !isPositivePx(derivedExitPx)) return null;
  return variationalLegPnl(varSignedSize, hlClosePx, derivedExitPx);
}

const VARIATIONAL_CLOSED_PNL_NOTIONAL_MAX = 0.35;

function variationalLegNotional(size, entryPx, markOrExitPx) {
  const abs = Math.abs(Number(size || 0));
  const entry = Number(entryPx);
  const mark = Number(markOrExitPx ?? entryPx);
  if (!abs || !isPositivePx(entry)) return null;
  return abs * (isPositivePx(mark) ? mark : entry);
}

/** Detect classic zero-exit bug (PnL ≈ entry×size) and other notional-sized closes. */
function variationalRealizedPnlLooksImplausible(leg, hedge, exitPx) {
  if (!leg || leg.venue !== 'variational') return false;
  const pnl = Number(leg.realizedPnl);
  if (!Number.isFinite(pnl)) return false;
  const entry = Number(leg.avgEntryPx ?? hedge?.variationalEntryPx);
  const size = Number(leg.size);
  if (!isPositivePx(entry) || !size) return false;
  const notional = variationalLegNotional(size, entry, exitPx ?? leg.avgClosePx);
  if (!notional) return false;
  if (Math.abs(pnl - entry * size) / Math.max(notional, 1) < 0.05) return true;
  if (Math.abs(pnl) > notional * VARIATIONAL_CLOSED_PNL_NOTIONAL_MAX) return true;
  return false;
}

function recomputeVariationalClosedPairTotals(pair) {
  const longPnl = Number.isFinite(Number(pair.longLeg?.realizedPnl)) ? Number(pair.longLeg.realizedPnl) : 0;
  const shortPnl = Number.isFinite(Number(pair.shortLeg?.realizedPnl)) ? Number(pair.shortLeg.realizedPnl) : 0;
  const funding = Number(pair.longLeg?.funding ?? 0) + Number(pair.shortLeg?.funding ?? 0);
  const fees = Number(pair.longLeg?.fees ?? 0) + Number(pair.shortLeg?.fees ?? 0);
  pair.closeSlippage = longPnl + shortPnl;
  pair.funding = funding;
  pair.fees = fees;
  pair.netPnl = pair.closeSlippage + funding - fees;
}

/** Strip or null unsafe Variational leg PnL before storage or display. */
function guardVariationalClosedPair(pair, hedge) {
  if (!pair?.manualVariationalClose) return pair;
  const next = {
    ...pair,
    longLeg: { ...(pair.longLeg || {}) },
    shortLeg: { ...(pair.shortLeg || {}) },
  };
  const exitPx = resolveVariationalExitPx(hedge)
    ?? (() => {
      const varLeg = pair?.longLeg?.venue === 'variational' ? pair.longLeg : pair.shortLeg;
      return isPositivePx(varLeg?.avgClosePx) ? Number(varLeg.avgClosePx) : null;
    })();
  let guarded = false;
  for (const key of ['longLeg', 'shortLeg']) {
    const leg = next[key];
    if (leg?.venue !== 'variational') continue;
    if (!isPositivePx(exitPx) || variationalRealizedPnlLooksImplausible(leg, hedge, exitPx)) {
      if (leg.realizedPnl != null) {
        leg.realizedPnl = null;
        guarded = true;
      }
      if (!isPositivePx(exitPx)) leg.avgClosePx = null;
    }
  }
  if (guarded || !isPositivePx(exitPx)) {
    next.closeLegEstimated = true;
    next.aprUnavailable = true;
    next.sessionApr = null;
    recomputeVariationalClosedPairTotals(next);
  }
  return next;
}

/** Warn when a manual Variational exit price looks implausible vs live mark or implied PnL. */
function validateVariationalExitPrices(hedge, exitPx, listing) {
  const warnings = [];
  const entryPx = Number(hedge?.variationalEntryPx);
  const mark = variationalLiveMarkPx(listing);
  const exit = Number(exitPx);
  if (mark && Number.isFinite(exit) && exit > 0) {
    const ratio = exit / mark;
    if (ratio > 1.5 || ratio < 0.67) {
      warnings.push(`Exit ${exit.toFixed(4)} is far from live Variational mark ${mark.toFixed(4)}`);
    }
  }
  if (Number.isFinite(entryPx) && entryPx > 0 && Number.isFinite(exit) && exit > 0 && mark) {
    const varSize = resolveVariationalSignedSize(hedge, null);
    const pnl = variationalLegPnl(varSize, entryPx, exit);
    const notional = Math.abs(varSize) * mark;
    if (notional > 0 && Math.abs(pnl) > notional * 0.35) {
      warnings.push(`Implied Variational PnL (${pnl.toFixed(0)} USD) exceeds 35% of notional`);
    }
  }
  return warnings;
}

/** Live Variational mark from stats API (not size-tier bid/ask quotes). */
function variationalLiveMarkPx(listing) {
  const live = Number(listing?.markPx);
  return Number.isFinite(live) && live > 0 ? live : null;
}

function buildVariationalSyntheticLeg(hedge, listing, trackedLeg = null) {
  const size = resolveVariationalSignedSize(hedge, trackedLeg);
  const entryPx = Number(hedge?.variationalEntryPx);
  const markPx = variationalLiveMarkPx(listing) || (Number.isFinite(entryPx) && entryPx > 0 ? entryPx : null);
  const hasEntry = Number.isFinite(entryPx) && entryPx > 0;
  const notional = Math.abs(size) * (markPx || entryPx || 0);
  const override = variationalFundingOverrideUsd(hedge);
  const funding = override != null ? override : 0;
  return {
    venue: 'variational',
    size,
    side: size > 0 ? 'long' : 'short',
    entryPx: hasEntry ? entryPx : null,
    markPx,
    notional,
    unrealizedPnl: hasEntry && markPx != null ? variationalLegPnl(size, entryPx, markPx) : null,
    fundingSinceOpen: funding,
    fees: 0,
    liquidationPx: null,
    tpPx: null,
    slPx: null,
    manualHedge: true,
    variationalHedgeId: hedge.id,
    fundingEstimated: true,
  };
}

function normalizeTrackedLeg(leg, venue, symbol) {
  if (!leg) return null;
  const size = Number(leg.size);
  if (!size) return null;
  return {
    venue,
    symbol,
    size,
    side: leg.side || (size > 0 ? 'long' : 'short'),
    entryPx: leg.entryPx ?? leg.entry ?? null,
    markPx: leg.markPx ?? null,
    notional: leg.notional ?? (leg.markPx != null ? Math.abs(size * leg.markPx) : null),
    unrealizedPnl: leg.unrealizedPnl ?? 0,
    fundingSinceOpen: leg.fundingSinceOpen ?? leg.funding ?? leg.cumFundingSinceOpen ?? leg.cumulativeFundingSinceOpen ?? 0,
    fees: leg.fees ?? 0,
    liquidationPx: leg.liquidationPx ?? null,
    tpPx: leg.tpPx ?? null,
    slPx: leg.slPx ?? null,
  };
}

function normalizeTrackedVenue(venue) {
  return String(venue || '').trim().toLowerCase();
}

function variationalHedgeMatchKey(symbol, venue) {
  return `${toBaseSymbol(symbol)}|${normalizeTrackedVenue(venue)}`;
}

function positionFromVenueState(data, venue, symbol) {
  const stateKey = {
    hyperliquid: 'hyperliquid',
    nado: 'nado',
    grvt: 'grvt',
    extended: 'extended',
  }[normalizeTrackedVenue(venue)];
  const positions = data?.[stateKey]?.state?.positions;
  if (!Array.isArray(positions)) return null;
  const base = toBaseSymbol(symbol);
  const pos = positions.find((p) => toBaseSymbol(p.symbol) === base);
  return normalizeTrackedLeg(pos, venue, base);
}

function findTrackedLegInPaired(data, venue, symbol) {
  const base = toBaseSymbol(symbol);
  for (const pair of data?.paired || []) {
    if (toBaseSymbol(pair.symbol) !== base) continue;
    const legs = [
      pair.crossLegA,
      pair.crossLegB,
      pair.hl,
      pair.nado,
      pair.grvt,
      pair.extended,
      pair.longLeg,
      pair.shortLeg,
    ].filter(Boolean);
    for (const leg of legs) {
      if (normalizeTrackedVenue(leg.venue) !== venue) continue;
      const normalized = normalizeTrackedLeg(leg, venue, base);
      if (normalized) return normalized;
    }
  }
  return null;
}

function trackedLegFromSnapshot(hedge) {
  const snap = hedge?.trackedLastSnapshot;
  if (!snap?.size) return null;
  const venue = hedge.trackedVenue;
  const symbol = toBaseSymbol(hedge.symbol);
  return normalizeTrackedLeg({
    size: Math.abs(Number(snap.size)),
    side: snap.side,
    entryPx: snap.entryPx,
    markPx: snap.markPx,
    unrealizedPnl: snap.unrealizedPnl,
    fundingSinceOpen: snap.funding,
    fees: snap.fees,
  }, venue, symbol);
}

function findTrackedLeg(data, hedge) {
  const symbol = toBaseSymbol(hedge.symbol);
  const venue = normalizeTrackedVenue(hedge.trackedVenue);
  const fromState = positionFromVenueState(data, venue, symbol);
  if (fromState) return fromState;
  const unh = (data?.unhedged || []).find(
    (u) => toBaseSymbol(u.symbol) === symbol && normalizeTrackedVenue(u.venue) === venue,
  );
  if (unh) return normalizeTrackedLeg(unh, venue, symbol);
  return findTrackedLegInPaired(data, venue, symbol);
}

function variationalPairHasSizeMismatch(trackedLeg, hedge, varLeg = null) {
  const sizeA = Math.abs(Number(trackedLeg?.size || 0));
  const sizeB = Math.abs(Number(
    varLeg?.size ?? hedge?.variationalSize ?? -Number(hedge?.trackedSize || 0),
  ));
  if (!sizeA || !sizeB) return false;
  const maxSize = Math.max(sizeA, sizeB, 1);
  return Math.abs(sizeA - sizeB) / maxSize > 0.0001;
}

function pinVariationalHedgeSizes(hedge, trackedLeg, varLeg) {
  if (!hedge) return hedge;
  const liveTracked = Number(trackedLeg?.size);
  if (Number.isFinite(liveTracked) && liveTracked !== 0) {
    const storedVar = Number(hedge.variationalSize);
    const storedTracked = Number(hedge.trackedSize);
    if (!Number.isFinite(storedVar) || storedVar === 0) {
      if (Number.isFinite(storedTracked) && storedTracked !== 0) {
        hedge.variationalSize = -storedTracked;
      } else {
        hedge.variationalSize = -liveTracked;
      }
    } else if (Math.sign(storedVar) !== Math.sign(-liveTracked)) {
      hedge.variationalSize = -liveTracked;
    }
    hedge.trackedSize = liveTracked;
    return hedge;
  }
  if (!Number.isFinite(Number(hedge.variationalSize)) && varLeg?.size != null) {
    hedge.variationalSize = Number(varLeg.size);
  } else if (!Number.isFinite(Number(hedge.variationalSize)) && hedge.trackedSize != null) {
    hedge.variationalSize = -Number(hedge.trackedSize);
  }
  return hedge;
}

function resolveVariationalSizesOnEntryEdit(hedge, trackedLeg) {
  if (!hedge) return hedge;
  const liveTracked = Number(trackedLeg?.size);
  const storedTracked = Number(hedge.trackedSize);

  if (Number.isFinite(liveTracked) && liveTracked !== 0) {
    hedge.trackedSize = liveTracked;
    hedge.variationalSize = -liveTracked;
  } else if (Number.isFinite(storedTracked) && storedTracked !== 0) {
    hedge.variationalSize = -storedTracked;
  }
  return hedge;
}

function buildVariationalOpenPair(trackedLeg, hedge, listing, spread) {
  const trackedVenue = hedge.trackedVenue;
  pinVariationalHedgeSizes(hedge, trackedLeg, null);
  const varLeg = buildVariationalSyntheticLeg(hedge, listing, trackedLeg);
  if (Number.isFinite(Number(varLeg.markPx))) hedge.variationalMarkPx = Number(varLeg.markPx);
  if (Number.isFinite(Number(varLeg.unrealizedPnl))) hedge.variationalLastUpnl = Number(varLeg.unrealizedPnl);
  const base = hedge.symbol;
  const pairLabel = `${venueShortLabel(trackedVenue)} + Var`;
  const trackedFunding = trackedLeg.fundingSinceOpen ?? 0;
  const varFunding = varLeg.fundingSinceOpen ?? 0;
  const fundingSinceOpen = trackedFunding + varFunding;
  const combinedUpnl = varLeg.unrealizedPnl == null
    ? null
    : (trackedLeg.unrealizedPnl ?? 0) + varLeg.unrealizedPnl;
  const fees = trackedLeg.fees ?? 0;
  const avgNotional = ((trackedLeg.notional || 0) + (varLeg.notional || 0)) / 2;
  const varRate8h = listing?.fundingRate8h ?? null;
  const trackedRate8h = spread ? venueRate8hFromSpread(spread, trackedVenue) : null;
  const currentSpread8h = netFundingSpread8h(
    trackedLeg.size,
    trackedRate8h,
    varLeg.size,
    varRate8h,
  );
  const sizeA = Math.abs(Number(trackedLeg.size || 0));
  const sizeB = Math.abs(Number(varLeg.size || 0));
  const maxSize = Math.max(sizeA, sizeB, 1);
  const sizeMismatchPct = (Math.abs(sizeA - sizeB) / maxSize) * 100;
  const alerts = [];
  if (sizeA && sizeB && Math.abs(sizeA - sizeB) / maxSize > 0.0001) alerts.push('size_mismatch');

  const crossLegA = { venue: trackedVenue, ...trackedLeg };
  const crossLegB = varLeg;
  const venueA = trackedVenue;
  const venueB = 'variational';
  const openedAt = Number(hedge.openedAt || 0) || null;
  const daysOpen = openedAt ? Math.max(1, (Date.now() - openedAt) / 86400000) : null;

  return {
    symbol: base,
    pairType: `${trackedVenue}_variational`,
    pairLabel,
    variationalHedgeId: hedge.id,
    pairOpenedAtMs: openedAt,
    daysOpen,
    hlSize: trackedVenue === 'hyperliquid' ? trackedLeg.size : null,
    nadoSize: trackedVenue === 'nado' ? trackedLeg.size : null,
    hlEntry: trackedVenue === 'hyperliquid' ? trackedLeg.entryPx : null,
    nadoEntry: trackedVenue === 'nado' ? trackedLeg.entryPx : null,
    hlUpnl: trackedVenue === 'hyperliquid' ? trackedLeg.unrealizedPnl : null,
    nadoUpnl: trackedVenue === 'nado' ? trackedLeg.unrealizedPnl : null,
    legAFundingSinceOpen: trackedFunding,
    legBFundingSinceOpen: varFunding,
    combinedUpnl,
    sizeMismatchPct,
    entrySlippage: null,
    avgNotional,
    hlFundingSinceOpen: trackedVenue === 'hyperliquid' ? trackedFunding : null,
    nadoFundingSinceOpen: trackedVenue === 'nado' ? trackedFunding : null,
    fundingSinceOpen,
    fundingWindow: fundingSinceOpen,
    fees,
    realized: 0,
    netArbPnl: (combinedUpnl ?? 0) + fundingSinceOpen - fees,
    currentSpread8h,
    fundingRate8hA: trackedRate8h,
    fundingRate8hB: varRate8h,
    breakEvenSpread8h: null,
    spreadCoversBreakeven: null,
    alerts,
    crossLegA,
    crossLegB,
    venueA,
    venueB,
  };
}

const HEDGE_CLOSE_MATCH_WINDOW_MS = 7 * 86400000;
const HEDGE_CLOSE_SIZE_MISMATCH_PCT = 5;
const TRACKED_LEG_SNAPSHOT_GRACE_MS = 20 * 60 * 1000;
/** Reopen closed hedge only within this window when finalize ran but the exchange leg still exists (mis-close). */
const CLOSED_HEDGE_REOPEN_MISClose_MS = 30 * 60 * 1000;
const CLOSED_HEDGE_REOPEN_ENTRY_TOL = 0.03;

function trackedLegEntryPx(leg) {
  const px = Number(leg?.entryPx ?? leg?.entry);
  return Number.isFinite(px) && px > 0 ? px : null;
}

function trackedLegSide(leg) {
  if (leg?.side) return leg.side;
  const size = Number(leg?.size);
  if (!Number.isFinite(size) || size === 0) return null;
  return size > 0 ? 'long' : 'short';
}

function closedHedgeLiveLegEntryMatches(hedge, liveLeg) {
  const snapEntry = trackedLegEntryPx(hedge?.trackedLastSnapshot);
  const liveEntry = trackedLegEntryPx(liveLeg);
  if (snapEntry == null || liveEntry == null) return null;
  return Math.abs(liveEntry - snapEntry) / Math.max(snapEntry, liveEntry, 1e-12) <= CLOSED_HEDGE_REOPEN_ENTRY_TOL;
}

function closedHedgeLiveLegSizeMatches(hedge, liveLeg) {
  const snapSize = Math.abs(Number(hedge?.trackedLastSnapshot?.size ?? hedge?.trackedSize ?? 0));
  const liveSize = Math.abs(Number(liveLeg?.size ?? 0));
  if (!snapSize || !liveSize) return null;
  return Math.abs(liveSize - snapSize) / Math.max(snapSize, liveSize, 1) * 100 <= HEDGE_CLOSE_SIZE_MISMATCH_PCT;
}

/** Reopen a closed hedge only for mis-closes or when the live leg is clearly the same round. */
function shouldReopenClosedVariationalHedge(hedge, liveLeg, now = Date.now()) {
  if (!hedge || hedge.status !== 'closed' || !liveLeg) return false;

  const snapSide = hedge?.trackedLastSnapshot?.side;
  const liveSide = trackedLegSide(liveLeg);
  if (snapSide && liveSide && snapSide !== liveSide) return false;

  const closedAt = Number(hedge.closedAt || 0);
  const ageMs = closedAt > 0 ? now - closedAt : Infinity;
  const entryMatch = closedHedgeLiveLegEntryMatches(hedge, liveLeg);
  const sizeMatch = closedHedgeLiveLegSizeMatches(hedge, liveLeg);

  if (entryMatch === true && sizeMatch !== false) return true;

  if (Number.isFinite(closedAt) && ageMs <= CLOSED_HEDGE_REOPEN_MISClose_MS) return true;

  return false;
}
/** Adverse Variational exit vs tracked exchange close (included in close slippage / net PnL). */
const VARIATIONAL_VS_TRACKED_CLOSE_SLIPPAGE_PCT = 0.0012;

const VENUE_STATE_KEY = {
  hyperliquid: 'hyperliquid',
  nado: 'nado',
  grvt: 'grvt',
  extended: 'extended',
};

function venueTrackedLegFetchUncertain(data, venue) {
  const stateKey = VENUE_STATE_KEY[normalizeTrackedVenue(venue)];
  if (!stateKey) return true;
  const state = data?.[stateKey]?.state;
  if (!state) return true;
  if (state.error) return true;
  return !Array.isArray(state.positions);
}

function trackedLegSnapshotGraceActive(hedge, now = Date.now()) {
  const lastLive = Number(hedge?.trackedLastLiveAt || 0);
  return lastLive > 0 && (now - lastLive) <= TRACKED_LEG_SNAPSHOT_GRACE_MS;
}

function shouldUseTrackedLegSnapshotFallback(hedge, data) {
  if (!trackedLegFromSnapshot(hedge)) return false;
  if (venueTrackedLegFetchUncertain(data, hedge.trackedVenue)) {
    return trackedLegSnapshotGraceActive(hedge);
  }
  return false;
}

function markTrackedLegLive(hedge, now = Date.now()) {
  hedge.trackedLastLiveAt = now;
}

function transitionOpenHedgeToPendingClose(hedge, data) {
  const closeLeg = findTrackedCloseLegFromFills(data, hedge);
  hedge.status = 'pending_close';
  hedge.pendingCloseAt = hedge.pendingCloseAt || closeLeg?.closeTime || Date.now();
  // Equity pending adj uses variationalLastUpnl / mark estimate — do not lock −trackedUpnl.
}

function hedgeHasFrozenCloseEvidence(hedge) {
  return Number.isFinite(Number(hedge?.closedFundingUsd))
    && Number(hedge?.closedAt) > 0;
}

function clearVariationalCloseFields(hedge) {
  hedge.closedAt = null;
  hedge.pendingCloseAt = null;
  hedge.variationalExitPx = null;
  hedge.lockedEquityAdjust = null;
  hedge.closedFundingUsd = null;
  hedge.closedTrackedFundingUsd = null;
  hedge.closedVariationalFundingUsd = null;
  hedge.supersededByLiveCross = false;
}

function finalizeVariationalCloseIfReady(hedge, data, listing, findCloseLeg = findTrackedCloseLeg, opts = {}) {
  if (!opts.ignoreLiveTrackedLeg && findTrackedLeg(data, hedge)) return null;
  const trackedCloseLeg = enrichTrackedCloseLegPx(data, hedge, findCloseLeg(data, hedge));
  if (!trackedCloseLeg) return null;
  const exitPx = resolveVariationalExitPx(hedge, trackedCloseLeg, data);
  if (!exitPx) return null;
  hedge.variationalExitPx = exitPx;
  hedge.status = 'closed';
  hedge.closedAt = hedge.closedAt || trackedCloseLeg.closeTime || hedge.pendingCloseAt || Date.now();
  hedge.pendingCloseAt = null;
  hedge.lockedEquityAdjust = null;
  hedge.supersededByLiveCross = false;
  const trackedSigned = trackedCloseLeg.side === 'short'
    ? -Math.abs(Number(hedge.trackedSize || trackedCloseLeg.size || 0))
    : Math.abs(Number(hedge.trackedSize || trackedCloseLeg.size || 0));
  const signedVar = resolveVariationalSignedSize(hedge, {
    size: trackedSigned,
    side: trackedCloseLeg.side,
  });
  freezeVariationalClosedFunding(hedge, listing, data, hedge.closedAt, signedVar);
  return buildVariationalClosedPair(hedge, trackedCloseLeg, listing, data);
}

/** Recover open/pending hedges that already froze close funding (merge zombies / supersede races). */
function recoverFrozenVariationalClosedPair(hedge, data, listing, findCloseLeg = findTrackedCloseLeg) {
  if (!hedge || hedge.status === 'closed') {
    if (hedge?.status === 'closed' && hedgeHasFrozenCloseEvidence(hedge)) {
      return finalizeVariationalCloseIfReady(hedge, data, listing, findCloseLeg, {
        ignoreLiveTrackedLeg: true,
      });
    }
    return null;
  }
  if (!hedgeHasFrozenCloseEvidence(hedge) && !isPositivePx(hedge?.variationalExitPx)) return null;
  hedge.supersededByLiveCross = false;
  return finalizeVariationalCloseIfReady(hedge, data, listing, findCloseLeg, {
    ignoreLiveTrackedLeg: true,
  });
}

function trackedCloseLegMatchesHedgeSize(leg, hedge) {
  const target = Math.abs(Number(hedge?.trackedSize || 0));
  const legSize = Math.abs(Number(leg?.size || 0));
  if (!target || !legSize) return true;
  return Math.abs(legSize - target) / Math.max(target, legSize) * 100 <= HEDGE_CLOSE_SIZE_MISMATCH_PCT;
}

function trackedCloseLegIsTrusted(leg, hedge) {
  if (!leg) return false;
  if (leg.fromExchangeClosingFills) return Number.isFinite(leg.realizedPnl);
  if (leg.reconstructedFromClosingFills) return false;
  if (!trackedCloseLegMatchesHedgeSize(leg, hedge)) return false;
  return Number.isFinite(leg.realizedPnl);
}

function hedgeTrackedPositionSide(hedge, hintLeg) {
  if (hintLeg?.side) return hintLeg.side;
  if (hedge?.trackedLastSnapshot?.side) return hedge.trackedLastSnapshot.side;
  const varSize = Number(hedge?.variationalSize ?? 0);
  if (varSize < 0) return 'long';
  if (varSize > 0) return 'short';
  return 'long';
}

function fillIsClosingSide(fill, positionSide) {
  const raw = String(fill?.side || '').toUpperCase();
  const isSell = raw === 'A' || raw === 'S' || raw === 'SELL' || raw === 'ASK';
  const isBuy = raw === 'B' || raw === 'BUY' || raw === 'BID';
  if (positionSide === 'short') return isBuy;
  return isSell;
}

function sumVenueSymbolFeesSince(data, hedge, closeTime) {
  const venue = hedge?.trackedVenue;
  const symbol = toBaseSymbol(hedge?.symbol);
  const since = Number(hedge?.openedAt || 0);
  const end = Number(closeTime || Date.now());
  if (!venue || !symbol) return 0;
  let sum = 0;
  for (const fill of dashboardFillSources(data)[venue] || []) {
    if (toBaseSymbol(fill.symbol) !== symbol) continue;
    const time = Number(fill.time || 0);
    if (since && time < since) continue;
    if (end && time > end) continue;
    sum += Math.abs(Number(fill.fee || 0));
  }
  return sum;
}

function findTrackedCloseLegFromClosingFills(data, hedge, hintLeg = null) {
  const venue = hedge?.trackedVenue;
  const symbol = toBaseSymbol(hedge?.symbol);
  const targetSize = Math.abs(Number(hedge?.trackedSize || 0));
  if (!venue || !symbol || !targetSize) return null;

  const positionSide = hedgeTrackedPositionSide(hedge, hintLeg);
  const openedAt = Number(hedge.openedAt || 0);
  const targetClose = Number(
    hedge.closedAt || hedge.pendingCloseAt || hintLeg?.closeTime || 0,
  );
  const clusterMs = CLOSED_SYNTHETIC_CLOSE_CLUSTER_MS || 3600000;
  const roundEps = CLOSED_ROUND_EPS || 1e-8;

  const fills = (dashboardFillSources(data)[venue] || [])
    .filter((f) => toBaseSymbol(f.symbol) === symbol)
    .filter((f) => !openedAt || Number(f.time || 0) >= openedAt - 60000)
    .sort((a, b) => Number(a.time || 0) - Number(b.time || 0));

  const closingFills = fills.filter((f) => {
    const sz = Number(f.sz ?? f.size ?? 0);
    return sz > 0 && fillIsClosingSide(f, positionSide);
  });
  if (!closingFills.length) return null;

  const clusters = [];
  let cluster = null;
  for (const fill of closingFills) {
    const time = Number(fill.time || 0);
    if (!cluster || time - cluster.closeTime > clusterMs) {
      cluster = {
        fills: [],
        closeTime: time,
        size: 0,
        realizedPnl: 0,
      };
      clusters.push(cluster);
    }
    const sz = Number(fill.sz ?? fill.size ?? 0);
    cluster.fills.push(fill);
    cluster.closeTime = Math.max(cluster.closeTime, time);
    cluster.size += sz;
    cluster.realizedPnl += Number(fill.closedPnl ?? fill.realizedPnl ?? 0);
  }

  let best = null;
  let bestScore = Infinity;
  for (const candidate of clusters) {
    if (Math.abs(candidate.size - targetSize) / targetSize * 100 > HEDGE_CLOSE_SIZE_MISMATCH_PCT) continue;
    const hasClosedPnl = candidate.fills.some(
      (f) => Math.abs(Number(f.closedPnl ?? f.realizedPnl ?? 0)) > roundEps,
    );
    if (!hasClosedPnl) continue;
    let score = 0;
    if (targetClose) score += Math.abs(candidate.closeTime - targetClose);
    else score += Math.max(0, Date.now() - candidate.closeTime);
    score += Math.abs(candidate.size - targetSize) * 100;
    if (openedAt && candidate.closeTime < openedAt) score += 86400000 * 100;
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  if (!best) return null;

  const closeTime = best.closeTime;
  let closeNotional = 0;
  let closeSize = 0;
  for (const fill of best.fills) {
    const sz = Number(fill.sz ?? fill.size ?? 0);
    const px = Number(fill.px ?? 0);
    if (sz > 0 && px > 0) {
      closeNotional += sz * px;
      closeSize += sz;
    }
  }

  const paymentSources = dashboardPaymentSources(data);
  const funding = fundingForClosedLeg
    ? fundingForClosedLeg(venue, symbol, openedAt || closeTime, closeTime, paymentSources)
    : Number(hintLeg?.funding ?? 0);

  return {
    venue,
    symbol: hedge.symbol,
    side: positionSide,
    size: targetSize,
    realizedPnl: best.realizedPnl,
    fees: sumVenueSymbolFeesSince(data, hedge, closeTime),
    funding,
    closeTime,
    openTime: openedAt || null,
    avgClosePx: closeSize > 0 ? closeNotional / closeSize : null,
    avgEntryPx: hedge.trackedLastSnapshot?.entryPx
      ?? hedge.trackedEntryPx
      ?? hintLeg?.avgEntryPx
      ?? hintLeg?.entryPx
      ?? null,
    closeLegEstimated: false,
    fromExchangeClosingFills: true,
    reconstructedFromClosingFills: false,
  };
}

function dashboardFillSources(data) {
  return {
    hyperliquid: data?.hyperliquid?.fills?.fills || [],
    nado: data?.nado?.matches?.matches || [],
    grvt: data?.grvt?.fills?.fills || [],
    extended: data?.extended?.fills?.fills || [],
  };
}

function dashboardPaymentSources(data) {
  return {
    hyperliquid: data?.hyperliquid?.funding?.payments || [],
    nado: data?.nado?.funding?.payments || [],
    grvt: data?.grvt?.funding?.payments || [],
    extended: data?.extended?.funding?.payments || [],
  };
}

function scoreTrackedCloseLegCandidate(leg, hedge, targetClose) {
  const openedAt = Number(hedge.openedAt || 0);
  let score = 0;
  if (targetClose && leg.closeTime) score += Math.abs(leg.closeTime - targetClose);
  const targetSize = Math.abs(Number(hedge.trackedSize || 0));
  const legSize = Math.abs(Number(leg.size || 0));
  if (targetSize && legSize) score += Math.abs(legSize - targetSize) * 100;
  if (openedAt && leg.openTimeKnown && leg.openTime && leg.openTime < openedAt) score += 86400000 * 100;
  if (!Number.isFinite(leg.realizedPnl)) score += 86400000 * 10;
  if (leg.reconstructedFromClosingFills) score += 86400000 * 50;
  return score;
}

function findTrackedCloseLegFromFills(data, hedge) {
  if (!buildClosedLegsForVenue) return null;
  const venue = hedge.trackedVenue;
  const symbol = toBaseSymbol(hedge.symbol);
  const openedAt = Number(hedge.openedAt || 0);
  const targetClose = Number(hedge.closedAt || hedge.pendingCloseAt || 0);
  const fillSources = dashboardFillSources(data);
  const paymentSources = dashboardPaymentSources(data);
  const legs = buildClosedLegsForVenue(venue, fillSources[venue] || [], paymentSources);
  const candidates = legs.filter((leg) => {
    if (toBaseSymbol(leg.symbol) !== symbol) return false;
    if (openedAt && leg.closeTime && leg.closeTime < openedAt) return false;
    if (targetClose && leg.closeTime && Math.abs(leg.closeTime - targetClose) > HEDGE_CLOSE_MATCH_WINDOW_MS) return false;
    return true;
  });
  if (!candidates.length) return null;
  candidates.sort((a, b) => scoreTrackedCloseLegCandidate(a, hedge, targetClose) - scoreTrackedCloseLegCandidate(b, hedge, targetClose));
  const best = candidates[0];
  return {
    ...best,
    closeLegEstimated: Boolean(best.reconstructedFromClosingFills || !Number.isFinite(best.realizedPnl)),
  };
}

function findTrackedCloseLegFromPools(data, hedge) {
  const symbol = hedge.symbol;
  const venue = hedge.trackedVenue;
  const openedAt = Number(hedge.openedAt || 0);
  const targetClose = Number(hedge.closedAt || hedge.pendingCloseAt || 0);
  const pools = [
    ...(data?.closedPairRefreshes || []),
    ...(data?.closedPairs || []),
  ];
  let best = null;
  let bestScore = Infinity;
  for (const pair of pools) {
    if (pair.symbol !== symbol && toBaseSymbol(pair.symbol) !== toBaseSymbol(symbol)) continue;
    const closeTime = Number(pair.closeTime || 0);
    if (openedAt && closeTime && closeTime < openedAt) continue;
    const pairOpen = Number(pair.openTime || 0);
    if (openedAt && pairOpen && pairOpen < openedAt - 3600000) continue;
    if (hedge.id && pair.variationalHedgeId && pair.variationalHedgeId !== hedge.id) continue;
    for (const leg of [pair.longLeg, pair.shortLeg]) {
      if (leg?.venue !== venue) continue;
      const legClose = Number(leg.closeTime || closeTime || 0);
      if (openedAt && legClose && legClose < openedAt) continue;
      const legOpen = Number(leg.openTime || pairOpen || 0);
      if (openedAt && legOpen && legOpen < openedAt - 3600000) continue;
      const candidate = { ...leg, closeTime: legClose || closeTime };
      const score = scoreTrackedCloseLegCandidate(candidate, hedge, targetClose);
      if (score < bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
  }
  return best;
}

function estimateTrackedCloseRealized(hedge, trackedCloseLeg, listing) {
  const snap = hedge?.trackedLastSnapshot;
  const size = Math.abs(Number(hedge.trackedSize || trackedCloseLeg?.size || 0));
  const side = trackedCloseLeg?.side || snap?.side || 'long';
  const entry = Number(
    trackedCloseLeg?.avgEntryPx
    ?? trackedCloseLeg?.entryPx
    ?? snap?.entryPx
    ?? hedge?.trackedEntryPx,
  );
  const trustedClosePx = trackedCloseLeg?.reconstructedFromClosingFills
    ? null
    : (trackedCloseLeg?.avgClosePx ?? trackedCloseLeg?.exitPx);
  const exit = Number(
    trustedClosePx
    ?? snap?.markPx
    ?? listing?.markPx,
  );
  if (!size || !Number.isFinite(entry) || entry <= 0 || !Number.isFinite(exit) || exit <= 0) return null;
  const signed = side === 'short' ? -size : size;
  return variationalLegPnl(signed, entry, exit);
}

function applyVariationalPeakToClosePair(pair, hedge, listing, data, trackedCloseLegRef = null) {
  if (!pair || !applyPeakToCloseMetrics) return pair;
  const fillSources = dashboardFillSources(data || {});
  const paymentSources = dashboardPaymentSources(data || {});
  const hedgeCloseRealized = resolveHedgeTrackedCloseRealized(hedge, trackedCloseLegRef, data);
  let next = applyPeakToCloseMetrics(pair, fillSources, paymentSources, {
    fundingForClosedLeg,
    ...(Number(hedge?.openedAt) > 0 ? {
      lookbackStartMs: Number(hedge.openedAt),
      lookbackMs: Math.max(
        Number(pair.closeTime || hedge.closedAt || Date.now()) - Number(hedge.openedAt),
        60 * 1000,
      ),
    } : {}),
  });
  const varLeg = next.longLeg?.venue === 'variational' ? next.longLeg : next.shortLeg;
  const trackedLeg = next.longLeg?.venue === 'variational' ? next.shortLeg : next.longLeg;
  if (!varLeg || !trackedLeg) return next;

  const hedgeTrackedSize = Math.abs(Number(hedge?.trackedSize || 0));
  const peakTrackedRealized = Number.isFinite(Number(trackedLeg.realizedPnl))
    ? Number(trackedLeg.realizedPnl)
    : null;
  const windowStart = Number(next.statsSinceMs || next.openTime || hedge?.openedAt || 0);
  const closeTime = Number(next.closeTime || hedge?.closedAt || Date.now());
  const trackedSigned = trackedLeg.side === 'short' ? -hedgeTrackedSize : hedgeTrackedSize;
  const signedVar = resolveVariationalSignedSize(hedge, {
    size: trackedSigned,
    side: trackedLeg.side,
  });
  const hlClosePx = trackedCloseLegExitPx(trackedCloseLegRef, data, hedge)
    ?? trackedCloseLegExitPx(trackedLeg, data, hedge);
  const derivedExit = deriveVariationalExitPx(hlClosePx, signedVar);

  if (hedgeTrackedSize > 0) trackedLeg.size = hedgeTrackedSize;
  if (hedgeCloseRealized != null && Number.isFinite(hedgeCloseRealized)) {
    trackedLeg.realizedPnl = hedgeCloseRealized;
  }

  varLeg.size = Math.abs(Number(signedVar)) || hedgeTrackedSize;
  if (derivedExit) {
    varLeg.avgClosePx = derivedExit;
    varLeg.variationalExitDerived = true;
  }
  const varSlipResolved = resolveVariationalCloseSlippagePnl(
    data,
    hedge,
    trackedLeg,
    closeTime,
    hedgeTrackedSize,
    hlClosePx,
  );
  const slipPnl = varSlipResolved?.slip ?? (
    isPositivePx(hlClosePx) && isPositivePx(varLeg.avgClosePx)
      ? variationalLegCloseSlippagePnl(signedVar, hlClosePx, varLeg.avgClosePx)
      : null
  );
  const trackedForVarPnl = hedgeCloseRealized != null && Number.isFinite(hedgeCloseRealized)
    ? hedgeCloseRealized
    : peakTrackedRealized;
  const varRealized = computeVariationalClosedLegPnl(trackedForVarPnl, slipPnl);
  if (varRealized != null && Number.isFinite(varRealized)) {
    varLeg.realizedPnl = varRealized;
    if (varSlipResolved?.peakMargin > 0) next.variationalPeakMargin = varSlipResolved.peakMargin;
  }

  const hedgeForFunding = {
    ...hedge,
    status: 'closed',
    closedAt: closeTime,
    variationalSize: signedVar,
    trackedSize: hedgeTrackedSize,
  };
  const fundingBreakdown = computeVariationalClosedPairFunding(
    hedgeForFunding,
    listing,
    paymentSources,
    closeTime,
    signedVar,
  );
  trackedLeg.funding = fundingBreakdown.tracked;
  varLeg.funding = fundingBreakdown.variational;

  const hedgeSlip = Number.isFinite(Number(trackedLeg.realizedPnl)) ? Number(trackedLeg.realizedPnl) : 0;
  const varSlip = Number.isFinite(Number(varLeg.realizedPnl)) ? Number(varLeg.realizedPnl) : 0;
  next.closeSlippage = hedgeSlip + varSlip;
  next.funding = fundingBreakdown.total;
  next.fundingSinceMs = fundingBreakdown.sinceMs;
  next.fees = Number(next.longLeg?.fees ?? 0) + Number(next.shortLeg?.fees ?? 0);
  const equitySlip = Number.isFinite(Number(slipPnl))
    ? Number(slipPnl)
    : (Number.isFinite(hedgeSlip) && Number.isFinite(varSlip) ? hedgeSlip + varSlip : 0);
  next.variationalEquityPnl = equitySlip + Number(fundingBreakdown.variational || 0);
  next.variationalCloseSlippagePnl = Number.isFinite(Number(slipPnl)) ? Number(slipPnl) : null;
  if (peakTrackedRealized != null && Number.isFinite(peakTrackedRealized)) {
    next.peakRealizedPnl = peakTrackedRealized;
  }
  next.netPnl = next.closeSlippage + next.funding - next.fees;
  next.peakMetricsApplied = true;
  if (windowStart > 0 && closeTime > windowStart) {
    next.sessionDays = Math.max((closeTime - windowStart) / 86400000, 1 / 24);
  }
  return next;
}

function resolveHedgeTrackedCloseRealized(hedge, trackedCloseLegRef, data) {
  const closeLeg = trackedCloseLegRef
    ? enrichTrackedCloseLegPx(data, hedge, trackedCloseLegRef)
    : null;
  if (closeLeg?.realizedPnl != null && Number.isFinite(Number(closeLeg.realizedPnl))) {
    return Number(closeLeg.realizedPnl);
  }
  return null;
}

function computeVariationalClosedPairFunding(hedge, listing, paymentSources, closeTime, signedVar) {
  const fundingStart = variationalHedgeOpenedAtMs(hedge);
  const end = Number(closeTime || hedge?.closedAt || Date.now());
  if (!fundingStart || !end || end < fundingStart) {
    return { tracked: 0, variational: 0, total: 0, sinceMs: fundingStart || 0 };
  }
  if (hedge?.closedFundingUsd != null && Number.isFinite(Number(hedge.closedFundingUsd))) {
    const tracked = Number.isFinite(Number(hedge.closedTrackedFundingUsd))
      ? Number(hedge.closedTrackedFundingUsd)
      : 0;
    const variational = Number.isFinite(Number(hedge.closedVariationalFundingUsd))
      ? Number(hedge.closedVariationalFundingUsd)
      : Number(hedge.closedFundingUsd) - tracked;
    return { tracked, variational, total: Number(hedge.closedFundingUsd), sinceMs: fundingStart };
  }
  const venue = hedge?.trackedVenue;
  const symbol = hedge?.symbol;
  const tracked = venue && fundingForClosedLeg
    ? fundingForClosedLeg(venue, symbol, fundingStart, end, paymentSources)
    : 0;
  const hedgeForFunding = {
    ...hedge,
    status: 'closed',
    closedAt: end,
    variationalSize: signedVar,
    trackedSize: Math.abs(Number(hedge?.trackedSize || 0)),
  };
  const variational = buildVariationalFundingEventsScheduled(hedgeForFunding, listing, {
    sinceMs: fundingStart,
    now: end,
    variationalSize: signedVar,
  }).reduce((sum, ev) => sum + (ev.usdc || 0), 0);
  return { tracked, variational, total: tracked + variational, sinceMs: fundingStart };
}

function freezeVariationalClosedFunding(hedge, listing, data, closeTime, signedVar) {
  const paymentSources = dashboardPaymentSources(data || {});
  const breakdown = computeVariationalClosedPairFunding(
    hedge,
    listing,
    paymentSources,
    closeTime,
    signedVar,
  );
  hedge.closedFundingUsd = breakdown.total;
  hedge.closedTrackedFundingUsd = breakdown.tracked;
  hedge.closedVariationalFundingUsd = breakdown.variational;
  return breakdown;
}

function findTrackedCloseLeg(data, hedge) {
  const fromFills = findTrackedCloseLegFromFills(data, hedge);
  if (trackedCloseLegIsTrusted(fromFills, hedge)) return fromFills;
  const fromPools = findTrackedCloseLegFromPools(data, hedge);
  if (fromPools && trackedCloseLegIsTrusted(fromPools, hedge)) {
    return { ...fromPools, closeLegEstimated: false };
  }
  const fromClosingFills = findTrackedCloseLegFromClosingFills(data, hedge, fromFills || fromPools);
  if (fromClosingFills) return fromClosingFills;
  const fallback = fromFills || fromPools;
  if (fallback) {
    const estimated = estimateTrackedCloseRealized(hedge, fallback, data?._variationalListingBySymbol?.[hedge.symbol]);
    if (estimated != null && Number.isFinite(estimated)) {
      return {
        ...fallback,
        size: Math.abs(Number(hedge.trackedSize || fallback.size || 0)),
        side: fallback.side,
        realizedPnl: estimated,
        closeLegEstimated: true,
      };
    }
  }
  const snap = hedge.trackedLastSnapshot;
  if (!snap) return null;
  return {
    venue: hedge.trackedVenue,
    symbol: hedge.symbol,
    side: snap.side,
    size: Math.abs(Number(snap.size || hedge.trackedSize || 0)),
    realizedPnl: null,
    funding: Number(snap.funding ?? 0),
    fees: Number(snap.fees ?? 0),
    closeTime: hedge.pendingCloseAt || hedge.closedAt || Date.now(),
    avgEntryPx: snap.entryPx ?? null,
    avgClosePx: snap.markPx ?? null,
    reconstructedFromClosingFills: false,
    closeLegEstimated: true,
  };
}

function buildVariationalClosedPair(hedge, trackedCloseLeg, listing, data = null) {
  const closeLeg = enrichTrackedCloseLegPx(data, hedge, trackedCloseLeg);
  const exitPx = resolveVariationalExitPx(hedge, closeLeg, data);
  const exitDerivedFromTracked = Boolean(
    closeLeg && deriveVariationalExitPx(
      trackedCloseLegExitPx(closeLeg, data, hedge),
      resolveVariationalSignedSize(hedge, {
        size: closeLeg.side === 'short'
          ? -Math.abs(Number(closeLeg.size || 0))
          : Math.abs(Number(closeLeg.size || 0)),
        side: closeLeg.side,
      }),
    ),
  );
  const entryPx = Number(hedge.variationalEntryPx);
  const hedgeTrackedSize = Math.abs(Number(hedge.trackedSize || 0));
  const trackedSize = hedgeTrackedSize || Math.abs(Number(closeLeg.size || 0));
  const trackedSigned = closeLeg.side === 'short' ? -trackedSize : trackedSize;
  const varSize = resolveVariationalSignedSize(hedge, { size: trackedSigned, side: closeLeg.side });
  const hlClosePx = trackedCloseLegExitPx(closeLeg, data, hedge);
  const closeTime = Number(closeLeg.closeTime || hedge.closedAt || Date.now());
  const varSlipResolved = resolveVariationalCloseSlippagePnl(
    data,
    hedge,
    closeLeg,
    closeTime,
    trackedSize,
    hlClosePx,
  );
  let trackedRealized = null;
  if (closeLeg.realizedPnl != null && Number.isFinite(Number(closeLeg.realizedPnl))) {
    trackedRealized = Number(closeLeg.realizedPnl);
  }
  if (!Number.isFinite(trackedRealized)) {
    trackedRealized = estimateTrackedCloseRealized(hedge, closeLeg, listing);
  }
  if (!Number.isFinite(trackedRealized)) trackedRealized = null;
  const slipPnl = varSlipResolved?.slip ?? (
    hlClosePx && exitPx
      ? variationalLegCloseSlippagePnl(varSize, hlClosePx, exitPx)
      : null
  );
  const varRealized = computeVariationalClosedLegPnl(trackedRealized, slipPnl);
  const closeLegEstimated = Boolean(
    closeLeg.closeLegEstimated
    || (closeLeg.reconstructedFromClosingFills && !closeLeg.fromExchangeClosingFills)
    || (!closeLeg.fromExchangeClosingFills && !trackedCloseLegMatchesHedgeSize(closeLeg, hedge))
    || !Number.isFinite(trackedRealized),
  );
  const paymentSources = dashboardPaymentSources(data || {});
  const fundingBreakdown = computeVariationalClosedPairFunding(
    hedge,
    listing,
    paymentSources,
    closeTime,
    varSize,
  );
  const varFunding = fundingBreakdown.variational;
  const trackedFunding = fundingBreakdown.tracked;
  const varLeg = {
    venue: 'variational',
    symbol: hedge.symbol,
    side: varSize > 0 ? 'long' : 'short',
    size: Math.abs(varSize),
    realizedPnl: Number.isFinite(varRealized) ? varRealized : null,
    funding: varFunding,
    fees: 0,
    avgEntryPx: entryPx,
    avgClosePx: exitPx,
    closeTime,
    fundingEstimated: true,
    variationalExitDerived: exitDerivedFromTracked,
  };
  const trackedLeg = {
    venue: hedge.trackedVenue,
    symbol: hedge.symbol,
    side: closeLeg.side,
    size: trackedSize,
    realizedPnl: trackedRealized,
    funding: trackedFunding,
    fees: Number(closeLeg.fees ?? 0),
    avgEntryPx: closeLeg.avgEntryPx ?? closeLeg.entryPx ?? hedge.trackedLastSnapshot?.entryPx ?? null,
    avgClosePx: closeLeg.avgClosePx ?? closeLeg.exitPx ?? null,
    closeTime,
    closeLegEstimated,
  };
  const longLeg = trackedLeg.side === 'long' ? trackedLeg : varLeg;
  const shortLeg = trackedLeg.side === 'short' ? trackedLeg : varLeg;
  const closeSlippage = (Number.isFinite(longLeg.realizedPnl) ? longLeg.realizedPnl : 0)
    + (Number.isFinite(shortLeg.realizedPnl) ? shortLeg.realizedPnl : 0);
  const funding = fundingBreakdown.total;
  const fees = longLeg.fees + shortLeg.fees;
  const pairCloseTime = Math.max(longLeg.closeTime || 0, shortLeg.closeTime || 0);
  const openTime = hedge.openedAt || closeLeg.openTime || null;
  const pair = {
    symbol: hedge.symbol,
    pairLabel: `${venueShortLabel(hedge.trackedVenue)} + Var`,
    pairType: `${hedge.trackedVenue}_variational`,
    variationalHedgeId: hedge.id,
    openTime,
    closeTime: pairCloseTime,
    size: Math.min(longLeg.size || 0, shortLeg.size || 0),
    sizeMismatchPct: 0,
    longLeg,
    shortLeg,
    closeSlippage,
    funding,
    fundingSinceMs: fundingBreakdown.sinceMs,
    fees,
    netPnl: closeSlippage + funding - fees,
    manualVariationalClose: true,
    closeLegEstimated,
    aprUnavailable: closeLegEstimated,
    sessionApr: null,
    variationalCloseSlippagePnl: Number.isFinite(Number(slipPnl)) ? Number(slipPnl) : null,
    // Off-exchange equity only: adverse Var-vs-HL close slip + Variational funding.
    variationalEquityPnl: (Number.isFinite(Number(slipPnl)) ? Number(slipPnl) : 0)
      + Number(fundingBreakdown.variational || 0),
  };
  if (varSlipResolved?.peakMargin > 0) pair.variationalPeakMargin = varSlipResolved.peakMargin;
  if (!closeLegEstimated && openTime && pairCloseTime > openTime) {
    pair.sessionDays = (pairCloseTime - openTime) / 86400000;
  }
  if (exitPx) hedge.variationalExitPx = exitPx;
  const peaked = data ? applyVariationalPeakToClosePair(pair, hedge, listing, data, closeLeg) : pair;
  return guardVariationalClosedPair(peaked, hedge);
}

function snapshotFromUnhedgedLeg(unhedgedLeg) {
  const trackedSize = Number(unhedgedLeg?.size);
  if (!Number.isFinite(trackedSize) || trackedSize === 0) return null;
  const side = unhedgedLeg.side || (trackedSize > 0 ? 'long' : 'short');
  return {
    size: trackedSize,
    side,
    entryPx: unhedgedLeg.entryPx ?? unhedgedLeg.entry ?? null,
    markPx: unhedgedLeg.markPx ?? null,
    unrealizedPnl: unhedgedLeg.unrealizedPnl ?? null,
    funding: unhedgedLeg.funding ?? unhedgedLeg.fundingSinceOpen ?? 0,
    fees: unhedgedLeg.fees ?? 0,
  };
}

function createHedgeFromUnhedged(unhedgedLeg, entryPx) {
  const trackedSize = Number(unhedgedLeg.size);
  const varEntry = Number(entryPx);
  const now = Date.now();
  return {
    id: `var-${now}-${Math.random().toString(36).slice(2, 8)}`,
    symbol: toBaseSymbol(unhedgedLeg.symbol),
    trackedVenue: normalizeTrackedVenue(unhedgedLeg.venue),
    trackedSize,
    variationalSize: -trackedSize,
    variationalEntryPx: Number.isFinite(varEntry) && varEntry > 0 ? varEntry : null,
    variationalExitPx: null,
    openedAt: now,
    updatedAt: now,
    closedAt: null,
    pendingCloseAt: null,
    status: 'open',
    variationalFundingUsdOverride: null,
    trackedLastSnapshot: snapshotFromUnhedgedLeg(unhedgedLeg),
    trackedLastLiveAt: now,
  };
}

const LIVE_CROSS_VENUES = ['hyperliquid', 'nado', 'grvt', 'extended'];

const CROSS_PAIR_SPECS = [
  { venues: ['hyperliquid', 'nado'], pairType: 'hl_nado', pairLabel: 'HL + Nado' },
  { venues: ['hyperliquid', 'grvt'], pairType: 'hl_grvt', pairLabel: 'HL + GRVT' },
  { venues: ['hyperliquid', 'extended'], pairType: 'hl_extended', pairLabel: 'HL + Extended' },
  { venues: ['nado', 'extended'], pairType: 'nado_extended', pairLabel: 'Nado + Extended' },
  { venues: ['nado', 'grvt'], pairType: 'nado_grvt', pairLabel: 'Nado + GRVT' },
  { venues: ['grvt', 'extended'], pairType: 'grvt_extended', pairLabel: 'GRVT + Extended' },
];

function pairExchangeLegs(pair) {
  return [
    pair?.crossLegA,
    pair?.crossLegB,
    pair?.hl,
    pair?.nado,
    pair?.grvt,
    pair?.extended,
    pair?.longLeg,
    pair?.shortLeg,
  ].filter(Boolean);
}

function perpLegsAreOpposed(legA, legB) {
  const sideA = legA?.side;
  const sideB = legB?.side;
  return Boolean(sideA && sideB && sideA !== sideB);
}

function pairTypeSpecForVenues(venueA, venueB) {
  const spec = CROSS_PAIR_SPECS.find(
    (s) => (s.venues[0] === venueA && s.venues[1] === venueB)
      || (s.venues[0] === venueB && s.venues[1] === venueA),
  );
  return spec || {
    pairType: `${venueA}_${venueB}`,
    pairLabel: `${venueShortLabel(venueA)} + ${venueShortLabel(venueB)}`,
  };
}

function findLiveCrossPairForHedge(paired, hedge) {
  const base = toBaseSymbol(hedge.symbol);
  const trackedVenue = hedge.trackedVenue;
  for (const pair of paired || []) {
    if (isVariationalPair(pair)) continue;
    if (toBaseSymbol(pair.symbol) !== base) continue;
    const venues = pairExchangeLegs(pair).map((leg) => leg.venue).filter(Boolean);
    if (!venues.includes(trackedVenue)) continue;
    if (venues.some((venue) => venue !== trackedVenue && venue !== 'variational')) return pair;
  }
  return null;
}

function findOpposingLegInState(data, hedge, trackedLeg) {
  const base = toBaseSymbol(hedge.symbol);
  for (const venue of LIVE_CROSS_VENUES) {
    if (venue === hedge.trackedVenue) continue;
    const leg = positionFromVenueState(data, venue, base);
    if (!leg || !perpLegsAreOpposed(trackedLeg, leg)) continue;
    return leg;
  }
  return null;
}

function buildMinimalCrossPair(trackedLeg, opposingLeg) {
  const spec = pairTypeSpecForVenues(trackedLeg.venue, opposingLeg.venue);
  const upnlA = trackedLeg.unrealizedPnl ?? 0;
  const upnlB = opposingLeg.unrealizedPnl ?? 0;
  const fundingA = trackedLeg.fundingSinceOpen ?? 0;
  const fundingB = opposingLeg.fundingSinceOpen ?? 0;
  const sizeA = Math.abs(trackedLeg.size);
  const sizeB = Math.abs(opposingLeg.size);
  const maxSize = Math.max(sizeA, sizeB, 1);
  const base = toBaseSymbol(trackedLeg.symbol || opposingLeg.symbol);
  const alerts = [];
  if (Math.abs(sizeA - sizeB) > 1e-9) alerts.push('size_mismatch');
  return {
    symbol: base,
    pairType: spec.pairType,
    pairLabel: spec.pairLabel,
    combinedUpnl: upnlA + upnlB,
    sizeMismatchPct: (Math.abs(sizeA - sizeB) / maxSize) * 100,
    avgNotional: ((trackedLeg.notional || 0) + (opposingLeg.notional || 0)) / 2,
    fundingSinceOpen: fundingA + fundingB,
    legAFundingSinceOpen: fundingA,
    legBFundingSinceOpen: fundingB,
    crossLegA: { venue: trackedLeg.venue, ...trackedLeg },
    crossLegB: { venue: opposingLeg.venue, ...opposingLeg },
    alerts,
  };
}

function liveCrossSupersedesVariational(data, paired, hedge, trackedLeg) {
  const existingCross = findLiveCrossPairForHedge(paired, hedge);
  if (existingCross) return { existingCross, opposingLeg: null };
  const opposingLeg = findOpposingLegInState(data, hedge, trackedLeg);
  return { existingCross: null, opposingLeg };
}

function isVariationalPair(pair) {
  return Boolean(pair?.variationalHedgeId)
    || String(pair?.pairType || '').endsWith('_variational');
}

function stripVariationalPairs(paired) {
  return (paired || []).filter((p) => !isVariationalPair(p));
}

function dedupeActiveVariationalHedges(hedges) {
  const closed = [];
  const activeByKey = new Map();
  for (const hedge of hedges || []) {
    if (hedge?.status === 'closed') {
      closed.push(hedge);
      continue;
    }
    const key = variationalHedgeMatchKey(hedge.symbol, hedge.trackedVenue);
    const prev = activeByKey.get(key);
    if (!prev || Number(hedge.openedAt || 0) >= Number(prev.openedAt || 0)) {
      activeByKey.set(key, hedge);
    }
  }
  return [...activeByKey.values(), ...closed];
}

function applyVariationalHedges(data, hedges, variationalBySymbol, opts = {}) {
  const resolveTrackedCloseLeg = opts.findTrackedCloseLeg || findTrackedCloseLeg;
  const nextHedges = dedupeActiveVariationalHedges((hedges || []).map((h) => ({ ...h })));
  const paired = stripVariationalPairs(data.paired);
  let unhedged = [...(data.unhedged || [])];
  const newClosedPairs = [];
  const pendingClose = [];
  const spreadByBase = Object.fromEntries((data.rateSpread || []).map((r) => [r.symbol, r]));

  for (const hedge of nextHedges) {
    if (hedge.status !== 'closed') continue;
    const liveTrackedLeg = findTrackedLeg(data, hedge);
    if (!liveTrackedLeg) continue;
    // A live HL+GRVT (etc.) cross is a new round — do not reopen / wipe a finished Variational close.
    const { existingCross, opposingLeg } = liveCrossSupersedesVariational(data, paired, hedge, liveTrackedLeg);
    if (existingCross || opposingLeg) continue;
    if (!shouldReopenClosedVariationalHedge(hedge, liveTrackedLeg)) continue;
    hedge.status = 'open';
    clearVariationalCloseFields(hedge);
    hedge.updatedAt = Date.now();
  }

  const closedPairAlreadyCached = (hedge) => (data.closedPairs || []).some((p) => (
    p?.variationalHedgeId === hedge.id
    || (p?.manualVariationalClose
      && toBaseSymbol(p?.symbol) === toBaseSymbol(hedge.symbol)
      && Math.abs(Number(p?.closeTime || 0) - Number(hedge.closedAt || 0)) <= 120000)
  ));

  for (const hedge of nextHedges) {
    if (hedge.status !== 'closed') continue;
    if (closedPairAlreadyCached(hedge)) continue;
    const listing = variationalBySymbol?.[hedge.symbol] || null;
    const recovered = recoverFrozenVariationalClosedPair(hedge, data, listing, resolveTrackedCloseLeg);
    if (recovered) newClosedPairs.push(recovered);
  }

  const hedgeKeys = new Set(
    nextHedges
      .filter((h) => (h.status === 'open' || h.status === 'pending_close') && !h.supersededByLiveCross)
      .map((h) => variationalHedgeMatchKey(h.symbol, h.trackedVenue)),
  );
  unhedged = unhedged.filter((u) => !hedgeKeys.has(variationalHedgeMatchKey(u.symbol, u.venue)));

  for (const hedge of nextHedges) {
    if (hedge.status === 'closed') continue;
    const listing = variationalBySymbol?.[hedge.symbol] || null;
    const spread = spreadByBase[hedge.symbol] || null;
    const liveTrackedLeg = findTrackedLeg(data, hedge);

    if (hedge.status === 'open') {
      if (hedgeHasFrozenCloseEvidence(hedge) || isPositivePx(hedge.variationalExitPx)) {
        const recovered = recoverFrozenVariationalClosedPair(hedge, data, listing, resolveTrackedCloseLeg);
        if (recovered) {
          newClosedPairs.push(recovered);
          continue;
        }
      }
      if (liveTrackedLeg) {
        const { existingCross, opposingLeg } = liveCrossSupersedesVariational(data, paired, hedge, liveTrackedLeg);
        if (existingCross || opposingLeg) {
          hedge.supersededByLiveCross = true;
          if (!existingCross && opposingLeg) {
            paired.push(buildMinimalCrossPair(liveTrackedLeg, opposingLeg));
          }
          continue;
        }
        markTrackedLegLive(hedge);
        hedge.trackedLastSnapshot = {
          size: liveTrackedLeg.size,
          side: liveTrackedLeg.side,
          entryPx: liveTrackedLeg.entryPx,
          unrealizedPnl: liveTrackedLeg.unrealizedPnl,
          funding: liveTrackedLeg.fundingSinceOpen,
          fees: liveTrackedLeg.fees,
        };
        const pair = buildVariationalOpenPair(liveTrackedLeg, hedge, listing, spread);
        pinVariationalHedgeSizes(hedge, liveTrackedLeg, pair.crossLegB);
        paired.push(pair);
      } else if (shouldUseTrackedLegSnapshotFallback(hedge, data)
        || (trackedLegFromSnapshot(hedge) && trackedLegSnapshotGraceActive(hedge))) {
        const snapLeg = trackedLegFromSnapshot(hedge);
        const pair = buildVariationalOpenPair(snapLeg, hedge, listing, spread);
        pinVariationalHedgeSizes(hedge, snapLeg, pair.crossLegB);
        paired.push(pair);
      } else {
        hedge.supersededByLiveCross = false;
        transitionOpenHedgeToPendingClose(hedge, data);
        const closedPair = finalizeVariationalCloseIfReady(hedge, data, listing, resolveTrackedCloseLeg);
        if (closedPair) {
          newClosedPairs.push(closedPair);
        } else {
          pendingClose.push(hedge);
        }
      }
      continue;
    }

    if (hedge.status === 'pending_close') {
      if (hedgeHasFrozenCloseEvidence(hedge) || isPositivePx(hedge.variationalExitPx)) {
        const recovered = recoverFrozenVariationalClosedPair(hedge, data, listing, resolveTrackedCloseLeg);
        if (recovered) {
          newClosedPairs.push(recovered);
          continue;
        }
      }
      if (liveTrackedLeg) {
        const { existingCross, opposingLeg } = liveCrossSupersedesVariational(data, paired, hedge, liveTrackedLeg);
        if (existingCross || opposingLeg) {
          hedge.supersededByLiveCross = true;
          hedge.status = 'open';
          clearVariationalCloseFields(hedge);
          if (!existingCross && opposingLeg) {
            paired.push(buildMinimalCrossPair(liveTrackedLeg, opposingLeg));
          }
          continue;
        }
        hedge.status = 'open';
        clearVariationalCloseFields(hedge);
        hedge.trackedLastSnapshot = {
          size: liveTrackedLeg.size,
          side: liveTrackedLeg.side,
          entryPx: liveTrackedLeg.entryPx,
          unrealizedPnl: liveTrackedLeg.unrealizedPnl,
          funding: liveTrackedLeg.fundingSinceOpen,
          fees: liveTrackedLeg.fees,
        };
        const reopenedPair = buildVariationalOpenPair(liveTrackedLeg, hedge, listing, spread);
        pinVariationalHedgeSizes(hedge, liveTrackedLeg, reopenedPair.crossLegB);
        paired.push(reopenedPair);
        continue;
      }
      hedge.supersededByLiveCross = false;
      const closedPair = finalizeVariationalCloseIfReady(hedge, data, listing, resolveTrackedCloseLeg);
      if (closedPair) {
        newClosedPairs.push(closedPair);
      } else {
        pendingClose.push(hedge);
      }
    }
  }

  return {
    paired,
    unhedged,
    hedges: nextHedges,
    newClosedPairs,
    pendingClose,
  };
}

const variationalHedgeExports = {
  VARIATIONAL_STATS_API,
  FUNDING_INTERVAL_8H_S,
  toBaseSymbol,
  venueShortLabel,
  parseVariationalListing,
  parseVariationalListings,
  estimateVariationalFundingUsd,
  buildVariationalFundingEvents,
  buildVariationalFundingEventsScheduled,
  buildVariationalFundingEventsFrozen,
  buildVariationalFundingEventsAligned,
  VARIATIONAL_SETTLEMENT_SAMPLE_LEAD_MS,
  VARIATIONAL_FREEZE_FRESH_MS,
  VARIATIONAL_RATE_SAMPLE_MATCH_MS,
  VARIATIONAL_RATE_SAMPLE_LIMIT,
  VARIATIONAL_RATE_SAMPLE_SYMBOL_GRACE_MS,
  VARIATIONAL_CLOSED_HEDGE_RETENTION_MS,
  variationalSettlementSampleAtMs,
  variationalSettlementsReadyForSample,
  isVariationalCatchUpFreeze,
  variationalFreezeQuality,
  normalizeVariationalRateSamples,
  mergeVariationalRateSamples,
  recordVariationalListingSample,
  recordVariationalListingSamples,
  variationalRateSampleKeepSymbols,
  pruneVariationalRateSamples,
  pruneVariationalHedgesByClosedAge,
  pruneVariationalSettlementsForHedges,
  resolveVariationalListingSampleAt,
  resolveVariationalFreezeMarketInputs,
  normalizeVariationalSizeHistory,
  recordVariationalSizeChange,
  resolveVariationalFundingSizeAt,
  freezeVariationalSettlementRecord,
  captureVariationalSettlementsDue,
  normalizeVariationalListing,
  resolveVariationalNativeRate,
  resolveVariationalFundingRateInterval,
  variationalResolveEntryPx,
  variationalHedgeFromPair,
  variationalHedgeOpenedAtMs,
  variationalNextFundingAtMs,
  variationalFundingSettlementsBetween,
  variationalFundingClockAnchorMs,
  fetchVariationalListingsWithClocks,
  variationalFundingPaymentPerInterval,
  resolveVariationalSignedSize,
  resolveVariationalFundingSize,
  buildVariationalSyntheticLeg,
  variationalPairHasSizeMismatch,
  pinVariationalHedgeSizes,
  resolveVariationalSizesOnEntryEdit,
  buildVariationalOpenPair,
  buildVariationalClosedPair,
  createHedgeFromUnhedged,
  snapshotFromUnhedgedLeg,
  normalizeTrackedVenue,
  applyVariationalHedges,
  stripVariationalPairs,
  dedupeActiveVariationalHedges,
  isVariationalPair,
  findLiveCrossPairForHedge,
  findOpposingLegInState,
  liveCrossSupersedesVariational,
  buildMinimalCrossPair,
  variationalHedgeMatchKey,
  findTrackedLeg,
  findTrackedLegInPaired,
  trackedLegFromSnapshot,
  findTrackedCloseLeg,
  isPositivePx,
  resolveVariationalExitPx,
  deriveVariationalExitPx,
  trackedCloseLegExitPx,
  trackedCloseFillVwap,
  enrichTrackedCloseLegPx,
  VARIATIONAL_VS_TRACKED_CLOSE_SLIPPAGE_PCT,
  computeVariationalClosedPairFunding,
  freezeVariationalClosedFunding,
  finalizeVariationalCloseIfReady,
  recoverFrozenVariationalClosedPair,
  hedgeHasFrozenCloseEvidence,
  clearVariationalCloseFields,
  variationalRealizedPnlLooksImplausible,
  guardVariationalClosedPair,
  recomputeVariationalClosedPairTotals,
  variationalLegPnl,
  variationalLegCloseSlippagePnl,
  variationalCloseSlippageFromPeakMargin,
  computeVariationalClosedLegPnl,
  resolveVariationalCloseSlippagePnl,
  validateVariationalExitPrices,
  variationalLiveMarkPx,
  netFundingSpread8h,
  venueRate8hFromSpread,
  TRACKED_LEG_SNAPSHOT_GRACE_MS,
  CLOSED_HEDGE_REOPEN_MISClose_MS,
  venueTrackedLegFetchUncertain,
  shouldUseTrackedLegSnapshotFallback,
  shouldReopenClosedVariationalHedge,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = variationalHedgeExports;
}
if (typeof window !== 'undefined') {
  window.VariationalHedge = variationalHedgeExports;
}

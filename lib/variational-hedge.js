/**
 * Variational manual hedge helpers — synthetic leg pairing + funding estimates.
 * Public stats API: omni-client-api.prod.ap-northeast-1.variational.io
 */

const VARIATIONAL_STATS_API = 'https://omni-client-api.prod.ap-northeast-1.variational.io/metadata/stats';
const FUNDING_INTERVAL_8H_S = 28800;

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

function variationalHedgeOpenedAtMs(hedge) {
  const openedAt = Number(hedge?.openedAt);
  return Number.isFinite(openedAt) && openedAt > 0 ? openedAt : null;
}

/** Next Variational funding boundary after `now` (first payout at openedAt + interval). */
function variationalNextFundingAtMs(hedge, listing, now = Date.now()) {
  const openedAt = variationalHedgeOpenedAtMs(hedge);
  if (!openedAt) return null;
  const intervalMs = (listing?.fundingIntervalS || FUNDING_INTERVAL_8H_S) * 1000;
  const elapsed = Number(now) - openedAt;
  if (elapsed < intervalMs) return openedAt + intervalMs;
  const completed = Math.floor(elapsed / intervalMs);
  return openedAt + (completed + 1) * intervalMs;
}

function buildVariationalFundingEvents(hedge, listing, opts = {}) {
  const sinceMs = Number(opts.sinceMs || 0);
  const now = Number(opts.now || Date.now());
  const openedAt = variationalHedgeOpenedAtMs(hedge);
  if (!openedAt) return [];

  const override = Number(hedge?.variationalFundingUsdOverride);
  if (Number.isFinite(override)) {
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

  const size = Number(hedge?.variationalSize ?? -Number(hedge?.trackedSize));
  const entryPx = Number(hedge?.variationalEntryPx);
  if (!size || !Number.isFinite(entryPx)) return [];

  const intervalS = listing?.fundingIntervalS || FUNDING_INTERVAL_8H_S;
  const intervalMs = intervalS * 1000;
  const rate = listing?.fundingRateInterval ?? 0;
  const markPx = listing?.markPx || entryPx;
  const avgPx = (entryPx + markPx) / 2;
  const endAt = hedge?.status === 'closed' ? Number(hedge?.closedAt || now) : now;
  const events = [];
  for (let t = openedAt + intervalMs; t <= endAt; t += intervalMs) {
    if (sinceMs && t < sinceMs) continue;
    events.push({
      venue: 'variational',
      time: t,
      usdc: variationalFundingPaymentPerInterval(size, avgPx, rate),
      symbol: hedge.symbol,
      intervalHours: intervalS / 3600,
      fundingEstimated: true,
    });
  }
  return events;
}

/** Estimated Variational funding at each completed native interval since hedge open. */
function buildVariationalFundingEventsScheduled(hedge, listing, opts = {}) {
  const openedAt = variationalHedgeOpenedAtMs(hedge);
  if (!openedAt) return [];
  return buildVariationalFundingEvents(hedge, listing, { ...opts, sinceMs: openedAt });
}

/** @deprecated Use buildVariationalFundingEventsScheduled — ignores tracked-exchange timestamps. */
function buildVariationalFundingEventsAligned(hedge, listing, _trackedEvents, opts = {}) {
  return buildVariationalFundingEventsScheduled(hedge, listing, opts);
}

function estimateVariationalFundingUsd(hedge, listing, now = Date.now()) {
  const override = Number(hedge?.variationalFundingUsdOverride);
  if (Number.isFinite(override)) return override;
  return buildVariationalFundingEventsScheduled(hedge, listing, { now })
    .reduce((sum, ev) => sum + (ev.usdc || 0), 0);
}

function variationalLegPnl(size, entryPx, markOrExitPx) {
  if (!Number.isFinite(entryPx) || !Number.isFinite(markOrExitPx) || !size) return 0;
  const abs = Math.abs(size);
  return size > 0 ? (markOrExitPx - entryPx) * abs : (entryPx - markOrExitPx) * abs;
}

/** Live Variational mark from stats API (not size-tier bid/ask quotes). */
function variationalLiveMarkPx(listing) {
  const live = Number(listing?.markPx);
  return Number.isFinite(live) && live > 0 ? live : null;
}

function buildVariationalSyntheticLeg(hedge, listing) {
  const size = Number(hedge?.variationalSize ?? -Number(hedge?.trackedSize));
  const entryPx = Number(hedge?.variationalEntryPx);
  const markPx = variationalLiveMarkPx(listing) || (Number.isFinite(entryPx) && entryPx > 0 ? entryPx : null);
  const hasEntry = Number.isFinite(entryPx) && entryPx > 0;
  const notional = Math.abs(size) * (markPx || entryPx || 0);
  const override = Number(hedge?.variationalFundingUsdOverride);
  const funding = Number.isFinite(override) ? override : 0;
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

function positionFromVenueState(data, venue, symbol) {
  const stateKey = {
    hyperliquid: 'hyperliquid',
    nado: 'nado',
    grvt: 'grvt',
    extended: 'extended',
  }[venue];
  const positions = data?.[stateKey]?.state?.positions;
  if (!Array.isArray(positions)) return null;
  const pos = positions.find((p) => {
    const base = toBaseSymbol(p.symbol);
    return base === symbol;
  });
  return normalizeTrackedLeg(pos, venue, symbol);
}

function findTrackedLeg(data, hedge) {
  const symbol = hedge.symbol;
  const venue = hedge.trackedVenue;
  const fromState = positionFromVenueState(data, venue, symbol);
  if (fromState) return fromState;
  const unh = (data?.unhedged || []).find((u) => u.symbol === symbol && u.venue === venue);
  if (unh) return normalizeTrackedLeg(unh, venue, symbol);
  return null;
}

function buildVariationalOpenPair(trackedLeg, hedge, listing, spread) {
  const trackedVenue = hedge.trackedVenue;
  const varLeg = buildVariationalSyntheticLeg(hedge, listing);
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

function findTrackedCloseLeg(data, hedge) {
  const symbol = hedge.symbol;
  const venue = hedge.trackedVenue;
  const openedAt = Number(hedge.openedAt || 0);
  const pools = [
    ...(data?.closedPairRefreshes || []),
    ...(data?.closedPairs || []),
  ];
  for (const pair of pools) {
    if (pair.symbol !== symbol) continue;
    const closeTime = Number(pair.closeTime || 0);
    if (openedAt && closeTime && closeTime < openedAt) continue;
    for (const leg of [pair.longLeg, pair.shortLeg]) {
      if (leg?.venue === venue) return { ...leg };
    }
  }
  const snap = hedge.trackedLastSnapshot;
  if (!snap) return null;
  return {
    venue,
    symbol,
    side: snap.side,
    size: Math.abs(Number(snap.size || hedge.trackedSize || 0)),
    realizedPnl: null,
    funding: Number(snap.funding ?? 0),
    fees: Number(snap.fees ?? 0),
    closeTime: hedge.pendingCloseAt || Date.now(),
    avgEntryPx: snap.entryPx ?? null,
    avgClosePx: snap.markPx ?? null,
    reconstructedFromClosingFills: false,
    closeLegEstimated: true,
  };
}

function buildVariationalClosedPair(hedge, trackedCloseLeg, listing) {
  const exitPx = Number(hedge.variationalExitPx);
  const entryPx = Number(hedge.variationalEntryPx);
  const varSize = Number(hedge.variationalSize ?? -Number(hedge.trackedSize));
  const varRealized = variationalLegPnl(varSize, entryPx, exitPx);
  const varFunding = estimateVariationalFundingUsd(
    { ...hedge, status: 'closed', closedAt: hedge.closedAt || Date.now() },
    listing,
    hedge.closedAt || Date.now(),
  );
  const varLeg = {
    venue: 'variational',
    symbol: hedge.symbol,
    side: varSize > 0 ? 'long' : 'short',
    size: Math.abs(varSize),
    realizedPnl: varRealized,
    funding: varFunding,
    fees: 0,
    avgEntryPx: entryPx,
    avgClosePx: exitPx,
    closeTime: hedge.closedAt || Date.now(),
    fundingEstimated: true,
  };
  const trackedLeg = {
    venue: hedge.trackedVenue,
    symbol: hedge.symbol,
    side: trackedCloseLeg.side,
    size: Math.abs(Number(trackedCloseLeg.size || hedge.trackedSize || 0)),
    realizedPnl: Number(trackedCloseLeg.realizedPnl ?? 0),
    funding: Number(trackedCloseLeg.funding ?? 0),
    fees: Number(trackedCloseLeg.fees ?? 0),
    avgEntryPx: trackedCloseLeg.avgEntryPx ?? trackedCloseLeg.entryPx ?? null,
    avgClosePx: trackedCloseLeg.avgClosePx ?? trackedCloseLeg.exitPx ?? null,
    closeTime: Number(trackedCloseLeg.closeTime || hedge.closedAt || Date.now()),
  };
  const longLeg = trackedLeg.side === 'long' ? trackedLeg : varLeg;
  const shortLeg = trackedLeg.side === 'short' ? trackedLeg : varLeg;
  const closeSlippage = longLeg.realizedPnl + shortLeg.realizedPnl;
  const funding = longLeg.funding + shortLeg.funding;
  const fees = longLeg.fees + shortLeg.fees;
  const closeTime = Math.max(longLeg.closeTime || 0, shortLeg.closeTime || 0);
  const pair = {
    symbol: hedge.symbol,
    pairLabel: `${venueShortLabel(hedge.trackedVenue)} + Var`,
    pairType: `${hedge.trackedVenue}_variational`,
    variationalHedgeId: hedge.id,
    openTime: hedge.openedAt || null,
    closeTime,
    size: Math.min(longLeg.size || 0, shortLeg.size || 0),
    sizeMismatchPct: 0,
    longLeg,
    shortLeg,
    closeSlippage,
    funding,
    fees,
    netPnl: closeSlippage + funding - fees,
    manualVariationalClose: true,
  };
  return pair;
}

function createHedgeFromUnhedged(unhedgedLeg, entryPx) {
  const trackedSize = Number(unhedgedLeg.size);
  const varEntry = Number(entryPx);
  return {
    id: `var-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    symbol: unhedgedLeg.symbol,
    trackedVenue: unhedgedLeg.venue,
    trackedSize,
    variationalSize: -trackedSize,
    variationalEntryPx: Number.isFinite(varEntry) && varEntry > 0 ? varEntry : null,
    variationalExitPx: null,
    openedAt: Date.now(),
    closedAt: null,
    pendingCloseAt: null,
    status: 'open',
    variationalFundingUsdOverride: null,
    trackedLastSnapshot: null,
  };
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
    const key = `${hedge.symbol}|${hedge.trackedVenue}`;
    const prev = activeByKey.get(key);
    if (!prev || Number(hedge.openedAt || 0) >= Number(prev.openedAt || 0)) {
      activeByKey.set(key, hedge);
    }
  }
  return [...activeByKey.values(), ...closed];
}

function applyVariationalHedges(data, hedges, variationalBySymbol) {
  const nextHedges = dedupeActiveVariationalHedges((hedges || []).map((h) => ({ ...h })));
  const paired = stripVariationalPairs(data.paired);
  let unhedged = [...(data.unhedged || [])];
  const newClosedPairs = [];
  const pendingClose = [];
  const spreadByBase = Object.fromEntries((data.rateSpread || []).map((r) => [r.symbol, r]));

  const hedgeKeys = new Set(
    nextHedges
      .filter((h) => h.status === 'open' || h.status === 'pending_close')
      .map((h) => `${h.symbol}|${h.trackedVenue}`),
  );
  unhedged = unhedged.filter((u) => !hedgeKeys.has(`${u.symbol}|${u.venue}`));

  for (const hedge of nextHedges) {
    if (hedge.status === 'closed') continue;
    const listing = variationalBySymbol?.[hedge.symbol] || null;
    const spread = spreadByBase[hedge.symbol] || null;
    const trackedLeg = findTrackedLeg(data, hedge);

    if (hedge.status === 'open') {
      if (trackedLeg) {
        hedge.trackedLastSnapshot = {
          size: trackedLeg.size,
          side: trackedLeg.side,
          entryPx: trackedLeg.entryPx,
          unrealizedPnl: trackedLeg.unrealizedPnl,
          funding: trackedLeg.fundingSinceOpen,
          fees: trackedLeg.fees,
        };
        paired.push(buildVariationalOpenPair(trackedLeg, hedge, listing, spread));
      } else {
        hedge.status = 'pending_close';
        hedge.pendingCloseAt = hedge.pendingCloseAt || Date.now();
        const snapUpnl = Number(hedge.trackedLastSnapshot?.unrealizedPnl);
        if (Number.isFinite(snapUpnl) && hedge.lockedEquityAdjust == null) {
          hedge.lockedEquityAdjust = -snapUpnl;
        }
        pendingClose.push(hedge);
      }
      continue;
    }

    if (hedge.status === 'pending_close') {
      if (trackedLeg) {
        hedge.status = 'open';
        hedge.pendingCloseAt = null;
        hedge.variationalExitPx = null;
        hedge.closedAt = null;
        hedge.lockedEquityAdjust = null;
        hedge.trackedLastSnapshot = {
          size: trackedLeg.size,
          side: trackedLeg.side,
          entryPx: trackedLeg.entryPx,
          unrealizedPnl: trackedLeg.unrealizedPnl,
          funding: trackedLeg.fundingSinceOpen,
          fees: trackedLeg.fees,
        };
        paired.push(buildVariationalOpenPair(trackedLeg, hedge, listing, spread));
        continue;
      }
      if (Number.isFinite(Number(hedge.variationalExitPx))) {
        const trackedCloseLeg = findTrackedCloseLeg(data, hedge);
        if (trackedCloseLeg) {
          hedge.status = 'closed';
          hedge.closedAt = hedge.closedAt || Date.now();
          hedge.lockedEquityAdjust = null;
          newClosedPairs.push(buildVariationalClosedPair(hedge, trackedCloseLeg, listing));
        } else {
          pendingClose.push(hedge);
        }
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
  buildVariationalFundingEventsAligned,
  variationalHedgeOpenedAtMs,
  variationalNextFundingAtMs,
  variationalFundingPaymentPerInterval,
  buildVariationalSyntheticLeg,
  buildVariationalOpenPair,
  buildVariationalClosedPair,
  createHedgeFromUnhedged,
  applyVariationalHedges,
  stripVariationalPairs,
  dedupeActiveVariationalHedges,
  isVariationalPair,
  findTrackedLeg,
  findTrackedCloseLeg,
  variationalLegPnl,
  variationalLiveMarkPx,
  netFundingSpread8h,
  venueRate8hFromSpread,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = variationalHedgeExports;
}
if (typeof window !== 'undefined') {
  window.VariationalHedge = variationalHedgeExports;
}

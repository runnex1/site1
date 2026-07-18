/**
 * Variational hedge-neutral portfolio equity adjustments.
 * Exchange equity includes tracked-leg uPnL; Variational leg PnL is off-platform.
 */

function variationalTrackedLeg(pair) {
  if (!pair?.crossLegA || !pair?.crossLegB) return null;
  const trackedVenue = pair.venueA || pair.crossLegA?.venue;
  if (!trackedVenue) return null;
  return pair.crossLegA?.venue === trackedVenue ? pair.crossLegA : pair.crossLegB;
}

function isVariationalClosedPair(pair) {
  return Boolean(pair?.manualVariationalClose)
    || String(pair?.pairType || '').endsWith('_variational');
}

function variationalLegFromClosedPair(pair) {
  if (pair?.longLeg?.venue === 'variational') return pair.longLeg;
  if (pair?.shortLeg?.venue === 'variational') return pair.shortLeg;
  return null;
}

/** Keep chart continuity after the tracked leg closes but before Variational exit is entered. */
function variationalPendingCloseEquityAdjust(pendingClose) {
  let sum = 0;
  for (const hedge of pendingClose || []) {
    const locked = Number(hedge?.lockedEquityAdjust);
    if (Number.isFinite(locked)) {
      sum += locked;
      continue;
    }
    const upnl = Number(hedge?.trackedLastSnapshot?.unrealizedPnl);
    if (Number.isFinite(upnl)) sum -= upnl;
  }
  return sum;
}

/** Neutralize open tracked-leg uPnL: add -trackedUpnl to exchange equity. */
function variationalOpenEquityAdjust(pairs, isVariationalPair) {
  let sum = 0;
  for (const pair of pairs || []) {
    if (typeof isVariationalPair === 'function' && !isVariationalPair(pair)) continue;
    if (typeof isVariationalPair !== 'function' && !String(pair?.pairType || '').endsWith('_variational')) continue;
    const leg = variationalTrackedLeg(pair);
    const upnl = Number(leg?.unrealizedPnl);
    if (Number.isFinite(upnl)) sum -= upnl;
  }
  return sum;
}

/** Add off-exchange Variational PnL only (close slip vs tracked + Var funding).
 *  Do NOT use varLeg.realizedPnl when it is the pair-card offset (−trackedRealized + slip):
 *  that would subtract HL realized again after exchange equity already includes it. */
function variationalClosedPairEquityPnl(pair) {
  if (Number.isFinite(Number(pair?.variationalEquityPnl))) {
    return Number(pair.variationalEquityPnl);
  }
  const varLeg = variationalLegFromClosedPair(pair);
  if (!varLeg) return 0;
  const funding = Number(varLeg.funding) || 0;
  const trackedLeg = pair?.longLeg?.venue === 'variational' ? pair.shortLeg : pair.longLeg;
  const varR = Number(varLeg.realizedPnl);
  const trackedR = Number(trackedLeg?.realizedPnl);
  if (Number.isFinite(varR) && Number.isFinite(trackedR)) {
    const slipApprox = varR + trackedR;
    // Offset form: var ≈ −tracked + small slip → sum is the adverse close slip only.
    const looksLikeOffset = Math.abs(slipApprox) <= Math.max(Math.abs(trackedR) * 0.05, 5)
      && Math.abs(slipApprox) < Math.max(Math.abs(varR) * 0.5, 1);
    if (looksLikeOffset) return slipApprox + funding;
  }
  if (Number.isFinite(Number(pair?.variationalCloseSlippagePnl))) {
    return Number(pair.variationalCloseSlippagePnl) + funding;
  }
  if (Number.isFinite(varR)) return varR + funding;
  return funding;
}

function variationalClosedEquityAdjust(closedPairs) {
  let sum = 0;
  for (const pair of closedPairs || []) {
    if (!isVariationalClosedPair(pair)) continue;
    sum += variationalClosedPairEquityPnl(pair);
  }
  return sum;
}

function variationalTotalEquityAdjust(pairs, closedPairs, isVariationalPair, pendingClose = []) {
  return variationalOpenEquityAdjust(pairs, isVariationalPair)
    + variationalPendingCloseEquityAdjust(pendingClose)
    + variationalClosedEquityAdjust(closedPairs);
}

function toBaseSymbol(ticker) {
  return String(ticker || '')
    .trim()
    .toUpperCase()
    .replace(/-PERP$/i, '')
    .replace(/USDT$/i, '')
    .replace(/USD$/i, '');
}

function trackedPositionFromStates(states, hedge) {
  const venue = hedge?.trackedVenue;
  const symbol = toBaseSymbol(hedge?.symbol);
  if (!venue || !symbol) return null;
  const positions = {
    hyperliquid: states?.hyperliquid?.state?.positions,
    nado: states?.nado?.state?.positions,
    grvt: states?.grvt?.state?.positions,
    extended: states?.extended?.state?.positions,
  }[venue];
  if (!Array.isArray(positions)) return null;
  const pos = positions.find((p) => toBaseSymbol(p.symbol) === symbol);
  if (!pos) return null;
  const upnl = Number(pos.unrealizedPnl ?? pos.unrealized_pnl);
  return Number.isFinite(upnl) ? { ...pos, unrealizedPnl: upnl } : null;
}

/** Server/cron path: open + pending from hedges + positions, closed from cached pairs. */
function computeVariationalEquityAdjustFromHedges({ hedges = [], closedPairs = [], states = null } = {}) {
  let openAdj = 0;
  let pendingAdj = 0;
  for (const hedge of hedges || []) {
    if (hedge?.status === 'closed') continue;
    if (hedge?.status === 'open') {
      const leg = states ? trackedPositionFromStates(states, hedge) : null;
      const upnl = leg != null
        ? Number(leg.unrealizedPnl)
        : Number(hedge?.trackedLastSnapshot?.unrealizedPnl);
      if (Number.isFinite(upnl)) openAdj -= upnl;
      continue;
    }
    if (hedge?.status === 'pending_close') {
      const locked = Number(hedge?.lockedEquityAdjust);
      if (Number.isFinite(locked)) {
        pendingAdj += locked;
        continue;
      }
      const snapUpnl = Number(hedge?.trackedLastSnapshot?.unrealizedPnl);
      if (Number.isFinite(snapUpnl)) pendingAdj -= snapUpnl;
    }
  }
  const closedAdj = variationalClosedEquityAdjust(closedPairs);
  return {
    openAdj,
    pendingAdj,
    closedAdj,
    totalAdj: openAdj + pendingAdj + closedAdj,
  };
}

function snapshotVariationalAdjust(snap, closedAdjFallback = 0) {
  if (Number.isFinite(Number(snap?.variationalEquityAdjust))) {
    return Number(snap.variationalEquityAdjust);
  }
  const parts = [
    snap?.variationalOpenEquityAdjust,
    snap?.variationalPendingCloseEquityAdjust,
    snap?.variationalClosedEquityAdjust,
  ]
    .map(Number)
    .filter(Number.isFinite);
  if (parts.length) return parts.reduce((sum, value) => sum + value, 0);
  return Number.isFinite(Number(closedAdjFallback)) ? Number(closedAdjFallback) : 0;
}

function variationalNeutralEquity(exchangeEquity, adjust) {
  const raw = Number(exchangeEquity);
  const adj = Number(adjust);
  if (!Number.isFinite(raw)) return null;
  if (!Number.isFinite(adj)) return raw;
  return raw + adj;
}

function equityPointChartValue(point, valueMode = 'neutral') {
  const raw = Number(point?.totalEquity);
  if (valueMode === 'raw') return Number.isFinite(raw) ? raw : 0;
  const neutral = point?.variationalNeutralEquity;
  if (Number.isFinite(Number(neutral))) return Number(neutral);
  const adjust = Number(point?.variationalEquityAdjust) || 0;
  return Number.isFinite(raw) ? raw + adjust : 0;
}

const variationalEquityExports = {
  variationalTrackedLeg,
  isVariationalClosedPair,
  variationalOpenEquityAdjust,
  variationalPendingCloseEquityAdjust,
  variationalClosedEquityAdjust,
  variationalClosedPairEquityPnl,
  variationalTotalEquityAdjust,
  computeVariationalEquityAdjustFromHedges,
  snapshotVariationalAdjust,
  variationalNeutralEquity,
  equityPointChartValue,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = variationalEquityExports;
}
if (typeof window !== 'undefined') {
  window.VariationalEquity = variationalEquityExports;
}

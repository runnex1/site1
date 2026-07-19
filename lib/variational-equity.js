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

function variationalVarLeg(pair) {
  if (pair?.crossLegA?.venue === 'variational') return pair.crossLegA;
  if (pair?.crossLegB?.venue === 'variational') return pair.crossLegB;
  return null;
}

/** While tracked leg is flat but Var exit not finalized: keep Variational MTM in hedge-neutral. */
function variationalPendingCloseEquityAdjust(pendingClose) {
  let sum = 0;
  for (const hedge of pendingClose || []) {
    const varUpnl = estimateVariationalOpenUpnl(hedge);
    if (Number.isFinite(varUpnl)) {
      sum += varUpnl;
      continue;
    }
    // Fallback: last synthetic Var uPnL stashed on the hedge (if any).
    const snapVar = Number(hedge?.variationalLastUpnl ?? hedge?.trackedLastSnapshot?.variationalUpnl);
    if (Number.isFinite(snapVar)) sum += snapVar;
  }
  return sum;
}

/**
 * Hedge-neutral open adjust:
 * Exchange equity already includes tracked-leg uPnL. Variational MTM is off-platform.
 * True wealth ≈ Exchange + varUpnl. Do not also subtract tracked uPnL (that yields
 * exchange-cash only and drops Var, and breaks on partial trims).
 */
function variationalOpenEquityAdjust(pairs, isVariationalPair) {
  let sum = 0;
  for (const pair of pairs || []) {
    if (typeof isVariationalPair === 'function' && !isVariationalPair(pair)) continue;
    if (typeof isVariationalPair !== 'function' && !String(pair?.pairType || '').endsWith('_variational')) continue;
    const varLeg = variationalVarLeg(pair);
    const varUpnl = Number(varLeg?.unrealizedPnl);
    if (Number.isFinite(varUpnl)) sum += varUpnl;
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

function estimateVariationalOpenUpnl(hedge, trackedLeg = null) {
  const size = Number(hedge?.variationalSize);
  const entry = Number(hedge?.variationalEntryPx);
  const mark = Number(
    hedge?.variationalMarkPx
    ?? hedge?.trackedLastSnapshot?.variationalMarkPx
    ?? trackedLeg?.markPx
    ?? hedge?.trackedLastSnapshot?.markPx,
  );
  if (!Number.isFinite(size) || size === 0) return null;
  if (!Number.isFinite(entry) || entry <= 0) return null;
  if (!Number.isFinite(mark) || mark <= 0) return null;
  const abs = Math.abs(size);
  return size > 0 ? (mark - entry) * abs : (entry - mark) * abs;
}

/** Server/cron path: open + pending from hedges + positions, closed from cached pairs. */
function computeVariationalEquityAdjustFromHedges({ hedges = [], closedPairs = [], states = null } = {}) {
  let openAdj = 0;
  let pendingAdj = 0;
  for (const hedge of hedges || []) {
    if (hedge?.status === 'closed') continue;
    if (hedge?.status === 'open') {
      // Only add off-platform Variational MTM; tracked uPnL is already in exchange equity.
      const leg = states ? trackedPositionFromStates(states, hedge) : null;
      const varUpnl = estimateVariationalOpenUpnl(hedge, leg);
      if (Number.isFinite(varUpnl)) openAdj += varUpnl;
      continue;
    }
    if (hedge?.status === 'pending_close') {
      const varUpnl = estimateVariationalOpenUpnl(hedge);
      if (Number.isFinite(varUpnl)) {
        pendingAdj += varUpnl;
        continue;
      }
      const snapVar = Number(hedge?.variationalLastUpnl ?? hedge?.trackedLastSnapshot?.variationalUpnl);
      if (Number.isFinite(snapVar)) pendingAdj += snapVar;
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
  variationalVarLeg,
  isVariationalClosedPair,
  variationalOpenEquityAdjust,
  variationalPendingCloseEquityAdjust,
  variationalClosedEquityAdjust,
  variationalClosedPairEquityPnl,
  variationalTotalEquityAdjust,
  estimateVariationalOpenUpnl,
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

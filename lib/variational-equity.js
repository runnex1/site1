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

/** Add Variational leg realized + funding from closed hedge pairs (not in exchange equity). */
function variationalClosedEquityAdjust(closedPairs) {
  let sum = 0;
  for (const pair of closedPairs || []) {
    if (!isVariationalClosedPair(pair)) continue;
    const varLeg = variationalLegFromClosedPair(pair);
    if (!varLeg) continue;
    sum += (Number(varLeg.realizedPnl) || 0) + (Number(varLeg.funding) || 0);
  }
  return sum;
}

function variationalTotalEquityAdjust(pairs, closedPairs, isVariationalPair) {
  return variationalOpenEquityAdjust(pairs, isVariationalPair)
    + variationalClosedEquityAdjust(closedPairs);
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
  variationalClosedEquityAdjust,
  variationalTotalEquityAdjust,
  variationalNeutralEquity,
  equityPointChartValue,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = variationalEquityExports;
}
if (typeof window !== 'undefined') {
  window.VariationalEquity = variationalEquityExports;
}

/**
 * Variational hedge-neutral portfolio equity adjustments.
 * Exchange equity includes tracked-leg uPnL; Variational leg PnL is off-platform.
 *
 * Hedge-neutral chart accuracy: mark both legs of a size hedge at the SAME price
 * (tracked venue mark for Var pairs; leg-A mark for cross-venue pairs) so underlying
 * price moves cancel. Only matched size is neutralized after partial closes
 * (min(|var|,|tracked|), same idea as cross-venue). Remaining move is entry slip,
 * funding, fees, and true basis.
 */

function variationalLegPnl(size, entry, mark) {
  const s = Number(size);
  const e = Number(entry);
  const m = Number(mark);
  if (!Number.isFinite(s) || s === 0) return null;
  if (!Number.isFinite(e) || e <= 0) return null;
  if (!Number.isFinite(m) || m <= 0) return null;
  const abs = Math.abs(s);
  return s > 0 ? (m - e) * abs : (e - m) * abs;
}

function variationalTrackedLeg(pair) {
  if (!pair?.crossLegA || !pair?.crossLegB) return null;
  const trackedVenue = pair.venueA || pair.crossLegA?.venue;
  if (!trackedVenue || trackedVenue === 'variational') return null;
  return pair.crossLegA?.venue === trackedVenue ? pair.crossLegA : pair.crossLegB;
}

/**
 * Opposite-sign hedge: signed Var size capped to min(|var|, |tracked|).
 * Same-sign / missing sizes → null (caller keeps full Var size).
 */
function matchedVariationalSignedSize(varSize, trackedSize) {
  const v = Number(varSize);
  const t = Number(trackedSize);
  if (!Number.isFinite(v) || v === 0 || !Number.isFinite(t) || t === 0) return null;
  if (v * t >= 0) return null;
  const matched = Math.min(Math.abs(v), Math.abs(t));
  return v > 0 ? matched : -matched;
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
    // Tracked flat → no venue mark; use Variational mark (sameMark falls back).
    const varUpnl = estimateVariationalOpenUpnl(hedge, null, { sameMark: true });
    if (Number.isFinite(varUpnl)) {
      sum += varUpnl;
      continue;
    }
    const snapVar = Number(hedge?.variationalLastUpnl ?? hedge?.trackedLastSnapshot?.variationalUpnl);
    if (Number.isFinite(snapVar)) sum += snapVar;
  }
  return sum;
}

/**
 * Hedge-neutral open adjust (Variational pairs):
 * Exchange equity already includes tracked-leg uPnL at the venue mark.
 * Add Var MTM for the MATCHED size only, marked at the SAME tracked venue mark,
 * so price cancels after partial closes. Unmatched Var inventory is omitted
 * (pending_close still marks full Var when tracked is flat).
 */
function variationalOpenEquityAdjust(pairs, isVariationalPair) {
  let sum = 0;
  for (const pair of pairs || []) {
    if (typeof isVariationalPair === 'function' && !isVariationalPair(pair)) continue;
    if (typeof isVariationalPair !== 'function' && !String(pair?.pairType || '').endsWith('_variational')) continue;
    const varLeg = variationalVarLeg(pair);
    const tracked = variationalTrackedLeg(pair);
    const varSize = Number(varLeg?.size);
    const matched = matchedVariationalSignedSize(varSize, tracked?.size);
    const size = matched == null ? varSize : matched;
    const entry = Number(varLeg?.entryPx ?? varLeg?.entry);
    const mark = Number(tracked?.markPx ?? tracked?.mark);
    const sameMarkUpnl = variationalLegPnl(size, entry, mark);
    if (Number.isFinite(sameMarkUpnl)) {
      sum += sameMarkUpnl;
      continue;
    }
    // Fallback when tracked mark missing: scale stored Var uPnL to matched size.
    const varUpnl = Number(varLeg?.unrealizedPnl);
    if (!Number.isFinite(varUpnl)) continue;
    if (matched == null || !Number.isFinite(varSize) || varSize === 0) {
      sum += varUpnl;
      continue;
    }
    sum += varUpnl * (Math.abs(matched) / Math.abs(varSize));
  }
  return sum;
}

/**
 * Cross-venue hedge legs (hl+nado / hl+grvt / hl+extended).
 * Returns { legA, legB } or null for Variational pairs.
 */
function crossVenuePairLegs(pair) {
  if (!pair || typeof pair !== 'object') return null;
  const pairType = String(pair.pairType || '');
  if (pairType.endsWith('_variational')) return null;
  if (pair.hl && pair.nado) return { legA: pair.hl, legB: pair.nado };
  if (pair.crossLegA && pair.crossLegB) {
    if (pair.crossLegA.venue === 'variational' || pair.crossLegB.venue === 'variational') return null;
    return { legA: pair.crossLegA, legB: pair.crossLegB };
  }
  return null;
}

/**
 * Re-mark leg B at leg A's mark. Added to Σ venue equity so directional price cancels;
 * leftover is true basis (markA − markB) on the matched size.
 * adjust = signedMatchedSizeB × (markA − markB)
 */
function crossVenueSameMarkAdjustForPair(pair) {
  const legs = crossVenuePairLegs(pair);
  if (!legs) return 0;
  const markA = Number(legs.legA.markPx ?? legs.legA.mark);
  const markB = Number(legs.legB.markPx ?? legs.legB.mark);
  const sizeA = Number(legs.legA.size ?? legs.legA.szi);
  const sizeB = Number(legs.legB.size ?? legs.legB.szi);
  if (!Number.isFinite(markA) || markA <= 0 || !Number.isFinite(markB) || markB <= 0) return 0;
  if (!Number.isFinite(sizeA) || !Number.isFinite(sizeB) || sizeA === 0 || sizeB === 0) return 0;
  if (sizeA * sizeB >= 0) return 0; // not a hedge
  const matched = Math.min(Math.abs(sizeA), Math.abs(sizeB));
  const signedB = sizeB > 0 ? matched : -matched;
  return signedB * (markA - markB);
}

function crossVenueSameMarkAdjust(pairs) {
  let sum = 0;
  for (const pair of pairs || []) {
    sum += crossVenueSameMarkAdjustForPair(pair);
  }
  return sum;
}

function listVenuePositionsFromStates(states) {
  const blocks = {
    hyperliquid: states?.hyperliquid?.state?.positions,
    nado: states?.nado?.state?.positions,
    grvt: states?.grvt?.state?.positions,
    extended: states?.extended?.state?.positions,
  };
  const out = [];
  for (const [venue, positions] of Object.entries(blocks)) {
    for (const p of positions || []) {
      const symbol = toBaseSymbol(p.symbol || p.coin);
      const size = Number(p.size ?? p.szi);
      const markPx = Number(p.markPx ?? p.mark);
      if (!symbol || !Number.isFinite(size) || size === 0) continue;
      if (!Number.isFinite(markPx) || markPx <= 0) continue;
      out.push({ venue, symbol, size, markPx });
    }
  }
  return out;
}

/** Cron path when full `paired` is unavailable: greedy opposite-sign matches by symbol. */
function crossVenueSameMarkAdjustFromStates(states) {
  const positions = listVenuePositionsFromStates(states);
  const bySymbol = new Map();
  for (const p of positions) {
    if (!bySymbol.has(p.symbol)) bySymbol.set(p.symbol, []);
    bySymbol.get(p.symbol).push(p);
  }
  let sum = 0;
  for (const legs of bySymbol.values()) {
    const used = new Set();
    for (let i = 0; i < legs.length; i++) {
      if (used.has(i)) continue;
      for (let j = i + 1; j < legs.length; j++) {
        if (used.has(j)) continue;
        if (legs[i].venue === legs[j].venue) continue;
        if (legs[i].size * legs[j].size >= 0) continue;
        const markA = legs[i].markPx;
        const markB = legs[j].markPx;
        const matched = Math.min(Math.abs(legs[i].size), Math.abs(legs[j].size));
        const signedB = legs[j].size > 0 ? matched : -matched;
        sum += signedB * (markA - markB);
        used.add(i);
        used.add(j);
        break;
      }
    }
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
    + crossVenueSameMarkAdjust(pairs)
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

/**
 * Variational open uPnL.
 * sameMark (default true for equity): prefer tracked venue mark so HN cancels price.
 * sameMark equity path caps size to the live tracked leg (matched neutralize).
 * sameMark:false keeps full Variational size + listing mark (pair-card display).
 */
function estimateVariationalOpenUpnl(hedge, trackedLeg = null, opts = {}) {
  const sameMark = opts?.sameMark !== false;
  let size = Number(hedge?.variationalSize);
  // Only match against a live tracked leg — not hedge.trackedSize (stale on pending_close).
  if (sameMark) {
    const matched = matchedVariationalSignedSize(size, trackedLeg?.size);
    if (matched != null) size = matched;
  }
  const entry = Number(hedge?.variationalEntryPx);
  const mark = sameMark
    ? Number(
      trackedLeg?.markPx
      ?? hedge?.trackedLastSnapshot?.markPx
      ?? hedge?.variationalMarkPx
      ?? hedge?.trackedLastSnapshot?.variationalMarkPx,
    )
    : Number(
      hedge?.variationalMarkPx
      ?? hedge?.trackedLastSnapshot?.variationalMarkPx
      ?? trackedLeg?.markPx
      ?? hedge?.trackedLastSnapshot?.markPx,
    );
  return variationalLegPnl(size, entry, mark);
}

/** Server/cron path: open + pending from hedges + positions, closed from cached pairs. */
function computeVariationalEquityAdjustFromHedges({
  hedges = [],
  closedPairs = [],
  states = null,
  paired = null,
} = {}) {
  let openAdj = 0;
  let pendingAdj = 0;
  for (const hedge of hedges || []) {
    if (hedge?.status === 'closed') continue;
    if (hedge?.status === 'open') {
      // Same-mark Var MTM; tracked uPnL is already in exchange equity.
      const leg = states ? trackedPositionFromStates(states, hedge) : null;
      const varUpnl = estimateVariationalOpenUpnl(hedge, leg, { sameMark: true });
      if (Number.isFinite(varUpnl)) openAdj += varUpnl;
      continue;
    }
    if (hedge?.status === 'pending_close') {
      const varUpnl = estimateVariationalOpenUpnl(hedge, null, { sameMark: true });
      if (Number.isFinite(varUpnl)) {
        pendingAdj += varUpnl;
        continue;
      }
      const snapVar = Number(hedge?.variationalLastUpnl ?? hedge?.trackedLastSnapshot?.variationalUpnl);
      if (Number.isFinite(snapVar)) pendingAdj += snapVar;
    }
  }
  const closedAdj = variationalClosedEquityAdjust(closedPairs);
  const crossVenueAdj = Array.isArray(paired) && paired.length
    ? crossVenueSameMarkAdjust(paired)
    : (states ? crossVenueSameMarkAdjustFromStates(states) : 0);
  return {
    openAdj,
    pendingAdj,
    closedAdj,
    crossVenueAdj,
    totalAdj: openAdj + pendingAdj + closedAdj + crossVenueAdj,
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
    snap?.crossVenueSameMarkAdjust,
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

/** Same level the Hedge-neutral chart uses for a point. */
function hedgeNeutralEquityFromPoint(point) {
  const neutral = Number(point?.variationalNeutralEquity);
  if (Number.isFinite(neutral)) return neutral;
  const raw = Number(point?.totalEquity);
  const adjust = Number(point?.variationalEquityAdjust) || 0;
  return Number.isFinite(raw) ? raw + adjust : null;
}

/**
 * Hedge-neutral with deposits/withdrawals/transfers removed.
 * Prefer HN − pnlCumulativeNetDeposits (full equity-moving ledger, no same-sign
 * cross-venue offset). Fall back to cumulativeNetDeposits / adjustedEquity.
 */
function capitalNeutralHedgeNeutralFromPoint(point) {
  const hn = hedgeNeutralEquityFromPoint(point);
  if (!Number.isFinite(hn)) return null;
  const pnlDep = Number(point?.pnlCumulativeNetDeposits);
  if (Number.isFinite(pnlDep)) return hn - pnlDep;
  const deposits = Number(point?.cumulativeNetDeposits);
  if (Number.isFinite(deposits)) return hn - deposits;
  const adjusted = Number(point?.adjustedEquity);
  const varAdj = Number(point?.variationalEquityAdjust);
  if (Number.isFinite(adjusted)) {
    return adjusted + (Number.isFinite(varAdj) ? varAdj : 0);
  }
  return hn;
}

/**
 * PnL series: capital-neutral hedge-neutral minus a fixed baseline.
 * Pass `fixedBaseline` (locked once client-side) so the series never re-zeros
 * when the first visible snapshot changes. Without it, falls back to first point.
 */
function rebaseHedgeNeutralSeriesToPnl(points, fixedBaseline) {
  const rows = Array.isArray(points) ? points : [];
  if (!rows.length) return [];
  const levels = rows.map((p) => {
    const v = capitalNeutralHedgeNeutralFromPoint(p);
    return Number.isFinite(v) ? v : 0;
  });
  const locked = Number(fixedBaseline);
  const baseline = Number.isFinite(locked) ? locked : levels[0];
  return rows.map((p, i) => ({
    ...p,
    chartValue: levels[i] - baseline,
    capitalNeutralHedgeNeutral: levels[i],
    pnlBaseline: baseline,
  }));
}

function equityPointChartValue(point, valueMode = 'neutral') {
  const raw = Number(point?.totalEquity);
  if (valueMode === 'raw') return Number.isFinite(raw) ? raw : 0;
  if (valueMode === 'pnl') {
    if (Number.isFinite(Number(point?.chartValue)) && point?.pnlBaseline != null) {
      return Number(point.chartValue);
    }
    const level = capitalNeutralHedgeNeutralFromPoint(point);
    return Number.isFinite(level) ? level : 0;
  }
  const hn = hedgeNeutralEquityFromPoint(point);
  return Number.isFinite(hn) ? hn : 0;
}

const variationalEquityExports = {
  variationalLegPnl,
  variationalTrackedLeg,
  variationalVarLeg,
  matchedVariationalSignedSize,
  isVariationalClosedPair,
  variationalOpenEquityAdjust,
  crossVenuePairLegs,
  crossVenueSameMarkAdjustForPair,
  crossVenueSameMarkAdjust,
  crossVenueSameMarkAdjustFromStates,
  variationalPendingCloseEquityAdjust,
  variationalClosedEquityAdjust,
  variationalClosedPairEquityPnl,
  variationalTotalEquityAdjust,
  estimateVariationalOpenUpnl,
  computeVariationalEquityAdjustFromHedges,
  snapshotVariationalAdjust,
  variationalNeutralEquity,
  hedgeNeutralEquityFromPoint,
  capitalNeutralHedgeNeutralFromPoint,
  rebaseHedgeNeutralSeriesToPnl,
  equityPointChartValue,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = variationalEquityExports;
}
if (typeof window !== 'undefined') {
  window.VariationalEquity = variationalEquityExports;
}

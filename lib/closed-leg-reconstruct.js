/**
 * Reconstruct closed perps legs from exchange fill history.
 * Shared by server (perps.js) and browser (variational-hedge.js).
 */

const CLOSED_SYNTHETIC_CLOSE_CLUSTER_MS = 3600000;
const CLOSED_ROUND_EPS = 1e-8;

function toBaseSymbol(symbol) {
  return String(symbol || '')
    .trim()
    .toUpperCase()
    .replace(/-PERP$/i, '')
    .replace(/USDT$/i, '')
    .replace(/USD$/i, '');
}

function closedFillKey(fill) {
  return `${fill.venue || ''}:${fill.time || 0}:${fill.submissionIdx || fill.oid || ''}:${fill.symbol || ''}:${fill.px || 0}:${fill.sz ?? fill.size ?? 0}:${fill.side || ''}`;
}

function fillSignedSize(fill) {
  const raw = Number(fill.sz ?? fill.size ?? 0);
  if (!Number.isFinite(raw) || raw === 0) return 0;
  const side = String(fill.side || '').toLowerCase();
  const abs = Math.abs(raw);
  if (side === 'b' || side === 'buy' || side === 'bid') return abs;
  if (side === 'a' || side === 'sell' || side === 'ask') return -abs;
  return raw;
}

function computeFillRealizedPnl(fills) {
  let pos = 0;
  let avgEntry = 0;
  let realized = 0;
  for (const fill of fills) {
    const delta = fillSignedSize(fill);
    const px = Number(fill.px || 0);
    if (!delta || !px) continue;
    if (Math.abs(pos) <= CLOSED_ROUND_EPS) {
      pos = delta;
      avgEntry = px;
      continue;
    }
    if (Math.sign(pos) === Math.sign(delta)) {
      const nextAbs = Math.abs(pos) + Math.abs(delta);
      avgEntry = nextAbs > 0 ? ((avgEntry * Math.abs(pos)) + (px * Math.abs(delta))) / nextAbs : px;
      pos += delta;
      continue;
    }
    const closedSize = Math.min(Math.abs(pos), Math.abs(delta));
    realized += closedSize * (px - avgEntry) * Math.sign(pos);
    const remaining = Math.abs(delta) - closedSize;
    pos += delta;
    if (remaining > CLOSED_ROUND_EPS && Math.sign(pos) === Math.sign(delta)) {
      avgEntry = px;
    }
    if (Math.abs(pos) <= CLOSED_ROUND_EPS) {
      pos = 0;
      avgEntry = 0;
    }
  }
  return realized;
}

function fundingForClosedLeg(venue, symbol, openTime, closeTime, paymentSources) {
  const start = Number(openTime || 0);
  const end = Number(closeTime || 0);
  if (!start || !end) return 0;
  return (paymentSources[venue] || [])
    .filter((p) => toBaseSymbol(p.symbol) === symbol && (p.time || 0) >= start && (p.time || 0) <= end)
    .reduce((sum, p) => sum + (p.usdc || 0), 0);
}

function buildClosedLegsForVenue(venue, fills, paymentSources) {
  const bySymbol = {};
  for (const fill of fills || []) {
    const symbol = toBaseSymbol(fill.symbol);
    const time = Number(fill.time || 0);
    if (!symbol || !time) continue;
    if (!bySymbol[symbol]) bySymbol[symbol] = [];
    bySymbol[symbol].push(fill);
  }

  const legs = [];
  for (const [symbol, rows] of Object.entries(bySymbol)) {
    const sorted = [...rows].sort((a, b) => (a.time || 0) - (b.time || 0));
    const consumed = new Set();
    let pos = 0;
    let round = [];
    for (const fill of sorted) {
      const delta = fillSignedSize(fill);
      if (!delta) continue;
      if (!round.length && Math.abs(Number(fill.closedPnl ?? fill.realizedPnl ?? 0)) > CLOSED_ROUND_EPS) continue;
      round.push({ ...fill, _signedSize: delta });
      pos += delta;
      if (Math.abs(pos) <= CLOSED_ROUND_EPS && round.length >= 2) {
        const first = round[0];
        const last = round[round.length - 1];
        const openedSize = round
          .filter((f) => Math.sign(f._signedSize) === Math.sign(first._signedSize))
          .reduce((sum, f) => sum + Math.abs(f._signedSize), 0);
        const reportedPnl = round.reduce((sum, f) => sum + Number(f.closedPnl ?? f.realizedPnl ?? 0), 0);
        const fallbackPnl = computeFillRealizedPnl(round);
        const realizedPnl = Math.abs(reportedPnl) > CLOSED_ROUND_EPS ? reportedPnl : fallbackPnl;
        const fees = round.reduce((sum, f) => sum + Math.abs(Number(f.fee || 0)), 0);
        const openTime = Number(first.time || 0);
        const closeTime = Number(last.time || 0);
        const openSign = Math.sign(first._signedSize);
        let entryNotional = 0;
        let entrySize = 0;
        let closeNotional = 0;
        let closeSize = 0;
        for (const f of round) {
          const sz = Math.abs(f._signedSize);
          const px = Number(f.px || 0);
          if (!sz || !px) continue;
          if (Math.sign(f._signedSize) === openSign) {
            entryNotional += sz * px;
            entrySize += sz;
          } else {
            closeNotional += sz * px;
            closeSize += sz;
          }
        }
        const avgEntryPx = entrySize > 0 ? entryNotional / entrySize : null;
        const avgClosePx = closeSize > 0 ? closeNotional / closeSize : null;
        legs.push({
          venue,
          symbol,
          side: first._signedSize > 0 ? 'long' : 'short',
          size: openedSize,
          openTime,
          closeTime,
          openTimeKnown: true,
          realizedPnl,
          fees,
          avgEntryPx,
          avgClosePx,
          funding: fundingForClosedLeg(venue, symbol, openTime, closeTime, paymentSources),
          fillCount: round.length,
        });
        round.forEach((f) => consumed.add(closedFillKey(f)));
        round = [];
        pos = 0;
      }
    }

    let synthetic = null;
    const flushSynthetic = () => {
      if (!synthetic) return;
      legs.push({
        venue,
        symbol,
        side: synthetic.side,
        size: synthetic.size,
        openTime: synthetic.closeStart,
        closeTime: synthetic.closeTime,
        openTimeKnown: false,
        realizedPnl: synthetic.realizedPnl,
        fees: synthetic.fees,
        funding: 0,
        fillCount: synthetic.fillCount,
        avgClosePx: synthetic.closeSize > 0 ? synthetic.closeNotional / synthetic.closeSize : null,
        reconstructedFromClosingFills: true,
      });
      synthetic = null;
    };

    for (const fill of sorted) {
      if (consumed.has(closedFillKey(fill))) continue;
      const realizedPnl = Number(fill.closedPnl ?? fill.realizedPnl ?? 0);
      const delta = fillSignedSize(fill);
      const time = Number(fill.time || 0);
      if (Math.abs(realizedPnl) <= CLOSED_ROUND_EPS || !delta || !time) continue;

      const side = delta < 0 ? 'long' : 'short';
      if (synthetic && (synthetic.side !== side || time - synthetic.closeTime > CLOSED_SYNTHETIC_CLOSE_CLUSTER_MS)) {
        flushSynthetic();
      }
      if (!synthetic) {
        synthetic = {
          side,
          closeStart: time,
          closeTime: time,
          size: 0,
          realizedPnl: 0,
          fees: 0,
          fillCount: 0,
          closeNotional: 0,
          closeSize: 0,
        };
      }
      synthetic.closeTime = Math.max(synthetic.closeTime, time);
      const absDelta = Math.abs(delta);
      synthetic.size += absDelta;
      synthetic.realizedPnl += realizedPnl;
      synthetic.fees += Math.abs(Number(fill.fee || 0));
      synthetic.fillCount += 1;
      const px = Number(fill.px || 0);
      if (px && absDelta) {
        synthetic.closeNotional += absDelta * px;
        synthetic.closeSize += absDelta;
      }
    }
    flushSynthetic();
  }
  return legs;
}

const closedLegReconstructExports = {
  toBaseSymbol,
  CLOSED_ROUND_EPS,
  CLOSED_SYNTHETIC_CLOSE_CLUSTER_MS,
  closedFillKey,
  fillSignedSize,
  computeFillRealizedPnl,
  fundingForClosedLeg,
  buildClosedLegsForVenue,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = closedLegReconstructExports;
}
if (typeof globalThis !== 'undefined') {
  globalThis.ClosedLegReconstruct = closedLegReconstructExports;
}

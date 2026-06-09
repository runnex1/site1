/**
 * DeFi PNL engine — FIFO cost-basis accounting for wallet tokens and protocol positions.
 * Chart displays Total PNL = Realized + Unrealized only (single combined series).
 */

const EPS = 1e-9;

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeTokenSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase();
}

function tokensToMap(tokens) {
  const map = new Map();
  for (const t of tokens || []) {
    const sym = normalizeTokenSymbol(t.symbol);
    if (!sym) continue;
    const amount = num(t.amount, 0);
    const value = num(t.value, 0);
    if (map.has(sym)) {
      const prev = map.get(sym);
      map.set(sym, { symbol: sym, amount: prev.amount + amount, value: prev.value + value });
    } else {
      map.set(sym, { symbol: sym, amount, value });
    }
  }
  return map;
}

function normalizeTokensForPnl(tokens) {
  return [...tokensToMap(tokens).values()].map(t => ({
    symbol: t.symbol,
    amount: t.amount,
    value: t.value,
  }));
}

function isProtocolMetaKey(key) {
  return String(key || '').includes('__net__') || String(key || '').includes('__total__');
}

class FifoQtyLedger {
  constructor() {
    this.lots = [];
    this.realized = 0;
  }

  qty() {
    return this.lots.reduce((s, l) => s + l.qty, 0);
  }

  addLot(qty, totalCost) {
    const q = num(qty, 0);
    const cost = num(totalCost, 0);
    if (q <= EPS || cost < 0) return;
    this.lots.push({ qty: q, costPerUnit: cost / q });
  }

  sellQty(qty, pricePerUnit) {
    let remaining = num(qty, 0);
    const price = num(pricePerUnit, 0);
    if (remaining <= EPS) return;
    while (remaining > EPS && this.lots.length) {
      const lot = this.lots[0];
      const take = Math.min(remaining, lot.qty);
      this.realized += take * (price - lot.costPerUnit);
      lot.qty -= take;
      remaining -= take;
      if (lot.qty <= EPS) this.lots.shift();
    }
  }

  unrealized(pricePerUnit) {
    const price = num(pricePerUnit, 0);
    return this.lots.reduce((s, l) => s + l.qty * (price - l.costPerUnit), 0);
  }

  totalPnl(pricePerUnit) {
    return this.realized + this.unrealized(pricePerUnit);
  }
}

class FifoUsdLedger {
  constructor() {
    this.lots = [];
    this.realized = 0;
  }

  notional() {
    return this.lots.reduce((s, l) => s + l.notional, 0);
  }

  addNotional(notional, cost) {
    const n = num(notional, 0);
    const c = num(cost, 0);
    if (n <= EPS || c < 0) return;
    this.lots.push({ notional: n, cost: c });
  }

  removeNotional(notional) {
    let remaining = num(notional, 0);
    if (remaining <= EPS) return;
    while (remaining > EPS && this.lots.length) {
      const lot = this.lots[0];
      const take = Math.min(remaining, lot.notional);
      const costPart = lot.cost * (take / lot.notional);
      this.realized += take - costPart;
      lot.notional -= take;
      lot.cost -= costPart;
      remaining -= take;
      if (lot.notional <= EPS) this.lots.shift();
    }
  }

  unrealized(currentNotional) {
    const mark = num(currentNotional, 0);
    const cost = this.lots.reduce((s, l) => s + l.cost, 0);
    return mark - cost;
  }

  totalPnl(currentNotional) {
    return this.realized + this.unrealized(currentNotional);
  }
}

function processQtyTransition(ledger, prevAmt, prevVal, nextAmt, nextVal) {
  const pAmt = num(prevAmt, 0);
  const pVal = num(prevVal, 0);
  const nAmt = num(nextAmt, 0);
  const nVal = num(nextVal, 0);
  const nextPrice = nAmt > EPS ? nVal / nAmt : 0;
  const prevPrice = pAmt > EPS ? pVal / pAmt : 0;

  if (pAmt <= EPS && nAmt > EPS) {
    ledger.addLot(nAmt, nVal);
    return;
  }
  if (pAmt > EPS && nAmt <= EPS) {
    ledger.sellQty(pAmt, prevPrice > EPS ? prevPrice : nextPrice);
    return;
  }
  if (nAmt + EPS < pAmt) {
    ledger.sellQty(pAmt - nAmt, nextPrice);
  } else if (nAmt > pAmt + EPS) {
    const addQty = nAmt - pAmt;
    ledger.addLot(addQty, addQty * nextPrice);
  }
}

function processUsdTransition(ledger, prevVal, nextVal) {
  const pVal = num(prevVal, 0);
  const nVal = num(nextVal, 0);
  if (pVal <= EPS && nVal > EPS) {
    ledger.addNotional(nVal, nVal);
    return;
  }
  if (pVal > EPS && nVal <= EPS) {
    ledger.removeNotional(pVal);
    return;
  }
  if (nVal + EPS < pVal) {
    ledger.removeNotional(pVal - nVal);
  } else if (nVal > pVal + EPS) {
    ledger.addNotional(nVal - pVal, nVal - pVal);
  }
}

function snapshotFingerprint(kind, snap) {
  if (kind === 'wallet') {
    return JSON.stringify(normalizeTokensForPnl(snap.tokens || []).sort((a, b) => a.symbol.localeCompare(b.symbol)));
  }
  const positions = snap.positions || {};
  const keys = Object.keys(positions).filter(k => !isProtocolMetaKey(k)).sort();
  return JSON.stringify(keys.map(k => [k, num(positions[k], 0)]));
}

function dedupePnlSnapshots(snapshots) {
  const sorted = (snapshots || [])
    .filter(s => s && Number.isFinite(num(s.ts, NaN)))
    .map(s => ({ ...s, ts: num(s.ts) }))
    .sort((a, b) => a.ts - b.ts);
  const out = [];
  let lastFp = null;
  for (const snap of sorted) {
    const kind = snap.tokens ? 'wallet' : 'protocol';
    const fp = snapshotFingerprint(kind, snap);
    if (fp === lastFp && out.length) continue;
    out.push(snap);
    lastFp = fp;
  }
  return out;
}

function aggregateWalletTotal(trackers, tokenMap) {
  let total = 0;
  const seen = new Set();
  for (const [sym, t] of tokenMap) {
    seen.add(sym);
    const ledger = trackers.get(sym);
    if (!ledger) continue;
    const price = num(t.amount, 0) > EPS ? num(t.value, 0) / num(t.amount, 0) : 0;
    total += ledger.totalPnl(price);
  }
  for (const [sym, ledger] of trackers) {
    if (!seen.has(sym)) total += ledger.realized;
  }
  return total;
}

function aggregateProtocolTotal(trackers, positionMap) {
  let total = 0;
  const seen = new Set();
  for (const [key, val] of Object.entries(positionMap || {})) {
    if (isProtocolMetaKey(key)) continue;
    seen.add(key);
    const ledger = trackers.get(key);
    if (!ledger) continue;
    total += ledger.totalPnl(num(val, 0));
  }
  for (const [key, ledger] of trackers) {
    if (!seen.has(key)) total += ledger.realized;
  }
  return total;
}

function formatPointLabel(ts) {
  if (!Number.isFinite(ts)) return '';
  return new Date(ts).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function computeWalletPnlSeries(snapshots) {
  const series = dedupePnlSnapshots(snapshots);
  if (!series.length) return { points: [], total: 0 };

  const trackers = new Map();
  const points = [];
  let prevMap = new Map();

  for (const snap of series) {
    const tokenMap = tokensToMap(snap.tokens || []);
    const keys = new Set([...prevMap.keys(), ...tokenMap.keys()]);
    for (const sym of keys) {
      const prev = prevMap.get(sym) || { amount: 0, value: 0 };
      const next = tokenMap.get(sym) || { amount: 0, value: 0 };
      if (!trackers.has(sym)) trackers.set(sym, new FifoQtyLedger());
      processQtyTransition(
        trackers.get(sym),
        prev.amount,
        prev.value,
        next.amount,
        next.value
      );
    }
    const totalPnl = aggregateWalletTotal(trackers, tokenMap);
    points.push({ ts: snap.ts, totalPnl, label: formatPointLabel(snap.ts) });
    prevMap = tokenMap;
  }

  const total = points.length ? points[points.length - 1].totalPnl : 0;
  return { points, total };
}

function computeProtocolPnlSeries(snapshots) {
  const series = dedupePnlSnapshots(snapshots);
  if (!series.length) return { points: [], total: 0 };

  const trackers = new Map();
  const points = [];
  let prevPositions = {};

  for (const snap of series) {
    const positions = snap.positions || {};
    const keys = new Set([
      ...Object.keys(prevPositions).filter(k => !isProtocolMetaKey(k)),
      ...Object.keys(positions).filter(k => !isProtocolMetaKey(k)),
    ]);
    for (const key of keys) {
      const prevVal = num(prevPositions[key], 0);
      const nextVal = num(positions[key], 0);
      if (!trackers.has(key)) trackers.set(key, new FifoUsdLedger());
      processUsdTransition(trackers.get(key), prevVal, nextVal);
    }
    const active = {};
    for (const [key, val] of Object.entries(positions)) {
      if (!isProtocolMetaKey(key)) active[key] = num(val, 0);
    }
    const totalPnl = aggregateProtocolTotal(trackers, active);
    points.push({ ts: snap.ts, totalPnl, label: formatPointLabel(snap.ts) });
    prevPositions = positions;
  }

  const total = points.length ? points[points.length - 1].totalPnl : 0;
  return { points, total };
}

const DefiPnl = {
  EPS,
  FifoQtyLedger,
  FifoUsdLedger,
  normalizeTokenSymbol,
  normalizeTokensForPnl,
  tokensToMap,
  isProtocolMetaKey,
  processQtyTransition,
  processUsdTransition,
  dedupePnlSnapshots,
  computeWalletPnlSeries,
  computeProtocolPnlSeries,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = DefiPnl;
}
if (typeof window !== 'undefined') {
  window.DefiPnl = DefiPnl;
}

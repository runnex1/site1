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

function positionMetricValue(metric) {
  if (metric == null) return 0;
  if (typeof metric === 'number') return num(metric, 0);
  return num(metric.value, 0);
}

function positionMetricQty(metric) {
  if (metric == null || typeof metric === 'number') return null;
  const q = num(metric.qty, NaN);
  return Number.isFinite(q) && q > 0 ? q : null;
}

function normalizeProtocolPositionMap(positions) {
  const out = {};
  for (const [key, raw] of Object.entries(positions || {})) {
    if (isProtocolMetaKey(key)) continue;
    out[key] = {
      value: positionMetricValue(raw),
      qty: positionMetricQty(raw),
    };
  }
  return out;
}

function isProtocolBorrowLegKey(key) {
  return String(key || '').toLowerCase().includes(':borrowed:');
}

/** Collapse legacy import leg maps to one net-equity row per protocol. */
function aggregateProtocolImportPositionsToNet(positions) {
  const byProtocol = {};
  for (const [key, raw] of Object.entries(positions || {})) {
    if (isProtocolMetaKey(key)) continue;
    const protocol = String(key.split('|||')[0] || '').trim();
    if (!protocol) continue;
    const val = positionMetricValue(raw);
    if (val <= EPS) continue;
    if (isProtocolBorrowLegKey(key)) byProtocol[protocol] = (byProtocol[protocol] || 0) - val;
    else byProtocol[protocol] = (byProtocol[protocol] || 0) + val;
  }
  const out = {};
  for (const [name, value] of Object.entries(byProtocol)) {
    out[`${name}|||__pnl__`] = { value, qty: null };
  }
  return out;
}

const PROTOCOL_PNL_BUCKET_MS = 6 * 3600 * 1000;

/** Keep one snapshot per 6h bucket; later sources win (weekly/current over noisy imports). */
function dedupeProtocolPnlTimeline(snapshots) {
  const sorted = dedupePnlSnapshots(snapshots).sort((a, b) => a.ts - b.ts);
  const out = [];
  for (const snap of sorted) {
    const last = out[out.length - 1];
    if (last && snap.ts - last.ts < PROTOCOL_PNL_BUCKET_MS) out[out.length - 1] = snap;
    else out.push(snap);
  }
  return out;
}

/** Single-step value jump at or above this ratio is treated as a capital deposit (new lot). */
const PROTOCOL_DEPOSIT_JUMP_RATIO = 0.35;

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

  closeAtMark(markValue) {
    const mark = num(markValue, 0);
    if (mark <= EPS) {
      this.lots = [];
      return;
    }
    this.realized += this.unrealized(mark);
    this.lots = [];
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

function processUsdTransition(ledger, prevMetric, nextMetric) {
  const pVal = positionMetricValue(prevMetric);
  const nVal = positionMetricValue(nextMetric);
  const pQty = positionMetricQty(prevMetric);
  const nQty = positionMetricQty(nextMetric);

  if (pVal <= EPS && nVal > EPS) {
    ledger.addNotional(nVal, nVal);
    return;
  }
  if (pVal > EPS && nVal <= EPS) {
    ledger.closeAtMark(pVal);
    return;
  }
  if (nVal + EPS < pVal) {
    ledger.removeNotional(pVal - nVal);
    return;
  }
  if (nVal > pVal + EPS) {
    const delta = nVal - pVal;
    let depositUsd = 0;
    if (pQty != null && nQty != null && nQty > pQty + EPS) {
      const price = nVal / nQty;
      depositUsd = (nQty - pQty) * price;
    } else if (pVal > EPS && delta / pVal >= PROTOCOL_DEPOSIT_JUMP_RATIO) {
      depositUsd = delta;
    }
    if (depositUsd > EPS) {
      ledger.addNotional(depositUsd, depositUsd);
    }
  }
}

function snapshotFingerprint(kind, snap) {
  if (kind === 'wallet') {
    return JSON.stringify(normalizeTokensForPnl(snap.tokens || []).sort((a, b) => a.symbol.localeCompare(b.symbol)));
  }
  const positions = snap.positions || {};
  const keys = Object.keys(positions).filter(k => !isProtocolMetaKey(k)).sort();
  return JSON.stringify(keys.map(k => {
    const m = positions[k];
    return [k, positionMetricValue(m), positionMetricQty(m)];
  }));
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
  const normalized = typeof positionMap === 'object' && !Array.isArray(positionMap)
    && Object.values(positionMap).some(v => v && typeof v === 'object' && 'value' in v)
      ? positionMap
      : normalizeProtocolPositionMap(positionMap);
  for (const [key, metric] of Object.entries(normalized)) {
    if (isProtocolMetaKey(key)) continue;
    seen.add(key);
    const ledger = trackers.get(key);
    if (!ledger) continue;
    total += ledger.totalPnl(positionMetricValue(metric));
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
    const positions = normalizeProtocolPositionMap(snap.positions || {});
    const keys = new Set([
      ...Object.keys(prevPositions),
      ...Object.keys(positions),
    ]);
    for (const key of keys) {
      const prevMetric = prevPositions[key] || { value: 0, qty: null };
      const nextMetric = positions[key] || { value: 0, qty: null };
      if (!trackers.has(key)) trackers.set(key, new FifoUsdLedger());
      processUsdTransition(trackers.get(key), prevMetric, nextMetric);
    }
    const totalPnl = aggregateProtocolTotal(trackers, positions);
    points.push({ ts: snap.ts, totalPnl, label: formatPointLabel(snap.ts) });
    prevPositions = positions;
  }

  const total = points.length ? points[points.length - 1].totalPnl : 0;
  return { points, total };
}

const PROTOCOL_PNL_MAX_MOVE_PCT = 1.2;

/**
 * Sum net-value deltas vs a snapshot for protocols that exist in both, have APY,
 * and moved less than maxMovePct (excludes deposits/withdrawals).
 */
function computeProtocolSnapshotDeltaPnl(pairs, { maxMovePct = PROTOCOL_PNL_MAX_MOVE_PCT } = {}) {
  let total = 0;
  let count = 0;
  for (const row of pairs || []) {
    const currentNet = num(row.currentNet, NaN);
    const snapshotNet = num(row.snapshotNet, NaN);
    if (!Number.isFinite(currentNet) || !Number.isFinite(snapshotNet)) continue;
    const apyRaw = row.apy;
    if (apyRaw == null || apyRaw === '' || !Number.isFinite(Number(apyRaw))) continue;
    const apy = Number(apyRaw);
    const base = Math.abs(snapshotNet);
    if (base <= EPS) continue;
    const delta = currentNet - snapshotNet;
    const movePct = Math.abs(delta) / base * 100;
    if (movePct >= maxMovePct) continue;
    total += delta;
    count += 1;
  }
  return { total, count };
}

function buildProtocolSnapshotPnlSeries(snapshotTs, totalPnl, endTs = Date.now()) {
  const start = num(snapshotTs, Date.now());
  const end = num(endTs, Date.now());
  const total = num(totalPnl, 0);
  return {
    points: [
      { ts: start, totalPnl: 0, label: formatPointLabel(start) },
      { ts: end, totalPnl: total, label: formatPointLabel(end) },
    ],
    total,
  };
}

const DefiPnl = {
  EPS,
  FifoQtyLedger,
  FifoUsdLedger,
  normalizeTokenSymbol,
  normalizeTokensForPnl,
  tokensToMap,
  isProtocolMetaKey,
  positionMetricValue,
  positionMetricQty,
  normalizeProtocolPositionMap,
  isProtocolBorrowLegKey,
  aggregateProtocolImportPositionsToNet,
  dedupeProtocolPnlTimeline,
  PROTOCOL_PNL_BUCKET_MS,
  PROTOCOL_PNL_MAX_MOVE_PCT,
  computeProtocolSnapshotDeltaPnl,
  buildProtocolSnapshotPnlSeries,
  PROTOCOL_DEPOSIT_JUMP_RATIO,
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

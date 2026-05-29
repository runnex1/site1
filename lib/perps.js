/**
 * Perps DEX helpers — Hyperliquid + Nado (read-only, no API keys).
 */

const HL_INFO = 'https://api.hyperliquid.xyz/info';
const NADO_GATEWAY = 'https://gateway.prod.nado.xyz/v1';
const NADO_ARCHIVE = 'https://archive.prod.nado.xyz/v1';

const X18 = 1e18;

function fromX18(v) {
  if (v == null || v === '') return 0;
  return Number(v) / X18;
}

function toBaseSymbol(symbol) {
  return String(symbol || '').replace(/-PERP$/i, '');
}

function nadoSubaccount(wallet, name = 'default') {
  const addr = String(wallet || '').toLowerCase().replace(/^0x/, '');
  if (!/^[\da-f]{40}$/.test(addr)) throw new Error('Invalid wallet address');
  const nameHex = Buffer.from(name, 'utf8').toString('hex').padEnd(24, '0').slice(0, 24);
  return '0x' + addr + nameHex;
}

async function hlPost(body) {
  const r = await fetch(HL_INFO, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Hyperliquid HTTP ${r.status}`);
  return r.json();
}

async function nadoQuery(params) {
  const qs = new URLSearchParams(params);
  const r = await fetch(`${NADO_GATEWAY}/query?${qs}`);
  if (!r.ok) throw new Error(`Nado gateway HTTP ${r.status}`);
  const data = await r.json();
  if (data.status !== 'success') throw new Error(data.error || 'Nado query failed');
  return data.data;
}

async function nadoArchive(body) {
  const r = await fetch(NADO_ARCHIVE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Nado archive HTTP ${r.status}`);
  return r.json();
}

let _nadoSymbolCache = null;
let _nadoSymbolCacheAt = 0;

async function nadoSymbolMap() {
  if (_nadoSymbolCache && Date.now() - _nadoSymbolCacheAt < 300000) return _nadoSymbolCache;
  const data = await nadoQuery({ type: 'symbols' });
  const map = { idToSymbol: {}, symbolToId: {} };
  for (const [symbol, meta] of Object.entries(data.symbols || {})) {
    if (meta.type !== 'perp') continue;
    map.idToSymbol[meta.product_id] = symbol;
    map.symbolToId[symbol] = meta.product_id;
    const base = symbol.replace(/-PERP$/i, '');
    map.symbolToId[base] = meta.product_id;
  }
  _nadoSymbolCache = map;
  _nadoSymbolCacheAt = Date.now();
  return map;
}

async function fetchHyperliquidState(wallet) {
  const state = await hlPost({ type: 'clearinghouseState', user: wallet });
  const positions = (state.assetPositions || [])
    .filter(p => Math.abs(parseFloat(p.position?.szi || 0)) > 0)
    .map(p => {
      const pos = p.position;
      return {
        venue: 'hyperliquid',
        symbol: pos.coin,
        size: parseFloat(pos.szi),
        side: parseFloat(pos.szi) >= 0 ? 'long' : 'short',
        entryPx: parseFloat(pos.entryPx || 0),
        markPx: null,
        notional: parseFloat(pos.positionValue || 0),
        unrealizedPnl: parseFloat(pos.unrealizedPnl || 0),
        cumFundingAllTime: parseFloat(pos.cumFunding?.allTime || 0),
        cumFundingSinceOpen: parseFloat(pos.cumFunding?.sinceOpen || 0),
        leverage: pos.leverage?.value ? parseFloat(pos.leverage.value) : null,
      };
    });

  return {
    venue: 'hyperliquid',
    wallet,
    accountValue: parseFloat(state.marginSummary?.accountValue || 0),
    withdrawable: parseFloat(state.withdrawable || 0),
    positions,
  };
}

async function fetchHyperliquidFunding(wallet, days = 30) {
  const startTime = Date.now() - days * 86400000;
  const rows = await hlPost({ type: 'userFunding', user: wallet, startTime });
  const payments = (Array.isArray(rows) ? rows : []).map(row => {
    const d = row.delta || {};
    return {
      venue: 'hyperliquid',
      time: row.time,
      symbol: d.coin,
      fundingRate: parseFloat(d.fundingRate || 0),
      size: parseFloat(d.szi || 0),
      usdc: parseFloat(d.usdc || 0),
    };
  });
  const total = payments.reduce((s, p) => s + p.usdc, 0);
  return { venue: 'hyperliquid', wallet, days, payments, totalFunding: total };
}

async function fetchHyperliquidFills(wallet, days = 30) {
  const startTime = Date.now() - days * 86400000;
  const rows = await hlPost({ type: 'userFills', user: wallet });
  const fills = (Array.isArray(rows) ? rows : [])
    .filter(f => Number(f.time) >= startTime)
    .map(f => ({
      venue: 'hyperliquid',
      time: f.time,
      symbol: f.coin,
      px: parseFloat(f.px || 0),
      sz: parseFloat(f.sz || 0),
      side: f.side,
      dir: f.dir,
      fee: parseFloat(f.fee || 0),
      closedPnl: parseFloat(f.closedPnl || 0),
    }));
  const totalFees = fills.reduce((s, f) => s + f.fee, 0);
  const totalRealized = fills.reduce((s, f) => s + f.closedPnl, 0);
  return { venue: 'hyperliquid', wallet, days, fills, totalFees, totalRealized };
}

async function fetchHyperliquidRates() {
  const data = await hlPost({ type: 'metaAndAssetCtxs' });
  const universe = data[0]?.universe || [];
  const ctxs = data[1] || [];
  return universe.map((u, i) => ({
    venue: 'hyperliquid',
    symbol: u.name,
    fundingRate8h: parseFloat(ctxs[i]?.funding || 0),
    markPx: parseFloat(ctxs[i]?.markPx || 0),
    openInterest: parseFloat(ctxs[i]?.openInterest || 0),
  }));
}

async function fetchNadoPositionEvents(subaccount, productIds) {
  if (!productIds.length) return {};
  const data = await nadoArchive({
    events: {
      subaccounts: [subaccount],
      product_ids: productIds,
      limit: { raw: 1 },
    },
  });
  const map = {};
  for (const ev of data.events || []) {
    const perp = ev.post_balance?.perp;
    if (!perp) continue;
    const productId = perp.product_id ?? ev.product_id;
    const amount = fromX18(perp.balance?.amount);
    const netEntryUnrealized = fromX18(ev.net_entry_unrealized);
    map[productId] = {
      entryPx: amount !== 0 ? Math.abs(netEntryUnrealized / amount) : null,
      netEntryUnrealized,
    };
  }
  return map;
}

async function fetchNadoState(wallet, subaccountName = 'default') {
  const subaccount = nadoSubaccount(wallet, subaccountName);
  const [symMap, info] = await Promise.all([
    nadoSymbolMap(),
    nadoQuery({ type: 'subaccount_info', subaccount }),
  ]);

  const openBalances = (info.perp_balances || []).filter(b => Math.abs(fromX18(b.balance?.amount)) > 1e-12);
  const productIds = openBalances.map(b => b.product_id);
  const pnlByProduct = await fetchNadoPositionEvents(subaccount, productIds);

  const oracleByProduct = Object.fromEntries(
    (info.perp_products || []).map(p => [p.product_id, fromX18(p.oracle_price_x18)])
  );

  const positions = openBalances
    .map(b => {
      const amount = fromX18(b.balance?.amount);
      const symbol = symMap.idToSymbol[b.product_id] || `PID${b.product_id}`;
      const pnl = pnlByProduct[b.product_id];
      const oracle = oracleByProduct[b.product_id] ?? null;
      const unrealizedPnl = pnl && oracle != null
        ? amount * oracle - pnl.netEntryUnrealized
        : null;
      return {
        venue: 'nado',
        productId: b.product_id,
        symbol,
        size: amount,
        side: amount >= 0 ? 'long' : 'short',
        entryPx: pnl?.entryPx ?? null,
        markPx: oracle,
        notional: oracle != null ? Math.abs(amount * oracle) : null,
        unrealizedPnl,
        vQuoteBalance: fromX18(b.balance?.v_quote_balance),
        lastCumulativeFunding: fromX18(b.balance?.last_cumulative_funding_x18),
      };
    })
    .filter(Boolean);

  const health = (info.healths || [])[0];
  return {
    venue: 'nado',
    wallet,
    subaccount,
    exists: !!info.exists,
    accountValue: health ? fromX18(health.assets || health.asset_value) : null,
    health: health ? fromX18(health.health) : null,
    positions,
  };
}

async function fetchNadoFunding(wallet, days = 30, subaccountName = 'default') {
  const subaccount = nadoSubaccount(wallet, subaccountName);
  const symMap = await nadoSymbolMap();
  const productIds = Object.keys(symMap.idToSymbol).map(Number);
  const sinceSec = Math.floor(Date.now() / 1000) - days * 86400;

  const payments = [];
  let maxIdx = undefined;
  for (let page = 0; page < 20; page++) {
    const body = {
      interest_and_funding: {
        subaccount,
        product_ids: productIds.slice(0, 32),
        limit: 100,
        ...(maxIdx != null ? { max_idx: maxIdx } : {}),
      },
    };
    const data = await nadoArchive(body);
    let oldestInPage = Infinity;
    for (const p of data.funding_payments || []) {
      const ts = Number(p.timestamp || 0);
      oldestInPage = Math.min(oldestInPage, ts);
      if (ts >= sinceSec) {
        payments.push({
          venue: 'nado',
          time: ts * 1000,
          symbol: symMap.idToSymbol[p.product_id] || `PID${p.product_id}`,
          productId: p.product_id,
          fundingRate: fromX18(p.rate_x18),
          size: fromX18(p.balance_amount),
          usdc: fromX18(p.amount),
        });
      }
    }
    if (data.next_idx == null) break;
    maxIdx = data.next_idx;
    if (!(data.funding_payments || []).length) break;
    if (oldestInPage < sinceSec) break;
  }

  payments.sort((a, b) => b.time - a.time);
  const total = payments.reduce((s, p) => s + p.usdc, 0);
  return { venue: 'nado', wallet, subaccount, days, payments, totalFunding: total };
}

async function fetchNadoMatches(wallet, days = 30, subaccountName = 'default') {
  const subaccount = nadoSubaccount(wallet, subaccountName);
  const symMap = await nadoSymbolMap();
  const productIds = Object.keys(symMap.idToSymbol).map(Number);
  const sinceSec = Math.floor(Date.now() / 1000) - days * 86400;

  const matches = [];
  let maxIdx = undefined;
  for (let page = 0; page < 30; page++) {
    const body = {
      matches: {
        subaccounts: [subaccount],
        product_ids: productIds.slice(0, 32),
        limit: 100,
        ...(maxIdx != null ? { max_idx: maxIdx } : {}),
      },
    };
    const data = await nadoArchive(body);
    const rows = data.matches || [];
    const tsByIdx = Object.fromEntries(
      (data.txs || []).map(tx => [String(tx.submission_idx), Number(tx.timestamp || 0)])
    );
    if (!rows.length) break;

    let oldestTs = Infinity;
    for (const m of rows) {
      const idx = String(m.submission_idx);
      const tsSec = tsByIdx[idx] || 0;
      oldestTs = Math.min(oldestTs, tsSec || Infinity);
      if (tsSec && tsSec < sinceSec) continue;

      const productId = m.pre_balance?.base?.perp?.product_id
        ?? m.post_balance?.base?.perp?.product_id
        ?? null;
      const symbol = symMap.idToSymbol[productId] || `PID${productId}`;
      const fee = fromX18(m.fee);
      const realizedPnl = fromX18(m.realized_pnl || 0);
      const baseFilled = fromX18(m.base_filled);
      const quoteFilled = fromX18(m.quote_filled);
      const px = baseFilled !== 0 ? Math.abs(quoteFilled / baseFilled) : fromX18(m.order?.priceX18);

      matches.push({
        venue: 'nado',
        time: tsSec ? tsSec * 1000 : 0,
        submissionIdx: idx,
        symbol,
        productId,
        px,
        size: baseFilled,
        fee,
        realizedPnl,
        isTaker: !!m.is_taker,
      });
    }

    if (data.next_idx == null) break;
    maxIdx = data.next_idx;
    if (rows.length < 100) break;
    if (oldestTs < sinceSec) break;
  }

  const totalFees = matches.reduce((s, m) => s + m.fee, 0);
  const totalRealized = matches.reduce((s, m) => s + m.realizedPnl, 0);
  return { venue: 'nado', wallet, subaccount, days, matches, totalFees, totalRealized };
}

async function fetchNadoRates() {
  const symMap = await nadoSymbolMap();
  const productIds = Object.keys(symMap.idToSymbol).map(Number);
  const data = await nadoArchive({ funding_rates: { product_ids: productIds } });
  const rates = [];
  for (const [pid, row] of Object.entries(data || {})) {
    if (!row || typeof row !== 'object') continue;
    const productId = Number(row.product_id || pid);
    rates.push({
      venue: 'nado',
      symbol: symMap.idToSymbol[productId] || `PID${productId}`,
      productId,
      fundingRateDaily: fromX18(row.funding_rate_x18),
      updateTime: Number(row.update_time || 0) * 1000,
    });
  }
  return rates;
}

function sumByBase(items, amountKey, symbolKey = 'symbol') {
  const map = {};
  for (const item of items) {
    const base = toBaseSymbol(item[symbolKey]);
    map[base] = (map[base] || 0) + (item[amountKey] || 0);
  }
  return map;
}

function buildFundingCumulativeSeries(hlPayments, nadoPayments, days, pairedBases = null) {
  const dayMap = {};
  const allow = pairedBases ? new Set(pairedBases) : null;
  const add = (payments) => {
    for (const p of payments) {
      if (allow && !allow.has(toBaseSymbol(p.symbol))) continue;
      const day = new Date(p.time).toISOString().slice(0, 10);
      dayMap[day] = (dayMap[day] || 0) + p.usdc;
    }
  };
  add(hlPayments);
  add(nadoPayments);

  const startMs = Date.now() - days * 86400000;
  const daysSorted = Object.keys(dayMap).sort();
  let cumFunding = 0;
  const points = [];
  for (const day of daysSorted) {
    const ts = new Date(day + 'T12:00:00Z').getTime();
    if (ts < startMs - 86400000) continue;
    cumFunding += dayMap[day];
    points.push({ ts, day, dailyFunding: dayMap[day], cumFunding });
  }
  return points;
}

function buildNetArbSeries(fundingPoints, totalFees, days) {
  if (!fundingPoints.length) return [];
  const feePerDay = totalFees / Math.max(days, 1);
  let cumFees = 0;
  return fundingPoints.map((p, i) => {
    cumFees += feePerDay;
    return {
      ...p,
      cumNetArb: p.cumFunding - cumFees,
    };
  });
}

function buildPairedAnalysis({
  hlState,
  nadoState,
  hlFunding,
  nadoFunding,
  hlFills,
  nadoMatches,
  spreadRows,
  days,
}) {
  const hlByBase = Object.fromEntries(hlState.positions.map(p => [toBaseSymbol(p.symbol), p]));
  const nadoByBase = Object.fromEntries(nadoState.positions.map(p => [toBaseSymbol(p.symbol), p]));
  const spreadByBase = Object.fromEntries(spreadRows.map(r => [r.symbol, r]));

  const fundingHl = sumByBase(hlFunding.payments, 'usdc');
  const fundingNado = sumByBase(nadoFunding.payments, 'usdc');
  const feesHl = sumByBase(hlFills.fills, 'fee');
  const feesNado = sumByBase(nadoMatches.matches, 'fee');
  const realizedHl = sumByBase(hlFills.fills, 'closedPnl');
  const realizedNado = sumByBase(nadoMatches.matches, 'realizedPnl');

  const paired = [];
  const unhedged = [];

  const allBases = new Set([
    ...Object.keys(hlByBase),
    ...Object.keys(nadoByBase),
  ]);

  for (const base of [...allBases].sort()) {
    const hl = hlByBase[base];
    const na = nadoByBase[base];
    if (hl && na) {
      const hlUpnl = hl.unrealizedPnl ?? 0;
      const naUpnl = na.unrealizedPnl ?? 0;
      const combinedUpnl = hlUpnl + naUpnl;
      const hlSize = Math.abs(hl.size);
      const naSize = Math.abs(na.size);
      const maxSize = Math.max(hlSize, naSize, 1);
      const sizeMismatchPct = (Math.abs(hlSize - naSize) / maxSize) * 100;
      const matchedSize = Math.min(hlSize, naSize);
      const entrySlippage = hl.entryPx && na.entryPx != null
        ? (na.entryPx - hl.entryPx) * matchedSize
        : null;
      const avgNotional = ((hl.notional || 0) + (na.notional || 0)) / 2;
      const funding = (fundingHl[base] || 0) + (fundingNado[base] || 0);
      const fees = (feesHl[base] || 0) + (feesNado[base] || 0);
      const realized = (realizedHl[base] || 0) + (realizedNado[base] || 0);
      const netArbPnl = funding + combinedUpnl + realized - fees;
      const spread = spreadByBase[base];
      const currentSpread8h = spread?.spread8h ?? null;
      const periodsInWindow = (days * 3);
      const breakEvenSpread8h = avgNotional > 0 && periodsInWindow > 0
        ? (fees + Math.abs(entrySlippage || 0)) / (avgNotional * periodsInWindow)
        : null;
      const alerts = [];
      if (sizeMismatchPct > 1) alerts.push('size_mismatch');
      if (Math.abs(combinedUpnl) > 500) alerts.push('basis_drift');
      if (breakEvenSpread8h != null && currentSpread8h != null && currentSpread8h < breakEvenSpread8h) {
        alerts.push('spread_below_breakeven');
      }

      paired.push({
        symbol: base,
        hlSize: hl.size,
        nadoSize: na.size,
        hlEntry: hl.entryPx,
        nadoEntry: na.entryPx,
        hlUpnl,
        nadoUpnl: naUpnl,
        combinedUpnl,
        sizeMismatchPct,
        entrySlippage,
        avgNotional,
        funding,
        fees,
        realized,
        netArbPnl,
        currentSpread8h,
        breakEvenSpread8h,
        spreadCoversBreakeven: breakEvenSpread8h == null || currentSpread8h == null
          ? null
          : currentSpread8h >= breakEvenSpread8h,
        alerts,
        hl,
        nado: na,
      });
    } else if (hl) {
      unhedged.push({
        symbol: base,
        venue: 'hyperliquid',
        size: hl.size,
        side: hl.side,
        notional: hl.notional,
        unrealizedPnl: hl.unrealizedPnl,
        funding: fundingHl[base] || 0,
        fees: feesHl[base] || 0,
      });
    } else if (na) {
      unhedged.push({
        symbol: base,
        venue: 'nado',
        size: na.size,
        side: na.side,
        notional: na.notional,
        unrealizedPnl: na.unrealizedPnl,
        funding: fundingNado[base] || 0,
        fees: feesNado[base] || 0,
      });
    }
  }

  const combinedUpnl = paired.reduce((s, p) => s + p.combinedUpnl, 0);
  const pairedFunding = paired.reduce((s, p) => s + p.funding, 0);
  const pairedFees = paired.reduce((s, p) => s + p.fees, 0);
  const pairedRealized = paired.reduce((s, p) => s + p.realized, 0);
  const totalFees = hlFills.totalFees + nadoMatches.totalFees;
  const totalRealized = hlFills.totalRealized + nadoMatches.totalRealized;
  const totalEntrySlippage = paired.reduce((s, p) => s + (p.entrySlippage || 0), 0);
  const netFunding = hlFunding.totalFunding + nadoFunding.totalFunding;
  const netArbPnl = pairedFunding + combinedUpnl + pairedRealized - pairedFees;
  const avgNotional = paired.reduce((s, p) => s + p.avgNotional, 0) || 0;
  const netFundingApr = avgNotional > 0 ? (pairedFunding / avgNotional) * (365 / days) * 100 : null;
  const netArbApr = avgNotional > 0 ? ((pairedFunding - pairedFees) / avgNotional) * (365 / days) * 100 : null;

  return {
    paired,
    unhedged,
    combinedUpnl,
    pairedFunding,
    pairedFees,
    pairedRealized,
    totalFees,
    totalRealized,
    totalEntrySlippage,
    netFunding,
    netArbPnl,
    avgNotional,
    netFundingApr,
    netArbApr,
  };
}

async function fetchPerpsDashboard(wallets) {
  const hlWallet = wallets.hyperliquid;
  const nadoWallet = wallets.nado || hlWallet;
  const days = wallets.days || 30;

  const [
    hlState,
    nadoState,
    hlFunding,
    nadoFunding,
    hlFills,
    nadoMatches,
    hlRates,
    nadoRates,
  ] = await Promise.all([
    fetchHyperliquidState(hlWallet),
    fetchNadoState(nadoWallet),
    fetchHyperliquidFunding(hlWallet, days),
    fetchNadoFunding(nadoWallet, days),
    fetchHyperliquidFills(hlWallet, days),
    fetchNadoMatches(nadoWallet, days),
    fetchHyperliquidRates(),
    fetchNadoRates(),
  ]);

  const hlRateBySymbol = Object.fromEntries(hlRates.map(r => [r.symbol, r]));
  const nadoRateByBase = {};
  for (const r of nadoRates) {
    const base = r.symbol.replace(/-PERP$/i, '');
    nadoRateByBase[base] = r;
  }

  const spreadRows = [];
  const bases = new Set([
    ...hlState.positions.map(p => p.symbol),
    ...nadoState.positions.map(p => p.symbol.replace(/-PERP$/i, '')),
    'BTC', 'ETH', 'SOL',
  ]);
  for (const base of bases) {
    const hl = hlRateBySymbol[base];
    const na = nadoRateByBase[base];
    if (!hl && !na) continue;
    const hl8h = hl?.fundingRate8h ?? null;
    const naDaily = na?.fundingRateDaily ?? null;
    const na8h = naDaily != null ? naDaily / 3 : null;
    spreadRows.push({
      symbol: base,
      hyperliquid8h: hl8h,
      nado8h: na8h,
      spread8h: hl8h != null && na8h != null ? hl8h - na8h : null,
    });
  }

  const arb = buildPairedAnalysis({
    hlState,
    nadoState,
    hlFunding,
    nadoFunding,
    hlFills,
    nadoMatches,
    spreadRows,
    days,
  });

  const fundingSeries = buildFundingCumulativeSeries(
    hlFunding.payments,
    nadoFunding.payments,
    days,
    arb.paired.map(p => p.symbol)
  );
  const netArbSeries = buildNetArbSeries(fundingSeries, arb.pairedFees, days);

  return {
    fetchedAt: Date.now(),
    days,
    wallets: { hyperliquid: hlWallet, nado: nadoWallet },
    hyperliquid: { state: hlState, funding: hlFunding, fills: hlFills },
    nado: { state: nadoState, funding: nadoFunding, matches: nadoMatches },
    rateSpread: spreadRows.sort((a, b) => a.symbol.localeCompare(b.symbol)),
    paired: arb.paired,
    unhedged: arb.unhedged,
    fundingSeries,
    netArbSeries,
    summary: {
      hlFundingTotal: hlFunding.totalFunding,
      nadoFundingTotal: nadoFunding.totalFunding,
      netFundingTotal: hlFunding.totalFunding + nadoFunding.totalFunding,
      hlPositionCount: hlState.positions.length,
      nadoPositionCount: nadoState.positions.length,
      hlAccountValue: hlState.accountValue,
      nadoAccountValue: nadoState.accountValue,
      nadoExists: nadoState.exists,
      combinedUpnl: arb.combinedUpnl,
      pairedFunding: arb.pairedFunding,
      pairedFees: arb.pairedFees,
      pairedRealized: arb.pairedRealized,
      totalFees: arb.totalFees,
      hlFees: hlFills.totalFees,
      nadoFees: nadoMatches.totalFees,
      totalRealized: arb.totalRealized,
      totalEntrySlippage: arb.totalEntrySlippage,
      netArbPnl: arb.netArbPnl,
      avgNotional: arb.avgNotional,
      netFundingApr: arb.netFundingApr,
      netArbApr: arb.netArbApr,
      pairedCount: arb.paired.length,
      unhedgedCount: arb.unhedged.length,
    },
  };
}

module.exports = {
  nadoSubaccount,
  toBaseSymbol,
  fetchHyperliquidState,
  fetchHyperliquidFunding,
  fetchHyperliquidFills,
  fetchHyperliquidRates,
  fetchNadoState,
  fetchNadoFunding,
  fetchNadoMatches,
  fetchNadoRates,
  fetchPerpsDashboard,
  buildPairedAnalysis,
  buildFundingCumulativeSeries,
};

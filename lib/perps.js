/**
 * Perps DEX helpers — Hyperliquid + Nado + GRVT.
 * GRVT account data requires GRVT_API_KEY on the server (Vercel env).
 */

const HL_INFO = 'https://api.hyperliquid.xyz/info';
const NADO_GATEWAY = 'https://gateway.prod.nado.xyz/v1';
const NADO_ARCHIVE = 'https://archive.prod.nado.xyz/v1';
const GRVT_AUTH = 'https://edge.grvt.io/auth/api_key/login';
const GRVT_TRADES = 'https://trades.grvt.io/full/v1';
const GRVT_MARKET = 'https://market-data.grvt.io/full/v1';
const DEFAULT_GRVT_SUB_ACCOUNT = '4860249204328359';

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

let _grvtAuthCache = null;

function grvtNsToMs(ns) {
  const n = Number(ns);
  if (!n) return 0;
  return n > 1e15 ? Math.floor(n / 1e6) : n;
}

function grvtBaseFromInstrument(instrument) {
  return String(instrument || '').split('_')[0] || instrument;
}

function grvtFundingRateToDecimal(raw) {
  const v = parseFloat(raw);
  if (!Number.isFinite(v)) return null;
  // GRVT funding: percentage points for the funding interval (0.01 = 0.01%).
  if (Math.abs(v) < 1) return v / 100;
  // Integer values are centibeeps (1 centibeep = 1e-6 notional fraction).
  return v / 1_000_000;
}

function grvtRateToDecimal(raw) {
  return grvtFundingRateToDecimal(raw);
}

function grvtFundingSinceOpen(pos) {
  if (!pos) return null;
  const raw = pos.cumulativeFundingSinceOpen ?? pos.cumFundingSinceOpen;
  if (raw == null || !Number.isFinite(raw)) return null;
  return -raw;
}

function grvtExtractCookie(headers) {
  const raw = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : [headers.get('set-cookie')].filter(Boolean);
  for (const line of raw) {
    const match = String(line).match(/gravity=([^;]+)/i);
    if (match) return `gravity=${match[1]}`;
  }
  return '';
}

function grvtThrowIfError(data, label) {
  if (!data || typeof data !== 'object') return;
  const status = data.status;
  const code = Number(data.code);
  if (status === 'failure' || status === 401 || status === 451 || status === 403) {
    throw new Error(data.message || data.error || `${label} auth failed`);
  }
  if (Number.isFinite(code) && code >= 400) {
    throw new Error(data.message || data.error || `${label} error ${code}`);
  }
  if (data.error && status !== 'success') {
    throw new Error(String(data.error));
  }
}

async function grvtAuth() {
  const apiKey = process.env.GRVT_API_KEY;
  if (!apiKey) throw new Error('GRVT_API_KEY not configured');
  if (_grvtAuthCache && _grvtAuthCache.expiresAt > Date.now()) return _grvtAuthCache;

  const r = await fetch(GRVT_AUTH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: 'rm=true;' },
    body: JSON.stringify({ api_key: apiKey }),
  });
  const body = await r.json().catch(() => ({}));
  grvtThrowIfError(body, 'GRVT auth');
  if (!r.ok) throw new Error(body.message || body.error || `GRVT auth HTTP ${r.status}`);

  const cookie = grvtExtractCookie(r.headers);
  const accountId = r.headers.get('x-grvt-account-id') || '';
  if (!cookie || !accountId) {
    throw new Error(body.message || body.error || 'GRVT auth failed — missing session cookie');
  }
  _grvtAuthCache = {
    cookie,
    accountId,
    expiresAt: Date.now() + 25 * 60 * 1000,
  };
  return _grvtAuthCache;
}

async function grvtTradesPost(path, body) {
  const auth = await grvtAuth();
  const r = await fetch(`${GRVT_TRADES}/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: auth.cookie,
      'X-Grvt-Account-Id': auth.accountId,
    },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  grvtThrowIfError(data, `GRVT ${path}`);
  if (!r.ok) throw new Error(data.message || data.error || `GRVT ${path} HTTP ${r.status}`);
  return data;
}

function grvtPx(raw) {
  const v = parseFloat(raw);
  if (!Number.isFinite(v)) return 0;
  return Math.abs(v) >= 1e12 ? v / 1e9 : v;
}

function mapGrvtPositions(rows) {
  return (rows || [])
    .filter(p => Math.abs(parseFloat(p.size || 0)) > 0)
    .map(p => {
      const size = parseFloat(p.size || 0);
      const cumFunding = parseFloat(p.cumulative_realized_funding_payment || 0);
      return {
        venue: 'grvt',
        symbol: grvtBaseFromInstrument(p.instrument),
        instrument: p.instrument,
        size,
        side: size >= 0 ? 'long' : 'short',
        entryPx: grvtPx(p.entry_price),
        markPx: grvtPx(p.mark_price),
        notional: Math.abs(parseFloat(p.notional || 0)),
        unrealizedPnl: parseFloat(p.unrealized_pnl || 0),
        cumFundingSinceOpen: cumFunding,
        cumulativeFundingSinceOpen: cumFunding,
        leverage: p.leverage ? parseFloat(p.leverage) : null,
      };
    });
}

async function grvtMarketPost(path, body) {
  const r = await fetch(`${GRVT_MARKET}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`GRVT market ${path} HTTP ${r.status}`);
  return r.json();
}

async function grvtPaginate(path, baseBody, windowStartMs) {
  const startNs = String(Math.floor(windowStartMs * 1e6));
  const rows = [];
  let cursor = '';
  for (let page = 0; page < 50; page++) {
    const data = await grvtTradesPost(path, {
      ...baseBody,
      start_time: startNs,
      limit: 500,
      cursor,
    });
    const batch = data.result || [];
    rows.push(...batch);
    cursor = data.next || '';
    if (!cursor || batch.length < 500) break;
  }
  return rows;
}

async function fetchGrvtState(subAccountId) {
  const empty = {
    venue: 'grvt',
    subAccountId,
    exists: false,
    accountValue: 0,
    availableBalance: 0,
    positions: [],
  };
  if (!subAccountId || !process.env.GRVT_API_KEY) return { ...empty, configured: false };

  const data = await grvtTradesPost('account_summary', { sub_account_id: String(subAccountId) });
  const acc = data.result || {};
  let positions = mapGrvtPositions(acc.positions || []);
  if (!positions.length) {
    const posData = await grvtTradesPost('positions', {
      sub_account_id: String(subAccountId),
      kind: ['PERPETUAL'],
    });
    positions = mapGrvtPositions(posData.result || []);
  }

  return {
    venue: 'grvt',
    subAccountId,
    configured: true,
    exists: true,
    accountValue: parseFloat(acc.total_equity || 0),
    availableBalance: parseFloat(acc.available_balance || 0),
    unrealizedPnl: parseFloat(acc.unrealized_pnl || 0),
    positions,
  };
}

async function fetchGrvtFunding(subAccountId, days = 30) {
  const empty = { venue: 'grvt', subAccountId, days, payments: [], totalFunding: 0 };
  if (!subAccountId || !process.env.GRVT_API_KEY) return empty;

  const windowStart = Date.now() - days * 86400000;
  const rows = await grvtPaginate('funding_payment_history', {
    sub_account_id: String(subAccountId),
    kind: ['PERPETUAL'],
  }, windowStart);

  const payments = rows
    .map(row => ({
      venue: 'grvt',
      time: grvtNsToMs(row.event_time),
      symbol: grvtBaseFromInstrument(row.instrument),
      instrument: row.instrument,
      usdc: -parseFloat(row.amount || 0),
      size: null,
    }))
    .filter(p => p.time >= windowStart);

  payments.sort((a, b) => b.time - a.time);
  const totalFunding = payments.reduce((s, p) => s + p.usdc, 0);
  return { venue: 'grvt', subAccountId, days, payments, totalFunding };
}

async function fetchGrvtFills(subAccountId, days = 30) {
  const empty = { venue: 'grvt', subAccountId, days, fills: [], totalFees: 0, totalRealized: 0 };
  if (!subAccountId || !process.env.GRVT_API_KEY) return empty;

  const windowStart = Date.now() - days * 86400000;
  const rows = await grvtPaginate('fill_history', {
    sub_account_id: String(subAccountId),
    kind: ['PERPETUAL'],
  }, windowStart);

  const fills = rows
    .map(row => ({
      venue: 'grvt',
      time: grvtNsToMs(row.event_time),
      symbol: grvtBaseFromInstrument(row.instrument),
      instrument: row.instrument,
      px: parseFloat(row.price || 0),
      sz: parseFloat(row.size || 0),
      side: row.is_buyer ? 'buy' : 'sell',
      fee: parseFloat(row.fee || 0),
      closedPnl: parseFloat(row.realized_pnl || 0),
    }))
    .filter(f => f.time >= windowStart);

  return {
    venue: 'grvt',
    subAccountId,
    days,
    fills,
    totalFees: fills.reduce((s, f) => s + f.fee, 0),
    totalRealized: fills.reduce((s, f) => s + f.closedPnl, 0),
  };
}

async function fetchGrvtCapitalFlows(subAccountId) {
  const empty = { venue: 'grvt', subAccountId, payments: [], netDeposits: 0 };
  if (!subAccountId || !process.env.GRVT_API_KEY) return empty;

  const payments = [];
  let cursor = '';
  for (let page = 0; page < 50; page++) {
    const dep = await grvtTradesPost('deposit_history', {
      currency: ['USDT', 'USDC'],
      limit: 500,
      cursor,
    });
    for (const row of dep.result || []) {
      const amt = parseFloat(row.num_tokens || 0);
      if (!amt) continue;
      payments.push({
        venue: 'grvt',
        time: grvtNsToMs(row.confirmed_time || row.initiated_time),
        kind: 'deposit',
        usdc: amt,
        currency: row.currency,
        txHash: row.l_2_hash || row.l_1_hash,
      });
    }
    cursor = dep.next || '';
    if (!cursor || !(dep.result || []).length) break;
  }

  cursor = '';
  for (let page = 0; page < 50; page++) {
    const wdr = await grvtTradesPost('withdrawal_history', {
      currency: ['USDT', 'USDC'],
      limit: 500,
      cursor,
    });
    for (const row of wdr.result || []) {
      const amt = parseFloat(row.num_tokens || 0);
      if (!amt) continue;
      payments.push({
        venue: 'grvt',
        time: grvtNsToMs(row.event_time || row.confirmed_time || row.initiated_time),
        kind: 'withdraw',
        usdc: -amt,
        currency: row.currency,
        txHash: row.l_2_hash || row.l_1_hash,
      });
    }
    cursor = wdr.next || '';
    if (!cursor || !(wdr.result || []).length) break;
  }

  payments.sort((a, b) => a.time - b.time);
  const netDeposits = payments.reduce((s, p) => s + p.usdc, 0);
  return { venue: 'grvt', subAccountId, payments, netDeposits };
}

let _grvtInstrumentsCache = null;

async function fetchGrvtInstrumentMap() {
  if (_grvtInstrumentsCache && _grvtInstrumentsCache.expiresAt > Date.now()) {
    return _grvtInstrumentsCache.map;
  }
  const data = await grvtMarketPost('all_instruments', {});
  const arr = data.result || [];
  const map = {};
  for (const ins of arr) {
    const base = grvtBaseFromInstrument(ins.instrument);
    if (base) map[base] = ins;
  }
  _grvtInstrumentsCache = { map, expiresAt: Date.now() + 300000 };
  return map;
}

async function fetchGrvtRates(bases = []) {
  const instrumentMap = await fetchGrvtInstrumentMap();
  const symbols = new Set(bases);
  ['BTC', 'ETH', 'SOL'].forEach(b => symbols.add(b));
  const rows = await Promise.all([...symbols].map(async base => {
    const instrument = `${base}_USDT_Perp`;
    const intervalHours = instrumentMap[base]?.funding_interval_hours ?? 8;
    try {
      const data = await grvtMarketPost('ticker', { instrument });
      const t = data.result || data;
      const raw = t.funding_rate ?? t.funding_rate_8h_curr ?? t.funding_rate_8h_avg;
      const fundingRateInterval = grvtFundingRateToDecimal(raw);
      const fundingRate8h = fundingRateInterval != null
        ? fundingRateInterval * (8 / intervalHours)
        : null;
      return {
        venue: 'grvt',
        symbol: base,
        instrument,
        fundingRateInterval,
        fundingIntervalHours: intervalHours,
        fundingRate8h,
        markPx: parseFloat(t.mark_price || 0),
      };
    } catch (_) {
      return null;
    }
  }));
  return rows.filter(Boolean);
}

const EXTENDED_API = 'https://api.starknet.extended.exchange/api/v1';

function extendedBaseFromMarket(market) {
  return String(market || '').replace(/-USD$/i, '').replace(/-USDC$/i, '');
}

function extendedMarketFromBase(base) {
  return `${String(base || '').toUpperCase()}-USD`;
}

async function extendedGet(path, params = {}) {
  const apiKey = process.env.EXTENDED_API_KEY;
  if (!apiKey) throw new Error('EXTENDED_API_KEY not configured');
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === '') continue;
    if (Array.isArray(v)) v.forEach(item => qs.append(k, String(item)));
    else qs.append(k, String(v));
  }
  const url = `${EXTENDED_API}${path}${qs.toString() ? `?${qs}` : ''}`;
  const r = await fetch(url, {
    headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
  });
  const data = await r.json().catch(() => ({}));
  if (data.status === 'ERROR') {
    throw new Error(data.message || data.error || `Extended ${path} failed`);
  }
  if (!r.ok && r.status !== 404) {
    throw new Error(data.message || data.error || `Extended ${path} HTTP ${r.status}`);
  }
  return { ok: r.ok, status: r.status, data: data.data, pagination: data.pagination, raw: data };
}

function extendedFundingUsdc(row) {
  const fee = parseFloat(row.fundingFee || 0);
  if (!Number.isFinite(fee)) return 0;
  // Extended fundingFee is collateral movement: positive credits the account (received), negative is paid.
  return fee;
}

async function extendedPaginate(path, params, windowStartMs) {
  const rows = [];
  const seen = new Set();
  let cursor = params.cursor;
  for (let page = 0; page < 100; page++) {
    const res = await extendedGet(path, { ...params, cursor, limit: params.limit || 500 });
    const batch = Array.isArray(res.data) ? res.data : [];
    if (!batch.length) break;
    let oldestInBatch = Infinity;
    for (const row of batch) {
      const key = row.id != null ? `id:${row.id}` : `${row.paidTime}:${row.market}:${row.positionId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
      const t = Number(row.paidTime || row.time || row.createdTime || 0);
      if (t) oldestInBatch = Math.min(oldestInBatch, t);
    }
    cursor = res.pagination?.cursor;
    if (!cursor) break;
    if (windowStartMs && oldestInBatch < windowStartMs) break;
  }
  return windowStartMs
    ? rows.filter(row => Number(row.paidTime || row.time || row.createdTime || 0) >= windowStartMs)
    : rows;
}

function mapExtendedPositions(rows) {
  return (rows || [])
    .filter(p => Math.abs(parseFloat(p.size || 0)) > 0)
    .map(p => {
      const sizeAbs = parseFloat(p.size || 0);
      const sideRaw = String(p.side || '').toUpperCase();
      const signedSize = sideRaw === 'SHORT' ? -sizeAbs : sizeAbs;
      return {
        venue: 'extended',
        symbol: extendedBaseFromMarket(p.market),
        market: p.market,
        size: signedSize,
        side: sideRaw === 'SHORT' ? 'short' : 'long',
        entryPx: parseFloat(p.openPrice || 0),
        markPx: parseFloat(p.markPrice || 0),
        notional: Math.abs(parseFloat(p.value || 0)),
        unrealizedPnl: parseFloat(p.unrealisedPnl || 0),
        realisedPnl: parseFloat(p.realisedPnl || 0),
        leverage: p.leverage ? parseFloat(p.leverage) : null,
      };
    });
}

async function fetchExtendedState() {
  const empty = {
    venue: 'extended',
    exists: false,
    configured: false,
    accountValue: 0,
    balance: 0,
    positions: [],
  };
  if (!process.env.EXTENDED_API_KEY) return empty;

  const [balanceRes, positionsRes] = await Promise.all([
    extendedGet('/user/balance').catch(() => ({ ok: false, status: 404, data: null })),
    extendedGet('/user/positions'),
  ]);

  const bal = balanceRes.data || {};
  const positions = mapExtendedPositions(positionsRes.data || []);
  const accountValue = parseFloat(bal.equity || 0)
    || positions.reduce((s, p) => s + (p.notional || 0), 0);

  return {
    venue: 'extended',
    configured: true,
    exists: accountValue > 0 || positions.length > 0,
    accountValue,
    balance: parseFloat(bal.balance || 0),
    availableForTrade: parseFloat(bal.availableForTrade || 0),
    unrealizedPnl: parseFloat(bal.unrealisedPnl || 0),
    accountId: positions[0]?.accountId ?? bal.accountId ?? null,
    positions,
  };
}

async function fetchExtendedFunding(days = 30) {
  const empty = { venue: 'extended', days, payments: [], totalFunding: 0 };
  if (!process.env.EXTENDED_API_KEY) return empty;

  const windowStart = Date.now() - days * 86400000;
  const rows = await extendedPaginate('/user/funding/history', { startTime: windowStart }, windowStart);

  const payments = rows.map(row => ({
    venue: 'extended',
    time: Number(row.paidTime) || 0,
    symbol: extendedBaseFromMarket(row.market),
    market: row.market,
    size: parseFloat(row.size || 0),
    usdc: extendedFundingUsdc(row),
    fundingRate: parseFloat(row.fundingRate || 0),
  })).filter(p => p.time >= windowStart);

  payments.sort((a, b) => b.time - a.time);
  return {
    venue: 'extended',
    days,
    payments,
    totalFunding: payments.reduce((s, p) => s + p.usdc, 0),
  };
}

async function fetchExtendedFills(days = 30) {
  const empty = { venue: 'extended', days, fills: [], totalFees: 0, totalRealized: 0 };
  if (!process.env.EXTENDED_API_KEY) return empty;

  const windowStart = Date.now() - days * 86400000;
  const rows = await extendedPaginate('/user/trades', { type: 'trade' }, windowStart);

  const fills = rows
    .map(row => ({
      venue: 'extended',
      time: Number(row.createdTime) || 0,
      symbol: extendedBaseFromMarket(row.market),
      market: row.market,
      px: parseFloat(row.price || row.averagePrice || 0),
      sz: parseFloat(row.qty || row.filledQty || 0),
      side: String(row.side || '').toLowerCase(),
      fee: parseFloat(row.fee || 0),
      closedPnl: 0,
    }))
    .filter(f => f.time >= windowStart);

  return {
    venue: 'extended',
    days,
    fills,
    totalFees: fills.reduce((s, f) => s + f.fee, 0),
    totalRealized: 0,
  };
}

async function fetchExtendedCapitalFlows() {
  const empty = { venue: 'extended', payments: [], netDeposits: 0 };
  if (!process.env.EXTENDED_API_KEY) return empty;

  const rows = await extendedPaginate('/user/assetOperations', { status: 'COMPLETED' }, 0);
  const payments = [];
  for (const row of rows) {
    const type = String(row.type || '').toUpperCase();
    if (type === 'TRANSFER') continue;
    const amt = parseFloat(row.amount || 0);
    if (!amt) continue;
    if (type === 'DEPOSIT') {
      payments.push({
        venue: 'extended',
        time: Number(row.time) || 0,
        kind: 'deposit',
        usdc: Math.abs(amt),
        txId: row.id,
      });
    } else if (type === 'WITHDRAWAL') {
      payments.push({
        venue: 'extended',
        time: Number(row.time) || 0,
        kind: 'withdraw',
        usdc: -Math.abs(amt),
        txId: row.id,
      });
    }
  }

  payments.sort((a, b) => a.time - b.time);
  return { venue: 'extended', payments, netDeposits: payments.reduce((s, p) => s + p.usdc, 0) };
}

async function fetchExtendedRates(bases = []) {
  const symbols = new Set(bases.map(b => extendedMarketFromBase(b)));
  ['BTC', 'ETH', 'SOL', 'ONDO', 'VIRTUAL', 'IP'].forEach(b => symbols.add(extendedMarketFromBase(b)));
  const res = await fetch(`${EXTENDED_API}/info/markets?${[...symbols].map(m => `market=${encodeURIComponent(m)}`).join('&')}`);
  const data = await res.json().catch(() => ({}));
  if (data.status !== 'OK') return [];
  return (data.data || []).map(m => {
    const hourly = parseFloat(m.marketStats?.fundingRate ?? 0);
    return {
      venue: 'extended',
      symbol: extendedBaseFromMarket(m.name || m.market),
      market: m.name || m.market,
      fundingRate8h: hourly * 8,
      fundingRateHourly: hourly,
      markPx: parseFloat(m.marketStats?.markPrice || 0),
    };
  });
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

function hlSpotEquityUsd(spotState) {
  const balances = spotState?.balances || [];
  if (!balances.length) return 0;
  let total = 0;
  for (const b of balances) {
    const qty = parseFloat(b.total || 0);
    if (qty <= 0) continue;
    if (b.coin === 'USDC') total += qty;
    else total += parseFloat(b.entryNtl || 0);
  }
  return total;
}

function nadoAccountEquity(healths) {
  // healths[0]=initial, [1]=maintenance, [2]=unweighted (total portfolio value per Nado docs)
  const unweighted = Array.isArray(healths) ? healths[2] : null;
  if (!unweighted) return null;
  const equity = fromX18(unweighted.health);
  if (Number.isFinite(equity)) return equity;
  const assets = fromX18(unweighted.assets || unweighted.asset_value);
  const liabilities = fromX18(unweighted.liabilities || 0);
  return assets - liabilities;
}

async function fetchHyperliquidState(wallet) {
  const [state, spotState] = await Promise.all([
    hlPost({ type: 'clearinghouseState', user: wallet }),
    hlPost({ type: 'spotClearinghouseState', user: wallet }).catch(() => ({ balances: [] })),
  ]);
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

  const perpAccountValue = parseFloat(state.marginSummary?.accountValue || 0);
  const spotEquity = hlSpotEquityUsd(spotState);
  // Unified HL accounts: spotClearinghouseState is the source of truth for total trading balance.
  const accountValue = spotEquity > 0 ? spotEquity : perpAccountValue;

  return {
    venue: 'hyperliquid',
    wallet,
    accountValue,
    perpAccountValue,
    spotEquity,
    withdrawable: parseFloat(state.withdrawable || 0),
    positions,
  };
}

async function fetchHyperliquidFunding(wallet, days = 30) {
  const windowStart = Date.now() - days * 86400000;
  let startTime = windowStart;
  const allRows = [];
  for (let page = 0; page < 50; page++) {
    const rows = await hlPost({ type: 'userFunding', user: wallet, startTime });
    if (!Array.isArray(rows) || !rows.length) break;
    allRows.push(...rows);
    if (rows.length < 500) break;
    const maxTime = Math.max(...rows.map(r => Number(r.time) || 0));
    startTime = maxTime + 1;
    if (startTime >= Date.now()) break;
  }
  const seen = new Set();
  const payments = allRows
    .filter(row => {
      const key = `${row.time}:${row.hash || ''}:${row.delta?.coin || ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return Number(row.time) >= windowStart;
    })
    .map(row => {
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
  payments.sort((a, b) => b.time - a.time);
  const total = payments.reduce((s, p) => s + p.usdc, 0);
  return { venue: 'hyperliquid', wallet, days, payments, totalFunding: total };
}

async function fetchHyperliquidFills(wallet, days = 30) {
  const windowStart = Date.now() - days * 86400000;
  const fills = [];
  const seen = new Set();
  let startTime = windowStart;

  for (let page = 0; page < 40; page++) {
    const rows = await hlPost({
      type: 'userFillsByTime',
      user: wallet,
      startTime,
      aggregateByTime: true,
    });
    const batch = Array.isArray(rows) ? rows : [];
    if (!batch.length) break;

    let maxTime = startTime;
    for (const f of batch) {
      const time = Number(f.time) || 0;
      if (time < windowStart) continue;
      const key = `${time}:${f.oid ?? ''}:${f.coin}:${f.px}:${f.sz}`;
      if (seen.has(key)) continue;
      seen.add(key);
      maxTime = Math.max(maxTime, time);
      fills.push({
        venue: 'hyperliquid',
        time,
        symbol: f.coin,
        px: parseFloat(f.px || 0),
        sz: parseFloat(f.sz || 0),
        side: f.side,
        dir: f.dir,
        fee: parseFloat(f.fee || 0),
        closedPnl: parseFloat(f.closedPnl || 0),
      });
    }

    if (maxTime <= startTime) break;
    startTime = maxTime + 1;
    if (startTime >= Date.now() - 500) break;
    if (batch.length < 2000) break;
  }

  const totalFees = fills.reduce((s, f) => s + f.fee, 0);
  const totalRealized = fills.reduce((s, f) => s + f.closedPnl, 0);
  return { venue: 'hyperliquid', wallet, days, fills, totalFees, totalRealized };
}

async function fetchHyperliquidRates() {
  const data = await hlPost({ type: 'metaAndAssetCtxs' });
  const universe = data[0]?.universe || [];
  const ctxs = data[1] || [];
  return universe.map((u, i) => {
    const hourly = parseFloat(ctxs[i]?.funding || 0);
    return {
      venue: 'hyperliquid',
      symbol: u.name,
      fundingRateHourly: hourly,
      fundingRate8h: hourly * 8,
      markPx: parseFloat(ctxs[i]?.markPx || 0),
      openInterest: parseFloat(ctxs[i]?.openInterest || 0),
    };
  });
}

function hlFundingSinceOpen(hlPos) {
  if (!hlPos) return null;
  const raw = hlPos.cumFundingSinceOpen ?? hlPos.cumFundingAllTime;
  if (raw == null || !Number.isFinite(raw)) return null;
  // HL position cumFunding is negative when the leg earned funding (UI shows positive).
  return -raw;
}

async function fetchNadoPositionEvents(subaccount, productIds) {
  if (!productIds.length) return {};
  const map = {};
  await Promise.all(productIds.map(async (productId) => {
    const data = await nadoArchive({
      events: {
        subaccounts: [subaccount],
        product_ids: [productId],
        limit: { raw: 1 },
      },
    });
    for (const ev of data.events || []) {
      const perp = ev.post_balance?.perp;
      if (!perp) continue;
      const pid = perp.product_id ?? ev.product_id;
      if (Number(pid) !== Number(productId)) continue;
      const amount = fromX18(perp.balance?.amount);
      const netEntryUnrealized = fromX18(ev.net_entry_unrealized);
      map[productId] = {
        entryPx: amount !== 0 ? Math.abs(netEntryUnrealized / amount) : null,
        netEntryUnrealized,
        fundingSinceOpen: fromX18(ev.net_funding_unrealized),
        fundingCumulative: fromX18(ev.net_funding_cumulative),
      };
    }
  }));
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
        : (oracle != null && pnl?.entryPx != null
          ? amount * (oracle - pnl.entryPx)
          : null);
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
        fundingSinceOpen: pnl?.fundingSinceOpen ?? null,
        fundingCumulative: pnl?.fundingCumulative ?? null,
      };
    })
    .filter(Boolean);

  const healths = info.healths || [];
  const unweighted = healths[2];
  return {
    venue: 'nado',
    wallet,
    subaccount,
    exists: !!info.exists,
    accountValue: nadoAccountEquity(healths),
    health: unweighted ? fromX18(unweighted.health) : null,
    positions,
  };
}

async function fetchNadoFunding(wallet, days = 30, subaccountName = 'default') {
  const subaccount = nadoSubaccount(wallet, subaccountName);
  const symMap = await nadoSymbolMap();
  const allProductIds = Object.keys(symMap.idToSymbol).map(Number);
  const sinceSec = Math.floor(Date.now() / 1000) - days * 86400;

  const payments = [];
  const seen = new Set();

  async function fetchProductChunk(productIds) {
    let maxIdx = undefined;
    for (let page = 0; page < 30; page++) {
      const data = await nadoArchive({
        interest_and_funding: {
          subaccount,
          product_ids: productIds,
          limit: 100,
          ...(maxIdx != null ? { max_idx: maxIdx } : {}),
        },
      });
      let oldestInPage = Infinity;
      for (const p of data.funding_payments || []) {
        const ts = Number(p.timestamp || 0);
        oldestInPage = Math.min(oldestInPage, ts);
        if (ts < sinceSec) continue;
        const key = `${ts}:${p.product_id}:${p.idx ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
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
      if (data.next_idx == null) break;
      maxIdx = data.next_idx;
      if (!(data.funding_payments || []).length) break;
      if (oldestInPage < sinceSec) break;
    }
  }

  for (let i = 0; i < allProductIds.length; i += 32) {
    await fetchProductChunk(allProductIds.slice(i, i + 32));
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

function normalizeWalletAddr(wallet) {
  return String(wallet || '').toLowerCase();
}

function classifyHlLedgerFlow(wallet, row) {
  const w = normalizeWalletAddr(wallet);
  const d = row.delta || {};
  const type = d.type;
  let usdc = 0;
  let kind = type;
  let external = false;

  if (type === 'deposit') {
    usdc = Math.abs(parseFloat(d.usdc || 0));
    external = true;
  } else if (type === 'withdraw') {
    usdc = -Math.abs(parseFloat(d.usdc || 0));
    external = true;
  } else if (type === 'send') {
    const dest = normalizeWalletAddr(d.destination);
    const user = normalizeWalletAddr(d.user);
    const amount = Math.abs(parseFloat(d.usdcValue || d.amount || 0));
    if (dest === w) {
      usdc = amount;
      kind = 'transfer_in';
      external = true;
    } else if (user === w) {
      usdc = -amount;
      kind = 'transfer_out';
      external = true;
    }
  } else if (type === 'spotTransfer') {
    const dest = normalizeWalletAddr(d.destination);
    const user = normalizeWalletAddr(d.user);
    const amount = Math.abs(parseFloat(d.usdcValue || 0));
    if (dest === w) {
      usdc = amount;
      kind = 'spot_transfer_in';
      external = true;
    } else if (user === w) {
      usdc = -amount;
      kind = 'spot_transfer_out';
      external = true;
    }
  } else if (type === 'internalTransfer' || type === 'accountClassTransfer') {
    kind = type;
    external = false;
  } else if (type === 'borrowLend') {
    kind = 'borrow_lend';
    external = false;
  }

  if (!external || !usdc) return null;
  return {
    venue: 'hyperliquid',
    time: Number(row.time) || 0,
    kind,
    usdc,
    external,
    hash: row.hash || null,
  };
}

async function fetchHyperliquidCapitalFlows(wallet) {
  let startTime = 0;
  const allRows = [];
  for (let page = 0; page < 50; page++) {
    const rows = await hlPost({ type: 'userNonFundingLedgerUpdates', user: wallet, startTime });
    if (!Array.isArray(rows) || !rows.length) break;
    allRows.push(...rows);
    if (rows.length < 500) break;
    const maxTime = Math.max(...rows.map(r => Number(r.time) || 0));
    startTime = maxTime + 1;
    if (startTime >= Date.now()) break;
  }

  const seen = new Set();
  const payments = allRows
    .map(row => classifyHlLedgerFlow(wallet, row))
    .filter(p => {
      if (!p) return false;
      const key = `${p.time}:${p.kind}:${p.usdc}:${p.hash || ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.time - b.time);

  const netDeposits = payments.reduce((s, p) => s + p.usdc, 0);
  return { venue: 'hyperliquid', wallet, payments, netDeposits };
}

async function fetchNadoCapitalFlows(wallet, subaccountName = 'default') {
  const subaccount = nadoSubaccount(wallet, subaccountName);
  const payments = [];
  let maxIdx = undefined;

  for (let page = 0; page < 20; page++) {
    const body = {
      events: {
        subaccounts: [subaccount],
        event_types: ['deposit_collateral', 'withdraw_collateral'],
        limit: { raw: 500 },
        ...(maxIdx != null ? { max_idx: maxIdx } : {}),
      },
    };
    const data = await nadoArchive(body);
    const tsByIdx = Object.fromEntries(
      (data.txs || []).map(tx => [String(tx.submission_idx), Number(tx.timestamp || 0)])
    );

    for (const ev of data.events || []) {
      const pre = fromX18(ev.pre_balance?.spot?.balance?.amount || 0);
      const post = fromX18(ev.post_balance?.spot?.balance?.amount || 0);
      const usdc = post - pre;
      if (!usdc) continue;
      const idx = String(ev.submission_idx || '');
      const tsSec = tsByIdx[idx] || 0;
      payments.push({
        venue: 'nado',
        time: tsSec ? tsSec * 1000 : 0,
        kind: ev.event_type === 'withdraw_collateral' ? 'withdraw' : 'deposit',
        usdc,
        external: true,
        productId: ev.product_id,
        submissionIdx: idx,
      });
    }

    if (data.next_idx == null) break;
    maxIdx = data.next_idx;
    if (!(data.events || []).length) break;
  }

  const deduped = [];
  const seen = new Set();
  for (const p of payments.sort((a, b) => a.time - b.time)) {
    const key = `${p.submissionIdx}:${p.usdc}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(p);
  }

  const netDeposits = deduped.reduce((s, p) => s + p.usdc, 0);
  return { venue: 'nado', wallet, subaccount, payments: deduped, netDeposits };
}

const CROSS_VENUE_WINDOW_MS = 7 * 86400000;

function hlStrategyPayments(payments) {
  return (payments || []).filter(p => p.kind === 'deposit' || p.kind === 'withdraw');
}

function computeCrossVenueOffset(primaryPayments, hlPayments, windowMs) {
  const hlP = hlStrategyPayments(hlPayments);
  const primaryP = [...(primaryPayments || [])];

  const hlDep = hlP.filter(p => p.usdc > 0);
  const hlWdr = hlP.filter(p => p.usdc < 0);
  const primaryDep = primaryP.filter(p => p.usdc > 0);
  const primaryWdr = primaryP.filter(p => p.usdc < 0);

  let crossVenueOffset = 0;
  const usedHlDep = new Set();
  const usedHlWdr = new Set();

  for (const pd of primaryDep) {
    let bestIdx = -1;
    let bestDist = Infinity;
    let bestKind = null;

    hlDep.forEach((hd, i) => {
      if (usedHlDep.has(i)) return;
      const dist = Math.abs(pd.time - hd.time);
      if (dist <= windowMs && dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
        bestKind = 'dep';
      }
    });
    hlWdr.forEach((hw, i) => {
      if (usedHlWdr.has(i)) return;
      const dist = Math.abs(pd.time - hw.time);
      if (dist <= windowMs && dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
        bestKind = 'wdr';
      }
    });

    if (bestIdx >= 0 && bestKind) {
      const hlRow = bestKind === 'dep' ? hlDep[bestIdx] : hlWdr[bestIdx];
      const overlap = Math.min(pd.usdc, Math.abs(hlRow.usdc));
      if (overlap > 50) {
        crossVenueOffset += overlap;
        if (bestKind === 'dep') usedHlDep.add(bestIdx);
        else usedHlWdr.add(bestIdx);
      }
    }
  }

  for (const pw of primaryWdr) {
    let bestIdx = -1;
    let bestDist = Infinity;
    hlDep.forEach((hd, i) => {
      if (usedHlDep.has(i)) return;
      const dist = Math.abs(pw.time - hd.time);
      if (dist <= windowMs && dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    });
    if (bestIdx >= 0) {
      const overlap = Math.min(Math.abs(pw.usdc), hlDep[bestIdx].usdc);
      if (overlap > 50) {
        crossVenueOffset += overlap;
        usedHlDep.add(bestIdx);
      }
    }
  }

  return crossVenueOffset;
}

function computeCombinedNetDeposits(hlCapitalFlows, nadoCapitalFlows, grvtCapitalFlows = null, extendedCapitalFlows = null, windowMs = CROSS_VENUE_WINDOW_MS) {
  const hlP = hlStrategyPayments(hlCapitalFlows?.payments);
  const nadoP = [...(nadoCapitalFlows?.payments || [])];
  const grvtP = [...(grvtCapitalFlows?.payments || [])];
  const extendedP = [...(extendedCapitalFlows?.payments || [])];

  const hlNetDeposits = hlP.reduce((s, p) => s + p.usdc, 0);
  const nadoNetDeposits = nadoP.reduce((s, p) => s + p.usdc, 0);
  const grvtNetDeposits = grvtP.reduce((s, p) => s + p.usdc, 0);
  const extendedNetDeposits = extendedP.reduce((s, p) => s + p.usdc, 0);
  const rawCombinedNetDeposits = hlNetDeposits + nadoNetDeposits + grvtNetDeposits + extendedNetDeposits;

  let crossVenueOffset = computeCrossVenueOffset(nadoP, hlP, windowMs);
  const extras = [grvtCapitalFlows ? grvtP : null, extendedCapitalFlows ? extendedP : null].filter(Boolean);
  for (const extraP of extras) {
    crossVenueOffset += computeCrossVenueOffset(extraP, hlP, windowMs);
    crossVenueOffset += computeCrossVenueOffset(extraP, nadoP, windowMs);
  }
  if (grvtCapitalFlows && extendedCapitalFlows) {
    crossVenueOffset += computeCrossVenueOffset(extendedP, grvtP, windowMs);
  }

  return {
    combinedNetDeposits: rawCombinedNetDeposits - crossVenueOffset,
    rawCombinedNetDeposits,
    crossVenueOffset,
    hlNetDeposits,
    nadoNetDeposits,
    grvtNetDeposits: grvtCapitalFlows ? grvtNetDeposits : undefined,
    extendedNetDeposits: extendedCapitalFlows ? extendedNetDeposits : undefined,
  };
}

function netDepositsAtTime(hlPayments, nadoPayments, timeMs, grvtPayments = null, extendedPayments = null, windowMs = CROSS_VENUE_WINDOW_MS) {
  const hlFiltered = hlStrategyPayments(hlPayments).filter(p => p.time <= timeMs);
  const nadoFiltered = (nadoPayments || []).filter(p => p.time <= timeMs);
  const grvtFiltered = grvtPayments ? (grvtPayments || []).filter(p => p.time <= timeMs) : null;
  const extendedFiltered = extendedPayments ? (extendedPayments || []).filter(p => p.time <= timeMs) : null;
  return computeCombinedNetDeposits(
    { payments: hlFiltered },
    { payments: nadoFiltered },
    grvtFiltered ? { payments: grvtFiltered } : null,
    extendedFiltered ? { payments: extendedFiltered } : null,
    windowMs,
  ).combinedNetDeposits;
}

function isoDateFromMs(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function buildEquitySeries({
  capitalFlows,
  hlAccountValue,
  nadoAccountValue,
  grvtAccountValue = 0,
  extendedAccountValue = 0,
  fetchedAt,
  snapshots = [],
  backfill = [],
}) {
  const hlPayments = capitalFlows?.hl?.payments || [];
  const nadoPayments = capitalFlows?.nado?.payments || [];
  const grvtPayments = capitalFlows?.grvt?.payments || [];
  const extendedPayments = capitalFlows?.extended?.payments || [];
  const combinedNetDeposits = capitalFlows?.combinedNetDeposits
    ?? computeCombinedNetDeposits(
      { payments: hlPayments },
      { payments: nadoPayments },
      grvtPayments.length ? { payments: grvtPayments } : null,
      extendedPayments.length ? { payments: extendedPayments } : null,
    ).combinedNetDeposits;

  const points = [];
  const sourcePriority = { live: 3, snapshot: 2, backfill: 1 };

  for (const bf of backfill) {
    const time = Number(bf.time) || 0;
    if (!time) continue;
    const hl = bf.hlAccountValue ?? bf.hl ?? null;
    const nado = bf.nadoAccountValue ?? bf.nado ?? null;
    const grvt = bf.grvtAccountValue ?? bf.grvt ?? 0;
    const extended = bf.extendedAccountValue ?? bf.extended ?? 0;
    const totalEquity = bf.totalEquity ?? ((hl ?? 0) + (nado ?? 0) + grvt + extended);
    const cumulativeNetDeposits = bf.cumulativeNetDeposits
      ?? netDepositsAtTime(
        hlPayments,
        nadoPayments,
        time,
        grvtPayments.length ? grvtPayments : null,
        extendedPayments.length ? extendedPayments : null,
      );
    points.push({
      time,
      date: bf.date || isoDateFromMs(time),
      hlAccountValue: hl,
      nadoAccountValue: nado,
      grvtAccountValue: grvt,
      extendedAccountValue: extended,
      totalEquity,
      cumulativeNetDeposits,
      adjustedEquity: totalEquity - cumulativeNetDeposits,
      source: 'backfill',
    });
  }

  for (const snap of snapshots) {
    const time = Number(snap.fetchedAt) || Date.parse(snap.date) || 0;
    if (!time) continue;
    const hl = snap.hlAccountValue ?? 0;
    const nado = snap.nadoAccountValue ?? 0;
    const grvt = snap.grvtAccountValue ?? 0;
    const extended = snap.extendedAccountValue ?? 0;
    const totalEquity = snap.totalEquity ?? hl + nado + grvt + extended;
    const cumulativeNetDeposits = snap.cumulativeNetDeposits
      ?? netDepositsAtTime(
        hlPayments,
        nadoPayments,
        time,
        grvtPayments.length ? grvtPayments : null,
        extendedPayments.length ? extendedPayments : null,
      );
    points.push({
      time,
      date: snap.date || isoDateFromMs(time),
      hlAccountValue: hl,
      nadoAccountValue: nado,
      grvtAccountValue: grvt,
      extendedAccountValue: extended,
      totalEquity,
      cumulativeNetDeposits,
      adjustedEquity: snap.adjustedEquity ?? totalEquity - cumulativeNetDeposits,
      source: 'snapshot',
    });
  }

  const hlNow = hlAccountValue ?? 0;
  const nadoNow = nadoAccountValue ?? 0;
  const grvtNow = grvtAccountValue ?? 0;
  const extendedNow = extendedAccountValue ?? 0;
  const totalNow = hlNow + nadoNow + grvtNow + extendedNow;
  points.push({
    time: fetchedAt,
    date: isoDateFromMs(fetchedAt),
    hlAccountValue: hlNow,
    nadoAccountValue: nadoNow,
    grvtAccountValue: grvtNow,
    extendedAccountValue: extendedNow,
    totalEquity: totalNow,
    cumulativeNetDeposits: combinedNetDeposits,
    adjustedEquity: totalNow - combinedNetDeposits,
    source: 'live',
  });

  const byDate = {};
  for (const p of points.sort((a, b) => a.time - b.time)) {
    const key = p.date;
    if (!byDate[key] || sourcePriority[p.source] >= sourcePriority[byDate[key].source]) {
      byDate[key] = p;
    }
  }

  const series = Object.values(byDate).sort((a, b) => a.time - b.time);
  const baselineAdjustedEquity = series[0]?.adjustedEquity ?? 0;
  const withPnl = series.map(p => ({
    ...p,
    pnl: p.adjustedEquity - baselineAdjustedEquity,
  }));

  return {
    points: withPnl,
    baselineAdjustedEquity,
    baselineDate: series[0]?.date ?? null,
    walletPnl: withPnl.at(-1)?.pnl ?? 0,
    trackingStarted: series.length > 0,
    hasBackfill: backfill.length > 0,
    combinedNetDeposits,
  };
}

function sumByBase(items, amountKey, symbolKey = 'symbol') {
  const map = {};
  for (const item of items) {
    const base = toBaseSymbol(item[symbolKey]);
    map[base] = (map[base] || 0) + (item[amountKey] || 0);
  }
  return map;
}

/** Net 8h funding spread captured by the hedge (long pays, short receives). */
function netFundingSpread8h(sizeA, rateA, sizeB, rateB) {
  if (rateA == null || rateB == null || !Number.isFinite(rateA) || !Number.isFinite(rateB)) return null;
  const signA = Math.sign(sizeA || 0);
  const signB = Math.sign(sizeB || 0);
  if (!signA || !signB) return null;
  return (-signA * rateA) + (-signB * rateB);
}

function venueRate8h(spread, venue) {
  const key = {
    hyperliquid: 'hyperliquid8h',
    nado: 'nado8h',
    grvt: 'grvt8h',
    extended: 'extended8h',
  }[venue];
  return spread?.[key] ?? null;
}

function fundingForVenueInWindow(venue, base, maps) {
  if (venue === 'hyperliquid') return maps.hl[base] || 0;
  if (venue === 'nado') return maps.nado[base] || 0;
  if (venue === 'grvt') return maps.grvt[base] || 0;
  if (venue === 'extended') return maps.extended[base] || 0;
  return 0;
}

function sumPairFundingPayments(base, venueA, venueB, paymentSources, daysBack) {
  const cutoff = Date.now() - daysBack * 86400000;
  const venues = new Set([venueA, venueB]);
  let sum = 0;
  for (const [venue, payments] of Object.entries(paymentSources)) {
    if (!venues.has(venue)) continue;
    for (const p of payments) {
      if (toBaseSymbol(p.symbol) !== base) continue;
      if (p.time < cutoff) continue;
      sum += p.usdc || 0;
    }
  }
  return sum;
}

function sumPairTradingFees(base, venueA, venueB, fillSources, daysBack) {
  const cutoff = Date.now() - daysBack * 86400000;
  return sumPairTradingFeesSince(base, venueA, venueB, fillSources, cutoff);
}

function sumPairTradingFeesSince(base, venueA, venueB, fillSources, sinceMs) {
  const venues = new Set([venueA, venueB]);
  let sum = 0;
  for (const [venue, items] of Object.entries(fillSources)) {
    if (!venues.has(venue)) continue;
    for (const item of items) {
      if (toBaseSymbol(item.symbol) !== base) continue;
      if (sinceMs && item.time < sinceMs) continue;
      sum += item.fee || 0;
    }
  }
  return sum;
}

function earliestFillMsForPair(base, venue, fillSources) {
  const items = fillSources?.[venue];
  if (!Array.isArray(items)) return null;
  let earliest = null;
  for (const item of items) {
    if (toBaseSymbol(item.symbol) !== base) continue;
    const t = Number(item.time) || 0;
    if (!t) continue;
    if (earliest == null || t < earliest) earliest = t;
  }
  return earliest;
}

function pairDaysOpen(base, venueA, venueB, paymentSources, fillSources) {
  const venues = new Set([venueA, venueB]);
  let earliestPayment = null;
  for (const [venue, payments] of Object.entries(paymentSources)) {
    if (!venues.has(venue)) continue;
    for (const p of payments) {
      if (toBaseSymbol(p.symbol) !== base) continue;
      if (earliestPayment == null || p.time < earliestPayment) earliestPayment = p.time;
    }
  }

  let openFromFills = null;
  if (fillSources) {
    const ta = earliestFillMsForPair(base, venueA, fillSources);
    const tb = earliestFillMsForPair(base, venueB, fillSources);
    const openMs = ta != null && tb != null ? Math.max(ta, tb) : (ta ?? tb);
    if (openMs != null) {
      openFromFills = Math.max((Date.now() - openMs) / 86400000, 1 / 24);
    }
  }

  let openFromPayments = null;
  if (earliestPayment != null) {
    openFromPayments = Math.max((Date.now() - earliestPayment) / 86400000, 1 / 24);
  }

  if (openFromFills != null && openFromPayments != null) {
    // Prefer the shorter span (current leg) when old funding payments exist from prior trades.
    return Math.min(openFromFills, openFromPayments);
  }
  return openFromFills ?? openFromPayments;
}

const PERPS_MAX_FILL_HISTORY_DAYS = 90;

function attachPairFundingMeta(pair, base, venueA, venueB, paymentSources, fillSources, fillHistoryDays) {
  pair.fundingByRange = {
    '1d': sumPairFundingPayments(base, venueA, venueB, paymentSources, 1),
    '7d': sumPairFundingPayments(base, venueA, venueB, paymentSources, 7),
    '30d': sumPairFundingPayments(base, venueA, venueB, paymentSources, 30),
  };
  pair.feesByRange = {
    '1d': sumPairTradingFees(base, venueA, venueB, fillSources, 1),
    '7d': sumPairTradingFees(base, venueA, venueB, fillSources, 7),
    '30d': sumPairTradingFees(base, venueA, venueB, fillSources, 30),
  };
  pair.daysOpen = pairDaysOpen(base, venueA, venueB, paymentSources, fillSources);
  const sinceMs = pair.daysOpen
    ? Date.now() - Math.ceil(pair.daysOpen) * 86400000
    : Date.now() - fillHistoryDays * 86400000;
  pair.feesSinceOpen = sumPairTradingFeesSince(base, venueA, venueB, fillSources, sinceMs);
  pair.feesHistoryComplete = !pair.daysOpen || pair.daysOpen <= fillHistoryDays;
  pair.venueA = venueA;
  pair.venueB = venueB;
}

function buildDailyFundingSeries({
  hlPayments = [],
  nadoPayments = [],
  grvtPayments = [],
  extendedPayments = [],
  hlFills = [],
  nadoMatches = [],
  grvtFills = [],
  extendedFills = [],
  days = 30,
  pairedBases = null,
}) {
  const allow = pairedBases ? new Set(pairedBases) : null;
  const fundingByDay = {};
  const feesByDay = {};
  const venueByDay = {};

  const addFunding = (payments, venue) => {
    for (const p of payments) {
      if (allow && !allow.has(toBaseSymbol(p.symbol))) continue;
      const day = isoDateFromMs(p.time);
      fundingByDay[day] = (fundingByDay[day] || 0) + (p.usdc || 0);
      if (!venueByDay[day]) venueByDay[day] = {};
      venueByDay[day][venue] = (venueByDay[day][venue] || 0) + (p.usdc || 0);
    }
  };

  const addFees = (items, symbolKey = 'symbol', feeKey = 'fee') => {
    for (const item of items) {
      if (allow && symbolKey && !allow.has(toBaseSymbol(item[symbolKey]))) continue;
      const day = isoDateFromMs(item.time);
      feesByDay[day] = (feesByDay[day] || 0) + (item[feeKey] || 0);
    }
  };

  addFunding(hlPayments, 'hyperliquid');
  addFunding(nadoPayments, 'nado');
  addFunding(grvtPayments, 'grvt');
  addFunding(extendedPayments, 'extended');
  addFees(hlFills);
  addFees(nadoMatches);
  addFees(grvtFills);
  addFees(extendedFills);

  const endDay = isoDateFromMs(Date.now());
  const startDay = isoDateFromMs(Date.now() - days * 86400000);
  const points = [];
  let cumFunding = 0;
  let cumFees = 0;
  let cumNet = 0;

  for (let d = new Date(startDay + 'T00:00:00Z'); d <= new Date(endDay + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
    const day = d.toISOString().slice(0, 10);
    const dailyFunding = fundingByDay[day] || 0;
    const dailyFees = feesByDay[day] || 0;
    const dailyNet = dailyFunding - dailyFees;
    cumFunding += dailyFunding;
    cumFees += dailyFees;
    cumNet += dailyNet;
    points.push({
      ts: d.getTime() + 43200000,
      day,
      dailyFunding,
      dailyFees,
      dailyNet,
      cumFunding,
      cumFees,
      cumNet,
      byVenue: venueByDay[day] || {},
    });
  }

  return points;
}

function buildFundingCumulativeSeries(hlPayments, nadoPayments, days, pairedBases = null, grvtPayments = null, extendedPayments = null) {
  return buildDailyFundingSeries({
    hlPayments,
    nadoPayments,
    grvtPayments: grvtPayments || [],
    extendedPayments: extendedPayments || [],
    days,
    pairedBases,
  }).map(p => ({
    ts: p.ts,
    day: p.day,
    dailyFunding: p.dailyFunding,
    cumFunding: p.cumFunding,
  }));
}

function buildNetArbSeries(fundingPoints, totalFees, days) {
  if (!fundingPoints.length) return [];
  const hasDailyFees = fundingPoints.some(p => p.dailyFees != null);
  if (hasDailyFees) {
    return fundingPoints.map(p => ({
      ...p,
      cumNetArb: p.cumNet ?? (p.cumFunding - (p.cumFees || 0)),
    }));
  }
  const feePerDay = totalFees / Math.max(days, 1);
  let cumFees = 0;
  return fundingPoints.map(p => {
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
  grvtState = null,
  extendedState = null,
  hlFunding,
  nadoFunding,
  grvtFunding = null,
  extendedFunding = null,
  extendedFundingSinceOpen = null,
  hlFills,
  nadoMatches,
  grvtFills = null,
  extendedFills = null,
  spreadRows,
  days,
  fillHistoryDays = PERPS_MAX_FILL_HISTORY_DAYS,
}) {
  const grvt = grvtState || { positions: [] };
  const extended = extendedState || { positions: [] };
  const hlByBase = Object.fromEntries(hlState.positions.map(p => [toBaseSymbol(p.symbol), p]));
  const nadoByBase = Object.fromEntries(nadoState.positions.map(p => [toBaseSymbol(p.symbol), p]));
  const grvtByBase = Object.fromEntries(grvt.positions.map(p => [toBaseSymbol(p.symbol), p]));
  const extendedByBase = Object.fromEntries(extended.positions.map(p => [toBaseSymbol(p.symbol), p]));
  const spreadByBase = Object.fromEntries(spreadRows.map(r => [r.symbol, r]));

  const fundingHl = sumByBase(hlFunding.payments, 'usdc');
  const fundingNado = sumByBase(nadoFunding.payments, 'usdc');
  const fundingGrvt = grvtFunding ? sumByBase(grvtFunding.payments, 'usdc') : {};
  const fundingExtendedWindow = extendedFunding ? sumByBase(extendedFunding.payments, 'usdc') : {};
  const fundingExtendedSinceOpen = extendedFundingSinceOpen
    ? sumByBase(extendedFundingSinceOpen.payments, 'usdc')
    : fundingExtendedWindow;
  const fundingMaps = {
    hl: fundingHl,
    nado: fundingNado,
    grvt: fundingGrvt,
    extended: fundingExtendedWindow,
  };
  const paymentSources = {
    hyperliquid: hlFunding.payments || [],
    nado: nadoFunding.payments || [],
    grvt: grvtFunding?.payments || [],
    extended: extendedFunding?.payments || [],
  };
  const fillSources = {
    hyperliquid: hlFills.fills || [],
    nado: nadoMatches.matches || [],
    grvt: grvtFills?.fills || [],
    extended: extendedFills?.fills || [],
  };
  const feesHl = sumByBase(hlFills.fills, 'fee');
  const feesNado = sumByBase(nadoMatches.matches, 'fee');
  const feesGrvt = grvtFills ? sumByBase(grvtFills.fills, 'fee') : {};
  const feesExtended = extendedFills ? sumByBase(extendedFills.fills, 'fee') : {};
  const realizedHl = sumByBase(hlFills.fills, 'closedPnl');
  const realizedNado = sumByBase(nadoMatches.matches, 'realizedPnl');
  const realizedGrvt = grvtFills ? sumByBase(grvtFills.fills, 'closedPnl') : {};
  const realizedExtended = extendedFills ? sumByBase(extendedFills.fills, 'closedPnl') : {};

  const paired = [];
  const unhedged = [];
  const hedgedLegs = new Set();

  function markHedged(base, ...venues) {
    for (const venue of venues) hedgedLegs.add(`${base}:${venue}`);
  }

  function isHedged(base, venue) {
    return hedgedLegs.has(`${base}:${venue}`);
  }

  function pushHlNadoPair(base, hl, na) {
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
    const hlFundingSinceOpenVal = hlFundingSinceOpen(hl);
    const nadoFundingSinceOpenVal = na.fundingSinceOpen;
    const fundingSinceOpen = (hlFundingSinceOpenVal ?? 0) + (nadoFundingSinceOpenVal ?? 0);
    const fundingWindow = (fundingHl[base] || 0) + (fundingNado[base] || 0);
    const fees = (feesHl[base] || 0) + (feesNado[base] || 0);
    const realized = (realizedHl[base] || 0) + (realizedNado[base] || 0);
    const netArbPnl = fundingSinceOpen + combinedUpnl + realized - fees;
    const spread = spreadByBase[base];
    const currentSpread8h = netFundingSpread8h(
      hl.size,
      spread?.hyperliquid8h,
      na.size,
      spread?.nado8h,
    );
    const periodsInWindow = (days * 3);
    const breakEvenSpread8h = avgNotional > 0 && periodsInWindow > 0
      ? fees / (avgNotional * periodsInWindow)
      : null;
    const alerts = [];
    if (sizeMismatchPct > 1) alerts.push('size_mismatch');
    if (Math.abs(combinedUpnl) > 500) alerts.push('basis_drift');
    if (breakEvenSpread8h != null && currentSpread8h != null && currentSpread8h < breakEvenSpread8h) {
      alerts.push('spread_below_breakeven');
    }
    paired.push({
      symbol: base,
      pairType: 'hl_nado',
      pairLabel: 'HL + Nado',
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
      hlFundingSinceOpen: hlFundingSinceOpenVal,
      nadoFundingSinceOpen: nadoFundingSinceOpenVal,
      fundingSinceOpen,
      fundingWindow,
      fees,
      realized,
      netArbPnl,
      currentSpread8h,
      fundingRate8hA: spread?.hyperliquid8h ?? null,
      fundingRate8hB: spread?.nado8h ?? null,
      breakEvenSpread8h,
      spreadCoversBreakeven: breakEvenSpread8h == null || currentSpread8h == null
        ? null
        : currentSpread8h >= breakEvenSpread8h,
      alerts,
      hl,
      nado: na,
    });
    attachPairFundingMeta(paired[paired.length - 1], base, 'hyperliquid', 'nado', paymentSources, fillSources, fillHistoryDays);
    markHedged(base, 'hyperliquid', 'nado');
  }

  function pushCrossPair(base, pairType, pairLabel, legA, legB, venueA, venueB, fundingA, fundingB, feesA, feesB, spreadKey) {
    const upnlA = legA.unrealizedPnl ?? 0;
    const upnlB = legB.unrealizedPnl ?? 0;
    const combinedUpnl = upnlA + upnlB;
    const sizeA = Math.abs(legA.size);
    const sizeB = Math.abs(legB.size);
    const maxSize = Math.max(sizeA, sizeB, 1);
    const sizeMismatchPct = (Math.abs(sizeA - sizeB) / maxSize) * 100;
    const avgNotional = ((legA.notional || 0) + (legB.notional || 0)) / 2;
    const fundingSinceOpen = (fundingA ?? 0) + (fundingB ?? 0);
    const fundingWindow = fundingForVenueInWindow(venueA, base, fundingMaps)
      + fundingForVenueInWindow(venueB, base, fundingMaps);
    const fees = (feesA || 0) + (feesB || 0);
    const spread = spreadByBase[base];
    const currentSpread8h = netFundingSpread8h(
      legA.size,
      venueRate8h(spread, venueA),
      legB.size,
      venueRate8h(spread, venueB),
    );
    const alerts = [];
    if (sizeMismatchPct > 1) alerts.push('size_mismatch');
    if (Math.abs(combinedUpnl) > 500) alerts.push('basis_drift');
    paired.push({
      symbol: base,
      pairType,
      pairLabel,
      hlSize: venueA === 'hyperliquid' ? legA.size : venueB === 'hyperliquid' ? legB.size : null,
      nadoSize: venueA === 'nado' ? legA.size : venueB === 'nado' ? legB.size : null,
      hlEntry: venueA === 'hyperliquid' ? legA.entryPx : venueB === 'hyperliquid' ? legB.entryPx : null,
      nadoEntry: venueA === 'nado' ? legA.entryPx : venueB === 'nado' ? legB.entryPx : null,
      hlUpnl: venueA === 'hyperliquid' ? upnlA : venueB === 'hyperliquid' ? upnlB : null,
      nadoUpnl: venueA === 'nado' ? upnlA : venueB === 'nado' ? upnlB : null,
      legAFundingSinceOpen: fundingA,
      legBFundingSinceOpen: fundingB,
      combinedUpnl,
      sizeMismatchPct,
      entrySlippage: null,
      avgNotional,
      hlFundingSinceOpen: venueA === 'hyperliquid' ? fundingA : venueB === 'hyperliquid' ? fundingB : null,
      nadoFundingSinceOpen: venueA === 'nado' ? fundingA : venueB === 'nado' ? fundingB : null,
      fundingSinceOpen,
      fundingWindow,
      fees,
      realized: 0,
      netArbPnl: fundingSinceOpen + combinedUpnl - fees,
      currentSpread8h,
      fundingRate8hA: venueRate8h(spread, venueA),
      fundingRate8hB: venueRate8h(spread, venueB),
      breakEvenSpread8h: null,
      spreadCoversBreakeven: null,
      alerts,
      crossLegA: { venue: venueA, ...legA },
      crossLegB: { venue: venueB, ...legB },
    });
    attachPairFundingMeta(paired[paired.length - 1], base, venueA, venueB, paymentSources, fillSources, fillHistoryDays);
    markHedged(base, venueA, venueB);
  }

  function getFundingSinceOpen(venue, leg, base) {
    if (venue === 'hyperliquid') return hlFundingSinceOpen(leg) ?? fundingHl[base] ?? 0;
    if (venue === 'nado') return leg.fundingSinceOpen ?? fundingNado[base] ?? 0;
    if (venue === 'grvt') return grvtFundingSinceOpen(leg) ?? fundingGrvt[base] ?? 0;
    if (venue === 'extended') return fundingExtendedSinceOpen[base] ?? fundingExtendedWindow[base] ?? 0;
    return 0;
  }

  function getFeesForVenue(venue, base) {
    if (venue === 'hyperliquid') return feesHl[base] || 0;
    if (venue === 'nado') return feesNado[base] || 0;
    if (venue === 'grvt') return feesGrvt[base] || 0;
    if (venue === 'extended') return feesExtended[base] || 0;
    return 0;
  }

  const venueMaps = {
    hyperliquid: hlByBase,
    nado: nadoByBase,
    grvt: grvtByBase,
    extended: extendedByBase,
  };

  /** All venue pairs — earlier entries take priority when a leg could match multiple hedges. */
  const pairSpecs = [
    { venues: ['hyperliquid', 'nado'], pairType: 'hl_nado', pairLabel: 'HL + Nado', spreadKey: 'spread8h', hlNado: true },
    { venues: ['nado', 'extended'], pairType: 'nado_extended', pairLabel: 'Nado + Extended', spreadKey: 'spreadNadoExtended8h' },
    { venues: ['hyperliquid', 'grvt'], pairType: 'hl_grvt', pairLabel: 'HL + GRVT', spreadKey: 'spreadHlGrvt8h' },
    { venues: ['hyperliquid', 'extended'], pairType: 'hl_extended', pairLabel: 'HL + Extended', spreadKey: 'spreadHlExtended8h' },
    { venues: ['nado', 'grvt'], pairType: 'nado_grvt', pairLabel: 'Nado + GRVT', spreadKey: 'spreadNadoGrvt8h' },
    { venues: ['grvt', 'extended'], pairType: 'grvt_extended', pairLabel: 'GRVT + Extended', spreadKey: 'spreadGrvtExtended8h' },
  ];

  const allBases = new Set([
    ...Object.keys(hlByBase),
    ...Object.keys(nadoByBase),
    ...Object.keys(grvtByBase),
    ...Object.keys(extendedByBase),
  ]);

  for (const spec of pairSpecs) {
    const [venueA, venueB] = spec.venues;
    const mapA = venueMaps[venueA];
    const mapB = venueMaps[venueB];
    for (const base of [...allBases].sort()) {
      const legA = mapA[base];
      const legB = mapB[base];
      if (!legA || !legB) continue;
      if (isHedged(base, venueA) || isHedged(base, venueB)) continue;
      if (spec.hlNado) {
        pushHlNadoPair(base, legA, legB);
      } else {
        pushCrossPair(
          base, spec.pairType, spec.pairLabel,
          legA, legB, venueA, venueB,
          getFundingSinceOpen(venueA, legA, base),
          getFundingSinceOpen(venueB, legB, base),
          getFeesForVenue(venueA, base),
          getFeesForVenue(venueB, base),
          spec.spreadKey,
        );
      }
    }
  }

  const legSpecs = [
    { venue: 'hyperliquid', map: hlByBase, funding: (p, b) => hlFundingSinceOpen(p) ?? fundingHl[b] ?? 0, fees: feesHl },
    { venue: 'nado', map: nadoByBase, funding: (p, b) => p.fundingSinceOpen ?? fundingNado[b] ?? 0, fees: feesNado },
    { venue: 'grvt', map: grvtByBase, funding: (p, b) => grvtFundingSinceOpen(p) ?? fundingGrvt[b] ?? 0, fees: feesGrvt },
    { venue: 'extended', map: extendedByBase, funding: (p, b) => fundingExtendedSinceOpen[b] ?? fundingExtendedWindow[b] ?? 0, fees: feesExtended },
  ];

  for (const base of [...allBases].sort()) {
    for (const { venue, map, funding, fees } of legSpecs) {
      const leg = map[base];
      if (!leg || isHedged(base, venue)) continue;
      unhedged.push({
        symbol: base,
        venue,
        size: leg.size,
        side: leg.side,
        notional: leg.notional,
        unrealizedPnl: leg.unrealizedPnl,
        funding: funding(leg, base),
        fees: fees[base] || 0,
      });
    }
  }

  const combinedUpnl = paired.reduce((s, p) => s + p.combinedUpnl, 0);
  const pairedFundingSinceOpen = paired.reduce((s, p) => s + (p.fundingSinceOpen ?? 0), 0);
  const pairedHlFundingSinceOpen = paired.reduce((s, p) => s + (p.hlFundingSinceOpen ?? 0), 0);
  const pairedNadoFundingSinceOpen = paired.reduce((s, p) => s + (p.nadoFundingSinceOpen ?? 0), 0);
  const pairedFundingWindow = paired.reduce((s, p) => s + (p.fundingWindow ?? 0), 0);
  const pairedFees = paired.reduce((s, p) => s + p.fees, 0);
  const pairedRealized = paired.reduce((s, p) => s + p.realized, 0);
  const totalFees = hlFills.totalFees + nadoMatches.totalFees + (grvtFills?.totalFees || 0) + (extendedFills?.totalFees || 0);
  const totalRealized = hlFills.totalRealized + nadoMatches.totalRealized + (grvtFills?.totalRealized || 0) + (extendedFills?.totalRealized || 0);
  const totalEntrySlippage = paired.reduce((s, p) => s + (p.entrySlippage || 0), 0);
  const netFunding = hlFunding.totalFunding + nadoFunding.totalFunding + (grvtFunding?.totalFunding || 0) + (extendedFunding?.totalFunding || 0);
  const netArbPnl = pairedFundingSinceOpen + combinedUpnl + pairedRealized - pairedFees;
  const avgNotional = paired.reduce((s, p) => s + p.avgNotional, 0) || 0;
  const netFundingApr = avgNotional > 0 ? (pairedFundingWindow / avgNotional) * (365 / days) * 100 : null;
  const netArbApr = avgNotional > 0 ? ((pairedFundingWindow - pairedFees) / avgNotional) * (365 / days) * 100 : null;

  return {
    paired,
    unhedged,
    combinedUpnl,
    pairedFunding: pairedFundingSinceOpen,
    pairedFundingSinceOpen,
    pairedHlFundingSinceOpen,
    pairedNadoFundingSinceOpen,
    pairedFundingWindow,
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
  const grvtSubAccount = wallets.grvtSubAccount
    || process.env.GRVT_SUB_ACCOUNT_ID
    || DEFAULT_GRVT_SUB_ACCOUNT;
  const days = wallets.days || 30;
  const fillHistoryDays = Math.min(
    PERPS_MAX_FILL_HISTORY_DAYS,
    Math.max(days, PERPS_MAX_FILL_HISTORY_DAYS),
  );

  const grvtEnabled = Boolean(grvtSubAccount && process.env.GRVT_API_KEY);
  const extendedEnabled = Boolean(process.env.EXTENDED_API_KEY);

  const [
    hlState,
    nadoState,
    hlFunding,
    nadoFunding,
    hlFills,
    nadoMatches,
    hlRates,
    nadoRates,
    hlCapitalFlows,
    nadoCapitalFlows,
    grvtState,
    grvtFunding,
    grvtFills,
    grvtCapitalFlows,
    extendedState,
    extendedFunding,
    extendedFills,
    extendedCapitalFlows,
  ] = await Promise.all([
    fetchHyperliquidState(hlWallet),
    fetchNadoState(nadoWallet),
    fetchHyperliquidFunding(hlWallet, days),
    fetchNadoFunding(nadoWallet, days),
    fetchHyperliquidFills(hlWallet, fillHistoryDays),
    fetchNadoMatches(nadoWallet, fillHistoryDays),
    fetchHyperliquidRates(),
    fetchNadoRates(),
    fetchHyperliquidCapitalFlows(hlWallet),
    fetchNadoCapitalFlows(nadoWallet),
    grvtEnabled ? fetchGrvtState(grvtSubAccount).catch(e => ({
      venue: 'grvt',
      subAccountId: grvtSubAccount,
      exists: false,
      accountValue: 0,
      positions: [],
      error: e.message,
    })) : Promise.resolve({
      venue: 'grvt',
      subAccountId: grvtSubAccount,
      configured: false,
      exists: false,
      accountValue: 0,
      positions: [],
    }),
    grvtEnabled ? fetchGrvtFunding(grvtSubAccount, days).catch(() => ({
      venue: 'grvt', subAccountId: grvtSubAccount, days, payments: [], totalFunding: 0,
    })) : Promise.resolve({ venue: 'grvt', subAccountId: grvtSubAccount, days, payments: [], totalFunding: 0 }),
    grvtEnabled ? fetchGrvtFills(grvtSubAccount, fillHistoryDays).catch(() => ({
      venue: 'grvt', subAccountId: grvtSubAccount, days, fills: [], totalFees: 0, totalRealized: 0,
    })) : Promise.resolve({ venue: 'grvt', subAccountId: grvtSubAccount, days, fills: [], totalFees: 0, totalRealized: 0 }),
    grvtEnabled ? fetchGrvtCapitalFlows(grvtSubAccount).catch(() => ({
      venue: 'grvt', subAccountId: grvtSubAccount, payments: [], netDeposits: 0,
    })) : Promise.resolve({ venue: 'grvt', subAccountId: grvtSubAccount, payments: [], netDeposits: 0 }),
    extendedEnabled ? fetchExtendedState().catch(e => ({
      venue: 'extended', exists: false, accountValue: 0, positions: [], error: e.message,
    })) : Promise.resolve({
      venue: 'extended', configured: false, exists: false, accountValue: 0, positions: [],
    }),
    extendedEnabled ? fetchExtendedFunding(Math.max(days, 365)).catch(() => ({
      venue: 'extended', days, payments: [], totalFunding: 0,
    })) : Promise.resolve({ venue: 'extended', days, payments: [], totalFunding: 0 }),
    extendedEnabled ? fetchExtendedFills(fillHistoryDays).catch(() => ({
      venue: 'extended', days, fills: [], totalFees: 0, totalRealized: 0,
    })) : Promise.resolve({ venue: 'extended', days, fills: [], totalFees: 0, totalRealized: 0 }),
    extendedEnabled ? fetchExtendedCapitalFlows().catch(() => ({
      venue: 'extended', payments: [], netDeposits: 0,
    })) : Promise.resolve({ venue: 'extended', payments: [], netDeposits: 0 }),
  ]);

  const [grvtRates, extendedRates] = await Promise.all([
    grvtEnabled
      ? fetchGrvtRates(grvtState.positions.map(p => p.symbol)).catch(() => [])
      : Promise.resolve([]),
    extendedEnabled
      ? fetchExtendedRates(extendedState.positions.map(p => p.symbol)).catch(() => [])
      : Promise.resolve([]),
  ]);

  const hlRateBySymbol = Object.fromEntries(hlRates.map(r => [r.symbol, r]));
  const nadoRateByBase = {};
  for (const r of nadoRates) {
    const base = r.symbol.replace(/-PERP$/i, '');
    nadoRateByBase[base] = r;
  }
  const grvtRateByBase = Object.fromEntries(grvtRates.map(r => [r.symbol, r]));
  const extendedRateByBase = Object.fromEntries(extendedRates.map(r => [r.symbol, r]));

  const spreadRows = [];
  const bases = new Set([
    ...hlState.positions.map(p => p.symbol),
    ...nadoState.positions.map(p => p.symbol.replace(/-PERP$/i, '')),
    ...grvtState.positions.map(p => p.symbol),
    ...extendedState.positions.map(p => p.symbol),
    'BTC', 'ETH', 'SOL',
  ]);
  for (const base of bases) {
    const hl = hlRateBySymbol[base];
    const na = nadoRateByBase[base];
    const gv = grvtRateByBase[base];
    const ex = extendedRateByBase[base];
    if (!hl && !na && !gv && !ex) continue;
    const hl8h = hl?.fundingRate8h ?? null;
    const naDaily = na?.fundingRateDaily ?? null;
    const na8h = naDaily != null ? naDaily / 3 : null;
    const grvt8h = gv?.fundingRate8h ?? null;
    const grvtIntervalRate = gv?.fundingRateInterval ?? null;
    const grvtIntervalHours = gv?.fundingIntervalHours ?? 8;
    const extended8h = ex?.fundingRate8h ?? null;
    spreadRows.push({
      symbol: base,
      hyperliquidHourly: hl?.fundingRateHourly ?? null,
      hyperliquid8h: hl8h,
      nadoDaily: naDaily,
      nado8h: na8h,
      grvt8h,
      grvtIntervalRate,
      grvtIntervalHours,
      extended8h,
      extendedHourly: ex?.fundingRateHourly ?? (extended8h != null ? extended8h / 8 : null),
      spread8h: hl8h != null && na8h != null ? hl8h - na8h : null,
      spreadHlGrvt8h: hl8h != null && grvt8h != null ? hl8h - grvt8h : null,
      spreadHlExtended8h: hl8h != null && extended8h != null ? hl8h - extended8h : null,
      spreadNadoExtended8h: na8h != null && extended8h != null ? na8h - extended8h : null,
      spreadNadoGrvt8h: na8h != null && grvt8h != null ? na8h - grvt8h : null,
      spreadGrvtExtended8h: grvt8h != null && extended8h != null ? grvt8h - extended8h : null,
    });
  }

  const extendedWindowStart = Date.now() - days * 86400000;
  const extendedAllPayments = extendedFunding.payments || [];
  const extendedWindowPayments = extendedAllPayments.filter(p => p.time >= extendedWindowStart);
  const extendedFundingWindow = {
    ...extendedFunding,
    days,
    payments: extendedWindowPayments,
    totalFunding: extendedWindowPayments.reduce((s, p) => s + (p.usdc || 0), 0),
  };
  const extendedFundingSinceOpen = {
    ...extendedFunding,
    payments: extendedAllPayments,
    totalFunding: extendedAllPayments.reduce((s, p) => s + (p.usdc || 0), 0),
  };

  const arb = buildPairedAnalysis({
    hlState,
    nadoState,
    grvtState,
    extendedState,
    hlFunding,
    nadoFunding,
    grvtFunding,
    extendedFunding: extendedFundingWindow,
    extendedFundingSinceOpen,
    hlFills,
    nadoMatches,
    grvtFills,
    extendedFills,
    spreadRows,
    days,
    fillHistoryDays,
  });

  const dailySeriesInputs = {
    hlPayments: hlFunding.payments,
    nadoPayments: nadoFunding.payments,
    grvtPayments: grvtFunding.payments,
    extendedPayments: extendedWindowPayments,
    hlFills: hlFills.fills,
    nadoMatches: nadoMatches.matches,
    grvtFills: grvtFills.fills,
    extendedFills: extendedFills.fills,
    days,
  };
  const dailyFundingSeries = buildDailyFundingSeries(dailySeriesInputs);
  for (const p of arb.paired) {
    p.dailyPerformanceSeries = buildDailyFundingSeries({
      ...dailySeriesInputs,
      pairedBases: [p.symbol],
    });
  }
  const fundingSeries = buildFundingCumulativeSeries(
    hlFunding.payments,
    nadoFunding.payments,
    days,
    arb.paired.map(p => p.symbol),
    grvtFunding.payments,
    extendedWindowPayments,
  );
  const pairedDailyFundingSeries = buildDailyFundingSeries({
    hlPayments: hlFunding.payments,
    nadoPayments: nadoFunding.payments,
    grvtPayments: grvtFunding.payments,
    extendedPayments: extendedWindowPayments,
    hlFills: hlFills.fills,
    nadoMatches: nadoMatches.matches,
    grvtFills: grvtFills.fills,
    extendedFills: extendedFills.fills,
    days,
    pairedBases: arb.paired.map(p => p.symbol),
  });
  const netArbSeries = buildNetArbSeries(pairedDailyFundingSeries, arb.pairedFees, days);

  const fetchedAt = Date.now();
  const capitalFlows = {
    hl: hlCapitalFlows,
    nado: nadoCapitalFlows,
    grvt: grvtCapitalFlows,
    extended: extendedCapitalFlows,
    ...computeCombinedNetDeposits(hlCapitalFlows, nadoCapitalFlows, grvtCapitalFlows, extendedCapitalFlows),
  };
  const grvtEquity = grvtState.accountValue ?? 0;
  const extendedEquity = extendedState.accountValue ?? 0;
  const equityNow = {
    hl: hlState.accountValue,
    nado: nadoState.accountValue ?? 0,
    grvt: grvtEquity,
    extended: extendedEquity,
    total: hlState.accountValue + (nadoState.accountValue ?? 0) + grvtEquity + extendedEquity,
    adjustedTotal: hlState.accountValue + (nadoState.accountValue ?? 0) + grvtEquity + extendedEquity - capitalFlows.combinedNetDeposits,
  };
  const equitySeries = buildEquitySeries({
    capitalFlows,
    hlAccountValue: hlState.accountValue,
    nadoAccountValue: nadoState.accountValue ?? 0,
    grvtAccountValue: grvtEquity,
    extendedAccountValue: extendedEquity,
    fetchedAt,
    snapshots: [],
    backfill: [],
  });

  return {
    fetchedAt,
    days,
    wallets: { hyperliquid: hlWallet, nado: nadoWallet, grvtSubAccount },
    grvt: {
      state: grvtState,
      funding: grvtFunding,
      fills: grvtFills,
      configured: grvtEnabled,
    },
    extended: {
      state: extendedState,
      funding: extendedFunding,
      fills: extendedFills,
      configured: extendedEnabled,
    },
    hyperliquid: { state: hlState, funding: hlFunding, fills: hlFills },
    nado: { state: nadoState, funding: nadoFunding, matches: nadoMatches },
    rateSpread: spreadRows.sort((a, b) => a.symbol.localeCompare(b.symbol)),
    paired: arb.paired,
    unhedged: arb.unhedged,
    fundingSeries,
    dailyFundingSeries,
    netArbSeries,
    capitalFlows,
    equityNow,
    equitySeries,
    walletPnl: equityNow.adjustedTotal,
    curveWalletPnl: equitySeries.walletPnl,
    summary: {
      hlFundingTotal: hlFunding.totalFunding,
      nadoFundingTotal: nadoFunding.totalFunding,
      grvtFundingTotal: grvtFunding.totalFunding,
      extendedFundingTotal: extendedFundingWindow.totalFunding,
      extendedFundingSinceOpenTotal: extendedFundingSinceOpen.totalFunding,
      netFundingTotal: hlFunding.totalFunding + nadoFunding.totalFunding + grvtFunding.totalFunding + extendedFunding.totalFunding,
      hlPositionCount: hlState.positions.length,
      nadoPositionCount: nadoState.positions.length,
      grvtPositionCount: grvtState.positions.length,
      extendedPositionCount: extendedState.positions.length,
      hlAccountValue: hlState.accountValue,
      nadoAccountValue: nadoState.accountValue ?? 0,
      grvtAccountValue: grvtEquity,
      extendedAccountValue: extendedEquity,
      grvtConfigured: grvtEnabled,
      grvtError: grvtState.error || null,
      extendedConfigured: extendedEnabled,
      extendedError: extendedState.error || null,
      nadoExists: nadoState.exists,
      combinedUpnl: arb.combinedUpnl,
      pairedFunding: arb.pairedFundingSinceOpen,
      pairedFundingSinceOpen: arb.pairedFundingSinceOpen,
      pairedHlFundingSinceOpen: arb.pairedHlFundingSinceOpen,
      pairedNadoFundingSinceOpen: arb.pairedNadoFundingSinceOpen,
      pairedFundingWindow: arb.pairedFundingWindow,
      netFundingTotalAllAccounts: hlFunding.totalFunding + nadoFunding.totalFunding + grvtFunding.totalFunding + extendedFunding.totalFunding,
      pairedFees: arb.pairedFees,
      pairedRealized: arb.pairedRealized,
      totalFees: arb.totalFees,
      hlFees: hlFills.totalFees,
      nadoFees: nadoMatches.totalFees,
      grvtFees: grvtFills.totalFees,
      extendedFees: extendedFills.totalFees,
      totalRealized: arb.totalRealized,
      totalEntrySlippage: arb.totalEntrySlippage,
      netArbPnl: arb.netArbPnl,
      avgNotional: arb.avgNotional,
      netFundingApr: arb.netFundingApr,
      netArbApr: arb.netArbApr,
      pairedCount: arb.paired.length,
      fillHistoryDays,
      days,
      unhedgedCount: arb.unhedged.length,
      walletPnl: equityNow.adjustedTotal,
      curveWalletPnl: equitySeries.walletPnl,
      combinedNetDeposits: capitalFlows.combinedNetDeposits,
      rawCombinedNetDeposits: capitalFlows.rawCombinedNetDeposits,
      crossVenueOffset: capitalFlows.crossVenueOffset,
      grvtNetDeposits: capitalFlows.grvtNetDeposits,
      extendedNetDeposits: capitalFlows.extendedNetDeposits,
      adjustedEquity: equityNow.adjustedTotal,
    },
  };
}

function perpsEquityBucketKey(ms) {
  const d = new Date(ms);
  const h = Math.floor(d.getUTCHours() / 4) * 4;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}T${String(h).padStart(2, '0')}`;
}

function parseEquityBucketTime(key) {
  if (!key) return 0;
  if (key.includes('T')) return Date.parse(`${key}:00:00.000Z`) || 0;
  return Date.parse(key) || 0;
}

function buildEquitySnapshotFromDashboard(data) {
  const s = data.summary || {};
  const fetchedAt = data.fetchedAt || Date.now();
  const hlAccountValue = s.hlAccountValue ?? data.equityNow?.hl ?? 0;
  const nadoAccountValue = s.nadoAccountValue ?? data.equityNow?.nado ?? 0;
  const grvtAccountValue = s.grvtAccountValue ?? data.equityNow?.grvt ?? 0;
  const extendedAccountValue = s.extendedAccountValue ?? data.equityNow?.extended ?? 0;
  const totalEquity = hlAccountValue + nadoAccountValue + grvtAccountValue + extendedAccountValue;
  const combinedNetDeposits = s.combinedNetDeposits
    ?? data.capitalFlows?.combinedNetDeposits
    ?? 0;
  const key = perpsEquityBucketKey(fetchedAt);
  const date = new Date(fetchedAt).toISOString().slice(0, 10);
  return {
    key,
    record: {
      date,
      bucket: key,
      hlAccountValue,
      nadoAccountValue,
      grvtAccountValue,
      extendedAccountValue,
      totalEquity,
      adjustedEquity: s.adjustedEquity ?? data.equityNow?.adjustedTotal ?? totalEquity - combinedNetDeposits,
      cumulativeNetDeposits: combinedNetDeposits,
      fetchedAt,
    },
  };
}

function appendEquitySnapshotStore(store, data, maxEntries = 180) {
  const next = { ...(store || {}) };
  const { key, record } = buildEquitySnapshotFromDashboard(data);
  next[key] = record;
  const keys = Object.keys(next).sort((a, b) => parseEquityBucketTime(a) - parseEquityBucketTime(b));
  while (keys.length > maxEntries) {
    delete next[keys.shift()];
  }
  return next;
}

module.exports = {
  nadoSubaccount,
  toBaseSymbol,
  perpsEquityBucketKey,
  parseEquityBucketTime,
  buildEquitySnapshotFromDashboard,
  appendEquitySnapshotStore,
  fetchHyperliquidState,
  fetchHyperliquidFunding,
  fetchHyperliquidFills,
  fetchHyperliquidRates,
  fetchHyperliquidCapitalFlows,
  fetchNadoState,
  fetchNadoFunding,
  fetchNadoMatches,
  fetchNadoRates,
  fetchNadoCapitalFlows,
  fetchGrvtState,
  fetchGrvtFunding,
  fetchGrvtFills,
  fetchGrvtCapitalFlows,
  fetchGrvtRates,
  fetchExtendedState,
  fetchExtendedFunding,
  fetchExtendedFills,
  fetchExtendedCapitalFlows,
  fetchExtendedRates,
  fetchPerpsDashboard,
  buildPairedAnalysis,
  buildFundingCumulativeSeries,
  buildDailyFundingSeries,
  buildEquitySeries,
  computeCombinedNetDeposits,
  PERPS_MAX_FILL_HISTORY_DAYS,
};

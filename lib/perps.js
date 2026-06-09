/**
 * Perps DEX helpers — Hyperliquid + Nado + GRVT.
 * GRVT account data requires GRVT_API_KEY on the server (Vercel env).
 */

const HL_INFO = 'https://api.hyperliquid.xyz/info';
const NADO_GATEWAY = 'https://gateway.prod.nado.xyz/v1';
const NADO_ARCHIVE = 'https://archive.prod.nado.xyz/v1';
const NADO_TRIGGER = 'https://trigger.prod.nado.xyz/v1';
const GRVT_AUTH = 'https://edge.grvt.io/auth/api_key/login';
const GRVT_TRADES = 'https://trades.grvt.io/full/v1';
const GRVT_MARKET = 'https://market-data.grvt.io/full/v1';
const DEFAULT_GRVT_SUB_ACCOUNT = '4860249204328359';
const PERPS_CORE_FETCH_TIMEOUT_MS = 45000;
const PERPS_OPTIONAL_FETCH_TIMEOUT_MS = 25000;
const PERPS_NADO_HISTORY_TIMEOUT_MS = 55000;
const PERPS_GRVT_HISTORY_TIMEOUT_MS = 60000;
const PERPS_NADO_PRODUCT_CONCURRENCY = 2;
const PERPS_NADO_ARCHIVE_RETRIES = 4;
const PERPS_GRVT_HISTORY_MAX_PAGES = 40;

const X18 = 1e18;

function fromX18(v) {
  if (v == null || v === '') return 0;
  return Number(v) / X18;
}

function toBaseSymbol(symbol) {
  return String(symbol || '').replace(/-PERP$/i, '');
}

function errorMessage(e) {
  return e?.message || String(e || 'unknown error');
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function mapConcurrent(items, fn, concurrency = PERPS_NADO_PRODUCT_CONCURRENCY) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

async function fetchWithTimeout(url, opts = {}, ms = PERPS_CORE_FETCH_TIMEOUT_MS, label = 'fetch') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } catch (e) {
    if (e?.name === 'AbortError') {
      throw new Error(`${label} timed out after ${Math.round(ms / 1000)}s`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function combineErrors(...items) {
  return items
    .map(item => item?.error)
    .filter(Boolean)
    .join('; ') || null;
}

function nadoSubaccount(wallet, name = 'default') {
  const addr = String(wallet || '').toLowerCase().replace(/^0x/, '');
  if (!/^[\da-f]{40}$/.test(addr)) throw new Error('Invalid wallet address');
  const nameHex = Buffer.from(name, 'utf8').toString('hex').padEnd(24, '0').slice(0, 24);
  return '0x' + addr + nameHex;
}

async function hlPost(body) {
  const r = await fetchWithTimeout(HL_INFO, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, PERPS_CORE_FETCH_TIMEOUT_MS, 'Hyperliquid API');
  if (!r.ok) throw new Error(`Hyperliquid HTTP ${r.status}`);
  return r.json();
}

async function nadoQuery(params) {
  const qs = new URLSearchParams(params);
  const r = await fetchWithTimeout(`${NADO_GATEWAY}/query?${qs}`, {}, PERPS_CORE_FETCH_TIMEOUT_MS, 'NADO gateway');
  if (!r.ok) throw new Error(`Nado gateway HTTP ${r.status}`);
  const data = await r.json();
  if (data.status !== 'success') throw new Error(data.error || 'Nado query failed');
  return data.data;
}

async function nadoArchive(body) {
  let lastError = null;
  for (let attempt = 0; attempt < PERPS_NADO_ARCHIVE_RETRIES; attempt++) {
    try {
      const r = await fetchWithTimeout(NADO_ARCHIVE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, PERPS_CORE_FETCH_TIMEOUT_MS, 'NADO archive');
      if (r.status === 429) {
        lastError = new Error('Nado archive HTTP 429');
        const backoffMs = 400 * (2 ** attempt);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        continue;
      }
      if (!r.ok) throw new Error(`Nado archive HTTP ${r.status}`);
      return r.json();
    } catch (e) {
      lastError = e;
      if (attempt + 1 >= PERPS_NADO_ARCHIVE_RETRIES) break;
      const backoffMs = 400 * (2 ** attempt);
      await new Promise(resolve => setTimeout(resolve, backoffMs));
    }
  }
  throw lastError || new Error('Nado archive failed');
}

let _grvtAuthCache = null;

function msToGrvtNs(ms) {
  return String(BigInt(Math.floor(Number(ms) || 0)) * 1000000n);
}

function normalizeUnixMs(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || !n) return 0;
  if (Math.abs(n) >= 1e16) return Math.floor(n / 1e6);
  if (Math.abs(n) >= 1e13) return Math.floor(n / 1000);
  if (Math.abs(n) < 1e11) return Math.floor(n * 1000);
  return Math.floor(n);
}

function grvtNsToMs(ns) {
  const raw = ns == null ? '' : String(ns);
  if (!raw) return 0;
  try {
    const n = BigInt(raw);
    if (n >= 10000000000000000n) return Number(n / 1000000n);
    if (n >= 10000000000000n) return Number(n / 1000n);
    if (n < 100000000000n) return Number(n * 1000n);
    return Number(n);
  } catch {
    return normalizeUnixMs(raw);
  }
}

function grvtBatch(data) {
  const raw = data?.result ?? data?.r;
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    const nested = raw.result ?? raw.r;
    if (Array.isArray(nested)) return nested;
  }
  return [];
}

function grvtNextCursor(data) {
  return String(data?.next ?? data?.n ?? '');
}

function mapGrvtFillRow(row) {
  const instrument = row.instrument ?? row.i;
  return {
    venue: 'grvt',
    time: grvtNsToMs(row.event_time ?? row.et),
    symbol: grvtBaseFromInstrument(instrument),
    instrument,
    px: grvtPx(row.price ?? row.p),
    sz: parseFloat(row.size ?? row.s ?? 0),
    side: parseGrvtIsBuyer(row.is_buyer ?? row.ib) ? 'buy' : 'sell',
    fee: Math.abs(parseFloat(row.fee ?? row.f ?? 0)),
    closedPnl: parseFloat(row.realized_pnl ?? row.rp ?? 0),
  };
}

function grvtBaseFromInstrument(instrument) {
  return String(instrument || '').split('_')[0] || instrument;
}

function parseGrvtIsBuyer(value) {
  return parseGrvtBoolean(value);
}

function parseGrvtBoolean(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0 || value == null) return false;
  const s = String(value).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
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
  return raw;
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

  const r = await fetchWithTimeout(GRVT_AUTH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: 'rm=true;' },
    body: JSON.stringify({ api_key: apiKey }),
  }, PERPS_OPTIONAL_FETCH_TIMEOUT_MS, 'GRVT auth');
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
  const r = await fetchWithTimeout(`${GRVT_TRADES}/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: auth.cookie,
      'X-Grvt-Account-Id': auth.accountId,
    },
    body: JSON.stringify(body),
  }, PERPS_OPTIONAL_FETCH_TIMEOUT_MS, `GRVT ${path}`);
  const data = await r.json().catch(() => ({}));
  grvtThrowIfError(data, `GRVT ${path}`);
  if (!r.ok) throw new Error(data.message || data.error || `GRVT ${path} HTTP ${r.status}`);
  return data;
}

function grvtPx(raw) {
  const v = parseFloat(raw);
  if (!Number.isFinite(v)) return 0;
  // GRVT prices are 9-decimal fixed point integers; account_summary may return decimals.
  if (Math.abs(v) >= 1e6) return v / 1e9;
  return v;
}

function firstNumber(...values) {
  for (const value of values) {
    const n = parseFloat(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function pickNested(obj, keys) {
  for (const key of keys) {
    const direct = obj?.[key];
    if (direct != null) return direct;
    const nested = obj?.position?.[key]
      ?? obj?.risk?.[key]
      ?? obj?.accountRisk?.[key]
      ?? obj?.margin?.[key]
      ?? obj?.balance?.[key];
    if (nested != null) return nested;
  }
  return null;
}

function liquidationPriceFrom(obj, pxFn = v => firstNumber(v)) {
  const raw = pickNested(obj, [
    'liquidationPx',
    'liquidation_px',
    'liquidationPrice',
    'liquidation_price',
    'estimatedLiquidationPrice',
    'estimated_liquidation_price',
    'estLiquidationPrice',
    'est_liquidation_price',
    'el',
    'liqPx',
    'liq_px',
    'liqPrice',
    'liq_price',
    'liquidation_price_x18',
    'liquidationPriceX18',
    'liq_price_x18',
    'liqPriceX18',
  ]);
  return pxFn(raw) || null;
}

function computeNadoLiquidationPx({
  amount,
  oracle,
  maintenanceHealth,
  longWeightMaint,
  shortWeightMaint,
}) {
  const size = Number(amount || 0);
  const mark = Number(oracle || 0);
  const health = Number(maintenanceHealth || 0);
  if (!size || !mark || !health) return null;
  if (size > 0 && longWeightMaint > 0) {
    const liq = mark - health / size / longWeightMaint;
    return liq > 0 && Number.isFinite(liq) ? liq : null;
  }
  if (size < 0 && shortWeightMaint > 0) {
    const liq = mark + health * shortWeightMaint / Math.abs(size);
    return liq > 0 && liq < mark * 10 && Number.isFinite(liq) ? liq : null;
  }
  return null;
}

function nadoLiquidationPriceFrom(balanceRow, ctx = null) {
  const x18 = pickNested(balanceRow, [
    'liquidation_price_x18',
    'liquidationPriceX18',
    'liq_price_x18',
    'liqPriceX18',
  ]);
  const parsedX18 = fromX18(x18);
  if (Number.isFinite(parsedX18) && parsedX18 > 0) return parsedX18;
  const direct = liquidationPriceFrom(balanceRow);
  if (direct != null) return direct;
  if (!ctx) return null;
  return computeNadoLiquidationPx(ctx);
}

function tpslPxFrom(raw) {
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function mergeTpslEntry(map, symbol, kind, px) {
  const base = toBaseSymbol(symbol);
  if (!base || px == null) return;
  const entry = map.get(base) || { tpPx: null, slPx: null };
  if (kind === 'tp' && entry.tpPx == null) entry.tpPx = px;
  else if (kind === 'sl' && entry.slPx == null) entry.slPx = px;
  map.set(base, entry);
}

function attachTpslToPositions(positions, tpslByBase) {
  for (const p of positions || []) {
    const t = tpslByBase.get(toBaseSymbol(p.symbol));
    p.tpPx = t?.tpPx ?? null;
    p.slPx = t?.slPx ?? null;
  }
}

function classifyHyperliquidTpslOrder(order) {
  const orderType = String(order?.orderType || '').toLowerCase();
  if (/take\s*profit/.test(orderType) || orderType === 'tp') return 'tp';
  if (/stop/.test(orderType)) return 'sl';
  const cond = String(order?.triggerCondition || '').toLowerCase();
  if (cond.includes('tp') || cond.includes('take profit')) return 'tp';
  if (cond.includes('sl') || cond.includes('stop')) return 'sl';
  return null;
}

function parseHyperliquidTpslOrders(orders) {
  const map = new Map();
  for (const order of orders || []) {
    if (!order?.isPositionTpsl && !(order?.isTrigger && order?.reduceOnly)) continue;
    const triggerPx = tpslPxFrom(order.triggerPx);
    if (triggerPx == null) continue;
    const kind = classifyHyperliquidTpslOrder(order);
    if (!kind) continue;
    mergeTpslEntry(map, order.coin, kind, triggerPx);
  }
  return map;
}

function normalizeGrvtOrderRow(row) {
  const o = row || {};
  return {
    ...o,
    legs: o.legs ?? o.l,
    trigger: o.trigger ?? o.t,
  };
}

function grvtTriggerType(order) {
  const raw = order?.trigger?.trigger_type ?? order?.trigger?.tt;
  if (raw === 'TAKE_PROFIT' || raw === 1) return 'tp';
  if (raw === 'STOP_LOSS' || raw === 2) return 'sl';
  return null;
}

function parseGrvtTpslOrders(data) {
  const map = new Map();
  for (const row of grvtBatch(data)) {
    const order = normalizeGrvtOrderRow(row);
    const kind = grvtTriggerType(order);
    if (!kind) continue;
    const tpsl = order.trigger?.tpsl ?? order.trigger?.t;
    const triggerPx = tpslPxFrom(grvtPx(tpsl?.trigger_price ?? tpsl?.tp));
    if (triggerPx == null) continue;
    const leg = (order.legs || [])[0];
    const instrument = leg?.instrument ?? leg?.i;
    if (!instrument) continue;
    mergeTpslEntry(map, grvtBaseFromInstrument(instrument), kind, triggerPx);
  }
  return map;
}

function classifyNadoTriggerSide(trigger, positionSize) {
  const req = trigger?.price_trigger?.price_requirement || {};
  const key = Object.keys(req)[0];
  if (!key) return null;
  const px = tpslPxFrom(fromX18(req[key]));
  if (px == null) return null;
  const isAbove = /above$/i.test(key);
  const isLong = Number(positionSize) >= 0;
  if (isLong) return { kind: isAbove ? 'tp' : 'sl', px };
  return { kind: isAbove ? 'sl' : 'tp', px };
}

function parseNadoTriggerOrders(rows, positions = []) {
  const sizeByProduct = Object.fromEntries((positions || []).map(p => [p.productId, p.size]));
  const map = new Map();
  for (const row of rows || []) {
    const productId = row.product_id ?? row.order?.product_id;
    const trigger = row.trigger ?? row.order?.trigger;
    const classified = classifyNadoTriggerSide(trigger, sizeByProduct[productId] ?? 0);
    if (!classified) continue;
    const symbol = row.symbol
      || (positions.find(p => p.productId === productId) || {}).symbol;
    if (!symbol) continue;
    mergeTpslEntry(map, symbol, classified.kind, classified.px);
  }
  return map;
}

function perpsTpslDiffPct(a, b) {
  const left = Number(a);
  const right = Number(b);
  if (!Number.isFinite(left) || !Number.isFinite(right) || left <= 0 || right <= 0) return null;
  const avg = (left + right) / 2;
  if (avg <= 0) return null;
  return (Math.abs(left - right) / avg) * 100;
}

function perpsTpslMismatch(legs, thresholdPct = 0.5) {
  const rows = (legs || [])
    .map(leg => ({
      tpPx: tpslPxFrom(leg?.tpPx),
      slPx: tpslPxFrom(leg?.slPx),
    }))
    .filter(leg => leg.tpPx != null || leg.slPx != null);
  if (rows.length < 2) return false;
  const tps = rows.map(r => r.tpPx).filter(v => v != null);
  const sls = rows.map(r => r.slPx).filter(v => v != null);
  const tpMismatch = tps.length >= 2 && perpsTpslDiffPct(tps[0], tps[1]) > thresholdPct;
  const slMismatch = sls.length >= 2 && perpsTpslDiffPct(sls[0], sls[1]) > thresholdPct;
  return tpMismatch || slMismatch;
}

const PERPS_RISK_FULL_PCT = 20;
const PERPS_RISK_START_PCT_UP = 58.3;
const PERPS_RISK_START_PCT_DOWN = 50;

function perpsPriceRiskLevel(currentPx, levelPx) {
  const current = Number(currentPx);
  const level = Number(levelPx);
  if (!Number.isFinite(current) || current <= 0 || !Number.isFinite(level) || level <= 0) return 0;
  const distancePct = (Math.abs(current - level) / current) * 100;
  const goingUp = level > current;
  const startPct = goingUp ? PERPS_RISK_START_PCT_UP : PERPS_RISK_START_PCT_DOWN;
  const span = startPct - PERPS_RISK_FULL_PCT;
  if (distancePct <= PERPS_RISK_FULL_PCT) return 1;
  return Math.max(0, Math.min(1, (startPct - distancePct) / span));
}

function perpsPriceRiskStyle(currentPx, levelPx) {
  const risk = perpsPriceRiskLevel(currentPx, levelPx);
  if (risk <= 0) return '';
  const green = Math.round(156 - risk * 64);
  const blue = Math.round(187 - risk * 65);
  return `style="color:rgb(255,${green},${blue});text-shadow:0 0 ${Math.round(6 + risk * 8)}px rgba(255,92,122,${(0.18 + risk * 0.36).toFixed(2)})"`;
}

function perpsLiquidationRiskStyle(currentPx, liquidationPx) {
  return perpsPriceRiskStyle(currentPx, liquidationPx);
}

async function fetchNadoTriggerOrders(subaccount, positions = []) {
  try {
    const r = await fetchWithTimeout(`${NADO_TRIGGER}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'list_trigger_orders',
        tx: {
          sender: subaccount,
          recvTime: String(Date.now() + 90_000),
        },
        signature: '0x',
        trigger_types: ['price_trigger'],
        reduce_only: true,
        limit: 500,
      }),
    }, PERPS_OPTIONAL_FETCH_TIMEOUT_MS, 'NADO trigger orders');
    if (!r.ok) throw new Error(`Nado trigger HTTP ${r.status}`);
    const data = await r.json();
    if (data.status !== 'success') {
      throw new Error(data.error || 'Nado trigger query failed');
    }
    const rows = data.data?.orders
      || data.data?.trigger_orders
      || data.data
      || [];
    return { map: parseNadoTriggerOrders(Array.isArray(rows) ? rows : [], positions) };
  } catch (e) {
    return { map: new Map(), error: errorMessage(e) };
  }
}

function normalizeGrvtPositionRow(row) {
  const p = row || {};
  return {
    ...p,
    instrument: p.instrument ?? p.i,
    size: p.size ?? p.s,
    notional: p.notional ?? p.n,
    entry_price: p.entry_price ?? p.ep,
    mark_price: p.mark_price ?? p.mp,
    unrealized_pnl: p.unrealized_pnl ?? p.up,
    cumulative_realized_funding_payment: p.cumulative_realized_funding_payment ?? p.cr,
    leverage: p.leverage ?? p.l,
    est_liquidation_price: p.est_liquidation_price ?? p.el,
    isolated_mm: p.isolated_mm ?? p.im,
    isolated_balance: p.isolated_balance ?? p.ib,
    margin_type: p.margin_type ?? p.mt,
  };
}

function grvtNotionalUsd(row, size, markPx) {
  const fromMark = Math.abs(size * markPx);
  if (fromMark > 0) return fromMark;
  const raw = Math.abs(parseFloat(row.notional || 0));
  if (!raw) return 0;
  if (raw >= 1e6) return raw / 1e6;
  return raw;
}

function mapGrvtPositions(rows) {
  return (rows || [])
    .map(normalizeGrvtPositionRow)
    .filter(p => Math.abs(parseFloat(p.size || 0)) > 0)
    .map(p => {
      const size = parseFloat(p.size || 0);
      const cumFunding = parseFloat(p.cumulative_realized_funding_payment || 0);
      const markPx = grvtPx(p.mark_price);
      return {
        venue: 'grvt',
        symbol: grvtBaseFromInstrument(p.instrument),
        instrument: p.instrument,
        size,
        side: size >= 0 ? 'long' : 'short',
        entryPx: grvtPx(p.entry_price),
        markPx,
        liquidationPx: liquidationPriceFrom(p, grvtPx),
        notional: grvtNotionalUsd(p, size, markPx),
        unrealizedPnl: parseFloat(p.unrealized_pnl || 0),
        cumFundingSinceOpen: cumFunding,
        cumulativeFundingSinceOpen: cumFunding,
        leverage: p.leverage ? parseFloat(p.leverage) : null,
      };
    });
}

async function grvtMarketPost(path, body) {
  const r = await fetchWithTimeout(`${GRVT_MARKET}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, PERPS_OPTIONAL_FETCH_TIMEOUT_MS, `GRVT market ${path}`);
  if (!r.ok) throw new Error(`GRVT market ${path} HTTP ${r.status}`);
  return r.json();
}

async function grvtPaginate(path, baseBody, windowStartMs, opts = {}) {
  const maxPages = opts.maxPages ?? PERPS_GRVT_HISTORY_MAX_PAGES;
  const rows = [];
  let cursor = '';
  for (let page = 0; page < maxPages; page++) {
    const body = {
      ...baseBody,
      limit: 500,
      cursor,
    };
    if (windowStartMs != null && !opts.omitStartTime) {
      body.start_time = msToGrvtNs(windowStartMs);
    }
    const data = await grvtTradesPost(path, body);
    const batch = grvtBatch(data);
    rows.push(...batch);
    cursor = grvtNextCursor(data);
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

  const [summaryData, posData, openOrdersData] = await Promise.all([
    grvtTradesPost('account_summary', { sub_account_id: String(subAccountId) }),
    grvtTradesPost('positions', {
      sub_account_id: String(subAccountId),
      kind: ['PERPETUAL'],
    }).catch(() => ({ result: [] })),
    grvtTradesPost('open_orders', {
      sub_account_id: String(subAccountId),
      kind: ['PERPETUAL'],
    }).catch(() => ({ result: [] })),
  ]);
  const acc = summaryData.result || {};
  const accountValue = parseFloat(acc.total_equity || 0);
  const positionRows = (posData.result || []).length ? posData.result : (acc.positions || []);
  const positions = mapGrvtPositions(positionRows);
  attachTpslToPositions(positions, parseGrvtTpslOrders(openOrdersData));

  return {
    venue: 'grvt',
    subAccountId,
    configured: true,
    exists: true,
    fetchedAt: Date.now(),
    accountValue,
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
      time: grvtNsToMs(row.event_time ?? row.et),
      symbol: grvtBaseFromInstrument(row.instrument ?? row.i),
      instrument: row.instrument ?? row.i,
      usdc: -parseFloat(row.amount ?? row.a ?? 0),
      size: null,
      intervalHours: row.funding_interval_hours ?? row.fundingIntervalHours ?? null,
    }))
    .filter(p => p.time >= windowStart);

  payments.sort((a, b) => b.time - a.time);
  const totalFunding = payments.reduce((s, p) => s + p.usdc, 0);
  return { venue: 'grvt', subAccountId, days, payments, totalFunding };
}

async function fetchGrvtFills(subAccountId, days = 30) {
  const empty = { venue: 'grvt', subAccountId, days, fills: [], totalFees: 0, totalRealized: 0, rawRowCount: 0 };
  if (!subAccountId || !process.env.GRVT_API_KEY) return empty;

  const windowStart = Date.now() - days * 86400000;
  const baseBody = {
    sub_account_id: String(subAccountId),
    kind: ['PERPETUAL'],
  };
  let rows = await grvtPaginate('fill_history', baseBody, windowStart);
  if (!rows.length) {
    rows = await grvtPaginate('fill_history', baseBody, windowStart, { omitStartTime: true });
  }

  const fills = rows
    .map(mapGrvtFillRow)
    .filter(f => f.time >= windowStart && f.symbol);

  return {
    venue: 'grvt',
    subAccountId,
    days,
    fills,
    rawRowCount: rows.length,
    totalFees: fills.reduce((s, f) => s + f.fee, 0),
    totalRealized: fills.reduce((s, f) => s + f.closedPnl, 0),
  };
}

async function fetchGrvtPositionHistory(subAccountId, days = 30) {
  const empty = { venue: 'grvt', subAccountId, days, positions: [], rawRowCount: 0 };
  if (!subAccountId || !process.env.GRVT_API_KEY) return empty;

  const windowStart = Date.now() - days * 86400000;
  const baseBody = {
    sub_account_id: String(subAccountId),
    kind: ['PERPETUAL'],
    status: ['CLOSED', 'LIQUIDATED'],
  };

  async function pullPages(includeStartTime) {
    const rows = [];
    let cursor = '';
    for (let page = 0; page < PERPS_GRVT_HISTORY_MAX_PAGES; page++) {
      const body = {
        ...baseBody,
        limit: 500,
        cursor,
      };
      if (includeStartTime) body.start_time = msToGrvtNs(windowStart);
      const data = await grvtTradesPost('position_history', body);
      const batch = grvtBatch(data);
      rows.push(...batch);
      cursor = grvtNextCursor(data);
      if (!cursor || !batch.length) break;
    }
    return rows;
  }

  let rows = await pullPages(true);
  if (!rows.length) rows = await pullPages(false);

  const positions = rows.filter(row => {
    if (!grvtPositionIsClosed(row)) return false;
    const closeTime = grvtNsToMs(row.close_time ?? row.ct);
    return closeTime >= windowStart;
  });

  return {
    venue: 'grvt',
    subAccountId,
    days,
    positions,
    rawRowCount: rows.length,
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
  const r = await fetchWithTimeout(url, {
    headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
  }, PERPS_OPTIONAL_FETCH_TIMEOUT_MS, `Extended ${path}`);
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
      const t = normalizeUnixMs(row.paidTime ?? row.time ?? row.createdTime ?? row.updatedTime ?? row.closedTime);
      if (t) oldestInBatch = Math.min(oldestInBatch, t);
    }
    cursor = res.pagination?.cursor;
    if (!cursor) break;
    if (windowStartMs && oldestInBatch < windowStartMs) break;
  }
  return windowStartMs
    ? rows.filter(row => normalizeUnixMs(row.paidTime ?? row.time ?? row.createdTime ?? row.updatedTime ?? row.closedTime) >= windowStartMs)
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
        liquidationPx: liquidationPriceFrom(p),
        tpPx: tpslPxFrom(p.tpTriggerPrice),
        slPx: tpslPxFrom(p.slTriggerPrice),
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
  const equity = parseFloat(bal.equity);
  const accountValue = Number.isFinite(equity) ? equity : 0;
  const balanceUnavailable = !balanceRes.ok || !Number.isFinite(equity);

  return {
    venue: 'extended',
    configured: true,
    exists: accountValue > 0 || positions.length > 0,
    fetchedAt: Date.now(),
    error: balanceUnavailable ? 'Extended balance unavailable' : null,
    accountValue,
    balance: parseFloat(bal.balance || 0),
    availableForTrade: parseFloat(bal.availableForTrade || 0),
    unrealizedPnl: parseFloat(bal.unrealisedPnl || 0),
    accountId: positions[0]?.accountId ?? bal.accountId ?? null,
    positions,
  };
}

async function fetchHyperliquidEquity(wallet) {
  const [state, spotState] = await Promise.all([
    hlPost({ type: 'clearinghouseState', user: wallet }),
    hlPost({ type: 'spotClearinghouseState', user: wallet }).catch(() => ({ balances: [] })),
  ]);
  const perpAccountValue = parseFloat(state.marginSummary?.accountValue || 0);
  const spotEquity = hlSpotEquityUsd(spotState);
  return {
    venue: 'hyperliquid',
    fetchedAt: Date.now(),
    accountValue: spotEquity > 0 ? spotEquity : perpAccountValue,
  };
}

async function fetchNadoEquity(wallet, subaccountName = 'default') {
  const info = await nadoQuery({ type: 'subaccount_info', subaccount: nadoSubaccount(wallet, subaccountName) });
  return {
    venue: 'nado',
    fetchedAt: Date.now(),
    accountValue: nadoAccountEquity(info.healths || []),
  };
}

async function fetchGrvtEquity(subAccountId) {
  if (!subAccountId || !process.env.GRVT_API_KEY) {
    return { venue: 'grvt', configured: false, accountValue: 0 };
  }
  const data = await grvtTradesPost('account_summary', { sub_account_id: String(subAccountId) });
  return {
    venue: 'grvt',
    configured: true,
    fetchedAt: Date.now(),
    accountValue: parseFloat(data.result?.total_equity || 0),
  };
}

async function fetchExtendedEquity() {
  if (!process.env.EXTENDED_API_KEY) {
    return { venue: 'extended', configured: false, accountValue: 0 };
  }
  const balanceRes = await extendedGet('/user/balance');
  const accountValue = parseFloat(balanceRes.data?.equity);
  if (!balanceRes.ok || !Number.isFinite(accountValue)) {
    throw new Error('Extended balance unavailable');
  }
  return {
    venue: 'extended',
    configured: true,
    fetchedAt: Date.now(),
    accountValue,
  };
}

async function fetchPerpsEquitySnapshot(wallets) {
  const grvtSubAccount = wallets.grvtSubAccount
    || process.env.GRVT_SUB_ACCOUNT_ID
    || DEFAULT_GRVT_SUB_ACCOUNT;
  const [hl, nado, grvt, extended] = await Promise.all([
    fetchHyperliquidEquity(wallets.hyperliquid),
    fetchNadoEquity(wallets.nado || wallets.hyperliquid),
    fetchGrvtEquity(grvtSubAccount),
    fetchExtendedEquity(),
  ]);
  const states = [hl, nado, grvt, extended];
  const configuredStates = states.filter(state => state.configured !== false);
  const invalid = configuredStates.find(state => !Number.isFinite(state.accountValue));
  if (invalid) throw new Error(`${invalid.venue} equity unavailable`);
  const equityFetchedAts = Object.fromEntries(
    configuredStates.map(state => [state.venue, state.fetchedAt]),
  );
  const receiptTimes = Object.values(equityFetchedAts).filter(Number.isFinite);
  const fetchedAt = receiptTimes.length ? Math.max(...receiptTimes) : Date.now();
  const equityCollectionSpanMs = receiptTimes.length > 1
    ? Math.max(...receiptTimes) - Math.min(...receiptTimes)
    : 0;
  const hlAccountValue = hl.accountValue;
  const nadoAccountValue = nado.accountValue;
  const grvtAccountValue = grvt.accountValue;
  const extendedAccountValue = extended.accountValue;
  const total = hlAccountValue + nadoAccountValue + grvtAccountValue + extendedAccountValue;
  const combinedNetDeposits = Number.isFinite(wallets.cumulativeNetDeposits)
    ? wallets.cumulativeNetDeposits
    : 0;
  return {
    fetchedAt,
    equityNow: {
      hl: hlAccountValue,
      nado: nadoAccountValue,
      grvt: grvtAccountValue,
      extended: extendedAccountValue,
      total,
      adjustedTotal: total - combinedNetDeposits,
    },
    summary: {
      hlAccountValue,
      nadoAccountValue,
      grvtAccountValue,
      extendedAccountValue,
      grvtConfigured: grvt.configured !== false,
      extendedConfigured: extended.configured !== false,
      combinedNetDeposits,
      adjustedEquity: total - combinedNetDeposits,
      equitySnapshotEligible: true,
      equityCollectionSpanMs,
      equityFetchedAts,
      equitySampleMode: 'concurrent_balance_only',
    },
  };
}

async function fetchExtendedFunding(days = 30) {
  const empty = { venue: 'extended', days, payments: [], totalFunding: 0 };
  if (!process.env.EXTENDED_API_KEY) return empty;

  const windowStart = Date.now() - days * 86400000;
  const rows = await extendedPaginate('/user/funding/history', { startTime: windowStart }, windowStart);

  const payments = rows.map(row => ({
    venue: 'extended',
    time: normalizeUnixMs(row.paidTime ?? row.time ?? row.createdTime),
    symbol: extendedBaseFromMarket(row.market),
    market: row.market,
    size: parseFloat(row.size || 0),
    usdc: extendedFundingUsdc(row),
    fundingRate: parseFloat(row.fundingRate || 0),
    intervalHours: 1,
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
      time: normalizeUnixMs(row.createdTime ?? row.time ?? row.updatedTime),
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

function extendedClosedTimeMs(row) {
  const t = normalizeUnixMs(row.closedTime ?? row.closeTime ?? row.closed_at ?? row.closedAt ?? row.updatedTime);
  return t || null;
}

async function fetchExtendedPositionHistory(days = 30) {
  const empty = { venue: 'extended', days, positions: [] };
  if (!process.env.EXTENDED_API_KEY) return empty;

  const windowStart = Date.now() - days * 86400000;
  const rows = await extendedPaginate('/user/positions/history', { limit: 500 }, 0);
  const positions = rows.filter(row => {
    const closeTime = extendedClosedTimeMs(row);
    return closeTime != null && closeTime >= windowStart;
  });

  return { venue: 'extended', days, positions };
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
  const res = await fetchWithTimeout(
    `${EXTENDED_API}/info/markets?${[...symbols].map(m => `market=${encodeURIComponent(m)}`).join('&')}`,
    {},
    PERPS_OPTIONAL_FETCH_TIMEOUT_MS,
    'Extended rates',
  );
  const data = await res.json().catch(() => ({}));
  if (data.status !== 'OK') return [];
  return (data.data || []).map(m => {
    const stats = m.marketStats || m.market_stats || {};
    const hourly = parseFloat(
      stats.fundingRate
      ?? stats.funding_rate
      ?? stats.nextFundingRate
      ?? stats.next_funding_rate
      ?? m.fundingRate
      ?? m.funding_rate
      ?? 0
    );
    return {
      venue: 'extended',
      symbol: extendedBaseFromMarket(m.name || m.market),
      market: m.name || m.market,
      fundingRate8h: hourly * 8,
      fundingRateHourly: hourly,
      markPx: parseFloat(stats.markPrice ?? stats.mark_price ?? m.markPrice ?? m.mark_price ?? 0),
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
  const [state, spotState, assetCtxs, openOrders] = await Promise.all([
    hlPost({ type: 'clearinghouseState', user: wallet }),
    hlPost({ type: 'spotClearinghouseState', user: wallet }).catch(() => ({ balances: [] })),
    hlPost({ type: 'metaAndAssetCtxs' }).catch(() => null),
    hlPost({ type: 'frontendOpenOrders', user: wallet }).catch(() => []),
  ]);
  const tpslByBase = parseHyperliquidTpslOrders(openOrders);
  const markByCoin = {};
  if (Array.isArray(assetCtxs) && assetCtxs.length >= 2) {
    const [meta, ctxRows] = assetCtxs;
    (meta?.universe || []).forEach((asset, idx) => {
      const mark = parseFloat(ctxRows?.[idx]?.markPx || 0);
      if (asset?.name && mark > 0) markByCoin[asset.name] = mark;
    });
  }
  const positions = (state.assetPositions || [])
    .filter(p => Math.abs(parseFloat(p.position?.szi || 0)) > 0)
    .map(p => {
      const pos = p.position;
      const markPx = parseFloat(pos.markPx || pos.oraclePx || pos.midPx || markByCoin[pos.coin] || 0) || null;
      return {
        venue: 'hyperliquid',
        symbol: pos.coin,
        size: parseFloat(pos.szi),
        side: parseFloat(pos.szi) >= 0 ? 'long' : 'short',
        entryPx: parseFloat(pos.entryPx || 0),
        markPx,
        liquidationPx: liquidationPriceFrom(pos),
        notional: parseFloat(pos.positionValue || 0),
        unrealizedPnl: parseFloat(pos.unrealizedPnl || 0),
        cumFundingAllTime: parseFloat(pos.cumFunding?.allTime || 0),
        cumFundingSinceOpen: parseFloat(pos.cumFunding?.sinceOpen || 0),
        leverage: pos.leverage?.value ? parseFloat(pos.leverage.value) : null,
      };
    });
  attachTpslToPositions(positions, tpslByBase);

  const perpAccountValue = parseFloat(state.marginSummary?.accountValue || 0);
  const spotEquity = hlSpotEquityUsd(spotState);
  // Unified HL accounts: spotClearinghouseState is the source of truth for total trading balance.
  const accountValue = spotEquity > 0 ? spotEquity : perpAccountValue;

  return {
    venue: 'hyperliquid',
    wallet,
    fetchedAt: Date.now(),
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
      const d = row.delta || row;
      const key = `${row.time}:${row.hash || ''}:${d.coin || row.coin || ''}:${d.usdc ?? row.usdc ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return Number(row.time) >= windowStart;
    })
    .map(row => {
      const d = row.delta || row;
      const usdc = parseFloat(d.usdc ?? row.usdc ?? 0);
      return {
        venue: 'hyperliquid',
        time: Number(row.time) || 0,
        symbol: d.coin || row.coin,
        fundingRate: parseFloat(d.fundingRate ?? d.funding_rate ?? row.fundingRate ?? row.funding_rate ?? 0),
        size: parseFloat(d.szi ?? d.sz ?? d.size ?? row.szi ?? row.sz ?? row.size ?? 0),
        // Hyperliquid userFunding delta.usdc is already signed:
        // negative = paid, positive = received.
        usdc: Number.isFinite(usdc) ? usdc : 0,
        intervalHours: 1,
      };
    })
    .filter(p => p.time >= windowStart && p.symbol);
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
  const errors = [];
  await Promise.all(productIds.map(async (productId) => {
    try {
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
    } catch (e) {
      errors.push(errorMessage(e));
    }
  }));
  if (errors.length && !Object.keys(map).length) {
    map.__error = [...new Set(errors)].join('; ');
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

  const maintenanceHealth = fromX18(info.healths?.[1]?.health);
  const productById = Object.fromEntries((info.perp_products || []).map(p => [p.product_id, p]));
  const positions = openBalances
    .map(b => {
      const amount = fromX18(b.balance?.amount);
      const symbol = symMap.idToSymbol[b.product_id] || `PID${b.product_id}`;
      const pnl = pnlByProduct[b.product_id];
      const oracle = oracleByProduct[b.product_id] ?? null;
      const risk = productById[b.product_id]?.risk || {};
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
        liquidationPx: nadoLiquidationPriceFrom(b, {
          amount,
          oracle,
          maintenanceHealth,
          longWeightMaint: fromX18(risk.long_weight_maintenance_x18),
          shortWeightMaint: fromX18(risk.short_weight_maintenance_x18),
        }),
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
  const errors = [];
  if (pnlByProduct.__error) errors.push(`NADO position events unavailable: ${pnlByProduct.__error}`);
  return {
    venue: 'nado',
    wallet,
    subaccount,
    exists: !!info.exists,
    fetchedAt: Date.now(),
    accountValue: nadoAccountEquity(healths),
    health: unweighted ? fromX18(unweighted.health) : null,
    positions,
    error: errors.length ? errors.join('; ') : null,
  };
}

async function fetchNadoFunding(wallet, days = 30, subaccountName = 'default', symbols = null) {
  const subaccount = nadoSubaccount(wallet, subaccountName);
  const symMap = await nadoSymbolMap();
  const requested = new Set((symbols || []).map(toBaseSymbol).filter(Boolean));
  const allProductIds = Object.entries(symMap.idToSymbol)
    .filter(([, symbol]) => requested.size ? requested.has(toBaseSymbol(symbol)) : false)
    .map(([productId]) => Number(productId));
  const sinceSec = Math.floor(Date.now() / 1000) - days * 86400;

  const payments = [];
  const seen = new Set();
  if (!allProductIds.length) {
    return { venue: 'nado', wallet, subaccount, days, payments, totalFunding: 0 };
  }

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
          intervalHours: 24,
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

function mapNadoMatchRow(m, tsByIdx, symMap) {
  const idx = String(m.submission_idx);
  const tsSec = tsByIdx[idx] || 0;
  const productId = m.pre_balance?.base?.perp?.product_id
    ?? m.post_balance?.base?.perp?.product_id
    ?? null;
  const symbol = symMap.idToSymbol[productId] || `PID${productId}`;
  const baseFilled = fromX18(m.base_filled);
  const quoteFilled = fromX18(m.quote_filled);
  return {
    venue: 'nado',
    time: tsSec ? tsSec * 1000 : 0,
    submissionIdx: idx,
    symbol,
    productId,
    px: baseFilled !== 0 ? Math.abs(quoteFilled / baseFilled) : fromX18(m.order?.priceX18),
    size: baseFilled,
    fee: fromX18(m.fee),
    realizedPnl: fromX18(m.realized_pnl || 0),
    isTaker: !!m.is_taker,
  };
}

async function fetchNadoProductMatches(subaccount, productId, symMap, sinceSec) {
  const rows = [];
  let maxIdx = undefined;
  for (let page = 0; page < 30; page++) {
    const data = await nadoArchive({
      matches: {
        subaccounts: [subaccount],
        product_ids: [productId],
        limit: 100,
        ...(maxIdx != null ? { max_idx: maxIdx } : {}),
      },
    });
    const pageRows = data.matches || [];
    const tsByIdx = Object.fromEntries(
      (data.txs || []).map(tx => [String(tx.submission_idx), Number(tx.timestamp || 0)]),
    );
    if (!pageRows.length) break;

    let oldestTs = Infinity;
    for (const m of pageRows) {
      const idx = String(m.submission_idx);
      const tsSec = tsByIdx[idx] || 0;
      oldestTs = Math.min(oldestTs, tsSec || Infinity);
      if (tsSec && tsSec < sinceSec) continue;
      rows.push(mapNadoMatchRow(m, tsByIdx, symMap));
    }

    if (data.next_idx == null) break;
    maxIdx = data.next_idx;
    if (pageRows.length < 100) break;
    if (oldestTs < sinceSec) break;
  }
  return rows;
}

function mergeNadoMatches(primary, supplemental) {
  const seenIdx = new Set();
  const matches = [];
  for (const row of [...(primary?.matches || []), ...(supplemental?.matches || [])]) {
    const key = row.submissionIdx || `${row.time}:${row.symbol}:${row.size}`;
    if (seenIdx.has(key)) continue;
    seenIdx.add(key);
    matches.push(row);
  }
  matches.sort((a, b) => (b.time || 0) - (a.time || 0));
  const totalFees = matches.reduce((s, m) => s + m.fee, 0);
  const totalRealized = matches.reduce((s, m) => s + m.realizedPnl, 0);
  return {
    venue: 'nado',
    wallet: primary?.wallet || supplemental?.wallet,
    subaccount: primary?.subaccount || supplemental?.subaccount,
    days: primary?.days || supplemental?.days,
    matches,
    totalFees,
    totalRealized,
    error: primary?.error || supplemental?.error || null,
    supplementalCount: supplemental?.matches?.length || 0,
  };
}

function mergeNadoFunding(primary, supplemental) {
  const seen = new Set();
  const payments = [];
  for (const row of [...(primary?.payments || []), ...(supplemental?.payments || [])]) {
    const key = `${row.time}:${row.productId}:${row.usdc}`;
    if (seen.has(key)) continue;
    seen.add(key);
    payments.push(row);
  }
  payments.sort((a, b) => b.time - a.time);
  const totalFunding = payments.reduce((s, p) => s + p.usdc, 0);
  return {
    venue: 'nado',
    wallet: primary?.wallet || supplemental?.wallet,
    subaccount: primary?.subaccount || supplemental?.subaccount,
    days: primary?.days || supplemental?.days,
    payments,
    totalFunding,
    error: primary?.error || supplemental?.error || null,
    supplementalCount: supplemental?.payments?.length || 0,
  };
}

async function fetchNadoMatches(wallet, days = 30, subaccountName = 'default', symbols = null) {
  const subaccount = nadoSubaccount(wallet, subaccountName);
  const symMap = await nadoSymbolMap();
  const requested = new Set((symbols || []).map(toBaseSymbol).filter(Boolean));
  const productIds = Object.entries(symMap.idToSymbol)
    .filter(([, symbol]) => requested.size ? requested.has(toBaseSymbol(symbol)) : false)
    .map(([productId]) => Number(productId));
  const sinceSec = Math.floor(Date.now() / 1000) - days * 86400;

  if (!productIds.length) {
    return { venue: 'nado', wallet, subaccount, days, matches: [], totalFees: 0, totalRealized: 0 };
  }

  // Query one product at a time. Multi-product archive queries only return the
  // latest mixed batch (often 100 rows), which drops closed symbols like MEGA.
  const perProduct = await mapConcurrent(productIds, productId =>
    fetchNadoProductMatches(subaccount, productId, symMap, sinceSec),
  );
  const seenIdx = new Set();
  const matches = [];
  for (const rows of perProduct) {
    for (const row of rows) {
      const key = row.submissionIdx || `${row.time}:${row.symbol}:${row.size}`;
      if (seenIdx.has(key)) continue;
      seenIdx.add(key);
      matches.push(row);
    }
  }
  matches.sort((a, b) => (b.time || 0) - (a.time || 0));

  const totalFees = matches.reduce((s, m) => s + m.fee, 0);
  const totalRealized = matches.reduce((s, m) => s + m.realizedPnl, 0);
  return { venue: 'nado', wallet, subaccount, days, matches, totalFees, totalRealized, productCount: productIds.length };
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

function computeCrossVenueOffset(paymentGroups, windowMs) {
  const events = (paymentGroups || []).flatMap((payments, venue) =>
    (payments || [])
      .filter(p => Number.isFinite(p.usdc) && Number.isFinite(p.time) && p.usdc !== 0)
      .map(p => ({ ...p, venue })),
  );

  const offsetForSign = (sign) => {
    const rows = events.filter(p => Math.sign(p.usdc) === sign).sort((a, b) => a.time - b.time);
    let offset = 0;
    for (let i = 0; i < rows.length;) {
      const clusterStart = rows[i].time;
      const byVenue = new Map();
      let j = i;
      while (j < rows.length && rows[j].time - clusterStart <= windowMs) {
        byVenue.set(rows[j].venue, (byVenue.get(rows[j].venue) || 0) + Math.abs(rows[j].usdc));
        j += 1;
      }
      if (byVenue.size > 1) {
        const venueTotals = [...byVenue.values()];
        const duplicated = venueTotals.reduce((sum, value) => sum + value, 0) - Math.max(...venueTotals);
        if (duplicated > 50) offset += sign * duplicated;
      }
      i = j;
    }
    return offset;
  };

  return offsetForSign(1) + offsetForSign(-1);
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

  const paymentGroups = [hlP, nadoP];
  if (grvtCapitalFlows) paymentGroups.push(grvtP);
  if (extendedCapitalFlows) paymentGroups.push(extendedP);
  const crossVenueOffset = computeCrossVenueOffset(paymentGroups, windowMs);

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
  return sumPairFundingPaymentsSince(base, venueA, venueB, paymentSources, cutoff);
}

function sumVenueFundingPaymentsSince(base, venue, paymentSources, sinceMs) {
  let sum = 0;
  for (const p of paymentSources?.[venue] || []) {
    if (toBaseSymbol(p.symbol) !== base) continue;
    const time = Number(p.time) || 0;
    if (sinceMs && time < sinceMs) continue;
    sum += p.usdc || 0;
  }
  return sum;
}

function sumPairFundingPaymentsSince(base, venueA, venueB, paymentSources, sinceMs) {
  return sumVenueFundingPaymentsSince(base, venueA, paymentSources, sinceMs)
    + sumVenueFundingPaymentsSince(base, venueB, paymentSources, sinceMs);
}

function applyPairFundingSinceOpen(pair, base, venueA, venueB, paymentSources, sinceMs) {
  const fundA = sumVenueFundingPaymentsSince(base, venueA, paymentSources, sinceMs);
  const fundB = sumVenueFundingPaymentsSince(base, venueB, paymentSources, sinceMs);
  pair.fundingSinceOpen = fundA + fundB;
  pair.legAFundingSinceOpen = fundA;
  pair.legBFundingSinceOpen = fundB;
  if (pair.pairType === 'hl_nado') {
    pair.hlFundingSinceOpen = fundA;
    pair.nadoFundingSinceOpen = fundB;
  } else {
    if (venueA === 'hyperliquid') pair.hlFundingSinceOpen = fundA;
    else if (venueB === 'hyperliquid') pair.hlFundingSinceOpen = fundB;
    if (venueA === 'nado') pair.nadoFundingSinceOpen = fundA;
    else if (venueB === 'nado') pair.nadoFundingSinceOpen = fundB;
  }
  const realized = Number(pair.realized) || 0;
  const fees = Number(pair.fees) || 0;
  pair.netArbPnl = pair.fundingSinceOpen + (pair.combinedUpnl ?? 0) + realized - fees;
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

function fundingEventsForPair(base, venueA, venueB, paymentSources, sinceMs = 0) {
  const venues = new Set([venueA, venueB]);
  const start = Number(sinceMs || 0);
  const rows = [];
  for (const [venue, payments] of Object.entries(paymentSources || {})) {
    if (!venues.has(venue)) continue;
    for (const p of payments || []) {
      const time = Number(p.time || 0);
      if (toBaseSymbol(p.symbol) !== base || (start && time < start)) continue;
      rows.push({
        venue,
        time,
        usdc: p.usdc || 0,
        symbol: p.symbol,
        intervalHours: p.intervalHours ?? null,
      });
    }
  }
  return rows.sort((a, b) => b.time - a.time);
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

function earliestFundingMsForPair(base, venueA, venueB, paymentSources) {
  const venues = new Set([venueA, venueB]);
  let earliest = null;
  for (const [venue, payments] of Object.entries(paymentSources || {})) {
    if (!venues.has(venue)) continue;
    for (const p of payments || []) {
      if (toBaseSymbol(p.symbol) !== base) continue;
      const t = Number(p.time) || 0;
      if (!t) continue;
      if (earliest == null || t < earliest) earliest = t;
    }
  }
  return earliest;
}

/** When this symbol hedge was first opened — earliest fill or funding on either leg. */
function pairOpenedAtMs(base, venueA, venueB, fillSources, paymentSources) {
  const candidates = [];
  const ta = earliestFillMsForPair(base, venueA, fillSources);
  const tb = earliestFillMsForPair(base, venueB, fillSources);
  if (ta != null) candidates.push(ta);
  if (tb != null) candidates.push(tb);
  const earliestFunding = earliestFundingMsForPair(base, venueA, venueB, paymentSources);
  if (earliestFunding != null) candidates.push(earliestFunding);
  return candidates.length ? Math.min(...candidates) : null;
}

function pairDaysOpen(base, venueA, venueB, paymentSources, fillSources) {
  const openMs = pairOpenedAtMs(base, venueA, venueB, fillSources, paymentSources);
  if (openMs == null) return null;
  return Math.max((Date.now() - openMs) / 86400000, 1 / 24);
}

const PERPS_MAX_FILL_HISTORY_DAYS = 365;

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
  pair.pairOpenedAtMs = pairOpenedAtMs(base, venueA, venueB, fillSources, paymentSources);
  pair.daysOpen = pairDaysOpen(base, venueA, venueB, paymentSources, fillSources);
  const sinceMs = pair.pairOpenedAtMs ?? (Date.now() - fillHistoryDays * 86400000);
  applyPairFundingSinceOpen(pair, base, venueA, venueB, paymentSources, sinceMs);
  pair.feesSinceOpen = sumPairTradingFeesSince(base, venueA, venueB, fillSources, sinceMs);
  pair.recentFundingEvents = fundingEventsForPair(base, venueA, venueB, paymentSources, sinceMs);
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
  const fundingEventsByDay = {};
  const feeEventsByDay = {};

  const addFunding = (payments, venue) => {
    for (const p of payments) {
      if (allow && !allow.has(toBaseSymbol(p.symbol))) continue;
      const day = isoDateFromMs(p.time);
      fundingByDay[day] = (fundingByDay[day] || 0) + (p.usdc || 0);
      if (!venueByDay[day]) venueByDay[day] = {};
      venueByDay[day][venue] = (venueByDay[day][venue] || 0) + (p.usdc || 0);
      if (!fundingEventsByDay[day]) fundingEventsByDay[day] = [];
      fundingEventsByDay[day].push({ time: p.time, usdc: p.usdc || 0, venue, intervalHours: p.intervalHours ?? null });
    }
  };

  const addFees = (items, symbolKey = 'symbol', feeKey = 'fee') => {
    for (const item of items) {
      if (allow && symbolKey && !allow.has(toBaseSymbol(item[symbolKey]))) continue;
      const day = isoDateFromMs(item.time);
      feesByDay[day] = (feesByDay[day] || 0) + (item[feeKey] || 0);
      if (!feeEventsByDay[day]) feeEventsByDay[day] = [];
      feeEventsByDay[day].push({ time: item.time, fee: item[feeKey] || 0 });
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
      fundingEvents: fundingEventsByDay[day] || [],
      feeEvents: feeEventsByDay[day] || [],
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

const CLOSED_PAIR_MATCH_WINDOW_MS = 30 * 60 * 1000;
const CLOSED_PAIR_SYNTHETIC_MATCH_WINDOW_MS = 6 * 60 * 60 * 1000;
const CLOSED_SYNTHETIC_CLOSE_CLUSTER_MS = 3600000;
const CLOSED_ROUND_EPS = 1e-8;
const CLOSED_PAIR_MAX_SIZE_MISMATCH_PCT = 5;

function closedFillKey(fill) {
  return `${fill.venue || ''}:${fill.time || 0}:${fill.submissionIdx || fill.oid || ''}:${fill.symbol || ''}:${fill.px || 0}:${fill.sz ?? fill.size ?? 0}:${fill.side || ''}`;
}

function closedLegSizeMismatchPct(a, b) {
  const aSize = Math.abs(Number(a?.size || 0));
  const bSize = Math.abs(Number(b?.size || 0));
  const maxSize = Math.max(aSize, bSize);
  if (!maxSize) return 0;
  return Math.abs(aSize - bSize) / maxSize * 100;
}

function closedLegCanScaleToMatch(source, target) {
  const sourceSize = Math.abs(Number(source?.size || 0));
  const targetSize = Math.abs(Number(target?.size || 0));
  if (!source?.fromExchangeHistory || !sourceSize || !targetSize) return false;
  return sourceSize > targetSize && targetSize / sourceSize > 0;
}

function scaleClosedLegToSize(leg, targetSize) {
  const oldSize = Math.abs(Number(leg?.size || 0));
  const nextSize = Math.abs(Number(targetSize || 0));
  if (!oldSize || !nextSize || Math.abs(oldSize - nextSize) <= CLOSED_ROUND_EPS) return leg;
  const ratio = nextSize / oldSize;
  return {
    ...leg,
    size: nextSize,
    realizedPnl: Number(leg.realizedPnl || 0) * ratio,
    fees: Number(leg.fees || 0) * ratio,
    funding: Number(leg.funding || 0) * ratio,
    sizeAdjustedFrom: oldSize,
    sizeAdjustedRatio: ratio,
  };
}

function normalizeClosedLegPair(a, b) {
  if (closedLegSizeMismatchPct(a, b) <= CLOSED_PAIR_MAX_SIZE_MISMATCH_PCT) return [a, b];
  if (closedLegCanScaleToMatch(a, b)) return [scaleClosedLegToSize(a, b.size), b];
  if (closedLegCanScaleToMatch(b, a)) return [a, scaleClosedLegToSize(b, a.size)];
  return [a, b];
}

function extendedClosedPositionSize(row) {
  return parseFloat(
    row.maxPositionSize
      ?? row.positionSize
      ?? row.size
      ?? row.qty
      ?? row.quantity
      ?? row.closedPositionSize
      ?? row.closedSize
      ?? row.closedQty
      ?? row.closedQuantity
      ?? 0,
  );
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
    .filter(p => toBaseSymbol(p.symbol) === symbol && (p.time || 0) >= start && (p.time || 0) <= end)
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
          .filter(f => Math.sign(f._signedSize) === Math.sign(first._signedSize))
          .reduce((sum, f) => sum + Math.abs(f._signedSize), 0);
        const reportedPnl = round.reduce((sum, f) => sum + Number(f.closedPnl ?? f.realizedPnl ?? 0), 0);
        const fallbackPnl = computeFillRealizedPnl(round);
        const realizedPnl = Math.abs(reportedPnl) > CLOSED_ROUND_EPS ? reportedPnl : fallbackPnl;
        const fees = round.reduce((sum, f) => sum + Math.abs(Number(f.fee || 0)), 0);
        const openTime = Number(first.time || 0);
        const closeTime = Number(last.time || 0);
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
          funding: fundingForClosedLeg(venue, symbol, openTime, closeTime, paymentSources),
          fillCount: round.length,
        });
        round.forEach(f => consumed.add(closedFillKey(f)));
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

      // A sell closes a long; a buy closes a short. This recovers rounds opened before the fetched fill window.
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
        };
      }
      synthetic.closeTime = Math.max(synthetic.closeTime, time);
      synthetic.size += Math.abs(delta);
      synthetic.realizedPnl += realizedPnl;
      synthetic.fees += Math.abs(Number(fill.fee || 0));
      synthetic.fillCount += 1;
    }
    flushSynthetic();
  }
  return legs;
}

function grvtPositionIsClosed(row) {
  const status = row?.status ?? row?.s;
  if (status == null) return Boolean(row.close_time ?? row.ct);
  const statusNum = Number(status);
  if (Number.isFinite(statusNum)) return statusNum >= 1 && statusNum <= 3;
  const normalized = String(status).toUpperCase();
  return normalized === 'CLOSED' || normalized === 'LIQUIDATED' || normalized === 'SETTLED';
}

function buildClosedLegsFromExchangeHistory(exchangeHistory, paymentSources) {
  const grvtHistory = exchangeHistory?.grvt || [];
  const extendedHistory = exchangeHistory?.extended || [];
  const legs = [];

  for (const row of grvtHistory) {
    if (!grvtPositionIsClosed(row)) continue;
    const openTime = grvtNsToMs(row.open_time ?? row.ot);
    const closeTime = grvtNsToMs(row.close_time ?? row.ct);
    if (!openTime || !closeTime) continue;
    const symbol = grvtBaseFromInstrument(row.instrument ?? row.i);
    const isLong = parseGrvtBoolean(row.is_long ?? row.il);
    legs.push({
      venue: 'grvt',
      symbol,
      side: isLong ? 'long' : 'short',
      size: parseFloat(row.closed_volume_base ?? row.cv ?? row.max_open_interest_base ?? row.mo ?? 0),
      openTime,
      closeTime,
      openTimeKnown: true,
      realizedPnl: parseFloat(row.realized_pnl ?? row.rp ?? 0),
      fees: parseFloat(row.cumulative_fee ?? row.cf ?? 0),
      funding: parseFloat(row.cumulative_realized_funding_payment ?? row.cr ?? 0)
        || fundingForClosedLeg('grvt', symbol, openTime, closeTime, paymentSources),
      fillCount: 0,
      fromExchangeHistory: true,
    });
  }

  for (const row of extendedHistory) {
    const closeTime = extendedClosedTimeMs(row);
    const openTime = normalizeUnixMs(row.createdTime ?? row.openTime ?? row.created_at ?? row.createdAt);
    if (!closeTime || !openTime) continue;
    const symbol = extendedBaseFromMarket(row.market);
    const sideRaw = String(row.side || '').toUpperCase();
    legs.push({
      venue: 'extended',
      symbol,
      side: sideRaw === 'SHORT' ? 'short' : 'long',
      size: extendedClosedPositionSize(row),
      openTime,
      closeTime,
      openTimeKnown: true,
      realizedPnl: parseFloat(row.realisedPnl || 0),
      fees: 0,
      funding: fundingForClosedLeg('extended', symbol, openTime, closeTime, paymentSources),
      fillCount: 0,
      fromExchangeHistory: true,
    });
  }

  return legs;
}

function pushClosedPair(pairs, a, b) {
  const [left, right] = normalizeClosedLegPair(a, b);
  const longLeg = left.side === 'long' ? left : right;
  const shortLeg = left.side === 'short' ? left : right;
  const closeSlippage = left.realizedPnl + right.realizedPnl;
  const funding = left.funding + right.funding;
  const fees = left.fees + right.fees;
  pairs.push({
    symbol: left.symbol,
    pairLabel: `${left.venue} + ${right.venue}`,
    openTime: left.openTimeKnown && right.openTimeKnown ? Math.min(left.openTime, right.openTime) : null,
    closeTime: Math.max(left.closeTime, right.closeTime),
    size: Math.min(left.size || 0, right.size || 0),
    sizeMismatchPct: closedLegSizeMismatchPct(left, right),
    longLeg,
    shortLeg,
    closeSlippage,
    funding,
    fees,
    netPnl: closeSlippage + funding - fees,
  });
}

function closedLegsOverlap(a, b) {
  return a.venue === b.venue
    && a.symbol === b.symbol
    && a.side === b.side
    && Math.abs(a.closeTime - b.closeTime) <= CLOSED_PAIR_MATCH_WINDOW_MS;
}

function closedLegsSameUtcCloseDay(a, b) {
  return new Date(a.closeTime).toISOString().slice(0, 10)
    === new Date(b.closeTime).toISOString().slice(0, 10);
}

function closedLegOpenWindowsOverlap(a, b) {
  if (!a.openTimeKnown || !b.openTimeKnown) return false;
  return Math.max(a.openTime, b.openTime) <= Math.min(a.closeTime, b.closeTime);
}

function closedLegsCanPair(a, b) {
  const sizeMismatch = closedLegSizeMismatchPct(a, b);
  if (
    sizeMismatch > CLOSED_PAIR_MAX_SIZE_MISMATCH_PCT
    && !closedLegCanScaleToMatch(a, b)
    && !closedLegCanScaleToMatch(b, a)
  ) {
    return false;
  }
  const closeGap = Math.abs(a.closeTime - b.closeTime);
  if (closeGap <= CLOSED_PAIR_MATCH_WINDOW_MS) return true;
  if ((!a.openTimeKnown || !b.openTimeKnown) && closeGap <= CLOSED_PAIR_SYNTHETIC_MATCH_WINDOW_MS) return true;
  if (!closedLegsSameUtcCloseDay(a, b)) return false;
  if (!a.openTimeKnown || !b.openTimeKnown) return true;
  return closedLegOpenWindowsOverlap(a, b);
}

function mergeVenueClosedLegs(historyLegs, fillLegs) {
  const merged = [...historyLegs];
  for (const fillLeg of fillLegs) {
    const overlaps = merged.filter(h => closedLegsOverlap(h, fillLeg));
    if (overlaps.some(h => closedLegSizeMismatchPct(h, fillLeg) <= CLOSED_PAIR_MAX_SIZE_MISMATCH_PCT)) continue;
    merged.push(fillLeg);
  }
  return merged;
}

function buildClosedLegs(fillSources, paymentSources, exchangeHistory = null) {
  const exchangeLegs = exchangeHistory
    ? buildClosedLegsFromExchangeHistory(exchangeHistory, paymentSources)
    : [];
  const grvtHistoryLegs = exchangeLegs.filter(l => l.venue === 'grvt');
  const extendedHistoryLegs = exchangeLegs.filter(l => l.venue === 'extended');
  const grvtFillLegs = buildClosedLegsForVenue('grvt', fillSources.grvt || [], paymentSources);
  const extendedFillLegs = buildClosedLegsForVenue('extended', fillSources.extended || [], paymentSources);
  const otherFillLegs = Object.entries(fillSources).flatMap(([venue, fills]) => {
    if (venue === 'grvt' || venue === 'extended') return [];
    return buildClosedLegsForVenue(venue, fills, paymentSources);
  });
  const legs = [
    ...mergeVenueClosedLegs(grvtHistoryLegs, grvtFillLegs),
    ...mergeVenueClosedLegs(extendedHistoryLegs, extendedFillLegs),
    ...otherFillLegs,
  ];
  return legs;
}

function summarizeClosedLegs(legs, unmatched = []) {
  const byVenue = {};
  const symbolsByVenue = {};
  const byPairKey = {};
  for (const leg of legs || []) {
    if (!leg?.venue) continue;
    byVenue[leg.venue] = (byVenue[leg.venue] || 0) + 1;
    if (!symbolsByVenue[leg.venue]) symbolsByVenue[leg.venue] = new Set();
    if (leg.symbol) symbolsByVenue[leg.venue].add(leg.symbol);
  }
  for (const leg of unmatched || []) {
    const key = `${leg.symbol || '?'}:${leg.venue || '?'}:${leg.side || '?'}`;
    byPairKey[key] = (byPairKey[key] || 0) + 1;
  }
  return {
    legCount: (legs || []).length,
    byVenue,
    symbolsByVenue: Object.fromEntries(Object.entries(symbolsByVenue).map(([venue, symbols]) => [
      venue,
      [...symbols].sort(),
    ])),
    unmatchedCount: (unmatched || []).length,
    unmatchedBySymbolVenueSide: byPairKey,
    unmatchedSample: (unmatched || [])
      .sort((a, b) => (b.closeTime || 0) - (a.closeTime || 0))
      .slice(0, 50)
      .map(l => ({
        venue: l.venue,
        symbol: l.symbol,
        side: l.side,
        size: l.size,
        closeTime: l.closeTime,
        closeDate: l.closeTime ? new Date(l.closeTime).toISOString() : null,
        openTimeKnown: Boolean(l.openTimeKnown),
        realizedPnl: l.realizedPnl,
        funding: l.funding,
        source: l.fromExchangeHistory ? 'position_history' : l.reconstructedFromClosingFills ? 'closing_fills' : 'fills',
      })),
  };
}

function buildClosedPairsFromLegs(legs) {
  const bySymbol = {};
  for (const leg of legs) {
    if (!bySymbol[leg.symbol]) bySymbol[leg.symbol] = [];
    bySymbol[leg.symbol].push(leg);
  }

  const pairs = [];
  const unmatched = [];
  for (const symbolLegs of Object.values(bySymbol)) {
    const used = new Set();
    while (true) {
      let bestI = -1;
      let bestJ = -1;
      let bestScore = Infinity;
      for (let i = 0; i < symbolLegs.length; i++) {
        if (used.has(i)) continue;
        const a = symbolLegs[i];
        for (let j = 0; j < symbolLegs.length; j++) {
          if (i === j || used.has(j)) continue;
          const b = symbolLegs[j];
          if (a.venue === b.venue || a.side === b.side) continue;
          const closeGap = Math.abs(a.closeTime - b.closeTime);
          if (!closedLegsCanPair(a, b)) continue;
          const openGap = a.openTimeKnown && b.openTimeKnown ? Math.abs(a.openTime - b.openTime) : 0;
          const sizeMismatch = closedLegSizeMismatchPct(a, b);
          const scaledPairPenalty = sizeMismatch > CLOSED_PAIR_MAX_SIZE_MISMATCH_PCT ? 15 * 60000 : 0;
          const sizePenalty = Math.min(sizeMismatch, CLOSED_PAIR_MAX_SIZE_MISMATCH_PCT) * 60000 + scaledPairPenalty;
          const score = closeGap + openGap * 0.25 + sizePenalty;
          if (score < bestScore) {
            bestScore = score;
            bestI = i;
            bestJ = j;
          }
        }
      }
      if (bestI < 0) break;
      used.add(bestI);
      used.add(bestJ);
      pushClosedPair(pairs, symbolLegs[bestI], symbolLegs[bestJ]);
    }
    symbolLegs.forEach((leg, idx) => {
      if (!used.has(idx)) unmatched.push(leg);
    });
  }
  return {
    pairs: pairs.sort((a, b) => b.closeTime - a.closeTime),
    unmatched,
  };
}

function dailyRowHasPerformanceActivity(row) {
  const eps = 0.0000001;
  return Math.abs(row?.dailyFunding || 0) > eps
    || Math.abs(row?.dailyFees || 0) > eps
    || Math.abs(row?.dailyNet || 0) > eps
    || (Array.isArray(row?.fundingEvents) && row.fundingEvents.length > 0)
    || (Array.isArray(row?.feeEvents) && row.feeEvents.length > 0);
}

function splitDailySeriesIntoSessions(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const sessions = [];
  let current = [];
  for (const row of list) {
    if (dailyRowHasPerformanceActivity(row)) {
      current.push(row);
    } else if (current.length) {
      sessions.push(current);
      current = [];
    }
  }
  if (current.length) sessions.push(current);
  return sessions;
}

function trimDailySeriesToLatestSession(rows) {
  const sessions = splitDailySeriesIntoSessions(rows);
  return sessions.length ? sessions[sessions.length - 1] : [];
}

/** Align closed-pair funding/fees with Position Performance latest-session logic. */
function enrichClosedPairSessionPnl(pair, dailySeriesInputs, fillHistoryDays = PERPS_MAX_FILL_HISTORY_DAYS) {
  const symbol = toBaseSymbol(pair?.symbol);
  const closeTime = Number(pair?.closeTime || 0);
  if (!symbol || !closeTime) return pair;

  const openTime = Number(pair?.openTime || 0);
  const openDays = openTime > 0
    ? Math.ceil((closeTime - openTime) / 86400000) + 2
    : fillHistoryDays;
  const perfDays = Math.min(PERPS_MAX_FILL_HISTORY_DAYS, Math.max(fillHistoryDays, openDays));

  let series = buildDailyFundingSeries({
    ...dailySeriesInputs,
    days: perfDays,
    pairedBases: [symbol],
  });

  const closeDay = isoDateFromMs(closeTime);
  series = series.filter(r => r.day <= closeDay);
  const sessionRows = trimDailySeriesToLatestSession(series);
  if (!sessionRows.length) return pair;

  const funding = sessionRows.reduce((sum, r) => sum + (r.dailyFunding || 0), 0);
  const fees = sessionRows.reduce((sum, r) => sum + (r.dailyFees || 0), 0);
  const closeSlippage = Number(pair.closeSlippage || 0);

  return {
    ...pair,
    funding,
    fees,
    netPnl: closeSlippage + funding - fees,
    sessionStartDay: sessionRows[0]?.day || null,
    sessionEndDay: sessionRows[sessionRows.length - 1]?.day || null,
    sessionDayCount: sessionRows.length,
  };
}

function closedPairStableKey(pair) {
  const symbol = toBaseSymbol(pair?.symbol);
  const closeTime = Number(pair?.closeTime || 0);
  const longVenue = pair?.longLeg?.venue || '';
  const shortVenue = pair?.shortLeg?.venue || '';
  if (!symbol || !closeTime || !longVenue || !shortVenue) return '';
  return `${symbol}|${closeTime}|${longVenue}|${shortVenue}`;
}

function parseKnownClosedKeys(raw) {
  if (Array.isArray(raw)) return raw.map(String).map(s => s.trim()).filter(Boolean);
  return String(raw || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function filterFreshClosedPairs(pairs, knownClosedKeys) {
  const known = new Set(parseKnownClosedKeys(knownClosedKeys));
  if (!known.size) return pairs || [];
  return (pairs || []).filter(p => !known.has(closedPairStableKey(p)));
}

function enrichClosedPairsSessionPnl(closedPairs, dailySeriesInputs, fillHistoryDays = PERPS_MAX_FILL_HISTORY_DAYS) {
  return (closedPairs || []).map(pair => enrichClosedPairSessionPnl(pair, dailySeriesInputs, fillHistoryDays));
}

function buildClosedPairs(fillSources, paymentSources, exchangeHistory = null, opts = {}) {
  const legs = buildClosedLegs(fillSources, paymentSources, exchangeHistory);
  const built = buildClosedPairsFromLegs(legs);
  if (opts.withDebug) {
    return {
      pairs: built.pairs,
      debug: summarizeClosedLegs(legs, built.unmatched),
    };
  }
  return built.pairs;
}

function filterFullyClosedPairs(closedPairs, openByVenue) {
  return (closedPairs || []).filter(pair => {
    const symbol = toBaseSymbol(pair.symbol);
    for (const leg of [pair.longLeg, pair.shortLeg]) {
      const open = openByVenue?.[leg.venue]?.[symbol];
      if (open && Math.abs(open.size ?? 0) > CLOSED_ROUND_EPS) return false;
    }
    return true;
  });
}

function collectPerpsHistorySymbols({
  activeNadoSymbols = [],
  hlFills,
  grvtFills,
  extendedFills,
  hlFunding,
  nadoFunding,
  grvtFunding,
  extendedFunding,
}) {
  return Array.from(new Set([
    ...activeNadoSymbols.map(toBaseSymbol),
    ...(hlFills?.fills || []).map(f => toBaseSymbol(f.symbol)),
    ...(grvtFills?.fills || []).map(f => toBaseSymbol(f.symbol)),
    ...(extendedFills?.fills || []).map(f => toBaseSymbol(f.symbol)),
    ...(hlFunding?.payments || []).map(p => toBaseSymbol(p.symbol)),
    ...(nadoFunding?.payments || []).map(p => toBaseSymbol(p.symbol)),
    ...(grvtFunding?.payments || []).map(p => toBaseSymbol(p.symbol)),
    ...(extendedFunding?.payments || []).map(p => toBaseSymbol(p.symbol)),
  ].filter(Boolean)));
}

function collectInactiveNadoHistorySymbols({
  activeNadoSymbols = [],
  hlFills,
  grvtFills,
  extendedFills,
  nadoHistorySymbols,
}) {
  const activeNadoBaseSet = new Set(activeNadoSymbols.map(toBaseSymbol).filter(Boolean));
  const tradeSymbols = new Set([
    ...(hlFills?.fills || []).map(f => toBaseSymbol(f.symbol)),
    ...(grvtFills?.fills || []).map(f => toBaseSymbol(f.symbol)),
    ...(extendedFills?.fills || []).map(f => toBaseSymbol(f.symbol)),
  ].filter(Boolean));
  return (nadoHistorySymbols || [])
    .filter(symbol => !activeNadoBaseSet.has(symbol))
    .filter(symbol => tradeSymbols.has(symbol));
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
  grvtPositionHistory = null,
  extendedPositionHistory = null,
  spreadRows,
  days,
  fillHistoryDays = PERPS_MAX_FILL_HISTORY_DAYS,
  knownClosedKeys = [],
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
  const closedResult = buildClosedPairs(fillSources, paymentSources, {
    grvt: grvtPositionHistory?.positions || [],
    extended: extendedPositionHistory?.positions || [],
  }, { withDebug: true });
  const closedPairsFiltered = filterFullyClosedPairs(closedResult.pairs, {
    hyperliquid: hlByBase,
    nado: nadoByBase,
    grvt: grvtByBase,
    extended: extendedByBase,
  });
  const freshClosedPairs = filterFreshClosedPairs(closedPairsFiltered, knownClosedKeys);
  const closedPairs = enrichClosedPairsSessionPnl(freshClosedPairs, {
    hlPayments: hlFunding.payments || [],
    nadoPayments: nadoFunding.payments || [],
    grvtPayments: grvtFunding?.payments || [],
    extendedPayments: extendedFunding?.payments || [],
    hlFills: hlFills.fills || [],
    nadoMatches: nadoMatches.matches || [],
    grvtFills: grvtFills?.fills || [],
    extendedFills: extendedFills?.fills || [],
  }, fillHistoryDays);
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
    closedPairs,
    closedDebug: closedResult.debug,
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

function buildRateSpreadRows(bases, hlRateBySymbol, nadoRateByBase, grvtRateByBase, extendedRateByBase) {
  const spreadRows = [];
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
      hyperliquidMarkPx: hl?.markPx ?? null,
      nadoDaily: naDaily,
      nado8h: na8h,
      nadoMarkPx: na?.markPx ?? null,
      grvt8h,
      grvtMarkPx: gv?.markPx ?? null,
      grvtIntervalRate,
      grvtIntervalHours,
      extended8h,
      extendedMarkPx: ex?.markPx ?? null,
      extendedHourly: ex?.fundingRateHourly ?? (extended8h != null ? extended8h / 8 : null),
      spread8h: hl8h != null && na8h != null ? hl8h - na8h : null,
      spreadHlGrvt8h: hl8h != null && grvt8h != null ? hl8h - grvt8h : null,
      spreadHlExtended8h: hl8h != null && extended8h != null ? hl8h - extended8h : null,
      spreadNadoExtended8h: na8h != null && extended8h != null ? na8h - extended8h : null,
      spreadNadoGrvt8h: na8h != null && grvt8h != null ? na8h - grvt8h : null,
      spreadGrvtExtended8h: grvt8h != null && extended8h != null ? grvt8h - extended8h : null,
    });
  }
  return spreadRows.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/** Lightweight poll for live funding rates (Current APR). */
async function fetchPerpsLiveRates(opts = {}) {
  const grvtSubAccount = opts.grvtSubAccount
    || process.env.GRVT_SUB_ACCOUNT_ID
    || DEFAULT_GRVT_SUB_ACCOUNT;
  const grvtEnabled = Boolean(grvtSubAccount && process.env.GRVT_API_KEY);
  const extendedEnabled = Boolean(process.env.EXTENDED_API_KEY);
  const bases = new Set(
    (Array.isArray(opts.symbols) ? opts.symbols : String(opts.symbols || '').split(','))
      .map(s => toBaseSymbol(s.trim()))
      .filter(Boolean),
  );
  if (!bases.size) ['BTC', 'ETH', 'SOL'].forEach(s => bases.add(s));

  const [hlRates, nadoRates, grvtRates, extendedRates] = await Promise.all([
    withTimeout(fetchHyperliquidRates(), PERPS_CORE_FETCH_TIMEOUT_MS, 'Hyperliquid rates'),
    withTimeout(fetchNadoRates(), PERPS_CORE_FETCH_TIMEOUT_MS, 'NADO rates'),
    grvtEnabled ? withTimeout(fetchGrvtRates([...bases]), PERPS_OPTIONAL_FETCH_TIMEOUT_MS, 'GRVT rates').catch(() => []) : Promise.resolve([]),
    extendedEnabled ? withTimeout(fetchExtendedRates([...bases]), PERPS_OPTIONAL_FETCH_TIMEOUT_MS, 'Extended rates').catch(() => []) : Promise.resolve([]),
  ]);

  const hlRateBySymbol = Object.fromEntries(hlRates.map(r => [r.symbol, r]));
  const nadoRateByBase = {};
  for (const r of nadoRates) {
    nadoRateByBase[toBaseSymbol(r.symbol)] = r;
  }
  const grvtRateByBase = Object.fromEntries(grvtRates.map(r => [r.symbol, r]));
  const extendedRateByBase = Object.fromEntries(extendedRates.map(r => [r.symbol, r]));

  return {
    fetchedAt: Date.now(),
    rateSpread: buildRateSpreadRows(bases, hlRateBySymbol, nadoRateByBase, grvtRateByBase, extendedRateByBase),
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

  const [hlState, nadoState] = await Promise.all([
    withTimeout(fetchHyperliquidState(hlWallet), PERPS_CORE_FETCH_TIMEOUT_MS, 'Hyperliquid state'),
    withTimeout(fetchNadoState(nadoWallet), PERPS_CORE_FETCH_TIMEOUT_MS, 'NADO state').catch(e => ({
      venue: 'nado',
      wallet: nadoWallet,
      exists: false,
      accountValue: 0,
      positions: [],
      error: errorMessage(e),
    })),
  ]);
  const activeNadoSymbols = nadoState.positions.map(p => p.symbol);

  const [
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
    grvtPositionHistory,
    grvtCapitalFlows,
    extendedState,
    extendedFunding,
    extendedFills,
    extendedPositionHistory,
    extendedCapitalFlows,
  ] = await Promise.all([
    withTimeout(fetchHyperliquidFunding(hlWallet, fillHistoryDays), PERPS_CORE_FETCH_TIMEOUT_MS, 'Hyperliquid funding'),
    withTimeout(fetchNadoFunding(nadoWallet, fillHistoryDays, 'default', activeNadoSymbols), PERPS_CORE_FETCH_TIMEOUT_MS, 'NADO funding').catch(e => ({
      venue: 'nado', wallet: nadoWallet, days: fillHistoryDays, payments: [], totalFunding: 0, error: errorMessage(e),
    })),
    withTimeout(fetchHyperliquidFills(hlWallet, fillHistoryDays), PERPS_CORE_FETCH_TIMEOUT_MS, 'Hyperliquid fills'),
    withTimeout(fetchNadoMatches(nadoWallet, fillHistoryDays, 'default', activeNadoSymbols), PERPS_CORE_FETCH_TIMEOUT_MS, 'NADO matches').catch(e => ({
      venue: 'nado', wallet: nadoWallet, days: fillHistoryDays, matches: [], totalFees: 0, totalRealized: 0, error: errorMessage(e),
    })),
    withTimeout(fetchHyperliquidRates(), PERPS_CORE_FETCH_TIMEOUT_MS, 'Hyperliquid rates'),
    withTimeout(fetchNadoRates(), PERPS_CORE_FETCH_TIMEOUT_MS, 'NADO rates').catch(e => {
      const rows = [];
      rows.error = errorMessage(e);
      return rows;
    }),
    withTimeout(fetchHyperliquidCapitalFlows(hlWallet), PERPS_OPTIONAL_FETCH_TIMEOUT_MS, 'Hyperliquid capital flows').catch(e => ({
      venue: 'hyperliquid', wallet: hlWallet, payments: [], netDeposits: 0, error: errorMessage(e),
    })),
    withTimeout(fetchNadoCapitalFlows(nadoWallet), PERPS_OPTIONAL_FETCH_TIMEOUT_MS, 'NADO capital flows').catch(e => ({
      venue: 'nado', wallet: nadoWallet, payments: [], netDeposits: 0, error: errorMessage(e),
    })),
    grvtEnabled ? withTimeout(fetchGrvtState(grvtSubAccount), PERPS_OPTIONAL_FETCH_TIMEOUT_MS, 'GRVT state').catch(e => ({
      venue: 'grvt',
      subAccountId: grvtSubAccount,
      exists: false,
      accountValue: 0,
      positions: [],
      error: errorMessage(e),
    })) : Promise.resolve({
      venue: 'grvt',
      subAccountId: grvtSubAccount,
      configured: false,
      exists: false,
      accountValue: 0,
      positions: [],
    }),
    grvtEnabled ? withTimeout(fetchGrvtFunding(grvtSubAccount, fillHistoryDays), PERPS_OPTIONAL_FETCH_TIMEOUT_MS, 'GRVT funding').catch(e => ({
      venue: 'grvt', subAccountId: grvtSubAccount, days, payments: [], totalFunding: 0, error: errorMessage(e),
    })) : Promise.resolve({ venue: 'grvt', subAccountId: grvtSubAccount, days, payments: [], totalFunding: 0 }),
    grvtEnabled ? withTimeout(fetchGrvtFills(grvtSubAccount, fillHistoryDays), PERPS_GRVT_HISTORY_TIMEOUT_MS, 'GRVT fills').catch(e => ({
      venue: 'grvt', subAccountId: grvtSubAccount, days, fills: [], totalFees: 0, totalRealized: 0, rawRowCount: 0, error: errorMessage(e),
    })) : Promise.resolve({ venue: 'grvt', subAccountId: grvtSubAccount, days, fills: [], totalFees: 0, totalRealized: 0, rawRowCount: 0 }),
    grvtEnabled ? withTimeout(fetchGrvtPositionHistory(grvtSubAccount, fillHistoryDays), PERPS_GRVT_HISTORY_TIMEOUT_MS, 'GRVT position history').catch(e => ({
      venue: 'grvt', subAccountId: grvtSubAccount, days, positions: [], rawRowCount: 0, error: errorMessage(e),
    })) : Promise.resolve({ venue: 'grvt', subAccountId: grvtSubAccount, days, positions: [], rawRowCount: 0 }),
    grvtEnabled ? withTimeout(fetchGrvtCapitalFlows(grvtSubAccount), PERPS_OPTIONAL_FETCH_TIMEOUT_MS, 'GRVT capital flows').catch(e => ({
      venue: 'grvt', subAccountId: grvtSubAccount, payments: [], netDeposits: 0, error: errorMessage(e),
    })) : Promise.resolve({ venue: 'grvt', subAccountId: grvtSubAccount, payments: [], netDeposits: 0 }),
    extendedEnabled ? withTimeout(fetchExtendedState(), PERPS_OPTIONAL_FETCH_TIMEOUT_MS, 'Extended state').catch(e => ({
      venue: 'extended', exists: false, accountValue: 0, positions: [], error: errorMessage(e),
    })) : Promise.resolve({
      venue: 'extended', configured: false, exists: false, accountValue: 0, positions: [],
    }),
    extendedEnabled ? withTimeout(fetchExtendedFunding(Math.max(days, 365)), PERPS_OPTIONAL_FETCH_TIMEOUT_MS, 'Extended funding').catch(e => ({
      venue: 'extended', days, payments: [], totalFunding: 0, error: errorMessage(e),
    })) : Promise.resolve({ venue: 'extended', days, payments: [], totalFunding: 0 }),
    extendedEnabled ? withTimeout(fetchExtendedFills(fillHistoryDays), PERPS_OPTIONAL_FETCH_TIMEOUT_MS, 'Extended fills').catch(e => ({
      venue: 'extended', days, fills: [], totalFees: 0, totalRealized: 0, error: errorMessage(e),
    })) : Promise.resolve({ venue: 'extended', days, fills: [], totalFees: 0, totalRealized: 0 }),
    extendedEnabled ? withTimeout(fetchExtendedPositionHistory(fillHistoryDays), PERPS_OPTIONAL_FETCH_TIMEOUT_MS, 'Extended position history').catch(e => ({
      venue: 'extended', days, positions: [], error: errorMessage(e),
    })) : Promise.resolve({ venue: 'extended', days, positions: [] }),
    extendedEnabled ? withTimeout(fetchExtendedCapitalFlows(), PERPS_OPTIONAL_FETCH_TIMEOUT_MS, 'Extended capital flows').catch(e => ({
      venue: 'extended', payments: [], netDeposits: 0, error: errorMessage(e),
    })) : Promise.resolve({ venue: 'extended', payments: [], netDeposits: 0 }),
  ]);

  const [grvtRates, extendedRates] = await Promise.all([
    grvtEnabled
      ? withTimeout(fetchGrvtRates(grvtState.positions.map(p => p.symbol)), PERPS_OPTIONAL_FETCH_TIMEOUT_MS, 'GRVT rates').catch(() => [])
      : Promise.resolve([]),
    extendedEnabled
      ? withTimeout(fetchExtendedRates(extendedState.positions.map(p => p.symbol)), PERPS_OPTIONAL_FETCH_TIMEOUT_MS, 'Extended rates').catch(() => [])
      : Promise.resolve([]),
  ]);

  let nadoFundingForAnalysis = nadoFunding;
  let nadoMatchesForAnalysis = nadoMatches;
  const nadoHistorySymbols = collectPerpsHistorySymbols({
    activeNadoSymbols,
    hlFills,
    grvtFills,
    extendedFills,
    hlFunding,
    nadoFunding,
    grvtFunding,
    extendedFunding,
  });
  const inactiveNadoHistorySymbols = collectInactiveNadoHistorySymbols({
    activeNadoSymbols,
    hlFills,
    grvtFills,
    extendedFills,
    nadoHistorySymbols,
  });
  let nadoHistoryFetch = { inactiveSymbolCount: inactiveNadoHistorySymbols.length, merged: false };
  if (inactiveNadoHistorySymbols.length) {
    const [nf, nm] = await Promise.all([
      withTimeout(
        fetchNadoFunding(nadoWallet, fillHistoryDays, 'default', inactiveNadoHistorySymbols),
        PERPS_NADO_HISTORY_TIMEOUT_MS,
        'NADO funding history',
      ).catch(e => ({
        venue: 'nado',
        wallet: nadoWallet,
        days: fillHistoryDays,
        payments: [],
        totalFunding: 0,
        error: errorMessage(e),
      })),
      withTimeout(
        fetchNadoMatches(nadoWallet, fillHistoryDays, 'default', inactiveNadoHistorySymbols),
        PERPS_NADO_HISTORY_TIMEOUT_MS,
        'NADO match history',
      ).catch(e => ({
        venue: 'nado',
        wallet: nadoWallet,
        days: fillHistoryDays,
        matches: [],
        totalFees: 0,
        totalRealized: 0,
        error: errorMessage(e),
      })),
    ]);
    nadoFundingForAnalysis = mergeNadoFunding(nadoFunding, nf);
    nadoMatchesForAnalysis = mergeNadoMatches(nadoMatches, nm);
    nadoHistoryFetch = {
      inactiveSymbolCount: inactiveNadoHistorySymbols.length,
      inactiveSymbols: inactiveNadoHistorySymbols.sort(),
      merged: true,
      supplementalMatches: nm.matches?.length || 0,
      supplementalFunding: nf.payments?.length || 0,
      matchError: nm.error || null,
      fundingError: nf.error || null,
      totalMatches: nadoMatchesForAnalysis.matches?.length || 0,
    };
  }

  const hlRateBySymbol = Object.fromEntries(hlRates.map(r => [r.symbol, r]));
  const nadoRateByBase = {};
  for (const r of nadoRates) {
    const base = r.symbol.replace(/-PERP$/i, '');
    nadoRateByBase[base] = r;
  }
  const grvtRateByBase = Object.fromEntries(grvtRates.map(r => [r.symbol, r]));
  const extendedRateByBase = Object.fromEntries(extendedRates.map(r => [r.symbol, r]));

  const bases = new Set([
    ...hlState.positions.map(p => p.symbol),
    ...nadoState.positions.map(p => p.symbol.replace(/-PERP$/i, '')),
    ...grvtState.positions.map(p => p.symbol),
    ...extendedState.positions.map(p => p.symbol),
    'BTC', 'ETH', 'SOL',
  ]);
  const spreadRows = buildRateSpreadRows(bases, hlRateBySymbol, nadoRateByBase, grvtRateByBase, extendedRateByBase);

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
    nadoFunding: nadoFundingForAnalysis,
    grvtFunding,
    extendedFunding: extendedFundingWindow,
    extendedFundingSinceOpen,
    hlFills,
    nadoMatches: nadoMatchesForAnalysis,
    grvtFills,
    extendedFills,
    grvtPositionHistory,
    extendedPositionHistory,
    spreadRows,
    days,
    fillHistoryDays,
    knownClosedKeys: wallets.knownClosedKeys,
  });

  const dailySeriesInputs = {
    hlPayments: hlFunding.payments,
    nadoPayments: nadoFundingForAnalysis.payments,
    grvtPayments: grvtFunding.payments,
    extendedPayments: extendedWindowPayments,
    hlFills: hlFills.fills,
    nadoMatches: nadoMatchesForAnalysis.matches,
    grvtFills: grvtFills.fills,
    extendedFills: extendedFills.fills,
    days,
  };
  const dailyFundingSeries = buildDailyFundingSeries(dailySeriesInputs);
  for (const p of arb.paired) {
    const openDays = p.pairOpenedAtMs
      ? Math.ceil((Date.now() - p.pairOpenedAtMs) / 86400000) + 2
      : fillHistoryDays;
    const perfDays = Math.min(PERPS_MAX_FILL_HISTORY_DAYS, Math.max(fillHistoryDays, openDays));
    p.dailyPerformanceSeries = buildDailyFundingSeries({
      ...dailySeriesInputs,
      days: perfDays,
      pairedBases: [p.symbol],
    });
  }
  const fundingSeries = buildFundingCumulativeSeries(
    hlFunding.payments,
    nadoFundingForAnalysis.payments,
    days,
    arb.paired.map(p => p.symbol),
    grvtFunding.payments,
    extendedWindowPayments,
  );
  const pairedDailyFundingSeries = buildDailyFundingSeries({
    hlPayments: hlFunding.payments,
    nadoPayments: nadoFundingForAnalysis.payments,
    grvtPayments: grvtFunding.payments,
    extendedPayments: extendedWindowPayments,
    hlFills: hlFills.fills,
    nadoMatches: nadoMatchesForAnalysis.matches,
    grvtFills: grvtFills.fills,
    extendedFills: extendedFills.fills,
    days,
    pairedBases: arb.paired.map(p => p.symbol),
  });
  const netArbSeries = buildNetArbSeries(pairedDailyFundingSeries, arb.pairedFees, days);

  const fetchedAt = Date.now();
  const stateFetchedAts = [hlState, nadoState, grvtEnabled ? grvtState : null, extendedEnabled ? extendedState : null]
    .map(state => Number(state?.fetchedAt))
    .filter(Number.isFinite);
  const equityCollectionSpanMs = stateFetchedAts.length > 1
    ? Math.max(...stateFetchedAts) - Math.min(...stateFetchedAts)
    : 0;
  const equitySnapshotIssue = [
    !Number.isFinite(hlState.accountValue) ? 'Hyperliquid equity unavailable' : '',
    !Number.isFinite(nadoState.accountValue) ? 'Nado equity unavailable' : '',
    grvtEnabled && (grvtState.error || !Number.isFinite(grvtState.accountValue))
      ? `GRVT equity unavailable${grvtState.error ? `: ${grvtState.error}` : ''}`
      : '',
    extendedEnabled && (extendedState.error || !Number.isFinite(extendedState.accountValue))
      ? `Extended equity unavailable${extendedState.error ? `: ${extendedState.error}` : ''}`
      : '',
  ].find(Boolean) || null;
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
      funding: extendedFundingWindow,
      fundingSinceOpen: extendedFundingSinceOpen,
      fills: extendedFills,
      configured: extendedEnabled,
    },
    hyperliquid: { state: hlState, funding: hlFunding, fills: hlFills },
    nado: { state: nadoState, funding: nadoFundingForAnalysis, matches: nadoMatchesForAnalysis },
    rateSpread: spreadRows,
    paired: arb.paired,
    closedPairs: arb.closedPairs,
    closedDebug: arb.closedDebug,
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
      nadoFundingTotal: nadoFundingForAnalysis.totalFunding,
      nadoMatchCount: nadoMatchesForAnalysis.matches?.length || 0,
      nadoHistoryFetch,
      grvtFundingTotal: grvtFunding.totalFunding,
      extendedFundingTotal: extendedFundingWindow.totalFunding,
      extendedFundingSinceOpenTotal: extendedFundingSinceOpen.totalFunding,
      netFundingTotal: hlFunding.totalFunding + nadoFunding.totalFunding + grvtFunding.totalFunding + extendedFundingWindow.totalFunding,
      hlPositionCount: hlState.positions.length,
      nadoPositionCount: nadoState.positions.length,
      grvtPositionCount: grvtState.positions.length,
      extendedPositionCount: extendedState.positions.length,
      hlAccountValue: hlState.accountValue,
      nadoAccountValue: nadoState.accountValue ?? 0,
      hlError: combineErrors(hlCapitalFlows),
      nadoError: combineErrors(nadoState, nadoFundingForAnalysis, nadoMatchesForAnalysis, nadoCapitalFlows, { error: nadoRates.error }),
      grvtAccountValue: grvtEquity,
      extendedAccountValue: extendedEquity,
      grvtConfigured: grvtEnabled,
      grvtFillsCount: grvtFills.fills?.length || 0,
      grvtFillsRawCount: grvtFills.rawRowCount ?? grvtFills.fills?.length ?? 0,
      grvtPositionHistoryCount: grvtPositionHistory.positions?.length || 0,
      grvtPositionHistoryRawCount: grvtPositionHistory.rawRowCount ?? grvtPositionHistory.positions?.length ?? 0,
      grvtError: combineErrors(grvtState, grvtFunding, grvtFills, grvtPositionHistory, grvtCapitalFlows),
      extendedConfigured: extendedEnabled,
      extendedError: combineErrors(extendedState, extendedFundingWindow, extendedFundingSinceOpen, extendedFills, extendedCapitalFlows),
      equitySnapshotEligible: !equitySnapshotIssue,
      equitySnapshotIssue,
      equityCollectionSpanMs,
      nadoExists: nadoState.exists,
      combinedUpnl: arb.combinedUpnl,
      pairedFunding: arb.pairedFundingSinceOpen,
      pairedFundingSinceOpen: arb.pairedFundingSinceOpen,
      pairedHlFundingSinceOpen: arb.pairedHlFundingSinceOpen,
      pairedNadoFundingSinceOpen: arb.pairedNadoFundingSinceOpen,
      pairedFundingWindow: arb.pairedFundingWindow,
      netFundingTotalAllAccounts: hlFunding.totalFunding + nadoFunding.totalFunding + grvtFunding.totalFunding + extendedFundingWindow.totalFunding,
      pairedFees: arb.pairedFees,
      pairedRealized: arb.pairedRealized,
      totalFees: arb.totalFees,
      hlFees: hlFills.totalFees,
      nadoFees: nadoMatchesForAnalysis.totalFees,
      grvtFees: grvtFills.totalFees,
      extendedFees: extendedFills.totalFees,
      totalRealized: arb.totalRealized,
      totalEntrySlippage: arb.totalEntrySlippage,
      netArbPnl: arb.netArbPnl,
      avgNotional: arb.avgNotional,
      netFundingApr: arb.netFundingApr,
      netArbApr: arb.netArbApr,
      pairedCount: arb.paired.length,
      closedCount: arb.closedPairs.length,
      closedLegCount: arb.closedDebug?.legCount || 0,
      closedUnmatchedCount: arb.closedDebug?.unmatchedCount || 0,
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
      equityCollectionSpanMs: s.equityCollectionSpanMs ?? null,
      equityFetchedAts: s.equityFetchedAts ?? null,
      equitySampleMode: s.equitySampleMode ?? null,
    },
  };
}

function isEquitySnapshotEligible(data) {
  const s = data?.summary || {};
  if (s.equitySnapshotEligible === false) return false;
  const values = [
    s.hlAccountValue ?? data?.equityNow?.hl,
    s.nadoAccountValue ?? data?.equityNow?.nado,
  ];
  if (s.grvtConfigured) values.push(s.grvtAccountValue ?? data?.equityNow?.grvt);
  if (s.extendedConfigured) values.push(s.extendedAccountValue ?? data?.equityNow?.extended);
  return values.every(Number.isFinite);
}

function appendEquitySnapshotStore(store, data, maxEntries = 180) {
  const next = { ...(store || {}) };
  if (!isEquitySnapshotEligible(data)) return next;
  const { key, record } = buildEquitySnapshotFromDashboard(data);
  if (next[key]) return next;
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
  isEquitySnapshotEligible,
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
  fetchPerpsEquitySnapshot,
  fetchPerpsLiveRates,
  buildRateSpreadRows,
  buildPairedAnalysis,
  buildClosedPairs,
  buildClosedLegsFromExchangeHistory,
  enrichClosedPairsSessionPnl,
  enrichClosedPairSessionPnl,
  closedPairStableKey,
  filterFreshClosedPairs,
  parseKnownClosedKeys,
  trimDailySeriesToLatestSession,
  filterFullyClosedPairs,
  mergeNadoMatches,
  collectPerpsHistorySymbols,
  collectInactiveNadoHistorySymbols,
  fetchGrvtPositionHistory,
  fetchExtendedPositionHistory,
  buildFundingCumulativeSeries,
  buildDailyFundingSeries,
  buildEquitySeries,
  computeCombinedNetDeposits,
  pairOpenedAtMs,
  sumPairFundingPaymentsSince,
  applyPairFundingSinceOpen,
  PERPS_MAX_FILL_HISTORY_DAYS,
  liquidationPriceFrom,
  nadoLiquidationPriceFrom,
  computeNadoLiquidationPx,
  normalizeGrvtPositionRow,
  tpslPxFrom,
  parseHyperliquidTpslOrders,
  parseGrvtTpslOrders,
  parseNadoTriggerOrders,
  classifyNadoTriggerSide,
  perpsTpslDiffPct,
  perpsTpslMismatch,
  PERPS_RISK_FULL_PCT,
  PERPS_RISK_START_PCT_UP,
  PERPS_RISK_START_PCT_DOWN,
  perpsPriceRiskLevel,
  perpsPriceRiskStyle,
  perpsLiquidationRiskStyle,
};

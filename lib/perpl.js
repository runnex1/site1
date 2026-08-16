/**
 * Perpl (Monad perps DEX) helpers.
 * Public endpoints need no key; account endpoints require an enrolled Ed25519
 * API key. The user pastes the X-API-Key token + the hex of the 32-byte
 * Ed25519 private key (both handed out by the web UI at app.perpl.xyz/apikeys).
 * Signing uses Node's built-in crypto Ed25519 (raw seed → PKCS8 DER wrapper);
 * no third-party dependency needed.
 */

const { createHash, createPrivateKey, randomBytes, sign: ed25519Sign } = require('crypto');

const PERPL_API_URL = process.env.PERPL_API_URL || 'https://app.perpl.xyz/api';
const PERPL_CHAIN_ID = Number(process.env.PERPL_CHAIN_ID || 143);
const PERPL_HISTORY_MAX_PAGES = 30;
const PERPL_CONTEXT_CACHE_MS = 5 * 60 * 1000;

/** Decode a possibly 0x-prefixed hex string into a Buffer (or null). */
function perplHexToBuffer(hex) {
  if (typeof hex !== 'string') return null;
  const clean = hex.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]+$/.test(clean)) return null;
  const buf = Buffer.from(clean, 'hex');
  if (buf.length !== 32) return null;
  return buf;
}

/**
 * Wrap a raw 32-byte Ed25519 private seed as a PKCS8 DER PrivateKeyInfo so
 * Node's crypto.sign(null, ...) can use it directly (Ed25519 keys are always
 * PKCS8-wrapped by OpenSSL).
 */
function perplPrivateKeyFromSeed(seed) {
  const raw = Buffer.from(seed);
  if (raw.length !== 32) throw new Error('Perpl private key must be 32 bytes');
  // PKCS8: SEQUENCE { INTEGER 0, SEQUENCE { OID 1.3.101.112 (Ed25519) }, OCTET STRING { OCTET STRING seed } }
  const privInner = Buffer.concat([
    Buffer.from([0x04, 0x20]), // OCTET STRING, len 32
    raw,
  ]);
  const alg = Buffer.from([0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70]); // SEQUENCE { OID Ed25519 }
  const version = Buffer.from([0x02, 0x01, 0x00]); // INTEGER 0
  const wrappedPriv = Buffer.concat([
    Buffer.from([0x04, 0x22]), // OCTET STRING, len 34
    privInner,
  ]);
  const seqContent = Buffer.concat([version, alg, wrappedPriv]);
  const der = Buffer.concat([
    Buffer.from([0x30, 0x2e]), // SEQUENCE, len 46
    seqContent,
  ]);
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

function perplBase64Url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function perplBodyHash(body) {
  return createHash('sha256').update(body || '').digest('hex');
}

/**
 * Sign a Perpl REST request.
 * canonical = [chainId, method, target, timestampMs, nonce, sha256(body)].join('\n')
 */
function perplSignRequest({ chainId, method, target, timestampMs, nonce, body = '', seed }) {
  const canonical = [
    String(chainId),
    String(method).toUpperCase(),
    String(target),
    String(timestampMs),
    String(nonce),
    perplBodyHash(body),
  ].join('\n');
  const key = perplPrivateKeyFromSeed(seed);
  const sig = ed25519Sign(null, Buffer.from(canonical, 'utf8'), key);
  return perplBase64Url(sig);
}

function createPerplApi({ fetchWithTimeout, withTimeout, errorMessage, toBaseSymbol, timeoutMs }) {
  const optionalMs = timeoutMs || 25000;
  let _contextCache = null;
  let _contextCacheAt = 0;

  /** Perpl API key object: { apiKey, secret (32-byte hex) }. */
  function perplKeyFromConfig(perpl = null) {
    const apiKey = String(perpl?.apiKey || process.env.PERPL_API_KEY || '').trim();
    const secretRaw = String(perpl?.secret || process.env.PERPL_API_KEY_SECRET || '').trim();
    const secret = perplHexToBuffer(secretRaw);
    if (!apiKey || !secret) return null;
    return { apiKey, secret };
  }

  async function perplPublicGet(path, label = 'Perpl public') {
    const url = `${PERPL_API_URL}${path}`;
    const res = await fetchWithTimeout(url, { headers: { accept: 'application/json' } }, optionalMs, label);
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
    return { ok: res.ok, status: res.status, data, text };
  }

  /** Signed GET. target must match byte-for-byte what is requested. */
  async function perplSignedGet(key, target, label = 'Perpl signed') {
    const timestampMs = Date.now();
    const nonce = randomBytes(16).toString('base64url');
    const signature = perplSignRequest({
      chainId: PERPL_CHAIN_ID,
      method: 'GET',
      target,
      timestampMs,
      nonce,
      body: '',
      seed: key.secret,
    });
    const res = await fetchWithTimeout(
      `${PERPL_API_URL}${target}`,
      {
        headers: {
          accept: 'application/json',
          'X-API-Key': key.apiKey,
          'X-API-Timestamp': String(timestampMs),
          'X-API-Nonce': nonce,
          'X-API-Signature': signature,
        },
      },
      optionalMs,
      label,
    );
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
    return { ok: res.ok, status: res.status, data, text };
  }

  /** Follow `np` cursor pages for a signed history endpoint (newest → oldest). */
  async function perplSignedPaginate(key, path, { count = 100, maxPages = PERPL_HISTORY_MAX_PAGES, label = 'Perpl history' } = {}) {
    const rows = [];
    let cursor = null;
    for (let page = 0; page < maxPages; page++) {
      const params = new URLSearchParams();
      if (cursor) params.set('page', cursor);
      params.set('count', String(count));
      const target = `${path}?${params.toString()}`;
      const res = await perplSignedGet(key, target, `${label} p${page + 1}`);
      if (!res.ok) {
        if (res.status === 404) break; // no on-chain account yet
        const errText = res.data?.error || res.data?.message || res.text?.slice(0, 200) || `${label} failed (${res.status})`;
        const err = new Error(errText);
        err.status = res.status;
        throw err;
      }
      const batch = Array.isArray(res.data?.d) ? res.data.d : [];
      if (!batch.length) break;
      rows.push(...batch);
      if (!res.data?.np) break;
      cursor = res.data.np;
    }
    return rows;
  }

  /** Cached market context: id → { symbol, priceScale, sizeScale, fundingIntervalSec, markPx, fundingRateMicros }. */
  async function fetchPerplContext() {
    if (_contextCache && Date.now() - _contextCacheAt < PERPL_CONTEXT_CACHE_MS) {
      return _contextCache;
    }
    const res = await perplPublicGet('/v1/pub/context', 'Perpl context');
    if (!res.ok) {
      throw new Error(res.data?.error || res.text?.slice(0, 200) || `Perpl context failed (${res.status})`);
    }
    const markets = Array.isArray(res.data?.markets) ? res.data.markets : [];
    const byId = {};
    for (const m of markets) {
      if (!m || m.id == null) continue;
      const symbol = toBaseSymbol(m.symbol || m.name || '');
      if (!symbol) continue;
      const priceDecimals = Number(m.config?.price_decimals ?? 2);
      const sizeDecimals = Number(m.config?.size_decimals ?? 2);
      const fundingIntervalSec = Number(m.config?.funding_interval_sec ?? 3600);
      byId[String(m.id)] = {
        id: m.id,
        symbol,
        priceScale: Math.pow(10, priceDecimals),
        sizeScale: Math.pow(10, sizeDecimals),
        priceDecimals,
        sizeDecimals,
        fundingIntervalSec: Number.isFinite(fundingIntervalSec) && fundingIntervalSec > 0 ? fundingIntervalSec : 3600,
        markPx: Number(m.state?.mrk) || Number(m.state?.mid) || Number(m.state?.lst) || null,
        fundingRateMicros: Number(m.funding?.rate) || 0,
      };
    }
    _contextCache = byId;
    _contextCacheAt = Date.now();
    return byId;
  }

  /**
   * Public funding rates normalized to the dashboard's 8h convention.
   * Perpl funding.rate is micros per funding interval; scale by 1e-6 and
   * multiply by (8h / interval) so the spread table is comparable.
   */
  async function fetchPerplRates(bases = []) {
    let context;
    try {
      context = await fetchPerplContext();
    } catch (_) {
      return [];
    }
    const want = new Set(
      (Array.isArray(bases) ? bases : [])
        .map((s) => toBaseSymbol(s))
        .filter(Boolean),
    );
    const out = [];
    for (const m of Object.values(context)) {
      if (!m?.symbol) continue;
      if (want.size && !want.has(m.symbol)) continue;
      const micros = Number(m.fundingRateMicros) || 0;
      if (!Number.isFinite(micros)) continue;
      const intervalRate = micros / 1e6;
      const intervalHours = m.fundingIntervalSec / 3600;
      const perpl8h = intervalRate * (8 / intervalHours);
      out.push({
        venue: 'perpl',
        symbol: m.symbol,
        fundingRateInterval: intervalRate,
        fundingIntervalHours: intervalHours,
        fundingRate8h: perpl8h,
        markPx: Number.isFinite(m.markPx) && m.markPx > 0 ? m.markPx : null,
      });
    }
    return out;
  }

  /**
   * Open positions from signed position-history (st === 1), mapped to the
   * shared dashboard leg shape. Mark prices come from pub/context (fresh
   * enough for display; ~seconds behind).
   */
  async function fetchPerplState(perpl = null) {
    const key = perplKeyFromConfig(perpl);
    const empty = {
      venue: 'perpl',
      configured: false,
      exists: false,
      accountValue: 0,
      positions: [],
    };
    if (!key) return empty;
    const base = { ...empty, configured: true };

    let context = {};
    try { context = await fetchPerplContext(); } catch (_) { /* marks stay null */ }

    let rows;
    try {
      rows = await perplSignedPaginate(key, '/v1/trading/position-history', {
        count: 50,
        label: 'Perpl positions',
      });
    } catch (e) {
      return {
        ...base,
        exists: false,
        fetchedAt: Date.now(),
        accountValue: NaN,
        error: errorMessage(e),
      };
    }
    const openRows = rows.filter((p) => Number(p?.st) === 1);
    const positions = openRows
      .map((p) => {
        const meta = context[String(p?.mkt)];
        const symbol = meta?.symbol || toBaseSymbol(p?.mkt != null ? String(p.mkt) : '');
        if (!symbol) return null;
        const priceScale = meta?.priceScale || 1;
        const sizeScale = meta?.sizeScale || 1;
        const size = Number(p?.s) / sizeScale;
        if (!Number.isFinite(size) || Math.abs(size) < 1e-12) return null;
        const markPx = Number(p?.x) / priceScale
          || (meta?.markPx ?? null);
        const entryPx = Number(p?.ep) / priceScale || null;
        const notional = Number.isFinite(markPx) ? Math.abs(size * markPx) : null;
        const unrealizedPnl = Number.isFinite(markPx) && Number.isFinite(entryPx)
          ? (Number(p?.sd) === 2 ? -1 : 1) * (markPx - entryPx) * Math.abs(size)
          : null;
        return {
          venue: 'perpl',
          symbol,
          size, // signed: + long, - short
          side: Number(p?.sd) === 2 ? 'short' : 'long',
          entryPx: Number.isFinite(entryPx) ? entryPx : null,
          markPx: Number.isFinite(markPx) && markPx > 0 ? markPx : null,
          liquidationPx: null, // not exposed by Perpl position history
          notional,
          unrealizedPnl,
          cumFundingSinceOpen: Number(p?.fnd) / 1e6 || 0,
          leverage: Number.isFinite(Number(p?.lv)) ? Number(p.lv) / 100 : null,
          collateral: Number(p?.c) / 1e6 || 0,
        };
      })
      .filter(Boolean);

    // Latest balance from account-history (events are newest-first).
    let accountValue = 0;
    try {
      const events = await perplSignedPaginate(key, '/v1/trading/account-history', {
        count: 100,
        label: 'Perpl account',
      });
      const first = events.find((e) => Number.isFinite(Number(e?.b)));
      if (first) accountValue = Number(first.b) / 1e6;
    } catch (e) {
      // Balance unavailable — keep accountValue 0 but still surface positions.
    }
    const upnl = positions.reduce((s, p) => s + (p.unrealizedPnl || 0), 0);
    return {
      ...base,
      exists: positions.length > 0 || accountValue > 0,
      fetchedAt: Date.now(),
      accountValue,
      unrealizedPnl: upnl,
      positions,
    };
  }

  async function fetchPerplEquity(perpl = null) {
    const key = perplKeyFromConfig(perpl);
    if (!key) {
      return { venue: 'perpl', configured: false, accountValue: 0 };
    }
    const state = await fetchPerplState(perpl);
    return {
      venue: 'perpl',
      configured: true,
      fetchedAt: state.fetchedAt || Date.now(),
      accountValue: state.accountValue,
      error: state.error || null,
    };
  }

  /** Funding payments (account-history et === 8) → shared payment shape. */
  async function fetchPerplFunding(perpl = null, days = 30) {
    const key = perplKeyFromConfig(perpl);
    const empty = { venue: 'perpl', configured: false, days, payments: [], totalFunding: 0 };
    if (!key) return { ...empty, configured: false };

    let context = {};
    try { context = await fetchPerplContext(); } catch (_) { /* symbols from mkt id only */ }

    let rows;
    try {
      rows = await perplSignedPaginate(key, '/v1/trading/account-history', {
        count: 100,
        label: 'Perpl funding',
      });
    } catch (e) {
      return { ...empty, configured: true, error: errorMessage(e) };
    }
    const windowStart = Date.now() - days * 86400000;
    const payments = rows
      .filter((e) => Number(e?.et) === 8)
      .map((e) => {
        const meta = context[String(e?.m)];
        const symbol = meta?.symbol || toBaseSymbol(e?.m != null ? String(e.m) : '');
        if (!symbol) return null;
        return {
          venue: 'perpl',
          time: Number(e?.at) || 0,
          symbol,
          usdc: Number(e?.a) / 1e6 || 0, // signed: negative = paid
          fundingRate: Number.isFinite(Number(e?.a))
            ? (Number(e.a) / 1e6) / (Math.abs(Number(e?.s) / (meta?.sizeScale || 1)) || 1)
            : null,
          size: Math.abs(Number(e?.s) / (meta?.sizeScale || 1)) || null,
          intervalHours: meta ? meta.fundingIntervalSec / 3600 : 1,
        };
      })
      .filter(Boolean)
      .filter((p) => p.time >= windowStart);

    payments.sort((a, b) => b.time - a.time);
    return {
      venue: 'perpl',
      configured: true,
      days,
      payments,
      totalFunding: payments.reduce((s, p) => s + p.usdc, 0),
    };
  }

  /** Fills → shared fill shape (fee in USD, closedPnl from settlement delta). */
  async function fetchPerplFills(perpl = null, days = 30) {
    const key = perplKeyFromConfig(perpl);
    const empty = { venue: 'perpl', configured: false, days, fills: [], totalFees: 0, totalRealized: 0, rawRowCount: 0 };
    if (!key) return empty;

    let context = {};
    try { context = await fetchPerplContext(); } catch (_) { /* price scaling falls back to 1 */ }

    let rows;
    try {
      rows = await perplSignedPaginate(key, '/v1/trading/fills', {
        count: 100,
        label: 'Perpl fills',
      });
    } catch (e) {
      return { ...empty, configured: true, error: errorMessage(e) };
    }
    const windowStart = Date.now() - days * 86400000;
    const fills = [];
    const seen = new Set();
    for (const row of rows) {
      const time = Number(row?.at) || 0;
      if (time < windowStart) continue;
      const meta = context[String(row?.mkt)];
      const symbol = meta?.symbol || toBaseSymbol(row?.mkt != null ? String(row.mkt) : '');
      if (!symbol) continue;
      const priceScale = meta?.priceScale || 1;
      const sizeScale = meta?.sizeScale || 1;
      const size = Number(row?.s) / sizeScale;
      if (!Number.isFinite(size) || size === 0) continue;
      const keyId = `${time}:${row?.oid ?? ''}:${symbol}:${row?.p ?? ''}:${size}`;
      if (seen.has(keyId)) continue;
      seen.add(keyId);
      const px = Number(row?.p) / priceScale || 0;
      const fee = Number(row?.f) / 1e6 || 0; // micros → USD
      fills.push({
        venue: 'perpl',
        time,
        symbol,
        px,
        sz: Math.abs(size),
        side: Number(row?.t) === 1 || Number(row?.t) === 3 ? 'buy' : 'sell',
        fee,
        closedPnl: 0, // realized PnL is not per-fill in Perpl fills
        oid: row?.oid ?? null,
      });
    }

    fills.sort((a, b) => b.time - a.time);
    return {
      venue: 'perpl',
      configured: true,
      days,
      fills,
      totalFees: fills.reduce((s, f) => s + f.fee, 0),
      totalRealized: 0,
      rawRowCount: rows.length,
    };
  }

  /** Capital flows: account-history Deposit(1)/Withdrawal(2). Signed like HL/Nado/GRVT. */
  async function fetchPerplCapitalFlows(perpl = null) {
    const key = perplKeyFromConfig(perpl);
    const empty = { venue: 'perpl', configured: false, payments: [], netDeposits: 0 };
    if (!key) return empty;

    let rows;
    try {
      rows = await perplSignedPaginate(key, '/v1/trading/account-history', {
        count: 100,
        label: 'Perpl flows',
      });
    } catch (e) {
      return { ...empty, configured: true, error: errorMessage(e) };
    }
    const payments = [];
    for (const e of rows) {
      const time = Number(e?.at) || 0;
      const et = Number(e?.et);
      const amount = Number(e?.a) || 0;
      if (!time || !Number.isFinite(amount) || amount === 0) continue;
      let usdc = 0;
      let kind = null;
      if (et === 1) {
        kind = 'deposit';
        usdc = Math.abs(amount) / 1e6;
      } else if (et === 2) {
        kind = 'withdraw';
        usdc = -Math.abs(amount) / 1e6;
      } else {
        continue;
      }
      payments.push({ venue: 'perpl', time, usdc, kind, type: et === 2 ? 'withdrawal' : 'deposit' });
    }
    payments.sort((a, b) => b.time - a.time);
    return {
      venue: 'perpl',
      configured: true,
      payments,
      netDeposits: payments.reduce((s, p) => s + p.usdc, 0),
    };
  }

  return {
    PERPL_API_URL,
    PERPL_CHAIN_ID,
    perplKeyFromConfig,
    perplHexToBuffer,
    perplPrivateKeyFromSeed,
    perplSignRequest,
    fetchPerplContext,
    fetchPerplRates,
    fetchPerplState,
    fetchPerplEquity,
    fetchPerplFunding,
    fetchPerplFills,
    fetchPerplCapitalFlows,
  };
}

module.exports = {
  PERPL_API_URL,
  PERPL_CHAIN_ID,
  perplHexToBuffer,
  perplPrivateKeyFromSeed,
  perplSignRequest,
  createPerplApi,
};

const PENDLE_CORE = 'https://api-v2.pendle.finance/core';

const CHAIN_NAMES = {
  1: 'Ethereum',
  10: 'Optimism',
  56: 'BSC',
  143: 'Monad',
  146: 'Sonic',
  999: 'HyperEVM',
  5000: 'Mantle',
  8453: 'Base',
  9745: 'Plasma',
  42161: 'Arbitrum',
  80094: 'Berachain',
  57073: 'Ink',
};

const MARKET_CACHE_MS = 5 * 60 * 1000;
let marketIndexCache = { at: 0, index: null };

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function percent(value) {
  const n = num(value, 0);
  return Math.abs(n) <= 1 ? n * 100 : n;
}

function parseAssetId(id) {
  const m = String(id || '').match(/^(\d+)-(.+)$/i);
  if (!m) return null;
  return { chainId: Number(m[1]), address: String(m[2]).toLowerCase() };
}

async function pendleFetch(path, { timeout = 30000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(`${PENDLE_CORE}${path}`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch (e) { body = { message: text.slice(0, 200) }; }
    if (!response.ok) {
      throw new Error(body?.message || body?.error || `Pendle HTTP ${response.status}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function marketRecordFromApi(market) {
  const pt = parseAssetId(market.pt);
  const yt = parseAssetId(market.yt);
  const sy = parseAssetId(market.sy);
  const chainId = pt?.chainId || yt?.chainId || num(market.chainId, 1);
  const details = market.details || {};
  return {
    name: market.name || 'Pendle market',
    protocol: market.protocol || '',
    expiry: market.expiry || null,
    chainId,
    chainName: CHAIN_NAMES[chainId] || `Chain ${chainId}`,
    marketAddress: String(market.address || '').toLowerCase(),
    marketId: `${chainId}-${String(market.address || '').toLowerCase()}`,
    ptAddress: pt?.address || '',
    ytAddress: yt?.address || '',
    syAddress: sy?.address || '',
    impliedApy: num(details.impliedApy, null),
    underlyingApy: num(details.underlyingApy, null),
    aggregatedApy: num(details.aggregatedApy, null),
    ptRoi: num(details.ptRoi, null),
    ptPrice: null,
  };
}

function buildMarketIndex(markets) {
  const byPtAddress = new Map();
  const byMarketAddress = new Map();
  const byMarketId = new Map();
  for (const market of markets || []) {
    const rec = marketRecordFromApi(market);
    if (rec.ptAddress) byPtAddress.set(rec.ptAddress, rec);
    if (rec.marketAddress) byMarketAddress.set(rec.marketAddress, rec);
    if (rec.marketId) byMarketId.set(rec.marketId.toLowerCase(), rec);
  }
  return {
    byPtAddress,
    byMarketAddress,
    byMarketId,
    marketCount: markets?.length || 0,
    updatedAt: Date.now(),
  };
}

async function fetchPendleMarketIndex({ force = false } = {}) {
  if (!force && marketIndexCache.index && Date.now() - marketIndexCache.at < MARKET_CACHE_MS) {
    return marketIndexCache.index;
  }
  const markets = [];
  let skip = 0;
  let total = Infinity;
  while (skip < total) {
    const page = await pendleFetch(`/v2/markets/all?limit=100&skip=${skip}`);
    const batch = page.results || [];
    if (!batch.length) break;
    markets.push(...batch);
    total = num(page.total, markets.length);
    skip += batch.length;
    if (batch.length < 100) break;
  }
  const index = buildMarketIndex(markets);
  marketIndexCache = { at: Date.now(), index };
  return index;
}

function rawBalanceUnits(raw, decimals = 18) {
  const v = BigInt(String(raw || '0'));
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = v % base;
  return Number(whole) + Number(frac) / Number(base);
}

function legHasBalance(leg) {
  if (!leg) return false;
  if (num(leg.valuation) > 0.01) return true;
  try { return BigInt(String(leg.balance || '0')) > 0n; } catch (e) { return false; }
}

function flattenWalletPendlePositions(wallet, payload, marketIndex) {
  const rows = [];
  for (const chain of payload?.positions || []) {
    const chainId = num(chain.chainId, 0);
    const chainName = CHAIN_NAMES[chainId] || `Chain ${chainId}`;
    const buckets = [
      ...(chain.openPositions || []).map(pos => ({ pos, open: true })),
      ...(chain.closedPositions || []).map(pos => ({ pos, open: false })),
    ];
    for (const { pos, open } of buckets) {
      const marketId = String(pos.marketId || '').toLowerCase();
      const meta = marketIndex.byMarketId.get(marketId) || null;
      const legs = [
        { type: 'PT', leg: pos.pt, symbol: meta ? `PT-${meta.name}` : 'PT' },
        { type: 'YT', leg: pos.yt, symbol: meta ? `YT-${meta.name}` : 'YT' },
        { type: 'LP', leg: pos.lp, symbol: meta ? `LP-${meta.name}` : 'LP' },
      ];
      for (const { type, leg, symbol } of legs) {
        if (!legHasBalance(leg)) continue;
        if (!open && num(leg.valuation) <= 0.01) continue;
        const decimals = type === 'LP' ? 18 : 6;
        rows.push({
          wallet: String(wallet),
          chainId,
          chainName,
          open,
          legType: type,
          symbol,
          marketName: meta?.name || marketId,
          marketAddress: meta?.marketAddress || parseAssetId(pos.marketId)?.address || '',
          marketId,
          balance: String(leg.balance || '0'),
          balanceUnits: rawBalanceUnits(leg.balance, decimals),
          valueUsd: num(leg.valuation, 0),
          impliedApy: meta?.impliedApy == null ? null : percent(meta.impliedApy),
          underlyingApy: meta?.underlyingApy == null ? null : percent(meta.underlyingApy),
          expiry: meta?.expiry || null,
          protocol: meta?.protocol || 'Pendle',
        });
      }
    }
  }
  rows.sort((a, b) => {
    if (a.open !== b.open) return a.open ? -1 : 1;
    return num(b.valueUsd) - num(a.valueUsd);
  });
  return rows;
}

async function fetchPendleWalletPositions(wallet) {
  const address = String(wallet || '').trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return { wallet: address, positions: [], error: 'Invalid EVM wallet' };
  }
  try {
    const payload = await pendleFetch(`/v1/dashboard/positions/database/${address}`);
    return { wallet: address, payload, error: null };
  } catch (e) {
    return { wallet: address, positions: [], error: e.message || 'Pendle positions fetch failed' };
  }
}

async function fetchPendleForWallets(wallets) {
  const clean = [...new Set((wallets || []).map(w => String(w || '').trim()).filter(w => /^0x[a-fA-F0-9]{40}$/.test(w)))];
  const errors = [];
  if (!clean.length) {
    return { updatedAt: Date.now(), marketCount: 0, wallets: [], errors: [] };
  }

  let marketIndex;
  try {
    marketIndex = await fetchPendleMarketIndex();
  } catch (e) {
    errors.push({ provider: 'pendle', message: e.message || 'Pendle markets fetch failed' });
    marketIndex = buildMarketIndex([]);
  }

  const settled = await Promise.allSettled(clean.map(fetchPendleWalletPositions));
  const walletsOut = settled.map((r, i) => {
    if (r.status !== 'fulfilled') {
      errors.push({ provider: 'pendle', wallet: clean[i], message: r.reason?.message || 'Pendle wallet fetch failed' });
      return { wallet: clean[i], positions: [], updatedAt: null };
    }
    const row = r.value;
    if (row.error) errors.push({ provider: 'pendle', wallet: row.wallet, message: row.error });
    const positions = row.payload
      ? flattenWalletPendlePositions(row.wallet, row.payload, marketIndex)
      : [];
    return {
      wallet: row.wallet,
      positions,
      updatedAt: row.payload?.positions?.[0]?.updatedAt || null,
      totalOpen: (row.payload?.positions || []).reduce((n, c) => n + num(c.totalOpen), 0),
    };
  });

  return {
    updatedAt: Date.now(),
    marketCount: marketIndex.marketCount,
    marketIndexUpdatedAt: marketIndex.updatedAt,
    wallets: walletsOut,
    errors,
  };
}

function isPtNamedLoop(position) {
  if (/PT/i.test(String(position?.marketName || ''))) return true;
  return (position?.supplied || []).some((leg) => /\bPT[-\s]/i.test(String(leg.symbol || '')) || /^PT/i.test(String(leg.symbol || '')));
}

function ptCollateralLeg(position, marketIndex) {
  const supplied = position?.supplied || [];
  const bySymbol = supplied.find((leg) => /PT/i.test(String(leg.symbol || '')));
  if (bySymbol) return bySymbol;
  return supplied.find((leg) => {
    const addr = String(leg.address || '').toLowerCase();
    return addr && marketIndex?.byPtAddress?.has(addr);
  });
}

function enrichPositionWithPendle(position, marketIndex, recomputePositionApy) {
  if (!position || !marketIndex || !isPtNamedLoop(position)) return position;
  const leg = ptCollateralLeg(position, marketIndex);
  if (!leg) return position;
  const addr = String(leg.address || '').toLowerCase();
  const meta = marketIndex.byPtAddress.get(addr);
  if (!meta || meta.impliedApy == null) return position;

  const impliedApy = percent(meta.impliedApy);
  leg.nativeApy = leg.nativeApy ?? leg.apy ?? 0;
  leg.pendleApy = impliedApy;
  leg.apy = impliedApy;
  leg.pendleMarket = meta.marketAddress;
  leg.pendleExpiry = meta.expiry;
  leg.pendleMarketName = meta.name;

  position.suppliedYieldUsd = (position.supplied || []).reduce(
    (sum, l) => sum + num(l.value) * num(l.apy, 0),
    0,
  );
  position.pendleEnriched = true;
  position.pendleImpliedApy = impliedApy;
  if (typeof recomputePositionApy === 'function') recomputePositionApy(position);
  return position;
}

module.exports = {
  PENDLE_CORE,
  fetchPendleMarketIndex,
  fetchPendleForWallets,
  enrichPositionWithPendle,
  isPtNamedLoop,
  buildMarketIndex,
  marketRecordFromApi,
  parseAssetId,
  percent,
};

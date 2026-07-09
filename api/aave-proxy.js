/**
 * POST /api/aave-proxy — Aave GraphQL proxy (browser-like headers)
 * GET  /api/perps     — Hyperliquid + Nado funding arb (rewritten here to stay within Vercel function limit)
 */

const {
  fetchPerpsDashboard,
  fetchPerpsEquitySnapshotWithVariational,
  fetchPerpsLiveRates,
  appendEquitySnapshotStore,
  buildEquitySnapshotFromDashboard,
} = require('../lib/perps');
const { kvGet, kvSet } = require('../lib/kv');
const { CACHE_KEYS, parseJson: parseCronJson } = require('../lib/cron-runner');
const { fetchLoopRates, mergeRecentLoopPositions } = require('../lib/loop-rates');
const {
  appendLoopSnapshotStore,
  buildLoopSnapshotFromRates,
  resolveLoopYieldWallets,
  persistLoopYieldWallets,
  persistLoopSnapshotStore,
  ensureUsdeUsdmSnapshotsPurged,
} = require('../lib/loop-snapshots');
const { ensureLoopLogoCache } = require('../lib/logo-resolver');

const responseCache = new Map();
const PERPS_DASHBOARD_CACHE_MS = 5 * 60 * 1000;
const LOOP_RATES_CACHE_MS = 15 * 60 * 1000;
const LOOP_RATES_KV_CACHE_MS = 15 * 60 * 1000;
const LOOP_RATES_CACHE_VERSION = 'v4';

function isWallet(v) {
  return typeof v === 'string' && /^0x[a-fA-F0-9]{40}$/.test(v.trim());
}

function parseJson(raw, fallback) {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch (e) { return fallback; }
}

function expectedSyncSecret() {
  return process.env.SYNC_SECRET || process.env.CRON_SECRET || '';
}

function providedCronSecret(req) {
  return String(
    req.headers['x-sync-secret']
    || req.query?.secret
    || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    || '',
  );
}

function sortedCsv(raw) {
  return String(raw || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))
    .join(',');
}

function msUntilNextHourly02() {
  const now = new Date();
  const next = new Date(now);
  next.setMinutes(2, 0, 0);
  if (next <= now) next.setHours(next.getHours() + 1);
  return Math.max(60 * 1000, next.getTime() - now.getTime());
}

function cacheGet(key) {
  const entry = responseCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) return null;
  return entry.body;
}

function cacheSet(key, body, ttlMs) {
  responseCache.set(key, {
    body,
    expiresAt: Date.now() + Math.max(1000, ttlMs),
    savedAt: Date.now(),
  });
  return body;
}

async function fetchWithRetry(fn, label, retries = 1) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
    }
  }
  const message = lastError?.message || String(lastError || 'failed');
  throw new Error(`${label} retry failed: ${message}`);
}

async function cachedJson(key, ttlMs, label, fn) {
  const cached = cacheGet(key);
  if (cached) return { ...cached, cached: true };
  try {
    const body = await fetchWithRetry(fn, label, 1);
    return cacheSet(key, body, ttlMs);
  } catch (e) {
    const stale = responseCache.get(key)?.body;
    if (stale) {
      const warning = `${label} retry failed; showing cached data: ${e.message || e}`;
      return {
        ...stale,
        cached: true,
        stale: true,
        warning,
        warnings: [...new Set([...(stale.warnings || []), warning])],
      };
    }
    throw e;
  }
}

function perpsSymbolsFromDashboard(data) {
  return [...new Set([
    ...(data?.paired || []).map(p => p.symbol),
    ...(data?.unhedged || []).map(p => p.symbol),
    ...(data?.rateSpread || []).map(p => p.symbol),
  ]
    .map(s => String(s || '').trim().toUpperCase().replace(/-PERP$/i, ''))
    .filter(Boolean))].sort();
}

function cacheKeyParts(key) {
  const [scope, rest = ''] = String(key || '').split(/:(.*)/s);
  return {
    scope,
    symbols: rest.split(',').map(s => s.trim()).filter(Boolean),
  };
}

async function kvCacheGet(key, matchKey, maxAgeMs, opts = {}) {
  const cached = parseCronJson(await kvGet(key), null);
  if (!cached?.data || !cached.fetchedAt) return null;
  if (matchKey && cached.key && cached.key !== matchKey) {
    if (!opts.allowSymbolSuperset) return null;
    const requested = cacheKeyParts(matchKey);
    const available = cacheKeyParts(cached.key);
    if (requested.scope !== available.scope) return null;
    const availableSet = new Set(available.symbols);
    if (requested.symbols.some(symbol => !availableSet.has(symbol))) return null;
  }
  if (Date.now() - Number(cached.fetchedAt) > maxAgeMs) return null;
  return { ...cached.data, cached: true, cacheSource: 'kv', cacheFetchedAt: cached.fetchedAt };
}

async function kvCacheSet(key, matchKey, data) {
  await kvSet(key, JSON.stringify({ key: matchKey, fetchedAt: Date.now(), data }));
}

async function handlePerpsCronSnapshot(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const secret = String(req.headers['x-sync-secret'] || req.query.secret || '');
  const expected = expectedSyncSecret();
  if (!expected || secret !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const savedConfig = parseJson(await kvGet('vault:perps_config'), {});
  const portfolio = parseJson(await kvGet('vault:portfolio'), {});
  const portfolioConfig = portfolio?.perpsArb && typeof portfolio.perpsArb === 'object'
    ? portfolio.perpsArb
    : {};
  const config = isWallet(savedConfig.hyperliquid) ? savedConfig : portfolioConfig;
  const wallet = String(config.hyperliquid || '').trim();
  const nadoWallet = String(config.nado || wallet).trim();
  const grvtSubAccount = String(
    config.grvtSubAccount || process.env.GRVT_SUB_ACCOUNT_ID || '4860249204328359',
  ).trim();
  const days = Math.min(365, Math.max(1, parseInt(config.days || '30', 10) || 30));

  if (!isWallet(wallet)) {
    return res.status(400).json({ error: 'No valid perps wallet in vault:perps_config' });
  }
  if (!isWallet(savedConfig.hyperliquid)) {
    await kvSet('vault:perps_config', JSON.stringify({
      ...config,
      hyperliquid: wallet,
      nado: nadoWallet,
      grvtSubAccount,
      configured: true,
    }));
  }

  try {
    const savedSnapshots = parseJson(await kvGet('vault:perps_snapshots'), {});
    const previousSnapshot = Object.values(savedSnapshots)
      .sort((a, b) => (Number(a?.fetchedAt) || 0) - (Number(b?.fetchedAt) || 0))
      .at(-1);
    const hedges = parseJson(await kvGet('vault:perps_variational_hedges'), []);
    const closedPairs = parseJson(await kvGet('vault:perps_closed_pairs'), []);
    const data = await fetchPerpsEquitySnapshotWithVariational({
      hyperliquid: wallet,
      nado: nadoWallet,
      grvtSubAccount,
      cumulativeNetDeposits: Number(previousSnapshot?.cumulativeNetDeposits) || 0,
    }, { hedges, closedPairs });
    const store = appendEquitySnapshotStore(savedSnapshots, data);
    await kvSet('vault:perps_snapshots', JSON.stringify(store));
    const { key, record } = buildEquitySnapshotFromDashboard(data);
    return res.status(200).json({
      ok: true,
      bucket: key,
      totalEquity: record.totalEquity,
      variationalEquityAdjust: record.variationalEquityAdjust ?? null,
      fetchedAt: record.fetchedAt,
      equityCollectionSpanMs: record.equityCollectionSpanMs,
      equityFetchedAts: record.equityFetchedAts,
      equitySampleMode: record.equitySampleMode,
      snapshotCount: Object.keys(store).length,
    });
  } catch (e) {
    console.error('[perps-cron]', e);
    return res.status(500).json({ error: e.message || 'Cron snapshot failed' });
  }
}

async function handlePerps(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-sync-secret');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (req.query.cronSnapshot === '1') {
    return handlePerpsCronSnapshot(req, res);
  }

  const wallet = String(req.query.wallet || req.query.hyperliquid || '').trim();
  const nadoWallet = String(req.query.nadoWallet || req.query.nado || wallet).trim();
  const days = Math.min(365, Math.max(1, parseInt(req.query.days || '30', 10) || 30));

  const grvtSubAccount = String(
    req.query.grvtSubAccount || req.query.grvt || process.env.GRVT_SUB_ACCOUNT_ID || '4860249204328359',
  ).trim();

  if (req.query.live === '1') {
    try {
      const symbols = String(req.query.symbols || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      const cacheKey = `${grvtSubAccount}:${sortedCsv(req.query.symbols)}`;
      const kvCached = req.query.force === '1'
        ? null
        : await kvCacheGet(CACHE_KEYS.perpsLive, cacheKey, 90 * 1000, { allowSymbolSuperset: true });
      if (kvCached) return res.status(200).json(kvCached);
      const data = await cachedJson(
        `perps:live:${cacheKey}`,
        msUntilNextHourly02(),
        'Perps live funding',
        () => fetchPerpsLiveRates({ grvtSubAccount, symbols }),
      );
      await kvCacheSet(CACHE_KEYS.perpsLive, cacheKey, data);
      return res.status(200).json(data);
    } catch (e) {
      console.error('[perps-live]', e);
      return res.status(500).json({ error: e.message || 'Live rates fetch failed' });
    }
  }

  if (!isWallet(wallet)) {
    return res.status(400).json({ error: 'Valid hyperliquid wallet required (0x + 40 hex chars)' });
  }
  if (!isWallet(nadoWallet)) {
    return res.status(400).json({ error: 'Valid nado wallet required' });
  }

  const knownClosedKeys = String(req.query.knownClosedKeys || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const dashboardOpts = {
    hyperliquid: wallet,
    nado: nadoWallet,
    grvtSubAccount,
    days,
    knownClosedKeys,
    grvtPositionsOverride: req.query.grvtPositions || null,
  };

  try {
    const data = knownClosedKeys.length
      ? await fetchPerpsDashboard(dashboardOpts)
      : await cachedJson(
        `perps:dashboard:${wallet.toLowerCase()}:${nadoWallet.toLowerCase()}:${grvtSubAccount}:${days}`,
        PERPS_DASHBOARD_CACHE_MS,
        'Perps dashboard',
        () => fetchPerpsDashboard(dashboardOpts),
      );
    const activeSymbols = perpsSymbolsFromDashboard(data);
    if (activeSymbols.length) await kvSet('vault:perps_symbols', JSON.stringify(activeSymbols));
    return res.status(200).json(data);
  } catch (e) {
    console.error('[perps]', e);
    return res.status(500).json({ error: e.message || 'Perps fetch failed' });
  }
}

async function persistLoopLogoCache(positions) {
  try {
    const saved = parseJson(await kvGet('vault:logo_cache'), {});
    const { cache, changed } = await ensureLoopLogoCache(saved, positions, { maxResolve: 16 });
    if (changed) await kvSet('vault:logo_cache', JSON.stringify(cache));
    return changed;
  } catch (e) {
    console.warn('[loop-logos]', e.message || e);
    return false;
  }
}

async function handleLoopCronSnapshot(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const expected = expectedSyncSecret();
  if (!expected || providedCronSecret(req) !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const wallets = await resolveLoopYieldWallets({ kvGet, parseJson });
  if (!wallets.length) {
    return res.status(400).json({ error: 'No yield wallets configured for loop snapshots' });
  }

  try {
    const previousCache = parseCronJson(await kvGet(CACHE_KEYS.loopRates), null);
    const freshData = await fetchLoopRates({ wallets });
    const data = mergeRecentLoopPositions(freshData, previousCache?.data, {
      previousFetchedAt: previousCache?.fetchedAt,
    });
    const savedSnapshots = parseJson(await kvGet('vault:loop_snapshots'), {});
    const store = appendLoopSnapshotStore(savedSnapshots, data);
    const persisted = await persistLoopSnapshotStore({ kvGet, kvSet, parseJson, store });
    await persistLoopYieldWallets(kvSet, wallets);
    const logosUpdated = await persistLoopLogoCache(data.positions);
    await kvSet(CACHE_KEYS.loopRates, JSON.stringify({
      key: `${LOOP_RATES_CACHE_VERSION}:${wallets.map((w) => w.toLowerCase()).sort().join(',')}`,
      fetchedAt: Date.now(),
      data,
    }));
    const { key, record } = buildLoopSnapshotFromRates(data);
    return res.status(200).json({
      ok: true,
      bucket: key,
      fetchedAt: record.fetchedAt,
      positionCount: record.positions.length,
      snapshotCount: persisted.bucketCount,
      latestFetchedAt: persisted.latestFetchedAt,
      logosUpdated,
    });
  } catch (e) {
    console.error('[loop-cron]', e);
    return res.status(500).json({ error: e.message || 'Loop cron snapshot failed' });
  }
}

async function handleLoopSnapshots(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    await ensureUsdeUsdmSnapshotsPurged({ kvGet, kvSet, parseJson });
    const loopSnapshots = parseJson(await kvGet('vault:loop_snapshots'), {});
    return res.status(200).json({ ok: true, loopSnapshots });
  } catch (e) {
    console.error('[loop-snapshots]', e);
    return res.status(500).json({ error: e.message || 'Loop snapshots fetch failed' });
  }
}

async function persistLoopSnapshotsFromRates(data, wallets = []) {
  try {
    const savedSnapshots = parseJson(await kvGet('vault:loop_snapshots'), {});
    const store = appendLoopSnapshotStore(savedSnapshots, data);
    const persisted = await persistLoopSnapshotStore({ kvGet, kvSet, parseJson, store });
    if (wallets.length) await persistLoopYieldWallets(kvSet, wallets);
    return persisted;
  } catch (e) {
    console.warn('[loop-snapshots-persist]', e.message || e);
    throw e;
  }
}

async function handleLoopRates(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const wallets = String(req.query.wallets || req.query.wallet || '')
    .split(',')
    .map(w => w.trim())
    .filter(Boolean);

  try {
    const walletKey = `${LOOP_RATES_CACHE_VERSION}:${wallets.map(w => w.toLowerCase()).sort().join(',')}`;
    const writeSnapshots = req.query.snapshots !== '0';
    const kvCached = req.query.force === '1'
      ? null
      : await kvCacheGet(CACHE_KEYS.loopRates, walletKey, LOOP_RATES_KV_CACHE_MS);
    if (kvCached) {
      if (writeSnapshots) await persistLoopSnapshotsFromRates(kvCached, wallets);
      return res.status(200).json(kvCached);
    }
    const previousCache = parseCronJson(await kvGet(CACHE_KEYS.loopRates), null);
    const freshData = await cachedJson(
      `loop-rates:${walletKey}`,
      LOOP_RATES_CACHE_MS,
      'Loop rates',
      () => fetchLoopRates({ wallets }),
    );
    const data = mergeRecentLoopPositions(freshData, previousCache?.data, {
      previousFetchedAt: previousCache?.fetchedAt,
    });
    if (writeSnapshots) await persistLoopSnapshotsFromRates(data, wallets);
    await persistLoopLogoCache(data.positions);
    await kvCacheSet(CACHE_KEYS.loopRates, walletKey, data);
    return res.status(200).json(data);
  } catch (e) {
    console.error('[loop-rates]', e);
    return res.status(500).json({ error: e.message || 'Loop rates fetch failed' });
  }
}

module.exports = async function handler(req, res) {
  if (req.query.loopCronSnapshot === '1') {
    return handleLoopCronSnapshot(req, res);
  }
  if (req.query.loopSnapshots === '1') {
    return handleLoopSnapshots(req, res);
  }
  if (req.query.loopRates === '1') {
    return handleLoopRates(req, res);
  }

  if (req.method === 'GET' && (
    req.query.wallet
    || req.query.hyperliquid
    || req.query.cronSnapshot === '1'
    || req.query.live === '1'
  )) {
    return handlePerps(req, res);
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) {
      return res.status(400).json({ error: 'Invalid JSON' });
    }
  }

  try {
    const r = await fetch('https://api.v3.aave.com/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://app.aave.com',
        'Referer': 'https://app.aave.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
      body: JSON.stringify(body),
    });

    const data = await r.json();
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

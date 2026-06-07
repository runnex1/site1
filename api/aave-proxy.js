/**
 * POST /api/aave-proxy — Aave GraphQL proxy (browser-like headers)
 * GET  /api/perps     — Hyperliquid + Nado funding arb (rewritten here to stay within Vercel function limit)
 */

const {
  fetchPerpsDashboard,
  fetchPerpsEquitySnapshot,
  fetchPerpsLiveRates,
  appendEquitySnapshotStore,
  buildEquitySnapshotFromDashboard,
} = require('../lib/perps');
const { kvGet, kvSet } = require('../lib/kv');
const { fetchLoopRates } = require('../lib/loop-rates');
const {
  appendLoopSnapshotStore,
  buildLoopSnapshotFromRates,
  loopYieldWalletsFromWatcherList,
} = require('../lib/loop-snapshots');
const { ensureLoopLogoCache } = require('../lib/logo-resolver');

const responseCache = new Map();
const PERPS_DASHBOARD_CACHE_MS = 5 * 60 * 1000;
const LOOP_RATES_CACHE_MS = 15 * 60 * 1000;

function isWallet(v) {
  return typeof v === 'string' && /^0x[a-fA-F0-9]{40}$/.test(v.trim());
}

function parseJson(raw, fallback) {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch (e) { return fallback; }
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

async function handlePerpsCronSnapshot(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const secret = String(req.headers['x-sync-secret'] || req.query.secret || '');
  if (!process.env.SYNC_SECRET || secret !== process.env.SYNC_SECRET) {
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
    const data = await fetchPerpsEquitySnapshot({
      hyperliquid: wallet,
      nado: nadoWallet,
      grvtSubAccount,
      cumulativeNetDeposits: Number(previousSnapshot?.cumulativeNetDeposits) || 0,
    });
    const store = appendEquitySnapshotStore(savedSnapshots, data);
    await kvSet('vault:perps_snapshots', JSON.stringify(store));
    const { key, record } = buildEquitySnapshotFromDashboard(data);
    return res.status(200).json({
      ok: true,
      bucket: key,
      totalEquity: record.totalEquity,
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
      const data = await cachedJson(
        `perps:live:${grvtSubAccount}:${sortedCsv(req.query.symbols)}`,
        msUntilNextHourly02(),
        'Perps live funding',
        () => fetchPerpsLiveRates({ grvtSubAccount, symbols }),
      );
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
  const secret = String(req.headers['x-sync-secret'] || req.query.secret || '');
  if (!process.env.SYNC_SECRET || secret !== process.env.SYNC_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const watcherWallets = parseJson(await kvGet('vault:watcherwallets'), []);
  const wallets = loopYieldWalletsFromWatcherList(watcherWallets);
  if (!wallets.length) {
    return res.status(400).json({ error: 'No yield wallets configured in vault:watcherwallets' });
  }

  try {
    const data = await fetchLoopRates({ wallets });
    const savedSnapshots = parseJson(await kvGet('vault:loop_snapshots'), {});
    const store = appendLoopSnapshotStore(savedSnapshots, data);
    await kvSet('vault:loop_snapshots', JSON.stringify(store));
    const logosUpdated = await persistLoopLogoCache(data.positions);
    const { key, record } = buildLoopSnapshotFromRates(data);
    return res.status(200).json({
      ok: true,
      bucket: key,
      fetchedAt: record.fetchedAt,
      positionCount: record.positions.length,
      snapshotCount: Object.keys(store).length,
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
    const loopSnapshots = parseJson(await kvGet('vault:loop_snapshots'), {});
    return res.status(200).json({ ok: true, loopSnapshots });
  } catch (e) {
    console.error('[loop-snapshots]', e);
    return res.status(500).json({ error: e.message || 'Loop snapshots fetch failed' });
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
    const data = await cachedJson(
      `loop-rates:${wallets.map(w => w.toLowerCase()).sort().join(',')}`,
      LOOP_RATES_CACHE_MS,
      'Loop rates',
      () => fetchLoopRates({ wallets }),
    );
    await persistLoopLogoCache(data.positions);
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

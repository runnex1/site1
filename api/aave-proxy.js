/**
 * POST /api/aave-proxy — Aave GraphQL proxy (browser-like headers)
 * GET  /api/perps     — Hyperliquid + Nado funding arb (rewritten here to stay within Vercel function limit)
 */

const {
  fetchPerpsDashboard,
  fetchPerpsLiveRates,
  appendEquitySnapshotStore,
  buildEquitySnapshotFromDashboard,
} = require('../lib/perps');
const { kvGet, kvSet } = require('../lib/kv');

function isWallet(v) {
  return typeof v === 'string' && /^0x[a-fA-F0-9]{40}$/.test(v.trim());
}

function parseJson(raw, fallback) {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch (e) { return fallback; }
}

async function handlePerpsCronSnapshot(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const secret = String(req.headers['x-sync-secret'] || req.query.secret || '');
  if (!process.env.SYNC_SECRET || secret !== process.env.SYNC_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const config = parseJson(await kvGet('vault:perps_config'), {});
  const wallet = String(config.hyperliquid || '').trim();
  const nadoWallet = String(config.nado || wallet).trim();
  const grvtSubAccount = String(
    config.grvtSubAccount || process.env.GRVT_SUB_ACCOUNT_ID || '4860249204328359',
  ).trim();
  const days = Math.min(90, Math.max(1, parseInt(config.days || '30', 10) || 30));

  if (!isWallet(wallet)) {
    return res.status(400).json({ error: 'No valid perps wallet in vault:perps_config' });
  }

  try {
    const data = await fetchPerpsDashboard({
      hyperliquid: wallet,
      nado: nadoWallet,
      grvtSubAccount,
      days,
    });
    const store = appendEquitySnapshotStore(parseJson(await kvGet('vault:perps_snapshots'), {}), data);
    await kvSet('vault:perps_snapshots', JSON.stringify(store));
    const { key, record } = buildEquitySnapshotFromDashboard(data);
    return res.status(200).json({
      ok: true,
      bucket: key,
      totalEquity: record.totalEquity,
      fetchedAt: record.fetchedAt,
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
  const days = Math.min(90, Math.max(1, parseInt(req.query.days || '30', 10) || 30));

  const grvtSubAccount = String(
    req.query.grvtSubAccount || req.query.grvt || process.env.GRVT_SUB_ACCOUNT_ID || '4860249204328359',
  ).trim();

  if (req.query.live === '1') {
    try {
      const symbols = String(req.query.symbols || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      const data = await fetchPerpsLiveRates({ grvtSubAccount, symbols });
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

  try {
    const data = await fetchPerpsDashboard({
      hyperliquid: wallet,
      nado: nadoWallet,
      grvtSubAccount,
      days,
    });
    return res.status(200).json(data);
  } catch (e) {
    console.error('[perps]', e);
    return res.status(500).json({ error: e.message || 'Perps fetch failed' });
  }
}

module.exports = async function handler(req, res) {
  if (req.method === 'GET' && (req.query.wallet || req.query.hyperliquid)) {
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

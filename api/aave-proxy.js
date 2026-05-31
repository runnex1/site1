/**
 * POST /api/aave-proxy — Aave GraphQL proxy (browser-like headers)
 * GET  /api/perps     — Hyperliquid + Nado funding arb (rewritten here to stay within Vercel function limit)
 */

const { fetchPerpsDashboard } = require('../lib/perps');

function isWallet(v) {
  return typeof v === 'string' && /^0x[a-fA-F0-9]{40}$/.test(v.trim());
}

async function handlePerps(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const wallet = String(req.query.wallet || req.query.hyperliquid || '').trim();
  const nadoWallet = String(req.query.nadoWallet || req.query.nado || wallet).trim();
  const days = Math.min(90, Math.max(1, parseInt(req.query.days || '30', 10) || 30));

  if (!isWallet(wallet)) {
    return res.status(400).json({ error: 'Valid hyperliquid wallet required (0x + 40 hex chars)' });
  }
  if (!isWallet(nadoWallet)) {
    return res.status(400).json({ error: 'Valid nado wallet required' });
  }

  try {
    const grvtSubAccount = String(
      req.query.grvtSubAccount || req.query.grvt || process.env.GRVT_SUB_ACCOUNT_ID || '4860249204328359',
    ).trim();
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

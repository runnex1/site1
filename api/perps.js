/**
 * GET /api/perps?wallet=0x...&nadoWallet=0x...&days=30
 * Read-only Hyperliquid + Nado positions and funding history.
 */

const { fetchPerpsDashboard } = require('../lib/perps');

function isWallet(v) {
  return typeof v === 'string' && /^0x[a-fA-F0-9]{40}$/.test(v.trim());
}

module.exports = async function handler(req, res) {
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
    const data = await fetchPerpsDashboard({ hyperliquid: wallet, nado: nadoWallet, days });
    return res.status(200).json(data);
  } catch (e) {
    console.error('[perps]', e);
    return res.status(500).json({ error: e.message || 'Perps fetch failed' });
  }
};

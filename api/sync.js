/**
 * POST /api/sync-portfolio
 *
 * Receives full portfolio snapshot from browser and stores in KV.
 * Called by the browser every time saveData() runs.
 *
 * Stores:
 *   vault:portfolio   — tokens, protocols, ETFs, prediction markets, watchlist
 *   vault:watchlist   — watchlist entries with prices
 *   vault:snapshots   — weekly portfolio snapshots
 *   vault:aavemarkets — Aave cap markets being monitored
 *   vault:customtokens— custom token definitions
 */

const { kvGet, kvSet } = require('../lib/kv');

const SYNC_SECRET = process.env.SYNC_SECRET || '';

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-sync-secret');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Auth
  if (SYNC_SECRET) {
    const provided = req.headers['x-sync-secret'];
    if (provided !== SYNC_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) {
      return res.status(400).json({ error: 'Invalid JSON' });
    }
  }

  const saved = {};

  try {
    // Portfolio data (tokens, protocols, ETFs, prediction markets)
    if (body.portfolio) {
      await kvSet('vault:portfolio', JSON.stringify(body.portfolio));
      saved.portfolio = true;
    }

    // Watchlist
    if (body.watchlist) {
      await kvSet('vault:watchlist', JSON.stringify(body.watchlist));
      saved.watchlist = true;
    }

    // Weekly snapshots
    if (body.snapshots) {
      await kvSet('vault:snapshots', JSON.stringify(body.snapshots));
      saved.snapshots = true;
    }

    // Aave markets being monitored
    if (body.aaveMarkets) {
      await kvSet('vault:aavemarkets', JSON.stringify(body.aaveMarkets));
      saved.aaveMarkets = true;
    }

    // Custom token definitions
    if (body.customTokens) {
      await kvSet('vault:customtokens', JSON.stringify(body.customTokens));
      saved.customTokens = true;
    }

    // Watcher wallets
    if (body.watcherWallets) {
      await kvSet('vault:watcherwallets', JSON.stringify(body.watcherWallets));
      saved.watcherWallets = true;
    }

    // Polymarket wallet addresses — also available inside body.portfolio
    const pmWallets = body.polymarketWallets || body.portfolio?.polymarketWallets;
    if (pmWallets) {
      await kvSet('vault:pm_wallets', JSON.stringify(pmWallets));
      saved.pmWallets = true;
    }

    // Watcher links
    if (body.watcherLinks) {
      await kvSet('vault:watcherlinks', JSON.stringify(body.watcherLinks));
      saved.watcherLinks = true;
    }

    // Opinion.trade wallet addresses (no API key stored)
    if (body.opinionWallets) {
      await kvSet('vault:opinion_wallets', JSON.stringify(body.opinionWallets));
      saved.opinionWallets = true;
    }

    // Portfolio snapshots
    if (body.snapshots) {
      await kvSet('vault:snapshots', JSON.stringify(body.snapshots));
      saved.snapshots = true;
    }

    // Chart comparison tickers
    if (body.chartTickers) {
      await kvSet('vault:chart_tickers', JSON.stringify(body.chartTickers));
      saved.chartTickers = true;
    }

    // TG / news feed channel handles
    if (body.tgChannels) {
      await kvSet('vault:feed_channels', JSON.stringify(body.tgChannels));
      saved.tgChannels = true;
    }

    // Timestamp of last sync
    await kvSet('vault:portfolio_synced_at', Date.now().toString());

    return res.status(200).json({ ok: true, saved });
  } catch (e) {
    console.error('[sync-portfolio] KV error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};

/**
 * POST /api/sync-alerts
 * Syncs browser alerts to KV.
 * Real-world event alerts are intentionally disabled and stripped here.
 */

const { kvGet, kvSet } = require('../lib/kv');

const ALERTS_KEY       = 'vault:alerts';
const RECENT_FIRED_KEY = 'vault:recent_fired';

const SERVER_FIELDS = ['lastEventCheck', 'tgSent'];
const ALLOWED_TYPES = new Set(['crypto', 'stock', 'etf', 'polymarket', 'opinion', 'aavecap', 'contract', 'pmapy']);
const CRYPTO_TICKERS = new Set([
  'BTC','ETH','SOL','BNB','XRP','ADA','DOGE','MATIC','POL','DOT','SHIB','LTC','LINK','UNI','ATOM','XLM','NEAR','APT','SUI','ARB','OP','INJ','TIA','PEPE','WIF','BONK','JUP','PYTH','JTO','RNDR','HNT','AVAX','USDC','USDT','DAI','FRAX','USDE','SUSDE','WBTC','STETH','WSTETH','RETH','CBETH','EZETH','EETH','WEETH','RSETH','CRV','CVX','LDO','MKR','SNX','COMP','YFI','SUSHI','BAL','AAVE','PENDLE','ENA','PRIME'
]);

function isEventAlert(alert) {
  return alert?.type === 'event' || !!alert?.condition;
}

function sanitizeAlert(alert) {
  if (!alert || typeof alert !== 'object') return null;
  if (isEventAlert(alert)) return null;

  const a = { ...alert };
  if (!a.id) a.id = Date.now().toString() + Math.random().toString(36).slice(2, 5);
  if (!a.type && a.symbol) a.type = 'crypto';
  if (!ALLOWED_TYPES.has(a.type)) return null;

  if (a.symbol && typeof a.symbol === 'string') {
    a.symbol = a.type === 'aavecap' ? a.symbol.trim() : a.symbol.trim().toUpperCase();
  }

  // Browser/AI sometimes misclassifies lowercase crypto tickers as stocks.
  if ((a.type === 'stock' || a.type === 'etf') && CRYPTO_TICKERS.has(String(a.symbol || '').toUpperCase())) {
    a.type = 'crypto';
    a.symbol = String(a.symbol).toUpperCase();
  }

  if (a.type === 'aavecap') {
    if (!a.symbol || !a.chainId) return null;
    a.chainId = Number(a.chainId);
    a.target = Number(a.target);
    if (!Number.isFinite(a.chainId) || !Number.isFinite(a.target)) return null;
    if (a.dir !== 'above' && a.dir !== 'below') return null;
    return { ...a, triggered: !!a.triggered };
  }

  if (a.type === 'contract') {
    if (!a.contractAddress || !a.contractChain) return null;
  } else if (!a.symbol) {
    return null;
  }

  a.target = Number(a.target);
  if (!Number.isFinite(a.target)) return null;
  if (a.dir !== 'above' && a.dir !== 'below') return null;

  return { ...a, triggered: !!a.triggered };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-sync-secret');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    try {
      const stored = await kvGet(ALERTS_KEY);
      const alerts = stored ? (typeof stored === 'string' ? JSON.parse(stored) : stored) : [];
      const firedRaw = await kvGet(RECENT_FIRED_KEY);
      const fired = firedRaw ? (typeof firedRaw === 'string' ? JSON.parse(firedRaw) : firedRaw) : [];
      const clean = Array.isArray(alerts) ? alerts.map(sanitizeAlert).filter(Boolean) : [];
      if (Array.isArray(alerts) && clean.length !== alerts.length) {
        await kvSet(ALERTS_KEY, JSON.stringify(clean));
      }
      return res.status(200).json({
        ok: true,
        alerts: clean,
        recentFired: Array.isArray(fired) ? fired.slice(-20) : [],
        removed: Array.isArray(alerts) ? alerts.length - clean.length : 0,
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const syncSecret = process.env.SYNC_SECRET;
  if (syncSecret) {
    const provided = req.headers['x-sync-secret'];
    // Browser alert sync sends an empty credential; keep that legacy flow working.
    if (provided && provided !== syncSecret) return res.status(401).json({ error: 'Unauthorized' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) {
      return res.status(400).json({ error: 'Invalid JSON' });
    }
  }

  const browserAlerts = body?.alerts;
  const tgChannels    = body?.tgChannels || [];
  if (body?.command) {
    try {
      const { processVaultCommand } = require('./tg-webhook');
      if (typeof processVaultCommand !== 'function') throw new Error('server command processor unavailable');
      const result = await processVaultCommand(String(body.command || ''), { answerQuestions: true });
      return res.status(200).json({ ok: !!result.ok, ...result });
    } catch (e) {
      return res.status(500).json({ ok:false, handled:true, error:e.message, messages:['Server command error: ' + e.message] });
    }
  }
  if (!Array.isArray(browserAlerts)) {
    return res.status(400).json({ error: 'alerts must be an array' });
  }

  try {
    let existing = [];
    let recentFired = new Set();
    try {
      const stored = await kvGet(ALERTS_KEY);
      if (stored) existing = typeof stored === 'string' ? JSON.parse(stored) : stored;
    } catch (e) {}
    try {
      const firedRaw = await kvGet(RECENT_FIRED_KEY);
      if (firedRaw) {
        const firedArr = typeof firedRaw === 'string' ? JSON.parse(firedRaw) : firedRaw;
        recentFired = new Set((Array.isArray(firedArr) ? firedArr : []).map(r => typeof r === 'object' ? r.id : r).filter(Boolean));
      }
    } catch (e) {}

    const existingClean = (Array.isArray(existing) ? existing : []).map(sanitizeAlert).filter(Boolean);
    const existingMap = new Map(existingClean.map(a => [a.id, a]));
    const sanitizedBrowserAlerts = browserAlerts.map(sanitizeAlert).filter(Boolean);
    const browserIds = new Set(sanitizedBrowserAlerts.map(a => a.id));

    const browserMerged = sanitizedBrowserAlerts
      .filter(a => !a.triggered && !recentFired.has(a.id))
      .map(a => {
        const kv = existingMap.get(a.id);
        if (!kv) return a;
        const patch = {};
        for (const f of SERVER_FIELDS) {
          if (kv[f] !== undefined) patch[f] = kv[f];
        }
        return Object.keys(patch).length ? { ...a, ...patch } : a;
      });

    // Browser localStorage is not allowed to erase Telegram-created alerts.
    // Those can be removed with the Telegram remove/clear commands.
    const tgOnly = existingClean.filter(a =>
      a.source === 'tg' &&
      !a.triggered &&
      !browserIds.has(a.id) &&
      !recentFired.has(a.id)
    );

    const mergedMap = new Map();
    for (const a of [...browserMerged, ...tgOnly]) mergedMap.set(a.id, a);
    const merged = [...mergedMap.values()];

    await kvSet(ALERTS_KEY, JSON.stringify(merged));

    if (Array.isArray(tgChannels) && tgChannels.length > 0) {
      await kvSet('vault:tg_channels', JSON.stringify(tgChannels));
    }

    return res.status(200).json({
      ok: true,
      count: merged.length,
      active: merged.filter(a => !a.triggered).length,
      browser: browserAlerts.length,
      rejected: browserAlerts.length - sanitizedBrowserAlerts.length,
      eventAlertsDisabled: true,
      tgOnly: tgOnly.length,
      recentFired: [...recentFired],
    });
  } catch (e) {
    console.error('[sync-alerts] KV write error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};

/**
 * POST /api/sync-alerts
 * Merges browser alerts with KV alerts (preserves TG-set alerts).
 */

const { kvGet, kvSet } = require('../lib/kv');

const ALERTS_KEY       = 'vault:alerts';
const RECENT_FIRED_KEY = 'vault:recent_fired';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-sync-secret');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET — return current alerts from KV (used by terminalLoad to merge on startup)
  if (req.method === 'GET') {
    try {
      const stored = await kvGet(ALERTS_KEY);
      const alerts = stored ? (typeof stored === 'string' ? JSON.parse(stored) : stored) : [];
      return res.status(200).json({ ok: true, alerts });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const syncSecret = process.env.SYNC_SECRET;
  if (syncSecret) {
    const provided = req.headers['x-sync-secret'];
    if (provided !== syncSecret) return res.status(401).json({ error: 'Unauthorized' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) {
      return res.status(400).json({ error: 'Invalid JSON' });
    }
  }

  const browserAlerts = body?.alerts;
  const tgChannels    = body?.tgChannels || [];

  if (!Array.isArray(browserAlerts)) {
    return res.status(400).json({ error: 'alerts must be an array' });
  }

  try {
    // Load existing KV alerts and recently fired IDs
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
        recentFired = new Set(firedArr);
      }
    } catch (e) {}

    const browserIds = new Set(browserAlerts.map(a => a.id));

    // Only keep untriggered browser alerts that haven't already fired on the server
    const merged = browserAlerts.filter(a => !a.triggered && !recentFired.has(a.id));

    // Add TG-only alerts — but only if browser sent a non-empty list.
    // If browser sends [], the user explicitly cleared everything — don't restore KV alerts.
    if (browserAlerts.length > 0) {
      const tgOnly = existing.filter(a => !browserIds.has(a.id) && !a.triggered && !recentFired.has(a.id));
      merged.push(...tgOnly);
    }

    await kvSet(ALERTS_KEY, JSON.stringify(merged));

    if (Array.isArray(tgChannels) && tgChannels.length > 0) {
      await kvSet('vault:tg_channels', JSON.stringify(tgChannels));
    }

    // ── Immediately check brand-new event alerts ────────────────────────────
    // A "new" alert is one the browser just added (not in previous KV state)
    // and created within the last 2 minutes (guards against KV-cleared re-saves).
    const existingIds = new Set(existing.map(a => a.id));
    const newEventAlerts = browserAlerts.filter(a =>
      a.type === 'event' &&
      !existingIds.has(a.id) &&
      !a.triggered &&
      (Date.now() - (a.setAt || 0)) < 120000
    );
    if (newEventAlerts.length > 0) {
      const baseUrl = 'https://' + (process.env.VERCEL_PROJECT_PRODUCTION_URL || 'testedefi.vercel.app');
      // Await so the function doesn't terminate before checks complete
      await Promise.allSettled(newEventAlerts.map(a =>
        fetch(baseUrl + '/api/event-check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // Pass alertId so event-check sends TG + marks triggered in KV if fired
          body: JSON.stringify({ condition: a.condition, label: a.label, alertId: a.id }),
          signal: AbortSignal.timeout(22000),
        }).catch(e => console.warn('[sync-alerts] immediate check failed:', e.message))
      ));
    }

    return res.status(200).json({
      ok:          true,
      count:       merged.length,
      active:      merged.filter(a => !a.triggered).length,
      browser:     browserAlerts.length,
      tgOnly:      0,
      recentFired: [...recentFired], // let browser remove these from localStorage
    });
  } catch (e) {
    console.error('[sync-alerts] KV write error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};

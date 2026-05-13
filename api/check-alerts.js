const { kvGet, kvSet } = require('../lib/kv');
const { fetchPrice, fmtPrice, AAVE_CHAIN_NAMES } = require('../lib/price');

const ALERTS_KEY       = 'vault:alerts';
const TG_CHAN_KEY      = 'vault:tg_channels';
const RECENT_FIRED_KEY = 'vault:recent_fired';
const GRACE_MS         = 5000;   // 5 s grace period before a new alert is eligible
const EVENT_CHECK_MS   = 60000;  // 1 min between checks per event alert

function dedupKey(alert) {
  return alert.id || (alert.symbol + '-' + alert.dir + '-' + alert.target);
}

async function tgSend(token, chatId, text) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
    const j = await res.json();
    if (!j.ok) console.error('[TG] Send failed:', j.description);
    return j;
  } catch (e) {
    console.error('[TG] Network error:', e.message);
  }
}

function isTriggered(alert, price) {
  if (price == null) return false;
  return alert.dir === 'above' ? price >= alert.target : price <= alert.target;
}

function buildMessage(alert, price, now) {
  const label     = alert.label || alert.symbol;
  const priceStr  = fmtPrice(price, alert.type);
  const targetStr = fmtPrice(alert.target, alert.type);
  const dirStr    = alert.dir === 'above' ? 'rose above' : 'dropped below';

  let typeTag = '';
  switch (alert.type) {
    case 'crypto':     typeTag = '🪙 Crypto';    break;
    case 'stock':      typeTag = '📈 Stock';      break;
    case 'etf':        typeTag = '📊 ETF';         break;
    case 'polymarket': typeTag = '🎯 Polymarket'; break;
    case 'aavecap': {
      const chain = AAVE_CHAIN_NAMES[alert.chainId] || `Chain ${alert.chainId}`;
      typeTag = `🏦 Aave / ${chain}`;
      break;
    }
    case 'contract':   typeTag = '📝 Token';      break;
    default:           typeTag = '🔔';
  }

  return [
    `🔔 <b>Vault Alert — ${label}</b>`,
    ``,
    `<b>Type:</b> ${typeTag}`,
    `<b>Current:</b> ${priceStr}`,
    `<b>Trigger:</b> ${dirStr} ${targetStr}`,
    ``,
    `<i>${now}</i>`,
  ].join('\n');
}

module.exports = async function handler(req, res) {
  // Auth
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const provided =
      req.headers['x-cron-secret'] ||
      (req.headers['authorization'] || '').replace('Bearer ', '');
    if (provided !== secret) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  // CORS — allow browser polling
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-cron-secret, authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const tgToken  = (process.env.TG_BOT_TOKEN || '').trim();
  const tgChatId = (process.env.TG_CHAT_ID   || '').trim();
  if (!tgToken || !tgChatId) {
    return res.status(200).json({ skipped: true, reason: 'no_telegram_config' });
  }

  // ── Load alerts ──────────────────────────────────────────────────────────
  let alerts = [];
  try {
    const stored = await kvGet(ALERTS_KEY);
    if (stored) alerts = typeof stored === 'string' ? JSON.parse(stored) : stored;
    if (!Array.isArray(alerts)) alerts = [];
  } catch (e) {
    console.error('[check-alerts] load error:', e.message);
  }

  const now          = Date.now();
  const active       = alerts.filter(a => !a.triggered && (!a.setAt || (now - a.setAt) >= GRACE_MS));
  const skippedGrace = alerts.filter(a => !a.triggered && a.setAt && (now - a.setAt) < GRACE_MS).length;

  if (!active.length) {
    return res.status(200).json({ ok: true, checked: 0, fired: 0, skippedGrace, reason: 'no_active_alerts' });
  }

  const baseUrl  = 'https://' + (process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || 'testedefi.vercel.app');
  const nowStr   = new Date().toUTCString();
  const results  = [];
  const newFired = [];
  let alertsModified = false;

  // ── EVENT ALERTS — check in PARALLEL ────────────────────────────────────
  //
  // FIX: previously these ran in a sequential for-loop with await, so 6 alerts
  // × up to 25 s each = 150 s total, always timing out at maxDuration=30 s.
  //
  // FIX: lastEventCheck is now stamped and saved to KV BEFORE the async checks
  // start. If the function times out mid-run the stamp still persists, preventing
  // the same alerts from being re-checked every 10 seconds forever.

  const eventAlerts = active.filter(a => a.type === 'event');
  const dueEvents   = eventAlerts.filter(a => (now - (a.lastEventCheck || 0)) >= EVENT_CHECK_MS);

  if (dueEvents.length > 0) {
    // Cap alerts per run so timing always fits within Vercel's 60 s maxDuration.
    // Formula: stagger*(n-1) + PER_CHECK_MS < 60000
    // With PER_CHECK_MS=22s and MAX_PER_RUN=12: 11*3.4s + 22s ≈ 59s (safe).
    // Alerts beyond the cap are skipped this run but stamped due so they fire next minute.
    const MAX_PER_RUN  = 12;
    const PER_CHECK_MS = 22000;
    const batch        = dueEvents.slice(0, MAX_PER_RUN);
    // Dynamic stagger: spread batch evenly across (60s - per-check budget - 2s margin)
    const staggerBudget = 60000 - PER_CHECK_MS - 2000;  // 36 000 ms
    const staggerMs     = batch.length > 1
      ? Math.floor(staggerBudget / (batch.length - 1))
      : 0;

    console.log('[check-alerts] Event alerts due:', dueEvents.length, '/', eventAlerts.length,
      '| batch:', batch.length, '| stagger:', staggerMs + 'ms');

    // STAMP NOW in memory + persist to KV immediately (prevents re-entry)
    dueEvents.forEach(a => {
      const live = alerts.find(x => x.id === a.id);
      if (live) { live.lastEventCheck = now; alertsModified = true; }
    });
    try {
      await kvSet(ALERTS_KEY, JSON.stringify(alerts));
      alertsModified = false; // freshly saved; track new changes from here
    } catch (e) {
      console.error('[check-alerts] KV stamp error (continuing):', e.message);
    }

    // Run batch event-checks in parallel with dynamic stagger
    const ecResults = await Promise.allSettled(
      batch.map(async (alert, idx) => {
        if (idx > 0) await new Promise(r => setTimeout(r, idx * staggerMs));
        const condition = (alert.condition || alert.label || '').trim();
        if (!condition) return { alertId: alert.id, triggered: false, reason: 'no_condition' };

        console.log('[event] Checking condition:', condition.slice(0, 80));
        const ecRes = await fetch(baseUrl + '/api/event-check', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ condition, label: alert.label, alertId: alert.id }),
          signal:  AbortSignal.timeout(PER_CHECK_MS),
        });
        if (!ecRes.ok) throw new Error('event-check HTTP ' + ecRes.status);
        const ecData = await ecRes.json();
        console.log('[event] verdict=' + ecData.verdict + ' triggered=' + ecData.triggered + ' | ' + condition.slice(0, 60));
        return { alertId: alert.id, triggered: !!ecData.triggered, verdict: ecData.verdict };
      })
    );

    for (const r of ecResults) {
      if (r.status === 'rejected') {
        console.error('[check-alerts] event check failed:', r.reason?.message || r.reason);
        continue;
      }
      const { alertId, triggered, verdict, reason } = r.value;
      results.push({ id: alertId, type: 'event', triggered, verdict, reason });

      if (triggered) {
        // TG message was already sent by /api/event-check (it has the alertId)
        newFired.push(alertId);
        const live = alerts.find(a => a.id === alertId);
        if (live) { live._delete = true; alertsModified = true; }
      }
    }
  } else if (eventAlerts.length > 0) {
    const nextMs = Math.min(...eventAlerts.map(a => EVENT_CHECK_MS - (now - (a.lastEventCheck || 0))));
    console.log('[check-alerts] All event alerts throttled. Next check in', Math.round(nextMs / 1000), 's');
    eventAlerts.forEach(a => results.push({ id: a.id, type: 'event', triggered: false, reason: 'throttled' }));
  }

  // ── PRICE / MARKET ALERTS — run in PARALLEL ──────────────────────────────
  const priceAlerts = active.filter(a => a.type !== 'event' && a.type !== 'opinion');

  const priceResults = await Promise.allSettled(
    priceAlerts.map(async (alert) => {
      let price = null;
      try { price = await fetchPrice(alert); }
      catch (e) { console.error(`fetchPrice ${alert.symbol}:`, e.message); }
      return { alert, price };
    })
  );

  for (const r of priceResults) {
    if (r.status === 'rejected') continue;
    const { alert, price } = r.value;
    const triggered = isTriggered(alert, price);

    results.push({
      id: alert.id, symbol: alert.symbol, type: alert.type,
      price:   price != null ? +price.toFixed(6) : null,
      target:  alert.target, dir: alert.dir, triggered,
    });

    if (!triggered) continue;

    await tgSend(tgToken, tgChatId, buildMessage(alert, price, nowStr));
    newFired.push(alert.id);
    const live = alerts.find(a => a.id === alert.id);
    if (live) { live._delete = true; alertsModified = true; }
    console.log('[vault-alerts] Fired: ' + (alert.label || alert.symbol));
  }

  // ── Persist ───────────────────────────────────────────────────────────────
  try {
    if (alertsModified) {
      const remaining = alerts.filter(a => !a._delete);
      await kvSet(ALERTS_KEY, JSON.stringify(remaining));
    }

    if (newFired.length > 0) {
      const firedRaw = await kvGet(RECENT_FIRED_KEY);
      const existing = firedRaw
        ? (typeof firedRaw === 'string' ? JSON.parse(firedRaw) : firedRaw)
        : [];
      const updated = [...existing, ...newFired].slice(-100);
      await kvSet(RECENT_FIRED_KEY, JSON.stringify(updated));
    }
  } catch (e) {
    console.error('[check-alerts] KV write:', e.message);
  }

  return res.status(200).json({
    ok: true, timestamp: nowStr,
    checked: results.length, fired: newFired.length,
    recentFired: newFired,
    skippedGrace, results,
  });
};

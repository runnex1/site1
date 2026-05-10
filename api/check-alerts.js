const { kvGet, kvSet } = require('../lib/kv');
const { fetchPrice, fmtPrice, AAVE_CHAIN_NAMES } = require('../lib/price');
const { fetchRecentHeadlines, checkEventCondition } = require('../lib/news');

const ALERTS_KEY      = 'vault:alerts';
const TG_CHAN_KEY     = 'vault:tg_channels';
const RECENT_FIRED_KEY = 'vault:recent_fired';
const GROQ_KEY        = process.env.GROQ_API_KEY;   // ← from Vercel env vars
const GRACE_MS        = 5000;   // 5 seconds grace period
const EVENT_CHECK_MS  = 600000; // check event alerts every 10 minutes

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

  // Load alerts
  let alerts = [];
  try {
    const stored = await kvGet(ALERTS_KEY);
    if (stored) alerts = typeof stored === 'string' ? JSON.parse(stored) : stored;
  } catch (e) {
    console.error('[check-alerts] load error:', e.message);
  }

  const now          = Date.now();
  const active       = alerts.filter(a => !a.triggered && (!a.setAt || (now - a.setAt) >= GRACE_MS));
  const skippedGrace = alerts.filter(a => !a.triggered && a.setAt && (now - a.setAt) < GRACE_MS).length;

  if (!active.length) {
    return res.status(200).json({ ok: true, checked: 0, fired: 0, skippedGrace, reason: 'no_active_alerts' });
  }

  const nowStr        = new Date().toUTCString();
  const results       = [];
  const newFired      = [];
  let alertsModified  = false;
  const handlerState  = {};

  for (const alert of active) {
    if (alert.type === 'opinion') continue;

    // ── Event alerts — check via news + AI ──────────────────────────────────
    if (alert.type === 'event') {
      try {
        const lastChecked = alert.lastEventCheck || 0;
        if ((now - lastChecked) < EVENT_CHECK_MS) {
          results.push({ id: alert.id, symbol: alert.symbol, type: 'event', triggered: false, reason: 'throttled' });
          continue;
        }
        alert.lastEventCheck = now;
        alertsModified = true;

        // Use condition if set, fall back to label
        const condition = (alert.condition || alert.label || '').trim();
        if (!condition) {
          console.warn('[event] Alert has no condition or label — skipping:', alert.id);
          results.push({ id: alert.id, type: 'event', triggered: false, reason: 'no_condition' });
          continue;
        }

        if (!GROQ_KEY) {
          console.warn('[event] GROQ_API_KEY not set — skipping event alert');
          results.push({ id: alert.id, type: 'event', triggered: false, reason: 'no_groq_key' });
          continue;
        }

        console.log('[event] Checking condition:', condition);

        const tgChanStored = await kvGet(TG_CHAN_KEY);
        const tgChannels   = tgChanStored
          ? (typeof tgChanStored === 'string' ? JSON.parse(tgChanStored) : tgChanStored)
          : [];

        if (!handlerState.headlines) {
          handlerState.headlines = await fetchRecentHeadlines(tgChannels);
        }

        const { triggered: eventTriggered, reason } = await checkEventCondition(
          condition,                  // ← fixed: was alert.condition (could be undefined)
          handlerState.headlines,
          GROQ_KEY,
        );

        console.log(`[event] Groq says triggered=${eventTriggered} for: "${condition}" — reason: ${reason}`);

        results.push({ id: alert.id, symbol: alert.symbol, type: 'event', triggered: eventTriggered, reason });

        if (eventTriggered) {
          const msg = [
            '🔔 <b>Event Alert — ' + (alert.label || condition) + '</b>',
            '',
            '<b>Condition:</b> ' + condition,
            '<b>Reason:</b> ' + reason,
            '',
            '<i>' + nowStr + '</i>',
          ].join('\n');
          await tgSend(tgToken, tgChatId, msg);
          newFired.push(alert.id);
          alert._delete    = true;
          alertsModified   = true;
        }
      } catch (e) {
        console.error('[check-alerts] event check error:', e.message);
      }
      continue;
    }

    // ── Price / market alerts ────────────────────────────────────────────────
    let price = null;
    try { price = await fetchPrice(alert); }
    catch (e) { console.error(`fetchPrice ${alert.symbol}:`, e.message); }

    const triggered = isTriggered(alert, price);

    results.push({
      id: alert.id, symbol: alert.symbol, type: alert.type,
      price:   price != null ? +price.toFixed(6) : null,
      target:  alert.target, dir: alert.dir, triggered,
    });

    if (!triggered) continue;

    await tgSend(tgToken, tgChatId, buildMessage(alert, price, nowStr));
    newFired.push(alert.id);
    alert._delete   = true;
    alertsModified  = true;
    console.log('[vault-alerts] Fired: ' + (alert.label || alert.symbol));
  }

  // Persist
  try {
    if (alertsModified) {
      const remaining = alerts.filter(a => !a._delete);
      await kvSet(ALERTS_KEY, JSON.stringify(remaining));
    }

    // Write fired IDs to recent_fired so browser re-syncs don't re-add them
    if (newFired.length > 0) {
      const firedRaw = await kvGet(RECENT_FIRED_KEY);
      const existing = firedRaw
        ? (typeof firedRaw === 'string' ? JSON.parse(firedRaw) : firedRaw)
        : [];
      // Keep last 100 fired IDs to prevent unbounded growth
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

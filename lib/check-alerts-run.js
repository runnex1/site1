const { kvGet, kvSet } = require('../lib/kv');
const { fetchPrice, fmtPrice, AAVE_CHAIN_NAMES } = require('../lib/price');
const { collectEvents } = require('../lib/event-log');

const ALERTS_KEY       = 'vault:alerts';
const RECENT_FIRED_KEY = 'vault:recent_fired';
const GRACE_MS         = 5000; // 5 s grace period before a new alert is eligible

async function updateEventLogQuietly() {
  try {
    if (typeof collectEvents === 'function') await collectEvents();
  } catch (e) {
    console.error('[check-alerts] event-log update error:', e.message);
  }
}

function isEventAlert(alert) {
  return alert?.type === 'event' || !!alert?.condition;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapePolymarketUrl(value) {
  const url = String(value || '');
  return /^https:\/\/(?:www\.)?polymarket\.com\//i.test(url) ? escapeHtml(url) : '';
}

function polymarketUrlFromSlugs(eventSlug, marketSlug) {
  const event = String(eventSlug || marketSlug || '').trim();
  const market = String(marketSlug || eventSlug || '').trim();
  if (!event) return '';
  return market && market !== event
    ? `https://polymarket.com/event/${event}/${market}`
    : `https://polymarket.com/event/${event}`;
}

function fmtPercent(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '?';
  if (Math.abs(n) >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 0 }) + '%';
  if (Math.abs(n) >= 100) return n.toFixed(0) + '%';
  return n.toFixed(1) + '%';
}

function fmtPmOdds(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '?';
  const pct = n * 100;
  if (pct === 0) return '<0.1%';
  if (pct > 0 && pct < 1) return pct.toFixed(2) + '%';
  return pct.toFixed(1) + '%';
}

async function pmTokenPrice(tokenId) {
  if (!tokenId) return null;
  try {
    const res = await fetch(`https://clob.polymarket.com/last-trade-price?token_id=${encodeURIComponent(tokenId)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const price = Number(data?.price);
    return Number.isFinite(price) ? price : null;
  } catch (e) {
    return null;
  }
}

async function safeJson(url, timeout = 8000) {
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeout) });
    return res.ok ? await res.json() : null;
  } catch (e) {
    return null;
  }
}

function marketStatusEnded(m) {
  const e = m?.event || {};
  if (m?.closed === true || m?.resolved === true || m?.archived === true || e.closed === true || e.resolved === true || e.archived === true) return true;
  if (m?.active === false || e.active === false) return true;
  const status = String([m?.status, m?.resolutionStatus, m?.state, e.status, e.resolutionStatus, e.state].filter(Boolean).join(' ')).toLowerCase();
  return /\b(closed|resolved|ended|settled|archived)\b/.test(status);
}

async function polymarketAlertEnded(alert) {
  const slug = alert.marketSlug || alert.symbol;
  if (!slug) return false;
  const data = await safeJson(`https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}&limit=1`);
  const market = Array.isArray(data) ? data[0] : (data?.markets?.[0] || data?.data?.[0] || null);
  return market ? marketStatusEnded(market) : false;
}

function firedRecord(alert, price, now, reason = 'triggered') {
  return {
    id: alert.id,
    at: now,
    type: alert.type,
    symbol: alert.symbol,
    label: alert.label || alert.marketTitle || alert.symbol || 'alert',
    price,
    target: alert.target,
    reason,
  };
}

function endedMessage(alert, now) {
  const label = alert.type === 'polymarket' && alert.marketTitle
    ? (() => {
        const url = escapePolymarketUrl(alert.marketUrl || polymarketUrlFromSlugs(alert.eventSlug, alert.marketSlug || alert.symbol));
        return url ? `<a href="${url}">${escapeHtml(alert.marketTitle)}</a>` : escapeHtml(alert.marketTitle);
      })()
    : escapeHtml(alert.label || alert.symbol);
  return [`🧹 <b>Removed ended Polymarket alert</b>`, '', label, '', `<i>${escapeHtml(now)}</i>`].join('\n');
}

async function currentNoOdds(alert) {
  let price = null;
  if (alert.asset) price = await pmTokenPrice(alert.asset);
  if (price == null && alert.marketSlug) {
    try { price = await fetchPrice({ type: 'polymarket', marketSlug: alert.marketSlug, symbol: alert.marketSlug, side: alert.positionOutcome || 'NO' }); }
    catch (e) { price = null; }
  }
  if (price == null || !Number.isFinite(Number(price)) || price <= 0 || price >= 1) return null;
  return /^yes$/i.test(alert.positionOutcome || '') ? 1 - Number(price) : Number(price);
}

async function checkPmapyAlert(alert, now) {
  const end = new Date(alert.endAt || 0);
  if (!end || !Number.isFinite(end.getTime()) || end.getTime() <= now) return { price: null, triggered: false };
  const noOdds = await currentNoOdds(alert);
  if (!noOdds || noOdds <= 0.70) return { price: null, triggered: false };
  const days = Math.max(1, Math.ceil((end.getTime() - now) / 86400000));
  const apy = Math.pow(1 / noOdds, 365 / days) - 1;
  return { price: apy, noOdds, days, triggered: apy >= Number(alert.target || 0) };
}

function isTriggered(alert, price) {
  if (price == null) return false;
  return alert.dir === 'above' ? price >= alert.target : price <= alert.target;
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
    return { ok: false, description: e.message };
  }
}

function buildMessage(alert, price, now) {
  if (alert.type === 'pmapy') {
    const url = escapePolymarketUrl(alert.marketUrl || polymarketUrlFromSlugs(alert.eventSlug, alert.marketSlug || alert.symbol));
    const title = url ? `<a href="${url}">${escapeHtml(alert.marketTitle || alert.symbol)}</a>` : escapeHtml(alert.marketTitle || alert.symbol);
    return [
      `ðŸ”” <b>Vault Alert â€” ${title}</b>`,
      '',
      '<b>Type:</b> ðŸ“ˆ Polymarket APY',
      `<b>Current APY:</b> ${escapeHtml(fmtPercent(Number(price) * 100))}`,
      `<b>Target:</b> over ${escapeHtml(fmtPercent(Number(alert.target) * 100))}`,
      alert._lastNoOdds != null ? `<b>NO odds:</b> ${escapeHtml(fmtPmOdds(alert._lastNoOdds))}` : '',
      alert._lastDays != null ? `<b>Days left:</b> ${escapeHtml(String(alert._lastDays))}` : '',
      '',
      `<i>${escapeHtml(now)}</i>`,
    ].filter(Boolean).join('\n');
  }
  const label     = alert.type === 'polymarket' && alert.marketTitle
    ? (() => {
        const url = escapePolymarketUrl(alert.marketUrl || polymarketUrlFromSlugs(alert.eventSlug, alert.marketSlug || alert.symbol));
        const title = url ? `<a href="${url}">${escapeHtml(alert.marketTitle)}</a>` : escapeHtml(alert.marketTitle);
        return `${title} ${escapeHtml(alert.side || 'YES')} ${escapeHtml(alert.dir || 'above')} ${escapeHtml(fmtPrice(alert.target, alert.type))}`;
      })()
    : escapeHtml(alert.label || alert.symbol);
  const priceStr  = escapeHtml(fmtPrice(price, alert.type));
  const targetStr = escapeHtml(fmtPrice(alert.target, alert.type));
  const dirStr    = alert.dir === 'above' ? 'rose above' : 'dropped below';

  let typeTag = '';
  switch (alert.type) {
    case 'crypto':     typeTag = '🪙 Crypto'; break;
    case 'stock':      typeTag = '📈 Stock'; break;
    case 'etf':        typeTag = '📊 ETF'; break;
    case 'polymarket': typeTag = '🎯 Polymarket'; break;
    case 'aavecap': {
      const chain = escapeHtml(AAVE_CHAIN_NAMES[alert.chainId] || `Chain ${alert.chainId}`);
      typeTag = `🏦 Aave / ${chain}`;
      break;
    }
    case 'contract':   typeTag = '📝 Token'; break;
    default:           typeTag = '🔔';
  }

  return [
    `🔔 <b>Vault Alert — ${label}</b>`,
    '',
    `<b>Type:</b> ${typeTag}`,
    `<b>Current:</b> ${priceStr}`,
    `<b>Trigger:</b> ${dirStr} ${targetStr}`,
    '',
    `<i>${escapeHtml(now)}</i>`,
  ].join('\n');
}

module.exports = async function runCheckAlerts(req, res) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const provided =
      req.headers['x-cron-secret'] ||
      req.query?.secret ||
      (req.headers['authorization'] || '').replace('Bearer ', '');
    if (provided !== secret) return res.status(401).json({ error: 'Unauthorized' });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-cron-secret, authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const tgToken  = (process.env.TG_BOT_TOKEN || '').trim();
  const tgChatId = (process.env.TG_CHAT_ID   || '').trim();
  if (!tgToken || !tgChatId) {
    await updateEventLogQuietly();
    return res.status(200).json({ skipped: true, reason: 'no_telegram_config' });
  }

  let alerts = [];
  try {
    const stored = await kvGet(ALERTS_KEY);
    if (stored) alerts = typeof stored === 'string' ? JSON.parse(stored) : stored;
    if (!Array.isArray(alerts)) alerts = [];
  } catch (e) {
    console.error('[check-alerts] load error:', e.message);
  }

  // Real-world event alerts were intentionally removed. Purge any stale event
  // alerts from KV so they cannot be checked or fired by old clients.
  const nonEventAlerts = alerts.filter(a => !isEventAlert(a));
  const purgedEvents = alerts.length - nonEventAlerts.length;
  if (purgedEvents > 0) {
    try { await kvSet(ALERTS_KEY, JSON.stringify(nonEventAlerts)); }
    catch (e) { console.error('[check-alerts] purge event alerts error:', e.message); }
  }
  alerts = nonEventAlerts;

  const now          = Date.now();
  const active       = alerts.filter(a => !a.triggered && (!a.setAt || (now - a.setAt) >= GRACE_MS));
  const skippedGrace = alerts.filter(a => !a.triggered && a.setAt && (now - a.setAt) < GRACE_MS).length;

  if (!active.length) {
    await updateEventLogQuietly();
    try { await kvSet('vault:last_cron_ok', String(now)); } catch (e) {}
    try { await kvSet('vault:last_alert_check_summary', JSON.stringify({ timestamp: now, checked: 0, fired: 0, skippedGrace, purgedEvents, reason: 'no_active_alerts' })); } catch (e) {}
    return res.status(200).json({ ok: true, checked: 0, fired: 0, skippedGrace, purgedEvents, reason: 'no_active_alerts' });
  }

  const nowStr   = new Date().toUTCString();
  const results  = [];
  const newFired = [];
  let alertsModified = false;

  const priceAlerts = active.filter(a => a.type !== 'opinion' && a.type !== 'pmapy');
  const apyAlerts = active.filter(a => a.type === 'pmapy');
  const apyResults = await Promise.allSettled(
    apyAlerts.map(async (alert) => {
      const checked = await checkPmapyAlert(alert, now);
      return { alert, ...checked };
    })
  );
  for (const r of apyResults) {
    if (r.status === 'rejected') continue;
    const { alert, price, noOdds, days, triggered } = r.value;
    if (noOdds != null) alert._lastNoOdds = noOdds;
    if (days != null) alert._lastDays = days;
    const result = {
      id: alert.id, symbol: alert.symbol, type: alert.type,
      price: price != null ? +price.toFixed(6) : null,
      target: alert.target, dir: alert.dir, triggered,
    };
    results.push(result);
    if (!triggered) continue;
    const tgResult = await tgSend(tgToken, tgChatId, buildMessage(alert, price, nowStr));
    result.tgDelivered = !!tgResult?.ok;
    if (!tgResult?.ok) {
      result.tgError = tgResult?.description || 'unknown_telegram_error';
      console.error('[vault-alerts] Triggered but Telegram delivery failed; keeping alert for retry:', alert.id, result.tgError);
      continue;
    }
    newFired.push(firedRecord(alert, price, now));
    const live = alerts.find(a => a.id === alert.id);
    if (live) { live._delete = true; alertsModified = true; }
    console.log('[vault-alerts] Fired + delivered: ' + (alert.label || alert.symbol));
  }
  const priceResults = await Promise.allSettled(
    priceAlerts.map(async (alert) => {
      let price = null;
      let ended = false;
      if (alert.type === 'polymarket') ended = await polymarketAlertEnded(alert);
      if (ended) return { alert, price, ended };
      try { price = await fetchPrice(alert); }
      catch (e) { console.error(`fetchPrice ${alert.symbol}:`, e.message); }
      return { alert, price, ended };
    })
  );

  for (const r of priceResults) {
    if (r.status === 'rejected') continue;
    const { alert, price, ended } = r.value;
    if (ended) {
      const result = { id: alert.id, symbol: alert.symbol, type: alert.type, price: null, target: alert.target, dir: alert.dir, triggered: false, ended: true };
      results.push(result);
      const tgResult = await tgSend(tgToken, tgChatId, endedMessage(alert, nowStr));
      result.tgDelivered = !!tgResult?.ok;
      if (!tgResult?.ok) continue;
      newFired.push(firedRecord(alert, null, now, 'ended'));
      const live = alerts.find(a => a.id === alert.id);
      if (live) { live._delete = true; alertsModified = true; }
      continue;
    }
    const triggered = isTriggered(alert, price);

    const result = {
      id: alert.id, symbol: alert.symbol, type: alert.type,
      price: price != null ? +price.toFixed(6) : null,
      target: alert.target, dir: alert.dir, triggered,
    };
    results.push(result);

    if (!triggered) continue;

    const tgResult = await tgSend(tgToken, tgChatId, buildMessage(alert, price, nowStr));
    result.tgDelivered = !!tgResult?.ok;
    if (!tgResult?.ok) {
      result.tgError = tgResult?.description || 'unknown_telegram_error';
      console.error('[vault-alerts] Triggered but Telegram delivery failed; keeping alert for retry:', alert.id, result.tgError);
      continue;
    }

    newFired.push(firedRecord(alert, price, now));
    const live = alerts.find(a => a.id === alert.id);
    if (live) { live._delete = true; alertsModified = true; }
    console.log('[vault-alerts] Fired + delivered: ' + (alert.label || alert.symbol));
  }

  try {
    if (alertsModified) {
      const remaining = alerts.filter(a => !a._delete);
      await kvSet(ALERTS_KEY, JSON.stringify(remaining));
    }

    if (newFired.length > 0) {
      const firedRaw = await kvGet(RECENT_FIRED_KEY);
      const existing = firedRaw ? (typeof firedRaw === 'string' ? JSON.parse(firedRaw) : firedRaw) : [];
      const updated = [...existing, ...newFired].slice(-100);
      await kvSet(RECENT_FIRED_KEY, JSON.stringify(updated));
    }

    await kvSet('vault:last_cron_ok', String(now));
    await kvSet('vault:last_alert_check_summary', JSON.stringify({ timestamp: now, checked: results.length, fired: newFired.length, skippedGrace, purgedEvents }));
    await updateEventLogQuietly();
  } catch (e) {
    console.error('[check-alerts] KV write:', e.message);
  }

  return res.status(200).json({
    ok: true, timestamp: nowStr,
    checked: results.length, fired: newFired.length,
    recentFired: newFired,
    skippedGrace,
    purgedEvents,
    results,
  });
};

/**
 * lib/activity.js
 * Server-side Polymarket activity fetcher.
 * Used by api/ask.js to answer questions like:
 *   "What Polymarket positions moved over 5% today?"
 *   "What trades did I make on Polymarket today?"
 */

const { kvGet } = require('./kv');

const PM_WALLETS_KEY = 'vault:pm_wallets';
const FALLBACK_WALLET = '0x2Ec0aa99D26b703585f58bdEd217a640d09e976b';

async function getWallets() {
  try {
    const stored = await kvGet(PM_WALLETS_KEY);
    if (!stored) return [FALLBACK_WALLET];
    const parsed = typeof stored === 'string' ? JSON.parse(stored) : stored;
    return Array.isArray(parsed) && parsed.length ? parsed : [FALLBACK_WALLET];
  } catch (e) {
    return [FALLBACK_WALLET];
  }
}

async function pmFetch(url) {
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; VaultBot/1.0)',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  }
}

/**
 * Fetch positions with >5% price change in the last 24h across all wallets.
 * Returns array sorted by absolute % change descending.
 */
async function fetchMovers() {
  const wallets = await getWallets();
  const since24h = Math.floor(Date.now() / 1000) - 86400;
  const allPositions = [];

  for (const wallet of wallets) {
    let offset = 0;
    while (true) {
      const page = await pmFetch(
        `https://data-api.polymarket.com/positions?user=${encodeURIComponent(wallet)}&limit=100&offset=${offset}&sizeThreshold=0.01`
      );
      if (!Array.isArray(page) || page.length === 0) break;
      allPositions.push(...page.map(p => ({ ...p, _wallet: wallet })));
      if (page.length < 100) break;
      offset += 100;
    }
  }

  if (allPositions.length === 0) return [];

  // De-dupe by asset token
  const seen = new Set();
  const unique = allPositions.filter(p => {
    if (!p.asset || seen.has(p.asset)) return false;
    seen.add(p.asset);
    return true;
  });

  const movers = [];

  await Promise.all(unique.map(async pos => {
    const hist = await pmFetch(
      `https://clob.polymarket.com/prices-history?market=${encodeURIComponent(pos.asset)}&startTs=${since24h}&resolution=1h`
    );

    const size = parseFloat(pos.size || 0);
    const curPrice = size > 0 ? parseFloat(pos.currentValue || 0) / size : 0;
    const price24hAgo = hist?.history?.length
      ? parseFloat(hist.history[0].p ?? hist.history[0].price ?? 0)
      : null;

    if (!price24hAgo || price24hAgo === 0 || curPrice === 0) return;

    const pctChange = ((curPrice - price24hAgo) / price24hAgo) * 100;
    if (Math.abs(pctChange) < 5) return;

    // Sum value/size across all wallets holding this asset
    const allHolding = allPositions.filter(p2 => p2.asset === pos.asset);
    movers.push({
      title: pos.title || 'Unknown Market',
      outcome: pos.outcome || '',
      asset: pos.asset,
      pctChange,
      curPrice,
      price24hAgo,
      value: allHolding.reduce((s, p2) => s + parseFloat(p2.currentValue || 0), 0),
      size: allHolding.reduce((s, p2) => s + parseFloat(p2.size || 0), 0),
    });
  }));

  return movers.sort((a, b) => Math.abs(b.pctChange) - Math.abs(a.pctChange));
}

/**
 * Fetch trades filled in the last 24h across all wallets.
 * Returns array sorted newest first.
 */
async function fetchTrades() {
  const wallets = await getWallets();
  const since = Math.floor(Date.now() / 1000) - 86400;
  const trades = [];

  for (const wallet of wallets) {
    let offset = 0;
    while (true) {
      const page = await pmFetch(
        `https://data-api.polymarket.com/activity?user=${encodeURIComponent(wallet)}&type=TRADE&limit=500&offset=${offset}&start=${since}&sortBy=TIMESTAMP&sortDirection=DESC`
      );
      if (!Array.isArray(page) || page.length === 0) break;
      const recent = page.filter(t => (t.timestamp || 0) >= since);
      trades.push(...recent.map(t => ({ ...t, _wallet: wallet })));
      if (recent.length < page.length || page.length < 500) break;
      offset += 500;
    }
  }

  return trades.sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * Format movers + trades into a compact text block for AI prompts.
 */
function formatActivityForPrompt(movers, trades) {
  const lines = ['POLYMARKET PORTFOLIO ACTIVITY (last 24h):'];

  if (movers.length) {
    lines.push('\nPositions with >5% price move:');
    movers.forEach(m => {
      const dir = m.pctChange >= 0 ? '↑' : '↓';
      const sign = m.pctChange >= 0 ? '+' : '';
      lines.push(
        `  ${dir} ${sign}${m.pctChange.toFixed(1)}%  "${m.title}" [${m.outcome}]` +
        `  ${(m.price24hAgo * 100).toFixed(0)}¢→${(m.curPrice * 100).toFixed(0)}¢` +
        `  value $${m.value.toFixed(2)}`
      );
    });
  } else {
    lines.push('\nNo positions moved more than 5% in the last 24h.');
  }

  if (trades.length) {
    lines.push('\nTrades filled today:');
    // Group by market+outcome+side for brevity
    const grouped = new Map();
    for (const t of trades) {
      const key = `${t.title}||${t.outcome}||${t.side}`;
      if (!grouped.has(key)) grouped.set(key, { ...t, totalShares: 0, totalCost: 0, count: 0 });
      const g = grouped.get(key);
      const sz = parseFloat(t.size || 0);
      const pr = parseFloat(t.price || 0);
      g.totalShares += sz;
      g.totalCost += sz * pr;
      g.count++;
    }
    [...grouped.values()].slice(0, 15).forEach(g => {
      const avg = g.totalShares > 0 ? (g.totalCost / g.totalShares * 100).toFixed(0) : '?';
      lines.push(
        `  ${g.side} ${g.totalShares.toFixed(0)} shares  "${g.title}" [${g.outcome}]  avg ${avg}¢` +
        (g.count > 1 ? ` (${g.count} orders)` : '')
      );
    });
  } else {
    lines.push('\nNo trades in the last 24h.');
  }

  return lines.join('\n');
}

module.exports = { fetchMovers, fetchTrades, formatActivityForPrompt, getWallets };

"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = handler;
exports.maxDuration = void 0;
// =============================================================================
// /api/prices.js
// GET /api/prices?ids=bitcoin,ethereum,solana
// GET /api/prices?cgPath=/coins/ethereum/contract/0x...
// GET /api/prices?cgPath=/coins/ethena-usde/market_chart&vs_currency=usd&days=7
//
// Server-side proxy for CoinGecko simple/price.
// Keeps the API key off the client and shares the rate-limit budget
// across all users via edge caching (30s fresh, 60s stale).
// Set COINGECKO_API_KEY in your Vercel environment variables (optional
// but recommended — increases rate limit from ~30 to 500 req/min).
// =============================================================================

const maxDuration = exports.maxDuration = 15;
function first(value) {
  return Array.isArray(value) ? value[0] : value;
}
function coingeckoHeaders() {
  const headers = {
    Accept: 'application/json'
  };
  if (process.env.COINGECKO_API_KEY) {
    headers['x-cg-demo-api-key'] = process.env.COINGECKO_API_KEY;
  }
  return headers;
}
function safeCoinGeckoPath(raw) {
  const path = String(raw || '').trim();
  if (!path) return '';
  const normalized = path.startsWith('/') ? path : `/${path}`;
  const allowed = [/^\/simple\/price$/, /^\/search$/, /^\/coins\/markets$/, /^\/coins\/[^/?#]+\/market_chart$/, /^\/coins\/[^/?#]+\/contract\/[^/?#]+$/];
  return allowed.some(re => re.test(normalized)) ? normalized : '';
}
async function fetchCoinGecko(url, timeout = 10000) {
  const r = await fetch(url, {
    headers: coingeckoHeaders(),
    signal: AbortSignal.timeout(timeout)
  });
  const text = await r.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = {
      error: text || 'Invalid CoinGecko response'
    };
  }
  if (!r.ok) {
    return {
      error: data?.status?.error_message || data?.error || `CoinGecko returned HTTP ${r.status}`
    };
  }
  return data;
}
async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const cgPath = safeCoinGeckoPath(first(req.query?.cgPath || req.query?.path));
  try {
    if (cgPath) {
      res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=300');
      const incoming = new URL(req.url || '/', 'https://local');
      incoming.searchParams.delete('cgPath');
      incoming.searchParams.delete('path');
      const query = incoming.searchParams.toString();
      const url = `https://api.coingecko.com/api/v3${cgPath}${query ? `?${query}` : ''}`;
      const data = await fetchCoinGecko(url, 12000);
      return res.status(200).json(data);
    }
    res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');
    const ids = String(first(req.query?.ids) || '').trim();
    if (!ids) {
      return res.status(400).json({
        error: 'Missing ids param'
      });
    }
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`;
    const data = await fetchCoinGecko(url, 8000);
    return res.status(200).json(data);
  } catch (err) {
    console.error('[prices] Error:', err.message);
    return res.status(200).json({
      error: err.message
    });
  }
}
//# sourceMappingURL=prices.js.map
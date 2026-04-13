// =============================================================================
// /api/prices.js
// GET /api/prices?ids=bitcoin,ethereum,solana
//
// Server-side proxy for CoinGecko simple/price.
// Keeps the API key off the client and shares the rate-limit budget
// across all users via edge caching (30s fresh, 60s stale).
// Set COINGECKO_API_KEY in your Vercel environment variables (optional
// but recommended — increases rate limit from ~30 to 500 req/min).
// =============================================================================

export const maxDuration = 15;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');

  const ids = (req.query?.ids || '').trim();
  if (!ids) {
    return res.status(400).json({ error: 'Missing ids param' });
  }

  try {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`;

    const headers = {
      'Accept': 'application/json',
    };
    if (process.env.COINGECKO_API_KEY) {
      headers['x-cg-demo-api-key'] = process.env.COINGECKO_API_KEY;
    }

    const r = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(8000),
    });

    if (!r.ok) {
      return res.status(200).json({ error: `CoinGecko returned HTTP ${r.status}` });
    }

    const data = await r.json();
    return res.status(200).json(data);

  } catch (err) {
    console.error('[prices] Error:', err.message);
    return res.status(200).json({ error: err.message });
  }
}

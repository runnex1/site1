"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = handler;
// Vercel serverless function: proxy Yahoo Finance chart API server-side.
// Races query1 and query2 endpoints simultaneously — whichever wins.
// Usage: /api/yahoo?s=GC%3DF   or   /api/yahoo?s=%5EGSPC
// Optional: &range=1mo&interval=1d for historical chart data.
async function handler(req, res) {
  const symbol = req.query.s;
  if (!symbol) {
    return res.status(400).json({
      error: 'Missing symbol parameter ?s='
    });
  }
  const allowedRanges = new Set(['1d', '5d', '7d', '1mo', '3mo', '6mo', 'ytd', '1y', '5y', 'max']);
  const allowedIntervals = new Set(['1h', '1d', '1wk', '1mo']);
  const range = allowedRanges.has(String(req.query.range || '').toLowerCase()) ? String(req.query.range).toLowerCase() : '2d';
  const interval = allowedIntervals.has(String(req.query.interval || '').toLowerCase()) ? String(req.query.interval).toLowerCase() : '1d';
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://finance.yahoo.com/',
    'Origin': 'https://finance.yahoo.com'
  };
  const makeUrl = host => `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}`;
  const tryFetch = async host => {
    const response = await fetch(makeUrl(host), {
      headers,
      signal: AbortSignal.timeout(6000)
    });
    if (!response.ok) throw new Error(`${host} returned ${response.status}`);
    const data = await response.json();
    // Validate the response has actual price data
    if (!data?.chart?.result?.[0]?.meta?.regularMarketPrice) {
      throw new Error(`${host} returned no price data`);
    }
    return data;
  };
  try {
    // Race both Yahoo endpoints — first valid response wins
    const data = await Promise.any([tryFetch('query1.finance.yahoo.com'), tryFetch('query2.finance.yahoo.com')]);
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({
      error: err.message
    });
  }
}
//# sourceMappingURL=yahoo.js.map
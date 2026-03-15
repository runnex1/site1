// Vercel serverless function: proxy Yahoo Finance chart API server-side.
// Usage: /api/yahoo?s=GC%3DF   or   /api/yahoo?s=%5EGSPC
// Returns the raw Yahoo Finance JSON response.
export default async function handler(req, res) {
    const symbol = req.query.s;
    if (!symbol) {
        return res.status(400).json({ error: 'Missing symbol parameter ?s=' });
    }

    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2d`;

    try {
        const response = await fetch(url, {
            headers: {
                // Mimic a browser request so Yahoo doesn't block it
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': 'https://finance.yahoo.com/',
                'Origin': 'https://finance.yahoo.com',
            },
            signal: AbortSignal.timeout(8000),
        });

        if (!response.ok) {
            return res.status(response.status).json({ error: `Yahoo returned ${response.status}` });
        }

        const data = await response.json();

        // Cache for 60s on CDN edge — prices don't need to be real-time to the second
        res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
        res.setHeader('Access-Control-Allow-Origin', '*');
        return res.status(200).json(data);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}

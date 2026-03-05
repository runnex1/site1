export default async function handler(req, res) {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'Missing url param' });

    try {
        const r = await fetch(decodeURIComponent(url), {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RSSReader/1.0)' },
            signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) return res.status(r.status).json({ error: 'Upstream error' });
        const text = await r.text();
        res.setHeader('Content-Type', 'application/xml; charset=utf-8');
        res.setHeader('Cache-Control', 's-maxage=300');
        res.status(200).send(text);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
}

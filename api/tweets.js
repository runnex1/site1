// =============================================================================
// /api/tweets.js
// GET /api/tweets?handle=justinsuntron
//
// Fetches the 3 latest tweets via Nitter RSS — no API key required.
// Falls back through multiple public Nitter instances automatically.
// =============================================================================

export const maxDuration = 60;

// Verified working as of April 2026 — source: github.com/zedeus/nitter/wiki/Instances
const NITTER_INSTANCES = [
  'https://xcancel.com',
  'https://nitter.poast.org',
  'https://nitter.privacyredirect.com',
  'https://nitter.tiekoetter.com',
  'https://nitter.catsarch.com',
  'https://nuku.trabun.org',
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=300');

  const handle = (req.query?.handle || '')
    .trim()
    .replace(/^@/, '')
    .replace(/[^a-zA-Z0-9_]/g, '');

  if (!handle) {
    return res.status(400).json({ error: 'Missing or invalid handle param' });
  }

  for (const base of NITTER_INSTANCES) {
    try {
      const rssUrl = `${base}/${handle}/rss`;
      console.log(`[tweets] Trying ${rssUrl}`);

      const r = await fetch(rssUrl, {
        signal: AbortSignal.timeout(8000),
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });

      if (!r.ok) {
        console.warn(`[tweets] ${base} responded ${r.status}, trying next`);
        continue;
      }

      const xml = await r.text();
      const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];

      if (!items.length) {
        console.warn(`[tweets] ${base} returned no items, trying next`);
        continue;
      }

      const tweets = items.slice(0, 3).map(m => {
        const block = m[1];

        // Title: try CDATA first, fall back to plain text
        const titleCdata = (block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) || [])[1];
        const titlePlain = (block.match(/<title>([\s\S]*?)<\/title>/)                  || [])[1];
        const text = (titleCdata || titlePlain || '').replace(/\s+/g, ' ').trim();

        // URL: Nitter puts the tweet permalink in <guid>, not <link>
        const guid    = (block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/) || [])[1] || '';
        const pubDate = (block.match(/<pubDate>(.*?)<\/pubDate>/)      || [])[1] || '';

        const url  = guid.trim().replace(/^https?:\/\/[^/]+/, 'https://x.com');
        const date = pubDate
          ? new Date(pubDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
          : '';

        return { text, url, date };
      });

      console.log(`[tweets] Success via ${base} — ${tweets.length} tweet(s) for @${handle}`);
      return res.status(200).json({ handle, tweets });

    } catch (e) {
      console.warn(`[tweets] ${base} failed: ${e.message}`);
    }
  }

  return res.status(200).json({
    handle,
    tweets: [],
    error: 'All Nitter instances failed. Try updating the NITTER_INSTANCES list.',
  });
}

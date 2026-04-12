// Vercel serverless function: fetch latest tweets for a given X handle
// GET /api/tweets?handle=KobeissiLetter
// Returns { handle, tweets: [{ text, url, date }] }
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'private, max-age=120'); // 2-min browser cache

    const handle = (req.query?.handle || '')
        .trim()
        .replace(/^@/, '')
        .replace(/[^a-zA-Z0-9_]/g, '');

    if (!handle) {
        return res.status(400).json({ error: 'Missing handle param' });
    }

    // ── Strategy 1: syndication.twitter.com iframe HTML ────────────────────
    // This is the actual page X loads inside embedded timeline iframes.
    // It contains rendered tweet HTML with full text, no JS required.
    async function fetchViaSyndication() {
        const url = `https://syndication.twitter.com/srv/timeline-profile/screen-name/${handle}?suppressResponseCodes=true&pc=false&lang=en`;
        const r = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': 'https://platform.twitter.com/',
            },
            signal: AbortSignal.timeout(10000),
        });
        if (!r.ok) throw new Error(`syndication HTTP ${r.status}`);
        const html = await r.text();

        // Tweet text lives in <p> tags with class containing "tweet-text"
        // and links are in data-tweet-id attributes
        const tweets = [];

        // Extract JSON from the __NEXT_DATA__ / window.__INITIAL_STATE__ blob if present
        const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
        if (nextDataMatch) {
            try {
                const nextData = JSON.parse(nextDataMatch[1]);
                // Navigate the Next.js page props to find tweets
                const timeline = nextData?.props?.pageProps?.timeline;
                const entries = timeline?.entries || timeline?.items || [];
                for (const entry of entries) {
                    const tweet = entry?.content?.tweet || entry?.tweet || entry;
                    const text = tweet?.full_text || tweet?.text;
                    const id   = tweet?.id_str || tweet?.id;
                    const created = tweet?.created_at;
                    if (text && id) {
                        tweets.push({
                            text: text.replace(/https:\/\/t\.co\/\S+/g, '').trim(),
                            url: `https://x.com/${handle}/status/${id}`,
                            date: created ? new Date(created).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '',
                        });
                        if (tweets.length >= 3) break;
                    }
                }
                if (tweets.length) return tweets;
            } catch(e) { /* fall through to regex */ }
        }

        // Fallback: regex scrape tweet text blocks from rendered HTML
        // Syndication page wraps tweet text in <div data-testid="tweetText"> or similar
        const tweetBlocks = [...html.matchAll(/data-testid="tweetText"[^>]*>([\s\S]*?)<\/div>/gi)];
        const idMatches   = [...html.matchAll(/\/status\/(\d+)/g)];
        const dateMatches = [...html.matchAll(/datetime="([^"]+)"/g)];

        for (let i = 0; i < Math.min(tweetBlocks.length, 3); i++) {
            // Strip inner HTML tags to get plain text
            const raw = tweetBlocks[i][1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            const id  = idMatches[i]?.[1] || '';
            const dt  = dateMatches[i]?.[1] || '';
            if (raw) {
                tweets.push({
                    text: raw,
                    url: id ? `https://x.com/${handle}/status/${id}` : `https://x.com/${handle}`,
                    date: dt ? new Date(dt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '',
                });
            }
        }
        return tweets;
    }

    // ── Strategy 2: Nitter RSS (fallback) ──────────────────────────────────
    async function fetchViaNitter() {
        const instances = [
            'https://nitter.net',
            'https://nitter.privacydev.net',
            'https://nitter.poast.org',
        ];
        for (const base of instances) {
            try {
                const r = await fetch(`${base}/${handle}/rss`, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VaultBot/1.0)' },
                    signal: AbortSignal.timeout(8000),
                });
                if (!r.ok) continue;
                const xml = await r.text();
                const tweets = [];
                const itemRe = /<item>([\s\S]*?)<\/item>/gi;
                let m;
                while ((m = itemRe.exec(xml)) !== null && tweets.length < 3) {
                    const block = m[1];
                    const tag = n => {
                        const t = block.match(new RegExp(`<${n}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${n}>`, 'i'))
                               || block.match(new RegExp(`<${n}[^>]*>([^<]*)<\\/${n}>`, 'i'));
                        return t ? t[1].trim() : '';
                    };
                    // Nitter puts full tweet text in <description>, title is often truncated
                    const desc = tag('description').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                    const title = tag('title');
                    let link = tag('link') || tag('guid');
                    if (link) link = link.replace(/^https?:\/\/nitter\.[^/]+\//, 'https://x.com/');
                    const pubDate = tag('pubDate');
                    const date = pubDate ? new Date(pubDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
                    const text = desc.length > 20 ? desc : title;
                    if (text && link) tweets.push({ text, url: link, date });
                }
                if (tweets.length) return tweets;
            } catch(e) { /* try next */ }
        }
        return [];
    }

    // ── Try both strategies ─────────────────────────────────────────────────
    let tweets = [];
    try {
        tweets = await fetchViaSyndication();
    } catch(e) {
        console.warn('[tweets] syndication failed:', e.message);
    }
    if (!tweets.length) {
        try {
            tweets = await fetchViaNitter();
        } catch(e) {
            console.warn('[tweets] nitter failed:', e.message);
        }
    }

    if (!tweets.length) {
        return res.status(200).json({ handle, tweets: [], error: 'Could not fetch tweets from any source' });
    }

    return res.status(200).json({ handle, tweets });
}

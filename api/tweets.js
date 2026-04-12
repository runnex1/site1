// Vercel serverless function: fetch latest tweets for a given X handle
// GET /api/tweets?handle=KobeissiLetter
// Returns { handle, tweets: [{ text, url, date }] }
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'private, max-age=120');

    const handle = (req.query?.handle || '')
        .trim()
        .replace(/^@/, '')
        .replace(/[^a-zA-Z0-9_]/g, '');

    if (!handle) {
        return res.status(400).json({ error: 'Missing handle param' });
    }

    // ── Strategy 1: syndication.twitter.com ────────────────────────────────
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

        // ── Path A: parse __NEXT_DATA__ JSON blob ───────────────────────────
        const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
        if (nextDataMatch) {
            try {
                const nextData = JSON.parse(nextDataMatch[1]);
                const timeline = nextData?.props?.pageProps?.timeline;
                const entries  = timeline?.entries || timeline?.items || [];

                const all = [];
                for (const entry of entries) {
                    const tweet = entry?.content?.tweet || entry?.tweet || entry;
                    const text  = tweet?.full_text || tweet?.text;
                    const id    = tweet?.id_str || tweet?.id;
                    const created = tweet?.created_at;
                    if (text && id) {
                        all.push({
                            id:   BigInt(id),          // use BigInt for safe 64-bit compare
                            text: text.replace(/https:\/\/t\.co\/\S+/g, '').trim(),
                            url:  `https://x.com/${handle}/status/${id}`,
                            date: created ? new Date(created).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '',
                        });
                    }
                }

                if (all.length) {
                    // Sort newest-first by tweet ID (higher = newer)
                    all.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
                    return all.slice(0, 3).map(({ id, ...rest }) => rest);
                }
            } catch(e) { /* fall through to regex path */ }
        }

        // ── Path B: regex scrape — pair each tweetText block with its own status ID ──
        // Strategy: find every tweet container by locating status URLs that appear
        // *immediately before* a tweetText block in document order.
        //
        // We walk the HTML once, collecting (statusId, datetime, textBlock) triples
        // by scanning for the three markers in order.
        const all = [];
        // Match all status IDs with their position in the string
        const statusRe  = /href="https:\/\/twitter\.com\/[^/]+\/status\/(\d+)/g;
        const datetimeRe = /datetime="([^"]+)"/g;
        const textRe    = /data-testid="tweetText"[^>]*>([\s\S]*?)<\/div>/gi;

        const statusHits  = [...html.matchAll(statusRe)].map(m => ({ id: m[1], pos: m.index }));
        const datetimeHits = [...html.matchAll(datetimeRe)].map(m => ({ dt: m[1], pos: m.index }));
        const textHits    = [...html.matchAll(textRe)].map(m => ({
            text: m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
            pos: m.index,
        }));

        for (const textHit of textHits) {
            // Find the nearest status ID that appears before this text block
            const nearestId = statusHits
                .filter(s => s.pos < textHit.pos)
                .at(-1);
            // Find the nearest datetime that appears before this text block
            const nearestDt = datetimeHits
                .filter(d => d.pos < textHit.pos)
                .at(-1);

            if (textHit.text && nearestId) {
                all.push({
                    id:   BigInt(nearestId.id),
                    text: textHit.text,
                    url:  `https://x.com/${handle}/status/${nearestId.id}`,
                    date: nearestDt?.dt
                        ? new Date(nearestDt.dt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                        : '',
                });
            }
        }

        if (!all.length) throw new Error('No tweets parsed from syndication HTML');

        // Sort newest-first and dedupe by ID
        const seen = new Set();
        const deduped = all.filter(t => {
            const k = t.id.toString();
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
        });
        deduped.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
        return deduped.slice(0, 3).map(({ id, ...rest }) => rest);
    }

    // ── Strategy 2: Nitter RSS fallback ────────────────────────────────────
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

                const all = [];
                const itemRe = /<item>([\s\S]*?)<\/item>/gi;
                let m;
                while ((m = itemRe.exec(xml)) !== null) {
                    const block = m[1];
                    const tag = n => {
                        const t = block.match(new RegExp(`<${n}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${n}>`, 'i'))
                               || block.match(new RegExp(`<${n}[^>]*>([^<]*)<\\/${n}>`, 'i'));
                        return t ? t[1].trim() : '';
                    };
                    const desc    = tag('description').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                    const title   = tag('title');
                    let link      = tag('link') || tag('guid');
                    if (link) link = link.replace(/^https?:\/\/nitter\.[^/]+\//, 'https://x.com/');
                    const pubDate = tag('pubDate');
                    const date    = pubDate ? new Date(pubDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
                    // Extract tweet ID from link for sorting
                    const idMatch = link?.match(/\/status\/(\d+)/);
                    const id      = idMatch ? BigInt(idMatch[1]) : 0n;
                    const text    = desc.length > 20 ? desc : title;
                    if (text && link) all.push({ id, text, url: link, date });
                }

                if (all.length) {
                    all.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
                    return all.slice(0, 3).map(({ id, ...rest }) => rest);
                }
            } catch(e) { /* try next instance */ }
        }
        return [];
    }

    // ── Try strategies in order ─────────────────────────────────────────────
    let tweets = [];
    try   { tweets = await fetchViaSyndication(); }
    catch (e) { console.warn('[tweets] syndication failed:', e.message); }

    if (!tweets.length) {
        try   { tweets = await fetchViaNitter(); }
        catch (e) { console.warn('[tweets] nitter failed:', e.message); }
    }

    if (!tweets.length) {
        return res.status(200).json({ handle, tweets: [], error: 'Could not fetch tweets from any source' });
    }

    return res.status(200).json({ handle, tweets });
}

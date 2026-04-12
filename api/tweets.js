// Vercel serverless function: fetch latest 3 tweets for a given X handle
// GET /api/tweets?handle=KobeissiLetter
//
// Strategy (priority order):
//   1. Nitter RSS  — accurate structured feed, no API key, free
//   2. Groq fallback — AI web search if all Nitter instances fail
//
// Setup: set GROQ_API_KEY in your Vercel environment variables (never hardcode keys)

export const maxDuration = 30;

// ── Nitter public instances (ranked by reliability) ──────────────────────────
const NITTER_INSTANCES = [
    'https://nitter.privacydev.net',
    'https://nitter.poast.org',
    'https://nitter.net',
    'https://nitter.1d4.us',
    'https://nitter.kavin.rocks',
];

// ── Try fetching RSS from a single Nitter instance ───────────────────────────
async function tryNitterRSS(handle, baseUrl) {
    const url = `${baseUrl}/${handle}/rss`;
    const res = await fetch(url, {
        signal: AbortSignal.timeout(7000),
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RSSBot/1.0)' },
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const xml = await res.text();

    // Detect Nitter error pages (they return 200 but with HTML or error XML)
    if (xml.includes('<title>Error</title>') || xml.includes('instance is down') || !xml.includes('<item>')) {
        throw new Error('Nitter instance returned no items');
    }

    // Parse items manually (no DOMParser in Node)
    const items = [];
    const itemRx = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRx.exec(xml)) !== null && items.length < 3) {
        const block  = match[1];
        const title  = decodeEntities(extractTag(block, 'title'));
        const link   = extractTag(block, 'link') || extractTag(block, 'guid');
        const pubDate = extractTag(block, 'pubDate');

        if (!title || !link) continue;

        // Rewrite Nitter links → real X links
        const tweetUrl = link.replace(/^https?:\/\/nitter\.[^/]+\//, 'https://x.com/');
        const date     = pubDate ? formatDate(new Date(pubDate)) : '';

        items.push({ text: title, url: tweetUrl, date });
    }

    if (!items.length) throw new Error('No parseable items in RSS');
    return items;
}

// ── Groq fallback (AI web search) ────────────────────────────────────────────
async function tryGroq(handle) {
    const GROQ_KEY = process.env.GROQ_API_KEY;
    if (!GROQ_KEY) throw new Error('GROQ_API_KEY env var not set');

    const prompt = `Search x.com/twitter.com for the 3 most recent posts by @${handle}.

Reply with ONLY a raw JSON array, no markdown, no explanation:
[{"text":"full post text","url":"https://x.com/${handle}/status/ID_IF_KNOWN","date":"Apr 12"},...]

Rules: newest first. Real tweet IDs in URLs if found. Return [] if nothing found.`;

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${GROQ_KEY}`,
        },
        signal: AbortSignal.timeout(25000),
        body: JSON.stringify({
            model: 'compound-beta-mini',
            max_tokens: 1024,
            temperature: 0.1,
            messages: [{ role: 'user', content: prompt }],
        }),
    });

    if (!groqRes.ok) {
        const err = await groqRes.json().catch(() => ({}));
        throw new Error(err?.error?.message || `Groq HTTP ${groqRes.status}`);
    }

    const groqData = await groqRes.json();
    const raw      = groqData.choices?.[0]?.message?.content || '';
    const clean    = raw.replace(/```json|```/g, '').trim();
    const start    = clean.indexOf('[');
    const end      = clean.lastIndexOf(']');

    if (start === -1) throw new Error('No JSON array in Groq response');

    const tweets = JSON.parse(clean.slice(start, end + 1));
    if (!Array.isArray(tweets)) throw new Error('Groq response is not an array');

    return tweets.slice(0, 3);
}

// ── Main handler ─────────────────────────────────────────────────────────────
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

    const errors = [];

    // ── 1. Try each Nitter instance in turn ──────────────────────────────────
    for (const instance of NITTER_INSTANCES) {
        try {
            const tweets = await tryNitterRSS(handle, instance);
            return res.status(200).json({ handle, tweets, source: 'nitter' });
        } catch (err) {
            errors.push(`${instance}: ${err.message}`);
        }
    }

    // ── 2. All Nitter instances failed — try Groq ─────────────────────────────
    try {
        const tweets = await tryGroq(handle);
        return res.status(200).json({ handle, tweets, source: 'groq' });
    } catch (err) {
        errors.push(`groq: ${err.message}`);
    }

    // ── 3. Everything failed ──────────────────────────────────────────────────
    console.error(`[tweets] All sources failed for @${handle}:`, errors);
    return res.status(200).json({ handle, tweets: [], error: 'All sources failed', details: errors });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function extractTag(xml, tag) {
    // Handles both plain and CDATA content
    const re = new RegExp(`<${tag}(?:[^>]*)>(?:<!\\[CDATA\\[)?(.*?)(?:\\]\\]>)?</${tag}>`, 's');
    return (xml.match(re)?.[1] || '').trim();
}

function decodeEntities(str) {
    return str
        .replace(/&amp;/g,  '&')
        .replace(/&lt;/g,   '<')
        .replace(/&gt;/g,   '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g,  "'")
        .replace(/&apos;/g, "'");
}

function formatDate(d) {
    if (isNaN(d)) return '';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

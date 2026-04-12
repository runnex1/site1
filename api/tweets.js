// Vercel serverless function: fetch latest 3 tweets for a given X handle
// GET /api/tweets?handle=KobeissiLetter
//
// Source priority:
//   1. Twitter Syndication API  — powers X's own embed widgets, no auth needed
//   2. Groq compound-beta       — stronger web search than mini, as last resort
//
// Required env var (Vercel dashboard → Settings → Environment Variables):
//   GROQ_API_KEY = gsk_...

export const maxDuration = 30;

// ─── 1. Twitter Syndication API ───────────────────────────────────────────────
// X uses this endpoint to power its own "Embedded Timeline" widgets on third-party
// sites. It's server-side fetched here to avoid browser CORS restrictions.
async function trySyndication(handle) {
    const url = `https://syndication.twitter.com/srv/timeline-profile/screen-name/${handle}`;

    const res = await fetch(url, {
        signal: AbortSignal.timeout(10000),
        headers: {
            // Mimic a browser — X rejects obvious bot User-Agents
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
        },
    });

    if (!res.ok) throw new Error(`Syndication HTTP ${res.status}`);

    const html = await res.text();

    // The page is a Next.js SSR app — all data lives in __NEXT_DATA__
    const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (!match) throw new Error('__NEXT_DATA__ not found in syndication response');

    const nextData = JSON.parse(match[1]);

    // Navigate the nested structure to the timeline entries
    const entries =
        nextData?.props?.pageProps?.timeline?.entries ||
        nextData?.props?.pageProps?.tweets ||          // alternate key seen in some responses
        [];

    if (!entries.length) throw new Error('No entries in syndication timeline');

    const tweets = [];

    for (const entry of entries) {
        if (tweets.length >= 3) break;

        // Each entry wraps a tweet object at slightly different depths depending on type
        const tweet =
            entry?.content?.tweet ||
            entry?.content?.itemContent?.tweet_results?.result?.legacy ||
            entry?.tweet ||
            null;

        if (!tweet) continue;

        // Skip retweets — remove this block if you want RTs included
        if (tweet.retweeted_status || tweet.full_text?.startsWith('RT @')) continue;

        const id   = tweet.id_str   || tweet.id;
        const text = tweet.full_text || tweet.text || '';
        const raw  = tweet.created_at;
        const date = raw ? formatDate(new Date(raw)) : '';

        if (!text || !id) continue;

        tweets.push({
            text: cleanTweetText(text),
            url:  `https://x.com/${handle}/status/${id}`,
            date,
        });
    }

    if (!tweets.length) throw new Error('Syndication returned entries but none were parseable');
    return tweets;
}

// ─── 2. Groq compound-beta fallback ──────────────────────────────────────────
// compound-beta has stronger real-time web search than compound-beta-mini.
async function tryGroq(handle) {
    const GROQ_KEY = process.env.GROQ_API_KEY;
    if (!GROQ_KEY) throw new Error('GROQ_API_KEY env var not set');

    const prompt = `Search x.com for the 3 most recent posts (not retweets) by the Twitter/X account @${handle}.

Return ONLY a raw JSON array — no markdown fences, no explanation, no preamble:
[{"text":"full post text here","url":"https://x.com/${handle}/status/TWEET_ID","date":"Apr 13"},...]

Rules:
- Newest post first
- Include the real numeric tweet ID in the URL when you can find it
- Skip retweets (text starting with "RT @")
- Return [] if the account is private or no posts are found`;

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${GROQ_KEY}`,
        },
        signal: AbortSignal.timeout(25000),
        body: JSON.stringify({
            model: 'compound-beta',   // stronger than compound-beta-mini
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
    if (!Array.isArray(tweets)) throw new Error('Groq did not return an array');
    if (!tweets.length)         throw new Error('Groq returned empty array');

    return tweets.slice(0, 3);
}

// ─── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    // Edge-cache for 2 min; serve stale for up to 5 min while revalidating
    res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=300');

    const handle = (req.query?.handle || '')
        .trim()
        .replace(/^@/, '')
        .replace(/[^a-zA-Z0-9_]/g, '');

    if (!handle) {
        return res.status(400).json({ error: 'Missing or invalid handle param' });
    }

    const errors = [];

    // ── Try 1: Syndication API ────────────────────────────────────────────────
    try {
        const tweets = await trySyndication(handle);
        return res.status(200).json({ handle, tweets, source: 'syndication' });
    } catch (err) {
        errors.push(`syndication: ${err.message}`);
        console.warn(`[tweets] Syndication failed for @${handle}:`, err.message);
    }

    // ── Try 2: Groq compound-beta ─────────────────────────────────────────────
    try {
        const tweets = await tryGroq(handle);
        return res.status(200).json({ handle, tweets, source: 'groq' });
    } catch (err) {
        errors.push(`groq: ${err.message}`);
        console.warn(`[tweets] Groq failed for @${handle}:`, err.message);
    }

    // ── All sources failed ────────────────────────────────────────────────────
    return res.status(200).json({
        handle,
        tweets: [],
        error: `All sources failed for @${handle}`,
        details: errors,
    });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function cleanTweetText(text) {
    return text
        .replace(/https?:\/\/t\.co\/\S+/g, '')  // strip t.co tracking URLs
        .replace(/\s+/g, ' ')
        .trim();
}

function formatDate(d) {
    if (!d || isNaN(d)) return '';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

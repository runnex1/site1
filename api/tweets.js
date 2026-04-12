// Vercel serverless function: fetch latest 3 tweets for a given X handle
// GET /api/tweets?handle=KobeissiLetter
//
// Required env vars → Vercel Dashboard → Settings → Environment Variables:
//   TAVILY_API_KEY   get free key at https://tavily.com (1,000 searches/month free)
//   GROQ_API_KEY     get free key at https://console.groq.com (fallback only)

export const maxDuration = 30;

// ─── 1. Tavily Search API ─────────────────────────────────────────────────────
// Tavily is a search API built for AI apps. Free tier = 1,000 searches/month.
// We search for recent posts from the handle on x.com and parse the results.
async function tryTavily(handle) {
    const key = process.env.TAVILY_API_KEY;
    if (!key) throw new Error('TAVILY_API_KEY env var not set — get a free key at tavily.com');

    const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({
            api_key: key,
            query: `from:${handle} site:x.com`,
            search_depth: 'basic',
            include_domains: ['x.com', 'twitter.com'],
            max_results: 5,
            include_answer: false,
        }),
    });

    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.message || `Tavily HTTP ${res.status}`);
    }

    const data = await res.json();
    const results = data?.results;
    if (!results?.length) throw new Error('Tavily returned no results for this handle');

    // Tavily results have: title, url, content (snippet), published_date
    const tweets = results
        .filter(r => {
            const url = r.url || '';
            // Only keep direct tweet/status URLs from this handle
            return url.includes(`x.com/${handle}/status/`) ||
                   url.includes(`twitter.com/${handle}/status/`);
        })
        .slice(0, 3)
        .map(r => ({
            text: cleanText(r.content || r.title || ''),
            url:  r.url.replace('twitter.com', 'x.com'),
            date: r.published_date ? formatDate(new Date(r.published_date)) : '',
        }));

    if (!tweets.length) throw new Error('Tavily results found but none matched tweet URL pattern');
    return tweets;
}

// ─── 2. Groq compound-beta fallback ──────────────────────────────────────────
async function tryGroq(handle) {
    const key = process.env.GROQ_API_KEY;
    if (!key) throw new Error('GROQ_API_KEY env var not set');

    const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

    const prompt = `Today is ${today}. Search x.com right now for the 3 most recent original posts by @${handle} (exclude retweets and replies).

Return ONLY a raw JSON array — no markdown, no explanation, nothing else:
[{"text":"full post text","url":"https://x.com/${handle}/status/TWEET_ID","date":"Apr 13"},...]

- Newest first
- Use real numeric tweet IDs in URLs if you can find them
- Return [] if nothing found`;

    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        signal: AbortSignal.timeout(25000),
        body: JSON.stringify({
            model: 'compound-beta',
            max_tokens: 1024,
            temperature: 0,
            messages: [{ role: 'user', content: prompt }],
        }),
    });

    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error?.message || `Groq HTTP ${res.status}`);
    }

    const data   = await res.json();
    const raw    = data.choices?.[0]?.message?.content || '';
    const clean  = raw.replace(/```json|```/g, '').trim();
    const start  = clean.indexOf('[');
    const end    = clean.lastIndexOf(']');
    if (start === -1) throw new Error('No JSON array in Groq response');

    const tweets = JSON.parse(clean.slice(start, end + 1));
    if (!Array.isArray(tweets) || !tweets.length) throw new Error('Groq returned no results');
    return tweets.slice(0, 3);
}

// ─── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, s-maxage=120, stale-while-revalidate=300');

    const handle = (req.query?.handle || '')
        .trim().replace(/^@/, '').replace(/[^a-zA-Z0-9_]/g, '');

    if (!handle) return res.status(400).json({ error: 'Missing or invalid handle param' });

    const errors = [];

    // ── 1. Tavily ─────────────────────────────────────────────────────────────
    try {
        const tweets = await tryTavily(handle);
        return res.status(200).json({ handle, tweets, source: 'tavily' });
    } catch (err) {
        errors.push(`tavily: ${err.message}`);
        console.warn(`[tweets] Tavily failed for @${handle}:`, err.message);
    }

    // ── 2. Groq ───────────────────────────────────────────────────────────────
    try {
        const tweets = await tryGroq(handle);
        return res.status(200).json({ handle, tweets, source: 'groq' });
    } catch (err) {
        errors.push(`groq: ${err.message}`);
        console.warn(`[tweets] Groq failed for @${handle}:`, err.message);
    }

    return res.status(200).json({ handle, tweets: [], error: 'All sources failed', details: errors });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function cleanText(text) {
    return text
        .replace(/https?:\/\/t\.co\/\S+/g, '')   // strip t.co tracking links
        .replace(/https?:\/\/\S+/g, '')            // strip any remaining URLs from snippets
        .replace(/\s+/g, ' ')
        .trim();
}

function formatDate(d) {
    if (!d || isNaN(d)) return '';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

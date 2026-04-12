// =============================================================================
// /api/tweets.js  →  place this file in the `api/` folder of your Vercel project
// GET /api/tweets?handle=justinsuntron
// =============================================================================
// Works out of the box with no env var setup required.
// Optionally set GROQ_API_KEY in Vercel env vars to use your own key instead.
// =============================================================================

export const maxDuration = 60;

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

    // Use env var if set, otherwise fall back to the key already in your project
    const GROQ_KEY = process.env.GROQ_API_KEY || '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';

    // compound-beta has real-time web search built in — much stronger than compound-beta-mini
    const prompt = `Use your web search tool to find the 3 most recent posts on X (Twitter) by @${handle}.

Search for: site:x.com/${handle} OR twitter.com/${handle}

Return ONLY a raw JSON array with no markdown, no explanation, nothing else before or after:
[{"text":"the full post text here","url":"https://x.com/${handle}/status/NUMERIC_ID","date":"Apr 13"},...]

Rules:
- Newest post first
- Do NOT include retweets (skip anything starting with "RT @")
- Put the real numeric tweet status ID in each URL
- If you genuinely cannot find any posts, return exactly: []`;

    try {
        const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${GROQ_KEY}`,
            },
            signal: AbortSignal.timeout(55000),
            body: JSON.stringify({
                model: 'compound-beta',      // full compound-beta, not mini — has stronger search
                max_tokens: 1024,
                temperature: 0,
                messages: [{ role: 'user', content: prompt }],
            }),
        });

        if (!groqRes.ok) {
            const err = await groqRes.json().catch(() => ({}));
            const msg = err?.error?.message || `Groq HTTP ${groqRes.status}`;
            console.error(`[tweets] Groq error for @${handle}:`, msg);
            return res.status(200).json({ handle, tweets: [], error: msg });
        }

        const groqData = await groqRes.json();
        const raw      = groqData.choices?.[0]?.message?.content || '';

        // Strip any accidental markdown fences and find the JSON array
        const clean = raw.replace(/```json|```/gi, '').trim();
        const start = clean.indexOf('[');
        const end   = clean.lastIndexOf(']');

        if (start === -1 || end === -1) {
            console.error(`[tweets] No JSON array in Groq response for @${handle}:`, raw);
            return res.status(200).json({ handle, tweets: [], error: 'Groq returned no JSON array', raw });
        }

        const tweets = JSON.parse(clean.slice(start, end + 1));

        if (!Array.isArray(tweets)) {
            return res.status(200).json({ handle, tweets: [], error: 'Groq response was not an array' });
        }

        // Strip t.co tracking URLs from tweet text
        const cleaned = tweets.slice(0, 3).map(t => ({
            ...t,
            text: (t.text || '').replace(/https?:\/\/t\.co\/\S+/g, '').replace(/\s+/g, ' ').trim(),
        }));

        return res.status(200).json({ handle, tweets: cleaned });

    } catch (err) {
        console.error(`[tweets] Unhandled error for @${handle}:`, err.message);
        return res.status(200).json({ handle, tweets: [], error: err.message });
    }
}

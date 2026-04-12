// =============================================================================
// /api/tweets.js
// GET /api/tweets?handle=justinsuntron
//
// Two-step approach:
//   Step 1 — compound-beta-mini searches x.com and returns raw text
//   Step 2 — llama-3.3-70b-versatile structures that text into clean JSON
//
// Requires: GROQ_API_KEY in Vercel Environment Variables
// =============================================================================

export const maxDuration = 60;

const GROQ_BASE = 'https://api.groq.com/openai/v1/chat/completions';

async function groq(apiKey, model, prompt, timeoutMs = 30000) {
    const res = await fetch(GROQ_BASE, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({
            model,
            max_tokens: 1024,
            temperature: 0,
            messages: [{ role: 'user', content: prompt }],
        }),
    });

    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error?.message || `Groq HTTP ${res.status}`);
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || '';
}

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

    const GROQ_KEY = process.env.GROQ_API_KEY;
    if (!GROQ_KEY) {
        return res.status(200).json({ handle, tweets: [], error: 'GROQ_API_KEY env var not set' });
    }

    try {
        // ── Step 1: Search ────────────────────────────────────────────────────
        // compound-beta-mini has built-in web search. We ask it to simply find
        // and describe recent posts — no JSON formatting pressure, just retrieval.
        const searchResult = await groq(
            GROQ_KEY,
            'compound-beta-mini',
            `Search the web and visit x.com/${handle} to find their 3 most recent posts.

For each post you find, write it out like this:
TEXT: <the full post text>
URL: <the full x.com URL including the status ID>
DATE: <the post date like "Apr 13">
---

Do not skip any post. Do not summarise. Write the full text of each post exactly as it appears.
If you cannot find any posts, write: NO POSTS FOUND`,
            55000
        );

        console.log(`[tweets] Step 1 raw result for @${handle}:`, searchResult.slice(0, 500));

        if (!searchResult || searchResult.includes('NO POSTS FOUND') || searchResult.trim() === '') {
            return res.status(200).json({ handle, tweets: [], error: 'No posts found by search step' });
        }

        // ── Step 2: Structure ─────────────────────────────────────────────────
        // A fast llama model parses the raw text into clean JSON.
        // No web search needed here — pure text transformation.
        const jsonResult = await groq(
            GROQ_KEY,
            'llama-3.3-70b-versatile',
            `Convert the following tweet listing into a JSON array.

Return ONLY the raw JSON array — no markdown fences, no explanation, nothing else:
[{"text":"full post text","url":"https://x.com/${handle}/status/NUMERIC_ID","date":"Apr 13"},...]

Rules:
- Maximum 3 items, newest first
- Use the exact tweet text provided — do not paraphrase
- If a URL contains a real numeric status ID, keep it exactly as-is
- Strip any t.co tracking URLs from the text field
- If date is missing, use ""

Tweet listing to convert:
${searchResult}`,
            15000
        );

        console.log(`[tweets] Step 2 JSON for @${handle}:`, jsonResult.slice(0, 500));

        const clean = jsonResult.replace(/```json|```/gi, '').trim();
        const start = clean.indexOf('[');
        const end   = clean.lastIndexOf(']');

        if (start === -1 || end === -1) {
            return res.status(200).json({
                handle, tweets: [], error: 'JSON formatting step failed', raw: jsonResult.slice(0, 300)
            });
        }

        const tweets = JSON.parse(clean.slice(start, end + 1));

        if (!Array.isArray(tweets) || tweets.length === 0) {
            return res.status(200).json({ handle, tweets: [], error: 'Empty array after formatting' });
        }

        const cleaned = tweets.slice(0, 3).map(t => ({
            text: (t.text || '').replace(/https?:\/\/t\.co\/\S+/g, '').replace(/\s+/g, ' ').trim(),
            url:  t.url  || `https://x.com/${handle}`,
            date: t.date || '',
        }));

        return res.status(200).json({ handle, tweets: cleaned });

    } catch (err) {
        console.error(`[tweets] Error for @${handle}:`, err.message);
        return res.status(200).json({ handle, tweets: [], error: err.message });
    }
}

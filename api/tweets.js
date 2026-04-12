// Vercel serverless function: fetch latest 3 tweets for a given X handle
// GET /api/tweets?handle=KobeissiLetter
// Uses Groq compound-beta-mini (built-in web search) — no X API key needed
export const maxDuration = 60;

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

    const GROQ_KEY = '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';

    const prompt = `Search x.com/twitter.com for the 3 most recent posts by @${handle}.

Reply with ONLY a raw JSON array, no markdown, no explanation:
[{"text":"full post text","url":"https://x.com/${handle}/status/ID_IF_KNOWN","date":"Apr 12"},...]

Rules: newest first. Real tweet IDs in URLs if found. Return [] if nothing found.`;

    try {
        const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${GROQ_KEY}`,
            },
            signal: AbortSignal.timeout(55000),
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
        const raw   = groqData.choices?.[0]?.message?.content || '';
        const clean = raw.replace(/```json|```/g, '').trim();
        const start = clean.indexOf('[');
        const end   = clean.lastIndexOf(']');

        if (start === -1) throw new Error('No JSON array in response');

        const tweets = JSON.parse(clean.slice(start, end + 1));
        if (!Array.isArray(tweets)) throw new Error('Not an array');

        return res.status(200).json({ handle, tweets: tweets.slice(0, 3) });

    } catch (err) {
        return res.status(200).json({ handle, tweets: [], error: err.message });
    }
}

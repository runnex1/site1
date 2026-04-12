// Vercel serverless function: fetch latest 3 tweets for a given X handle
// GET /api/tweets?handle=KobeissiLetter
// Uses Groq with web search to retrieve real recent tweets — no X API key needed
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

    const prompt = `Search for the 3 most recent tweets posted by @${handle} on X (Twitter).

Return ONLY a raw JSON array with exactly this shape — no markdown, no explanation, nothing else:
[
  { "text": "full tweet text here", "url": "https://x.com/${handle}/status/TWEET_ID", "date": "Apr 12" },
  { "text": "...", "url": "...", "date": "..." },
  { "text": "...", "url": "...", "date": "..." }
]

Rules:
- Use real tweet IDs in the URLs if you can find them, otherwise use https://x.com/${handle}
- date format: "Mon D" e.g. "Apr 12"
- text should be the full tweet content, no truncation
- newest tweet first
- if you cannot find any real recent tweets, return []`;

    try {
        const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${GROQ_KEY}`,
            },
            signal: AbortSignal.timeout(20000),
            body: JSON.stringify({
                model: 'compound-beta',   // Groq's model with built-in web search
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

        if (!Array.isArray(tweets)) throw new Error('Response is not an array');

        return res.status(200).json({ handle, tweets: tweets.slice(0, 3) });

    } catch (err) {
        return res.status(200).json({
            handle,
            tweets: [],
            error: err.message,
        });
    }
}

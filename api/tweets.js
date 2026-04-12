// =============================================================================
// /api/tweets.js
// GET /api/tweets?handle=justinsuntron
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

    const GROQ_KEY = process.env.GROQ_API_KEY;
    if (!GROQ_KEY) {
        return res.status(200).json({ handle, tweets: [], error: 'GROQ_API_KEY env var not set' });
    }

    // Two-attempt strategy: first a targeted URL search, then a broader fallback
    const attempts = [
        {
            model: 'compound-beta-mini',
            prompt: `Go to https://x.com/${handle} and list the 3 most recent posts you find there.

Respond with ONLY a JSON array and nothing else — no markdown, no explanation:
[{"text":"exact post text","url":"https://x.com/${handle}/status/TWEET_ID","date":"Apr 13"}]

Skip any retweets. Return [] only if the account is private or has no posts.`,
        },
        {
            model: 'compound-beta-mini',
            prompt: `Search the web for: "${handle} twitter posts site:x.com"

Find the 3 most recent tweets by the X/Twitter account @${handle} from those results.

Respond with ONLY a JSON array, nothing else:
[{"text":"exact post text","url":"https://x.com/${handle}/status/TWEET_ID","date":"Apr 13"}]

Return [] if nothing is found.`,
        },
    ];

    for (const attempt of attempts) {
        try {
            const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${GROQ_KEY}`,
                },
                signal: AbortSignal.timeout(55000),
                body: JSON.stringify({
                    model: attempt.model,
                    max_tokens: 1024,
                    temperature: 0,
                    messages: [{ role: 'user', content: attempt.prompt }],
                }),
            });

            if (!groqRes.ok) {
                const err = await groqRes.json().catch(() => ({}));
                console.warn(`[tweets] Groq ${groqRes.status} for @${handle}:`, err?.error?.message);
                continue; // try next attempt
            }

            const groqData = await groqRes.json();
            const raw      = groqData.choices?.[0]?.message?.content || '';
            const clean    = raw.replace(/```json|```/gi, '').trim();
            const start    = clean.indexOf('[');
            const end      = clean.lastIndexOf(']');

            if (start === -1 || end === -1) {
                console.warn(`[tweets] No JSON array in response for @${handle}:`, raw.slice(0, 200));
                continue;
            }

            const tweets = JSON.parse(clean.slice(start, end + 1));

            if (!Array.isArray(tweets) || tweets.length === 0) {
                console.warn(`[tweets] Empty array from Groq for @${handle}`);
                continue;
            }

            const cleaned = tweets.slice(0, 3).map(t => ({
                ...t,
                text: (t.text || '').replace(/https?:\/\/t\.co\/\S+/g, '').replace(/\s+/g, ' ').trim(),
            }));

            return res.status(200).json({ handle, tweets: cleaned });

        } catch (err) {
            console.warn(`[tweets] Attempt error for @${handle}:`, err.message);
            continue;
        }
    }

    return res.status(200).json({ handle, tweets: [], error: 'Could not retrieve tweets after all attempts' });
}

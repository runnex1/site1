// Vercel serverless: check if a real-world event has occurred
// POST /api/event-check { condition: "Ali Khamenei has died", label: "Khamenei dies" }
// Returns { triggered: true/false, verdict: "YES"|"NO", headlines: [...] }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { condition, label } = req.body || {};
  if (!condition && !label) return res.status(400).json({ error: 'condition required' });

  const GROQ_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_KEY) return res.status(500).json({ error: 'GROQ_API_KEY is not set' });

  const query = (condition || label).slice(0, 100);
  const searchQuery = encodeURIComponent(query);

  // Fetch news server-side — no CORS issues here
  const RSS_SOURCES = [
    `https://news.google.com/rss/search?q=${searchQuery}&hl=en-US&gl=US&ceid=US:en`,
    'https://feeds.reuters.com/reuters/topNews',
    'https://feeds.reuters.com/reuters/worldNews',
    'https://feeds.bbci.co.uk/news/world/rss.xml',
    'https://rss.nytimes.com/services/xml/rss/nyt/World.xml',
  ];

  const headlines = [];

  await Promise.allSettled(RSS_SOURCES.map(async (url) => {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VaultBot/1.0)' },
        signal: AbortSignal.timeout(6000),
      });
      if (!r.ok) return;
      const text = await r.text();
      const titles = [...text.matchAll(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/gi)];
      const descs  = [...text.matchAll(/<description[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/gi)];
      [...titles.slice(1, 15), ...descs.slice(1, 8)].forEach(m => {
        const t = (m[1] || '').replace(/<[^>]+>/g, '').trim().slice(0, 200);
        if (t.length > 10) headlines.push(t);
      });
    } catch (e) {
      // silently skip failed feeds
    }
  }));

  if (!headlines.length) {
    return res.status(200).json({ triggered: false, verdict: 'NO_NEWS', headlines: [] });
  }

  // Ask Groq
  const prompt = `You are a factual news verification system. Determine if a specific real-world event has occurred based on these news headlines.

Event to check: "${query}"

Recent news (${headlines.length} items):
${headlines.slice(0, 30).join('\n')}

Has this event occurred? Reply with exactly one word: YES or NO.`;

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_KEY}`,
      },
      signal: AbortSignal.timeout(12000),
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        temperature: 0,
        messages: [
          { role: 'system', content: 'You are a factual news verification assistant. Answer only YES or NO. Never refuse or add caveats.' },
          { role: 'user',   content: prompt },
        ],
      }),
    });

    if (!groqRes.ok) {
      return res.status(200).json({ triggered: false, verdict: 'GROQ_ERROR', headlines: headlines.slice(0, 5) });
    }

    const data = await groqRes.json();
    const verdict   = (data.choices?.[0]?.message?.content || '').trim().toUpperCase().slice(0, 10);
    const triggered = verdict.startsWith('YES');

    return res.status(200).json({
      triggered,
      verdict,
      headlines: headlines.slice(0, 5),
    });

  } catch (err) {
    return res.status(200).json({ triggered: false, verdict: 'ERROR', error: err.message, headlines: headlines.slice(0, 5) });
  }
}

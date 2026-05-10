/**
 * POST /api/ask
 * News-grounded Q&A for the alerts terminal.
 * Body: { question: "what was the last FOMC decision?" }
 * Returns: { answer: "...", headlines: [...] }
 */
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { question } = req.body || {};
  if (!question) return res.status(400).json({ error: 'question required' });

  const GROQ_KEY   = process.env.GROQ_API_KEY;
  const GEMINI_KEY = process.env.GEMINI_API_KEY;

  if (!GROQ_KEY && !GEMINI_KEY) {
    return res.status(500).json({ error: 'No AI keys configured' });
  }

  // ── Fetch relevant headlines ──────────────────────────────────────────────
  const searchQuery = encodeURIComponent(question.slice(0, 80));
  const RSS_SOURCES = [
    'https://news.google.com/rss/search?q=' + searchQuery + '&hl=en-US&gl=US&ceid=US:en',
    'https://feeds.reuters.com/reuters/topNews',
    'https://feeds.reuters.com/reuters/businessNews',
    'https://feeds.reuters.com/reuters/worldNews',
    'https://feeds.bbci.co.uk/news/business/rss.xml',
    'https://www.cnbc.com/id/10000664/device/rss/rss.html',
    'https://feeds.a.dj.com/rss/RSSMarketsMain.xml',
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
      [...titles.slice(1, 12), ...descs.slice(1, 6)].forEach(m => {
        const t = (m[1] || '').replace(/<[^>]+>/g, '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim().slice(0, 250);
        if (t.length > 15) headlines.push(t);
      });
    } catch (e) {}
  }));

  // ── Build prompt ──────────────────────────────────────────────────────────
  const today = new Date().toDateString();
  const headlineBlock = headlines.length
    ? headlines.slice(0, 35).join('\n')
    : '(no headlines fetched — answer from training knowledge only)';

  const prompt = `Today is ${today}. You are a financial and world news assistant. Answer the user's question concisely and factually based on the recent headlines provided. If the headlines don't contain enough information, use your training knowledge but note the uncertainty.

USER QUESTION: ${question}

RECENT HEADLINES:
${headlineBlock}

Provide a clear, direct answer in 2-4 sentences. Focus on facts. No disclaimers about being an AI.`;

  // ── Ask Groq first, fall back to Gemini ──────────────────────────────────
  let answer = null;

  if (GROQ_KEY) {
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_KEY },
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          temperature: 0.3,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (r.ok) {
        const data = await r.json();
        answer = (data.choices?.[0]?.message?.content || '').trim();
      }
    } catch (e) {
      console.warn('[ask] Groq failed:', e.message);
    }
  }

  if (!answer && GEMINI_KEY) {
    try {
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + GEMINI_KEY, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3 },
        }),
      });
      if (r.ok) {
        const data = await r.json();
        answer = (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
      }
    } catch (e) {
      console.warn('[ask] Gemini failed:', e.message);
    }
  }

  if (!answer) {
    return res.status(500).json({ error: 'AI unavailable' });
  }

  return res.status(200).json({
    ok: true,
    answer,
    headlines: headlines.slice(0, 5),
    sources: headlines.length,
  });
};

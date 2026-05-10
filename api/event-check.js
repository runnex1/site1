// Vercel serverless: check if a real-world event has occurred
// POST /api/event-check { condition: "Ali Khamenei has died", label: "Khamenei dies" }
// Returns { triggered: true/false, verdict: "YES"|"NO"|"NO_NEWS"|"GROQ_ERROR", headlines: [...] }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { condition, label } = req.body || {};
  if (!condition && !label) return res.status(400).json({ error: 'condition required' });

  const GROQ_KEY   = process.env.GROQ_API_KEY;
  const GEMINI_KEY = process.env.GEMINI_API_KEY;

  if (!GROQ_KEY && !GEMINI_KEY) {
    return res.status(500).json({ error: 'No AI API keys configured (need GROQ_API_KEY and/or GEMINI_API_KEY)' });
  }

  const query = (condition || label).slice(0, 100);

  // ── Helper: call an OpenAI-compatible chat endpoint ───────────────────────
  async function askAI({ url, apiKey, model, systemPrompt, userPrompt }) {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(12000),
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt },
        ],
      }),
    });

    if (!r.ok) {
      let errMsg = `HTTP ${r.status}`;
      try {
        const body = await r.json();
        errMsg = `HTTP ${r.status} — ${body?.error?.message || JSON.stringify(body)}`;
      } catch (e) {}
      throw new Error(errMsg);
    }

    const data = await r.json();
    return (data.choices?.[0]?.message?.content || '').trim().toUpperCase().slice(0, 10);
  }

  // ── Ask Groq ──────────────────────────────────────────────────────────────
  async function askGroq(systemPrompt, userPrompt) {
    if (!GROQ_KEY) return null;
    try {
      return await askAI({
        url:        'https://api.groq.com/openai/v1/chat/completions',
        apiKey:     GROQ_KEY,
        model:      'llama-3.3-70b-versatile',
        systemPrompt,
        userPrompt,
      });
    } catch (err) {
      console.error('[event-check] Groq error:', err.message);
      return null;
    }
  }

  // ── Ask Gemini ────────────────────────────────────────────────────────────
  async function askGemini(systemPrompt, userPrompt) {
    if (!GEMINI_KEY) return null;
    try {
      return await askAI({
        url:        'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
        apiKey:     GEMINI_KEY,
        model:      'gemini-2.5-flash',
        systemPrompt,
        userPrompt,
      });
    } catch (err) {
      console.error('[event-check] Gemini error:', err.message);
      return null;
    }
  }

  // ── Ask both in parallel; return true if either says YES ─────────────────
  async function askBoth(systemPrompt, userPrompt) {
    const [groqVerdict, geminiVerdict] = await Promise.all([
      askGroq(systemPrompt, userPrompt),
      askGemini(systemPrompt, userPrompt),
    ]);
    console.log(`[event-check] Groq: ${groqVerdict} | Gemini: ${geminiVerdict}`);
    const triggered = groqVerdict?.startsWith('YES') || geminiVerdict?.startsWith('YES');
    const verdict   = triggered ? 'YES' : (groqVerdict || geminiVerdict || 'ERROR');
    return { triggered, verdict, groqVerdict, geminiVerdict };
  }

  const SYSTEM_VERIFY = 'You are a factual news verification assistant. Answer only YES or NO. Never refuse or add caveats.';

  // ── Step 1: Prior knowledge check (both AIs, in parallel) ────────────────
  // Fires immediately for conditions the model already knows about
  // (e.g. "Trump is president") without fetching any news.
  const priorResult = await askBoth(
    'You are a factual assistant. Answer only YES, NO, or UNSURE. Never refuse or add caveats.',
    `Based on your training knowledge, is this condition currently true?\n\nCondition: "${query}"\n\nAnswer YES if you are confident it is already true, NO if you are confident it is not yet true, or UNSURE if you cannot determine this from your training data alone.`
  );

  if (priorResult.triggered) {
    return res.status(200).json({
      triggered: true,
      verdict:   'YES',
      source:    'prior_knowledge',
      groqVerdict:   priorResult.groqVerdict,
      geminiVerdict: priorResult.geminiVerdict,
      headlines: [],
    });
  }

  // ── Step 2: Fetch live news headlines ─────────────────────────────────────
  const searchQuery = encodeURIComponent(query);
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
    } catch (e) {}
  }));

  if (!headlines.length) {
    return res.status(200).json({ triggered: false, verdict: 'NO_NEWS', headlines: [] });
  }

  // ── Step 3: Ask both AIs with live headlines (in parallel) ────────────────
  const headlinePrompt = `You are a factual news verification system. Determine if a specific real-world event has occurred based on these news headlines.

Event to check: "${query}"

Recent news (${headlines.length} items):
${headlines.slice(0, 30).join('\n')}

Has this event occurred? Reply with exactly one word: YES or NO.`;

  const headlineResult = await askBoth(SYSTEM_VERIFY, headlinePrompt);

  return res.status(200).json({
    triggered:     headlineResult.triggered,
    verdict:       headlineResult.verdict,
    source:        'headlines',
    groqVerdict:   headlineResult.groqVerdict,
    geminiVerdict: headlineResult.geminiVerdict,
    headlines:     headlines.slice(0, 5),
  });
}

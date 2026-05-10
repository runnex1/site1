/**
 * POST /api/ask
 * News-grounded Q&A for the alerts terminal.
 * Body: { question: "what was the last FOMC decision?" }
 * Returns: { answer, headlines, sources }
 *
 * Pipeline:
 *   1. Fetch RSS headlines (Google News search + major feeds) in parallel
 *   2. Ask Groq (grounded on headlines)
 *   3. Ask Gemini (fallback)
 *   4. Wikipedia search fallback (AI down? search Wikipedia with full question)
 *   5. Return top Google-News-only headlines (last resort, relevant to question)
 */
const { getNewsSources } = require('../lib/news-sources');

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

  // ── Fetch headlines ───────────────────────────────────────────────────────
  // Short entity for dual Google News search (e.g. "Romania" from "who is Romania PM?")
  const entityMatch = question.match(/\b([A-Z][a-z]{1,}(?:\s+[A-Z][a-z]{1,}){0,3})/);
  const shortQuery  = entityMatch ? entityMatch[1] : question.split(' ').slice(0, 3).join(' ');
  const RSS_SOURCES = getNewsSources(question.slice(0, 80), shortQuery);

  // Track which headlines came from Google News (question-specific) vs generic feeds
  const googleNewsHeadlines = [];
  const otherHeadlines      = [];

  await Promise.allSettled(RSS_SOURCES.map(async (url, idx) => {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VaultBot/1.0)' },
        signal: AbortSignal.timeout(6000),
      });
      if (!r.ok) return;
      const text = await r.text();
      const titles = [...text.matchAll(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/gi)];
      const descs  = [...text.matchAll(/<description[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/gi)];
      const parsed = [];
      [...titles.slice(1, 12), ...descs.slice(1, 6)].forEach(m => {
        const t = (m[1] || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim().slice(0, 250);
        if (t.length > 15) parsed.push(t);
      });
      // idx 0 and 1 are the two Google News search URLs (question-specific)
      if (idx <= 1) googleNewsHeadlines.push(...parsed);
      else          otherHeadlines.push(...parsed);
    } catch (e) {}
  }));

  const allHeadlines = [...googleNewsHeadlines, ...otherHeadlines];

  // ── Build AI prompt ───────────────────────────────────────────────────────
  const today = new Date().toDateString();
  const headlineBlock = allHeadlines.length
    ? allHeadlines.slice(0, 35).join('\n')
    : '(no headlines fetched — answer from training knowledge only)';

  const prompt = `Today is ${today}. You are a financial and world news assistant. Answer the user's question concisely and factually based on the recent headlines provided. If the headlines don't contain enough information, use your training knowledge but note the uncertainty.

USER QUESTION: ${question}

RECENT HEADLINES:
${headlineBlock}

Provide a clear, direct answer in 2-4 sentences. Focus on facts. No disclaimers about being an AI.`;

  // ── Step 2: Groq ──────────────────────────────────────────────────────────
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

  // ── Step 3: Gemini fallback ───────────────────────────────────────────────
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


  // ── Step 5: Extract answer from headlines (no AI needed) ─────────────────
  if (!answer) {
    const relevant = googleNewsHeadlines.length ? googleNewsHeadlines : allHeadlines;
    if (!relevant.length) {
      return res.status(503).json({ error: 'AI unavailable and no headlines fetched' });
    }

    // For "who is [role] of [country]" — extract name from headlines
    const isWhoQ = /^who\s+(is|was|are)/i.test(question.trim());
    if (isWhoQ) {
      const roleMatch = question.match(/\b(president|prime minister|premier|chancellor|minister|ceo|director|head)\b/i);
      const role = roleMatch ? roleMatch[1].toLowerCase() : null;

      let extracted = null;

      if (role) {
        // Build case-variants of role (e.g. "president" → "President", "prime minister" → "Prime Minister")
        const titleRole = role.replace(/\b\w/g, c => c.toUpperCase());
        // NO 'i' flag — name capture group [A-Z][a-z]+ must be strictly uppercase-first
        // Matches: "President Nicușor Dan" or "Romanian President Nicușor Dan"
        const afterRole  = new RegExp(`(?:${titleRole}|${role})\\s+([A-ZȘȚĂÎÂ][a-zșțăîâ\\-]+(?:\\s+[A-ZȘȚĂÎÂ][a-zșțăîâ\\-]+){1,3})`);
        // Matches: "Nicușor Dan, President" or "Nicușor Dan is the president"
        const beforeRole = new RegExp(`([A-ZȘȚĂÎÂ][a-zșțăîâ\\-]+(?:\\s+[A-ZȘȚĂÎÂ][a-zșțăîâ\\-]+){1,3})(?:,?\\s+is(?:\\s+the)?)?\\s+(?:${titleRole}|${role})`);

        for (const h of relevant) {
          const m = h.match(afterRole) || h.match(beforeRole);
          if (m?.[1]) {
            const name = m[1].trim();
            const words = name.split(/\s+/);
            // All words must start with uppercase (real proper name, not "to Headquarters")
            const allUpper = words.every(w => /^[A-ZȘȚĂÎÂ]/.test(w));
            if (allUpper && words.length >= 2) {
              extracted = name;
              break;
            }
          }
        }
      }

      if (extracted) {
        const context = question.replace(/^who\s+(is|was|are)\s+(the\s+)?/i, '').replace(/\?$/, '').trim();
        answer = `The ${context} is ${extracted}.`;
      } else {
        answer = relevant[0]; // most relevant headline as fallback
      }
    } else {
      answer = relevant.slice(0, 3).map((h, i) => `${i + 1}. ${h}`).join('\n');
    }
  }

  return res.status(200).json({
    ok: true,
    answer,
    headlines: googleNewsHeadlines.slice(0, 5),
    sources: allHeadlines.length,
  });
};

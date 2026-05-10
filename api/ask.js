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

  // ── Step 4: Wikipedia fallback (AI down) ─────────────────────────────────
  if (!answer) {
    try {
      const isWhoQ = /^who\s+(is|was|are)/i.test(question.trim());
      const year   = new Date().getFullYear();

      const core = question
        .replace(/^(who|what|when|where|why|how)\s+(is|are|was|were|did|does|do)\s+(the\s+|a\s+)?/i, '')
        .replace(/\?$/, '').trim();

      const searchTerm = isWhoQ ? `${core} ${year}` : core;
      const wikiSearch = encodeURIComponent(searchTerm.slice(0, 80));

      const searchRes = await fetch(
        `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${wikiSearch}&format=json&srlimit=5`,
        { headers: { 'User-Agent': 'VaultBot/1.0' }, signal: AbortSignal.timeout(5000) }
      ).then(r => r.ok ? r.json() : null).catch(() => null);

      const allResults = searchRes?.query?.search || [];

      // Fetch summaries for all results in parallel
      const summaries = await Promise.all(allResults.map(r =>
        fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(r.title)}`,
          { headers: { 'User-Agent': 'VaultBot/1.0' }, signal: AbortSignal.timeout(5000) })
          .then(res => res.ok ? res.json() : null).catch(() => null)
      ));

      if (isWhoQ) {
        // Pass 1: find a person article (has a person description, not a list/office)
        for (let i = 0; i < summaries.length; i++) {
          const s = summaries[i];
          if (!s?.extract) continue;
          const desc  = (s.description || '').toLowerCase();
          const title = allResults[i].title;
          const isPerson =
            /politician|prime minister|president|minister|chancellor|secretary|official|diplomat/i.test(desc) &&
            !/list of|lists of|history of|politics of/i.test(title) &&
            !/^(prime minister|president|government|minister|office) of/i.test(title);
          if (isPerson) {
            answer = `${s.title} — ${s.description || s.extract.split('.')[0]}`;
            break;
          }
        }

        // Pass 2: extract "current X is [Name]" sentence from any article
        if (!answer) {
          for (const s of summaries) {
            if (!s?.extract) continue;
            // Match "current prime minister is Bolojan" or "Bolojan is the current PM"
            const m = s.extract.match(
              /current[^.]*(?:prime minister|president|premier|head of government|chancellor)[^.]*is\s+([A-ZȘȚĂÎÂ][a-zșțăîâ]+(?:\s+[A-ZȘȚĂÎÂ][a-zșțăîâ]+){0,3})/i
            ) || s.extract.match(
              /([A-ZȘȚĂÎÂ][a-zșțăîâ]+(?:\s+[A-ZȘȚĂÎÂ][a-zșțăîâ]+){1,3})\s+is\s+the\s+(?:current\s+)?(?:prime minister|president|premier)/i
            );
            if (m) {
              answer = m[0].trim().replace(/^[^A-Z]*/, '');
              break;
            }
          }
        }
      }

      // For non-who questions, or final fallback: return first non-list result's extract
      if (!answer) {
        const best = summaries.find((s, i) =>
          s?.extract && !/^(list of|lists of)/i.test(allResults[i]?.title || '')
        );
        if (best) {
          answer = `[Wikipedia: ${best.title}] ${best.extract.slice(0, 400)}`;
        }
      }
    } catch (e) {}
  }

  // ── Step 5: Last resort — show question-relevant headlines only ───────────
  if (!answer) {
    const relevant = googleNewsHeadlines.length ? googleNewsHeadlines : allHeadlines;
    if (relevant.length > 0) {
      answer = relevant.slice(0, 5).map((h, i) => `${i + 1}. ${h}`).join('\n');
    } else {
      return res.status(503).json({ error: 'AI unavailable and no headlines fetched' });
    }
  }

  return res.status(200).json({
    ok: true,
    answer,
    headlines: googleNewsHeadlines.slice(0, 5),
    sources: allHeadlines.length,
  });
};

/**
 * POST /api/ask
 * News-grounded Q&A for the alerts terminal.
 * Body: { question: "who is the prime minister of Ukraine?" }
 * Returns: { answer, headlines, sources }
 *
 * Pipeline for "who is [role] of [country]":
 *   1. Wikidata SPARQL (authoritative, live, no API key) — runs first, in parallel with feeds
 *   2. RSS headlines context for AI enrichment
 *   3. Groq 70b (grounded on Wikidata + headlines)
 *   4. Gemini fallback
 *   5. Return Wikidata answer directly (no AI needed if Wikidata found it)
 *   6. Groq 8b-instant for non-political questions only
 *   7. Headline extraction fallback
 *
 * For non-role questions (FOMC, market crashes, etc.): skip Wikidata, go straight to AI + feeds.
 */
const { getNewsSources } = require('../lib/news-sources');

// Map role keywords → Wikidata property
const ROLE_PROP = {
  'president':          'P35',  // head of state
  'head of state':      'P35',
  'prime minister':     'P6',   // head of government
  'premier':            'P6',
  'chancellor':         'P6',
  'head of government': 'P6',
  'minister':           'P6',
};

function parseRoleQuestion(q) {
  const clean = q.toLowerCase().replace(/[?]/g, '').trim();
  if (!/^who\s+(is|was|are)/.test(clean)) return null;
  for (const [role, prop] of Object.entries(ROLE_PROP)) {
    const m = clean.match(new RegExp(`\\b${role.replace(' ', '\\s+')}\\b`));
    if (!m) continue;
    // Extract country — look for "of [Country]" or last capitalised word(s)
    const ofMatch = q.match(/\bof\s+([A-Z][a-zA-Z\s]{1,30}?)(?:\?|$)/);
    const country = ofMatch ? ofMatch[1].trim() : null;
    if (country) return { role, prop, country };
  }
  return null;
}

async function wikidataLookup({ country, prop }) {
  try {
    // Step 1: find the country's Wikidata QID
    const searchRes = await fetch(
      `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(country)}&language=en&format=json&limit=5&type=item`,
      { headers: { 'User-Agent': 'VaultBot/1.0' }, signal: AbortSignal.timeout(6000) }
    ).then(r => r.ok ? r.json() : null).catch(() => null);

    const entity = (searchRes?.search || []).find(e =>
      /\b(country|state|republic|nation|kingdom|federation|territory)\b/i.test(e.description || '')
    ) || searchRes?.search?.[0];

    console.log(`[wikidata] country="${country}" entity=${entity?.id} (${entity?.description})`);
    if (!entity?.id) return null;

    // Step 2: get entity claims directly (avoid SPARQL — unreliable from Vercel)
    const claimsRes = await fetch(
      `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${entity.id}&props=claims&format=json`,
      { headers: { 'User-Agent': 'VaultBot/1.0' }, signal: AbortSignal.timeout(6000) }
    ).then(r => r.ok ? r.json() : null).catch(() => null);

    const claims = claimsRes?.entities?.[entity.id]?.claims?.[prop] || [];
    // preferred rank = current holder; fallback to claim with no end date (P582)
    const current = claims.find(c => c.rank === 'preferred') ||
                    claims.find(c => !c.qualifiers?.P582);
    const personQid = current?.mainsnak?.datavalue?.value?.id;

    console.log(`[wikidata] prop=${prop} claims=${claims.length} current QID=${personQid}`);
    if (!personQid) return null;

    // Step 3: fetch the person's English label
    const personRes = await fetch(
      `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${personQid}&props=labels&format=json&languages=en`,
      { headers: { 'User-Agent': 'VaultBot/1.0' }, signal: AbortSignal.timeout(5000) }
    ).then(r => r.ok ? r.json() : null).catch(() => null);

    const name = personRes?.entities?.[personQid]?.labels?.en?.value || null;
    console.log(`[wikidata] person name="${name}"`);
    return name;
  } catch (e) {
    console.error('[wikidata] error:', e.message);
    return null;
  }
}

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

  // ── Detect political role question ───────────────────────────────────────
  const roleQ = parseRoleQuestion(question);

  // ── Fetch headlines + Wikidata in parallel ────────────────────────────────
  const entityMatch = question.match(/\b([A-Z][a-z]{1,}(?:\s+[A-Z][a-z]{1,}){0,3})/);
  const shortQuery  = entityMatch ? entityMatch[1] : question.split(' ').slice(0, 3).join(' ');
  const RSS_SOURCES = getNewsSources(question.slice(0, 80), shortQuery);

  const googleNewsHeadlines = [];
  const otherHeadlines      = [];

  const [, wikidataName] = await Promise.all([
    // RSS fetch
    Promise.allSettled(RSS_SOURCES.map(async (url, idx) => {
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
          const t = (m[1] || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim().slice(0, 250);
          if (t.length > 15) (idx <= 1 ? googleNewsHeadlines : otherHeadlines).push(t);
        });
      } catch (e) {}
    })),
    // Wikidata lookup (only for role questions)
    roleQ ? wikidataLookup(roleQ) : Promise.resolve(null),
  ]);

  const allHeadlines = [...googleNewsHeadlines, ...otherHeadlines];
  const today = new Date().toDateString();
  let answer = null;

  // ── Build AI prompt (includes Wikidata result if found) ───────────────────
  const wikidataContext = wikidataName
    ? `[Wikidata live data] The current ${roleQ.role} of ${roleQ.country} is ${wikidataName}.\n\n`
    : '';

  const headlineBlock = allHeadlines.length
    ? allHeadlines.slice(0, 30).join('\n')
    : '(no headlines fetched)';

  const prompt = `Today is ${today}. Answer the user's question concisely and factually.
${wikidataContext}RECENT HEADLINES:\n${headlineBlock}

USER QUESTION: ${question}

Provide a clear, direct answer in 1-2 sentences. Focus on facts. No disclaimers.`;

  // ── Step 2: Groq 70b ──────────────────────────────────────────────────────
  if (GROQ_KEY) {
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_KEY },
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          temperature: 0.1,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (r.ok) answer = (await r.json()).choices?.[0]?.message?.content?.trim() || null;
    } catch (e) { console.warn('[ask] Groq 70b failed:', e.message); }
  }

  // ── Step 3: Gemini fallback ───────────────────────────────────────────────
  if (!answer && GEMINI_KEY) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1 } }),
      });
      if (r.ok) answer = (await r.json()).candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
    } catch (e) { console.warn('[ask] Gemini failed:', e.message); }
  }

  // ── Step 4: Wikidata direct answer (AI offline but Wikidata worked) ───────
  if (!answer && wikidataName) {
    const context = question.replace(/^who\s+(is|was|are)\s+(the\s+)?/i, '').replace(/\?$/, '').trim();
    answer = `The ${context} is ${wikidataName}.`;
  }

  // ── Step 5: Groq 8b-instant — only for NON-role questions (avoids stale data) ──
  if (!answer && !roleQ && GROQ_KEY) {
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_KEY },
        signal: AbortSignal.timeout(8000),
        body: JSON.stringify({
          model: 'llama-3.1-8b-instant',
          temperature: 0.1,
          max_tokens: 80,
          messages: [{ role: 'user', content: `Today is ${today}. Answer based on these recent headlines and your knowledge. Be direct and factual, 1-2 sentences.

RECENT HEADLINES:
${allHeadlines.slice(0,15).join('\n')}

QUESTION: ${question}` }],
        }),
      });
      if (r.ok) answer = (await r.json()).choices?.[0]?.message?.content?.trim() || null;
    } catch (e) {}
  }

  // ── Step 6: Extract name from headlines ───────────────────────────────────
  if (!answer) {
    const relevant = googleNewsHeadlines.length ? googleNewsHeadlines : allHeadlines;
    if (relevant.length) {
      const isWhoQ = /^who\s+(is|was|are)/i.test(question.trim());
      if (isWhoQ && roleQ) {
        const titleRole = roleQ.role.replace(/\b\w/g, c => c.toUpperCase());
        const abbrevMap = { 'prime minister': 'PM', 'chief executive': 'CEO' };
        const abbrev = abbrevMap[roleQ.role] || null;
        const variants = [titleRole, roleQ.role, ...(abbrev ? [abbrev] : [])].join('|');
        const afterRole  = new RegExp(`(?:${variants})\\s+([A-ZȘȚĂÎÂ][a-zșțăîâ\\-]+(?:\\s+[A-ZȘȚĂÎÂ][a-zșțăîâ\\-]+){1,3})`);
        const beforeRole = new RegExp(`([A-ZȘȚĂÎÂ][a-zșțăîâ\\-]+(?:\\s+[A-ZȘȚĂÎÂ][a-zșțăîâ\\-]+){1,3})(?:,?\\s+is(?:\\s+the)?)?\\s+(?:${variants})`);
        let extracted = null;
        for (const h of relevant) {
          const m = h.match(afterRole) || h.match(beforeRole);
          if (m?.[1]) {
            const words = m[1].trim().split(/\s+/);
            if (words.length >= 2 && words.every(w => /^[A-ZȘȚĂÎÂ]/.test(w))) {
              extracted = m[1].trim();
              break;
            }
          }
        }
        if (extracted) {
          // Quick Groq name validation
          let confirmed = true;
          if (GROQ_KEY) {
            try {
              const vr = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_KEY },
                signal: AbortSignal.timeout(5000),
                body: JSON.stringify({
                  model: 'llama-3.1-8b-instant',
                  temperature: 0,
                  max_tokens: 5,
                  messages: [{ role: 'user', content: `Is "${extracted}" a real person's name? Reply only YES or NO.` }],
                }),
              });
              if (vr.ok) confirmed = (await vr.json()).choices?.[0]?.message?.content?.trim().toUpperCase().startsWith('YES');
            } catch (e) {}
          }
          if (confirmed) {
            const context = question.replace(/^who\s+(is|was|are)\s+(the\s+)?/i, '').replace(/\?$/, '').trim();
            answer = `The ${context} is ${extracted}.`;
          }
        }
      }
      if (!answer) {
        const keywords = question.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(w => w.length > 3);
        const filtered = relevant.filter(h => keywords.some(k => h.toLowerCase().includes(k)));
        answer = filtered.length ? filtered[0] : 'AI is temporarily unavailable. Try again in a moment.';
      }
    } else {
      return res.status(503).json({ error: 'AI unavailable and no headlines fetched' });
    }
  }

  return res.status(200).json({ ok: true, answer, headlines: googleNewsHeadlines.slice(0, 5), sources: allHeadlines.length });
};

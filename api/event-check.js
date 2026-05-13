/**
 * POST /api/event-check
 *
 * Single authority for event alert checking.
 * Called by browser (while website open) and check-alerts.js (cron, when closed).
 *
 * Source priority:
 *   1. Wikipedia summary  — authoritative for political roles, elections, deaths
 *   2. Wikidata description — structured entity facts (e.g. "President of Romania")
 *   3. Google News RSS     — breaking/recent events not yet on Wikipedia
 *   4. Reuters / BBC / NYT — additional headline sources
 *
 * Body:  { condition, label, alertId? }
 * Returns: { triggered, verdict, source, context }
 */

const { kvGet, kvSet } = require('../lib/kv');
const { getNewsSources } = require('../lib/news-sources');
const ALERTS_KEY = 'vault:alerts';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { condition, label, alertId, setAt } = req.body || {};
  if (!condition && !label) return res.status(400).json({ error: 'condition required' });

  const GROQ_KEY   = process.env.GROQ_API_KEY;
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  const TG_TOKEN   = (process.env.TG_BOT_TOKEN || '').trim();
  const TG_CHAT_ID = (process.env.TG_CHAT_ID   || '').trim();

  const query = (condition || label).slice(0, 120);
  const today = new Date().toDateString();

  // ── AI helper ─────────────────────────────────────────────────────────────
  async function askAI({ url, apiKey, model, messages }) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      signal: AbortSignal.timeout(14000),
      body: JSON.stringify({ model, temperature: 0, messages }),
    });
    if (!r.ok) {
      let msg = 'HTTP ' + r.status;
      try { const b = await r.json(); msg += ' — ' + (b?.error?.message || ''); } catch(e) {}
      throw new Error(msg);
    }
    const data = await r.json();
    return (data.choices?.[0]?.message?.content || '').trim().toUpperCase().slice(0, 10);
  }

  async function askGroq(prompt) {
    if (!GROQ_KEY) return null;
    try {
      return await askAI({
        url: 'https://api.groq.com/openai/v1/chat/completions',
        apiKey: GROQ_KEY, model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
      });
    } catch(e) { console.error('[event-check] Groq:', e.message); return null; }
  }

  async function askGemini(prompt) {
    if (!GEMINI_KEY) return null;
    try {
      return await askAI({
        url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
        apiKey: GEMINI_KEY, model: 'gemini-2.0-flash',
        messages: [{ role: 'user', content: prompt }],
      });
    } catch(e) { console.error('[event-check] Gemini:', e.message); return null; }
  }

  // Either AI saying YES is enough
  async function askBoth(prompt) {
    const [g, m] = await Promise.all([askGroq(prompt), askGemini(prompt)]);
    console.log('[event-check] Groq: ' + g + ' | Gemini: ' + m);
    const triggered = g?.startsWith('YES') || m?.startsWith('YES');
    return { triggered, verdict: triggered ? 'YES' : (g || m || 'ERROR') };
  }

  // JSON-based check — returns triggered, verdict, reason, headline
  // Strategy: Groq first (30 RPM free tier), Gemini only if Groq fails (15 RPM).
  // Running both in parallel doubled API usage and hit Gemini rate limits when many
  // alerts checked simultaneously. Sequential Groq→Gemini halves the load.
  // If BOTH are rate-limited, keyword matching on the headlines fires as a safety net
  // so events are never silently missed due to free-tier quota exhaustion.
  async function askBothJSON(prompt, headlines) {
    function tryParse(text) {
      if (!text) return null;
      try {
        const jsonStr = text.replace(/```json|```/g, '').trim();
        const braceMatch = jsonStr.match(/\{[\s\S]*\}/);
        return JSON.parse(braceMatch ? braceMatch[0] : jsonStr);
      } catch(e) {
        return /^\s*(yes|true)\b/i.test(text) ? { triggered: true, reason: text.slice(0,80), headline: '' } : null;
      }
    }

    async function callGroq() {
      if (!GROQ_KEY) return null;
      try {
        const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_KEY },
          signal: AbortSignal.timeout(14000),
          body: JSON.stringify({ model: 'llama-3.3-70b-versatile', temperature: 0, max_tokens: 150,
            messages: [{ role: 'user', content: prompt }] }),
        });
        if (!r.ok) { console.error('[event-check] JSON/Groq HTTP', r.status); return null; }
        return ((await r.json()).choices?.[0]?.message?.content || '').trim();
      } catch(e) { console.error('[event-check] JSON/Groq:', e.message); return null; }
    }

    async function callGemini() {
      if (!GEMINI_KEY) return null;
      try {
        const r = await fetch('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GEMINI_KEY },
          signal: AbortSignal.timeout(14000),
          body: JSON.stringify({ model: 'gemini-2.0-flash', temperature: 0, max_tokens: 150,
            messages: [{ role: 'user', content: prompt }] }),
        });
        if (!r.ok) { console.error('[event-check] JSON/Gemini HTTP', r.status); return null; }
        return ((await r.json()).choices?.[0]?.message?.content || '').trim();
      } catch(e) { console.error('[event-check] JSON/Gemini:', e.message); return null; }
    }

    // Groq first; only fall back to Gemini if Groq is rate-limited or down
    let aiText = await callGroq();
    if (!aiText) {
      console.warn('[event-check] Groq unavailable, trying Gemini...');
      aiText = await callGemini();
    }
    console.log('[event-check] AI raw (first 120):', (aiText || 'null').slice(0, 120));

    const parsed = tryParse(aiText);
    if (parsed) {
      const triggered = !!parsed.triggered;
      console.log('[event-check] AI verdict:', triggered ? 'YES' : 'NO', '| reason:', (parsed.reason || '').slice(0, 80));
      return { triggered, verdict: triggered ? 'YES' : 'NO', reason: parsed.reason || '', headline: parsed.headline || '' };
    }

    // Both AIs unavailable. Keyword-match headlines as safety net — rate-limit
    // exhaustion should never silently swallow a real event.
    if (headlines && headlines.length) {
      const stopWords = new Set(['this','that','have','with','from','what','when','will','been','were','they','them','about','into','also','after','before']);
      const words = query.toLowerCase()
        .replace(/[^\w\s]/g, ' ').split(/\s+/)
        .filter(w => w.length > 3 && !stopWords.has(w));
      const matchedHl = headlines.find(h => {
        const hl = h.toLowerCase();
        return words.filter(w => hl.includes(w)).length >= Math.min(2, words.length);
      });
      if (matchedHl) {
        console.log('[event-check] AI rate-limited — keyword fallback triggered:', matchedHl.slice(0, 100));
        return { triggered: true, verdict: 'YES', reason: 'Keyword match (AI rate-limited)', headline: matchedHl };
      }
    }

    console.log('[event-check] Both AIs unavailable, no keyword match — returning NO');
    return { triggered: false, verdict: 'NO', reason: 'AI unavailable', headline: '' };
  }

  // ── Wikipedia summary ─────────────────────────────────────────────────────
  async function fetchWikipedia(searchTerm) {
    try {
      const sUrl = 'https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=' +
        encodeURIComponent(searchTerm) + '&format=json&srlimit=2&origin=*';
      const sr = await fetch(sUrl, {
        signal: AbortSignal.timeout(6000),
        headers: { 'User-Agent': 'VaultAlerts/1.0 (farcasteeer@gmail.com)' },
      });
      if (!sr.ok) return null;
      const sd = await sr.json();
      const title = sd?.query?.search?.[0]?.title;
      if (!title) return null;

      const uUrl = 'https://en.wikipedia.org/api/rest_v1/page/summary/' +
        encodeURIComponent(title.replace(/ /g, '_'));
      const ur = await fetch(uUrl, {
        signal: AbortSignal.timeout(6000),
        headers: { 'User-Agent': 'VaultAlerts/1.0 (farcasteeer@gmail.com)' },
      });
      if (!ur.ok) return null;
      const ud = await ur.json();
      return ud.extract ? '[Wikipedia] ' + ud.extract.slice(0, 700) : null;
    } catch(e) {
      console.warn('[event-check] Wikipedia error:', e.message);
      return null;
    }
  }

  // ── Wikidata entity description ───────────────────────────────────────────
  async function fetchWikidata(searchTerm) {
    try {
      const url = 'https://www.wikidata.org/w/api.php?action=wbsearchentities&search=' +
        encodeURIComponent(searchTerm) + '&language=en&format=json&limit=3&origin=*';
      const r = await fetch(url, {
        signal: AbortSignal.timeout(5000),
        headers: { 'User-Agent': 'VaultAlerts/1.0 (farcasteeer@gmail.com)' },
      });
      if (!r.ok) return null;
      const d = await r.json();
      const items = (d?.search || []).filter(i => i.description);
      if (!items.length) return null;
      return items
        .slice(0, 2)
        .map(i => '[Wikidata] ' + i.label + ': ' + i.description)
        .join('\n');
    } catch(e) {
      console.warn('[event-check] Wikidata error:', e.message);
      return null;
    }
  }

  // ── RSS headlines ─────────────────────────────────────────────────────────
  // Returns [{text, pubTs}] where pubTs is a Unix ms timestamp (or 0 if missing).
  async function fetchRSS(url) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VaultBot/1.0)' },
        signal: AbortSignal.timeout(6000),
      });
      if (!r.ok) return [];
      const xml = await r.text();

      // Parse <item> blocks to keep title+pubDate together
      const items = [];
      const itemBlocks = [...xml.matchAll(/<item[\s>]([\s\S]*?)<\/item>/gi)];
      if (itemBlocks.length) {
        for (const b of itemBlocks.slice(0, 15)) {
          const body = b[1] || '';
          const titleM = body.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
          const dateM  = body.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i);
          const descM  = body.match(/<description[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i);
          const text   = ((titleM || descM || [])[1] || '').replace(/<[^>]+>/g, '').trim().slice(0, 220);
          const pubTs  = dateM ? (Date.parse(dateM[1].trim()) || 0) : 0;
          if (text.length > 10) items.push({ text, pubTs });
        }
      } else {
        // Fallback: feed has no <item> blocks — grab titles/descs without dates
        const titles = [...xml.matchAll(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/gi)];
        const descs  = [...xml.matchAll(/<description[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/gi)];
        [...titles.slice(1, 12), ...descs.slice(1, 6)].forEach(m => {
          const t = (m[1] || '').replace(/<[^>]+>/g, '').trim().slice(0, 220);
          if (t.length > 10) items.push({ text: t, pubTs: 0 });
        });
      }
      return items;
    } catch(e) { return []; }
  }

  // ── Extract entity name (first run of Title-Case words) ───────────────────
  function extractEntity(text) {
    const m = text.match(/\b([A-Z][a-z]{1,}(?:\s+[A-Z][a-z]{1,}){0,3})/);
    return m ? m[1] : text.split(' ').slice(0, 3).join(' ');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 1 — Wikipedia + Wikidata (authoritative, no API key needed)
  // ═══════════════════════════════════════════════════════════════════════════

  const entity = extractEntity(query);
  console.log('[event-check] Entity extracted:', entity, '| Query:', query);

  // Detect time-sensitive conditions: Wikipedia is an encyclopedia, not a news feed.
  // For conditions involving recent events ("announced", "arrived", "said today") Wikipedia
  // will almost always say NO even when the event HAS happened — skip it and go straight to RSS.
  const isTimeSensitive = /\b(announc|releas|said|says|stated|declared|tweet|post|today|yesterday|this week|this month|recent|latest|new\b|just\b|breaking|now\b|happen|occur|report|arriv|land|visit|sign|reach|meet|speak|address|confirm|pass|approv|reject|launch|attack|invad|withdraw|deal|vote|elect|win|lose|fire|resign|appoint|nominat)\b/i.test(query);
  console.log('[event-check] Time-sensitive:', isTimeSensitive);

  // Detect future-tense alerts: "next rate decision", "upcoming election", "will announce"…
  // For these, only headlines published AFTER the alert was created count — otherwise a
  // headline about last month's rate decision would immediately fire a "next decision" alert.
  const isFutureTense = /\b(next|upcoming|will\s|future|soon|expected|scheduled|planned|going\s+to|yet\s+to|yet\s+to\s+be|announce[sd]?\s+the\s+next|next\s+time)\b/i.test(query);
  const alertSetAt    = setAt ? Number(setAt) : 0;
  if (isFutureTense) console.log('[event-check] Future-tense alert — cutoff:', alertSetAt ? new Date(alertSetAt).toUTCString() : 'none');

  // For time-sensitive conditions skip Wikipedia entirely:
  //   - Wikipedia won't have breaking news → always says NO for announcements/arrivals
  //   - Skipping it saves 1-2 Groq API calls per alert, preventing 429s when 5 alerts check in parallel
  let wikiSummary = null, wikidataDesc = null;
  if (!isTimeSensitive) {
    [wikiSummary, wikidataDesc] = await Promise.all([
      fetchWikipedia(entity),
      fetchWikidata(entity),
    ]);
  }

  const authoritative = [wikiSummary, wikidataDesc].filter(Boolean).join('\n');

  let triggered = false;
  let verdict   = 'NO';
  let source    = 'no_data';
  let reason    = '';
  let headline  = '';

  if (authoritative && !isTimeSensitive) {
    const wikiPrompt =
      'Today is ' + today + '.\n\n' +
      'AUTHORITATIVE SOURCES:\n' + authoritative + '\n\n' +
      'CONDITION TO CHECK: "' + query + '"\n\n' +
      'Based ONLY on the authoritative sources above, is this condition currently true?\n' +
      'Answer YES if any source confirms it, NO if directly contradicted, UNSURE if unclear.\n' +
      'One word: YES, NO, or UNSURE.';

    const wikiResult = await askBoth(wikiPrompt);
    console.log('[event-check] Wiki verdict:', wikiResult.verdict);

    if (wikiResult.triggered) {
      triggered = true;
      verdict   = 'YES';
      source    = 'wikipedia';
    } else if (wikiResult.verdict !== 'UNSURE' && wikiResult.verdict !== 'ERROR') {
      // Non-time-sensitive: trust Wikipedia NO for stable facts (leadership, elections, deaths)
      triggered = false;
      verdict   = 'NO';
      source    = 'wikipedia';
    }
    // If UNSURE, or time-sensitive, or ERROR → fall through to RSS
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 2 — RSS headlines (for breaking/recent events not yet on Wikipedia)
  // ═══════════════════════════════════════════════════════════════════════════

  if (!triggered && (source === 'no_data' || verdict === 'UNSURE' || !authoritative || isTimeSensitive)) {
    const RSS_SOURCES = getNewsSources(query, entity);

    const rssResults = await Promise.all(RSS_SOURCES.map(fetchRSS));
    const allItems   = rssResults.flat();

    // For future-tense alerts, discard headlines published before the alert was set.
    // This prevents "next rate decision" from firing on last month's announcement.
    const items = (isFutureTense && alertSetAt)
      ? allItems.filter(h => h.pubTs === 0 || h.pubTs >= alertSetAt)
      : allItems;

    // Format for AI: include publish date when available so the model can reason about recency
    const headlines = items.slice(0, 30).map(h => {
      if (h.pubTs) {
        const d = new Date(h.pubTs).toUTCString();
        return `[${d}] ${h.text}`;
      }
      return h.text;
    });

    // Plain text array for keyword fallback (no date prefix needed)
    const headlineTexts = items.map(h => h.text);

    if (!headlines.length) {
      verdict = 'NO_NEWS';
      source  = 'no_news';
    } else {
      // Build full context: Wikipedia (if any) + RSS headlines
      const contextParts = [];
      if (authoritative) contextParts.push('AUTHORITATIVE SOURCES:\n' + authoritative);
      const cutoffNote = (isFutureTense && alertSetAt)
        ? `\nNOTE: This alert was created on ${new Date(alertSetAt).toUTCString()}. ONLY trigger if a headline published AFTER that date confirms the event. Ignore older headlines.`
        : '';
      contextParts.push('RECENT NEWS HEADLINES:\n' + headlines.join('\n') + cutoffNote);

      const rssPrompt =
        'Today is ' + today + '.\n\n' +
        contextParts.join('\n\n') + '\n\n' +
        'CONDITION TO CHECK: "' + query + '"\n\n' +
        'Has this condition been met based on the sources above?\n' +
        'Reply with ONLY a JSON object:\n' +
        '{"triggered": true/false, "reason": "brief explanation of what happened", "headline": "the specific headline that confirmed this, or empty string"}\n\n' +
        (isTimeSensitive
          ? 'Say triggered:true if ANY headline shows this happened recently (last 48h). News moves faster than Wikipedia — do not require encyclopedia confirmation. When in doubt, trigger.'
          : 'Be conservative — only say triggered:true if there is clear, direct evidence.');

      const rssResult = await askBothJSON(rssPrompt, headlineTexts);
      triggered = rssResult.triggered;
      verdict   = rssResult.verdict;
      reason    = rssResult.reason;
      headline  = rssResult.headline;
      source    = 'headlines';
    }
  }

  // ── Fire: send TG + mark in KV ────────────────────────────────────────────
  if (triggered && alertId && TG_TOKEN && TG_CHAT_ID) {
    try {
      const stored = await kvGet(ALERTS_KEY);
      const alerts = stored ? (typeof stored === 'string' ? JSON.parse(stored) : stored) : [];
      const alert  = alerts.find(a => a.id === alertId);
      if (alert && !alert.tgSent) {
        const msgLines = [
          '🔔 <b>Event Alert — ' + (alert.label || query) + '</b>',
          '',
          '<b>Condition:</b> ' + query,
        ];
        if (reason)   msgLines.push('<b>What happened:</b> ' + reason);
        if (headline) msgLines.push('<b>Headline:</b> <i>' + headline + '</i>');
        msgLines.push('');
        msgLines.push('<i>' + new Date().toUTCString() + '</i>');
        const msg = msgLines.join('\n');
        await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: TG_CHAT_ID, text: msg, parse_mode: 'HTML' }),
        });
        alert.triggered = true;
        alert.tgSent    = true;
        await kvSet(ALERTS_KEY, JSON.stringify(alerts));
        console.log('[event-check] Fired + TG sent:', alert.label, '| source:', source);
      }
    } catch(e) {
      console.error('[event-check] KV/TG error:', e.message);
    }
  }

  return res.status(200).json({
    triggered, verdict, source,
    context: [wikiSummary, wikidataDesc].filter(Boolean).slice(0, 2),
  });
};

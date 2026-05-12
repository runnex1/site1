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

  const { condition, label, alertId } = req.body || {};
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
  async function askBothJSON(prompt) {
    let rawText = '{}';
    try {
      const [g, m] = await Promise.all([askGroq(prompt), askGemini(prompt)]);
      rawText = (g || m || '{}');
    } catch(e) { /* ignore */ }
    try {
      const parsed = JSON.parse(rawText.replace(/```json|```/g, '').trim());
      const triggered = !!parsed.triggered;
      return {
        triggered,
        verdict:  triggered ? 'YES' : 'NO',
        reason:   parsed.reason  || '',
        headline: parsed.headline || '',
      };
    } catch(e) {
      const triggered = rawText?.startsWith('YES');
      return { triggered, verdict: triggered ? 'YES' : 'NO', reason: '', headline: '' };
    }
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
  async function fetchRSS(url) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VaultBot/1.0)' },
        signal: AbortSignal.timeout(6000),
      });
      if (!r.ok) return [];
      const text = await r.text();
      const titles = [...text.matchAll(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/gi)];
      const descs  = [...text.matchAll(/<description[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/gi)];
      const out = [];
      [...titles.slice(1, 12), ...descs.slice(1, 6)].forEach(m => {
        const t = (m[1] || '').replace(/<[^>]+>/g, '').trim().slice(0, 220);
        if (t.length > 10) out.push(t);
      });
      return out;
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

  const [wikiSummary, wikidataDesc] = await Promise.all([
    fetchWikipedia(entity),
    fetchWikidata(entity),
  ]);

  const authoritative = [wikiSummary, wikidataDesc].filter(Boolean).join('\n');

  let triggered = false;
  let verdict   = 'NO';
  let source    = 'no_data';
  let reason    = '';
  let headline  = '';

  if (authoritative) {
    const wikiPrompt =
      'Today is ' + today + '.\n\n' +
      'AUTHORITATIVE SOURCES:\n' + authoritative + '\n\n' +
      'CONDITION TO CHECK: "' + query + '"\n\n' +
      'Based ONLY on the authoritative sources above, is this condition currently true?\n' +
      'Answer YES if any source confirms it, NO if contradicted, UNSURE if unclear.\n' +
      'One word: YES, NO, or UNSURE.';

    const wikiResult = await askBoth(wikiPrompt);
    console.log('[event-check] Wiki verdict:', wikiResult.verdict);

    if (wikiResult.triggered) {
      triggered = true;
      verdict   = 'YES';
      source    = 'wikipedia';
    } else if (wikiResult.verdict !== 'UNSURE' && wikiResult.verdict !== 'ERROR') {
      // Both AIs said NO based on Wikipedia → very confident, skip RSS
      triggered = false;
      verdict   = 'NO';
      source    = 'wikipedia';
    }
    // If UNSURE → fall through to RSS
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 2 — RSS headlines (for breaking/recent events not yet on Wikipedia)
  // ═══════════════════════════════════════════════════════════════════════════

  if (!triggered && (source === 'no_data' || verdict === 'UNSURE' || !authoritative)) {
    const RSS_SOURCES = getNewsSources(query, entity);

    const rssResults = await Promise.all(RSS_SOURCES.map(fetchRSS));
    const headlines  = rssResults.flat();

    if (!headlines.length) {
      verdict = 'NO_NEWS';
      source  = 'no_news';
    } else {
      // Build full context: Wikipedia (if any) + RSS headlines
      const contextParts = [];
      if (authoritative) contextParts.push('AUTHORITATIVE SOURCES:\n' + authoritative);
      contextParts.push('RECENT NEWS HEADLINES:\n' + headlines.slice(0, 30).join('\n'));

      const rssPrompt =
        'Today is ' + today + '.\n\n' +
        contextParts.join('\n\n') + '\n\n' +
        'CONDITION TO CHECK: "' + query + '"\n\n' +
        'Has this condition been met based on the sources above?\n' +
        'Reply with ONLY a JSON object:\n' +
        '{"triggered": true/false, "reason": "brief explanation of what happened", "headline": "the specific headline that confirmed this, or empty string"}\n\n' +
        'Be conservative — only say triggered:true if there is clear, direct evidence.';

      const rssResult = await askBothJSON(rssPrompt);
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
        const sourceLabel = source === 'wikipedia' ? 'Wikipedia' : source === 'headlines' ? 'News' : source;
        msgLines.push('<b>Source:</b> ' + sourceLabel);
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

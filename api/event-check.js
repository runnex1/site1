/**
 * POST /api/event-check
 *
 * Single authority for event alert checking.
 * Called by:
 *   - Browser (terminalCheckEventAlert) — while website is open
 *   - check-alerts.js (cron) — when website is closed
 *
 * Both paths use identical logic and produce identical results.
 *
 * Body: { condition, label, alertId? }
 *   alertId — when provided, marks the alert triggered in KV and sends TG
 *
 * Returns: { triggered, verdict, source, headlines }
 */

const { kvGet, kvSet } = require('../lib/kv');

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

  const query = (condition || label).slice(0, 100);

  // ── AI helper (OpenAI-compatible endpoint) ────────────────────────────────
  async function askAI({ url, apiKey, model, systemPrompt, userPrompt }) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
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
      let errMsg = 'HTTP ' + r.status;
      try { const b = await r.json(); errMsg += ' — ' + (b?.error?.message || JSON.stringify(b)); } catch(e) {}
      throw new Error(errMsg);
    }
    const data = await r.json();
    return (data.choices?.[0]?.message?.content || '').trim().toUpperCase().slice(0, 10);
  }

  async function askGroq(systemPrompt, userPrompt) {
    if (!GROQ_KEY) return null;
    try {
      return await askAI({
        url:    'https://api.groq.com/openai/v1/chat/completions',
        apiKey: GROQ_KEY,
        model:  'llama-3.3-70b-versatile',
        systemPrompt, userPrompt,
      });
    } catch (e) {
      console.error('[event-check] Groq error:', e.message);
      return null;
    }
  }

  async function askGemini(systemPrompt, userPrompt) {
    if (!GEMINI_KEY) return null;
    try {
      return await askAI({
        url:    'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
        apiKey: GEMINI_KEY,
        model:  'gemini-2.0-flash',
        systemPrompt, userPrompt,
      });
    } catch (e) {
      console.error('[event-check] Gemini error:', e.message);
      return null;
    }
  }

  async function askBoth(systemPrompt, userPrompt) {
    const [groqV, geminiV] = await Promise.all([
      askGroq(systemPrompt, userPrompt),
      askGemini(systemPrompt, userPrompt),
    ]);
    console.log('[event-check] Groq: ' + groqV + ' | Gemini: ' + geminiV);
    const triggered = groqV?.startsWith('YES') || geminiV?.startsWith('YES');
    return { triggered, verdict: triggered ? 'YES' : (groqV || geminiV || 'ERROR'), groqV, geminiV };
  }

  const SYSTEM_FACTUAL = 'You are a factual assistant. Answer only YES, NO, or UNSURE. Never refuse or add caveats.';
  const SYSTEM_VERIFY  = 'You are a factual news verification assistant. Answer only YES or NO. Never refuse or add caveats.';

  // ── Step 1: Prior knowledge check ────────────────────────────────────────
  // Either AI saying YES is enough — both saying NO means skip to headlines.
  // UNSURE from one or both → proceed to headlines (don't block on uncertainty).
  const priorResult = await askBoth(
    SYSTEM_FACTUAL,
    'Today is ' + new Date().toDateString() + '. Based on your knowledge, is this condition currently true? Condition: "' + query + '". Answer YES if true or very likely true given current date, NO if clearly false, UNSURE if uncertain. For well-known public figures and their roles, be confident.'
  );

  let triggered = false;
  let verdict   = 'NO';
  let source    = 'prior_knowledge';
  let headlines = [];

  if (priorResult.triggered) {
    triggered = true;
    verdict   = 'YES';
  } else {
    // ── Step 2: Fetch live news headlines ───────────────────────────────────
    // Use 3 targeted searches: full query, key entity name, and entity + "president"
    const words   = query.split(/\s+/).filter(w => w.length > 2);
    const keyName = words.slice(0, 3).join(' '); // first 3 meaningful words
    const searchQuery  = encodeURIComponent(query);
    const searchShort  = encodeURIComponent(keyName);
    const RSS_SOURCES = [
      'https://news.google.com/rss/search?q=' + searchQuery + '&hl=en-US&gl=US&ceid=US:en',
      'https://news.google.com/rss/search?q=' + searchShort + '&hl=en-US&gl=US&ceid=US:en',
      'https://feeds.reuters.com/reuters/topNews',
      'https://feeds.reuters.com/reuters/worldNews',
      'https://feeds.bbci.co.uk/news/world/rss.xml',
      'https://rss.nytimes.com/services/xml/rss/nyt/World.xml',
    ];

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
      verdict = 'NO_NEWS';
    } else {
      // ── Step 3: Ask both AIs with live headlines ──────────────────────────
      const headlineResult = await askBoth(
        SYSTEM_VERIFY,
        'Today is ' + new Date().toDateString() + '. Is the following condition currently true based on these recent news headlines? Condition: "' + query + '". Headlines:\n' + headlines.slice(0, 30).join('\n') + '\nIf any headline confirms the condition is true, say YES. If headlines clearly contradict it, say NO. One word only: YES or NO.'
      );
      triggered = headlineResult.triggered;
      verdict   = headlineResult.verdict;
      source    = 'headlines';
    }
  }

  // ── If triggered: send TG + mark in KV (single authority) ────────────────
  if (triggered && alertId && TG_TOKEN && TG_CHAT_ID) {
    try {
      // Mark alert as triggered in KV
      const stored = await kvGet(ALERTS_KEY);
      const alerts = stored ? (typeof stored === 'string' ? JSON.parse(stored) : stored) : [];
      const alert  = alerts.find(a => a.id === alertId);

      if (alert && !alert.tgSent) {
        const nowStr = new Date().toUTCString();
        const msg = [
          '🔔 <b>Event Alert — ' + (alert.label || query) + '</b>',
          '',
          '<b>Condition:</b> ' + query,
          '<b>Source:</b> ' + source,
          '',
          '<i>' + nowStr + '</i>',
        ].join('\n');

        await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: TG_CHAT_ID, text: msg, parse_mode: 'HTML' }),
        });

        alert.triggered = true;
        alert.tgSent    = true;
        await kvSet(ALERTS_KEY, JSON.stringify(alerts));
        console.log('[event-check] Fired + TG sent for:', alert.label);
      }
    } catch (e) {
      console.error('[event-check] KV/TG error:', e.message);
    }
  }

  return res.status(200).json({
    triggered, verdict, source,
    headlines: headlines.slice(0, 5),
  });
};

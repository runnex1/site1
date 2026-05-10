/**
 * POST /api/ai
 *
 * Unified AI endpoint. Browser sends messages here instead of calling
 * Groq/Gemini directly. Server tries Groq first, falls back to Gemini.
 * API keys never leave the server.
 *
 * Body: { messages: [...], system?: string, temperature?: number }
 * Response: { ok: true, text: "..." }
 */

const GROQ_KEY   = process.env.GROQ_API_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GROQ_MODEL   = 'llama-3.3-70b-versatile';
const GEMINI_MODEL = 'gemini-2.5-flash';

async function callGroq(messages, temperature) {
  if (!GROQ_KEY) throw new Error('GROQ_API_KEY not set');
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_KEY },
    body: JSON.stringify({ model: GROQ_MODEL, temperature, messages }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) {
    let errMsg = 'Groq HTTP ' + r.status;
    try { const b = await r.json(); errMsg += ' — ' + (b?.error?.message || JSON.stringify(b)); } catch (e) {}
    throw new Error(errMsg);
  }
  const data = await r.json();
  const text = (data.choices?.[0]?.message?.content || '').trim();
  if (!text || text.toLowerCase().includes("i can't help") || text.toLowerCase().includes("i cannot help")) {
    throw new Error('Groq refused');
  }
  return text;
}

async function callGemini(messages, system, temperature) {
  if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY not set');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent?key=' + GEMINI_KEY;
  const body = {
    contents: messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
    generationConfig: { temperature },
  };
  if (system) {
    body.system_instruction = { parts: [{ text: system }] };
  }
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) {
    let errMsg = 'Gemini HTTP ' + r.status;
    try { const b = await r.json(); errMsg += ' — ' + JSON.stringify(b); } catch (e) {}
    throw new Error(errMsg);
  }
  const data = await r.json();
  return (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-sync-secret');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) {
      return res.status(400).json({ error: 'Invalid JSON' });
    }
  }

  const messages     = body?.messages;
  const system       = body?.system || '';
  const temperature  = body?.temperature ?? 0.2;

  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: 'messages required' });
  }

  // Build full messages array with system prompt
  const fullMessages = system
    ? [{ role: 'system', content: system }, ...messages]
    : messages;

  // Try Groq first, fall back to Gemini
  let text = '';
  let provider = '';

  try {
    text     = await callGroq(fullMessages, temperature);
    provider = 'groq';
  } catch (groqErr) {
    console.warn('[ai] Groq failed (' + groqErr.message + '), trying Gemini...');
    try {
      text     = await callGemini(messages, system, temperature);
      provider = 'gemini';
    } catch (geminiErr) {
      console.error('[ai] Both AI providers failed:', geminiErr.message);
      return res.status(503).json({ error: 'AI unavailable', groq: groqErr.message, gemini: geminiErr.message });
    }
  }

  return res.status(200).json({ ok: true, text, provider });
};

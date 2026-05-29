const { answerPriceQuestion } = require('../lib/price-answer');
const { isPolymarketOddsQuestion, answerPolymarketOddsQuestion } = require('../lib/pm');
const { fetchMovers, fetchTrades, formatActivityForPrompt } = require('../lib/activity');

function isPortfolioQuestion(q) {
  return /\b(my\s+position|my\s+trade|my\s+portfolio|position.*moved|movers?|filled\s+order|limit\s+order.*filled|what.*i.*trade|my\s+p&?l|my\s+activity)\b/i.test(q);
}

async function answerGeneralQuestion(question) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return null;
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      signal: AbortSignal.timeout(12000),
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        temperature: 0.1,
        max_tokens: 180,
        messages: [{ role: 'user', content: 'Answer briefly and directly: ' + question }]
      })
    });
    if (!r.ok) return null;
    return (await r.json()).choices?.[0]?.message?.content?.trim() || null;
  } catch { return null; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).json({ error: 'POST or GET only' });

  const question = req.method === 'GET' ? String(req.query?.q || req.query?.question || '') : (req.body || {}).question;
  if (!question) return res.status(400).json({ error: 'question required' });

  const priceAnswer = await answerPriceQuestion(question);
  if (priceAnswer) return res.status(200).json(priceAnswer);

  if (isPolymarketOddsQuestion(question)) return res.status(200).json(await answerPolymarketOddsQuestion(question));

  if (req.method === 'GET') return res.status(200).json({ ok: false, answer: 'GET supports price and market-odds questions.', headlines: [], sources: [] });

  if (isPortfolioQuestion(question)) {
    try {
      const [movers, trades] = await Promise.all([fetchMovers(), fetchTrades()]);
      if (movers.length || trades.length) return res.status(200).json({ ok: true, answer: formatActivityForPrompt(movers, trades).replace('POLYMARKET PORTFOLIO ACTIVITY (last 24h):', 'Polymarket activity (last 24h):').trim(), headlines: [], sources: [] });
    } catch {}
  }

  return res.status(200).json({ ok: true, answer: await answerGeneralQuestion(question) || 'I do not have enough live data to answer that right now.', headlines: [], sources: [] });
};

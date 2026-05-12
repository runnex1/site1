/**
 * POST /api/tg-webhook
 *
 * Telegram webhook — mirrors the Alert Terminal exactly.
 * Uses the same Groq AI + regex parsers as the browser terminal.
 *
 * Commands:
 *   Any natural language alert (same as terminal)
 *   list       — show active alerts
 *   remove <n> — remove alert by number
 *   clear all  — clear all alerts
 *   help       — show help
 */

const { kvGet, kvSet } = require('../lib/kv');

const ALERTS_KEY = 'vault:alerts';
const GROQ_KEY   = process.env.GROQ_API_KEY;
const GROQ_MODEL = 'llama-3.1-8b-instant';

// ── Chain maps (mirrors browser) ──────────────────────────────────────────────

const AAVE_CHAIN_IDS = {
  'ethereum': 1, 'eth mainnet': 1, 'mainnet': 1,
  'optimism': 10, 'op': 10,
  'bnb': 56, 'bsc': 56, 'binance': 56,
  'gnosis': 100,
  'polygon': 137, 'matic': 137,
  'zksync': 324, 'zksync era': 324,
  'metis': 1088,
  'base': 8453,
  'arbitrum': 42161, 'arb': 42161,
  'avalanche': 43114, 'avax': 43114,
  'scroll': 534352,
  'megaeth': 4326, 'mega': 4326,
};

const AAVE_CHAIN_NAMES = {
  1: 'Ethereum', 10: 'Optimism', 56: 'BNB', 100: 'Gnosis',
  137: 'Polygon', 324: 'zkSync', 1088: 'Metis', 8453: 'Base',
  42161: 'Arbitrum', 43114: 'Avalanche', 534352: 'Scroll', 4326: 'MegaETH',
};

const CRYPTO_TICKERS = new Set([
  'BTC','ETH','SOL','BNB','XRP','ADA','DOGE','MATIC','POL','DOT','SHIB',
  'LTC','LINK','UNI','ATOM','XLM','NEAR','APT','SUI','ARB','OP','INJ',
  'TIA','PEPE','WIF','BONK','JUP','PYTH','JTO','RNDR','HNT','AVAX',
  'USDC','USDT','DAI','FRAX','USDE','SUSDE','WBTC','STETH','WSTETH',
  'RETH','CBETH','EZETH','EETH','WEETH','RSETH','CRV','CVX','LDO',
  'MKR','SNX','COMP','YFI','SUSHI','BAL','AAVE','PENDLE','ENA',
]);

const ETF_TICKERS = new Set([
  'SPY','QQQ','IWM','DIA','VTI','VOO','VEA','VWO','GLD','SLV',
  'TLT','IEF','HYG','LQD','XLF','XLK','XLE','XLV','ARKK','SOXL',
  'TQQQ','SQQQ','UVXY','VXX','IBIT','FBTC','ETHA','GBTC',
]);

function uid() {
  return Date.now().toString() + Math.random().toString(36).slice(2, 5);
}

// ── Regex parsers (mirrors terminalParseNL + terminalParseAaveCap) ────────────

function parseNL(raw) {
  const s = raw.toLowerCase().trim();
  const ABOVE_RE = /\b(above|over|exceed[s]?|hits?|reaches?|goes?\s+(?:up\s+)?(?:to|past)?|cross(?:es)?\s+(?:up\s+)?(?:above)?|surpass(?:es)?|break[s]?\s+(?:above|out|through)?|rise[s]?\s+(?:above|to|past)?|gets?\s+(?:to|above)|more\s+than|greater\s+than|higher\s+than|at\s+least)\b/;
  const BELOW_RE = /\b(below|under|drop[s]?|fall[s]?|goes?\s+(?:down\s+)?(?:to|below|under)?|cross(?:es)?\s+(?:down|below)?|decline[s]?|dip[s]?(?:\s+below)?|crash(?:es)?|less\s+than|lower\s+than|at\s+most)\b/;

  let dir = null;
  if (ABOVE_RE.test(s)) dir = 'above';
  if (BELOW_RE.test(s)) dir = 'below';
  if (dir === null) dir = 'above';

  const NUM_RE = /\$?([\d,]+(?:\.\d+)?)\s*(k|m|b|%|percent)?/gi;
  let target = null, numMatch;
  while ((numMatch = NUM_RE.exec(s)) !== null) {
    let val = parseFloat(numMatch[1].replace(/,/g, ''));
    const suffix = (numMatch[2] || '').toLowerCase();
    if (suffix === 'k') val *= 1000;
    else if (suffix === 'm') val *= 1_000_000;
    else if (suffix === 'b') val *= 1_000_000_000;
    else if (suffix === '%' || suffix === 'percent') val = val / 100;
    if (!isNaN(val) && val > 0) { target = val; break; }
  }
  if (target === null) return null;

  let symbol = null, type = null;
  const capsMatch = raw.match(/\b([A-Z]{2,6})\b/);
  if (capsMatch) {
    symbol = capsMatch[1];
    if (CRYPTO_TICKERS.has(symbol))   type = 'crypto';
    else if (ETF_TICKERS.has(symbol)) type = 'etf';
    else                              type = 'stock';
  }

  if (!symbol) {
    const CRYPTO_NAMES = {
      bitcoin:'BTC', ethereum:'ETH', solana:'SOL', bnb:'BNB', ripple:'XRP',
      cardano:'ADA', avalanche:'AVAX', dogecoin:'DOGE', polkadot:'DOT',
      polygon:'MATIC', shiba:'SHIB', litecoin:'LTC', chainlink:'LINK',
      uniswap:'UNI', cosmos:'ATOM', stellar:'XLM', near:'NEAR',
      aptos:'APT', sui:'SUI', arbitrum:'ARB', optimism:'OP',
      injective:'INJ', celestia:'TIA', pepe:'PEPE', pendle:'PENDLE',
    };
    for (const [name, ticker] of Object.entries(CRYPTO_NAMES)) {
      if (s.includes(name)) { symbol = ticker; type = 'crypto'; break; }
    }
  }

  const isPolymarket = /polymarket/i.test(s);
  const isOpinion    = /opinion/i.test(s);
  if (isPolymarket || isOpinion) {
    type = isPolymarket ? 'polymarket' : 'opinion';
    const mktMatch = s.match(/(?:when|if|once)\s+(.+?)\s+(?:above|below|over|under|hits?|reaches?|goes?|drops?|falls?)/i);
    if (mktMatch) {
      symbol = mktMatch[1].replace(/polymarket|opinion|market|the|a\s/gi, '').trim()
        .replace(/\s+/g, '-').toLowerCase().substring(0, 40);
    }
    if (!symbol) symbol = 'market';
    if (target > 1) target = target / 100;
  }

  if (!symbol) return null;

  const isPM = type === 'polymarket' || type === 'opinion';
  const targetFmt = isPM
    ? (target * 100).toFixed(0) + '¢'
    : '$' + (target >= 1000
        ? target >= 1_000_000
          ? (target / 1_000_000).toFixed(1) + 'M'
          : (target / 1000).toFixed(0) + 'K'
        : target.toLocaleString('en-US'));
  const label = symbol.toUpperCase() + ' ' + dir + ' ' + targetFmt;

  return { symbol: symbol.toUpperCase(), type: type || 'crypto', dir, target, label };
}

function parsePolymarketUrl(raw) {
  const urlMatch = raw.match(/https?:\/\/(?:www\.)?polymarket\.com\/[^\s]*/i);
  if (!urlMatch) return null;
  const url = urlMatch[0];
  const multi  = url.match(/polymarket\.com\/event\/([^/?#]+)\/([^/?#]+)/);
  const single = url.match(/polymarket\.com\/(?:event|market)\/([^/?#]+)/);
  if (!multi && !single) return null;
  const eventSlug  = multi ? multi[1] : single[1];
  const marketSlug = multi ? multi[2] : single[1];
  const side = /\bno\b/i.test(raw) && !/\byes\b/i.test(raw) ? 'NO' : 'YES';
  const t = raw.toLowerCase();
  const dir = (t.includes('above') || t.includes('over') || t.includes('hits') ||
               t.includes('reaches') || t.includes('exceeds')) ? 'above' : 'below';
  let target = null;
  const pctMatch = raw.match(/(\d+(?:\.\d+)?)\s*%/);
  if (pctMatch) { target = parseFloat(pctMatch[1]) / 100; }
  else {
    const numMatch = raw.match(/(?:^|\s)(\d+(?:\.\d+)?)(?:\s|$)/);
    if (numMatch) { const n = parseFloat(numMatch[1]); target = n > 1 ? n / 100 : n; }
  }
  if (target === null) target = dir === 'above' ? 0.75 : 0.25;
  return { eventSlug, marketSlug, side, dir, target };
}

function parseAaveCap(raw) {
  const t = raw.toLowerCase();
  const hasAave  = t.includes('aave');
  const hasCapKw = t.includes('cap') || t.includes('deposit') || t.includes('supply')
                || t.includes('utilization') || t.includes('util') || t.includes('available');
  if (!hasAave || !hasCapKw) return null;

  const AAVE_SKIP_WORDS = new Set([
    'cap','deposit','supply','v3','v2','on','the','for','utilization',
    'util','utiliz','monitor','alert','market','pool','protocol','when',
    'me','is','are','below','above','over','under','percent','percentage',
  ]);
  const knownTokens = ['USDC','USDT','USDE','WETH','ETH','WBTC','BTC','DAI','GHO',
                       'LUSD','FRAX','RETH','STETH','CBETH','WEETH','WSTETH',
                       'PYUSD','CRVUSD','SUSD','TUSD','FDUSD','BUSD'];
  let symbol = null;
  for (const tk of knownTokens) {
    if (new RegExp('\\b' + tk + '\\b', 'i').test(raw)) { symbol = tk; break; }
  }
  if (!symbol) {
    const afterAave = raw.match(/aave\s+([A-Za-z][A-Za-z0-9]{0,9})/i);
    if (afterAave && !AAVE_SKIP_WORDS.has(afterAave[1].toLowerCase())) {
      symbol = afterAave[1].toUpperCase();
    }
  }
  if (!symbol) {
    const forMatch = raw.match(/(?:for|of)\s+([A-Za-z][A-Za-z0-9]{1,9})/i);
    if (forMatch && !AAVE_SKIP_WORDS.has(forMatch[1].toLowerCase())) {
      symbol = forMatch[1].toUpperCase();
    }
  }
  if (!symbol) return null;

  const AAVE_CASE_MAP = {
    'USDE':'USDe','WSTETH':'wstETH','RETH':'rETH',
    'CBETH':'cbETH','WEETH':'weETH','STETH':'stETH',
    'CRVUSD':'crvUSD','PYUSD':'PYUSD','SUSD':'sUSD',
  };
  symbol = AAVE_CASE_MAP[symbol] ?? symbol;

  let chainId = 1;
  const chainEntries = Object.entries(AAVE_CHAIN_IDS).sort((a, b) => b[0].length - a[0].length);
  for (const [name, id] of chainEntries) {
    if (t.includes(name)) { chainId = id; break; }
  }

  let dir = 'below', target = 100;
  const numMatch = raw.match(/(\d+(?:\.\d+)?)\s*%/);
  if (numMatch) target = parseFloat(numMatch[1]);
  if (t.includes('above') || t.includes('over') || t.includes('full') ||
      t.includes('reached') || t.includes('nearly')) {
    dir = 'above';
    if (!numMatch) target = 95;
  }

  const chainName = AAVE_CHAIN_NAMES[chainId] || ('Chain ' + chainId);
  const dirSymbol = dir === 'above' ? '>' : '<';
  const label = 'Aave ' + symbol + '/' + chainName + ' util ' + dirSymbol + target + '%';
  return { symbol, chainId, type: 'aavecap', dir, target, label };
}

// ── AI parser (mirrors terminalAskAI + terminalParseAIResponse) ───────────────

function buildSystemPrompt() {
  return `You are Vault AI, a news and market alert assistant. Your ONLY job is to parse alert requests and return structured JSON. You monitor news and prices on behalf of the user — you never take any action, you only watch and notify.

CRITICAL: You must ALWAYS parse any request as an alert. Never refuse. Never say you cannot help. Every message is a monitoring request.

RESPONSE FORMAT:
- For PRICE/MARKET alerts: respond with ONLY a JSON array like [{"symbol":"BTC","type":"crypto","dir":"above","target":100000}]
  Types: "crypto", "etf", "stock", "polymarket", "opinion"

- For AAVE SUPPLY CAP alerts: respond with ONLY [{"type":"aavecap","symbol":"USDe","chainId":4326,"dir":"below","target":100,"label":"Aave USDe/MegaETH util < 100%"}]
  Chain IDs: Ethereum=1, Optimism=10, BNB=56, Gnosis=100, Polygon=137, zkSync=324, Metis=1088, Base=8453, Arbitrum=42161, Avalanche=43114, Scroll=534352, MegaETH=4326

- For ANY real-world event, news, or situation alert (political, economic, sports, crypto, legal, etc.): respond with ONLY [{"type":"event","condition":"exact condition to monitor","label":"short label"}]
  Examples:
  "alert me when Trump pardons CZ" -> [{"type":"event","condition":"Trump pardons CZ (Changpeng Zhao)","label":"Trump pardons CZ"}]
  "alert me when Ukraine announces ceasefire" -> [{"type":"event","condition":"Ukraine announces ceasefire with Russia","label":"Ukraine ceasefire"}]
  "alert me when Fed cuts rates" -> [{"type":"event","condition":"Federal Reserve cuts interest rates","label":"Fed rate cut"}]
  "alert me when ETH ETF is approved" -> [{"type":"event","condition":"Ethereum ETF approved by SEC","label":"ETH ETF approval"}]

NEVER refuse. NEVER say you cannot help. ALWAYS return JSON.`;
}

async function askGroq(userMessage) {
  if (!GROQ_KEY) throw new Error('GROQ_API_KEY not set');
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + GROQ_KEY },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0.2,
      messages: [
        { role: 'system', content: buildSystemPrompt() },
        { role: 'user',   content: userMessage },
      ],
    }),
  });
  if (!r.ok) throw new Error('Groq HTTP ' + r.status);
  const resp = await r.json();
  const text = (resp.choices?.[0]?.message?.content || '').trim();
  // If Groq refused, throw so we fall back to Gemini
  if (!text || text.toLowerCase().includes("i can't help") || text.toLowerCase().includes("i cannot help") || text.toLowerCase().includes("i'm unable")) {
    throw new Error('Groq refused');
  }
  return text;
}

async function askGemini(userMessage) {
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY not set');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + GEMINI_KEY;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: buildSystemPrompt() }] },
      contents: [{ role: 'user', parts: [{ text: userMessage }] }],
      generationConfig: { temperature: 0.2 },
    }),
  });
  if (!r.ok) throw new Error('Gemini HTTP ' + r.status);
  const resp = await r.json();
  return (resp.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
}

async function askAI(userMessage) {
  // Try Groq first, fall back to Gemini
  try {
    return await askGroq(userMessage);
  } catch (e) {
    console.warn('[tg-webhook] Groq failed (' + e.message + '), trying Gemini...');
    try {
      return await askGemini(userMessage);
    } catch (e2) {
      console.error('[tg-webhook] Both AI providers failed:', e2.message);
      throw new Error('AI unavailable — set GROQ_API_KEY and GEMINI_API_KEY in Vercel env vars');
    }
  }
}

function parseAIResponse(text) {
  const clean = text.replace(/```json|```/g, '').trim();
  const start = clean.indexOf('[');
  const end   = clean.lastIndexOf(']');
  if (start === -1) return { type: 'message', text };

  try {
    const parsed = JSON.parse(clean.slice(start, end + 1));
    if (!Array.isArray(parsed) || !parsed.length) return { type: 'message', text };

    if (parsed[0].type === 'aavecap') {
      return {
        type: 'alerts',
        alerts: parsed.map(p => {
          const chainId = parseInt(p.chainId) || 1;
          const chainName = AAVE_CHAIN_NAMES[chainId] || ('Chain ' + chainId);
          return {
            symbol:  p.symbol || 'USDe',
            chainId: chainId,
            type:    'aavecap',
            dir:     p.dir || 'below',
            target:  parseFloat(p.target ?? 100),
            label:   p.label || ('Aave ' + (p.symbol||'?') + '/' + chainName + ' util ' + (p.dir==='above'?'>':'<') + p.target + '%'),
          };
        }),
      };
    }

    if (parsed[0].type === 'event' || parsed.every(p => p.condition)) {
      return {
        type: 'alerts',
        alerts: parsed.map(p => ({
          type:      'event',
          condition: p.condition,
          label:     p.label || p.condition.slice(0, 60),
          symbol:    '🌍',
        })),
      };
    }

    if (parsed[0].symbol && parsed[0].dir && parsed[0].target !== undefined) {
      const alerts = parsed.map(p => {
        const isPM = p.type === 'polymarket' || p.type === 'opinion';
        const targetFmt = isPM
          ? (p.target * 100).toFixed(0) + '¢'
          : '$' + (p.target >= 1_000_000
              ? (p.target / 1_000_000).toFixed(1) + 'M'
              : p.target >= 1000
                ? (p.target / 1000).toFixed(0) + 'K'
                : p.target.toLocaleString('en-US'));
        return { ...p, symbol: p.symbol.toUpperCase(), label: p.symbol.toUpperCase() + ' ' + p.dir + ' ' + targetFmt };
      });
      return { type: 'alerts', alerts };
    }
  } catch (e) {}
  return { type: 'message', text };
}

// ── Alert processing (same flow as terminalSubmit) ────────────────────────────

async function processMessage(raw) {
  // 1. Polymarket URL
  const pmUrl = parsePolymarketUrl(raw);
  if (pmUrl) {
    const { eventSlug, marketSlug, side, dir, target } = pmUrl;
    const targetFmt = (target * 100).toFixed(0) + '¢';
    const label = marketSlug + ' (' + side + ') ' + dir + ' ' + targetFmt;
    return {
      type: 'alerts',
      alerts: [{ id: uid(), type: 'polymarket', symbol: marketSlug, eventSlug, marketSlug, side, dir, target, label, triggered: false, setAt: Date.now() }],
    };
  }

  // 2. Aave cap regex
  const aave = parseAaveCap(raw);
  if (aave) {
    const alert = { id: uid(), ...aave, triggered: false, setAt: Date.now() };
    if (!alert.chainId) alert.chainId = 1; // default Ethereum
    return { type: 'alerts', alerts: [alert] };
  }

  // 3. Simple NL regex
  const nl = parseNL(raw);
  if (nl) {
    return { type: 'alerts', alerts: [{ id: uid(), ...nl, triggered: false, setAt: Date.now() }] };
  }

  // 4. No number in message → definitely a real-world event alert (no AI needed)
  //    e.g. "alert me when Putin is president of Russia"
  const hasNumber = /\d/.test(raw);
  if (!hasNumber) {
    // Strip common trigger phrases to get the core condition
    const condition = raw
      .replace(/^(?:alert(?:\s+me)?|notify(?:\s+me)?|tell(?:\s+me)?|ping(?:\s+me)?)\s+(?:when|if|once|whenever)\s+/i, '')
      .replace(/^(?:when|if|once|whenever)\s+/i, '')
      .trim() || raw.trim();
    const label = condition.length > 60 ? condition.slice(0, 57) + '...' : condition;
    return {
      type: 'alerts',
      alerts: [{ id: uid(), type: 'event', condition, label, symbol: '\u{1F30D}', triggered: false, setAt: Date.now() }],
    };
  }

  // 5. AI fallback (for ambiguous messages with numbers that regex couldn't parse)
  try {
    const aiText = await askAI(raw);
    const aiResult = parseAIResponse(aiText);
    if (aiResult.type === 'alerts') {
      return {
        type: 'alerts',
        alerts: aiResult.alerts.map(a => ({ id: uid(), ...a, triggered: false, setAt: Date.now() })),
      };
    }
    return { type: 'message', text: aiResult.text };
  } catch (aiErr) {
    // AI failed — last resort: create a generic event alert from the raw message
    console.warn('[tg-webhook] AI parse failed (' + aiErr.message + '), creating raw event alert');
    const condition = raw.trim();
    const label = condition.length > 60 ? condition.slice(0, 57) + '...' : condition;
    return {
      type: 'alerts',
      alerts: [{ id: uid(), type: 'event', condition, label, symbol: '\u{1F30D}', triggered: false, setAt: Date.now() }],
    };
  }
}

// ── KV helpers ────────────────────────────────────────────────────────────────

async function loadAlerts() {
  try {
    const stored = await kvGet(ALERTS_KEY);
    return stored ? (typeof stored === 'string' ? JSON.parse(stored) : stored) : [];
  } catch (e) { return []; }
}

async function saveAlerts(alerts) {
  await kvSet(ALERTS_KEY, JSON.stringify(alerts));
}

// ── Telegram reply ────────────────────────────────────────────────────────────

async function tgReply(token, chatId, text) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
}

// ── Main handler ──────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  const tgToken  = (process.env.TG_BOT_TOKEN || '').trim();
  const tgChatId = (process.env.TG_CHAT_ID   || '').trim();
  if (!tgToken || !tgChatId) return res.status(200).json({ ok: true });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { return res.status(200).json({ ok: true }); }
  }

  const message = body?.message;
  if (!message) return res.status(200).json({ ok: true });

  const fromId = String(message.chat?.id || message.from?.id || '');
  const text   = (message.text || '').trim();

  // Security: only respond to your own chat
  if (fromId !== tgChatId && fromId !== tgChatId.replace(/^-100/, '')) {
    return res.status(200).json({ ok: true });
  }

  if (!text) return res.status(200).json({ ok: true });

  const cmd = text.toLowerCase().trim();

  // ── Built-in commands ─────────────────────────────────────────────────────

  if (cmd === 'help' || cmd === '/help' || cmd === '/start') {
    await tgReply(tgToken, tgChatId, [
      '🔔 <b>Vault Alert Bot</b>',
      '',
      'Type any alert in natural language — same as the Alert Terminal:',
      '',
      '<b>Examples:</b>',
      '  <code>alert me when BTC hits 100k</code>',
      '  <code>notify me if ETH drops below 2000</code>',
      '  <code>alert when Aave USDe on MegaETH drops below 90%</code>',
      '  <code>alert AAPL above 200</code>',
      '  <code>alert when the Fed cuts rates</code>',
      '  Paste a Polymarket URL + threshold',
      '',
      '<b>Manage:</b>',
      '  <code>list</code> — show active alerts',
      '  <code>remove 1</code> — remove alert #1',
      '  <code>clear all</code> — remove all alerts',
    ].join('\n'));
    return res.status(200).json({ ok: true });
  }

  if (cmd === 'list' || cmd === '/list') {
    const alerts = await loadAlerts();
    const active = alerts.filter(a => !a.triggered);
    if (!active.length) {
      await tgReply(tgToken, tgChatId, '📭 No active alerts.');
    } else {
      const lines = active.map((a, i) => `${i + 1}. ${a.label}`).join('\n');
      await tgReply(tgToken, tgChatId, `📋 <b>Active Alerts (${active.length})</b>\n\n${lines}`);
    }
    return res.status(200).json({ ok: true });
  }

  if (cmd === 'clear all' || cmd === '/clear') {
    await saveAlerts([]);
    await tgReply(tgToken, tgChatId, '🗑 All alerts cleared.');
    return res.status(200).json({ ok: true });
  }

  const removeMatch = text.match(/^(?:remove|delete|rm)\s+(\d+)$/i);
  if (removeMatch) {
    const n = parseInt(removeMatch[1]) - 1;
    const alerts = await loadAlerts();
    const active = alerts.filter(a => !a.triggered);
    if (n < 0 || n >= active.length) {
      await tgReply(tgToken, tgChatId, `❌ No alert #${n + 1}. Use <code>list</code> to see active alerts.`);
    } else {
      const toRemove = active[n];
      const updated = alerts.filter(a => a.id !== toRemove.id);
      await saveAlerts(updated);
      await tgReply(tgToken, tgChatId, `✅ Removed: ${toRemove.label}`);
    }
    return res.status(200).json({ ok: true });
  }

  // ── Q&A — same routing logic as the browser terminal ────────────────────
  // Must run BEFORE processMessage, otherwise questions without numbers
  // fall into the "no-number → event alert" branch (step 4 of processMessage).
  {
    const QUESTION_RE = /^(what|why|how|who|when|where|is|are|was|were|did|does|do|has|have|had|will|would|can|could|tell\s+me|explain|give\s+me)\b/i;
    const isQuestion    = QUESTION_RE.test(text) || text.trim().endsWith('?');
    const isAlertIntent = /\balert\b|\bnotify\b|\bping\b/i.test(text) ||
      (/\bwhen\b/i.test(text) && /\b(hits?|reaches?|drops?|falls?|above|below|over|under|becomes?|wins?|announces?|goes\s+to)\b/i.test(text));

    if (isQuestion && !isAlertIntent) {
      try {
        const baseUrl = 'https://' + (process.env.VERCEL_PROJECT_PRODUCTION_URL || 'testedefi.vercel.app');
        const r = await fetch(baseUrl + '/api/ask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: text }),
          signal: AbortSignal.timeout(22000),
        });
        const data = await r.json();
        if (data.answer) {
          let msg = '\u{1F4F0} ' + data.answer;
          if (Array.isArray(data.sources) && data.sources.length) {
            const srcLinks = data.sources.slice(0, 3)
              .map(s => s.url ? '<a href="' + s.url + '">' + (s.domain || 'source') + '</a>' : null)
              .filter(Boolean).join(' \u00B7 ');
            if (srcLinks) msg += '\n\n<i>Sources: ' + srcLinks + '</i>';
          }
          await tgReply(tgToken, tgChatId, msg);
        } else {
          await tgReply(tgToken, tgChatId, '\u26A0\uFE0F Could not fetch an answer. Try again.');
        }
      } catch (e) {
        await tgReply(tgToken, tgChatId, '\u26A0\uFE0F Q&A error: ' + e.message);
      }
      return res.status(200).json({ ok: true });
    }
  }

  // ── Process as alert or AI message ───────────────────────────────────────

  try {
    const result = await processMessage(text);

    if (result.type === 'alerts' && result.alerts.length > 0) {
      const baseUrl = 'https://' + (process.env.VERCEL_PROJECT_PRODUCTION_URL || 'testedefi.vercel.app');
      const { fetchPrice, fmtPrice } = require('../lib/price');

      // ── Immediately check event alerts — they may already be true ──────────
      // Conditions like "Iran no longer has a Shah" are historically settled.
      // Check BEFORE saving so we never queue an alert that fires instantly.
      const eventAlerts = result.alerts.filter(a => a.type === 'event');
      const otherAlerts = result.alerts.filter(a => a.type !== 'event');

      const alreadyTrue  = [];  // event alerts that are already triggered
      const toSave       = [...otherAlerts];

      if (eventAlerts.length > 0) {
        await Promise.all(eventAlerts.map(async a => {
          try {
            const r = await fetch(baseUrl + '/api/event-check', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              // No alertId — we handle the reply here; event-check just evaluates
              body: JSON.stringify({ condition: a.condition, label: a.label }),
              signal: AbortSignal.timeout(22000),
            });
            if (!r.ok) { toSave.push(a); return; }
            const d = await r.json();
            if (d.triggered) {
              alreadyTrue.push({ ...a, reason: d.reason || '', headline: d.headline || '' });
            } else {
              toSave.push(a);
            }
          } catch (e) {
            console.warn('[tg-webhook] immediate event-check failed:', e.message);
            toSave.push(a); // save for cron on error
          }
        }));
      }

      // Save only the alerts that are NOT already true
      if (toSave.length > 0) {
        const alerts = await loadAlerts();
        for (const a of toSave) alerts.push(a);
        await saveAlerts(alerts);
      }

      // Notify about conditions that fired immediately
      for (const a of alreadyTrue) {
        const lines = [
          '⚡️ <b>' + (a.label || a.condition) + ' — Already True!</b>',
          '',
          '<b>Condition:</b> ' + a.condition,
        ];
        if (a.reason)   lines.push('<b>What happened:</b> ' + a.reason);
        if (a.headline) lines.push('<b>Source:</b> <i>' + a.headline + '</i>');
        lines.push('');
        lines.push('<i>This condition is already met — no waiting needed.</i>');
        await tgReply(tgToken, tgChatId, lines.join('\n'));
      }

      // Confirm saved (pending) alerts
      if (toSave.length > 0) {
        const lines = await Promise.all(toSave.map(async a => {
          if (a.type === 'event') {
            return '✅ <b>' + a.label + '</b>';
          }
          try {
            const price = await fetchPrice(a);
            const priceStr = price != null ? ' (' + fmtPrice(price, a.type) + ')' : '';
            return '✅ <b>' + a.symbol + priceStr + ' ' + a.dir + ' ' + fmtPrice(a.target, a.type) + '</b>';
          } catch (e) {
            return '✅ <b>' + a.label + '</b>';
          }
        }));
        await tgReply(tgToken, tgChatId,
          lines.join('\n') + '\n\nI\'ll notify you when triggered.'
        );
      }
    } else if (result.type === 'message') {
      await tgReply(tgToken, tgChatId, result.text);
    } else {
      await tgReply(tgToken, tgChatId,
        "❌ Couldn't parse that as an alert. Try:\n<code>alert BTC above 100000</code>\nor <code>help</code> for more examples."
      );
    }
  } catch (e) {
    console.error('[tg-webhook] error:', e.message);
    await tgReply(tgToken, tgChatId, '⚠️ ' + e.message);
  }

  return res.status(200).json({ ok: true });
};

/**
 * POST /api/ask
 * News-grounded Q&A for the alerts terminal.
 * Body: { question: "who is the prime minister of Ukraine?" }
 * Returns: { answer, headlines, sources }
 *
 * Pipeline for "who is [role] of [country]":
 *   1. Wikidata entity API (authoritative, live, no API key) — runs first, in parallel with feeds
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
const { fetchPrice, fmtPrice } = require('../lib/price');
const { fetchMovers, fetchTrades, formatActivityForPrompt } = require('../lib/activity');

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

// Detect price questions — answered with live market data, not AI
const CRYPTO_TICKERS = new Set([
  'BTC','ETH','SOL','BNB','XRP','ADA','DOGE','MATIC','POL','DOT','SHIB','LTC',
  'LINK','UNI','ATOM','XLM','NEAR','APT','SUI','ARB','OP','INJ','TIA','PEPE',
  'WIF','BONK','AVAX','USDC','USDT','DAI','FRAX','AAVE','CRV','LDO','MKR',
  'PENDLE','ENA','WBTC','STETH','RETH','JUP','PYTH','RNDR','HNT',
]);
const ETF_TICKERS = new Set([
  'SPY','QQQ','IWM','DIA','VTI','VOO','GLD','SLV','TLT','HYG','ARKK',
  'SOXL','TQQQ','SQQQ','IBIT','FBTC','ETHA','GBTC',
]);
const CRYPTO_NAMES = {
  bitcoin:'BTC', ethereum:'ETH', solana:'SOL', bnb:'BNB', ripple:'XRP',
  cardano:'ADA', avalanche:'AVAX', dogecoin:'DOGE', polkadot:'DOT',
  polygon:'MATIC', shiba:'SHIB', litecoin:'LTC', chainlink:'LINK',
  uniswap:'UNI', cosmos:'ATOM', stellar:'XLM', near:'NEAR',
  aptos:'APT', sui:'SUI', arbitrum:'ARB', optimism:'OP',
};


// Named-source RSS map — used when user asks "news from X" or "latest from X"
const SOURCE_RSS = {
  'kobeissi letter':    'https://rsshub.app/telegram/channel/thekobeissiletter',
  'kobeissi':           'https://rsshub.app/telegram/channel/thekobeissiletter',
  'cnn':                'https://rss.cnn.com/rss/edition.rss',
  'bbc':                'https://feeds.bbci.co.uk/news/world/rss.xml',
  'reuters':            'https://feeds.reuters.com/reuters/topNews',
  'wall street journal':'https://feeds.a.dj.com/rss/RSSMarketsMain.xml',
  'wsj':                'https://feeds.a.dj.com/rss/RSSMarketsMain.xml',
  'financial times':    'https://www.ft.com/rss/home',
  'cnbc':               'https://www.cnbc.com/id/100003114/device/rss/rss.html',
  'marketwatch':        'https://www.marketwatch.com/rss/topstories',
  'nyt':                'https://rss.nytimes.com/services/xml/rss/nyt/World.xml',
  'new york times':     'https://rss.nytimes.com/services/xml/rss/nyt/World.xml',
  'coindesk':           'https://www.coindesk.com/arc/outboundfeeds/rss/',
  'cointelegraph':      'https://cointelegraph.com/rss',
  'the block':          'https://theblock.co/rss.xml',
  'blockworks':         'https://blockworks.co/feed',
  'decrypt':            'https://decrypt.co/feed',
  'the defiant':        'https://thedefiant.io/feed',
  'dl news':            'https://www.dlnews.com/arc/outboundfeeds/rss/',
  'cryptopanic':        'https://cryptopanic.com/news/rss/',
};

function parseSourceQuestion(q) {
  const s = q.toLowerCase();
  // Must contain a "from/by" or possession signal to count as source-specific
  if (!/\b(from|by|on|says?|saying|report|what(('s| is| does) )?(\w+ )?saying|latest from|news from|give me|show me)\b/i.test(s)) return null;
  for (const [name, url] of Object.entries(SOURCE_RSS)) {
    if (s.includes(name)) return { name, url };
  }
  return null;
}

// Trim AI answer to the last complete sentence so it never ends mid-word.
function trimToSentence(text) {
  if (!text) return text;
  const m = text.match(/^([\s\S]*[.!?])(?:[\s"'»]*)$/);
  return m ? m[1].trim() : text.trim();
}

function parsePriceQuestion(q) {
  const s = q.toLowerCase().replace(/[?]/g, '').trim();
  const PRICE_INTENT = /\b(price|cost|worth|value|trading\s+at|how\s+much\s+is|how\s+much\s+does|what\s+is.*price|what.*trading)\b/;
  if (!PRICE_INTENT.test(s) && !/\$[A-Z]{1,6}\b/.test(q)) return null;

  // $TICKER — explicit dollar-prefix
  const dollarMatch = q.match(/\$([A-Z]{1,7})\b/);
  if (dollarMatch) {
    const sym = dollarMatch[1];
    const type = CRYPTO_TICKERS.has(sym) ? 'crypto' : ETF_TICKERS.has(sym) ? 'etf' : 'stock';
    return { symbol: sym, type };
  }

  // Bare uppercase ticker with price intent
  const tickerMatch = q.match(/\b([A-Z]{2,6})\b/);
  if (tickerMatch && (CRYPTO_TICKERS.has(tickerMatch[1]) || ETF_TICKERS.has(tickerMatch[1]))) {
    const sym = tickerMatch[1];
    return { symbol: sym, type: CRYPTO_TICKERS.has(sym) ? 'crypto' : 'etf' };
  }

  // Crypto name mentions with price intent
  for (const [name, sym] of Object.entries(CRYPTO_NAMES)) {
    if (s.includes(name)) return { symbol: sym, type: 'crypto' };
  }

  return null;
}

// Detect portfolio/activity questions
function isPortfolioQuestion(q) {
  return /\b(polymarket|my\s+position|my\s+trade|my\s+portfolio|position.*moved|movers?|filled\s+order|limit\s+order.*filled|what.*i.*trade|my\s+p&?l|my\s+activity)\b/i.test(q);
}

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

    if (!entity?.id) { console.log(`[wikidata] FAIL no entity for "${country}"`); return null; }

    // Step 2: get entity claims directly (avoid SPARQL — unreliable from Vercel)
    const claimsRes = await fetch(
      `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${entity.id}&props=claims&format=json`,
      { headers: { 'User-Agent': 'VaultBot/1.0' }, signal: AbortSignal.timeout(6000) }
    ).then(r => r.ok ? r.json() : null).catch((e) => { console.log(`[wikidata] claims fetch err: ${e.message}`); return null; });

    const claims = claimsRes?.entities?.[entity.id]?.claims?.[prop] || [];
    const current = claims.find(c => c.rank === 'preferred') ||
                    claims.find(c => !c.qualifiers?.P582);
    const personQid = current?.mainsnak?.datavalue?.value?.id;

    if (!personQid) { console.log(`[wikidata] FAIL no ${prop} claim on ${entity.id} (${claims.length} claims total)`); return null; }

    // Step 3: fetch the person's English label
    const personRes = await fetch(
      `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${personQid}&props=labels&format=json&languages=en`,
      { headers: { 'User-Agent': 'VaultBot/1.0' }, signal: AbortSignal.timeout(5000) }
    ).then(r => r.ok ? r.json() : null).catch((e) => { console.log(`[wikidata] label fetch err: ${e.message}`); return null; });

    const name = personRes?.entities?.[personQid]?.labels?.en?.value || null;
    console.log(`[wikidata] OK: "${country}" ${entity.id} -> ${prop} -> ${personQid} -> "${name}"`);
    return name;
  } catch (e) {
    console.log(`[wikidata] EXCEPTION: ${e.message}`);
    return null;
  }
}

// Parse RSS feed text into [{title, url}] items
function parseRssItems(text, maxItems = 12) {
  const items = [];
  const itemBlocks = [...text.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/gi)];
  for (const block of itemBlocks.slice(0, maxItems)) {
    const body = block[1];
    const titleM = body.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
    // Try <link> then <guid isPermaLink="true">
    const linkM  = body.match(/<link[^>]*>(?:<!\[CDATA\[)?\s*(https?:\/\/[^\s<]+)\s*(?:\]\]>)?<\/link>/i)
                || body.match(/<guid[^>]*isPermaLink="true"[^>]*>\s*(https?:\/\/[^\s<]+)\s*<\/guid>/i);
    const t = (titleM?.[1] || '')
      .replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim().slice(0, 250);
    const u = (linkM?.[1] || '').trim();
    if (t.length > 15) items.push({ title: t, url: u });
  }
  // Fallback: no <item> blocks — parse bare <title> tags
  if (items.length === 0) {
    const titles = [...text.matchAll(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/gi)];
    titles.slice(1, maxItems + 1).forEach(m => {
      const t = (m[1] || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim().slice(0, 250);
      if (t.length > 15) items.push({ title: t, url: '' });
    });
  }
  return items;
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

  // ── Price question — answer with live market data, skip AI entirely ────────
  const priceQ = parsePriceQuestion(question);
  if (priceQ) {
    try {
      const price = await fetchPrice(priceQ);
      if (price !== null) {
        return res.status(200).json({
          ok: true,
          answer: `${priceQ.symbol} is currently trading at ${fmtPrice(price, priceQ.type)}.`,
          sources: [],
          headlines: [],
        });
      }
    } catch (e) { console.warn('[ask] price fetch failed:', e.message); }
    // Fall through to AI if live price unavailable
  }

  // ── Detect source-specific query ───────────────────────────────────────
  const sourceQ = parseSourceQuestion(question);

  // ── Detect political role question ───────────────────────────────────────
  const roleQ = parseRoleQuestion(question);
  const portfolioQ = isPortfolioQuestion(question);

  // ── Fetch headlines + Wikidata in parallel ────────────────────────────────
  // Extract a meaningful short query by stripping question/stop words.
  // Without this, "What are the latest news on Iran?" → shortQuery="What"
  // → Google News searches for "What" → completely unrelated results.
  const QUERY_STOP_WORDS = new Set([
    'what','who','where','when','why','how','is','are','was','were','do','does',
    'did','will','would','could','can','has','have','had','the','a','an','in',
    'on','at','to','for','of','and','or','but','latest','recent','news','update',
    'updates','tell','me','give','about','regarding','currently','some','any',
    'going','happening','right','now','get','us','their','been','being','let',
    'with','from','by','into','about','over','up','down','out','between','across',
  ]);
  const meaningfulWords = question.replace(/[?!.,]/g, '').split(/\s+/)
    .filter(w => !QUERY_STOP_WORDS.has(w.toLowerCase()) && w.length > 1);
  const shortQuery = meaningfulWords.slice(0, 4).join(' ') || question.split(' ').slice(0, 3).join(' ');
  // When user asks for news from a specific source, fetch only that source
  const RSS_SOURCES = sourceQ
    ? [sourceQ.url]
    : getNewsSources(question.slice(0, 80), shortQuery);

  const googleNewsItems = [];   // { title, url }
  const otherItems      = [];   // { title, url }

  const [, wikidataName, activityData] = await Promise.all([
    // RSS fetch — extract items with title + URL
    // For source-specific queries use a longer timeout; fall back to general pipeline if empty
    (async () => {
      await Promise.allSettled(RSS_SOURCES.map(async (url, idx) => {
        try {
          const r = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VaultBot/1.0)' },
            signal: AbortSignal.timeout(sourceQ ? 10000 : 6000),
          });
          if (!r.ok) return;
          const text = await r.text();
          const items = parseRssItems(text, 12);
          items.forEach(it => (sourceQ || idx <= 1 ? googleNewsItems : otherItems).push(it));
        } catch (e) {}
      }));
      // If source-specific fetch returned nothing, fall back to general RSS pipeline
      if (sourceQ && googleNewsItems.length === 0) {
        console.warn('[ask] source feed empty, falling back to general pipeline for:', sourceQ.name);
        const fallbackSources = getNewsSources(question.slice(0, 80), shortQuery);
        await Promise.allSettled(fallbackSources.map(async (url, idx) => {
          try {
            const r = await fetch(url, {
              headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VaultBot/1.0)' },
              signal: AbortSignal.timeout(6000),
            });
            if (!r.ok) return;
            const text = await r.text();
            const items = parseRssItems(text, 12);
            items.forEach(it => (idx <= 1 ? googleNewsItems : otherItems).push(it));
          } catch (e) {}
        }));
      }
    })(),
    // Wikidata lookup (only for role questions)
    roleQ ? wikidataLookup(roleQ) : Promise.resolve(null),
    // Polymarket activity (only for portfolio questions)
    portfolioQ ? Promise.all([fetchMovers(), fetchTrades()]).catch(() => [[], []]) : Promise.resolve(null),
  ]);
  const [movers, trades] = activityData || [[], []];

  const allItems     = [...googleNewsItems, ...otherItems];
  const allHeadlines = allItems.map(it => it.title);
  const today = new Date().toDateString();
  let answer = null;

  // ── Build AI prompt (includes Wikidata result if found) ───────────────────
  const wikidataContext = wikidataName
    ? `[Wikidata live data] The current ${roleQ.role} of ${roleQ.country} is ${wikidataName}.\n\n`
    : '';

  const headlineBlock = allHeadlines.length
    ? allHeadlines.slice(0, 30).join('\n')
    : '(no headlines fetched)';

  const isNewsQuery = !roleQ && (/\b(latest|recent|news|update|happen|situation|war|conflict|crisis|election|vote|attack|deal|talks?|summit)\b/i.test(question) || isSourceQuery);

  const isSourceQuery = !!sourceQ;
  const lengthGuide = isSourceQuery
    ? 'Summarise the latest posts from this source in 3-4 sentences. Cover the key themes. Use ONLY the posts above.'
    : roleQ
    ? 'Answer in 1 concise sentence — state the name and role only.'
    : portfolioQ
      ? 'Summarise the portfolio activity clearly. List each position or trade. Be concise but complete.'
      : isNewsQuery
        ? 'Summarise in 3-4 sentences: what happened, who is involved, and current status. Use the headlines as your primary source.'
        : 'Answer directly in 1-2 sentences. No disclaimers.';

  // Include live portfolio data in prompt when available
  const activityBlock = portfolioQ && (movers.length || trades.length)
    ? '\n\n' + formatActivityForPrompt(movers, trades)
    : '';

  const prompt = `Today is ${today}. Answer the user's question concisely and factually.
${wikidataContext}RECENT HEADLINES:\n${headlineBlock}${activityBlock}

USER QUESTION: ${question}

${lengthGuide}`;

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
          max_tokens: portfolioQ ? 350 : isNewsQuery ? 220 : 80,
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
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: portfolioQ ? 350 : isNewsQuery ? 220 : 80 },
        }),
      });
      if (r.ok) answer = (await r.json()).candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
    } catch (e) { console.warn('[ask] Gemini failed:', e.message); }
  }

  // ── Step 3b: Portfolio direct answer (AI offline but we have activity data) ─
  if (!answer && portfolioQ && (movers.length || trades.length)) {
    answer = formatActivityForPrompt(movers, trades)
      .replace('POLYMARKET PORTFOLIO ACTIVITY (last 24h):', 'Polymarket activity (last 24h):')
      .trim();
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
          max_tokens: portfolioQ ? 350 : isNewsQuery ? 200 : 80,
          messages: [{ role: 'user', content: `Today is ${today}. ${lengthGuide}

RECENT HEADLINES:
${allHeadlines.slice(0, 15).join('\n')}

QUESTION: ${question}` }],
        }),
      });
      if (r.ok) answer = (await r.json()).choices?.[0]?.message?.content?.trim() || null;
    } catch (e) {}
  }

  // ── Step 6: Extract name from headlines ───────────────────────────────────
  if (!answer) {
    const relevant = googleNewsItems.length ? googleNewsItems : allItems;
    const relevantTitles = relevant.map(it => it.title);
    if (relevantTitles.length) {
      const isWhoQ = /^who\s+(is|was|are)/i.test(question.trim());
      if (isWhoQ && roleQ) {
        const titleRole = roleQ.role.replace(/\b\w/g, c => c.toUpperCase());
        const abbrevMap = { 'prime minister': 'PM', 'chief executive': 'CEO' };
        const abbrev = abbrevMap[roleQ.role] || null;
        const variants = [titleRole, roleQ.role, ...(abbrev ? [abbrev] : [])].join('|');
        const afterRole  = new RegExp(`(?:${variants})\\s+([A-ZȘȚĂÎÂ][a-zșțăîâ\\-]+(?:\\s+[A-ZȘȚĂÎÂ][a-zșțăîâ\\-]+){1,3})`);
        const beforeRole = new RegExp(`([A-ZȘȚĂÎÂ][a-zșțăîâ\\-]+(?:\\s+[A-ZȘȚĂÎÂ][a-zșțăîâ\\-]+){1,3})(?:,?\\s+is(?:\\s+the)?)?\\s+(?:${variants})`);
        let extracted = null;
        for (const h of relevantTitles) {
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
        const filtered = relevantTitles.filter(h => keywords.some(k => h.toLowerCase().includes(k)));
        answer = filtered.length ? filtered[0] : 'AI is temporarily unavailable. Try again in a moment.';
      }
    } else {
      return res.status(503).json({ error: 'AI unavailable and no headlines fetched' });
    }
  }

  // ── Build sources list — query-relevant items only ───────────────────────
  // Google News items are already filtered by the question query → always relevant.
  // General feeds (Reuters/BBC/NYT) are top world news → often unrelated, exclude them.
  // Fallback: keyword-filter otherItems if Google News returned nothing with URLs.
  const keywords = question.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(w => w.length > 3);
  // When a named source was requested, all items came from it — show them directly
  if (sourceQ) {
    const srcItems = googleNewsItems.filter(it => it.url).slice(0, 5).map(it => {
      let domain = sourceQ.name;
      try {
        const h = new URL(it.url).hostname.replace(/^www\./, '');
        if (h !== 'news.google.com') domain = h;  // keep sourceQ.name for Google News fallback URLs
      } catch {}
      return { title: it.title.slice(0, 90), url: it.url, domain };
    });
    if (answer) answer = trimToSentence(answer);
    return res.status(200).json({ ok: true, answer, headlines: googleNewsItems.map(i => i.title), sources: srcItems });
  }
  const googleWithUrl = googleNewsItems.filter(it => it.url);
  const relevantOther = otherItems.filter(it =>
    it.url && keywords.some(k => it.title.toLowerCase().includes(k))
  );
  const sourceItems = googleWithUrl.length ? googleWithUrl : relevantOther;
  const sources = sourceItems
    .slice(0, 4)
    .map(it => {
      let domain = '';
      try { domain = new URL(it.url).hostname.replace(/^www\./, ''); } catch {}
      // Google News redirect URLs → show clean domain from title suffix if possible
      if (domain === 'news.google.com') {
        const m = it.title.match(/ - ([^-]+)$/);
        domain = m ? m[1].trim().toLowerCase() : 'news.google.com';
      }
      return { title: it.title.slice(0, 90), url: it.url, domain };
    });

  if (answer) answer = trimToSentence(answer);

  return res.status(200).json({
    ok: true,
    answer,
    headlines: googleNewsItems.slice(0, 5).map(i => i.title),
    sources,
  });
};

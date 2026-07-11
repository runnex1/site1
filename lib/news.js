/**
 * News fetcher for event alert checking.
 * Fetches from the same RSS sources as the Daily Brief + user TG channels via RSS.
 */

const DAILY_BRIEF_SOURCES = [
  // ── Crypto / DeFi ────────────────────────────────────────────────────────
  { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/',          label: 'CoinDesk'        },
  { url: 'https://cointelegraph.com/rss',                            label: 'CoinTelegraph'   },
  { url: 'https://decrypt.co/feed',                                  label: 'Decrypt'         },
  { url: 'https://theblock.co/rss.xml',                              label: 'The Block'       },
  { url: 'https://unchainedcrypto.com/feed/',                        label: 'Unchained'       },
  { url: 'https://www.dlnews.com/arc/outboundfeeds/rss/',            label: 'DL News'         },
  { url: 'https://cryptopanic.com/news/rss/',                        label: 'CryptoPanic'     },
  // ── Macro / Traditional Finance ──────────────────────────────────────────
  { url: 'https://feeds.reuters.com/reuters/businessNews',           label: 'Reuters Business'},
  { url: 'https://feeds.reuters.com/reuters/politicsNews',           label: 'Reuters Politics'},
  { url: 'https://feeds.bbci.co.uk/news/business/rss.xml',          label: 'BBC Business'    },
  { url: 'https://feeds.bbci.co.uk/news/world/rss.xml',             label: 'BBC World'       },
  { url: 'https://www.investing.com/rss/news_25.rss',               label: 'Investing.com'   },
  { url: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml',           label: 'WSJ Markets'     },
  { url: 'https://www.cnbc.com/id/10000664/device/rss/rss.html',    label: 'CNBC Finance'    },
  { url: 'https://www.marketwatch.com/rss/topstories',              label: 'MarketWatch'     },
  { url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml',  label: 'NYT World'       },
  { url: 'https://www.ft.com/rss/home',                             label: 'FT'              },
];

async function safeFetch(url, timeout = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'Accept': 'application/rss+xml, application/xml, text/xml, */*' },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parseRSS(xml) {
  // Simple regex-based RSS parser (no DOM on server)
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let itemMatch;
  while ((itemMatch = itemRegex.exec(xml)) !== null) {
    const block = itemMatch[1];
    const title = (block.match(/<title[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) ||
                   block.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || '';
    const desc  = (block.match(/<description[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/description>/) ||
                   block.match(/<description[^>]*>([\s\S]*?)<\/description>/) || [])[1] || '';
    const link  = (block.match(/<link[^>]*>([\s\S]*?)<\/link>/) || [])[1] || '';
    const pubDate = (block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
    
    const cleanTitle = title.replace(/<[^>]+>/g, '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim();
    const cleanDesc  = desc.replace(/<[^>]+>/g, '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim().slice(0, 200);
    
    if (cleanTitle) items.push({ title: cleanTitle, desc: cleanDesc, link: link.trim(), pubDate: pubDate.trim() });
    if (items.length >= 3) break;
  }
  return items;
}

async function fetchRSSFeed(url) {
  // Try direct first, then CORS proxies
  const urls = [
    url,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  ];
  for (const u of urls) {
    const text = await safeFetch(u);
    if (text && text.includes('<item>')) {
      return parseRSS(text);
    }
  }
  return [];
}

// Build TG channel RSS URL from handle
function tgChannelRSSUrl(handle) {
  // Clean handle — remove t.me/ prefix if present
  const clean = handle.replace(/^(?:https?:\/\/)?t\.me\//, '').replace(/^@/, '').trim();
  // Telegram channels have RSS via nitter or rsshub
  return `https://rsshub.app/telegram/channel/${clean}`;
}

/**
 * Fetch recent headlines from all sources.
 * tgChannels: array of channel handles from vault_tg_channels
 * Returns array of { title, desc, source } strings
 */
async function fetchRecentHeadlines(tgChannels = []) {
  const sources = [...DAILY_BRIEF_SOURCES];

  // Add TG channels as RSS sources
  for (const handle of (tgChannels || [])) {
    sources.push({ url: tgChannelRSSUrl(handle), label: handle });
  }

  const results = await Promise.allSettled(
    sources.map(async (src) => {
      const items = await fetchRSSFeed(src.url);
      return items.map(i => ({ ...i, source: src.label }));
    })
  );

  return results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .slice(0, 60); // max 60 headlines across all sources
}

/**
 * Check if an event condition has been met based on recent headlines.
 * Uses Groq AI.
 */
function buildEventPrompt(condition, headlineText) {
  return 'You are checking if a specific condition has been met based on recent news headlines.\n\n' +
    'CONDITION TO CHECK: "' + condition + '"\n\n' +
    'RECENT HEADLINES:\n' + headlineText + '\n\n' +
    'Has the condition been met? Reply with ONLY a JSON object:\n' +
    '{"triggered": true/false, "reason": "brief explanation of what happened", "headline": "the specific headline that triggered this, or empty string"}\n\n' +
    'Be conservative — only say triggered:true if there is clear, direct evidence in the headlines.';
}

async function checkWithGroq(prompt, groqKey) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + groqKey },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',
      temperature: 0,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error('Groq HTTP ' + res.status);
  const data = await res.json();
  return (data.choices?.[0]?.message?.content || '{}').replace(/```json|```/g, '').trim();
}

async function checkWithGemini(prompt) {
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) throw new Error('No Gemini key');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + geminiKey;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0 },
    }),
  });
  if (!res.ok) throw new Error('Gemini HTTP ' + res.status);
  const data = await res.json();
  return (data.candidates?.[0]?.content?.parts?.[0]?.text || '{}').replace(/```json|```/g, '').trim();
}

async function checkEventCondition(condition, headlines, groqKey) {
  if (!headlines.length) return { triggered: false, reason: 'no headlines fetched' };

  const headlineText = headlines
    .map((h, i) => (i + 1) + '. [' + h.source + '] ' + h.title + (h.desc ? ' — ' + h.desc : ''))
    .join('\n');

  const prompt = buildEventPrompt(condition, headlineText);

  let rawText = '{}';
  try {
    rawText = await checkWithGroq(prompt, groqKey);
  } catch (e) {
    console.warn('[news] Groq failed (' + e.message + '), trying Gemini...');
    try {
      rawText = await checkWithGemini(prompt);
    } catch (e2) {
      return { triggered: false, reason: 'AI unavailable: ' + e2.message };
    }
  }

  try {
    const parsed = JSON.parse(rawText);
    return { triggered: !!parsed.triggered, reason: parsed.reason || '', headline: parsed.headline || '' };
  } catch (e) {
       return { triggered: false, reason: 'Parse error', headline: '' };
  }
}

module.exports = { fetchRecentHeadlines, checkEventCondition };

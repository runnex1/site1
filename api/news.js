const { kvGet } = require('../lib/kv');

const SOURCES_WITH_TYPE = [
  { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/',         label: 'CoinDesk',         type: 'crypto' },
  { url: 'https://cointelegraph.com/rss',                           label: 'CoinTelegraph',    type: 'crypto' },
  { url: 'https://decrypt.co/feed',                                 label: 'Decrypt',          type: 'crypto' },
  { url: 'https://unchainedcrypto.com/feed/',                       label: 'Unchained',        type: 'crypto' },
  { url: 'https://cryptopanic.com/news/rss/',                       label: 'CryptoPanic',      type: 'crypto' },
  { url: 'https://thedefiant.io/api/feed',                          label: 'The Defiant',      type: 'defi' },
  // Direct Block RSS is Cloudflare-blocked from serverless; Google News site feed works.
  { url: 'https://news.google.com/rss/search?q=site:theblock.co&hl=en-US&gl=US&ceid=US:en', label: 'The Block', type: 'defi' },
  { url: 'https://protos.com/feed/',                                label: 'Protos',           type: 'defi' },
  { url: 'https://www.bankless.com/feed',                           label: 'Bankless',         type: 'defi' },
  { url: 'https://news.google.com/rss/search?q=site:coindesk.com+DeFi&hl=en-US&gl=US&ceid=US:en', label: 'CoinDesk · DeFi', type: 'defi' },
  { url: 'https://news.google.com/rss/search?q=site:unchainedcrypto.com+DeFi&hl=en-US&gl=US&ceid=US:en', label: 'Unchained · DeFi', type: 'defi' },
  { url: 'https://news.google.com/rss/search?q=site:decrypt.co+DeFi&hl=en-US&gl=US&ceid=US:en', label: 'Decrypt · DeFi', type: 'defi' },
  { url: 'https://news.google.com/rss/search?q=site:cointelegraph.com+DeFi&hl=en-US&gl=US&ceid=US:en', label: 'CoinTelegraph · DeFi', type: 'defi' },
  { url: 'https://feeds.bbci.co.uk/news/business/rss.xml',          label: 'BBC Business',     type: 'macro' },
  { url: 'https://feeds.bbci.co.uk/news/world/rss.xml',             label: 'BBC World',        type: 'macro' },
  { url: 'https://www.investing.com/rss/news_25.rss',               label: 'Investing.com',    type: 'macro' },
  { url: 'https://feeds.content.dowjones.io/public/rss/RSSMarketsMain', label: 'WSJ Markets',  type: 'macro' },
  { url: 'https://www.cnbc.com/id/10000664/device/rss/rss.html',    label: 'CNBC Finance',     type: 'macro' },
  { url: 'https://www.marketwatch.com/rss/topstories',              label: 'MarketWatch',      type: 'macro' },
  { url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml',  label: 'NYT World',        type: 'macro' },
  { url: 'https://www.ft.com/rss/home',                             label: 'FT',               type: 'macro' },
];

const ASSET_ALIASES = {
  btc: ['btc', 'bitcoin'],
  xbt: ['xbt', 'bitcoin'],
  eth: ['eth', 'ethereum'],
  sol: ['sol', 'solana'],
  bnb: ['bnb', 'binance'],
  xrp: ['xrp', 'ripple'],
  doge: ['doge', 'dogecoin'],
  ada: ['ada', 'cardano'],
  avax: ['avax', 'avalanche'],
  link: ['link', 'chainlink'],
  aave: ['aave'],
  ondo: ['ondo'],
  ena: ['ena', 'ethena'],
  usde: ['usde', 'ethena usde'],
  hype: ['hype', 'hyperliquid'],
};

function cleanText(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return Number.isFinite(code) && code >= 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : `&#${n};`;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const code = parseInt(h, 16);
      return Number.isFinite(code) && code >= 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : `&#x${h};`;
    })
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

async function safeFetch(url, timeout = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/rss+xml, application/xml, text/xml, */*' },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parseRSS(xml, maxItems = 30) {
  const items = [];
  const itemRegex = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let itemMatch;
  while ((itemMatch = itemRegex.exec(xml)) !== null) {
    const block = itemMatch[1];
    const get = name => {
      const re = new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i');
      return cleanText((block.match(re) || [])[1] || '');
    };
    const title = get('title');
    const desc = get('description');
    const link = get('link') || get('guid') || '#';
    const pubDate = get('pubDate') || get('dc:date') || get('updated') || get('published');
    if (title) items.push({ title, desc: desc.slice(0, 240), link, pubDate });
    if (items.length >= maxItems) break;
  }
  return items;
}

function parseAtom(xml, maxItems = 30) {
  const items = [];
  const entryRegex = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
  let entryMatch;
  while ((entryMatch = entryRegex.exec(xml)) !== null) {
    const block = entryMatch[1];
    const get = name => {
      const re = new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i');
      return cleanText((block.match(re) || [])[1] || '');
    };
    const linkMatch = block.match(/<link[^>]+href=["']([^"']+)["'][^>]*>/i);
    const title = get('title');
    const desc = get('summary') || get('content');
    const link = cleanText(linkMatch?.[1] || get('link') || get('id') || '#');
    const pubDate = get('published') || get('updated');
    if (title) items.push({ title, desc: desc.slice(0, 240), link, pubDate });
    if (items.length >= maxItems) break;
  }
  return items;
}

async function fetchRSSFeed(url, maxItems = 30) {
  const urls = [url, `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`];
  for (const u of urls) {
    const text = await safeFetch(u);
    if (text && /<item\b/i.test(text)) return parseRSS(text, maxItems);
    if (text && /<entry\b/i.test(text)) return parseAtom(text, maxItems);
  }
  return [];
}

function tgChannelRSSUrl(handle) {
  const clean = String(handle || '').replace(/^(?:https?:\/\/)?t\.me\/(?:s\/)?/i, '').replace(/^@/, '').trim();
  return `https://rsshub.app/telegram/channel/${clean}`;
}

function parseTelegramChannelParam(raw) {
  return String(raw || '').split(',').map(s => s.trim()).filter(Boolean).map((entry) => {
    const idx = entry.lastIndexOf(':');
    if (idx > 0) {
      const suffix = entry.slice(idx + 1).toLowerCase();
      if (['crypto', 'defi', 'macro'].includes(suffix)) {
        const handle = entry.slice(0, idx)
          .replace(/^(?:https?:\/\/)?t\.me\/(?:s\/)?/i, '')
          .replace(/^@/, '')
          .replace(/[^a-zA-Z0-9_]/g, '');
        if (handle) return { handle, category: suffix };
      }
    }
    const handle = entry
      .replace(/^(?:https?:\/\/)?t\.me\/(?:s\/)?/i, '')
      .replace(/^@/, '')
      .replace(/[^a-zA-Z0-9_]/g, '');
    if (!handle) return null;
    return { handle, category: /kobeissi/i.test(handle) ? 'macro' : 'crypto' };
  }).filter(Boolean);
}

/** Newsletter RSS entries: label|feedUrl|category (each URI-encoded), comma-separated. Max 8. */
function normalizeNewsletterFeedUrl(raw) {
  let url = String(raw || '').trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    const host = u.hostname.toLowerCase();
    if (/\.substack\.com$/i.test(host)) {
      const path = (u.pathname || '/').replace(/\/+$/, '') || '';
      if (!path || path === '/') u.pathname = '/feed';
    }
    return u.toString();
  } catch {
    return '';
  }
}

function parseNewsletterParam(raw) {
  return String(raw || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 8).map((entry) => {
    const parts = entry.split('|');
    if (parts.length < 2) return null;
    let label = '';
    let feedUrl = '';
    let category = 'defi';
    try {
      label = decodeURIComponent(parts[0] || '').trim();
      feedUrl = normalizeNewsletterFeedUrl(decodeURIComponent(parts[1] || ''));
      category = decodeURIComponent(parts[2] || 'defi').trim().toLowerCase();
    } catch {
      return null;
    }
    if (!feedUrl) return null;
    if (!['crypto', 'defi', 'macro'].includes(category)) category = 'defi';
    if (!label) {
      try {
        const host = new URL(feedUrl).hostname.replace(/^www\./i, '');
        label = /\.substack\.com$/i.test(host)
          ? host.replace(/\.substack\.com$/i, '')
          : (host.split('.')[0] || 'Newsletter');
      } catch {
        label = 'Newsletter';
      }
    }
    label = label.slice(0, 60);
    return { label, feedUrl, category };
  }).filter(Boolean);
}

async function fetchTelegramChannelPosts(channel, maxPosts = 12) {
  const clean = String(channel || '').replace(/^@/, '').replace(/[^a-zA-Z0-9_]/g, '');
  if (!clean) return [];
  const url = `https://t.me/s/${clean}`;
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    if (!r.ok) return [];
    const html = await r.text();
    const messageBlocks = [...html.matchAll(/<div class="tgme_widget_message_wrap[^"]*">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/g)].map(m => m[0]);
    const posts = messageBlocks.slice(-30).reverse().reduce((acc, block) => {
      if (acc.length >= maxPosts) return acc;
      const textMatch = block.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
      if (!textMatch) return acc;
      const rawText = cleanText(textMatch[1].replace(/<br\s*\/?>/gi, '\n'));
      if (!rawText) return acc;
      const urlMatch = block.match(/href="(https:\/\/t\.me\/[^"]+\/(\d+))"/);
      const postUrl = urlMatch ? urlMatch[1] : `https://t.me/${clean}`;
      const dateMatch = block.match(/<time[^>]*datetime="([^"]+)"/);
      const pubDate = dateMatch ? dateMatch[1] : '';
      if (!pubDate || !Number.isFinite(Date.parse(pubDate))) return acc;
      const parts = rawText.split(/\n+/).filter(Boolean);
      const title = (parts[0] || rawText).slice(0, 220);
      const desc = rawText.slice(title.length).trim().slice(0, 240);
      acc.push({ title, desc, link: postUrl, pubDate });
      return acc;
    }, []);
    return posts;
  } catch {
    return [];
  }
}

async function fetchSourceItems(src) {
  if (src.kind === 'telegram') {
    const items = await fetchTelegramChannelPosts(src.handle);
    return items.map(i => ({
      title: i.title,
      desc: i.desc,
      url: i.link || '#',
      type: src.type,
      source: src.label,
      pubDate: i.pubDate,
      publishedAt: publishedAt(i.pubDate),
    }));
  }
  let items = await fetchRSSFeed(src.url);
  if (src.label === 'The Defiant') {
    items = await enrichDefiantDatesFromSanity(items);
  }
  return items.map(i => ({
    title: i.title,
    desc: i.desc,
    url: i.link || '#',
    type: src.type,
    source: src.label,
    pubDate: i.pubDate,
    publishedAt: i.publishedAt || publishedAt(i.pubDate),
  }));
}

function parseTs(pubDate) {
  const ts = Date.parse(pubDate || '');
  return Number.isFinite(ts) ? ts : null;
}

function publishedAt(pubDate) {
  const ts = parseTs(pubDate);
  return ts ? new Date(ts).toISOString() : '';
}

/** The Defiant's RSS stamps many items with the same feed-build time. Sanity has real post dates. */
const DEFIANT_SANITY_QUERY =
  'https://6oftkxoa.api.sanity.io/v2021-10-21/data/query/production';

function defiantSlugFromUrl(url) {
  const m = String(url || '').match(/thedefiant\.io\/(?:news|converge)\/[^/?#]+\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]).toLowerCase() : '';
}

async function enrichDefiantDatesFromSanity(items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return list;
  const slugs = [...new Set(list.map((i) => defiantSlugFromUrl(i.link || i.url)).filter(Boolean))];
  if (!slugs.length) return list;
  try {
    const query = `*[_type=="blog" && slug.current in ${JSON.stringify(slugs)}]{publishedAt,_createdAt,_updatedAt,"slug":slug.current}`;
    const res = await fetch(`${DEFIANT_SANITY_QUERY}?query=${encodeURIComponent(query)}`, {
      signal: AbortSignal.timeout(8000),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return list;
    const data = await res.json();
    const bySlug = new Map();
    for (const row of data?.result || []) {
      if (row?.slug) bySlug.set(String(row.slug).toLowerCase(), row);
    }
    if (!bySlug.size) return list;
    return list.map((item) => {
      const row = bySlug.get(defiantSlugFromUrl(item.link || item.url));
      if (!row) return item;
      const iso = row.publishedAt || row._updatedAt || row._createdAt;
      const ts = Date.parse(iso || '');
      if (!Number.isFinite(ts)) return item;
      return {
        ...item,
        pubDate: new Date(ts).toUTCString(),
        publishedAt: new Date(ts).toISOString(),
      };
    });
  } catch {
    return list;
  }
}

function isWithinWindow(item, windowMs = 24 * 60 * 60 * 1000, now = Date.now()) {
  const ts = parseTs(item.pubDate);
  return ts !== null && ts <= now + 5 * 60 * 1000 && now - ts <= windowMs;
}

function isWithinLast24h(item, now = Date.now()) {
  return isWithinWindow(item, 24 * 60 * 60 * 1000, now);
}

function parseWindowHours(raw) {
  const h = Number(raw);
  if (!Number.isFinite(h)) return 24;
  if ([8, 24, 48, 168].includes(h)) return h;
  return 24;
}

function isPricePrediction(item) {
  const text = `${item.title || ''} ${item.desc || ''}`.toLowerCase();
  return /\b(price prediction|price forecast|price target|analyst predicts?|analyst says .* could|could (?:hit|reach|surge)|will .* (?:hit|reach) \$?\d|top crypto to buy|best coins? to buy|next .*x crypto)\b/.test(text);
}

function normalizeTitle(title) {
  return String(title || '').toLowerCase()
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[^a-z0-9\s$]/g, ' ')
    .replace(/\b(the|a|an|to|of|and|or|for|on|in|with|as|is|are|from|after|before|amid)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleOverlap(a, b) {
  const aw = new Set(normalizeTitle(a).split(' ').filter(w => w.length > 3));
  const bw = new Set(normalizeTitle(b).split(' ').filter(w => w.length > 3));
  if (!aw.size || !bw.size) return 0;
  const hit = [...aw].filter(w => bw.has(w)).length;
  return hit / Math.min(aw.size, bw.size);
}

function dedupeNews(items) {
  const out = [];
  const exact = new Set();
  for (const item of items) {
    const key = normalizeTitle(item.title).split(' ').slice(0, 10).join(' ');
    if (!key || exact.has(key)) continue;
    if (out.some(prev => titleOverlap(prev.title, item.title) >= 0.72)) continue;
    exact.add(key);
    out.push(item);
  }
  return out;
}

function marketMovingScore(item) {
  const text = `${item.title || ''} ${item.desc || ''} ${item.source || ''}`.toLowerCase();
  let score = 0;

  const cryptoStrong = [
    'strategy', 'microstrategy', 'saylor', 'bitcoin purchase', 'buys bitcoin', 'bought bitcoin',
    'institutional adoption', 'etf inflow', 'etf approval', 'spot etf', 'treasury company',
    'reserve', 'sec', 'cftc', 'lawsuit', 'settlement', 'regulation', 'regulatory',
    'hack', 'exploit', 'breach', 'stolen', 'liquidation', 'crash', 'selloff',
  ];
  const defiStrong = [
    'upgrade', 'mainnet', 'token upgrade', 'tokenomics', 'governance', 'proposal passed',
    'airdrop', 'tvl', 'fastest growing', 'launches', 'partnership', 'integration',
    'exploit', 'hack', 'audit', 'stablecoin', 'restaking', 'lending', 'dex',
  ];
  const macroStrong = [
    'federal reserve', 'fed', 'powell', 'trump', 'xi', 'china', 'united states',
    'tariff', 'sanction', 'war', 'ceasefire', 'iran', 'russia', 'ukraine', 'israel',
    'cpi', 'ppi', 'inflation', 'jobs report', 'unemployment', 'gdp', 'oil', 'opec',
    'market crash', 'stocks fall', 'stocks rally', 'bond yields', 'dollar',
  ];

  for (const w of cryptoStrong) if (text.includes(w)) score += 5;
  for (const w of defiStrong) if (text.includes(w)) score += item.type === 'defi' ? 5 : 3;
  for (const w of macroStrong) if (text.includes(w)) score += 5;

  if (/\b(breaking|urgent|exclusive)\b/.test(text)) score += 4;
  if (/[+-]?\d+(?:\.\d+)?%/.test(text)) score += 2;
  if (/\b(record|surge|plunge|crash|rally|soar|slump|halts?|ban|approves?|rejects?|launches?|passes?)\b/.test(text)) score += 3;
  if (item.type === 'defi') score += 2;
  if (/kobeissi/i.test(item.source || '')) score += 6;
  if (item.type === 'tg') score += 2;
  if (/\b(opinion|guide|explainer|sponsored|podcast|newsletter roundup)\b/.test(text)) score -= 4;
  if (isPricePrediction(item)) score -= 100;
  return score;
}

function holdingsFromQuery(query) {
  return String(query || '').split(',').map(s => s.trim()).filter(Boolean);
}

async function holdingsFromServer() {
  try {
    const raw = await kvGet('vault:portfolio');
    const portfolio = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!portfolio) return [];
    const names = [];
    for (const token of (portfolio.tokens || [])) {
      if (token.symbol) names.push(token.symbol);
      if (token.name) names.push(token.name);
    }
    return names;
  } catch {
    return [];
  }
}

function expandHoldingTerms(holdings) {
  const terms = new Set();
  const generic = new Set([
    'usd', 'usdc', 'usdt', 'dai', 'eur', 'weth', 'wbtc', 'btc.b', 'pool', 'vault', 'token',
    'yield', 'lending', 'borrow', 'borrowed', 'supplied', 'staking', 'market', 'position',
    'long', 'short', 'yes', 'no', 'trump', 'iran', 'china', 'russia', 'oil',
  ]);
  for (const raw of holdings || []) {
    const clean = String(raw || '').trim();
    if (!clean) continue;
    const lower = clean.toLowerCase();
    if (!generic.has(lower)) terms.add(lower);
    for (const part of lower.split(/[^a-z0-9$]+/).filter(Boolean)) {
      const normalized = part.replace(/^\$/, '');
      if (part.length >= 2 && !generic.has(normalized)) terms.add(normalized);
      for (const alias of (ASSET_ALIASES[part.replace(/^\$/, '')] || [])) terms.add(alias);
    }
    for (const alias of (ASSET_ALIASES[lower.replace(/^\$/, '')] || [])) terms.add(alias);
  }
  return [...terms].filter(t => t.length >= 2 && (!generic.has(t) || ['btc', 'eth'].includes(t)));
}

function matchesHolding(item, terms) {
  const text = normalizeTitle(`${item.title || ''} ${item.desc || ''}`);
  return terms.some(term => {
    const t = normalizeTitle(term);
    if (!t) return false;
    if (t.length <= 4) return new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);
    return text.includes(t);
  });
}

function overlapsAny(item, list, threshold = 0.72) {
  return (list || []).some(prev => titleOverlap(prev.title, item.title) >= threshold);
}

function ensureTypeCoverage(selected, clean) {
  const out = [...selected];
  const seen = new Set(out.map(i => i.idx));
  for (const type of ['crypto', 'defi', 'macro']) {
    if (out.some(i => (i.type || 'macro') === type)) continue;
    const best = clean
      .filter(i => (i.type || 'macro') === type)
      .filter(i => !seen.has(i.idx))
      .filter(i => i.marketImpactScore >= (type === 'defi' ? -2 : 3))
      .sort((a, b) => b.marketImpactScore - a.marketImpactScore)[0];
    if (best) {
      seen.add(best.idx);
      out.push(best);
    }
  }
  return out;
}

function selectPortfolioItems(clean, holdingTerms, mainItems) {
  return clean
    .filter(item => matchesHolding(item, holdingTerms))
    .filter(item => item.marketImpactScore >= 4)
    .filter(item => !overlapsAny(item, mainItems))
    .slice(0, 2);
}

async function checkWithGroq(prompt, groqKey) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + groqKey },
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

async function rankDailyBriefItems(items, holdingTerms, windowHours = 24) {
  const windowMs = windowHours * 60 * 60 * 1000;
  const clean = dedupeNews((items || [])
    .filter(i => i && i.title)
    .filter(i => isWithinWindow(i, windowMs))
    .filter(i => i.type === 'defi' || !isPricePrediction(i)))
    .map((i, idx) => ({ ...i, idx, marketImpactScore: marketMovingScore(i) }))
    .sort((a, b) => b.marketImpactScore - a.marketImpactScore);

  const feedItems = [...clean].sort((a, b) => {
    const bt = parseTs(b.pubDate) || 0;
    const at = parseTs(a.pubDate) || 0;
    return bt - at || b.marketImpactScore - a.marketImpactScore;
  });

  const fallback = () => {
    const order = { tg: 0, crypto: 1, defi: 2, macro: 3 };
    const byType = clean.reduce((acc, item) => {
      const type = item.type || 'macro';
      (acc[type] ||= []).push(item);
      return acc;
    }, {});
    const orderedTypes = [...new Set(['tg', 'crypto', 'defi', 'macro', ...Object.keys(byType)])];
    const items = ensureTypeCoverage(orderedTypes
      .flatMap(type => (byType[type] || []).slice(0, 4))
      .sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9) || b.marketImpactScore - a.marketImpactScore), clean);
    const portfolioItems = selectPortfolioItems(clean, holdingTerms, items);
    return { items, portfolioItems, feedItems };
  };

  const key = process.env.GROQ_API_KEY;
  if (!key || !clean.length) return fallback();

  const compact = clean.slice(0, 90).map((item, i) =>
    `${i}. [${item.type || 'macro'} score=${item.marketImpactScore}] ${item.source || ''}: ${item.title}`
  ).join('\n');
  const prompt =
    'You are the editor of a crypto/DeFi portfolio Daily Brief.\n' +
    'Return ONLY JSON: {"keep":[numbers],"portfolio":[numbers]}.\n' +
    'Keep rules: all headlines must be important and market-moving from the last 24h; keep up to 4 per type; reject price predictions, generic analysis, duplicates, guides, sponsored posts, and weak chatter.\n' +
    'Crypto priorities: Saylor/Strategy BTC purchases or actions, major BTC institutional adoption, causes of market crashes, major regulation, big exploits.\n' +
    'DeFi priorities: protocol upgrades, major announcements from leading projects, important industry developments, market-moving token upgrades, major achievements, fastest-growing DeFi sectors.\n' +
    'Macro priorities: causes of the latest market move, major conflicts, US/China president statements, breaking Kobeissi-style market news.\n' +
    'Portfolio rules: choose up to 2 items directly tied to these holding terms and only if important: ' + holdingTerms.slice(0, 50).join(', ') + '.\n\n' +
    compact;

  try {
    const parsed = JSON.parse(await checkWithGroq(prompt, key));
    const pick = arr => (Array.isArray(arr) ? arr.map(Number).filter(Number.isInteger).map(i => clean[i]).filter(Boolean) : []);
    const selected = ensureTypeCoverage(dedupeNews(pick(parsed.keep)).filter(i => i.marketImpactScore > -50), clean);
    if (!selected.length) return fallback();
    const byType = {};
    for (const item of selected) {
      const type = item.type || 'macro';
      (byType[type] ||= []);
      if (byType[type].length < 4) byType[type].push(item);
    }
    const mainItems = [...new Set(['tg', 'crypto', 'defi', 'macro', ...Object.keys(byType)])].flatMap(t => byType[t] || []);
    const aiPortfolio = dedupeNews(pick(parsed.portfolio))
      .filter(i => matchesHolding(i, holdingTerms))
      .filter(i => i.marketImpactScore >= 4)
      .filter(i => !overlapsAny(i, mainItems));
    return { items: mainItems, portfolioItems: aiPortfolio.length ? aiPortfolio.slice(0, 2) : selectPortfolioItems(clean, holdingTerms, mainItems), feedItems };
  } catch (e) {
    console.warn('[news] Daily Brief AI ranking failed:', e.message);
    return fallback();
  }
}

function buildSourceHealth(sources, settled, windowMs = 7 * 24 * 60 * 60 * 1000, now = Date.now()) {
  const health = {};
  (sources || []).forEach((src, idx) => {
    const result = settled?.[idx];
    if (result?.status !== 'fulfilled') {
      health[src.label] = { ok: false, recent7d: 0, note: 'fetch_failed' };
      return;
    }
    const items = result.value || [];
    const recent7d = items.filter((i) => isWithinWindow({ pubDate: i.pubDate }, windowMs, now)).length;
    health[src.label] = {
      ok: recent7d > 0,
      recent7d,
      note: recent7d > 0 ? '' : (items.length ? 'stale' : 'empty'),
    };
  });
  return health;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const tgChannels = parseTelegramChannelParam(req.query?.tg || '');
  const newsletters = parseNewsletterParam(req.query?.nl || '');
  const queryHoldings = holdingsFromQuery(req.query?.holdings || '');
  const serverHoldings = queryHoldings.length ? [] : await holdingsFromServer();
  const holdingTerms = expandHoldingTerms([...queryHoldings, ...serverHoldings]);
  const windowHours = parseWindowHours(req.query?.window);

  const sources = [...SOURCES_WITH_TYPE];
  for (const { handle, category } of tgChannels) {
    if (!handle) continue;
    sources.push({
      kind: 'telegram',
      handle,
      label: handle,
      type: category,
    });
  }
  for (const { label, feedUrl, category } of newsletters) {
    if (!feedUrl || !label) continue;
    sources.push({
      url: feedUrl,
      label,
      type: category,
      kind: 'newsletter',
    });
  }

  const settled = await Promise.allSettled(
    sources.map(async (src) => fetchSourceItems(src)),
  );

  const rawItems = settled.filter(r => r.status === 'fulfilled').flatMap(r => r.value);
  const sourceHealth = buildSourceHealth(sources, settled);
  const ranked = await rankDailyBriefItems(rawItems, holdingTerms, windowHours);
  return res.status(200).json({ ok: true, ...ranked, sourceHealth, windowHours, ts: Date.now() });
};

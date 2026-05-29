const { fetchPrice, fmtPrice } = require('./price');

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const JUPITER_MINTS = {
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: USDC_MINT,
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  JUP: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  WIF: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
};
const CRYPTO_NAMES = {
  bitcoin: 'BTC', ethereum: 'ETH', solana: 'SOL', ripple: 'XRP',
  cardano: 'ADA', avalanche: 'AVAX', dogecoin: 'DOGE', litecoin: 'LTC',
  chainlink: 'LINK', near: 'NEAR', aptos: 'APT', sui: 'SUI', pepe: 'PEPE',
  pendle: 'PENDLE', echelon: 'PRIME', 'echelon prime': 'PRIME'
};
const ETF_TICKERS = new Set(['SPY','QQQ','IWM','DIA','VTI','VOO','GLD','SLV','TLT','HYG','ARKK','SOXL','TQQQ','SQQQ','IBIT','FBTC','ETHA','GBTC']);

function jupiterHeaders(extra = {}) {
  const key = (process.env.JUPITER_API_KEY || process.env.JUP_API_KEY || '').trim();
  return key ? { 'x-api-key': key, ...extra } : extra;
}
function detectChainHint(q) {
  return /\b(on\s+solana|solana|spl)\b/i.test(String(q || '')) ? 'solana' : null;
}
function detectAssetClassHint(q) {
  const s = String(q || '').toLowerCase();
  if (/\b(stock|equity|share|shares|nasdaq|nyse)\b/.test(s)) return 'stock';
  if (/\b(etf|fund)\b/.test(s)) return 'etf';
  if (/\b(crypto|token|coin|defi|onchain|on-chain|solana|ethereum|erc20|spl)\b/.test(s)) return 'crypto';
  return null;
}
function isPriceQuestion(q) {
  return /\$[A-Za-z0-9]{1,12}\b/.test(q) || /\b(price|cost|worth|value|trading\s+at|market\s+cap|how\s+much\s+is|how\s+much\s+does|what\s+is.*price|what.*trading)\b/i.test(q);
}
function extractSymbolOrName(q) {
  const assetClassHint = detectAssetClassHint(q);
  const chainHint = detectChainHint(q);
  const dollar = q.match(/\$([A-Za-z0-9]{1,12})\b/);
  if (dollar) return { query: dollar[1].toUpperCase(), assetClassHint, chainHint };

  const upper = [...q.matchAll(/\b([A-Z]{2,12})\b/g)]
    .map(m => m[1])
    .find(x => !['USD','THE','WHAT','HOW','SPL'].includes(x));
  if (upper) return { query: upper.toUpperCase(), assetClassHint, chainHint };

  const s = q.toLowerCase();
  for (const [name, sym] of Object.entries(CRYPTO_NAMES)) {
    if (s.includes(name)) return { query: sym, assetClassHint: assetClassHint || 'crypto', chainHint };
  }
  return null;
}
async function safeJson(url, opts = {}) {
  try {
    const res = await fetch(url, {
      ...opts,
      headers: { Accept: 'application/json', ...(opts.headers || {}) },
      signal: AbortSignal.timeout(opts.timeout || 9000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
function usd(v) {
  if (v == null || !Number.isFinite(Number(v))) return '?';
  const n = Number(v);
  if (n < 0.000001) return '$' + n.toExponential(2);
  if (n < 0.01) return '$' + n.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
  if (n < 2) return '$' + n.toFixed(4);
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function format24h(change) {
  if (change == null || !Number.isFinite(Number(change))) return '';
  const n = Number(change);
  const dir = n >= 0 ? 'up' : 'down';
  return ` (${dir} ${Math.abs(n).toFixed(2)}% in the last 24h)`;
}
function normalizeMint(x) {
  if (!x) return null;
  if (typeof x === 'string') return x;
  return x.id || x.address || x.mint || x.tokenAddress || null;
}
function jupSwapUrl(mint) {
  return `https://jup.ag/swap?sell=${USDC_MINT}&buy=${mint}`;
}
function sortJupiterTokens(tokens) {
  return [...tokens].sort((a, b) =>
    (Number(b.organicScore || 0) - Number(a.organicScore || 0)) ||
    (Number(b.liquidity || 0) - Number(a.liquidity || 0)) ||
    (Number(b.mcap || 0) - Number(a.mcap || 0))
  );
}
function makeTokenAnswer(name, symbol, price, change24h) {
  return `${name || symbol} (${symbol}) is currently trading at ${usd(price)}${format24h(change24h)}.`;
}
async function fetchJupiterV3PriceForMints(mints) {
  const clean = [...new Set((mints || []).map(normalizeMint).filter(Boolean))].slice(0, 50);
  if (!clean.length) return null;
  for (const base of ['https://api.jup.ag', 'https://lite-api.jup.ag']) {
    const price = await safeJson(`${base}/price/v3?ids=${encodeURIComponent(clean.join(','))}`, {
      headers: jupiterHeaders(),
      timeout: 10000,
    });
    if (price && typeof price === 'object') {
      for (const mint of clean) {
        const row = price[mint];
        const p = row?.usdPrice ?? row?.price ?? row?.data?.price;
        if (p != null && Number.isFinite(Number(p))) return { mint, price: Number(p), raw: row };
      }
    }
  }
  return null;
}
async function fetchStockOrEtf(symbol, type = 'stock') {
  const sym = String(symbol || '').toUpperCase();
  const price = await fetchPrice({ symbol: sym, type });
  if (price == null) return null;
  return {
    symbol: sym,
    name: sym,
    type,
    price,
    source: 'Yahoo Finance',
    answer: `${sym} ${type === 'etf' ? 'ETF' : 'stock'} is currently trading at ${fmtPrice(price, type)}.`,
    sources: []
  };
}
async function fetchFromCoinGecko(query) {
  const search = await safeJson(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(query)}`);
  const coins = (search?.coins || []).filter(c => c?.id && c?.symbol).slice(0, 20);
  if (!coins.length) return null;
  const q = String(query).toLowerCase();
  const candidates = coins.filter(c => String(c.symbol || '').toLowerCase() === q || String(c.name || '').toLowerCase() === q);
  const ids = (candidates.length ? candidates : coins).slice(0, 12).map(c => c.id).join(',');
  const markets = await safeJson(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${encodeURIComponent(ids)}&order=market_cap_desc&per_page=12&page=1&sparkline=false&price_change_percentage=24h`);
  if (!Array.isArray(markets) || !markets.length) return null;
  markets.sort((a, b) => (a.market_cap_rank || 999999) - (b.market_cap_rank || 999999) || (b.market_cap || 0) - (a.market_cap || 0));
  const m = markets[0];
  const sym = String(m.symbol || '').toUpperCase();
  const ch24 = typeof m.price_change_percentage_24h === 'number' ? m.price_change_percentage_24h : null;
  return {
    symbol: sym,
    name: m.name,
    type: 'crypto',
    price: m.current_price,
    priceChange24h: ch24,
    source: 'CoinGecko',
    answer: makeTokenAnswer(m.name, sym, m.current_price, ch24),
    sources: [{ domain: 'coingecko', title: `${m.name} price`, url: `https://www.coingecko.com/en/coins/${m.id}` }]
  };
}
async function fetchFromJupiter(query) {
  const sym = String(query || '').toUpperCase();
  const candidates = [];
  if (JUPITER_MINTS[sym]) candidates.push(JUPITER_MINTS[sym]);

  const bySearch = await safeJson(`https://api.jup.ag/tokens/v2/search?query=${encodeURIComponent(sym)}`, {
    headers: jupiterHeaders(),
    timeout: 10000,
  });
  const arr = Array.isArray(bySearch) ? bySearch : Array.isArray(bySearch?.data) ? bySearch.data : [];
  const sorted = sortJupiterTokens(arr.filter(t => String(t?.symbol || '').toUpperCase() === sym));

  for (const t of sorted) {
    const mint = normalizeMint(t);
    const ch24 = t.priceChange24h ?? t.stats24h?.priceChange;
    if (t.usdPrice != null && Number.isFinite(Number(t.usdPrice))) {
      return {
        symbol: sym,
        name: t.name || sym,
        type: 'crypto',
        chain: 'solana',
        mint,
        price: Number(t.usdPrice),
        priceChange24h: ch24,
        source: 'Jupiter',
        answer: makeTokenAnswer(t.name || sym, sym, t.usdPrice, ch24),
        sources: [{ domain: 'jupiter', title: `${sym}/USDC swap`, url: jupSwapUrl(mint) }]
      };
    }
    candidates.push(t);
  }

  const priced = await fetchJupiterV3PriceForMints(candidates);
  if (!priced) return null;
  const ch24 = priced.raw?.priceChange24h;
  return {
    symbol: sym,
    name: sym,
    type: 'crypto',
    chain: 'solana',
    mint: priced.mint,
    price: priced.price,
    priceChange24h: ch24,
    source: 'Jupiter',
    answer: makeTokenAnswer(sym, sym, priced.price, ch24),
    sources: [{ domain: 'jupiter', title: `${sym}/USDC swap`, url: jupSwapUrl(priced.mint) }]
  };
}
async function resolveMarketPrice(query, opts = {}) {
  const sym = String(query || '').toUpperCase();
  if (opts.assetClassHint === 'stock') return await fetchStockOrEtf(sym, 'stock');
  if (opts.assetClassHint === 'etf') return await fetchStockOrEtf(sym, 'etf');
  if (opts.chainHint === 'solana') return await fetchFromJupiter(sym);
  return await fetchFromCoinGecko(sym) || (!opts.assetClassHint ? await fetchStockOrEtf(sym, ETF_TICKERS.has(sym) ? 'etf' : 'stock') : null);
}
async function answerPriceQuestion(question) {
  if (!isPriceQuestion(question)) return null;
  const parsed = extractSymbolOrName(question);
  if (!parsed?.query) return { ok: false, kind: 'price', answer: 'I could not identify which asset price you want.', sources: [], headlines: [] };
  const result = await resolveMarketPrice(parsed.query, { assetClassHint: parsed.assetClassHint, chainHint: parsed.chainHint });
  if (result) return { ok: true, kind: 'price', ...result, headlines: [] };
  return { ok: false, kind: 'price', answer: `I couldn't find a live ${parsed.chainHint === 'solana' ? 'Solana token' : (parsed.assetClassHint || 'market')} price for ${parsed.query}.`, sources: [], headlines: [] };
}
module.exports = { answerPriceQuestion, isPriceQuestion, extractSymbolOrName, detectAssetClassHint, detectChainHint, resolveMarketPrice, usd };

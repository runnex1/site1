/**
 * Price fetchers - server-side mirrors of all sources used in your browser.
 * Supports: crypto, stock/ETF, Polymarket, Opinion, Aave cap %, contract tokens.
 */

const { resolvePolymarketMarket, pickOutcome } = require('./polymarket-resolver');

function jupiterHeaders(extra = {}) {
  const key = (process.env.JUPITER_API_KEY || process.env.JUP_API_KEY || '').trim();
  return key ? { 'x-api-key': key, ...extra } : extra;
}

async function safeFetch(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeout ?? 10000);
  try {
    const res = await fetch(url, {
      ...opts,
      signal: controller.signal,
      headers: { 'Accept': 'application/json', ...(opts.headers || {}) },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const GECKO_IDS = {
  BTC:'bitcoin', ETH:'ethereum', SOL:'solana', BNB:'binancecoin',
  AVAX:'avalanche-2', MATIC:'matic-network', POL:'matic-network',
  ARB:'arbitrum', OP:'optimism', LINK:'chainlink', UNI:'uniswap',
  AAVE:'aave', CRV:'curve-dao-token', CVX:'convex-finance',
  LDO:'lido-dao', MKR:'maker', SNX:'synthetix-network-token',
  COMP:'compound-governance-token', YFI:'yearn-finance',
  SUSHI:'sushi', BAL:'balancer', '1INCH':'1inch',
  DOGE:'dogecoin', SHIB:'shiba-inu', PEPE:'pepe',
  XRP:'ripple', ADA:'cardano', DOT:'polkadot', ATOM:'cosmos',
  LTC:'litecoin', BCH:'bitcoin-cash', ETC:'ethereum-classic',
  FIL:'filecoin', NEAR:'near', APT:'aptos', SUI:'sui',
  TIA:'celestia', INJ:'injective-protocol', SEI:'sei-network',
  WIF:'dogwifcoin', BONK:'bonk', JUP:'jupiter-exchange-solana',
  PYTH:'pyth-network', JTO:'jito-governance-token', RNDR:'render-token',
  HNT:'helium', MOBILE:'helium-mobile', IOT:'helium-iot',
  USDC:'usd-coin', USDT:'tether', DAI:'dai', FRAX:'frax',
  USDE:'ethena-usde', SUSDE:'ethena-staked-usde',
  WBTC:'wrapped-bitcoin', STETH:'staked-ether', WSTETH:'wrapped-steth',
  RETH:'rocket-pool-eth', CBETH:'coinbase-wrapped-staked-eth',
  EZETH:'renzo-restaked-eth', EETH:'ether-fi-staked-eth',
  WEETH:'wrapped-eeth', RSETH:'kelp-dao-restaked-eth',
  PRIME:'echelon-prime', BASE:'base',
};

function geckoId(sym) {
  return GECKO_IDS[sym.toUpperCase()] || sym.toLowerCase();
}

const JUPITER_MINTS = {
  SOL:    'So11111111111111111111111111111111111111112',
  USDC:   'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT:   'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  BONK:   'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  WIF:    'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
  JUP:    'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  PYTH:   'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3',
  JTO:    'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',
  RNDR:   'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof',
  HNT:    'hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux',
};

const AAVE_GQL = 'https://api.v3.aave.com/graphql';

const AAVE_CHAIN_NAMES = {
  1: 'Ethereum', 137: 'Polygon', 43114: 'Avalanche',
  10: 'Optimism', 42161: 'Arbitrum', 8453: 'Base',
  56: 'BSC', 100: 'Gnosis', 250: 'Fantom', 1088: 'Metis',
  4326: 'MegaETH',
};

function normalizeMint(item) {
  if (!item) return null;
  if (typeof item === 'string') return item;
  return item.id || item.address || item.mint || item.tokenAddress || null;
}

function sortJupiterTokens(tokens) {
  return [...tokens].sort((a, b) =>
    (Number(b.organicScore || 0) - Number(a.organicScore || 0)) ||
    (Number(b.liquidity || 0) - Number(a.liquidity || 0)) ||
    (Number(b.mcap || 0) - Number(a.mcap || 0))
  );
}

async function fetchJupiterV3PriceForMints(mints) {
  const clean = [...new Set((mints || []).map(normalizeMint).filter(Boolean))].slice(0, 50);
  if (!clean.length) return null;

  const price = await safeFetch(
    `https://api.jup.ag/price/v3?ids=${encodeURIComponent(clean.join(','))}`,
    { headers: jupiterHeaders(), timeout: 10000 }
  );
  if (price && typeof price === 'object') {
    for (const mint of clean) {
      const p = price[mint]?.usdPrice ?? price[mint]?.price ?? price[mint]?.data?.price;
      if (p != null && Number.isFinite(Number(p))) return { mint, price: Number(p), source: 'price-v3' };
    }
  }
  return null;
}

async function fetchJupiterTokenSearch(symbol) {
  const sym = String(symbol || '').toUpperCase();
  const urls = [
    `https://api.jup.ag/tokens/v2/search?query=${encodeURIComponent(sym)}`,
    `https://lite-api.jup.ag/tokens/v1/mints/by-symbol?symbol=${encodeURIComponent(sym)}`,
    `https://lite-api.jup.ag/tokens/v1/search?query=${encodeURIComponent(sym)}`,
  ];

  const found = [];
  for (const url of urls) {
    const j = await safeFetch(url, { headers: jupiterHeaders(), timeout: 10000 });
    const arr = Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : Array.isArray(j?.mints) ? j.mints : [];
    for (const item of arr) {
      if (typeof item === 'string') found.push(item);
      else if (String(item?.symbol || '').toUpperCase() === sym || normalizeMint(item)) found.push(item);
    }
  }
  return found;
}

async function fetchJupiterPrice(symbol) {
  const sym = String(symbol || '').toUpperCase();
  const candidates = [];
  if (JUPITER_MINTS[sym]) candidates.push(JUPITER_MINTS[sym]);

  const searchResults = await fetchJupiterTokenSearch(sym);
  const exactObjects = searchResults.filter(x => typeof x !== 'string' && String(x.symbol || '').toUpperCase() === sym);
  const sortedObjects = sortJupiterTokens(exactObjects);

  for (const t of sortedObjects) {
    if (t.usdPrice != null && Number.isFinite(Number(t.usdPrice))) return Number(t.usdPrice);
    candidates.push(t);
  }
  candidates.push(...searchResults.filter(x => typeof x === 'string'));

  const priced = await fetchJupiterV3PriceForMints(candidates);
  return priced ? priced.price : null;
}

async function fetchCoinGeckoBySearch(sym) {
  const search = await safeFetch(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(sym)}`, { timeout: 8000 });
  const coins = (search?.coins || [])
    .filter(c => c?.id && c?.symbol && String(c.symbol).toUpperCase() === sym.toUpperCase())
    .slice(0, 12);
  if (!coins.length) return null;

  const ids = coins.map(c => c.id).join(',');
  const markets = await safeFetch(
    `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${encodeURIComponent(ids)}&order=market_cap_desc&per_page=12&page=1&sparkline=false`,
    { timeout: 10000 }
  );
  if (!Array.isArray(markets) || !markets.length) return null;

  markets.sort((a, b) => {
    const ar = a.market_cap_rank || 999999;
    const br = b.market_cap_rank || 999999;
    if (ar !== br) return ar - br;
    return (b.market_cap || 0) - (a.market_cap || 0);
  });
  return markets[0]?.current_price != null ? Number(markets[0].current_price) : null;
}

async function fetchCryptoPrice(symbol, opts = {}) {
  const sym = symbol.toUpperCase();

  if (opts.chain === 'solana') return await fetchJupiterPrice(sym);

  const cgId = geckoId(sym);
  const cg = await safeFetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(cgId)}&vs_currencies=usd`
  );
  if (cg?.[cgId]?.usd != null) return cg[cgId].usd;

  const cgSearchPrice = await fetchCoinGeckoBySearch(sym);
  if (cgSearchPrice != null) return cgSearchPrice;

  const dx = await safeFetch(
    `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(sym)}`
  );
  const pairs = (dx?.pairs || [])
    .filter(p => p.baseToken?.symbol?.toUpperCase() === sym && p.priceUsd)
    .sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0));
  if (pairs[0]?.priceUsd) return parseFloat(pairs[0].priceUsd);

  return null;
}

async function fetchStockPrice(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol.toUpperCase())}?interval=1d&range=1d`;
  const raw = await safeFetch(url);
  const result = raw?.chart?.result?.[0];
  if (!result) return null;
  const meta = result.meta;
  return meta?.regularMarketPrice ?? meta?.previousClose ?? null;
}

async function fetchPolymarketPrice(slug, side = 'YES') {
  const cleanSlug = String(slug || '').trim();
  if (!cleanSlug) return null;

  const wanted = /^no$/i.test(side) ? 'No' : 'Yes';
  const resolved = await resolvePolymarketMarket(cleanSlug.replace(/-/g, ' '), { slug: cleanSlug });
  const market = resolved?.market;
  if (market) {
    const outcome = pickOutcome(market, wanted);
    if (outcome?.price != null && Number.isFinite(Number(outcome.price))) return Number(outcome.price);
  }

  const url = `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(cleanSlug)}&limit=1`;
  const res = await safeFetch(url);
  const fallbackMarket = Array.isArray(res) ? res[0] : (res?.markets?.[0] || null);
  if (!fallbackMarket) return null;

  if (fallbackMarket.outcomePrices) {
    try {
      const prices = JSON.parse(fallbackMarket.outcomePrices);
      const prob = wanted === 'Yes' ? parseFloat(prices[0]) : parseFloat(prices[1]);
      if (!isNaN(prob)) return prob;
    } catch (e) {}
  }

  const tokens = fallbackMarket.tokens || fallbackMarket.clobTokenIds;
  if (tokens?.length > 0) {
    const sidx = wanted === 'Yes' ? 0 : 1;
    const tk = tokens[Math.min(sidx, tokens.length - 1)];
    const tokenId = typeof tk === 'string' ? tk : tk?.token_id;
    if (tokenId) {
      const pr = await safeFetch(`https://clob.polymarket.com/last-trade-price?token_id=${tokenId}`);
      if (pr?.price) return parseFloat(pr.price);
    }
  }
  return null;
}

async function fetchAaveCapUtil(symbol, chainId) {
  const query = JSON.stringify({
    query: '{ markets(request: { chainIds: [' + chainId + '] }) { chain { chainId } reserves { underlyingToken { symbol } supplyInfo { total { value } supplyCap { amount { value } } supplyCapReached } } } }'
  });

  const AAVE_PROXY = process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL + '/api/aave-proxy' : 'http://localhost:3000/api/aave-proxy';
  const BROWSER_HEADERS = {
    'Content-Type': 'application/json',
    'Origin': 'https://app.aave.com',
    'Referer': 'https://app.aave.com/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  };
  const attempts = [
    () => safeFetch(AAVE_GQL, { method: 'POST', headers: BROWSER_HEADERS, body: query, timeout: 12000 }),
    () => safeFetch(AAVE_PROXY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: query, timeout: 12000 }),
    () => safeFetch('https://api.allorigins.win/raw?url=' + encodeURIComponent(AAVE_GQL), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: query, timeout: 12000 }),
  ];

  for (const attempt of attempts) {
    try {
      const json = await attempt();
      if (!json?.data?.markets) continue;
      for (const market of json.data.markets) {
        for (const r of (market.reserves || [])) {
          if (r.underlyingToken?.symbol?.toUpperCase() !== symbol.toUpperCase()) continue;
          const cap   = parseFloat(r.supplyInfo?.supplyCap?.amount?.value ?? '0');
          const total = parseFloat(r.supplyInfo?.total?.value ?? '0');
          if (cap === 0) continue;
          return (total / cap) * 100;
        }
      }
    } catch (e) {
      continue;
    }
  }
  return null;
}

async function fetchContractPrice(address, chain) {
  const res = await safeFetch(
    `https://api.dexscreener.com/latest/dex/tokens/${address}`,
    { timeout: 8000 }
  );
  const pairs = (res?.pairs || [])
    .filter(p => p.priceUsd)
    .sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0));
  return pairs[0]?.priceUsd ? parseFloat(pairs[0].priceUsd) : null;
}

async function fetchPrice(alert) {
  try {
    switch (alert.type) {
      case 'crypto':
        return await fetchCryptoPrice(alert.symbol, { chain: alert.chain, preferCoinGecko: alert.preferCoinGecko });
      case 'stock':
      case 'etf':
        return await fetchStockPrice(alert.symbol);
      case 'polymarket':
        return await fetchPolymarketPrice(alert.marketSlug || alert.symbol, alert.side || 'YES');
      case 'opinion':
        return null;
      case 'aavecap':
        return await fetchAaveCapUtil(alert.symbol, alert.chainId || 1);
      case 'contract':
        return await fetchContractPrice(alert.contractAddress, alert.contractChain);
      default:
        return null;
    }
  } catch (e) {
    console.error(`[fetchPrice] ${alert.symbol}:`, e.message);
    return null;
  }
}

function fmtPrice(price, type) {
  if (price == null) return '?';
  if (type === 'polymarket' || type === 'opinion') return (price * 100).toFixed(1) + '¢';
  if (type === 'aavecap') return price.toFixed(2) + '%';
  if (price < 0.000001) return '$' + price.toExponential(2);
  if (price < 0.01) return '$' + price.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
  if (price < 1) return '$' + price.toFixed(4);
  if (price < 2) return '$' + price.toFixed(4);
  return '$' + price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

module.exports = { fetchPrice, fmtPrice, AAVE_CHAIN_NAMES, fetchCryptoPrice };

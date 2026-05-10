/**
 * Price fetchers — server-side mirrors of all sources used in your browser.
 * Supports: crypto, stock/ETF, Polymarket, Opinion, Aave cap %, contract tokens.
 */

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// ── CoinGecko ID map (mirrors browser CRYPTO_GECKO_IDS) ──────────────────────

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
  OP:'optimism', ARB:'arbitrum', BASE:'base',
};

function geckoId(sym) {
  return GECKO_IDS[sym.toUpperCase()] || sym.toLowerCase();
}

// ── Jupiter mints for Solana-native tokens ────────────────────────────────────

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

// ── Aave GraphQL ──────────────────────────────────────────────────────────────

const AAVE_GQL = 'https://api.v3.aave.com/graphql';

const AAVE_CHAIN_NAMES = {
  1: 'Ethereum', 137: 'Polygon', 43114: 'Avalanche',
  10: 'Optimism', 42161: 'Arbitrum', 8453: 'Base',
  56: 'BSC', 100: 'Gnosis', 250: 'Fantom', 1088: 'Metis',
  4326: 'MegaETH',
};

// ── Crypto price ──────────────────────────────────────────────────────────────

async function fetchCryptoPrice(symbol) {
  const sym = symbol.toUpperCase();

  // 1. Jupiter (Solana-native tokens)
  const mint = JUPITER_MINTS[sym];
  if (mint) {
    const d = await safeFetch(`https://api.jup.ag/price/v2?ids=${mint}`);
    const price = d?.data?.[mint]?.price;
    if (price != null) return parseFloat(price);
  }

  // 1b. Jupiter dynamic search
  const mints = await safeFetch(
    `https://lite-api.jup.ag/tokens/v1/mints/by-symbol?symbol=${encodeURIComponent(sym)}`
  );
  if (Array.isArray(mints) && mints.length > 0) {
    const pd = await safeFetch(`https://api.jup.ag/price/v2?ids=${mints[0]}`);
    const price = pd?.data?.[mints[0]]?.price;
    if (price != null) return parseFloat(price);
  }

  // 2. CoinGecko
  const cgId = geckoId(sym);
  const cg = await safeFetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(cgId)}&vs_currencies=usd`
  );
  if (cg?.[cgId]?.usd != null) return cg[cgId].usd;

  // 3. DEX Screener fallback
  const dx = await safeFetch(
    `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(sym)}`
  );
  const pairs = (dx?.pairs || [])
    .filter(p => p.baseToken?.symbol?.toUpperCase() === sym && p.priceUsd)
    .sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0));
  if (pairs[0]?.priceUsd) return parseFloat(pairs[0].priceUsd);

  return null;
}

// ── Stock / ETF price (Yahoo Finance) ────────────────────────────────────────

async function fetchStockPrice(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol.toUpperCase())}?interval=1d&range=1d`;
  const raw = await safeFetch(url);
  const result = raw?.chart?.result?.[0];
  if (!result) return null;
  const meta = result.meta;
  return meta?.regularMarketPrice ?? meta?.previousClose ?? null;
}

// ── Polymarket probability ────────────────────────────────────────────────────

async function fetchPolymarketPrice(slug, side = 'YES') {
  const url = `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}&limit=1`;
  const res = await safeFetch(url);
  const market = Array.isArray(res) ? res[0] : (res?.markets?.[0] || null);
  if (!market) return null;

  // outcomePrices fast path
  if (market.outcomePrices) {
    try {
      const prices = JSON.parse(market.outcomePrices);
      const prob = side === 'YES' ? parseFloat(prices[0]) : parseFloat(prices[1]);
      if (!isNaN(prob)) return prob;
    } catch (e) {}
  }

  // CLOB last-trade-price
  const tokens = market.tokens || market.clobTokenIds;
  if (tokens?.length > 0) {
    const sidx = side === 'YES' ? 0 : 1;
    const tk = tokens[Math.min(sidx, tokens.length - 1)];
    const tokenId = typeof tk === 'string' ? tk : tk?.token_id;
    if (tokenId) {
      const pr = await safeFetch(`https://clob.polymarket.com/last-trade-price?token_id=${tokenId}`);
      if (pr?.price) return parseFloat(pr.price);
    }
  }
  return null;
}

// ── Aave supply cap utilization % ────────────────────────────────────────────

async function fetchAaveCapUtil(symbol, chainId) {
  const query = JSON.stringify({
    query: '{ markets(request: { chainIds: [' + chainId + '] }) { chain { chainId } reserves { underlyingToken { symbol } supplyInfo { total { value } supplyCap { amount { value } } supplyCapReached } } } }'
  });

  // Try multiple approaches to reach Aave API (it blocks non-browser requests)
  const AAVE_PROXY = '/api/aave-proxy';
  const BROWSER_HEADERS = {
    'Content-Type': 'application/json',
    'Origin': 'https://app.aave.com',
    'Referer': 'https://app.aave.com/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  };
  const attempts = [
    // Direct with full browser headers (User-Agent spoofing) — works from server-side
    () => safeFetch(AAVE_GQL, { method: 'POST', headers: BROWSER_HEADERS, body: query, timeout: 12000 }),
    // Our own Vercel proxy as fallback
    () => safeFetch(AAVE_PROXY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: query, timeout: 12000 }),
    // Via allorigins proxy
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

// ── Contract token price (DEX Screener) ──────────────────────────────────────

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

// ── Router ────────────────────────────────────────────────────────────────────

async function fetchPrice(alert) {
  try {
    switch (alert.type) {
      case 'crypto':
        return await fetchCryptoPrice(alert.symbol);

      case 'stock':
      case 'etf':
        return await fetchStockPrice(alert.symbol);

      case 'polymarket':
        return await fetchPolymarketPrice(alert.symbol, alert.side || 'YES');

      case 'opinion':
        // Opinion.trade requires an API key — skip server-side (key stays in browser)
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

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtPrice(price, type) {
  if (price == null) return '?';
  if (type === 'polymarket' || type === 'opinion') {
    return (price * 100).toFixed(1) + '¢';
  }
  if (type === 'aavecap') {
    return price.toFixed(2) + '%';
  }
  if (price < 0.01) return '$' + price.toFixed(6);
  if (price < 1)    return '$' + price.toFixed(4);
  return '$' + price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}



module.exports = { fetchPrice, fmtPrice, AAVE_CHAIN_NAMES };

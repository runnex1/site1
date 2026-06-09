const { loopTokenLogoDataUrl, LOOP_TOKEN_LOGOS } = require('./loop-token-logos');

const LOOP_LOGO_PROTOCOLS = ['Aave', 'Morpho', 'Fluid'];

const GECKO_IDS = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  BNB: 'binancecoin',
  AVAX: 'avalanche-2',
  MATIC: 'matic-network',
  POL: 'matic-network',
  ARB: 'arbitrum',
  OP: 'optimism',
  LINK: 'chainlink',
  UNI: 'uniswap',
  AAVE: 'aave',
  CRV: 'curve-dao-token',
  CVX: 'convex-finance',
  LDO: 'lido-dao',
  MKR: 'maker',
  SNX: 'synthetix-network-token',
  COMP: 'compound-governance-token',
  YFI: 'yearn-finance',
  SUSHI: 'sushi',
  BAL: 'balancer',
  '1INCH': '1inch',
  DOGE: 'dogecoin',
  SHIB: 'shiba-inu',
  PEPE: 'pepe',
  XRP: 'ripple',
  ADA: 'cardano',
  DOT: 'polkadot',
  ATOM: 'cosmos',
  LTC: 'litecoin',
  USDC: 'usd-coin',
  USDT: 'tether',
  DAI: 'dai',
  FRAX: 'frax',
  USDE: 'ethena-usde',
  SUSDE: 'ethena-staked-usde',
  REUSD: 're-protocol-reusd',
  USDM: 'mountain-protocol-usdm',
  WBTC: 'wrapped-bitcoin',
  STETH: 'staked-ether',
  WSTETH: 'wrapped-steth',
  RETH: 'rocket-pool-eth',
  CBETH: 'coinbase-wrapped-staked-eth',
  ENA: 'ethena',
  PENDLE: 'pendle',
  MORPHO: 'morpho',
  GMX: 'gmx',
  RLP: 'resolv-liquidity-token',
  USR: 'resolv-usr',
};

const TOKEN_TO_LLAMA_SLUG = {
  ENA: 'ethena',
  USDE: 'ethena',
  SUSDE: 'ethena',
  SPECTRA: 'spectra',
  PENDLE: 'pendle',
  MORPHO: 'morpho',
  AAVE: 'aave',
  REUSD: 're',
  USDM: 'm0',
  USDC: 'usd-coin',
  USDT: 'tether',
  UNI: 'uniswap',
  CRV: 'curve-dex',
  LDO: 'lido',
  GMX: 'gmx',
  OP: 'optimism',
  ARB: 'arbitrum',
  RLP: 'resolv',
  USR: 'resolv',
};

const MANUAL_LOGO_URLS = {
  RLP: 'https://icons.llamao.fi/icons/protocols/resolv',
  USR: 'https://icons.llamao.fi/icons/protocols/resolv',
};

function toSlug(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function isDataImageUrl(url) {
  return String(url || '').startsWith('data:image/');
}

function isSvgFallbackDataUrl(url) {
  const u = String(url || '');
  return u.startsWith('data:image/svg+xml');
}

function tokenLogoKey(symbol) {
  return `token:${String(symbol || '').toUpperCase()}`;
}

function isLoopPinnedTokenLogo(symbol) {
  return Boolean(loopTokenLogoDataUrl(symbol));
}

function readLocalLoopLogoDataUrl(symbol) {
  return loopTokenLogoDataUrl(symbol);
}

function protocolLogoKey(name) {
  return `protocol:${String(name || '').toLowerCase().trim()}`;
}

function coingeckoHeaders() {
  const headers = { Accept: 'application/json' };
  if (process.env.COINGECKO_API_KEY) {
    headers['x-cg-demo-api-key'] = process.env.COINGECKO_API_KEY;
  }
  return headers;
}

async function fetchJson(url, timeout = 10000) {
  try {
    const res = await fetch(url, {
      headers: coingeckoHeaders(),
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function pickCoingeckoImage(coin) {
  return coin?.image?.large || coin?.image?.small || coin?.image?.thumb || null;
}

async function coingeckoImageUrlForSymbol(symbol) {
  const upper = String(symbol || '').toUpperCase();
  const mappedId = GECKO_IDS[upper];
  if (mappedId) {
    const coin = await fetchJson(
      `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(mappedId)}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false&sparkline=false`,
    );
    const image = pickCoingeckoImage(coin);
    if (image) return { image, geckoId: mappedId, source: 'coingecko' };
  }

  const search = await fetchJson(
    `https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(upper)}`,
  );
  const matches = (search?.coins || [])
    .filter(c => String(c?.symbol || '').toUpperCase() === upper)
    .sort((a, b) => (Number(a?.market_cap_rank) || 999999) - (Number(b?.market_cap_rank) || 999999));
  const match = matches[0];
  if (!match) return null;

  if (match.large || match.thumb) {
    return { image: match.large || match.thumb, geckoId: match.id, source: 'coingecko' };
  }
  if (!match.id) return null;

  const coin = await fetchJson(
    `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(match.id)}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false&sparkline=false`,
  );
  const image = pickCoingeckoImage(coin);
  return image ? { image, geckoId: match.id, source: 'coingecko' } : null;
}

function defillamaTokenLogoUrls(symbol) {
  const upper = String(symbol || '').toUpperCase();
  const lower = String(symbol || '').toLowerCase();
  const llamaSlug = TOKEN_TO_LLAMA_SLUG[upper] || lower;
  return [
    MANUAL_LOGO_URLS[upper] || null,
    `https://icons.llamao.fi/icons/protocols/${llamaSlug}`,
    llamaSlug !== lower ? `https://icons.llamao.fi/icons/protocols/${lower}` : null,
  ].filter(Boolean);
}

function protocolLogoSources(name) {
  const lower = String(name || '').toLowerCase().trim();
  const slug = toSlug(name);
  const baseSlug = toSlug(String(name || '').replace(/\s+v\d.*$/i, '').trim());
  const first = String(name || '').split(' ')[0].toLowerCase();
  return [
    `https://icons.llamao.fi/icons/protocols/${slug}`,
    `https://icons.llamao.fi/icons/protocols/${baseSlug}`,
    first ? `https://icons.llamao.fi/icons/protocols/${first}` : null,
    lower === 'fluid' ? 'https://icons.llamao.fi/icons/protocols/fluid-lending' : null,
    `https://raw.githubusercontent.com/spothq/cryptocurrency-icons/master/128/color/${baseSlug}.png`,
  ].filter(Boolean);
}

async function fetchImageAsDataUrl(url) {
  if (!url || isDataImageUrl(url)) return url || null;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'image/*,*/*;q=0.8' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const contentType = String(res.headers.get('content-type') || 'image/png').split(';')[0].trim();
    if (!contentType.startsWith('image/')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > 512 * 1024) return null;
    return `data:${contentType};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

async function resolveFirstDataUrl(sources) {
  const unique = [...new Set((sources || []).filter(Boolean))];
  for (const source of unique) {
    const dataUrl = await fetchImageAsDataUrl(source);
    if (dataUrl && !isSvgFallbackDataUrl(dataUrl)) return dataUrl;
  }
  return null;
}

async function resolveTokenLogoDataUrl(symbol) {
  const pinned = readLocalLoopLogoDataUrl(symbol);
  if (pinned) return { dataUrl: pinned, source: 'loop-pinned', geckoId: null };

  const cg = await coingeckoImageUrlForSymbol(symbol);
  if (cg?.image) {
    const dataUrl = await fetchImageAsDataUrl(cg.image);
    if (dataUrl && !isSvgFallbackDataUrl(dataUrl)) {
      return { dataUrl, source: cg.source, geckoId: cg.geckoId };
    }
  }

  const llamaDataUrl = await resolveFirstDataUrl(defillamaTokenLogoUrls(symbol));
  if (llamaDataUrl) return { dataUrl: llamaDataUrl, source: 'defillama', geckoId: null };

  return null;
}

function hasEmbeddedLogo(cache, key) {
  const item = cache?.[key];
  return Boolean(
    item?.url
    && item?.source
    && isDataImageUrl(item.url)
    && !isSvgFallbackDataUrl(item.url),
  );
}

function collectLoopLogoTargets(positions) {
  const protocols = new Set(LOOP_LOGO_PROTOCOLS);
  const tokens = new Set();

  for (const pos of positions || []) {
    if (pos?.protocol) protocols.add(String(pos.protocol));
    for (const leg of [...(pos?.supplied || []), ...(pos?.borrowed || [])]) {
      const sym = String(leg?.symbol || '').trim();
      if (sym) tokens.add(sym.toUpperCase());
    }
  }

  const targets = [];
  for (const protocol of protocols) {
    targets.push({
      kind: 'protocol',
      key: protocolLogoKey(protocol),
      sources: protocolLogoSources(protocol),
    });
  }
  for (const token of tokens) {
    targets.push({
      kind: 'token',
      key: tokenLogoKey(token),
      symbol: token,
    });
  }
  return targets;
}

async function ensureLogoCacheTargets(cache, targets, { maxResolve = 12 } = {}) {
  const next = { ...(cache || {}) };
  let changed = false;
  let resolved = 0;

  for (const target of targets || []) {
    if (!target?.key) continue;
    if (hasEmbeddedLogo(next, target.key) && !(target.kind === 'token' && isLoopPinnedTokenLogo(target.symbol))) {
      continue;
    }
    if (resolved >= maxResolve) break;

    let result = null;
    if (target.kind === 'token') {
      result = await resolveTokenLogoDataUrl(target.symbol);
    } else {
      const dataUrl = await resolveFirstDataUrl(target.sources);
      if (dataUrl) result = { dataUrl, source: 'defillama', geckoId: null };
    }
    resolved += 1;
    if (!result?.dataUrl) continue;

    next[target.key] = {
      url: result.dataUrl,
      ts: Date.now(),
      source: result.source,
      geckoId: result.geckoId || undefined,
    };
    changed = true;
  }

  return { cache: next, changed };
}

async function ensureLoopLogoCache(cache, positions, options) {
  const targets = collectLoopLogoTargets(positions);
  return ensureLogoCacheTargets(cache, targets, options);
}

module.exports = {
  GECKO_IDS,
  LOOP_TOKEN_LOGOS,
  collectLoopLogoTargets,
  ensureLoopLogoCache,
  ensureLogoCacheTargets,
  resolveTokenLogoDataUrl,
  coingeckoImageUrlForSymbol,
  hasEmbeddedLogo,
  fetchImageAsDataUrl,
  tokenLogoKey,
  protocolLogoKey,
  isDataImageUrl,
  isLoopPinnedTokenLogo,
  readLocalLoopLogoDataUrl,
};

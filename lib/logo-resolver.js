const LOOP_LOGO_PROTOCOLS = ['Aave', 'Morpho', 'Fluid'];

const TOKEN_TO_LLAMA_SLUG = {
  ENA: 'ethena',
  USDE: 'ethena',
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

function protocolLogoKey(name) {
  return `protocol:${String(name || '').toLowerCase().trim()}`;
}

function tokenLogoSources(symbol) {
  const upper = String(symbol || '').toUpperCase();
  const lower = String(symbol || '').toLowerCase();
  const llamaSlug = TOKEN_TO_LLAMA_SLUG[upper] || lower;
  return [
    MANUAL_LOGO_URLS[upper] || null,
    `https://icons.llamao.fi/icons/protocols/${llamaSlug}`,
    llamaSlug !== lower ? `https://icons.llamao.fi/icons/protocols/${lower}` : null,
    `https://raw.githubusercontent.com/spothq/cryptocurrency-icons/master/128/color/${lower}.png`,
    `https://assets.coincap.io/assets/icons/${lower}@2x.png`,
    `https://cryptologos.cc/logos/${lower}-${lower}-logo.png`,
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
      key: protocolLogoKey(protocol),
      sources: protocolLogoSources(protocol),
    });
  }
  for (const token of tokens) {
    targets.push({
      key: tokenLogoKey(token),
      sources: tokenLogoSources(token),
    });
  }
  return targets;
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

function hasEmbeddedLogo(cache, key) {
  const item = cache?.[key];
  return Boolean(item?.url && isDataImageUrl(item.url) && !isSvgFallbackDataUrl(item.url));
}

async function ensureLogoCacheTargets(cache, targets, { maxResolve = 12 } = {}) {
  const next = { ...(cache || {}) };
  let changed = false;
  let resolved = 0;

  for (const target of targets || []) {
    if (!target?.key) continue;
    if (hasEmbeddedLogo(next, target.key)) continue;
    if (resolved >= maxResolve) break;

    const existingUrl = next[target.key]?.url;
    const sources = existingUrl && !isDataImageUrl(existingUrl)
      ? [existingUrl, ...(target.sources || [])]
      : (target.sources || []);

    const dataUrl = await resolveFirstDataUrl(sources);
    resolved += 1;
    if (!dataUrl) continue;

    next[target.key] = { url: dataUrl, ts: Date.now() };
    changed = true;
  }

  return { cache: next, changed };
}

async function ensureLoopLogoCache(cache, positions, options) {
  const targets = collectLoopLogoTargets(positions);
  return ensureLogoCacheTargets(cache, targets, options);
}

module.exports = {
  collectLoopLogoTargets,
  ensureLoopLogoCache,
  ensureLogoCacheTargets,
  fetchImageAsDataUrl,
  tokenLogoKey,
  protocolLogoKey,
  isDataImageUrl,
};

/**
 * GRVT egress proxy — defaults to Romania (RO), a supported GRVT region.
 *
 * Resolution order:
 * 1. GRVT_PROXY_URL or HTTPS_PROXY (full URL)
 * 2. IPRoyal residential (IPROYAL_PROXY_USER + IPROYAL_PROXY_PASS, or GRVT_PROXY_USER/PASS)
 * 3. Generic host (GRVT_PROXY_HOST + optional user/pass)
 * 4. Webshare API (WEBSHARE_API_KEY) — fetches a RO proxy from your plan
 */

const DEFAULT_GRVT_PROXY_COUNTRY = 'ro';
const WEBSHARE_PROXY_CACHE_MS = 5 * 60 * 1000;

function grvtProxyCountry() {
  const raw = String(process.env.GRVT_PROXY_COUNTRY || DEFAULT_GRVT_PROXY_COUNTRY).trim().toLowerCase();
  return raw || DEFAULT_GRVT_PROXY_COUNTRY;
}

function grvtProxyUrlFromExplicit() {
  return String(process.env.GRVT_PROXY_URL || process.env.HTTPS_PROXY || '').trim() || null;
}

function encodeProxyUserPass(user, pass) {
  return `${encodeURIComponent(user)}:${encodeURIComponent(pass)}`;
}

function buildIproyalProxyUrl() {
  const user = String(process.env.IPROYAL_PROXY_USER || '').trim();
  const pass = String(process.env.IPROYAL_PROXY_PASS || '').trim();
  if (!user || !pass) return null;
  const host = String(process.env.IPROYAL_PROXY_HOST || 'geo.iproyal.com').trim();
  const port = String(process.env.IPROYAL_PROXY_PORT || '12321').trim();
  const country = grvtProxyCountry();
  const session = String(process.env.GRVT_PROXY_SESSION || `grvt${Math.floor(Date.now() / 60000)}`).trim();
  const passWithCountry = pass.includes('_country-')
    ? pass
    : `${pass}_country-${country}_session-${session}`;
  return `http://${encodeProxyUserPass(user, passWithCountry)}@${host}:${port}`;
}

function buildBrightDataProxyUrl() {
  const user = String(process.env.BRIGHTDATA_PROXY_USER || process.env.LUMINATI_PROXY_USER || '').trim();
  const pass = String(process.env.BRIGHTDATA_PROXY_PASS || process.env.LUMINATI_PROXY_PASS || '').trim();
  if (!user || !pass) return null;
  const host = String(process.env.BRIGHTDATA_PROXY_HOST || 'brd.superproxy.io').trim();
  const port = String(process.env.BRIGHTDATA_PROXY_PORT || '22225').trim();
  const country = grvtProxyCountry();
  const userWithCountry = user.includes('-country-') ? user : `${user}-country-${country}`;
  return `http://${encodeProxyUserPass(userWithCountry, pass)}@${host}:${port}`;
}

function buildComponentProxyUrl() {
  const host = String(process.env.GRVT_PROXY_HOST || '').trim();
  const user = String(process.env.GRVT_PROXY_USER || '').trim();
  const pass = String(process.env.GRVT_PROXY_PASS || '').trim();
  if (!host) return null;
  const port = String(process.env.GRVT_PROXY_PORT || '8080').trim();
  if (user && pass) {
    return `http://${encodeProxyUserPass(user, pass)}@${host}:${port}`;
  }
  return `http://${host}:${port}`;
}

function webshareProxyToUrl(proxy, mode) {
  if (!proxy?.username || !proxy?.password) return null;
  const auth = encodeProxyUserPass(proxy.username, proxy.password);
  if (mode === 'backbone' || !proxy.proxy_address) {
    const port = Number(proxy.port) || 80;
    return `http://${auth}@p.webshare.io:${port}`;
  }
  return `http://${auth}@${proxy.proxy_address}:${proxy.port}`;
}

let _webshareCache = null;

async function fetchWebshareCountryProxyUrl() {
  const apiKey = String(process.env.WEBSHARE_API_KEY || '').trim();
  if (!apiKey) return null;
  if (_webshareCache && _webshareCache.expiresAt > Date.now()) {
    return _webshareCache.url;
  }

  const mode = String(process.env.WEBSHARE_PROXY_MODE || 'backbone').trim();
  const country = grvtProxyCountry().toUpperCase();
  const params = new URLSearchParams({
    mode,
    page: '1',
    page_size: '1',
    country_code__in: country,
    valid: 'true',
  });
  const r = await fetch(`https://proxy.webshare.io/api/v2/proxy/list/?${params}`, {
    headers: { Authorization: `Token ${apiKey}` },
  });
  if (!r.ok) {
    throw new Error(`Webshare proxy list HTTP ${r.status}`);
  }
  const data = await r.json().catch(() => ({}));
  const proxy = data?.results?.[0];
  const url = webshareProxyToUrl(proxy, mode);
  if (!url) {
    throw new Error(`Webshare returned no ${country} proxies`);
  }
  _webshareCache = {
    url,
    expiresAt: Date.now() + WEBSHARE_PROXY_CACHE_MS,
    country,
    source: 'webshare',
  };
  return url;
}

let _resolvedMeta = null;
let _resolvedAgent = null;

async function resolveGrvtProxyMeta() {
  const explicit = grvtProxyUrlFromExplicit();
  if (explicit) {
    return { url: explicit, source: 'env', country: grvtProxyCountry() };
  }

  const iproyal = buildIproyalProxyUrl();
  if (iproyal) {
    return { url: iproyal, source: 'iproyal', country: grvtProxyCountry() };
  }

  const brightData = buildBrightDataProxyUrl();
  if (brightData) {
    return { url: brightData, source: 'brightdata', country: grvtProxyCountry() };
  }

  const component = buildComponentProxyUrl();
  if (component) {
    return { url: component, source: 'component', country: grvtProxyCountry() };
  }

  try {
    const webshareUrl = await fetchWebshareCountryProxyUrl();
    if (webshareUrl) {
      return { url: webshareUrl, source: 'webshare', country: grvtProxyCountry() };
    }
  } catch (e) {
    if (String(process.env.GRVT_PROXY_REQUIRED || '').trim() === '1') {
      throw e;
    }
  }

  return { url: null, source: 'none', country: grvtProxyCountry() };
}

async function resolveGrvtProxyAgent() {
  const meta = await resolveGrvtProxyMeta();
  if (!meta.url) {
    _resolvedMeta = meta;
    _resolvedAgent = null;
    return null;
  }
  if (_resolvedAgent && _resolvedMeta?.url === meta.url) {
    return _resolvedAgent;
  }
  const { ProxyAgent } = require('undici');
  _resolvedMeta = meta;
  _resolvedAgent = new ProxyAgent(meta.url);
  return _resolvedAgent;
}

function grvtProxyMeta() {
  return _resolvedMeta;
}

module.exports = {
  DEFAULT_GRVT_PROXY_COUNTRY,
  grvtProxyCountry,
  grvtProxyUrlFromExplicit,
  buildIproyalProxyUrl,
  buildBrightDataProxyUrl,
  buildComponentProxyUrl,
  webshareProxyToUrl,
  resolveGrvtProxyMeta,
  resolveGrvtProxyAgent,
  grvtProxyMeta,
  __test__: {
    encodeProxyUserPass,
    fetchWebshareCountryProxyUrl,
  },
};

/**
 * GRVT egress — prefer direct EU server egress (Vercel fra1 / Germany).
 * GRVT blocks many US and datacenter IPs; Germany is a supported, non-restricted region.
 *
 * Optional override: set GRVT_PROXY_URL (or HTTPS_PROXY) to a proxy you control.
 * We do not auto-fetch third-party residential proxies (Webshare/IPRoyal/etc.).
 */

const DEFAULT_GRVT_EGRESS_COUNTRY = 'de';
const DEFAULT_GRVT_VERCEL_REGION = 'fra1';

function grvtEgressCountry() {
  const raw = String(process.env.GRVT_EGRESS_COUNTRY || process.env.GRVT_PROXY_COUNTRY || DEFAULT_GRVT_EGRESS_COUNTRY).trim().toLowerCase();
  return raw || DEFAULT_GRVT_EGRESS_COUNTRY;
}

function grvtEgressRegion() {
  return String(process.env.VERCEL_REGION || process.env.GRVT_EGRESS_REGION || '').trim() || null;
}

function grvtProxyUrlFromExplicit() {
  return String(process.env.GRVT_PROXY_URL || process.env.HTTPS_PROXY || '').trim() || null;
}

let _resolvedMeta = null;
let _resolvedAgent = null;

async function resolveGrvtProxyMeta() {
  const explicit = grvtProxyUrlFromExplicit();
  if (explicit) {
    return {
      url: explicit,
      source: 'env',
      country: grvtEgressCountry(),
      region: grvtEgressRegion(),
    };
  }

  return {
    url: null,
    source: 'direct',
    country: grvtEgressCountry(),
    region: grvtEgressRegion() || DEFAULT_GRVT_VERCEL_REGION,
  };
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
  DEFAULT_GRVT_EGRESS_COUNTRY,
  DEFAULT_GRVT_VERCEL_REGION,
  grvtEgressCountry,
  grvtEgressRegion,
  grvtProxyCountry: grvtEgressCountry,
  grvtProxyUrlFromExplicit,
  resolveGrvtProxyMeta,
  resolveGrvtProxyAgent,
  grvtProxyMeta,
};

'use strict';

const COINGECKO_KEY_ENV = ['COINGECKO_API_KEY', 'COINGECKO_API_KEY1'];

function coinGeckoApiKeys() {
  const keys = [];
  const seen = new Set();
  for (const name of COINGECKO_KEY_ENV) {
    const key = String(process.env[name] || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

function coingeckoHeaders(apiKey) {
  const headers = { Accept: 'application/json' };
  if (apiKey) headers['x-cg-demo-api-key'] = apiKey;
  return headers;
}

function isRateLimitedResponse(status, data) {
  if (status === 429) return true;
  const msg = String(data?.status?.error_message || data?.error || '').toLowerCase();
  if (/rate.?limit|too many|exceeded|monthly|quota|credit|throttl/.test(msg)) return true;
  const code = Number(data?.status?.error_code);
  return code === 429;
}

async function fetchCoinGeckoWithFailover(url, opts = {}) {
  const timeout = Number(opts.timeout) || 10000;
  const keys = coinGeckoApiKeys();
  const attempts = keys.length ? keys : [null];
  let lastStatus = 0;
  let lastData = null;
  let lastError = null;

  for (let i = 0; i < attempts.length; i++) {
    const apiKey = attempts[i];
    try {
      const res = await fetch(url, {
        headers: coingeckoHeaders(apiKey),
        signal: AbortSignal.timeout(timeout),
      });
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { error: text || 'Invalid CoinGecko response' };
      }
      if (res.ok) {
        return { ok: true, status: res.status, data, keyIndex: i };
      }
      lastStatus = res.status;
      lastData = data;
      if (isRateLimitedResponse(res.status, data) && i < attempts.length - 1) {
        console.warn(`[coingecko] Key ${i + 1}/${attempts.length} rate limited — trying backup`);
        continue;
      }
      return {
        ok: false,
        status: res.status,
        data,
        error: data?.status?.error_message || data?.error || `CoinGecko returned HTTP ${res.status}`,
        keyIndex: i,
      };
    } catch (err) {
      lastError = err;
      if (i < attempts.length - 1) {
        console.warn(`[coingecko] Key ${i + 1}/${attempts.length} failed — trying backup`);
        continue;
      }
    }
  }

  return {
    ok: false,
    status: lastStatus,
    data: lastData,
    error: lastError?.message || lastData?.status?.error_message || lastData?.error || 'CoinGecko request failed',
  };
}

module.exports = {
  COINGECKO_KEY_ENV,
  coinGeckoApiKeys,
  coingeckoHeaders,
  fetchCoinGeckoWithFailover,
  isRateLimitedResponse,
};

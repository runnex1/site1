/**
 * Polymarket wallet idle collateral on Polygon (not deployed into positions).
 * Sums USDC.e + native USDC + pUSD (v2 collateral) for the user's EOA and proxy wallet.
 */

const https = require('https');

const USDC_BRIDGED = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const USDC_NATIVE = '0x3c499c542cEF5E3811e1192ce70d8eCc2d86790C';
const PUSD = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB';
const COLLATERAL_TOKENS = [USDC_BRIDGED, USDC_NATIVE, PUSD];
const USDC_DECIMALS = 6;
const BALANCE_OF_SELECTOR = '0x70a08231';
const GAMMA_PROFILE_URL = 'https://gamma-api.polymarket.com/public-profile';

const POLYGON_RPCS = [
  'https://polygon-bor-rpc.publicnode.com',
  'https://1rpc.io/matic',
  'https://rpc.ankr.com/polygon',
];

function isWallet(addr) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(addr || '').trim());
}

function normalizeWallet(addr) {
  return String(addr || '').trim().toLowerCase();
}

function encodeBalanceOfData(wallet) {
  const padded = String(wallet).toLowerCase().replace(/^0x/, '').padStart(64, '0');
  return BALANCE_OF_SELECTOR + padded;
}

function hexToUsdcAmount(hex) {
  if (!hex || hex === '0x') return 0;
  try {
    return Number(BigInt(hex)) / (10 ** USDC_DECIMALS);
  } catch {
    return 0;
  }
}

async function resolveHost(hostname) {
  const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`, {
    headers: { accept: 'application/dns-json' },
  });
  if (!response.ok) throw new Error(`DNS fallback returned HTTP ${response.status}`);
  const payload = await response.json();
  const ip = (payload.Answer || []).map(answer => answer.data).find(data => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(data));
  if (!ip) throw new Error(`Could not resolve ${hostname}`);
  return ip;
}

function fetchJsonViaResolvedIp(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    resolveHost(url.hostname).then((ip) => {
      const req = https.request({
        hostname: ip,
        servername: url.hostname,
        path: url.pathname + url.search,
        method: 'GET',
        timeout: timeoutMs,
        headers: { host: url.hostname, accept: 'application/json' },
      }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`HTTP ${response.statusCode}`));
            return;
          }
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error('Invalid JSON')); }
        });
      });
      req.on('timeout', () => req.destroy(new Error('Timed out')));
      req.on('error', reject);
      req.end();
    }).catch(reject);
  });
}

async function fetchGammaJson(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' }, signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      return await fetchJsonViaResolvedIp(url, timeoutMs);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function resolvePolymarketProxyWallet(wallet) {
  const addr = normalizeWallet(wallet);
  if (!isWallet(addr)) return null;
  try {
    const url = new URL(GAMMA_PROFILE_URL);
    url.searchParams.set('address', addr);
    const profile = await fetchGammaJson(url, 8000);
    const proxy = normalizeWallet(profile?.proxyWallet);
    if (isWallet(proxy) && proxy !== addr) return proxy;
  } catch (e) {
    // Profile lookup is best-effort; on-chain balance still checked on the input wallet.
  }
  return null;
}

async function fundingAddressesForWallet(wallet) {
  const addr = normalizeWallet(wallet);
  const addresses = [addr];
  const proxy = await resolvePolymarketProxyWallet(addr);
  if (proxy && !addresses.includes(proxy)) addresses.push(proxy);
  return addresses;
}

async function fetchPolygonErc20Balance(token, wallet, rpcUrl, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to: token, data: encodeBalanceOfData(wallet) }, 'latest'],
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || 'RPC error');
    return hexToUsdcAmount(json.result);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAddressCollateralOnPolygon(address) {
  let lastError = null;
  for (const rpc of POLYGON_RPCS) {
    try {
      const parts = await Promise.all(
        COLLATERAL_TOKENS.map(token => fetchPolygonErc20Balance(token, address, rpc)),
      );
      return { usdc: parts.reduce((sum, n) => sum + n, 0), error: null };
    } catch (e) {
      lastError = e;
    }
  }
  return { usdc: null, error: lastError?.message || 'RPC failed' };
}

async function fetchWalletUsdcOnPolygon(wallet) {
  const userWallet = normalizeWallet(wallet);
  const fundingAddresses = await fundingAddressesForWallet(userWallet);
  let total = 0;
  let lastError = null;
  for (const address of fundingAddresses) {
    const row = await fetchAddressCollateralOnPolygon(address);
    if (row.usdc == null) {
      lastError = row.error;
      continue;
    }
    total += row.usdc;
  }
  if (!Number.isFinite(total) && lastError) {
    return { wallet: userWallet, usdc: null, proxyWallet: fundingAddresses[1] || null, error: lastError };
  }
  return {
    wallet: userWallet,
    usdc: total,
    proxyWallet: fundingAddresses[1] || null,
    error: null,
  };
}

async function fetchPolymarketWalletBalances(wallets, concurrency = 4) {
  const list = [...new Set((wallets || []).map(w => String(w || '').trim()).filter(isWallet))];
  const out = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, list.length || 1) }, async () => {
    while (next < list.length) {
      const i = next++;
      out[i] = await fetchWalletUsdcOnPolygon(list[i]);
    }
  });
  await Promise.all(workers);
  const balances = out.filter(Boolean);
  const total = balances.reduce((sum, row) => sum + (Number.isFinite(row.usdc) ? row.usdc : 0), 0);
  return {
    wallets: list.length,
    total,
    balances,
    partial: balances.some(row => row.usdc == null),
  };
}

module.exports = {
  USDC_BRIDGED,
  USDC_NATIVE,
  PUSD,
  COLLATERAL_TOKENS,
  isWallet,
  hexToUsdcAmount,
  encodeBalanceOfData,
  resolvePolymarketProxyWallet,
  fundingAddressesForWallet,
  fetchPolymarketWalletBalances,
};

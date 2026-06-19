/**
 * Polymarket wallet idle USDC on Polygon (not deployed into positions).
 * Sums bridged USDC.e + native USDC ERC-20 balances for each proxy/funder address.
 */

const USDC_BRIDGED = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const USDC_NATIVE = '0x3c499c542cEF5E3811e1192ce70d8eCc2d86790C';
const USDC_DECIMALS = 6;
const BALANCE_OF_SELECTOR = '0x70a08231';

const POLYGON_RPCS = [
  'https://polygon-bor-rpc.publicnode.com',
  'https://1rpc.io/matic',
  'https://rpc.ankr.com/polygon',
];

function isWallet(addr) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(addr || '').trim());
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

async function fetchWalletUsdcOnPolygon(wallet) {
  let lastError = null;
  for (const rpc of POLYGON_RPCS) {
    try {
      const [bridged, native] = await Promise.all([
        fetchPolygonErc20Balance(USDC_BRIDGED, wallet, rpc),
        fetchPolygonErc20Balance(USDC_NATIVE, wallet, rpc),
      ]);
      return { wallet: wallet.toLowerCase(), usdc: bridged + native, error: null };
    } catch (e) {
      lastError = e;
    }
  }
  return { wallet: wallet.toLowerCase(), usdc: null, error: lastError?.message || 'RPC failed' };
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
  isWallet,
  hexToUsdcAmount,
  encodeBalanceOfData,
  fetchPolymarketWalletBalances,
};

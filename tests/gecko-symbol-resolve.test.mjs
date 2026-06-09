import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

assert.match(indexHtml, /AUSD:'agora-dollar'/, 'AUSD must map to Agora stablecoin');
assert.match(indexHtml, /async function resolveGeckoIdByMarketCap\(symbol\)/, 'market-cap resolver must exist');
assert.match(indexHtml, /async function resolveGeckoIdsForSymbols\(symbols, \{ concurrency = 3 \} = \{\}\)/, 'batch resolver must exist');
assert.doesNotMatch(indexHtml, /return GECKO_SYMBOL_IDS\[sym\] \|\| sym\.toLowerCase\(\)/, 'must not fallback to lowercase id');

async function pickGeckoIdByMarketCap(sym) {
  const search = await fetch(`https://testedefi.vercel.app/api/prices?cgPath=/search&query=${encodeURIComponent(sym)}`).then((r) => r.json());
  const coins = (search?.coins || [])
    .filter((c) => c?.id && String(c.symbol || '').toUpperCase() === sym)
    .slice(0, 12);
  assert.ok(coins.length > 1, 'AUSD should have multiple CoinGecko matches');
  const ids = coins.map((c) => c.id).join(',');
  const markets = await fetch(
    `https://testedefi.vercel.app/api/prices?cgPath=/coins/markets&vs_currency=usd&ids=${encodeURIComponent(ids)}&order=market_cap_desc&per_page=12&page=1&sparkline=false`,
  ).then((r) => r.json());
  markets.sort((a, b) =>
    (Number(a.market_cap_rank || 999999) - Number(b.market_cap_rank || 999999))
    || (Number(b.market_cap || 0) - Number(a.market_cap || 0)),
  );
  return markets[0]?.id || null;
}

const resolved = await pickGeckoIdByMarketCap('AUSD');
assert.equal(resolved, 'agora-dollar', 'highest market-cap AUSD must be Agora Dollar');

const prices = await fetch('https://testedefi.vercel.app/api/prices?ids=agora-dollar,ausd').then((r) => r.json());
assert.ok(prices['agora-dollar']?.usd > 0.99, 'Agora AUSD should be ~$1');
assert.ok(prices.ausd?.usd < 0.5, 'lowercase ausd id is the wrong asset');

console.log('PASS: gecko symbol resolve tests');

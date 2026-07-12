/**
 * Scenario verification for Loops DeFiLlama supply APY enrichment.
 * Run: node scripts/verify-loop-defillama-apy.mjs
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const {
  enrichPositionWithDefillamaYield,
  enrichPositionWithMerkl,
  shouldEnrichLegWithDefillama,
  defillamaApyForLeg,
  fetchDefillamaYieldApyIndex,
  fetchDefillamaChart7dApy,
  buildDefillama7dApyCache,
  computeChart7dMovingAvg,
  buildMerklAprIndex,
} = require('../lib/loop-rates.js');

const CAP_POOL_ID = 'bf6ca887-e357-49ec-8031-0d1a6141c455';
const STC_7D = 4.6644;

const failures = [];

function assert(condition, message) {
  if (!condition) failures.push(message);
}

function makePos({ chainId, supplied, borrowed, suppliedYieldUsd = 0, borrowedCostUsd = 0 }) {
  const totalSupplied = supplied.reduce((s, l) => s + Number(l.value || 0), 0);
  const totalBorrowed = borrowed.reduce((s, l) => s + Number(l.value || 0), 0);
  return {
    chainId,
    protocol: 'Aave',
    wallet: '0x523c4fD04438aAB5e96CADCcDC92c855390Fb459',
    totalSupplied,
    totalBorrowed,
    supplied,
    borrowed,
    suppliedYieldUsd,
    borrowedCostUsd,
    supplyApy: 0,
    borrowApy: borrowed.length ? borrowedCostUsd / totalBorrowed : null,
    netApy: 0,
  };
}

function mockIndex(entries) {
  return {
    bySymbolChain: new Map(entries),
    byAddress: new Map(),
  };
}

function enrich(pos, index, chart7dCache) {
  enrichPositionWithDefillamaYield(pos, index, chart7dCache);
  return pos;
}

console.log('=== Loops DeFiLlama APY scenario verification ===\n');

// 1. Plain collateral — no enrichment
{
  const index = mockIndex([['1:WBTC', { apy: 8.2, poolId: 'wbtc', score: 8.2 }]]);
  const leg = { symbol: 'WBTC', apy: 0, value: 100000, isCollateral: true };
  assert(!shouldEnrichLegWithDefillama(1, leg, index), 'WBTC must not enrich');
  const pos = enrich(makePos({
    chainId: 1,
    supplied: [leg],
    borrowed: [{ symbol: 'USDe', value: 50000, apy: 4.2 }],
  }), index, new Map());
  assert(pos.supplied[0].apy === 0, 'WBTC APY must stay 0');
  assert(!pos.defillamaBoost, 'WBTC must not be defillama-boosted');
  console.log('OK  plain collateral (WBTC)');
}

// 2. stcUSD zero protocol APY — use DeFiLlama 7d chart
{
  const index = mockIndex([['1:STCUSD', { apy: 5.75, poolId: CAP_POOL_ID, score: 1005.75, project: 'cap' }]]);
  const chart7dCache = new Map([[CAP_POOL_ID, STC_7D]]);
  const leg = { symbol: 'stcUSD', apy: 0, isCollateral: true, value: 100000, address: '0x8888' };
  assert(shouldEnrichLegWithDefillama(4326, leg, index, chart7dCache), 'stcUSD zero APY must enrich');
  const pos = enrich(makePos({
    chainId: 4326,
    supplied: [leg],
    borrowed: [{ symbol: 'USDm', value: 50000, apy: 3 }],
  }), index, chart7dCache);
  assert(pos.defillamaBoost, 'stcUSD zero must boost');
  assert(Math.abs(pos.supplyApy - STC_7D) < 0.05, `stcUSD zero → ${pos.supplyApy} expected ~${STC_7D}`);
  console.log('OK  stcUSD zero protocol APY (7d chart)');
}

// 3. stcUSD inflated Aave collateral — replace with 7d chart
{
  const index = mockIndex([['1:STCUSD', { apy: 5.75, poolId: CAP_POOL_ID, score: 1005.75, project: 'cap' }]]);
  const chart7dCache = new Map([[CAP_POOL_ID, STC_7D]]);
  const leg = { symbol: 'stcUSD', apy: 12.5, isCollateral: true, value: 100000, address: '0x8888' };
  assert(shouldEnrichLegWithDefillama(4326, leg, index, chart7dCache), 'stcUSD inflated must enrich');
  const pos = enrich(makePos({
    chainId: 4326,
    supplied: [leg],
    borrowed: [{ symbol: 'USDm', value: 50000, apy: 3 }],
    suppliedYieldUsd: 1_250_000,
    borrowedCostUsd: 1500,
  }), index, chart7dCache);
  assert(Math.abs(leg.apy - STC_7D) < 0.05, `stcUSD leg must be ${STC_7D} not ${leg.apy}`);
  assert(pos.supplyApy < 6, `stcUSD supply must be ~4.66% not ${pos.supplyApy}`);
  console.log('OK  stcUSD inflated Aave collateral (7d chart)');
}

// 4. USD3 Morpho collateral
{
  const index = mockIndex([['1:USD3', { apy: 6.36, poolId: 'usd3-pool', score: 1006.36, project: '3jane-lending' }]]);
  const chart7dCache = new Map([['usd3-pool', 5.88]]);
  const leg = { symbol: 'USD3', apy: 0, isCollateral: true, value: 5000, address: '0x056B' };
  const pos = enrich(makePos({
    chainId: 1,
    supplied: [leg],
    borrowed: [{ symbol: 'USDC', value: 4000, apy: 8 }],
  }), index, chart7dCache);
  assert(pos.defillamaBoost, 'USD3 must boost');
  assert(Math.abs(pos.supplyApy - 5.88) < 0.05, `USD3 supply ${pos.supplyApy}`);
  console.log('OK  USD3 Morpho collateral (7d chart)');
}

// 5. Active Aave USDC supply — keep protocol when reasonable
{
  const index = mockIndex([['1:USDC', { apy: 4.0, poolId: 'usdc-pool', score: 4, project: 'aave-v3' }]]);
  const chart7dCache = new Map([['usdc-pool', 3.9]]);
  const leg = { symbol: 'USDC', apy: 4.5, isCollateral: false, value: 10000 };
  assert(!shouldEnrichLegWithDefillama(1, leg, index, chart7dCache), 'reasonable USDC supply must keep protocol APY');
  const pos = enrich(makePos({
    chainId: 1,
    supplied: [leg],
    borrowed: [{ symbol: 'WETH', value: 8000, apy: 2 }],
    suppliedYieldUsd: 450,
    borrowedCostUsd: 160,
  }), index, chart7dCache);
  assert(!pos.defillamaBoost, 'USDC supply must not defillama-boost');
  assert(Math.abs(leg.apy - 4.5) < 0.01, 'USDC must keep protocol APY');
  console.log('OK  active USDC supply (reasonable protocol APY)');
}

// 6. Chart fetch fallback to spot when chart unavailable
{
  const index = mockIndex([['1:REUSD', { apy: 5.5, poolId: 're-pool', score: 1005.5, project: 're' }]]);
  const leg = { symbol: 'reUSD', apy: 0, value: 20000, address: '0xre' };
  const spotOnly = defillamaApyForLeg(1, leg, index, new Map());
  assert(Math.abs(spotOnly - 5.5) < 0.01, 'missing chart cache must fall back to pools spot APY');
  console.log('OK  chart cache miss falls back to spot APY');
}

// 7. Merkl must not stack on DeFiLlama intrinsic yield legs
{
  const index = mockIndex([['1:STCUSD', { apy: 5.75, poolId: CAP_POOL_ID, score: 1005.75, project: 'cap' }]]);
  const chart7dCache = new Map([[CAP_POOL_ID, STC_7D]]);
  const leg = { symbol: 'stcUSD', apy: 15, isCollateral: true, value: 100000, address: '0xstc' };
  const pos = enrich(makePos({
    chainId: 4326,
    supplied: [leg],
    borrowed: [{ symbol: 'USDm', value: 50000, apy: 3 }],
  }), index, chart7dCache);
  const merklIndex = buildMerklAprIndex([{
    wallet: pos.wallet,
    items: [{
      opportunity: {
        status: 'LIVE',
        chainId: 4326,
        action: 'LEND',
        explorerAddress: '0xstc',
        apr: 8.5,
        name: 'test-campaign',
        tokens: [{ address: '0xstc', symbol: 'stcUSD' }],
      },
    }],
  }]);
  enrichPositionWithMerkl(pos, merklIndex);
  assert(leg.merklApy == null, 'Merkl must not attach to defillama intrinsic leg');
  assert(Math.abs(leg.apy - STC_7D) < 0.05, `Merkl must not inflate leg APY: ${leg.apy}`);
  console.log('OK  Merkl skipped on DeFiLlama collateral');
}

// 8. Live DeFiLlama chart 7d for cap stcUSD
{
  const liveIndex = await fetchDefillamaYieldApyIndex();
  assert(!liveIndex.error, `live index fetch: ${liveIndex.error || 'ok'}`);
  const entry = liveIndex.bySymbolChain.get('1:STCUSD');
  assert(entry?.poolId === CAP_POOL_ID, 'stcUSD must map to cap pool id');
  const live7d = await fetchDefillamaChart7dApy(entry.poolId);
  assert(live7d > 4 && live7d < 6, `live stcUSD 7d ${live7d} must be near 4.66%`);
  const pos = makePos({
    chainId: 4326,
    supplied: [{ symbol: 'stcUSD', apy: 12, isCollateral: true, value: 100000, address: '0x8888' }],
    borrowed: [{ symbol: 'USDm', value: 50000, apy: 3 }],
  });
  const cache = await buildDefillama7dApyCache([pos], liveIndex);
  assert(cache.has(entry.poolId), 'buildDefillama7dApyCache must fetch chart for stcUSD');
  enrich(pos, liveIndex, cache);
  assert(Math.abs(pos.supplyApy - live7d) < 0.15, `live enriched supply ${pos.supplyApy} vs chart ${live7d}`);
  console.log(`OK  live stcUSD 7d chart → ${live7d.toFixed(2)}%`);
}

console.log('\n=== Summary ===');
if (failures.length) {
  console.error(`FAIL: ${failures.length} scenario(s)`);
  failures.forEach((f, i) => console.error(`  ${i + 1}. ${f}`));
  process.exit(1);
}
console.log('PASS: all DeFiLlama supply APY scenarios');

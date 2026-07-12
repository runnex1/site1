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
  buildMerklAprIndex,
} = require('../lib/loop-rates.js');

function defillamaPoolApy(pool) {
  const num = (v, fb = 0) => { const n = Number(v); return Number.isFinite(n) ? n : fb; };
  const base = num(pool.apyBase, NaN);
  const reward = num(pool.apyReward, 0);
  const total = num(pool.apy, 0);
  if (Number.isFinite(base) && base > 0.01) return base;
  if (total > 0.01 && reward > 0.01) return Math.max(total - reward, 0);
  return total;
}

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

function enrich(pos, index) {
  enrichPositionWithDefillamaYield(pos, index);
  return pos;
}

function mockIndex(entries) {
  return {
    bySymbolChain: new Map(entries),
    byAddress: new Map(),
  };
}

console.log('=== Loops DeFiLlama APY scenario verification ===\n');

// 1. Plain collateral — no enrichment
{
  const index = mockIndex([['1:WBTC', { apy: 8.2, score: 8.2 }]]);
  const leg = { symbol: 'WBTC', apy: 0, value: 100000, isCollateral: true };
  assert(!shouldEnrichLegWithDefillama(1, leg, index), 'WBTC must not enrich');
  const pos = enrich(makePos({
    chainId: 1,
    supplied: [leg],
    borrowed: [{ symbol: 'USDe', value: 50000, apy: 4.2 }],
  }), index);
  assert(pos.supplied[0].apy === 0, 'WBTC APY must stay 0');
  assert(!pos.defillamaBoost, 'WBTC must not be defillama-boosted');
  console.log('OK  plain collateral (WBTC)');
}

// 2. stcUSD zero protocol APY — use DeFiLlama
{
  const dlApy = 5.75;
  const index = mockIndex([['1:STCUSD', { apy: dlApy, score: 1005.75, project: 'cap' }]]);
  const leg = { symbol: 'stcUSD', apy: 0, isCollateral: true, value: 100000, address: '0x8888' };
  assert(shouldEnrichLegWithDefillama(4326, leg, index), 'stcUSD zero APY must enrich');
  const pos = enrich(makePos({
    chainId: 4326,
    supplied: [leg],
    borrowed: [{ symbol: 'USDm', value: 50000, apy: 3 }],
  }), index);
  assert(pos.defillamaBoost, 'stcUSD zero must boost');
  assert(Math.abs(pos.supplyApy - dlApy) < 0.05, `stcUSD zero → ${pos.supplyApy} expected ~${dlApy}`);
  console.log('OK  stcUSD zero protocol APY');
}

// 3. stcUSD inflated Aave collateral — replace with DeFiLlama
{
  const dlApy = 5.75;
  const index = mockIndex([['1:STCUSD', { apy: dlApy, score: 1005.75, project: 'cap' }]]);
  const leg = { symbol: 'stcUSD', apy: 12.5, isCollateral: true, value: 100000, address: '0x8888' };
  assert(shouldEnrichLegWithDefillama(4326, leg, index), 'stcUSD inflated must enrich');
  const pos = enrich(makePos({
    chainId: 4326,
    supplied: [leg],
    borrowed: [{ symbol: 'USDm', value: 50000, apy: 3 }],
    suppliedYieldUsd: 1_250_000,
    borrowedCostUsd: 1500,
  }), index);
  assert(Math.abs(leg.apy - dlApy) < 0.05, `stcUSD leg must be ${dlApy} not ${leg.apy}`);
  assert(pos.supplyApy < 8, `stcUSD supply must be <8% not ${pos.supplyApy}`);
  console.log('OK  stcUSD inflated Aave collateral');
}

// 4. USD3 Morpho collateral
{
  const dlApy = 6.36;
  const index = mockIndex([['1:USD3', { apy: dlApy, score: 1006.36, project: '3jane-lending' }]]);
  const leg = { symbol: 'USD3', apy: 0, isCollateral: true, value: 5000, address: '0x056B' };
  const pos = enrich(makePos({
    chainId: 1,
    supplied: [leg],
    borrowed: [{ symbol: 'USDC', value: 4000, apy: 8 }],
  }), index);
  assert(pos.defillamaBoost, 'USD3 must boost');
  assert(pos.supplyApy > 6, `USD3 supply ${pos.supplyApy}`);
  console.log('OK  USD3 Morpho collateral');
}

// 5. Active Aave USDC supply — keep protocol when reasonable
{
  const dlApy = 4.0;
  const protocolApy = 4.5;
  const index = mockIndex([['1:USDC', { apy: dlApy, score: 4, project: 'aave-v3' }]]);
  const leg = { symbol: 'USDC', apy: protocolApy, isCollateral: false, value: 10000 };
  assert(!shouldEnrichLegWithDefillama(1, leg, index), 'reasonable USDC supply must keep protocol APY');
  const pos = enrich(makePos({
    chainId: 1,
    supplied: [leg],
    borrowed: [{ symbol: 'WETH', value: 8000, apy: 2 }],
    suppliedYieldUsd: 450,
    borrowedCostUsd: 160,
  }), index);
  assert(!pos.defillamaBoost, 'USDC supply must not defillama-boost');
  assert(Math.abs(leg.apy - protocolApy) < 0.01, 'USDC must keep protocol APY');
  console.log('OK  active USDC supply (reasonable protocol APY)');
}

// 6. Near-zero supply without collateral flag — still enrich
{
  const dlApy = 5.5;
  const index = mockIndex([['1:REUSD', { apy: dlApy, score: 1005.5, project: 're' }]]);
  const leg = { symbol: 'reUSD', apy: 0, value: 20000, address: '0xre' };
  assert(shouldEnrichLegWithDefillama(1, leg, index), 'near-zero reUSD must enrich');
  const pos = enrich(makePos({
    chainId: 1,
    supplied: [leg],
    borrowed: [{ symbol: 'USDC', value: 15000, apy: 5 }],
  }), index);
  assert(pos.defillamaBoost, 'reUSD near-zero must boost');
  console.log('OK  near-zero yield token supply');
}

// 7. Merkl must not stack on DeFiLlama intrinsic yield legs
{
  const dlApy = 5.75;
  const index = mockIndex([['1:STCUSD', { apy: dlApy, score: 1005.75, project: 'cap' }]]);
  const leg = { symbol: 'stcUSD', apy: 15, isCollateral: true, value: 100000, address: '0xstc' };
  const pos = enrich(makePos({
    chainId: 4326,
    supplied: [leg],
    borrowed: [{ symbol: 'USDm', value: 50000, apy: 3 }],
  }), index);
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
  assert(Math.abs(leg.apy - dlApy) < 0.05, `Merkl must not inflate leg APY: ${leg.apy}`);
  assert(pos.supplyApy < 8, `Merkl must not inflate supply APY: ${pos.supplyApy}`);
  console.log('OK  Merkl skipped on DeFiLlama collateral');
}

// 8. Merkl still applies to non-defillama supply legs
{
  const leg = { symbol: 'USDC', apy: 3.5, value: 50000, address: '0xusdc' };
  const pos = makePos({
    chainId: 1,
    supplied: [leg],
    borrowed: [{ symbol: 'WETH', value: 40000, apy: 2 }],
    suppliedYieldUsd: 1750,
    borrowedCostUsd: 800,
  });
  const merklIndex = buildMerklAprIndex([{
    wallet: pos.wallet,
    items: [{
      opportunity: {
        status: 'LIVE',
        chainId: 1,
        action: 'LEND',
        explorerAddress: '0xusdc',
        apr: 2.0,
        name: 'usdc-campaign',
        tokens: [{ address: '0xusdc', symbol: 'USDC' }],
      },
    }],
  }]);
  enrichPositionWithMerkl(pos, merklIndex);
  assert(Number(leg.merklApy) > 0, 'Merkl must apply to normal supply leg');
  assert(leg.apy > 3.5, 'Merkl must increase normal supply leg APY');
  console.log('OK  Merkl still applies to normal supply');
}

// 9. defillamaPoolApy prefers apyBase
{
  assert(Math.abs(defillamaPoolApy({ apy: 12, apyBase: 5.5, apyReward: 6.5 }) - 5.5) < 0.01, 'apyBase preferred');
  assert(Math.abs(defillamaPoolApy({ apy: 8, apyBase: 0, apyReward: 3 }) - 5) < 0.01, 'total-reward fallback');
  console.log('OK  defillamaPoolApy uses apyBase');
}

// 10. Live DeFiLlama index — key assets
{
  const live = await fetchDefillamaYieldApyIndex();
  assert(!live.error, `live index fetch: ${live.error || 'ok'}`);
  const stc = live.bySymbolChain.get('1:STCUSD');
  const usd3 = live.bySymbolChain.get('1:USD3');
  assert(stc?.apy > 3 && stc?.apy < 12, `live stcUSD ${stc?.apy} out of range`);
  assert(stc?.project === 'cap', `live stcUSD project ${stc?.project}`);
  assert(usd3?.apy > 3 && usd3?.apy < 15, `live USD3 ${usd3?.apy}`);
  console.log(`OK  live index (stcUSD ${stc?.apy?.toFixed(2)}% cap, USD3 ${usd3?.apy?.toFixed(2)}%)`);
}

// 11. Live inflated stcUSD end-to-end
{
  const live = await fetchDefillamaYieldApyIndex();
  const dlApy = defillamaApyForLeg(4326, { symbol: 'stcUSD', address: '0x88887bE419578051FF9F4eb6C858A951921D8888' }, live);
  const leg = { symbol: 'stcUSD', apy: 14.2, isCollateral: true, value: 48000, address: '0x88887bE419578051FF9F4eb6C858A951921D8888' };
  const pos = enrich(makePos({
    chainId: 4326,
    supplied: [leg],
    borrowed: [{ symbol: 'USDm', value: 165000, apy: 3.2 }],
    suppliedYieldUsd: 681600,
    borrowedCostUsd: 5280,
  }), live);
  assert(pos.defillamaBoost, 'live stcUSD must boost');
  assert(Math.abs(leg.apy - dlApy) < 0.15, `live leg ${leg.apy} vs dl ${dlApy}`);
  assert(pos.supplyApy < dlApy + 1, `live supply ${pos.supplyApy} must track DeFiLlama ~${dlApy}`);
  assert(pos.supplyApy < 10, `live supply must not stay inflated at ${pos.supplyApy}`);
  console.log(`OK  live stcUSD inflated → ${pos.supplyApy.toFixed(2)}% (DL ${dlApy?.toFixed(2)}%)`);
}

console.log('\n=== Summary ===');
if (failures.length) {
  console.error(`FAIL: ${failures.length} scenario(s)`);
  failures.forEach((f, i) => console.error(`  ${i + 1}. ${f}`));
  process.exit(1);
}
console.log('PASS: all DeFiLlama supply APY scenarios');

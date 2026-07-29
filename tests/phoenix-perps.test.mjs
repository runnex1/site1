/**
 * Phoenix Eternal perps integration checks.
 * Run: node tests/phoenix-perps.test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  isSolanaAddress,
  phoenixHourlyRateFromPoint,
  phoenixQuoteLotsToUsd,
  phoenixPositionUnrealizedPnl,
} = require('../lib/phoenix-perps.js');
const {
  buildPairedAnalysis,
  buildRateSpreadRows,
  computeCombinedNetDeposits,
  fetchPhoenixState,
  fetchPhoenixRates,
  fetchPhoenixFunding,
  fetchPhoenixFills,
  fetchPhoenixCapitalFlows,
} = require('../lib/perps.js');

function pass(name) {
  console.log(`PASS: ${name}`);
}

{
  assert.equal(isSolanaAddress('3ctHNWw9NtU2Vwnx2fAhLpcgHHqjEV4nY9BQvxSrtuFr'), true);
  assert.equal(isSolanaAddress('0x1111111111111111111111111111111111111111'), false);
  assert.equal(isSolanaAddress(''), false);
  pass('isSolanaAddress');
}

{
  const fromAmt = phoenixHourlyRateFromPoint({
    fundingAmountPerUnit: '-0.0001',
    markPrice: '72.76',
  });
  assert.ok(Math.abs(fromAmt - (-0.0001 / 72.76)) < 1e-12);
  const fromPct = phoenixHourlyRateFromPoint({ fundingRatePercentage: '-0.000137' });
  assert.ok(Math.abs(fromPct - (-0.000137 / 100)) < 1e-15);
  assert.equal(phoenixQuoteLotsToUsd(25000000000), 25000);
  // virtualQuote + size*mark (not size*(mark-entry) which drifts with rounded entry)
  const upnl = phoenixPositionUnrealizedPnl({
    virtualQuoteLots: 52050407400,
    size: -714.24,
    markPx: 73.66,
    entryPx: 72.87,
  });
  assert.ok(Math.abs(upnl - (-560.511)) < 0.001);
  const naive = -714.24 * (73.66 - 72.87);
  assert.ok(Math.abs(naive - upnl) > 1, 'naive mark-entry must differ from Phoenix formula');
  pass('phoenix rate + quote lots + uPNL formula');
}

{
  const rows = buildRateSpreadRows(
    ['SOL'],
    {},
    {},
    {},
    {},
    {},
    { SOL: { fundingRateHourly: 0.000001, fundingRate8h: 0.000008, markPx: 100 } },
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].phoenix8h, 0.000008);
  assert.equal(rows[0].phoenixHourly, 0.000001);
  pass('buildRateSpreadRows phoenix 8h');
}

{
  const arb = buildPairedAnalysis({
    hlState: {
      positions: [{
        venue: 'hyperliquid', symbol: 'SOL', size: 10, side: 'long',
        entryPx: 70, markPx: 72, notional: 720, unrealizedPnl: 20,
        cumFundingSinceOpen: 1,
      }],
    },
    nadoState: { positions: [] },
    phoenixState: {
      positions: [{
        venue: 'phoenix', symbol: 'SOL', size: -10, side: 'short',
        entryPx: 71, markPx: 72, notional: 720, unrealizedPnl: -10,
        fundingSinceOpen: 2,
      }],
    },
    hlFunding: { payments: [], totalFunding: 0 },
    nadoFunding: { payments: [], totalFunding: 0 },
    phoenixFunding: {
      payments: [{ venue: 'phoenix', symbol: 'SOL', time: Date.now() - 1000, usdc: 2 }],
      totalFunding: 2,
    },
    hlFills: { fills: [], totalFees: 0, totalRealized: 0 },
    nadoMatches: { matches: [], totalFees: 0, totalRealized: 0 },
    phoenixFills: { fills: [], totalFees: 0, totalRealized: 0 },
    spreadRows: [{
      symbol: 'SOL',
      hyperliquid8h: 0.0001,
      phoenix8h: -0.00005,
      spreadHlPhoenix8h: 0.00015,
    }],
    days: 30,
  });
  assert.equal(arb.paired.length, 1);
  assert.equal(arb.paired[0].pairType, 'hl_phoenix');
  assert.equal(arb.paired[0].pairLabel, 'HL + Phoenix');
  assert.equal(arb.unhedged.length, 0);
  pass('buildPairedAnalysis HL + Phoenix');
}

{
  const out = computeCombinedNetDeposits(
    { payments: [{ time: 1, usdc: 100, kind: 'deposit' }] },
    { payments: [] },
    null,
    null,
    { payments: [{ time: 2, usdc: 50, type: 'deposit' }] },
  );
  assert.equal(out.rawCombinedNetDeposits, 150);
  assert.equal(out.phoenixNetDeposits, 50);
  pass('computeCombinedNetDeposits phoenix');
}

{
  // Empty / invalid wallet soft-empty
  const empty = await fetchPhoenixState('');
  assert.equal(empty.configured, false);
  assert.equal(empty.positions.length, 0);

  const missing = await fetchPhoenixState('11111111111111111111111111111111');
  assert.equal(missing.configured, true);
  assert.equal(missing.exists, false);

  // Live trader smoke (public API) — compare state mapping to TraderView in lockstep.
  const auth = '3ctHNWw9NtU2Vwnx2fAhLpcgHHqjEV4nY9BQvxSrtuFr';
  const traderKey = 'AgjgbWKZBFau9zEAS4udhMvgEjVBHjGMkZj3TFaKfESD';
  const [state, rates, funding, fills, capital, view] = await Promise.all([
    fetchPhoenixState(auth),
    fetchPhoenixRates(['SOL', 'BTC']),
    fetchPhoenixFunding(auth, 7),
    fetchPhoenixFills(auth, 7),
    fetchPhoenixCapitalFlows(auth),
    fetch(`https://perp-api.phoenix.trade/v1/view/trader/${traderKey}`).then((r) => r.json()),
  ]);
  assert.equal(state.configured, true);
  assert.ok(Number.isFinite(state.accountValue));
  assert.ok(state.positions.some((p) => p.symbol === 'SOL'));
  const sol = state.positions.find((p) => p.symbol === 'SOL');
  assert.ok(sol && Number.isFinite(sol.unrealizedPnl));
  const viewUpnl = Number(view.positions?.[0]?.unrealizedPnl?.ui);
  const viewPortfolio = Number(view.portfolioValue?.ui);
  assert.ok(Number.isFinite(viewUpnl));
  assert.ok(Math.abs(sol.unrealizedPnl - viewUpnl) < 1.5, `uPNL ${sol.unrealizedPnl} vs view ${viewUpnl}`);
  assert.ok(Math.abs(state.accountValue - viewPortfolio) < 2, `equity ${state.accountValue} vs view ${viewPortfolio}`);
  assert.ok(rates.some((r) => r.symbol === 'SOL' && Number.isFinite(r.fundingRate8h)));
  assert.ok(Array.isArray(funding.payments));
  assert.ok(Array.isArray(fills.fills));
  assert.ok(capital.payments.some((p) => p.type === 'deposit' && p.usdc > 0));
  pass('live Phoenix trader + rates smoke');
}

console.log('PASS: phoenix perps integration checks');

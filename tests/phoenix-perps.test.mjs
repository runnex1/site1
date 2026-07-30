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
  // Missing quote lots must fall back to mark−entry (not treat lots as 0 → ±notional).
  const fallback = phoenixPositionUnrealizedPnl({
    virtualQuoteLots: null,
    size: -714.24,
    markPx: 73.66,
    entryPx: 72.87,
  });
  assert.ok(Math.abs(fallback - naive) < 1e-9, 'missing quote lots uses mark-entry fallback');
  const zeroLotsTrap = phoenixQuoteLotsToUsd(null) + (-714.24) * 73.66;
  assert.ok(Math.abs(zeroLotsTrap) > 1000, 'sanity: treating missing lots as 0 would yield large bogus uPNL');
  assert.ok(Math.abs(fallback) < 1000, 'fallback must not look like ±notional');
  pass('phoenix rate + quote lots + uPNL formula');
}

{
  const {
    phoenixTicksToUsd,
    phoenixTpslFromPositionRow,
  } = require('../lib/phoenix-perps.js');
  assert.equal(phoenixTicksToUsd(7488, 100), 74.88);
  const tpsl = phoenixTpslFromPositionRow({
    entryPriceTicks: '7000',
    entryPriceUsd: '70',
    takeProfitTriggers: [{ status: 'active', trigger: { triggerPriceTicks: '8000' } }],
    stopLossTriggers: [{ status: 'active', trigger: { triggerPriceTicks: '6000' } }],
  }, 100);
  assert.equal(tpsl.tpPx, 80);
  assert.equal(tpsl.slPx, 60);
  // Fallback from entry ticks when market tickSize missing.
  const fallback = phoenixTpslFromPositionRow({
    entryPriceTicks: '7000',
    entryPriceUsd: '70',
    takeProfitTriggers: [{ status: 'active', trigger: { triggerPriceTicks: '7700' } }],
    stopLossTriggers: [],
  }, null);
  assert.equal(fallback.tpPx, 77);
  pass('phoenix TP/SL tick conversion');
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
  // Ext 30 long + Phoenix 45 short (~33% mismatch) must pair as partial hedge, not two unhedged rows.
  const arb = buildPairedAnalysis({
    hlState: { positions: [] },
    nadoState: { positions: [] },
    extendedState: {
      positions: [{
        venue: 'extended', symbol: 'BNB', size: 30, side: 'long',
        entryPx: 580, markPx: 592.67, notional: 17780.27, unrealizedPnl: 212.43,
      }],
    },
    phoenixState: {
      positions: [{
        venue: 'phoenix', symbol: 'BNB', size: -45, side: 'short',
        entryPx: 590, markPx: 595.81, notional: 26811.45, unrealizedPnl: -331.67,
        fundingSinceOpen: 1.7,
      }],
    },
    hlFunding: { payments: [], totalFunding: 0 },
    nadoFunding: { payments: [], totalFunding: 0 },
    extendedFunding: { payments: [], totalFunding: 0 },
    phoenixFunding: { payments: [], totalFunding: 1.7 },
    hlFills: { fills: [], totalFees: 0, totalRealized: 0 },
    nadoMatches: { matches: [], totalFees: 0, totalRealized: 0 },
    extendedFills: { fills: [], totalFees: 0, totalRealized: 0 },
    phoenixFills: { fills: [], totalFees: 0, totalRealized: 0 },
    spreadRows: [{
      symbol: 'BNB',
      extended8h: 0.0001,
      phoenix8h: -0.00005,
      spreadExtendedPhoenix8h: 0.00015,
    }],
    days: 30,
  });
  assert.equal(arb.paired.length, 1, 'partial Ext+Phoenix must pair');
  assert.equal(arb.paired[0].pairType, 'extended_phoenix');
  assert.ok(arb.paired[0].alerts.includes('size_mismatch'), 'partial hedge must warn size mismatch');
  assert.ok(arb.paired[0].sizeMismatchPct > 25 && arb.paired[0].sizeMismatchPct <= 50);
  assert.equal(arb.unhedged.length, 0);
  pass('buildPairedAnalysis Extended + Phoenix partial hedge');
}

{
  // Tiny opposite leg must stay unhedged (not steal a fake hedge).
  const arb = buildPairedAnalysis({
    hlState: {
      positions: [{
        venue: 'hyperliquid', symbol: 'ETH', size: 10, side: 'long',
        entryPx: 3000, markPx: 3010, notional: 30100, unrealizedPnl: 100,
      }],
    },
    nadoState: { positions: [] },
    extendedState: {
      positions: [{
        venue: 'extended', symbol: 'ETH', size: -0.2, side: 'short',
        entryPx: 3000, markPx: 3010, notional: 602, unrealizedPnl: -2,
      }],
    },
    hlFunding: { payments: [], totalFunding: 0 },
    nadoFunding: { payments: [], totalFunding: 0 },
    extendedFunding: { payments: [], totalFunding: 0 },
    hlFills: { fills: [], totalFees: 0, totalRealized: 0 },
    nadoMatches: { matches: [], totalFees: 0, totalRealized: 0 },
    extendedFills: { fills: [], totalFees: 0, totalRealized: 0 },
    spreadRows: [{ symbol: 'ETH', hl8h: 0.0001, extended8h: -0.00005, spreadHlExtended8h: 0.00015 }],
    days: 30,
  });
  assert.equal(arb.paired.length, 0, '98% mismatch must not pair');
  assert.equal(arb.unhedged.length, 2);
  pass('buildPairedAnalysis rejects tiny opposite leg');
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
  // New shape uses kind (matches HL/Nado/GRVT/Extended).
  const outKind = computeCombinedNetDeposits(
    { payments: [{ time: 1, usdc: 100, kind: 'deposit' }] },
    { payments: [] },
    null,
    null,
    { payments: [{ time: 2, usdc: 50, kind: 'deposit' }] },
  );
  assert.equal(outKind.phoenixNetDeposits, 50);
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
  assert.ok(Math.abs(sol.unrealizedPnl - viewUpnl) < 6, `uPNL ${sol.unrealizedPnl} vs view ${viewUpnl}`);
  assert.ok(Math.abs(state.accountValue - viewPortfolio) < 2, `equity ${state.accountValue} vs view ${viewPortfolio}`);
  assert.ok(rates.some((r) => r.symbol === 'SOL' && Number.isFinite(r.fundingRate8h)));
  assert.ok(Array.isArray(funding.payments));
  assert.ok(Array.isArray(fills.fills));
  assert.ok(capital.payments.some((p) => p.kind === 'deposit' && p.usdc > 0), 'Phoenix deposits must emit kind=deposit');
  assert.ok(capital.payments.every((p) => p.kind === 'deposit' || p.kind === 'withdraw'), 'Phoenix capital rows must use kind');
  pass('live Phoenix trader + rates smoke');
}

console.log('PASS: phoenix perps integration checks');

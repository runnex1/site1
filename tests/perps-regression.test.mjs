/**
 * Focused regression checks for perps accounting and dashboard wiring.
 * Run: node tests/perps-regression.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const { fetchLoopRates } = require('../lib/loop-rates.js');
const {
  appendEquitySnapshotStore,
  buildEquitySnapshotFromDashboard,
  buildClosedPairs,
  buildClosedLegsFromExchangeHistory,
  enrichClosedPairsSessionPnl,
  closedPairStableKey,
  filterFreshClosedPairs,
  buildDailyFundingSeries,
  computeCombinedNetDeposits,
  filterFullyClosedPairs,
  mergeNadoMatches,
  pairOpenedAtMs,
  computeNadoLiquidationPx,
  liquidationPriceFrom,
  normalizeGrvtPositionRow,
} = require('../lib/perps.js');
const aaveProxyHandler = require('../api/aave-proxy.js');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const indexHtml = readFileSync(join(ROOT, 'index.html'), 'utf8');
const perpsJs = readFileSync(join(ROOT, 'lib', 'perps.js'), 'utf8');
const aaveProxyJs = readFileSync(join(ROOT, 'api', 'aave-proxy.js'), 'utf8');
const syncJs = readFileSync(join(ROOT, 'api', 'sync.js'), 'utf8');
const now = Date.now();

function payment(usdc, time = now) {
  return { kind: usdc > 0 ? 'deposit' : 'withdraw', usdc, time };
}

function combined(hlPayments, nadoPayments, grvtPayments = null) {
  return computeCombinedNetDeposits(
    { payments: hlPayments },
    { payments: nadoPayments },
    grvtPayments ? { payments: grvtPayments } : null,
  );
}

{
  const result = combined([payment(-100)], [payment(100)]);
  assert.equal(result.rawCombinedNetDeposits, 0);
  assert.equal(result.combinedNetDeposits, 0, 'cross-venue withdrawal and deposit must remain net zero');
}

{
  const result = combined([payment(100)], [payment(100)]);
  assert.equal(result.rawCombinedNetDeposits, 200);
  assert.equal(result.combinedNetDeposits, 100, 'duplicate same-direction deposits must be counted once');
}

{
  const result = combined([payment(-100)], [payment(-100)]);
  assert.equal(result.rawCombinedNetDeposits, -200);
  assert.equal(result.combinedNetDeposits, -100, 'duplicate same-direction withdrawals must be counted once');
}

{
  const result = combined([payment(100)], [payment(100)], [payment(100)]);
  assert.equal(result.combinedNetDeposits, 100, 'a deposit duplicated across three venues must be counted once');
}

{
  const monthAgo = now - 35 * 86400000;
  const oneDayAgo = now - 86400000;
  const openMs = pairOpenedAtMs('ONDO', 'hyperliquid', 'nado', {
    hyperliquid: [{ symbol: 'ONDO', time: oneDayAgo, fee: 1 }],
    nado: [{ symbol: 'ONDO', time: monthAgo, fee: 1 }],
  }, {
    hyperliquid: [],
    nado: [{ symbol: 'ONDO', time: monthAgo, usdc: 0.5 }],
  });
  assert.equal(openMs, monthAgo, 'position performance must start when the first leg opened, not when the hedge completed');
}

{
  const recent = now - (23 * 60 * 60 * 1000);
  const old = now - (25 * 60 * 60 * 1000);
  const series = buildDailyFundingSeries({
    hlPayments: [{ symbol: 'BTC', time: recent, usdc: 2 }, { symbol: 'BTC', time: old, usdc: 3 }],
    hlFills: [{ symbol: 'BTC', time: recent, fee: 0.5 }, { symbol: 'BTC', time: old, fee: 1 }],
    days: 2,
  });
  const events = series.flatMap(row => row.fundingEvents);
  const fees = series.flatMap(row => row.feeEvents);
  assert.equal(events.length, 2, 'daily series must retain funding event timestamps');
  assert.equal(fees.length, 2, 'daily series must retain fee event timestamps');
}

{
  const open = now - 6 * 3600000;
  const close = now - 1 * 3600000;
  const closed = buildClosedPairs({
    hyperliquid: [
      { venue: 'hyperliquid', symbol: 'ENA', time: open, side: 'B', px: 0.1, sz: 50000, fee: 1, closedPnl: 0 },
      { venue: 'hyperliquid', symbol: 'ENA', time: close, side: 'A', px: 0.119, sz: 50000, fee: 1, closedPnl: 950 },
    ],
    extended: [
      { venue: 'extended', symbol: 'ENA', time: open + 1000, side: 'sell', px: 0.1, sz: 50000, fee: 1.5 },
      { venue: 'extended', symbol: 'ENA', time: close + 1000, side: 'buy', px: 0.1192, sz: 50000, fee: 1.5 },
    ],
  }, {
    hyperliquid: [{ venue: 'hyperliquid', symbol: 'ENA', time: open + 3600000, usdc: 12 }],
    extended: [{ venue: 'extended', symbol: 'ENA', time: open + 3600000, usdc: 8 }],
  });
  assert.equal(closed.length, 1, 'closed round-trip legs must be paired');
  assert.equal(Math.round(closed[0].closeSlippage), -10, 'closed slippage must be the net realized PnL of both legs');
  assert.equal(closed[0].funding, 20, 'closed PnL must include funding payments inside the round');
  assert.equal(closed[0].fees, 5, 'closed PnL must include trading fees from both legs');
  assert.equal(Math.round(closed[0].netPnl), 5, 'closed net PnL must equal slippage plus funding minus fees');
}

{
  const assets = ['ZK', 'POL', 'MON', 'VIRTUAL', 'IP', 'KAITO'];
  const grvtHistory = assets.map((symbol, idx) => {
    const closeTime = now - (idx + 2) * 86400000;
    const openTime = closeTime - (10 + idx) * 86400000;
    return {
      instrument: `${symbol}_USDT_Perp`,
      open_time: String(openTime * 1e6),
      close_time: String(closeTime * 1e6),
      is_long: true,
      status: 'CLOSED',
      closed_volume_base: String(1000 + idx * 100),
      realized_pnl: String(50 + idx),
      cumulative_fee: '2',
      cumulative_realized_funding_payment: String(90 + idx),
    };
  });
  const hlFills = assets.flatMap((symbol, idx) => {
    const closeTime = now - (idx + 2) * 86400000 + 10 * 60 * 1000;
    return [{
      venue: 'hyperliquid',
      symbol,
      time: closeTime,
      side: 'B',
      px: 1.1,
      sz: 1000 + idx * 100,
      fee: 1.5,
      closedPnl: -(48 + idx),
    }];
  });
  const closed = buildClosedPairs(
    { hyperliquid: hlFills, grvt: [] },
    { grvt: [], hyperliquid: [] },
    { grvt: grvtHistory, extended: [] },
  );
  assert.equal(closed.length, assets.length, 'GRVT position history must pair with HL closing fills for each asset');
  assert.deepEqual(closed.map(p => p.symbol).sort(), assets.sort());
}

{
  const closeTime = now - 3 * 86400000;
  const openTime = closeTime - 8 * 86400000;
  const closed = buildClosedPairs(
    {
      hyperliquid: [{
        venue: 'hyperliquid',
        symbol: 'ZK',
        time: closeTime + 10 * 60 * 1000,
        side: 'B',
        px: 0.12,
        sz: 1200,
        fee: 1.2,
        closedPnl: -42,
      }],
      grvt: [],
    },
    {},
    {
      grvt: [{
        i: 'ZK_USDT_Perp',
        ot: String(openTime * 1e6),
        ct: String(closeTime * 1e6),
        il: true,
        s: 1,
        cv: '1200',
        rp: '44',
        cf: '2',
        cr: '18',
      }],
      extended: [],
    },
  );
  assert.equal(closed.length, 1, 'lite GRVT position history rows must pair with HL closing fills');
  assert.equal(closed[0].pairLabel, 'grvt + hyperliquid');
}

{
  const close = now - 4 * 86400000;
  const open = close - 6 * 3600000;
  const closed = buildClosedPairs(
    {
      hyperliquid: [
        { venue: 'hyperliquid', symbol: 'POL', time: close, side: 'B', px: 1, sz: 500, fee: 1, closedPnl: -20 },
        { venue: 'hyperliquid', symbol: 'ZK', time: close + 5 * 60 * 1000, side: 'B', px: 1.1, sz: 800, fee: 1, closedPnl: 30 },
      ],
      grvt: [
        { venue: 'grvt', symbol: 'ZK', time: open, side: 'buy', px: 1, sz: 800, fee: 1, closedPnl: 0 },
        { venue: 'grvt', symbol: 'ZK', time: close + 10 * 60 * 1000, side: 'sell', px: 1.1, sz: 800, fee: 1, closedPnl: -28 },
      ],
    },
    {},
    {
      grvt: [{
        instrument: 'POL_USDT_Perp',
        open_time: String(open * 1e6),
        close_time: String(close * 1e6),
        is_long: true,
        status: 'CLOSED',
        closed_volume_base: '500',
        realized_pnl: '18',
        cumulative_fee: '1',
      }],
      extended: [],
    },
  );
  assert.equal(closed.length, 2, 'GRVT fill replay must add assets missing from sparse position history');
  assert.deepEqual(closed.map(p => p.symbol).sort(), ['POL', 'ZK']);
}

{
  const close = now - 4 * 86400000;
  const open = close - 6 * 3600000;
  const closed = buildClosedPairs(
    {
      hyperliquid: [
        { venue: 'hyperliquid', symbol: 'POL', time: close, side: 'B', px: 1, sz: 500, fee: 1, closedPnl: -20 },
        { venue: 'hyperliquid', symbol: 'ZK', time: close + 5 * 60 * 1000, side: 'B', px: 1.1, sz: 800, fee: 1, closedPnl: -78 },
      ],
      extended: [
        { venue: 'extended', symbol: 'ZK', time: open, side: 'buy', px: 1, sz: 800, fee: 1 },
        { venue: 'extended', symbol: 'ZK', time: close + 10 * 60 * 1000, side: 'sell', px: 1.1, sz: 800, fee: 1 },
      ],
    },
    {},
    {
      grvt: [],
      extended: [{
        market: 'POL-USD',
        side: 'LONG',
        createdTime: open,
        closedTime: close,
        maxPositionSize: '500',
        realisedPnl: '18',
      }],
    },
  );
  assert.equal(closed.length, 2, 'Extended fill replay must add assets missing from sparse position history');
  assert.deepEqual(closed.map(p => p.symbol).sort(), ['POL', 'ZK']);
}

{
  const close = now - 4 * 86400000;
  const open = close - 6 * 3600000;
  const closed = buildClosedPairs(
    {
      hyperliquid: [{
        venue: 'hyperliquid',
        symbol: 'SNX',
        time: close + 3 * 3600000,
        side: 'B',
        px: 1.1,
        sz: 58000,
        fee: 1,
        closedPnl: -8,
      }],
      extended: [],
    },
    {},
    {
      grvt: [],
      extended: [{
        market: 'SNX-USD',
        side: 'LONG',
        createdTime: Math.floor(open / 1000),
        closedTime: Math.floor(close / 1000),
        maxPositionSize: '58000',
        realisedPnl: '6',
      }],
    },
  );
  assert.equal(closed.length, 1, 'Extended second timestamps must still build closed legs');
  assert.equal(closed[0].symbol, 'SNX');
}

{
  const close = now - 3 * 86400000;
  const open = close - 6 * 3600000;
  const closed = buildClosedPairs(
    {
      hyperliquid: [{
        venue: 'hyperliquid',
        symbol: 'ZK',
        time: close + 5 * 60 * 1000,
        side: 'A',
        px: 1.1,
        sz: 1200,
        fee: 1,
        closedPnl: 42,
      }],
      grvt: [],
    },
    {},
    {
      grvt: [{
        instrument: 'ZK_USDT_Perp',
        open_time: String(open * 1e6),
        close_time: String(close * 1e6),
        is_long: 'false',
        status: 'CLOSED',
        closed_volume_base: '1200',
        realized_pnl: '-44',
        cumulative_fee: '2',
      }],
      extended: [],
    },
  );
  assert.equal(closed.length, 1, 'GRVT string false is_long must be parsed as a short closed leg');
  assert.equal(closed[0].shortLeg.venue, 'grvt');
}

{
  const close = now - 3 * 86400000;
  const open = close - 6 * 3600000;
  const closed = buildClosedPairs(
    {
      hyperliquid: [{
        venue: 'hyperliquid',
        symbol: 'LINEA',
        time: close + 4 * 3600000,
        side: 'B',
        px: 1.1,
        sz: 2500000,
        fee: 1,
        closedPnl: -12,
      }],
      grvt: [],
    },
    {},
    {
      grvt: [{
        instrument: 'LINEA_USDT_Perp',
        open_time: String(open),
        close_time: String(close),
        is_long: 'true',
        status: '1',
        closed_volume_base: '2500000',
        realized_pnl: '10',
        cumulative_fee: '2',
      }],
      extended: [],
    },
  );
  assert.equal(closed.length, 1, 'GRVT ms timestamps and numeric-string closed status must build closed legs');
  assert.equal(closed[0].symbol, 'LINEA');
}

{
  const specs = [
    ['hyperliquid', 'nado', 'CMBHLNADO'],
    ['hyperliquid', 'grvt', 'CMBHLGRVT'],
    ['hyperliquid', 'extended', 'CMBHLEXT'],
    ['nado', 'grvt', 'CMBNADOGRVT'],
    ['nado', 'extended', 'CMBNADOEXT'],
    ['grvt', 'extended', 'CMBGRVTEXT'],
  ];
  const sources = { hyperliquid: [], nado: [], grvt: [], extended: [] };
  const round = (venue, symbol, side, openTime, closeTime, pnl) => {
    const openSide = side === 'long' ? 'buy' : 'sell';
    const closeSide = side === 'long' ? 'sell' : 'buy';
    return [
      { venue, symbol, time: openTime, side: openSide, px: 1, sz: 1000, fee: 1, closedPnl: 0, realizedPnl: 0 },
      { venue, symbol, time: closeTime, side: closeSide, px: 1.1, sz: 1000, fee: 1, closedPnl: pnl, realizedPnl: pnl },
    ];
  };
  specs.forEach(([longVenue, shortVenue, symbol], idx) => {
    const openTime = now - (idx + 10) * 3600000;
    const closeTime = openTime + 2 * 3600000;
    sources[longVenue].push(...round(longVenue, symbol, 'long', openTime, closeTime, 100));
    sources[shortVenue].push(...round(shortVenue, symbol, 'short', openTime + 60 * 1000, closeTime + 60 * 1000, -98));
  });
  const closed = buildClosedPairs(sources, {});
  assert.equal(closed.length, specs.length, 'all non-Variational exchange combinations must be able to display closed positions');
  assert.deepEqual(closed.map(p => p.symbol).sort(), specs.map(s => s[2]).sort());
  for (const [longVenue, shortVenue, symbol] of specs) {
    const pair = closed.find(p => p.symbol === symbol);
    assert.equal(pair.longLeg.venue, longVenue, `${symbol} long venue must match`);
    assert.equal(pair.shortLeg.venue, shortVenue, `${symbol} short venue must match`);
  }
}

{
  const close = Date.UTC(2026, 2, 23, 8);
  const open = close - 2 * 86400000;
  const sameDay = buildClosedPairs({
    hyperliquid: [
      { venue: 'hyperliquid', symbol: 'RESOLV', time: open, side: 'B', px: 1, sz: 1000, fee: 1, closedPnl: 0 },
      { venue: 'hyperliquid', symbol: 'RESOLV', time: close + 2 * 3600000, side: 'A', px: 1.1, sz: 1000, fee: 1, closedPnl: 40 },
    ],
    grvt: [
      { venue: 'grvt', symbol: 'RESOLV', time: open + 10 * 60 * 1000, side: 'sell', px: 1, sz: 1000, fee: 1, closedPnl: 0 },
      { venue: 'grvt', symbol: 'RESOLV', time: close + 8 * 3600000, side: 'buy', px: 1.11, sz: 1000, fee: 1, closedPnl: -38 },
    ],
  }, {});
  assert.equal(sameDay.length, 1, 'closed legs on the same close day with overlapping open windows must pair even when hours apart');
}

{
  const t1 = now - 5 * 86400000;
  const t2 = now - 35 * 86400000;
  const t3 = now - 65 * 86400000;
  const mkRound = (symbol, open, close, hlPnl, grvtPnl, size) => ({
    hyperliquid: [
      { venue: 'hyperliquid', symbol, time: open, side: 'B', px: 1, sz: size, fee: 1, closedPnl: 0 },
      { venue: 'hyperliquid', symbol, time: close, side: 'A', px: 1.1, sz: size, fee: 1, closedPnl: hlPnl },
    ],
    grvt: [
      { venue: 'grvt', symbol, time: open + 10 * 60 * 1000, side: 'sell', px: 1, sz: size, fee: 1, closedPnl: 0 },
      { venue: 'grvt', symbol, time: close + 10 * 60 * 1000, side: 'buy', px: 1.11, sz: size, fee: 1, closedPnl: grvtPnl },
    ],
  });
  const sources = { hyperliquid: [], grvt: [] };
  for (const round of [
    mkRound('ZK', t3, t3 + 3600000, 50, -48, 1000),
    mkRound('POL', t2, t2 + 3600000, 30, -28, 500),
    mkRound('MEGA', t1, t1 + 3600000, 10, -9, 200),
  ]) {
    sources.hyperliquid.push(...round.hyperliquid);
    sources.grvt.push(...round.grvt);
  }
  const closed = buildClosedPairs(sources, {});
  assert.equal(closed.length, 3, 'each closed hedged round must appear as its own row');
  assert.deepEqual(closed.map(p => p.symbol).sort(), ['MEGA', 'POL', 'ZK']);
}

{
  const closeHl = now - 2 * 86400000;
  const closeGrvt = now - 86400000;
  const farApart = buildClosedPairs({
    hyperliquid: [
      { venue: 'hyperliquid', symbol: 'VIRTUAL', time: closeHl - 86400000, side: 'B', px: 1, sz: 1000, fee: 1, closedPnl: 0 },
      { venue: 'hyperliquid', symbol: 'VIRTUAL', time: closeHl, side: 'A', px: 1.1, sz: 1000, fee: 1, closedPnl: 40 },
    ],
    grvt: [
      { venue: 'grvt', symbol: 'VIRTUAL', time: closeGrvt - 86400000, side: 'sell', px: 1, sz: 1000, fee: 1, closedPnl: 0 },
      { venue: 'grvt', symbol: 'VIRTUAL', time: closeGrvt, side: 'buy', px: 1.11, sz: 1000, fee: 1, closedPnl: -38 },
    ],
  }, {});
  assert.equal(farApart.length, 0, 'legs closed more than 30 minutes apart must not pair');

  const close = now - 86400000;
  const withinWindow = buildClosedPairs({
    hyperliquid: [
      { venue: 'hyperliquid', symbol: 'VIRTUAL', time: close - 3600000, side: 'B', px: 1, sz: 1000, fee: 1, closedPnl: 0 },
      { venue: 'hyperliquid', symbol: 'VIRTUAL', time: close, side: 'A', px: 1.1, sz: 1000, fee: 1, closedPnl: 40 },
    ],
    grvt: [
      { venue: 'grvt', symbol: 'VIRTUAL', time: close - 3600000, side: 'sell', px: 1, sz: 1000, fee: 1, closedPnl: 0 },
      { venue: 'grvt', symbol: 'VIRTUAL', time: close + 10 * 60 * 1000, side: 'buy', px: 1.11, sz: 1000, fee: 1, closedPnl: -38 },
    ],
  }, {});
  assert.equal(withinWindow.length, 1, 'opposite legs closed within 30 minutes must pair');
}

{
  const close = now - 2 * 3600000;
  const closed = buildClosedPairs({
    hyperliquid: [
      { venue: 'hyperliquid', symbol: 'ONDO', time: close, side: 'A', px: 0.92, sz: 10000, fee: 1.2, closedPnl: 150 },
    ],
    nado: [
      { venue: 'nado', symbol: 'ONDO', time: close + 60000, size: 10000, px: 0.921, fee: 1.1, realizedPnl: -155 },
    ],
  }, { hyperliquid: [], nado: [] });
  assert.equal(closed.length, 1, 'closing fills with realized PnL must recover rounds opened before the fill window');
  assert.equal(Math.round(closed[0].closeSlippage), -5, 'recovered closing-fill rounds must keep realized close slippage');
  assert.equal(closed[0].longLeg.reconstructedFromClosingFills, true, 'recovered long leg must be marked as reconstructed');
}

{
  const close = now - 30 * 60 * 1000;
  const open = close - 4 * 3600000;
  const closed = buildClosedPairs({
    nado: [
      { venue: 'nado', symbol: 'UNI', time: close, side: 'sell', px: 9.5, size: 6800, fee: 5, realizedPnl: -7078 },
    ],
  }, {}, {
    extended: [{
      market: 'UNI-USD',
      side: 'SHORT',
      createdTime: open,
      closedTime: close + 30 * 1000,
      closedSize: '318.5',
      maxPositionSize: '11800',
      realisedPnl: '12257',
    }],
  });
  assert.equal(closed.length, 1, 'closed reconstruction should recover a history leg whose reported max size is too large');
  assert.equal(closed[0].size, 6800, 'closed pair should use the matched smaller close size');
  assert.equal(closed[0].shortLeg.size, 6800, 'oversized history leg should be scaled to the matched close size');
  assert.equal(closed[0].shortLeg.sizeAdjustedFrom, 11800, 'scaled history leg should preserve the original reported size');
  assert.ok(Math.abs(closed[0].closeSlippage) < 50, 'scaled history leg must not bring back the false huge close slippage');
}

{
  const close = now - 20 * 60 * 1000;
  const open = close - 4 * 3600000;
  const closed = buildClosedPairs({
    nado: [
      { venue: 'nado', symbol: 'UNI', time: open, side: 'buy', px: 9, size: 6800, fee: 1, realizedPnl: 0 },
      { venue: 'nado', symbol: 'UNI', time: close, side: 'sell', px: 9.5, size: 6800, fee: 5, realizedPnl: -200 },
    ],
    extended: [
      { venue: 'extended', symbol: 'UNI', time: open + 1000, side: 'sell', px: 9, sz: 6800, fee: 1, closedPnl: 0 },
      { venue: 'extended', symbol: 'UNI', time: close + 1000, side: 'buy', px: 8.95, sz: 6800, fee: 1, closedPnl: 0 },
    ],
  }, {}, {
    extended: [{
      market: 'UNI-USD',
      side: 'SHORT',
      createdTime: open,
      closedTime: close + 1000,
      maxPositionSize: '11800',
      realisedPnl: '12257',
    }],
  });
  assert.equal(closed.length, 1, 'Extended fill replay must survive when position history has the wrong max size');
  assert.equal(closed[0].shortLeg.size, 6800, 'closed pair must use the size-matched Extended fill leg');
  assert.ok(closed[0].sizeMismatchPct <= 5, 'closed pair must stay within the allowed size mismatch');
  assert.equal(closed[0].shortLeg.sizeAdjustedFrom, undefined, 'exact fill reconstruction should win over scaled history');
}

{
  const close = now - 10 * 60 * 1000;
  const closed = buildClosedPairs({
    hyperliquid: [
      { venue: 'hyperliquid', symbol: 'TEST', time: close, side: 'A', px: 1, sz: 1000, fee: 1, closedPnl: 100 },
    ],
    nado: [
      { venue: 'nado', symbol: 'TEST', time: close + 1000, side: 'buy', px: 1, size: 600, fee: 1, realizedPnl: -98 },
    ],
  }, {});
  assert.equal(closed.length, 0, 'large raw fill-vs-fill size mismatches must still be rejected');
}

{
  const close = now - 3600000;
  const sessionStart = close - 5 * 86400000;
  const sessionFunding = (symbol, perDay, days) => Array.from({ length: days }, (_, i) => ({
    symbol,
    time: sessionStart + i * 86400000 + 3600000,
    usdc: perDay,
  }));
  const hlPayments = sessionFunding('UNI', 6, 5);
  const grvtPayments = sessionFunding('UNI', -5, 5);
  const closed = buildClosedPairs({
    hyperliquid: [
      { venue: 'hyperliquid', symbol: 'UNI', time: close, side: 'A', px: 10, sz: 100, fee: 2, closedPnl: 50 },
    ],
    grvt: [
      { venue: 'grvt', symbol: 'UNI', time: close + 60000, side: 'buy', px: 10.1, sz: 100, fee: 1.5, closedPnl: -48 },
    ],
  }, { hyperliquid: hlPayments, grvt: grvtPayments });
  assert.equal(closed.length, 1, 'UNI closing-fill recovery must still pair opposite legs');
  assert.equal(closed[0].funding, 0, 'fill-window closed legs miss funding when open predates history');

  const enriched = enrichClosedPairsSessionPnl(closed, {
    hlPayments,
    grvtPayments,
    hlFills: [{ symbol: 'UNI', time: close, fee: 2 }],
    grvtFills: [{ symbol: 'UNI', time: close + 60000, fee: 1.5 }],
  }, 30);
  assert.equal(enriched[0].funding, 5, 'closed UNI must include full latest-session funding from both venues');
  assert.equal(enriched[0].fees, 3.5, 'closed UNI must include latest-session trading fees');
  assert.equal(enriched[0].netPnl, closed[0].closeSlippage + 5 - 3.5, 'closed net PnL must use session funding and fees');
}

{
  const pair = {
    symbol: 'UNI',
    closeTime: 1700000000000,
    longLeg: { venue: 'hyperliquid' },
    shortLeg: { venue: 'grvt' },
  };
  const key = closedPairStableKey(pair);
  const rows = [pair, { ...pair, closeTime: 1700001000000, shortLeg: { venue: 'nado' } }];
  const fresh = filterFreshClosedPairs(rows, [key]);
  assert.equal(fresh.length, 1, 'known closed keys must skip already-saved closed rounds');
  assert.equal(closedPairStableKey(fresh[0]), closedPairStableKey(rows[1]), 'only unseen closed rounds should remain for enrichment');
}

assert.match(indexHtml, /perpsTrimDailyRowToCutoff\(r, cutoff\)/, 'daily rows must be trimmed to the exact cutoff');
assert.match(indexHtml, /dayStart < cutoff\) return null;/, 'summary-only boundary rows must not count as full last-24h PnL');
assert.match(indexHtml, /return perpsRecomputeDailySeriesCumulative\(trimmed\);/, 'trimmed daily rows must rebuild cumulative totals from the selected window');
assert.match(indexHtml, /perpsTrimDailySeriesToLatestSession\(rows\)/, 'All-time daily funding chart must start after the last empty bucket');
assert.match(indexHtml, /while \(first > 0 && perpsDailyRowHasActivity\(list\[first - 1\]\)\) first--;/, 'daily funding latest session must stop at the previous empty bucket');
assert.match(indexHtml, /return t >= cutoff;/, 'equity points must use the exact rolling cutoff');
assert.match(indexHtml, /perpsRenderAlerts\(data\.paired \|\| \[\], data\.unhedged \|\| \[\], data\.summary \|\| \{\}\);/, 'alerts must refresh with the dashboard');
assert.doesNotMatch(perpsJs, /positions\.reduce\(\(s, p\) => s \+ \(p\.notional \|\| 0\), 0\)/, 'Extended notional must not be used as equity');
assert.match(perpsJs, /funding: extendedFundingWindow,/, 'Extended response must expose selected-window funding');
assert.match(perpsJs, /fundingSinceOpen: extendedFundingSinceOpen,/, 'Extended response must preserve since-open funding separately');
assert.match(perpsJs, /stats\.funding_rate/, 'Extended rates must tolerate snake_case funding-rate fields');
assert.match(perpsJs, /function enrichClosedPairsSessionPnl\(closedPairs, dailySeriesInputs/, 'closed positions must enrich funding and fees from the latest performance session');
assert.match(perpsJs, /enrichClosedPairsSessionPnl\(freshClosedPairs/, 'dashboard closed pairs must use session-aligned PnL');
assert.match(perpsJs, /function filterFreshClosedPairs\(pairs, knownClosedKeys\)/, 'known closed pairs must skip session enrichment on the server');
assert.match(aaveProxyJs, /knownClosedKeys\.length/, 'incremental closed-pair requests must bypass the shared dashboard cache');
assert.match(indexHtml, /const PERPS_CLOSED_PAIRS_KEY = 'vault-perps-closed-pairs'/, 'closed pairs must persist locally');
assert.match(indexHtml, /params\.set\('knownClosedKeys', knownClosedKeys\.join\(','\)\)/, 'perps refresh must tell the API which closed rounds are already cached');
assert.match(indexHtml, /data\.closedPairs = perpsCacheNewClosedPairs\(data\.closedPairs/, 'dashboard render must append only new closed pairs to the cache');
assert.match(indexHtml, /const TICKER_REFRESH_MS = 60 \* 1000/, 'market ticker must refresh every minute');
assert.match(indexHtml, /TICKER_SCROLL_DELAY_MS = 5000/, 'market ticker must start scrolling after a 5 second delay');
assert.match(indexHtml, /TICKER_HOVER_DWELL_MS = 2000/, 'market ticker must pause and reset after 2 seconds of hover');
assert.match(indexHtml, /function tickerHoldMarqueeAtStart\(track\)/, 'hover dwell must reset ticker marquee to the start position');
assert.match(indexHtml, /if \(_tickerMarqueeHeld\) \{\s*_tickerMarqueeHeld = false;\s*tickerRestartMarqueeAnimation\(track\)/, 'second hover dwell must resume ticker scrolling');
assert.match(indexHtml, /viewport\.addEventListener\('mouseleave', \(\) => \{\s*clearTimeout\(_tickerHoverDwellTimer\);\s*_tickerHoverDwellTimer = null;\s*\}\)/, 'ticker must stay paused on mouse leave until the next hover dwell');
assert.match(indexHtml, /function tickerSubmitAdd\(/, 'market ticker must let users add custom symbols manually');
assert.match(indexHtml, /list\.splice\(idx, 1\)/, 'clearing a custom ticker symbol on edit must remove it from the bar');
assert.match(indexHtml, /tickerAddSource/, 'market ticker add flow must let users choose CoinGecko, Jupiter, or TradFi');
assert.match(indexHtml, /function tkFetchCoingeckoLogo\(/, 'custom ticker logos must resolve from CoinGecko');
assert.match(indexHtml, /vault_ticker_custom_v2/, 'custom ticker metadata must persist symbol and price source');
assert.doesNotMatch(indexHtml, /ticker-source-badge/, 'custom ticker bar must not show price source labels like Auto');
assert.match(indexHtml, /pmMinNoOdds/, 'opportunity monitors must persist customizable PM min NO odds');
assert.match(indexHtml, /pmMinApy/, 'opportunity monitors must persist customizable PM min APY');
assert.match(indexHtml, /oppPmMinNoOdds/, 'configure modal must expose PM min NO odds');
assert.match(indexHtml, /oppPmMinApy/, 'configure modal must expose PM min APY');
assert.match(indexHtml, />Configure<\/button>/, 'opportunities panel must use Configure button label');
assert.match(indexHtml, /reappeared = !_lastOpportunityVisibleKeys\.has\(key\)/, 'new or reappearing opportunities must bubble to the top');
assert.match(indexHtml, /PERPS_DAILY_FUND_CACHE_KEY/, 'perps daily funding must cache for dashboard PnL tracker');
assert.match(indexHtml, /label:'Perpetual DEXs'/, 'PnL tracker must show Perpetual DEXs as a top-level row');
assert.doesNotMatch(indexHtml, /label:'Perps DEXs', pnl: perpsPnl, sub:true/, 'Perpetual DEXs must align with other PnL tracker rows');
assert.match(indexHtml, /dashboardPerpsPnlValue/, 'Perpetual DEXs PnL must come from daily funding chart totals');
assert.match(indexHtml, /EVENT_LOG_REFRESH_MS = 5 \* 60 \* 1000/, 'event log must refresh every 5 minutes on the dashboard');
assert.match(indexHtml, /forceCollect: true/, 'dashboard event log polls must force fresh Kobeissi checks');
assert.match(indexHtml, /eventLog=1&force=1/, 'dashboard must request forced event-log collection');
const eventLogJs = readFileSync(join(ROOT, 'lib', 'event-log.js'), 'utf8');
assert.match(eventLogJs, /fetchKobeissiPosts/, 'event log must scrape Kobeissi Letter Telegram headlines');
assert.match(eventLogJs, /if \(!\/\\bBREAKING\\b\/i\.test\(text\)\) continue;/, 'event log must include only breaking Kobeissi headlines');
assert.doesNotMatch(eventLogJs, /'Kobeissi Letter'/, 'event log must not add non-breaking Kobeissi headlines');
assert.match(indexHtml, /ticker-strip-viewport/, 'market ticker must use a scrolling viewport for overflow symbols');
assert.match(indexHtml, /function syncTabRefreshTimers\(tab\)/, 'tab switches must start and stop feature refresh timers');
const loopRatesJs = readFileSync(join(ROOT, 'lib', 'loop-rates.js'), 'utf8');
assert.match(loopRatesJs, /function morphoUsdFromRaw\(amountRaw, asset\)/, 'Morpho loops must derive USD from raw token amounts when Morpho omits USD fields');
assert.match(loopRatesJs, /borrowAssets borrowAssetsUsd/, 'Morpho loop query must request raw borrow asset amounts');
assert.match(loopRatesJs, /api\.fluid\.instadapp\.io/, 'Fluid loops must use the official Fluid API');
assert.match(loopRatesJs, /fluidPositionSource: 'fluid-official-api'/, 'Fluid position source must identify the official API');
assert.doesNotMatch(loopRatesJs, /DEFINITIV_API_KEY/, 'Fluid loops must not require a Definitiv API key');
assert.match(loopRatesJs, /api\.merkl\.xyz/, 'Loop APR must include Merkl reward campaigns');
assert.match(loopRatesJs, /rewards\/active-opportunities/, 'Merkl enrichment must use active opportunities for live reward APR');
assert.match(loopRatesJs, /fetchDefillamaYieldApyIndex/, 'yield-bearing collateral must use DeFiLlama APY when protocol supply APY is zero');
assert.match(loopRatesJs, /function canonicalNativeYieldApy\(/, 'native yield tokens like reUSD must use a shared DeFiLlama APY across protocols');
assert.match(loopRatesJs, /canonicalNativeYieldApy\(chainId, leg, index\)/, 'defillama leg lookup must prefer canonical native yield before address pools');
assert.match(indexHtml, /function loopsAppendSnapshotFromApiData\(/, 'live loop sync must append local 3h snapshots for history charts');
assert.match(loopRatesJs, /economicNetValue/, 'loop positions must include Merkl rewards in economic net value for snapshots');
assert.match(indexHtml, /LOOP_API_STATE_KEY/, 'loops tab must cache last live API state across page refreshes');
assert.match(indexHtml, /supplementalImported/, 'Loops must keep imported Fluid/Morpho positions when live API coverage is incomplete');
const loopSnapshotsJs = readFileSync(join(ROOT, 'lib', 'loop-snapshots.js'), 'utf8');
assert.match(loopSnapshotsJs, /economicNetValue/, 'loop snapshots must persist Merkl-inclusive economic net value');
assert.match(loopSnapshotsJs, /LOOP_SNAPSHOT_BUCKET_HOURS = 3/, 'loop snapshots must bucket history on 3h intervals');
assert.match(loopSnapshotsJs, /function appendLoopSnapshotStore\(store, data/, 'loop snapshots must append server-side history');
assert.match(loopSnapshotsJs, /function loopPositionHistoryKey\(/, 'loop snapshots must use stable history keys across Fluid NFT id changes');
assert.match(aaveProxyJs, /loopCronSnapshot/, 'loop cron snapshots must be exposed through aave-proxy');
assert.match(indexHtml, /function loopHistoryPositionMatch\(/, 'loop history must match snapshots by stable history key');
assert.match(indexHtml, /\/api\/loop-snapshots/, 'loops tab must hydrate snapshots from dedicated endpoint');
assert.match(indexHtml, /watcherWallets: watcherWallets/, 'loop sync must POST yield wallets so cron can snapshot server-side');
const loopsWorkflow = readFileSync(join(ROOT, '.github', 'workflows', 'loops-snapshot.yml'), 'utf8');
assert.match(loopsWorkflow, /aave-proxy\?loopCronSnapshot=1/, 'GitHub cron must hit loopCronSnapshot directly, not loop-rates rewrite');
assert.match(aaveProxyJs, /vault:loop_snapshots/, 'loop snapshots must persist in KV');
assert.match(syncJs, /loopSnapshots === '1'/, 'sync endpoint must hydrate loop snapshot history');
assert.match(indexHtml, /loops-cockpit[\s\S]{0,180}max-width:min\(1180px/, 'loops tab must use centered max-width like perps');
assert.match(indexHtml, /page-content:has\(#loopsTab\.active\)[\s\S]{0,80}padding:10px 2\.75rem/, 'loops tab must have horizontal page padding like perps');
assert.match(indexHtml, /loop-card-head/, 'loop cards must use stacked hero header row');
assert.match(indexHtml, /loop-card-main/, 'loop cards must use chart + legs side-by-side layout');
assert.match(indexHtml, /loop-leg-card/, 'loop cards must show supplied/borrowed leg cards');
assert.match(indexHtml, /loop-history-chart/, 'loop cards must render snapshot history chart');
assert.doesNotMatch(indexHtml, /loop-meter-wrap[\s\S]{0,1200}renderLoops/, 'loops render must not use LTV meter bar');
assert.match(indexHtml, /function loopHistoryChartHtml\(points\)/, 'loops tab must build per-position history charts from snapshots');
assert.match(indexHtml, /function loopHistoryChartSetMode\(/, 'loop history chart must toggle between net value and APY');
assert.match(indexHtml, /loop-history-mode-btn/, 'loop history chart must expose net value / APY toggle buttons');
assert.match(indexHtml, /height:148px/, 'loop history chart must be tall enough to read trends');
assert.match(indexHtml, /function loopSnapshotRealizedApy\(points, targetDays, endValue, endTs\)/, 'loops tab must compute realized APY from snapshots');
assert.match(indexHtml, /function loopSnapshotApyLegHtml\(/, 'loop cards must show 7d/30d realized APY in leg pane');
assert.match(indexHtml, /loop-realized-row/, 'loop cards must render realized APY mini metrics');

{
  const { loopSnapshotRealizedApy, MS_PER_DAY } = require('../lib/loop-snapshot-apy.js');
  const now = Date.UTC(2026, 5, 29, 12);
  const partial = loopSnapshotRealizedApy(
    [{ ts: now - 3 * MS_PER_DAY, netValue: 100000 }],
    7,
    103000,
    now,
  );
  assert.ok(partial?.partial, 'short position history must mark 7d APY as partial');
  assert.ok(Math.abs(partial.periodDays - 3) < 0.01, 'partial 7d APY must use full position period');
  assert.ok(Math.abs(partial.apy - 365) < 0.5, '3% gain over 3d must annualize to ~365% APY');

  const full = loopSnapshotRealizedApy(
    [
      { ts: now - 7 * MS_PER_DAY, netValue: 100000 },
      { ts: now - 3 * MS_PER_DAY, netValue: 104000 },
    ],
    7,
    107000,
    now,
  );
  assert.ok(full && !full.partial, '7d window with enough history must not be partial');
  assert.ok(Math.abs(full.apy - 365) < 0.5, '7% gain over 7d must annualize to ~365% APY');

  const partial30 = loopSnapshotRealizedApy(
    [{ ts: now - 10 * MS_PER_DAY, netValue: 50000 }],
    30,
    52000,
    now,
  );
  assert.ok(partial30?.partial, '10d history must mark 30d APY as partial');
  assert.ok(Math.abs(partial30.periodDays - 10) < 0.01, '30d APY must use full period when position is younger than 30d');
}

{
  const { appendLoopSnapshotStore, loopSnapshotBucketKey, loopPositionHistoryKey } = require('../lib/loop-snapshots.js');
  const ts = Date.UTC(2026, 5, 29, 13, 0);
  const data = {
    updatedAt: ts,
    wallets: ['0x07e6ae8F553DC77B8b372e4d20dAb797475E6119'],
    positions: [{ id: 'aave:1', protocol: 'Aave', marketName: 'USDe/USDm', wallet: '0xAbC', chainId: 1, totalBorrowed: 100, netValue: 10, totalSupplied: 110, netApy: 5 }],
  };
  const bucket = loopSnapshotBucketKey(ts);
  const store = appendLoopSnapshotStore({}, data);
  assert.equal(Object.keys(store).length, 1, 'first loop snapshot must be stored');
  assert.equal(store[bucket].positions[0].id, 'aave:1');
  assert.equal(store[bucket].positions[0].historyKey, loopPositionHistoryKey(data.positions[0]));
  const store2 = appendLoopSnapshotStore(store, data);
  assert.equal(Object.keys(store2).length, 1, 'same 3h bucket must not duplicate loop snapshots');
}

{
  const { collectLoopLogoTargets, tokenLogoKey, protocolLogoKey } = require('../lib/logo-resolver.js');
  const targets = collectLoopLogoTargets([
    {
      protocol: 'Aave',
      supplied: [{ symbol: 'USDe' }],
      borrowed: [{ symbol: 'USDm' }],
    },
  ]);
  const keys = new Set(targets.map(t => t.key));
  assert.ok(keys.has(protocolLogoKey('Aave')), 'loop logo resolver must include Aave protocol logos');
  assert.ok(keys.has(protocolLogoKey('Morpho')), 'loop logo resolver must always include Morpho protocol logos');
  assert.ok(keys.has(tokenLogoKey('USDE')), 'loop logo resolver must include supplied token logos');
  assert.ok(keys.has(tokenLogoKey('USDM')), 'loop logo resolver must include borrowed token logos');
}

assert.match(aaveProxyJs, /ensureLoopLogoCache/, 'loop rates cron must persist embedded logos server-side');
assert.match(syncJs, /logoCache === '1'/, 'sync endpoint must expose server logo cache for loops hydration');
assert.match(indexHtml, /function makeLoopLogo\(symbol, isProtocol/, 'loops tab must render logos from server cache only');
assert.match(indexHtml, /logoCache=1/, 'loops tab must hydrate server logo cache');

{
  const dashboard = (fetchedAt, total, overrides = {}) => ({
    fetchedAt,
    equityNow: { hl: total - 100, nado: 100, grvt: 0, extended: 0 },
    summary: {
      hlAccountValue: total - 100,
      nadoAccountValue: 100,
      grvtConfigured: false,
      extendedConfigured: false,
      combinedNetDeposits: 0,
      adjustedEquity: total,
      equitySnapshotEligible: true,
      ...overrides,
    },
  });
  const first = appendEquitySnapshotStore({}, dashboard(Date.UTC(2026, 5, 2, 8, 5), 1000));
  const second = appendEquitySnapshotStore(first, dashboard(Date.UTC(2026, 5, 2, 11, 55), 1200));
  assert.equal(Object.keys(second).length, 1, 'same 4h bucket must contain only one snapshot');
  assert.equal(second['2026-06-02T08'].totalEquity, 1000, 'minute refreshes must not rewrite a 4h snapshot');

  const incomplete = appendEquitySnapshotStore(second, dashboard(Date.UTC(2026, 5, 2, 12, 5), 200, {
    equitySnapshotEligible: false,
    equitySnapshotIssue: 'GRVT equity unavailable',
  }));
  assert.equal(Object.keys(incomplete).length, 1, 'incomplete venue reads must not create equity snapshots');

  const sampled = buildEquitySnapshotFromDashboard(dashboard(Date.UTC(2026, 5, 2, 12, 5), 1200, {
    equityCollectionSpanMs: 42,
    equityFetchedAts: { hyperliquid: 1, nado: 43 },
    equitySampleMode: 'concurrent_balance_only',
  }));
  assert.equal(sampled.record.equityCollectionSpanMs, 42, 'snapshot must preserve measured venue collection span');
  assert.equal(sampled.record.equitySampleMode, 'concurrent_balance_only', 'snapshot must identify balance-only sampling');
}

assert.match(indexHtml, /if \(store\[bucket\]\) return false;/, 'browser snapshots must be append-only within each 4h bucket');
assert.match(indexHtml, /if \(!perpsIsEquitySnapshotEligible\(data\)\) return false;/, 'browser snapshots must reject incomplete reads');
assert.match(aaveProxyJs, /portfolio\?\.perpsArb/, 'cron snapshots must recover wallet config from the saved portfolio');
assert.match(aaveProxyJs, /kvSet\('vault:perps_config'/, 'cron snapshots must persist recovered wallet config');
assert.match(aaveProxyJs, /fetchPerpsEquitySnapshot\(\{/, 'cron snapshots must use the lightweight concurrent balance sampler');
assert.doesNotMatch(aaveProxyJs.slice(aaveProxyJs.indexOf('async function handlePerpsCronSnapshot'), aaveProxyJs.indexOf('async function handlePerps(req')), /fetchPerpsDashboard\(\{/, 'cron snapshots must not run the heavy dashboard pipeline');
assert.match(perpsJs, /equitySampleMode: 'concurrent_balance_only'/, 'balance-only snapshots must identify their sampling mode');
assert.match(perpsJs, /await Promise\.all\(\[\s*fetchHyperliquidEquity/, 'venue equity endpoints must be sampled concurrently');
assert.match(syncJs, /const savedConfig = parseJson\(await kvGet\('vault:perps_config'\), \{\}\);/, 'fast config endpoint must use the initialized parser');
assert.doesNotMatch(syncJs, /const perpsConfig = parse\(await kvGet\('vault:perps_config'\), \{\}\);/, 'fast config endpoint must not call a parser before initialization');
assert.match(syncJs, /req\.query\?\.perpsSnapshots === '1'/, 'sync endpoint must expose lightweight Perps snapshot hydration');
assert.match(indexHtml, /await perpsHydrateSnapshotsFromCloud\(\);/, 'Perps refresh must hydrate cron snapshots before rendering the chart');
assert.match(indexHtml, /const merged = \{ \.\.\.local, \.\.\.\(serverSnaps \|\| \{\}\) \};/, 'scheduled server snapshots must replace same-bucket browser snapshots');
assert.match(indexHtml, /<g id="perpsEquityPoints"><\/g>/, 'equity chart must render visible sampled-point markers');
assert.match(indexHtml, /latest \$\{perpsFmtUsd\(chart\.plot\.at\(-1\)\?\.val\)\}/, 'equity chart badge must expose the latest plotted snapshot amount');
assert.match(indexHtml, /perpsPairDisplayLegEntries\(p\)/, 'position cards must order exchange labels with the long leg first');
assert.match(indexHtml, /perpsVenueWithSideHtml\(entry\.venue, entry\.leg\.size\)/, 'exchange labels must show long/short badges in position cards');
assert.match(indexHtml, /perpsSetPositionsTab\('closed'/, 'Positions panel must expose a Closed tab');
assert.match(indexHtml, /function perpsRenderClosedPositions\(closedPairs\)/, 'Closed tab must render fully closed position rounds');
assert.match(indexHtml, /p\.closeSlippage/, 'Closed tab must show closing slippage separately');
assert.match(perpsJs, /closedPairs: arb\.closedPairs/, 'Perps dashboard response must include closed pairs');
assert.match(perpsJs, /const CLOSED_PAIR_MATCH_WINDOW_MS = 30 \* 60 \* 1000;/, 'opposite hedge legs must close within 30 minutes');
assert.match(perpsJs, /function mergeVenueClosedLegs\(historyLegs, fillLegs\)/, 'GRVT fill replay must supplement sparse position history');
assert.match(perpsJs, /function collectPerpsHistorySymbols\(/, 'NADO history must include symbols from funding payments');
assert.match(perpsJs, /product_ids: \[productId\]/, 'NADO matches must paginate per product so closed symbols are not dropped');
assert.match(perpsJs, /fetchGrvtPositionHistory/, 'closed positions must load GRVT native position history');
assert.match(perpsJs, /function msToGrvtNs\(ms\)/, 'GRVT timestamps must use BigInt nanosecond conversion');
assert.match(perpsJs, /grvtFillsCount/, 'perps summary must expose GRVT fill counts for production debugging');
assert.match(perpsJs, /grvtPositionHistoryCount/, 'perps summary must expose GRVT position-history counts for production debugging');
assert.match(perpsJs, /fetchExtendedPositionHistory/, 'closed positions must load Extended native position history');
assert.match(perpsJs, /buildClosedLegsFromExchangeHistory/, 'closed positions must map exchange-native closed rounds');
assert.match(perpsJs, /const PERPS_MAX_FILL_HISTORY_DAYS = 365;/, 'Closed tab must fetch a long enough fill history to show older closed rounds');
assert.match(perpsJs, /reconstructedFromClosingFills: true/, 'Closed tab must recover rounds whose opening fill is outside the fetched history');
assert.match(perpsJs, /function parseGrvtIsBuyer\(value\)/, 'GRVT fill side parsing must normalize string booleans');
assert.match(perpsJs, /side: parseGrvtIsBuyer\(row\.is_buyer \?\? row\.ib\) \? 'buy' : 'sell'/, 'GRVT fills must not treat string "false" as a buy');
assert.match(indexHtml, /const PERPS_MAX_FILL_HISTORY_DAYS = 365;/, 'browser must request a 365d perps history window');
assert.match(indexHtml, /return PERPS_MAX_FILL_HISTORY_DAYS;/, 'perps API days must use the max history constant');
assert.match(aaveProxyJs, /Math\.min\(365, Math\.max\(1, parseInt\(req\.query\.days/, 'Perps API route must not clamp dashboard history to 90d');
assert.match(indexHtml, /perpsPositionFundingRecent/, 'position performance modal must include recent funding payments');
assert.match(indexHtml, /function perpsRecentFundingGroups\(p\)/, 'recent funding payments must support hourly net grouping');
assert.match(indexHtml, /function perpsRecentFundingHourBucket\(ts\)/, 'recent funding must bucket payments by single hour');
assert.match(indexHtml, /type: 'hour'/, 'recent funding cards must represent one hour each');
assert.doesNotMatch(indexHtml, /net-window/, 'recent funding must not roll up multiple hours');
assert.doesNotMatch(indexHtml, /type: 'venue'/, 'recent funding must not use separate slow-venue aggregate cards');
assert.match(indexHtml, /touch-action:pan-x/, 'recent funding strip must allow horizontal touch scrolling');
assert.match(perpsJs, /pair\.recentFundingEvents = fundingEventsForPair\(base, venueA, venueB, paymentSources, sinceMs\);/, 'position modal must receive raw per-pair funding events for slow venues like NADO');
assert.match(indexHtml, /p\.recentFundingEvents/, 'position modal must prefer raw per-pair funding events over daily chart rows');
assert.match(indexHtml, /perps-pos-funding-strip/, 'recent funding payments must render as a horizontal card strip');
assert.match(perpsJs, /const d = row\.delta \|\| row;/, 'Hyperliquid funding parser must support top-level funding rows as well as delta rows');
assert.match(perpsJs, /d\.usdc \?\? row\.usdc/, 'Hyperliquid funding parser must keep the signed USDC payment from the response');
assert.match(perpsJs, /negative = paid, positive = received/, 'Hyperliquid funding payments must document signed delta semantics');
assert.match(indexHtml, /Perps DEXs/, 'sidebar and search must use the Perps DEXs label');
assert.doesNotMatch(indexHtml, /Perps Arb/, 'old Perps Arb label must not remain in the UI');
assert.match(indexHtml, /function perpsFilterPairDailySeriesForPosition\(series, p\)/, 'position performance must use a dedicated position series filter');
assert.match(indexHtml, /function perpsTrimPairDailySeriesToLatestSession\(rows\)/, 'position performance must keep only the latest open session');
assert.match(indexHtml, /perpsTrimPairDailySeriesToLatestSession\(series\)/, 'position performance must drop closed gaps before charting');
assert.match(indexHtml, /let _perpsPositionChartShowFees = false;/, 'position performance must default to funding-only without trading fees');
assert.match(indexHtml, /if \(!opts\.preserveFeeMode\) _perpsPositionChartShowFees = false;/, 'opening a position chart must reset to funding-only mode');
assert.match(indexHtml, /perpsRenderPositionPerformanceChart\(canvas, series, _perpsPositionChartShowFees\)/, 'position performance chart must use the fee toggle state');
assert.match(indexHtml, /showFees \? \(r\.dailyNet \|\| 0\) : \(r\.dailyFunding \|\| 0\)/, 'position performance bars must exclude fees unless toggled on');
assert.match(indexHtml, /perpsTogglePositionChartFees/, 'position performance must expose a trading-fee toggle');
assert.match(perpsJs, /Math\.min\(\.\.\.candidates\)/, 'position open time must use earliest fill or funding on either leg');
assert.match(perpsJs, /const perfDays = Math\.min\(PERPS_MAX_FILL_HISTORY_DAYS, Math\.max\(fillHistoryDays, openDays\)\)/, 'per-pair performance series must span from pair open through fill history');
assert.match(perpsJs, /days: perfDays,\s*\n\s*pairedBases: \[p\.symbol\]/, 'per-pair performance series must use computed performance window');
assert.ok(indexHtml.includes('function perpsSyncTotalPnlForRange(data, range)'), 'Total PnL must follow the selected stat time window');
assert.ok(indexHtml.includes('perpsSyncTotalPnlForRange(data, _perpsStatRange)'), 'stats bar must sync Total PnL from the active stat range');
assert.doesNotMatch(indexHtml, /perpsSyncTotalPnlRolling24h/, 'Total PnL must not stay fixed to rolling 24h');
assert.match(indexHtml, /perpsSumDailyFundingSeries\(rows, true\)/, 'Net APR must use the same active-session rows as position performance');
assert.match(indexHtml, /function perpsFilterPairLatestSessionForRange\(series, range\)/, 'Position Net APR must filter to the latest session before applying the selected range');
assert.match(indexHtml, /const rows = perpsFilterPairLatestSessionForRange\(rawRows, range\);/, 'Position Net APR must not include older sessions in all-time APR');
assert.match(indexHtml, /function perpsPairAprDaysForRows\(p, range, rows\)/, 'Position Net APR must not annualize rolling 24h rows as two calendar days');
assert.match(indexHtml, /const days = perpsPairAprDaysForRows\(p, range, rows\);/, 'Position Net APR must use fixed stat-window days when a fixed range is selected');
assert.match(indexHtml, /const PERPS_REFRESH_RETRIES = 1;/, 'Perps dashboard load must retry transient API failures once');
assert.match(indexHtml, /function perpsDashboardLoadWarnings\(payload\)/, 'Perps dashboard must inspect partial NADO failures before rendering');
assert.match(indexHtml, /perpsFetchDashboardPayload\(params, silent\)/, 'Perps refresh must use the retrying dashboard fetch helper');
assert.match(indexHtml, /summary\?\.nadoError/, 'Perps alert bar must surface persistent NADO API failures');
assert.match(perpsJs, /rows\.error = errorMessage\(e\);/, 'NADO rate failures must be reported instead of silently returning empty rates');
assert.match(perpsJs, /nadoError: combineErrors\(nadoState, nadoFundingForAnalysis, nadoMatchesForAnalysis, nadoCapitalFlows, \{ error: nadoRates\.error \}\)/, 'Dashboard summary must include NADO rates/funding failures');
assert.match(indexHtml, /perpsSideBadgeHtml\(legs\.a\.size\)/, 'paired table legs must include long/short badges');
assert.match(indexHtml, /perpsVenueWithSideHtml\(u\.venue, u\.size\)/, 'unhedged exchange rows must include long/short badges');
assert.match(indexHtml, /<div>Liq Price<\/div>/, 'open positions must show a liquidation-price-only column');
assert.match(indexHtml, /function perpsPositionLiqStackHtml\(p, displayLegs\)/, 'open positions must render only liquidation prices in the Liq Price column');
assert.match(indexHtml, /function perpsPositionMidPx\(p, displayLegs\)/, 'open positions must calculate a mid price from both exchange marks');
assert.ok(indexHtml.includes('<span class="perps-pos-live-px">${perpsFmtPx(midPx)}</span>'), 'open positions must show live price next to OPEN without a mid pill');
assert.doesNotMatch(indexHtml, /perps-pos-mid-pill/, 'open positions must not wrap live price in a mid pill');
assert.doesNotMatch(indexHtml, /<div>Price \/ Liq<\/div>/, 'old Price / Liq header must be removed');
assert.doesNotMatch(indexHtml, /perps-pos-price-label">Px/, 'Liq Price column must not show current price labels');
assert.match(indexHtml, /function perpsLiquidationRiskStyle\(currentPx, liquidationPx\)/, 'liquidation prices must be colored by distance to current price');
assert.match(indexHtml, /distancePct <= 20 \? 1/, 'liquidation color must reach max red at 20 percent from liquidation');
assert.match(indexHtml, /hyperliquidMarkPx/, 'Hyperliquid current price must fall back to rate-spread mark price');
assert.match(perpsJs, /function liquidationPriceFrom\(obj, pxFn = v => firstNumber\(v\)\)/, 'position mapping must use a tolerant liquidation price extractor');
assert.match(perpsJs, /estimatedLiquidationPrice/, 'liquidation price extraction must check common estimated liquidation aliases');
assert.match(perpsJs, /obj\?\.balance\?\.\[key\]/, 'liquidation price extraction must check nested balance fields');
assert.match(perpsJs, /function nadoLiquidationPriceFrom\(balanceRow, ctx = null\)/, 'NADO liquidation price extraction must handle x18, direct fields, and official formula');
assert.doesNotMatch(perpsJs, /proportionalHealth/, 'NADO must not invent liquidation prices from notional-weighted health');
assert.doesNotMatch(perpsJs, /function estimateHyperliquidLiquidationPx\(/, 'Hyperliquid must not estimate liquidation when API returns null');
assert.doesNotMatch(perpsJs, /function estimateGrvtLiquidationPx\(/, 'GRVT must not estimate liquidation when API omits est_liquidation_price');
assert.match(perpsJs, /liquidationPx: liquidationPriceFrom\(pos\)/, 'Hyperliquid position mapping must use API liquidation price only');
assert.match(perpsJs, /liquidationPx: nadoLiquidationPriceFrom\(b, \{/, 'NADO position mapping must compute liquidation from maintenance health');
assert.match(perpsJs, /function computeNadoLiquidationPx\(/, 'NADO liquidation must be computable from oracle and maintenance health');
assert.match(perpsJs, /function normalizeGrvtPositionRow\(/, 'GRVT position mapping must normalize lite API aliases');
assert.match(perpsJs, /liquidationPx: liquidationPriceFrom\(p, grvtPx\)/, 'GRVT position mapping must use API est_liquidation_price only');
assert.match(perpsJs, /grvtTradesPost\('positions'/, 'GRVT state must fetch the dedicated positions endpoint for liquidation prices');
assert.match(perpsJs, /hyperliquidMarkPx: hl\?\.markPx \?\? null/, 'rate spread rows must expose Hyperliquid mark price for position rows');
assert.match(indexHtml, /perpsRateSpreadRow\(p\.symbol\)/, 'Current APR must fall back to the latest rate-spread row');
assert.match(indexHtml, /rateA \?\? p\.fundingRate8hA/, 'live APR polling must preserve previous leg rates when a response is partial');
assert.match(indexHtml, /if \(native\.rateDecimal == null\)/, 'Current APR tooltip must fall back to pair-level leg rates');
assert.match(indexHtml, /if \(data\.rateSpread\) perpsApplyLiveRates\(data\.rateSpread, data\.fetchedAt\)/, 'Current APR tooltip must retain the exact live-rate update time');
assert.match(indexHtml, /const PERPS_SCHEDULED_REFRESH_MINUTES = \[10, 50, 55\]/, 'Perps dashboard must refresh on a fixed hourly schedule');
assert.match(indexHtml, /function perpsManualRefresh\(/, 'Positions panel must expose a manual refresh control');
assert.match(indexHtml, /id="perpsManualRefreshBtn"/, 'Positions panel must render the manual refresh button');
assert.match(indexHtml, /function perpsShouldRenderEquityChart\(snapshotAdded, cloudSnapshotsAdded\)/, 'equity chart must refresh only when a new 4h snapshot point is added');
assert.doesNotMatch(indexHtml, /PERPS_AUTO_REFRESH_MS/, 'Perps dashboard must not poll on a short interval');
assert.doesNotMatch(indexHtml, /function perpsRefreshLiveApr\(/, 'Perps dashboard must not run a separate live APR poll');
assert.match(perpsJs, /function grvtFundingSinceOpen\(pos\) \{[\s\S]*?return raw;/, 'GRVT cumulative funding must keep the same account-credit sign as funding history');

assert.match(indexHtml, /PM_WALLETS_BACKUP_KEY/, 'Polymarket managed wallets must have a local backup store');
assert.match(indexHtml, /parsed\.polymarketWallets = mergeWalletAddresses\(data\.polymarketWallets, parsed\.polymarketWallets\);/, 'Cloud hydration must merge Polymarket wallets instead of replacing local wallets');
assert.match(indexHtml, /async function addNewWallet\(\)/, 'Manage Wallets add action must be async so persistence can finish before sync');
assert.match(indexHtml, /await saveData\(\);\s*\n\s*renderWalletList\(\);/, 'Manage Wallets must wait for save before refreshing the wallet list and syncing positions');
assert.match(indexHtml, /function syncPolymarketWalletState\(/, 'Polymarket wallets must have a canonical local merge/persist helper');
assert.match(indexHtml, /fetchServerPolymarketPositions\(wallets\)/, 'Polymarket position sync must prefer the server endpoint over fragile browser proxy fetches');
assert.match(syncJs, /req\.query\?\.polymarketPositions === '1'/, 'sync endpoint must expose Polymarket positions for wallet-based sync');
assert.match(syncJs, /function enrichPolymarketPositions\(positions\)/, 'server-side Polymarket sync must enrich position metadata for logos and links');
assert.match(syncJs, /marketIcon: pmFirstString\(pos\?\.marketIcon/, 'server-side Polymarket sync must preserve or enrich market icons');
assert.match(indexHtml, /onerror="this\.replaceWith\(document\.createTextNode/, 'Prediction market logos must fall back to readable initials when image loading fails');
assert.doesNotMatch(indexHtml, /ondblclick="deletePredictionMarketGroup/, 'Prediction market rows must not delete positions on double click');
assert.doesNotMatch(indexHtml, /ondblclick="deleteItem\('opinionMarkets'/, 'Opinion rows in Prediction Markets must not delete positions on double click');
assert.match(indexHtml, /data-market-url="\$\{dashEsc\(marketUrl\)\}"/, 'Prediction market rows must expose a market URL for click-through');
assert.match(indexHtml, /https:\/\/app\.opinion\.trade\/market\/\$\{pos\.marketId \|\| pos\.market_id\}/, 'Opinion positions must keep a market URL for click-through');
{
  const renderDashboard = indexHtml.slice(indexHtml.indexOf('function perpsRenderDashboard(data, opts = {})'), indexHtml.indexOf('function perpsFormatConnectedStatus'));
  assert.ok(renderDashboard.indexOf('perpsSaveSnapshot(data);') < renderDashboard.indexOf('data._equitySeries = perpsBuildEquitySeries(data);'), 'dashboard must save the current 4h snapshot before building the plotted series');
}

{
  let statusCode = null;
  let responseBody = null;
  const res = {
    setHeader() {},
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      responseBody = body;
      return body;
    },
  };
  await aaveProxyHandler({ method: 'GET', headers: {}, query: { cronSnapshot: '1' } }, res);
  assert.equal(statusCode, 401, 'cron snapshot GET must reach the protected Perps handler without a wallet query');
  assert.equal(responseBody?.error, 'Unauthorized');
}

{
  let statusCode = null;
  let responseBody = null;
  const res = {
    setHeader() {},
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      responseBody = body;
      return body;
    },
  };
  await aaveProxyHandler({ method: 'GET', headers: {}, query: { loopCronSnapshot: '1' } }, res);
  assert.equal(statusCode, 401, 'loop cron snapshot must require SYNC_SECRET');
  assert.equal(responseBody?.error, 'Unauthorized');
}

{
  const close = now - 2 * 86400000;
  const open = close - 5 * 86400000;
  const closed = buildClosedPairs({
    hyperliquid: [
      { venue: 'hyperliquid', symbol: 'ONDO', time: open, side: 'A', px: 1, sz: 16000, fee: 1, closedPnl: 0 },
      { venue: 'hyperliquid', symbol: 'ONDO', time: close, side: 'B', px: 1.1, sz: 16000, fee: 1, closedPnl: 100 },
    ],
    nado: [
      { venue: 'nado', symbol: 'ONDO', time: open + 1000, side: 'buy', px: 1, size: 16000, fee: 1, realizedPnl: 0 },
      { venue: 'nado', symbol: 'ONDO', time: close + 1000, side: 'sell', px: 1.1, size: 16000, fee: 1, realizedPnl: -120 },
    ],
  }, {});
  assert.equal(closed.length, 1, 'partial hedge close legs should still pair before filtering');
  const filtered = filterFullyClosedPairs(closed, {
    hyperliquid: {},
    nado: { ONDO: { symbol: 'ONDO-PERP', size: 28000 } },
  });
  assert.equal(filtered.length, 0, 'closed tab must hide rounds while either venue still holds size');
}

{
  const nadoLiq = computeNadoLiquidationPx({
    amount: 200000,
    oracle: 0.323475,
    maintenanceHealth: 5000,
    longWeightMaint: 0.95,
    shortWeightMaint: 1.05,
  });
  assert.ok(nadoLiq > 0 && nadoLiq < 0.323475, 'NADO long liquidation must sit below oracle');

  const nadoVerySafe = computeNadoLiquidationPx({
    amount: 12000,
    oracle: 0.71,
    maintenanceHealth: 26442,
    longWeightMaint: 0.95,
    shortWeightMaint: 1.05,
  });
  assert.equal(nadoVerySafe, null, 'NADO official formula must return null when position is very safe');

  assert.equal(liquidationPriceFrom({ liquidationPx: '0.669877' }), 0.669877, 'Hyperliquid must use API liquidation when present');
  assert.equal(liquidationPriceFrom({ liquidationPx: null }), null, 'Hyperliquid must show no liquidation when API returns null');

  const grvtLiq = liquidationPriceFrom(normalizeGrvtPositionRow({
    i: 'IP_USDT_Perp',
    el: '287500000',
  }), v => (Number(v) >= 1e6 ? Number(v) / 1e9 : Number(v)));
  assert.ok(grvtLiq > 0 && grvtLiq < 0.5, 'GRVT must use API est_liquidation_price when provided');
  assert.equal(liquidationPriceFrom(normalizeGrvtPositionRow({ i: 'IP_USDT_Perp', s: '44000' })), null, 'GRVT must show no liquidation when API omits el');
}

{
  const merged = mergeNadoMatches(
    { wallet: '0x1', subaccount: 's', days: 30, matches: [{ submissionIdx: '1', symbol: 'ONDO', time: 1, fee: 1, realizedPnl: 2 }] },
    { wallet: '0x1', subaccount: 's', days: 30, matches: [{ submissionIdx: '2', symbol: 'MEGA', time: 2, fee: 3, realizedPnl: 4 }] },
  );
  assert.equal(merged.matches.length, 2, 'inactive-symbol Nado history must merge with active-symbol matches');
  assert.equal(merged.totalFees, 4);
}

assert.match(indexHtml, /const PROTO_APR_FLOOR_HOURS = 24;/, 'protocol APR must floor short gaps to 24 hours');
assert.match(indexHtml, /const PROTO_APR_EXACT_AFTER_HOURS = 8;/, 'protocol APR must use exact elapsed time once imports are 8h or more apart');
assert.match(indexHtml, /function protocolAprDaysDiff\(baselineTs, newerTs\)/, 'protocol APR must branch between 24h floor and exact elapsed time');
assert.match(indexHtml, /const PROTO_APR_MAX_ABS = 80;/, 'protocol APR must hide rates at or above 80%');
assert.match(indexHtml, /const PROTO_VALUE_CHANGE_MAX = 700;/, 'protocol APR must hide positions with value changes above $700');
assert.match(indexHtml, /const MAX_PROTOCOL_SNAPSHOTS = 5;/, 'protocol snapshots must keep up to five previous imports');
assert.match(indexHtml, /function getAprBaselineSnapshot\(\)/, 'protocol APR must use the selected snapshot baseline');
assert.match(indexHtml, /function selectProtocolSnapshot\(tsValue\)/, 'snapshot picker must drive the APR baseline on Current');
assert.ok(indexHtml.includes("if (/nado/i.test(String(block.name || ''))) continue;"), 'protocol names containing Nado must be skipped during text import');
assert.match(indexHtml, /function calcSnapshotPositionAPR\(posKey, newerSnap, olderSnap\)/, 'snapshot view must compute yields against the prior snapshot');
assert.match(indexHtml, /function toggleProtocolSnapshotPicker\(\)/, 'snapshot picker must open only after clicking Select');
assert.ok(indexHtml.includes('id="protocolSnapshotSelectBtn"'), 'snapshot section must expose a Select button');
assert.match(indexHtml, /📸 Snapshot/, 'protocol snapshot tab must be renamed to Snapshot');
assert.doesNotMatch(indexHtml, /📸 First Snapshot/, 'protocol snapshot tab must not keep the First Snapshot label');
assert.match(indexHtml, /<div>Protocol<\/div><div>Type<\/div><div>Position<\/div>/, 'protocol positions table must drop the Network column');
assert.match(indexHtml, /periodYield \+= delta;/, '24h yield must use raw period deltas instead of dividing by elapsed time');
assert.match(indexHtml, /suppliedWeighted \+= apr \* val;\s*\n\s*suppliedWeight \+= val;/, 'supply APY must include all non-borrowed protocol positions');

console.log('PASS: perps accounting and dashboard regression checks');

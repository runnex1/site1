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
  closedPairAvgNotional,
  closedPairSessionApr,
  closedPairSessionDays,
  filterFreshClosedPairs,
  buildDailyFundingSeries,
  trimDailySeriesToLatestSession,
  computeCombinedNetDeposits,
  filterFullyClosedPairs,
  mergeNadoMatches,
  pairOpenedAtMs,
  sumPairFundingPaymentsSince,
  applyPairFundingSinceOpen,
  computeNadoLiquidationPx,
  liquidationPriceFrom,
  normalizeGrvtPositionRow,
  parseHyperliquidTpslOrders,
  parseGrvtTpslOrders,
  classifyNadoTriggerSide,
  perpsTpslMismatch,
  applyGrvtStateFallback,
  parseGrvtPositionsOverride,
  perpHedgedSizesExactMatch,
} = require('../lib/perps.js');
const aaveProxyHandler = require('../api/aave-proxy.js');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const indexHtml = readFileSync(join(ROOT, 'index.html'), 'utf8');
const perpsJs = readFileSync(join(ROOT, 'lib', 'perps.js'), 'utf8');
const loopSnapshotsJs = readFileSync(join(ROOT, 'lib', 'loop-snapshots.js'), 'utf8');
const aaveProxyJs = readFileSync(join(ROOT, 'api', 'aave-proxy.js'), 'utf8');
const syncJs = readFileSync(join(ROOT, 'api', 'sync.js'), 'utf8');
const variationalHedgeJs = readFileSync(join(ROOT, 'lib', 'variational-hedge.js'), 'utf8');
const vercelJson = readFileSync(join(ROOT, 'vercel.json'), 'utf8');
const watcherPreviewHtml = readFileSync(join(ROOT, 'ui-previews', 'watcher-preview.html'), 'utf8');
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

{
  const openTime = Date.UTC(2026, 0, 1, 0, 0);
  const closeTime = Date.UTC(2026, 0, 31, 0, 0);
  const pair = {
    symbol: 'BTC',
    openTime,
    closeTime,
    size: 1,
    avgNotional: 100000,
    netPnl: 1000,
    longLeg: { venue: 'hyperliquid', side: 'long', size: 1, avgEntryPx: 100000 },
    shortLeg: { venue: 'nado', side: 'short', size: 1, avgEntryPx: 100000 },
  };
  const days = closedPairSessionDays(pair);
  assert.ok(days > 29 && days < 32, 'closed session days must use open-to-close duration');
  const apr = closedPairSessionApr(pair);
  assert.ok(apr > 10 && apr < 14, 'closed session APR must annualize net PnL over margin and session days');
}

{
  const pair = {
    symbol: 'ETH',
    sessionStartDay: '2026-01-01',
    sessionEndDay: '2026-01-10',
    sessionDayCount: 3,
    avgNotional: 50000,
    netPnl: 500,
    openTime: Date.UTC(2025, 0, 1),
    closeTime: Date.UTC(2026, 0, 31),
  };
  assert.equal(closedPairSessionDays(pair), 10, 'closed session days must prefer latest performance session span');
  const apr = closedPairSessionApr(pair);
  assert.ok(apr > 35 && apr < 40, 'closed session APR must use performance session days, not open-to-close calendar span');
}

{
  const pair = {
    symbol: 'VIRTUAL',
    size: 40000,
    netPnl: -40,
    openTime: Date.UTC(2026, 4, 29),
    closeTime: Date.UTC(2026, 5, 4),
    longLeg: { venue: 'grvt', size: 40000, entryPx: 0.65 },
    shortLeg: { venue: 'hyperliquid', size: 40000, avgEntryPx: 0.722 },
  };
  const margin = closedPairAvgNotional(pair);
  assert.ok(margin > 25000 && margin < 31000, 'closed margin must average available leg entry/exit notionals');
  assert.ok(closedPairSessionApr(pair) != null, 'closed APR must compute when at least one leg has price data');
}

assert.match(indexHtml, /function perpsClosedPairAvgNotional\(/, 'Closed tab must recompute margin from leg prices and live marks');
assert.match(indexHtml, /perps-pos-closed-cell/, 'Closed tab must align metric values under column headers');

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
assert.match(perpsJs, /function applyPairFundingSinceOpen\(/, 'paired funding since open must use payment history');
assert.match(perpsJs, /applyPairFundingSinceOpen\(pair, base, venueA, venueB, paymentSources, sinceMs\)/, 'pair funding meta must override venue cumFunding with payment sums');

{
  const openMs = 1768953600006;
  const paymentSources = {
    hyperliquid: [
      { symbol: 'IP', time: openMs + 1000, usdc: -10 },
      { symbol: 'IP', time: openMs - 1000, usdc: -999 },
    ],
    grvt: [
      { symbol: 'IP', time: openMs + 2000, usdc: 50 },
      { symbol: 'IP', time: openMs + 3000, usdc: 25 },
    ],
  };
  const total = sumPairFundingPaymentsSince('IP', 'hyperliquid', 'grvt', paymentSources, openMs);
  assert.equal(total, 65, 'funding since open must sum signed payment usdc after pair open, not position cumFunding');
  const pair = {
    pairType: 'hl_grvt',
    combinedUpnl: 30,
    realized: 0,
    fees: 5,
    fundingSinceOpen: -45,
    netArbPnl: -20,
  };
  applyPairFundingSinceOpen(pair, 'IP', 'hyperliquid', 'grvt', paymentSources, openMs);
  assert.equal(pair.fundingSinceOpen, 65, 'applyPairFundingSinceOpen must replace stale cumFunding totals');
  assert.equal(pair.hlFundingSinceOpen, -10, 'HL leg funding since open must come from payment history');
  assert.equal(pair.legBFundingSinceOpen, 75, 'GRVT leg funding since open must come from payment history');
  assert.equal(pair.netArbPnl, 90, 'net arb PnL must refresh after funding since open correction');
}
assert.match(perpsJs, /stats\.funding_rate/, 'Extended rates must tolerate snake_case funding-rate fields');
assert.match(perpsJs, /function enrichClosedPairsSessionPnl\(closedPairs, dailySeriesInputs/, 'closed positions must enrich funding and fees from the latest performance session');
assert.match(perpsJs, /enrichClosedPairsSessionPnl\(freshClosedPairs/, 'dashboard closed pairs must use session-aligned PnL');
assert.match(perpsJs, /function filterFreshClosedPairs\(pairs, knownClosedKeys\)/, 'known closed pairs must skip full payload on incremental fetches');
assert.match(perpsJs, /closedPairRefreshes/, 'known closed pairs must still receive refreshed session metrics from the server');
assert.match(aaveProxyJs, /knownClosedKeys\.length/, 'incremental closed-pair requests must bypass the shared dashboard cache');
assert.match(indexHtml, /const PERPS_CLOSED_PAIRS_KEY = 'vault-perps-closed-pairs'/, 'closed pairs must persist locally');
assert.match(indexHtml, /params\.set\('knownClosedKeys', knownClosedKeys\.join\(','\)\)/, 'perps refresh must tell the API which closed rounds are already cached');
assert.match(indexHtml, /data\.closedPairs = perpsCacheNewClosedPairs\(\[[\s\S]{0,120}closedPairRefreshes/, 'dashboard render must merge fresh and refreshed closed pairs into the cache');
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
assert.match(indexHtml, /maxlength="96" placeholder="e\.g\. HOME, AAPL, BONK, 0x\.\.\., Solana mint"/, 'market ticker add flow must accept token contracts and Solana mints');
assert.match(indexHtml, /function tickerNormalizeInputSymbol\(value, source = 'auto'\)/, 'custom ticker symbols must preserve contract address casing');
assert.match(indexHtml, /function tkFetchGeckoCoinByContract\(value, withMarketData = true\)/, 'custom ticker CoinGecko source must support contract-address lookup');
assert.match(indexHtml, /if \(isSolanaMint\(clean\)\) return clean;/, 'custom ticker Jupiter source must accept a Solana mint directly');
assert.match(indexHtml, /tickerAddPrecision[\s\S]{0,220}3 exact decimals/, 'custom ticker add flow must allow exact 3-decimal display');
assert.match(indexHtml, /id="\$\{slug\}-precision-input"[\s\S]{0,220}3 dp/, 'custom ticker edit flow must allow exact 3-decimal display');
assert.match(indexHtml, /function tickerFmtForEntry\(price, entry = null\)[\s\S]{0,140}entry\?\.precision === '3'/, 'custom ticker formatter must honor saved exact-decimal preference');
assert.match(indexHtml, /class="ticker-ok-btn" onclick="tkEditSave\(\$\{idx\}\)"/, 'custom ticker editor must show an OK save button beside the selected source');
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
assert.match(eventLogJs, /walletSuffix4\(g\.wallet\)/, 'server event log must append wallet suffix to order fills');
assert.match(eventLogJs, /if \(!\/\\bBREAKING\\b\/i\.test\(text\)\) continue;/, 'event log must include only breaking Kobeissi headlines');
assert.doesNotMatch(eventLogJs, /'Kobeissi Letter'/, 'event log must not add non-breaking Kobeissi headlines');
assert.match(indexHtml, /ticker-strip-viewport/, 'market ticker must use a scrolling viewport for overflow symbols');
assert.match(indexHtml, /function syncTabRefreshTimers\(tab\)/, 'tab switches must start and stop feature refresh timers');
for (const rel of [
  'api/aave-proxy.js',
  'api/sync.js',
  'lib/cron-runner.js',
  '.github/workflows/loops-snapshot.yml',
  '.github/workflows/perps-equity-snapshot.yml',
  '.github/workflows/cron-tick.yml',
]) {
  assert.doesNotMatch(readFileSync(join(ROOT, rel), 'utf8'), /SYNC_SECRET1/, `${rel} must use only SYNC_SECRET`);
}
const cronRunnerJs = readFileSync(join(ROOT, 'lib', 'cron-runner.js'), 'utf8');
assert.doesNotMatch(cronRunnerJs, /perpsLive: \{ everyMs/, 'cron tick must not schedule unused perpsLive job');
assert.doesNotMatch(cronRunnerJs, /fundingRates: \{ everyMs/, 'cron tick must not schedule unused fundingRates job');
assert.doesNotMatch(cronRunnerJs, /predictionActivity: \{ everyMs/, 'event log must not duplicate via predictionActivity cron');
assert.doesNotMatch(cronRunnerJs, /checkAlerts: \{ everyMs/, 'alerts must use dedicated /api/check-alerts only');
assert.match(cronRunnerJs, /loopsSync: \{ everyMs: 15 \* 60 \* 1000/, 'loopsSync must run every 15 minutes');
assert.match(syncJs, /maxJobs \|\| '1'/, 'cron tick must default to one job per wake');
assert.match(aaveProxyJs, /LOOP_RATES_KV_CACHE_MS = 15 \* 60 \* 1000/, 'loop-rates KV cache must match 15m cron interval');
const loopRatesJs = readFileSync(join(ROOT, 'lib', 'loop-rates.js'), 'utf8');
assert.match(loopRatesJs, /function morphoUsdFromRaw\(amountRaw, asset\)/, 'Morpho loops must derive USD from raw token amounts when Morpho omits USD fields');
assert.match(loopRatesJs, /borrowAssets borrowAssetsUsd/, 'Morpho loop query must request raw borrow asset amounts');
assert.match(loopRatesJs, /api\.fluid\.instadapp\.io/, 'Fluid loops must use the official Fluid API');
assert.match(loopRatesJs, /fluidPositionSource: 'fluid-official-api'/, 'Fluid position source must identify the official API');
assert.doesNotMatch(loopRatesJs, /DEFINITIV_API_KEY/, 'Fluid loops must not require a Definitiv API key');
assert.match(loopRatesJs, /api\.merkl\.xyz/, 'Loop APR must include Merkl reward campaigns');
assert.match(loopRatesJs, /rewards\/active-opportunities/, 'Merkl enrichment must use active opportunities for live reward APR');
assert.match(loopRatesJs, /\/v4\/users\/\$\{wallet\}\/rewards\?chainId=/, 'Merkl net value must use user rewards endpoint for unclaimed balance');
assert.match(loopRatesJs, /merklUnclaimedUsdFromBreakdown/, 'Merkl rewards must subtract claimed from amount per breakdown');
assert.match(loopRatesJs, /merkl-user-rewards-unclaimed/, 'loop coverage must report unclaimed Merkl reward source');
assert.match(loopRatesJs, /fetchDefillamaYieldApyIndex/, 'yield-bearing collateral must use DeFiLlama APY when protocol supply APY is zero');
assert.match(loopRatesJs, /function canonicalNativeYieldApy\(/, 'native yield tokens like reUSD must use a shared DeFiLlama APY across protocols');
assert.match(loopRatesJs, /canonicalNativeYieldApy\(chainId, leg, index\)/, 'defillama leg lookup must prefer canonical native yield before address pools');
assert.match(loopRatesJs, /function shouldEnrichLegWithDefillama\(/, 'DeFiLlama enrichment must skip plain collateral like WBTC');
assert.match(loopRatesJs, /const dlApy = percent\(dlApyRaw\)/, 'DeFiLlama APY must normalize to protocol percent units');
assert.match(indexHtml, /id="loopsLendingSection"/, 'Loops tab must render a separate lending-only section');
assert.match(indexHtml, /function loopImportedLendingPositions\(/, 'Loops must include imported supply-only lending positions');
assert.match(indexHtml, /function buildLoopCardHtml\(/, 'Loops must share one card renderer for loops and lending rows');
assert.match(indexHtml, /function protocolDisplayEntries\(protocols, unitPrices = null\)/, 'protocol positions must split leveraged loops into separate rows');
assert.match(indexHtml, /DEFI_POSITION_MIN_DISPLAY_USD = 50/, 'DeFi positions table must hide positions at or below $50');
assert.match(indexHtml, /function buildSimpleDrawerTableHtml\(sec, ctx\)/, 'deposit-only protocol drawers must use aligned table layout');
assert.match(indexHtml, /kind: 'lending'/, 'protocol display entries must tag leveraged lending rows');
assert.match(indexHtml, /protocolEntrySummary\(entry\)/, 'protocol rows must show per-loop position summary');
assert.match(indexHtml, /protocolEntryNetValue\(entry\)/, 'protocol rows must use per-section net value');
assert.match(indexHtml, /function loopsUploadSnapshotsToServer\(/, 'loop snapshots must upload to server after local append');
assert.match(indexHtml, /function startLoopSnapshotScheduler\(/, 'loops tab must schedule 2h snapshot sync while open');
assert.match(indexHtml, /LOOP_SNAPSHOT_INTERVAL_MS = 2 \* 60 \* 60 \* 1000/, 'loop snapshot scheduler must run every 2 hours');
assert.match(indexHtml, /2h snapshot history/, 'loop history empty state must mention 2h snapshots');
assert.match(aaveProxyJs, /persistLoopSnapshotsFromRates/, 'loop-rates fetch must persist snapshots to KV');
assert.match(syncJs, /body\.loopSnapshots/, 'sync POST must merge client loop snapshots into KV');
assert.match(loopRatesJs, /fetchSolanaLoopRates/, 'loop rates must fetch Kamino and Jupiter Lend for Solana yield wallets');
const loopSolanaRatesJs = readFileSync(join(ROOT, 'lib', 'loop-solana-rates.js'), 'utf8');
assert.match(loopSolanaRatesJs, /api\.kamino\.finance/, 'Kamino integration must use the public Kamino REST API');
assert.match(loopSolanaRatesJs, /kamino-api/, 'Kamino positions must identify kamino-api source');
assert.match(loopSolanaRatesJs, /api\.jup\.ag\/lend\/v1/, 'Jupiter Lend integration must use the public Jupiter REST API');
assert.match(loopSolanaRatesJs, /jupiter-lend-api/, 'Jupiter Lend positions must identify jupiter-lend-api source');
assert.match(loopSolanaRatesJs, /jupiter-portfolio-api/, 'Jupiter Lend must fall back to Portfolio API when borrow positions endpoint is empty');
assert.match(loopSolanaRatesJs, /JUPITER_PORTFOLIO_API/, 'Jupiter Portfolio fallback must use the official portfolio API base');
assert.match(loopSolanaRatesJs, /positions\/\$\{encodeURIComponent\(wallet\)\}/, 'Jupiter Portfolio fallback must fetch positions by wallet address');
assert.match(loopRatesJs, /economicNetValue/, 'loop positions must include Merkl rewards in economic net value for snapshots');
assert.match(indexHtml, /LOOP_API_STATE_KEY/, 'loops tab must cache last live API state across page refreshes');
assert.match(indexHtml, /supplementalImported/, 'Loops must keep imported Fluid/Morpho positions when live API coverage is incomplete');
assert.match(loopSnapshotsJs, /economicNetValue/, 'loop snapshots must persist Merkl-inclusive economic net value');
assert.match(loopSnapshotsJs, /isUsdeUsdmLoopSnapshotPosition/, 'loop snapshots must identify USDe/USDm Aave MegaETH history');
assert.match(loopSnapshotsJs, /ensureUsdeUsdmSnapshotsPurged/, 'loop snapshots must one-time purge inflated USDe/USDm buckets');
assert.match(loopSnapshotsJs, /isSolanaWallet/, 'loop snapshots must accept Solana yield wallets');
assert.match(indexHtml, /loopsPurgeUsdeUsdmSnapshotHistory/, 'loops tab must purge inflated USDe/USDm history from local snapshots');
assert.match(loopSnapshotsJs, /LOOP_SNAPSHOT_BUCKET_HOURS = 2/, 'loop snapshots must bucket history on 2h intervals');
assert.match(loopSnapshotsJs, /function appendLoopSnapshotStore\(store, data/, 'loop snapshots must append server-side history');
assert.match(loopSnapshotsJs, /function loopPositionHistoryKey\(/, 'loop snapshots must use stable history keys across Fluid NFT id changes');
assert.match(loopSnapshotsJs, /fluid-vault:/, 'Fluid loop history keys must include vault NFT id');
assert.match(loopRatesJs, /function fluidVaultPositionId\(/, 'Fluid vault positions must use unique ids per NFT');
assert.match(aaveProxyJs, /loopCronSnapshot/, 'loop cron snapshots must be exposed through aave-proxy');
assert.match(indexHtml, /function loopHistoryPositionMatch\(/, 'loop history must match snapshots by stable history key');
assert.match(indexHtml, /\/api\/loop-snapshots/, 'loops tab must hydrate snapshots from dedicated endpoint');
assert.match(indexHtml, /watcherWallets: watcherWallets/, 'loop sync must POST yield wallets so cron can snapshot server-side');
const loopsWorkflow = readFileSync(join(ROOT, '.github', 'workflows', 'loops-snapshot.yml'), 'utf8');
assert.match(loopsWorkflow, /5 \*\/2 \* \* \*/, 'GitHub cron must run every 2 hours');
assert.match(loopsWorkflow, /loop-cron-snapshot/, 'loop cron backup must use vercel rewrite to loopCronSnapshot');
assert.match(vercelJson, /"source": "\/api\/check-alerts"/, 'check-alerts must rewrite to sync handler');
assert.match(vercelJson, /"source": "\/api\/loop-cron-snapshot"/, 'loop cron must expose friendly rewrite path');
assert.match(syncJs, /checkAlerts === '1'/, 'sync must route check-alerts cron through shared handler');
assert.match(syncJs, /check-alerts-run/, 'check-alerts logic must live in lib to stay within function limit');
assert.match(aaveProxyJs, /vault:loop_snapshots/, 'loop snapshots must persist in KV');
assert.match(syncJs, /loopSnapshots === '1'/, 'sync endpoint must hydrate loop snapshot history');
assert.match(indexHtml, /loops-cockpit[\s\S]{0,180}max-width:min\(1180px/, 'loops tab must use centered max-width like perps');
assert.match(indexHtml, /page-content:has\(#loopsTab\.active\)[\s\S]{0,80}padding:10px 2\.75rem/, 'loops tab must have horizontal page padding like perps');
assert.match(indexHtml, /loops-grid[\s\S]{0,120}grid-template-columns:repeat\(2, minmax\(0, 1fr\)\)/, 'loops grid must show two cards per row on desktop');
assert.match(indexHtml, /loop-card-head/, 'loop cards must use stacked hero header row');
assert.match(indexHtml, /loop-card-main/, 'loop cards must use chart + legs side-by-side layout');
assert.match(indexHtml, /loop-summary-row/, 'loop summary must place supply and borrow APY left of net value');
assert.match(indexHtml, /loop-head-stats/, 'loop header must group net APY and health on the right');
assert.match(indexHtml, /function loopHeadStatsHtml\(/, 'loop header must render net APY beside health');
assert.match(indexHtml, /function loopPairLegHtml\(/, 'loop pair title must render token logo beside each leg symbol');
assert.match(indexHtml, /loopPairLegHtml\(supplied, 'supply', 32, suppliedPos\)/, 'loop pair title must show supply leg with logo');
assert.match(indexHtml, /loopPairLegHtml\(borrowed, 'borrow', 32, borrowedPos\)/, 'loop pair title must show borrow leg with logo');
assert.match(indexHtml, /function loopPairLegTooltipHtml\(/, 'loop pair tickers must show amount value and price on hover');
assert.match(loopRatesJs, /amount: num\(item\?\.balance\?\.amount\?\.value\)/, 'Aave loop legs must expose token amount for ticker tooltips');
assert.doesNotMatch(indexHtml, /loop-head-eyebrow">\$\{dashEsc\(p\.name\)\}/, 'loop cards must not show protocol name in header');
assert.match(indexHtml, /loop-protocol-mark" title="\$\{dashEsc\(p\.name\)\}">\$\{makeLoopLogo\(p\.name, true, 26\)\}/, 'loop cards must show protocol logo without protocol name text');
assert.doesNotMatch(indexHtml, /#fda4af/, 'loop borrow token must not use red title color');
assert.match(indexHtml, /loop-history-apy \{ stroke:rgba\(56,189,248/, 'loop APY chart must use sky blue instead of orange');
assert.match(indexHtml, /loop-history-grid/, 'loop history chart must render subtle grid lines');
assert.match(indexHtml, /function loopEffectiveNetValue\(/, 'loops must use Merkl-inclusive economic net value for live positions');
assert.match(indexHtml, /function loopHistoryPositionNet\(/, 'loop capital events must ignore Merkl-only net value changes');
assert.match(indexHtml, /function loopNetValueTooltipHtml\(/, 'loop net value must show Aave vs Merkl breakdown on hover');
assert.match(indexHtml, /function loopPositionValue\(/, 'loops must price import fallback without stablecoin peg band');
assert.match(indexHtml, /loopPositionValue\(pos\)/, 'loop import fallback must use loopPositionValue not protocolPositionValue');
assert.match(indexHtml, /const legTokens = item =>/, 'loop live mapper must use a dedicated token amount formatter');
assert.doesNotMatch(indexHtml, /Number\(item\.value \|\| 0\)\.toLocaleString\('en-US', \{ maximumFractionDigits: 4 \}\) \+ ` \$\{item\.symbol\}`/, 'loops must not use USD value as a fake token amount');
assert.match(indexHtml, /function loopLegUnitPrice\(pos\)/, 'loop tooltip price must be computed from explicit/live token prices');
assert.doesNotMatch(indexHtml, /function loopLegUnitPrice\(amount, value\)[\s\S]{0,220}return value \/ amount;/, 'loop tooltip must not derive token price from value divided by amount');
assert.match(indexHtml, /lendingSectionApyBreakdown\(p, sec, loopPositionValue\)/, 'Loops imported APY weighting must not use Protocol Positions stable peg valuation');
assert.match(indexHtml, /lib\/defi-protocol-keys\.js/, 'protocol section keys must be shared for multi-loop APR');
assert.match(indexHtml, /aprHtmlFn: \(pos\) => aprBadgeHtml\(protocolPositionKey\(p, sec, pos\)/, 'defi drawer APR must use canonical section index keys');
assert.match(indexHtml, /protocolPositionKey\(p, section, pos\)/, 'lending APY breakdown must use canonical position keys');
assert.match(indexHtml, /USDM:'mountain-protocol-usdm'/, 'Loops live token prices must resolve USDm via Mountain Protocol USDm');
assert.match(indexHtml, /tab !== 'defi' && tab !== 'loops'/, 'live token prices must only refresh on DeFi and Loops tabs');
assert.match(indexHtml, /LOOPS_TOKEN_PRICE_REFRESH_MS = 60 \* 60 \* 1000/, 'loops live prices must refresh hourly while tab is active');
assert.match(indexHtml, /for \(const p of loopApiState\.positions \|\| \[\]\)/, 'live token prices must include Loop API leg symbols');
assert.match(indexHtml, /loopEffectiveNetValue\(loop\)/, 'loops KPIs and cards must rank and sum economic net value');
assert.match(indexHtml, /function perpsPairLatestSessionPnl\(/, 'perps positions must compute latest-session PnL for open rows');
assert.match(indexHtml, /function perpsPairTotalPnlBreakdown\(/, 'perps total PnL must combine spread funding and fees');
assert.match(indexHtml, /perpsFilterPairLatestSessionForRange\(p\.dailyPerformanceSeries \|\| \[\], null\)/, 'perps position PnL must use latest session without stat range');
assert.doesNotMatch(indexHtml, /Total PnL · \$\{dashEsc\(rangeLabel\)\}/, 'perps open positions must not suffix total PnL with stat range');
assert.doesNotMatch(indexHtml, /Net APR · \$\{dashEsc\(perpsStatRangeLabel/, 'perps open positions must not suffix Net APR with stat range');
assert.match(indexHtml, /perps-pos-metric-label">Net APR<\/div>/, 'perps open positions must label Net APR without time window');
assert.match(indexHtml, /function perpsBuildTotalPnlTooltipHtml\(/, 'perps total PnL must expose spread + funding + fees tooltip');
assert.match(indexHtml, /function perpsBuildFundingTooltipHtml\(/, 'perps funding must expose calculation tooltip');
assert.doesNotMatch(indexHtml, /Realized slippage/, 'dashboard must not show realized slippage');
assert.doesNotMatch(indexHtml, /sessionRealizedSlippage/, 'dashboard must not read session realized slippage');
assert.doesNotMatch(indexHtml, /dailySlippage/, 'daily funding chart must not include close slippage in series rows');
assert.doesNotMatch(indexHtml, /function perpsShowClosedPnlTip\(/, 'closed tab must not use slippage breakdown tooltips');
assert.doesNotMatch(perpsJs, /buildCloseSlippageByDay/, 'perps API must not merge close slippage into daily funding');
assert.doesNotMatch(indexHtml, /loop-head-stat-sub/, 'loop health must not show Risk/Watch/Safe sublabel');
assert.doesNotMatch(indexHtml, /\.loop-head-eyebrow/, 'loop header must not use protocol eyebrow styling');
assert.match(indexHtml, /loop-history-chart/, 'loop cards must render snapshot history chart');
assert.doesNotMatch(indexHtml, /loop-meter-wrap[\s\S]{0,1200}renderLoops/, 'loops render must not use LTV meter bar');
assert.match(indexHtml, /function loopHistoryChartHtml\(points, opts = \{\}\)/, 'loops tab must build per-position history charts from snapshots');
assert.match(indexHtml, /function loopHistoryChartSetMode\(/, 'loop history chart must toggle between net value and APY');
assert.match(indexHtml, /defaultMode = hasApy \? 'apy' : 'val'/, 'loop history chart must default to APY mode when APY history exists');
assert.match(indexHtml, /function loopHistoryChartHover\(/, 'loop history chart must support hover tooltips');
assert.doesNotMatch(indexHtml, /loopHistoryChartHtml[\s\S]{0,2200}loopHistoryPeriodDelta/, 'loop history chart must not render period delta footer');
assert.doesNotMatch(indexHtml, /loop-history-foot[\s\S]{0,400}3h buckets/, 'loop history chart must not show 3h buckets hint');
assert.match(indexHtml, /loop-history-mode-btn/, 'loop history chart must expose net value / APY toggle buttons');
assert.match(indexHtml, /height:148px/, 'loop history chart must be tall enough to read trends');
assert.match(indexHtml, /function loopSnapshotPeriodNetApy\(/, 'loops tab must compute period net APY from spot snapshot rates');
assert.match(indexHtml, /function loopTrimHistoryToLatestSession\(/, 'loop history must reset after deposits and withdrawals');
assert.match(indexHtml, /function loopHistoryCapitalEvent\(/, 'loop history must detect capital flow between snapshots');
assert.match(indexHtml, /loopSnapshotApyRowHtml\(chartMode, adjustedHistoryPoints, liveEndValue, liveEndTs\)/, 'loop cards must seed 7d/30d metrics from active chart mode and manual APY overrides');
assert.match(indexHtml, /function loopSetManualSupplyApy\(/, 'loops must allow timestamped manual supply APY overrides');
assert.doesNotMatch(indexHtml, /Fix \$1 peg/, 'loops tab must not expose borrowed-token $1 peg toggle');
assert.doesNotMatch(indexHtml, /function loopBorrowedPegNetValue\(/, 'loops tab must not recalculate borrowed legs with $1 peg');
assert.doesNotMatch(indexHtml, /function loopBorrowLegPeggedValue\(/, 'loops tab must not derive borrowed amounts for $1 peg charts');
assert.doesNotMatch(indexHtml, /LOOP_FIX_PEG_KEY/, 'loops tab must not persist $1 peg toggle state');
assert.match(indexHtml, /amount:\s*Number\(leg\?\.amount \|\| 0\) \|\| null/, 'browser loop snapshots must persist borrowed token amounts');
assert.match(loopSnapshotsJs, /amount:\s*num\(leg\?\.amount, null\)/, 'server loop snapshots must persist borrowed token amounts');
assert.match(indexHtml, /function tickerFmt\(price\)[\s\S]{0,240}minimumFractionDigits:\s*5/, 'market ticker must show near-$1 assets with enough precision instead of looking hard-pegged');
assert.match(indexHtml, /chartMode === 'apy'\s*\?\s*loopSnapshotPeriodNetApy\(points, targetDays, endTs\)/, 'APY chart mode must use spot net APY average');
assert.match(indexHtml, /:\s*loopSnapshotRealizedApy\(points, targetDays, endValue, endTs\)/, 'net value chart mode must use realized net value APY');
assert.match(indexHtml, /function loopSnapshotApyLegHtml\(/, 'loop cards must show 7d/30d APY in leg pane');
assert.match(indexHtml, /function loopSnapshotApyRowHtml\(/, 'loop cards must render 7d/30d APY row from chart mode');
assert.match(indexHtml, /function loopRefreshPeriodApyMetrics\(/, 'loop chart toggle must refresh 7d/30d APY metrics');
assert.match(indexHtml, /loopRefreshPeriodApyMetrics\(chart\)/, 'loop chart mode switch must update period APY metrics');
assert.match(indexHtml, /loop-realized-row/, 'loop cards must render realized APY mini metrics');
assert.match(indexHtml, /loopBuildChartHistoryPoints\(historyPoints, loop\.raw, liveEndValue, liveEndTs\)/, 'loop charts must reset net value history after deposits and withdrawals');
assert.match(indexHtml, /buildProtocolPnlPositionRows\(currentProtocols\)/, 'protocol PNL must match exact positions in current data and latest snapshot');
assert.match(indexHtml, /normalizePnlMatchKey\(cur\.key\)/, 'protocol PNL must match position keys between snapshot and live data');
assert.match(indexHtml, /computeProtocolSnapshotDeltaPnl\(pairs/, 'protocol PNL must filter by APY and 1\\.2% max net move');
assert.match(indexHtml, /DefiPnl\.PROTOCOL_PNL_MAX_MOVE_PCT/, 'protocol PNL max move threshold must use shared defi-pnl constant');
assert.match(indexHtml, /\[1-9A-HJ-NP-Za-km-z\]\{32,44\}/, 'loop yield wallets must accept Solana addresses');
assert.match(indexHtml, /Kamino, Jupiter Lend/, 'yield wallet modal must mention Solana loop protocols');
assert.match(indexHtml, /function predictionAggregatePnlDisplayValue\(/, 'Prediction Markets top PNL must use the same aggregate cache as the PNL chart');
assert.match(indexHtml, /fetchPredictionPnlChartPoints\('all'\)/, 'Prediction Markets top PNL must refresh from the all-time PNL chart API');
assert.match(indexHtml, /source:\s*'pnl-chart'/, 'Prediction Markets top PNL must mark chart-backed values instead of relying first on leaderboard data');
assert.match(indexHtml, /function ensurePolyFilledOrders\(/, 'Prediction Markets watched-wallet trades must share the Event Log fill loader');
assert.match(indexHtml, /predictionRenderFilledGroups\(groupFilledTradesByWindow/, 'Prediction Markets smart money must render grouped Order Filled rows like Event Log');
assert.doesNotMatch(indexHtml, /Wallet activity timed out/, 'Prediction Markets must not use a separate timed fill fetch');
assert.match(watcherPreviewHtml, /Dashboard theme tokens/, 'Watcher preview must use the Dashboard theme token set');
assert.match(watcherPreviewHtml, /linear-gradient\(180deg, rgba\(7,18,26,\.95\), rgba\(5,13,19,\.97\)\)/, 'Watcher preview panels must match the Dashboard dark surface treatment');

{
  const { enrichPositionWithDefillamaYield, shouldEnrichLegWithDefillama } = require('../lib/loop-rates.js');
  const index = {
    bySymbolChain: new Map([['1:WBTC', { apy: 8.2, score: 8.2 }]]),
    byAddress: new Map(),
  };
  const wbtcLeg = { symbol: 'WBTC', role: 'collateral', apy: 0, value: 100000, address: '0x2260' };
  assert.equal(shouldEnrichLegWithDefillama(1, wbtcLeg, index), false, 'WBTC collateral must not be DeFiLlama enriched');
  const position = {
    chainId: 1,
    totalSupplied: 100000,
    totalBorrowed: 50000,
    supplied: [wbtcLeg],
    borrowed: [{ symbol: 'USDe', value: 50000, apy: 4.2 }],
    suppliedYieldUsd: 0,
    borrowedCostUsd: 2100,
    supplyApy: 0,
    borrowApy: 4.2,
    netApy: -2.1,
  };
  enrichPositionWithDefillamaYield(position, index);
  assert.equal(position.supplied[0].apy, 0, 'WBTC collateral APY must stay at zero after enrichment');
  assert.ok(!position.defillamaBoost, 'WBTC/USDe loop must not be marked defillama-boosted from collateral');
}

{
  const {
    mapKaminoObligation,
    mapJupiterBorrowPosition,
    mapJupiterPortfolioBorrowLend,
    jupiterHealthFactor,
    kaminoMarketValueUsd,
  } = require('../lib/loop-solana-rates.js');
  const usd = kaminoMarketValueUsd('2644812517817138226881');
  assert.ok(usd > 2000 && usd < 2500, 'Kamino marketValueSf must decode to USD');

  const kaminoPos = mapKaminoObligation(
    'AcNSmd5CxwLs21TYUmhWt7CW2v159TdYRkvQxb1iBYRj',
    { name: 'Main Market', lendingMarket: '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF' },
    {
      d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q: { liquidityToken: 'SOL', supplyApy: 0.02, liquidityTokenMint: 'So111' },
      ESCkPWKHmgNE7Msf77n9yzqJd5kQVWWGy3o5Mgxhvavp: { liquidityToken: 'USDG', borrowApy: 0.05, liquidityTokenMint: 'USDG' },
    },
    {
      obligationAddress: 'HcrU9nyaBFmhNPrxnwXRjreVxdQTZdq2dpvktjsWiS4J',
      refreshedStats: {
        userTotalBorrow: 30711.47,
        userTotalDeposit: 54354.56,
        netAccountValue: 23643.09,
        loanToValue: 0.565,
        liquidationLtv: 0.798,
      },
      state: {
        deposits: [{ depositReserve: 'd4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q', depositedAmount: '1', marketValueSf: '2644812517817138226881' }],
        borrows: [{ borrowReserve: 'ESCkPWKHmgNE7Msf77n9yzqJd5kQVWWGy3o5Mgxhvavp', borrowedAmountOutsideElevationGroups: '1', marketValueSf: '43678869538560795623741' }],
      },
    },
  );
  assert.equal(kaminoPos?.protocol, 'Kamino', 'Kamino mapper must tag protocol');
  assert.ok(kaminoPos?.totalBorrowed > 30000, 'Kamino mapper must keep borrowed USD from refreshed stats');
  assert.ok(kaminoPos?.health > 1.2 && kaminoPos?.health < 1.5, 'Kamino health must derive from liquidation LTV / loan LTV');

  const jupPos = mapJupiterBorrowPosition(
    'BQ72nSv9f3PRyRKCBnHLVrerrv37CYTHm5h3s9VSGQDV',
    new Map([[1, {
      id: 1,
      supplyRate: 200,
      borrowRate: 500,
      supplyToken: { uiSymbol: 'SOL', symbol: 'WSOL', decimals: 9, price: 100 },
      borrowToken: { uiSymbol: 'USDC', symbol: 'USDC', decimals: 6, price: 1 },
    }]]),
    { vaultId: 1, collateralUsd: 10000, debtUsd: 5000, healthRatio: 1.8 },
  );
  assert.equal(jupPos?.protocol, 'Jupiter', 'Jupiter mapper must tag protocol');
  assert.equal(jupPos?.marketName, 'SOL / USDC', 'Jupiter mapper must build pair label from vault tokens');
  assert.ok(jupPos?.netApy < 0, 'Jupiter loop net APY must subtract borrow cost from supply yield');

  const portfolioPos = mapJupiterPortfolioBorrowLend(
    'FuzwwLMkp8KU3NEGykHhKz56YR4u6SWghdAmB447hxA1',
    {
      type: 'borrowlend',
      fetcherId: 'jupiter-exchange-borrow',
      platformId: 'jupiter-exchange',
      netApy: 0.12633709934154186,
      value: 11846.98,
      data: {
        borrowedValue: 94496.35,
        suppliedValue: 106343.33,
        value: 11846.98,
        healthRatio: 0.42,
        link: 'https://jup.ag/lend/borrow/68/nfts/273',
        suppliedAssets: [{
          value: 106343.33,
          data: { address: '7GxATsNMnaC88vdwd2t3mwrFuQwwGvmYPrUQ4D6FotXk', yields: [{ apy: 0.0487 }] },
        }],
        borrowedAssets: [{
          value: 94496.35,
          data: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
        }],
        borrowedYields: [[{ apy: -0.039 }]],
      },
    },
    new Map([[68, {
      id: 68,
      supplyToken: { uiSymbol: 'JUICED', address: '7GxATsNMnaC88vdwd2t3mwrFuQwwGvmYPrUQ4D6FotXk' },
      borrowToken: { uiSymbol: 'USDC', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
    }]]),
    { '7GxATsNMnaC88vdwd2t3mwrFuQwwGvmYPrUQ4D6FotXk': { symbol: 'JUICED' }, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': { symbol: 'USDC' } },
  );
  assert.equal(portfolioPos?.marketName, 'JUICED / USDC', 'Portfolio fallback must map JUICED/USDC borrow loops');
  assert.equal(portfolioPos?.source, 'jupiter-portfolio-api', 'Portfolio fallback must tag jupiter-portfolio-api source');
  assert.ok(portfolioPos?.totalBorrowed > 90000, 'Portfolio fallback must keep borrowed USD');
  assert.equal(portfolioPos?.supplied?.[0]?.amount, null, 'Portfolio fallback must not invent token amount from USD value');
  assert.ok(Math.abs(jupiterHealthFactor(0.024) - 1.024) < 0.0001, 'Jupiter buffer health must display as 1 + ratio');
  assert.ok(Math.abs(portfolioPos?.health - 1.42) < 0.01, 'Jupiter portfolio health must convert buffer ratio to health factor scale');

  const portfolioPosWithAmount = mapJupiterPortfolioBorrowLend(
    'FuzwwLMkp8KU3NEGykHhKz56YR4u6SWghdAmB447hxA1',
    {
      type: 'borrowlend',
      fetcherId: 'jupiter-exchange-borrow',
      platformId: 'jupiter-exchange',
      value: 11846.98,
      data: {
        borrowedValue: 94496.35,
        suppliedValue: 106343.33,
        value: 11846.98,
        healthRatio: 0.42,
        link: 'https://jup.ag/lend/borrow/68/nfts/273',
        suppliedAssets: [{
          value: 106343.33,
          amount: 100000,
          data: { address: '7GxATsNMnaC88vdwd2t3mwrFuQwwGvmYPrUQ4D6FotXk' },
        }],
        borrowedAssets: [{
          value: 94496.35,
          data: { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
        }],
      },
    },
    new Map([[68, {
      id: 68,
      supplyToken: { uiSymbol: 'JUICED', address: '7GxATsNMnaC88vdwd2t3mwrFuQwwGvmYPrUQ4D6FotXk' },
      borrowToken: { uiSymbol: 'USDC', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
    }]]),
    { '7GxATsNMnaC88vdwd2t3mwrFuQwwGvmYPrUQ4D6FotXk': { symbol: 'JUICED' }, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': { symbol: 'USDC' } },
  );
  assert.equal(portfolioPosWithAmount?.supplied?.[0]?.amount, 100000, 'Portfolio fallback must preserve real API token amount when present');
}

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
  const {
    loopSnapshotPeriodNetApy,
    loopTrimHistoryToLatestSession,
    loopHistoryCapitalEvent,
    MS_PER_DAY,
  } = require('../lib/loop-snapshot-apy.js');
  const now = Date.UTC(2026, 5, 29, 12);
  const before = {
    ts: now - 10 * MS_PER_DAY,
    netValue: 15000,
    netApy: 12,
    totalSupplied: 20000,
    totalBorrowed: 5000,
  };
  const afterWithdraw = {
    ts: now - 2 * MS_PER_DAY,
    netValue: 800,
    netApy: 15.9,
    totalSupplied: 1200,
    totalBorrowed: 400,
  };
  const later = {
    ts: now - MS_PER_DAY,
    netValue: 810,
    netApy: 15.4,
    totalSupplied: 1200,
    totalBorrowed: 400,
  };
  assert.ok(loopHistoryCapitalEvent(before, afterWithdraw), 'large withdraw must count as capital event');
  const beforeMerkl = {
    ts: now - 5 * MS_PER_DAY,
    netValue: 15465,
    positionNetValue: 14800,
    merklRewardsUsd: 665,
    netApy: 12,
    totalSupplied: 20000,
    totalBorrowed: 5000,
  };
  const afterMerklClaim = {
    ts: now - 4 * MS_PER_DAY,
    netValue: 14805,
    positionNetValue: 14800,
    merklRewardsUsd: 5,
    netApy: 12,
    totalSupplied: 20000,
    totalBorrowed: 5000,
  };
  assert.ok(!loopHistoryCapitalEvent(beforeMerkl, afterMerklClaim), 'Merkl claim must not count as capital event when Aave net is stable');
  const trimmedMerkl = loopTrimHistoryToLatestSession([beforeMerkl, afterMerklClaim]);
  assert.equal(trimmedMerkl.length, 2, 'Merkl claim must keep full chart history');
  const trimmed = loopTrimHistoryToLatestSession([before, afterWithdraw, later]);
  assert.equal(trimmed.length, 2, 'history must reset to latest session after withdraw');
  const apy7 = loopSnapshotPeriodNetApy([before, afterWithdraw, later], 7, now);
  assert.ok(apy7 && apy7.apy > 10 && apy7.apy < 20, '7d APY after withdraw must average spot net APY, not treat withdrawal as loss');
  assert.ok(apy7.partial, '7d APY must be partial when latest session is shorter than 7d');
}

{
  const { appendLoopSnapshotStore, loopSnapshotBucketKey, loopPositionHistoryKey, mergeLoopSnapshotStores } = require('../lib/loop-snapshots.js');
  const ts = Date.UTC(2026, 5, 29, 13, 0);
  const data = {
    updatedAt: ts,
    wallets: ['0x07e6ae8F553DC77B8b372e4d20dAb797475E6119'],
    positions: [{ id: 'aave:1', protocol: 'Aave', marketName: 'USDe/USDm', wallet: '0xAbC', chainId: 1, totalBorrowed: 100, netValue: 10, totalSupplied: 110, netApy: 5 }],
  };
  assert.equal(loopSnapshotBucketKey(Date.UTC(2026, 5, 29, 15, 0)), '2026-06-29T14', '2h buckets must floor UTC hours to even boundaries');
  const store = appendLoopSnapshotStore({}, data);
  assert.equal(Object.keys(store).length, 1, 'first loop snapshot must be stored');
  const bucket = Object.keys(store)[0];
  assert.equal(bucket, loopSnapshotBucketKey(Date.now()), 'append must bucket by recording time, not cached updatedAt');
  assert.equal(store[bucket].positions[0].id, 'aave:1');
  assert.equal(store[bucket].positions[0].historyKey, loopPositionHistoryKey(data.positions[0]));
  const store2 = appendLoopSnapshotStore(store, data);
  assert.equal(Object.keys(store2).length, 1, 'same 2h bucket must not duplicate loop snapshots');
  const merged = mergeLoopSnapshotStores({ '2026-06-01T00': { fetchedAt: 1, positions: [] } }, store2);
  assert.ok(Object.keys(merged).length >= 2, 'server merge must keep existing buckets and add new ones');

  const lendingStore = appendLoopSnapshotStore({}, {
    wallets: ['0xabc'],
    positions: [{
      id: 'fluid-lending:0xabc:1:usdc',
      protocol: 'Fluid',
      marketName: 'USDC',
      wallet: '0xabc',
      chainId: 1,
      totalSupplied: 5000,
      totalBorrowed: 0,
      netValue: 5000,
      supplyApy: 4.2,
      netApy: 4.2,
      lendingOnly: true,
    }],
  });
  const lendingBucket = Object.keys(lendingStore)[0];
  assert.equal(lendingStore[lendingBucket].positions.length, 1, 'supply-only lending positions must be snapshotted');
  assert.equal(lendingStore[lendingBucket].positions[0].lendingOnly, true);
  assert.equal(lendingStore[lendingBucket].positions[0].netApy, 4.2);
  assert.equal(
    lendingStore[lendingBucket].positions[0].historyKey,
    'fluid-lending:0xabc:1:usdc',
    'Fluid lending history keys must stay stable',
  );
}

{
  const {
    purgeLoopSnapshotPositions,
    isUsdeUsdmLoopSnapshotPosition,
    ensureUsdeUsdmSnapshotsPurged,
  } = require('../lib/loop-snapshots.js');
  const store = {
    '2026-06-09T00': {
      fetchedAt: 1,
      positions: [
        { protocol: 'Aave', marketName: 'AaveV3MegaETH', chainId: 4326, netValue: 14800, economicNetValue: 15465, merklRewardsUsd: 665 },
        { protocol: 'Jupiter', marketName: 'JUICED / USDC', chainId: 'solana', netValue: 11800, economicNetValue: 11800 },
      ],
    },
    '2026-06-09T02': {
      fetchedAt: 2,
      positions: [
        { protocol: 'Aave', marketName: 'USDe/USDm', chainId: 4326, netValue: 14810, economicNetValue: 15470, merklRewardsUsd: 660 },
      ],
    },
  };
  const { store: cleaned, removedPositions, bucketsAffected } = purgeLoopSnapshotPositions(
    store,
    isUsdeUsdmLoopSnapshotPosition,
  );
  assert.equal(removedPositions, 2, 'USDe/USDm purge must remove inflated Aave MegaETH history');
  assert.equal(bucketsAffected, 2, 'USDe/USDm purge must touch every bucket with that loop');
  assert.equal(cleaned['2026-06-09T00'].positions.length, 1, 'other loop positions must remain in shared buckets');
  assert.equal(cleaned['2026-06-09T00'].positions[0].protocol, 'Jupiter');
  assert.equal(cleaned['2026-06-09T02'], undefined, 'USDe-only buckets must be deleted entirely');

  let flag = '';
  const kv = {
    async get(key) {
      if (key === 'vault:loop_snapshots_usde_usdm_purged') return flag;
      if (key === 'vault:loop_snapshots') return JSON.stringify(store);
      return null;
    },
    async set(key, value) {
      if (key === 'vault:loop_snapshots_usde_usdm_purged') flag = value;
      if (key === 'vault:loop_snapshots') kv.saved = value;
    },
    saved: null,
  };
  const first = await ensureUsdeUsdmSnapshotsPurged({
    kvGet: kv.get,
    kvSet: kv.set,
    parseJson: (raw, fallback) => {
      try { return JSON.parse(raw); } catch { return fallback; }
    },
  });
  assert.equal(first.purged, true);
  assert.equal(first.removedPositions, 2);
  assert.ok(kv.saved, 'one-time purge must rewrite loop snapshot store');
  const second = await ensureUsdeUsdmSnapshotsPurged({
    kvGet: kv.get,
    kvSet: kv.set,
    parseJson: (raw, fallback) => {
      try { return JSON.parse(raw); } catch { return fallback; }
    },
  });
  assert.equal(second.purged, false, 'USDe/USDm purge must run only once server-side');
}

{
  const { loopPositionHistoryKey } = require('../lib/loop-snapshots.js');
  const wallet = '0x523c00000000000000000000000000000000b459';
  const base = {
    protocol: 'Fluid',
    wallet,
    chainId: 1,
    marketName: 'reUSD / USDT',
    totalBorrowed: 100,
    netValue: 4000,
  };
  const vaultA = { ...base, id: 'fluid-vault:0x523c:1:0xvault:17728' };
  const vaultB = { ...base, id: 'fluid-vault:0x523c:1:0xvault:18888' };
  assert.notEqual(loopPositionHistoryKey(vaultA), loopPositionHistoryKey(vaultB), 'Fluid vault NFTs must not share snapshot history keys');
  const lending = {
    protocol: 'Fluid',
    wallet,
    chainId: 1,
    id: 'fluid-lending:0x523c:1:usdc',
    marketName: 'USDC',
  };
  assert.equal(loopPositionHistoryKey(lending), lending.id, 'Fluid lending positions must use stable id history keys');
}

{
  const { merklUnclaimedUsdFromBreakdown, merklUnclaimedUsdFromReward, merklClaimedUsdFromReward } = require('../lib/loop-rates.js');
  const reward = {
    token: { decimals: 18, price: 0.9992442571629646 },
    amount: '700656723548154496240',
    claimed: '595576872317631124641',
    pending: '7573222382594431324',
  };
  const usd = merklUnclaimedUsdFromBreakdown(reward, {
    amount: '135724799652398706003',
    claimed: '30644948421875334404',
  });
  assert.ok(usd > 104 && usd < 106, 'Merkl breakdown unclaimed must use amount minus claimed');
  const rewardUsd = merklUnclaimedUsdFromReward(reward);
  const claimedUsd = merklClaimedUsdFromReward(reward);
  assert.ok(rewardUsd > 104 && rewardUsd < 106, 'Merkl reward unclaimed must match amount minus claimed at reward level');
  assert.ok(claimedUsd > 594 && claimedUsd < 596, 'Merkl claimed must use reward.claimed, not gross amount');
}

{
  const {
    collectLoopLogoTargets,
    tokenLogoKey,
    protocolLogoKey,
    hasEmbeddedLogo,
    GECKO_IDS,
  } = require('../lib/logo-resolver.js');
  const targets = collectLoopLogoTargets([
    {
      protocol: 'Aave',
      supplied: [{ symbol: 'USDe' }],
      borrowed: [{ symbol: 'USDm' }],
    },
  ]);
  const keys = new Set(targets.map(t => t.key));
  const usdeTarget = targets.find(t => t.key === tokenLogoKey('USDE'));
  assert.ok(keys.has(protocolLogoKey('Aave')), 'loop logo resolver must include Aave protocol logos');
  assert.ok(keys.has(protocolLogoKey('Morpho')), 'loop logo resolver must always include Morpho protocol logos');
  assert.ok(keys.has(tokenLogoKey('USDE')), 'loop logo resolver must include supplied token logos');
  assert.ok(keys.has(tokenLogoKey('USDM')), 'loop logo resolver must include borrowed token logos');
  assert.equal(usdeTarget?.kind, 'token', 'loop token logos must resolve as token targets');
  assert.equal(GECKO_IDS.USDE, 'ethena-usde', 'USDe must map to CoinGecko before DeFiLlama fallback');
  assert.equal(GECKO_IDS.USDM, 'mountain-protocol-usdm', 'USDm must map to CoinGecko before DeFiLlama fallback');
  assert.equal(GECKO_IDS.REUSD, 're-protocol-reusd', 'reUSD must map to CoinGecko before DeFiLlama fallback');
  const cached = { [tokenLogoKey('USDE')]: { url: 'data:image/png;base64,abc', ts: 1, source: 'coingecko' } };
  const legacy = { [tokenLogoKey('USDM')]: { url: 'data:image/png;base64,legacy', ts: 1 } };
  assert.ok(hasEmbeddedLogo(cached, tokenLogoKey('USDE')), 'embedded server logos must skip re-fetch');
  assert.ok(!hasEmbeddedLogo(legacy, tokenLogoKey('USDM')), 'legacy logos without source must refresh on next resolve');
}

{
  const { readLocalLoopLogoDataUrl, isLoopPinnedTokenLogo } = require('../lib/logo-resolver.js');
  const { loopTokenLogoDataUrl } = require('../lib/loop-token-logos.js');
  assert.equal(isLoopPinnedTokenLogo('USDm'), true, 'USDm must use the pinned loop logo');
  assert.equal(isLoopPinnedTokenLogo('JUICED'), true, 'JUICED must use the pinned loop logo');
  const usdm = readLocalLoopLogoDataUrl('USDM');
  const juiced = readLocalLoopLogoDataUrl('JUICED');
  assert.equal(usdm, loopTokenLogoDataUrl('USDM'), 'logo resolver must read embedded USDm PNG');
  assert.equal(juiced, loopTokenLogoDataUrl('JUICED'), 'logo resolver must read embedded JUICED PNG');
  assert.ok(usdm?.startsWith('data:image/png;base64,'), 'USDm pinned logo must embed as PNG data URL');
  assert.ok(juiced?.startsWith('data:image/png;base64,'), 'JUICED pinned logo must embed as PNG data URL');
}

assert.match(aaveProxyJs, /ensureLoopLogoCache/, 'loop rates cron must persist embedded logos server-side');
assert.match(syncJs, /logoCache === '1'/, 'sync endpoint must expose server logo cache for loops hydration');
assert.match(syncJs, /geckoSymbolIds === '1'/, 'sync endpoint must expose server gecko symbol ids');
assert.match(syncJs, /mergeGeckoSymbolIds/, 'sync must persist gecko symbol ids for high-value positions');
assert.match(indexHtml, /DEFI_TOKEN_PRICE_REFRESH_MS = 10 \* 60 \* 1000/, 'DeFi live prices must refresh every 10 minutes');
assert.match(indexHtml, /LOOPS_TOKEN_PRICE_REFRESH_MS = 60 \* 60 \* 1000/, 'Loops live prices must refresh every 1 hour');
assert.match(indexHtml, /function symbolExposureUsd\(sym\)/, 'gecko server save must gate on position exposure');
assert.match(indexHtml, /persistServerGeckoSymbolId/, 'resolved gecko ids must persist server-side for large positions');
assert.match(indexHtml, /warnEl\.textContent = _perpsRefreshError/, 'perps API failures must show under Updated timestamp');
assert.match(indexHtml, /function makeLoopLogo\(symbol, isProtocol/, 'loops tab must render logos from server cache only');
assert.match(indexHtml, /makeLoopLogo\(symbol, false, size\)/, 'loop token logos must read server-cached images via makeLoopLogo');
const logoResolverJs = readFileSync(join(ROOT, 'lib', 'logo-resolver.js'), 'utf8');
assert.match(logoResolverJs, /async function coingeckoImageUrlForSymbol\(/, 'token logos must try CoinGecko first on the server');
assert.match(logoResolverJs, /async function resolveTokenLogoDataUrl\(/, 'token logos must fall back to DeFiLlama after CoinGecko');
assert.match(logoResolverJs, /readLocalLoopLogoDataUrl/, 'loop logos must support pinned USDm and JUICED assets');
assert.match(indexHtml, /lib\/loop-token-logos\.js/, 'loops tab must load embedded USDm and JUICED logo data URLs');
assert.match(indexHtml, /loopTokenLogoDataUrl\(sym\)/, 'loops tab must prefer pinned USDm and JUICED logos');
assert.match(indexHtml, /perpsPriceRiskStyle\(currentPx, tp\)/, 'TP rows must use distance-based risk color like liq price');
assert.match(logoResolverJs, /hasEmbeddedLogo\(next, target\.key\)/, 'resolved token logos must persist server-side without re-fetching');
assert.match(logoResolverJs, /resolveTokenLogoDataUrl\(target\.symbol, next\)/, 'token logo resolve must read server cache before CoinGecko');
assert.doesNotMatch(logoResolverJs, /isLoopPinnedTokenLogo\(target\.symbol\)/, 'pinned loop logos must not force CoinGecko re-fetch when cached');
assert.match(logoResolverJs, /fetchCoinGeckoWithFailover/, 'logo resolver must failover across CoinGecko keys');
assert.match(readFileSync(join(ROOT, 'api', 'prices.js'), 'utf8'), /fetchCoinGeckoWithFailover/, 'prices proxy must failover across CoinGecko keys');

{
  const { coinGeckoApiKeys, isRateLimitedResponse } = require('../lib/coingecko-fetch.js');
  const prevA = process.env.COINGECKO_API_KEY;
  const prevB = process.env.COINGECKO_API_KEY1;
  process.env.COINGECKO_API_KEY = 'primary-key';
  process.env.COINGECKO_API_KEY1 = 'backup-key';
  assert.deepEqual(coinGeckoApiKeys(), ['primary-key', 'backup-key'], 'CoinGecko must read primary then COINGECKO_API_KEY1 backup');
  assert.equal(isRateLimitedResponse(429, {}), true, 'HTTP 429 must trigger key failover');
  assert.equal(isRateLimitedResponse(403, { status: { error_message: 'Monthly credit limit exceeded' } }), true);
  process.env.COINGECKO_API_KEY = prevA;
  process.env.COINGECKO_API_KEY1 = prevB;
}

{
  const { officialLoopPageUrl } = require('../lib/loop-official-urls.js');
  const aave = officialLoopPageUrl({
    protocol: 'Aave',
    marketName: 'AaveV3Base',
    chainId: 8453,
  });
  assert.match(aave, /^https:\/\/app\.aave\.com\/markets\/\?marketName=proto_base_v3$/, 'Aave loops must deep-link to the chain market');
  const morpho = officialLoopPageUrl({
    protocol: 'Morpho',
    chainId: 8453,
    marketId: '0xabc',
    vaultOnly: false,
  });
  assert.equal(morpho, 'https://app.morpho.org/base/market/0xabc', 'Morpho borrow loops must deep-link to the market page');
  const fluid = officialLoopPageUrl({
    protocol: 'Fluid',
    chainId: 1,
    totalBorrowed: 1000,
  });
  assert.equal(fluid, 'https://fluid.io/borrow/1', 'Fluid borrow loops must deep-link to borrow UI');
}


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

{
  function parseBucketTime(key) {
    if (!key) return 0;
    if (String(key).includes('T')) return Date.parse(`${key}:00:00.000Z`) || 0;
    return Date.parse(key) || 0;
  }
  function isEquityCapitalPayment(p) {
    if (!p || !Number.isFinite(p.time) || !Number.isFinite(p.usdc) || p.usdc === 0) return false;
    const kind = String(p.kind || '').toLowerCase();
    return kind.includes('deposit') || kind.includes('withdraw') || kind.includes('transfer');
  }
  function lastCapitalEventMs(data) {
    const cf = data?.capitalFlows || {};
    const payments = [
      ...(cf.hl?.payments || []),
      ...(cf.nado?.payments || []),
      ...(cf.grvt?.payments || []),
      ...(cf.extended?.payments || []),
    ].filter(isEquityCapitalPayment).sort((a, b) => a.time - b.time);
    return payments.length ? payments[payments.length - 1].time : 0;
  }

  const t0 = Date.UTC(2026, 5, 1, 8);
  const t1 = Date.UTC(2026, 5, 5, 12);
  const t2 = Date.UTC(2026, 5, 6, 8);
  const t3 = Date.UTC(2026, 5, 7, 8);
  const points = [
    { bucket: '2026-06-01T08', time: t0, totalEquity: 10000 },
    { bucket: '2026-06-05T12', time: t1, totalEquity: 15000 },
    { bucket: '2026-06-06T08', time: t2, totalEquity: 15200 },
    { bucket: '2026-06-07T08', time: t3, totalEquity: 15500 },
  ];
  const data = {
    capitalFlows: {
      hl: { payments: [{ time: t1, kind: 'deposit', usdc: 5000 }] },
      nado: { payments: [] },
    },
  };
  const sessionMs = lastCapitalEventMs(data);
  const sessionPoints = points.filter(p => parseBucketTime(p.bucket) >= sessionMs);
  assert.equal(sessionPoints.length, 3, 'last session must keep equity points after the latest capital event');
  assert.equal(sessionPoints[0].totalEquity, 15000, 'session chart must start at post-deposit equity');
  assert.equal(sessionPoints.at(-1).totalEquity, 15500, 'session chart must end at latest equity');
  assert.ok(sessionPoints.every(p => p.totalEquity > 0), 'session chart must plot equity values, not PnL');
}

assert.match(indexHtml, /if \(store\[bucket\]\) \{[\s\S]*?variationalEquityAdjust/, 'browser snapshots must patch variational fields into existing cron buckets');
assert.match(indexHtml, /if \(!perpsIsEquitySnapshotEligible\(data\)\) return false;/, 'browser snapshots must reject incomplete reads');
assert.match(aaveProxyJs, /portfolio\?\.perpsArb/, 'cron snapshots must recover wallet config from the saved portfolio');
assert.match(aaveProxyJs, /kvSet\('vault:perps_config'/, 'cron snapshots must persist recovered wallet config');
assert.match(aaveProxyJs, /fetchPerpsEquitySnapshotWithVariational\(\{/, 'cron snapshots must sample balances and compute variational adjust');
assert.doesNotMatch(aaveProxyJs.slice(aaveProxyJs.indexOf('async function handlePerpsCronSnapshot'), aaveProxyJs.indexOf('async function handlePerps(req')), /fetchPerpsDashboard\(\{/, 'cron snapshots must not run the heavy dashboard pipeline');
assert.match(perpsJs, /equitySampleMode: 'concurrent_balance_only'/, 'balance-only snapshots must identify their sampling mode');
assert.match(perpsJs, /await Promise\.all\(\[\s*fetchHyperliquidEquity/, 'venue equity endpoints must be sampled concurrently');
assert.match(syncJs, /const savedConfig = parseJson\(await kvGet\('vault:perps_config'\), \{\}\);/, 'fast config endpoint must use the initialized parser');
assert.doesNotMatch(syncJs, /const perpsConfig = parse\(await kvGet\('vault:perps_config'\), \{\}\);/, 'fast config endpoint must not call a parser before initialization');
assert.match(syncJs, /req\.query\?\.perpsSnapshots === '1'/, 'sync endpoint must expose lightweight Perps snapshot hydration');
assert.match(syncJs, /req\.query\?\.perpsAux === '1'/, 'sync endpoint must expose combined Perps aux hydration');
assert.match(syncJs, /vault:perps_variational_hedges/, 'sync must persist Variational hedges server-side');
assert.match(syncJs, /vault:perps_closed_pairs/, 'sync must persist closed Perps pairs server-side');
assert.match(syncJs, /mergeVariationalHedgeRows/, 'sync must merge Variational hedges instead of overwriting with empty');
assert.match(syncJs, /portfolio\?\.perpsArb\?\.variationalHedges/, 'portfolio sync must extract Variational hedges to server KV');
assert.match(indexHtml, /function perpsImportVariationalHedgesFromPortfolio\(/, 'Perps must import Variational hedges from synced portfolio');
assert.match(indexHtml, /function perpsPushVariationalHedgesToServer\(/, 'Perps must push local hedges to server when server copy is missing');
assert.match(indexHtml, /variationalHedges/, 'portfolio perpsArb must carry Variational hedges for cross-device sync');
assert.match(indexHtml, /await perpsHydratePerpsAuxFromCloud\(\)/, 'Perps refresh must hydrate server aux before rendering');
assert.match(indexHtml, /function perpsMergeEquitySnapshotRecord\(/, 'equity snapshots must merge variational fields per bucket');
assert.match(indexHtml, /function perpsSnapshotVariationalAdjust\(/, 'equity series must resolve snapshot variational adjust from components');
assert.match(indexHtml, /variationalPendingCloseEquityAdjust/, 'equity snapshots must persist pending-close variational adjust');
assert.match(perpsJs, /fetchPerpsEquitySnapshotWithVariational/, 'cron snapshots must compute variational equity adjust server-side');
assert.match(perpsJs, /variationalEquityAdjust: record\.variationalEquityAdjust/, 'equity snapshot records must store variational adjust');
assert.match(indexHtml, /<g id="perpsEquityPoints"><\/g>/, 'equity chart must render visible sampled-point markers');
assert.match(indexHtml, /data-perps-equity-mode="session"/, 'equity chart must default to last-session mode');
assert.match(indexHtml, /function perpsLastCapitalEventMs\(/, 'equity chart session mode must detect last capital flow');
assert.match(indexHtml, /function perpsApplyEquityChartMode\(/, 'equity chart must filter snapshots by chart mode');
assert.match(indexHtml, /function perpsEquityPointChartValue\(/, 'equity chart must support hedge-neutral and exchange value modes');
assert.match(indexHtml, /variationalNeutralEquity/, 'equity series must carry hedge-neutral values');
assert.match(indexHtml, /variationalEquityAdjust:/, 'equity snapshots must persist variational hedge adjustment');
assert.match(indexHtml, /data-perps-equity-value-mode="neutral"/, 'equity chart must default to hedge-neutral mode');
assert.doesNotMatch(indexHtml, /chartKind: 'pnl'/, 'equity chart must not plot PnL values');
assert.match(indexHtml, /\.perps-chart-tooltip \{[\s\S]*?position:fixed/, 'equity chart tooltip must use fixed positioning so it is not clipped');
assert.match(indexHtml, /const bucketLabel = hit\.bucket === 'live'/, 'equity chart hover must label the active snapshot bucket');
assert.match(indexHtml, /perpsPositionFundChartTooltip\(ev, tip\)/, 'equity chart tooltip must flip near viewport edges');
assert.match(indexHtml, /perpsPairDisplayLegEntries\(p\)/, 'position cards must order exchange labels with the long leg first');
assert.match(indexHtml, /perpsVenueWithSideHtml\(entry\.venue, entry\.leg\.size\)/, 'exchange labels must show long/short badges in position cards');
assert.match(indexHtml, /perpsSetPositionsTab\('closed'/, 'Positions panel must expose a Closed tab');
assert.match(indexHtml, /function perpsRenderClosedPositions\(closedPairs\)/, 'Closed tab must render fully closed position rounds');
assert.match(indexHtml, /perps-pos-head closed[\s\S]{0,180}<div>APR<\/div>/, 'Closed tab must show APR column beside Net PnL');
assert.match(indexHtml, /function perpsClosedPairSessionDays\(/, 'closed APR must use latest performance session day span');
assert.match(indexHtml, /perpsClosedPairSessionApr\(pair\)/, 'Closed tab must show session APR under Net PnL');
assert.match(indexHtml, /perps-pos-closed-cell/, 'Closed tab rows must align values under headers without duplicate labels');
assert.match(indexHtml, /function perpsNormalizeClosedPairForDisplay\(pair\)/, 'Closed tab must recompute APR from margin and session days at render time');
assert.match(perpsJs, /function closedPairSessionApr\(/, 'closed pairs must compute session APR server-side');
assert.match(indexHtml, /pair\.closeSlippage/, 'Closed tab must show closing slippage separately');
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
assert.match(indexHtml, /perpsPairPeriodApr\(p, _perpsStatRange\)/, 'positions table Net APR must follow the selected stat range within the latest session');
assert.match(indexHtml, /perpsBuildNetAprTooltipHtml\(p, range = _perpsStatRange\)/, 'Net APR tooltip must explain the selected stat window');
assert.doesNotMatch(indexHtml, /perpsPairSessionApr\(p\)/, 'positions table Net APR must not ignore the stat range selector');
assert.match(indexHtml, /const PERPS_REFRESH_RETRIES = 1;/, 'Perps dashboard load must retry transient API failures once');
assert.match(indexHtml, /function perpsDashboardLoadWarnings\(payload\)/, 'Perps dashboard must inspect partial NADO failures before rendering');
assert.match(indexHtml, /perpsFetchDashboardPayload\(params, silent\)/, 'Perps refresh must use the retrying dashboard fetch helper');
assert.match(indexHtml, /summary\?\.nadoError/, 'Perps alert bar must surface persistent NADO API failures');
assert.match(perpsJs, /rows\.error = errorMessage\(e\);/, 'NADO rate failures must be reported instead of silently returning empty rates');
assert.match(perpsJs, /nadoError: combineErrors\(nadoState, nadoFundingForAnalysis, nadoMatchesForAnalysis, nadoCapitalFlows, \{ error: nadoRates\.error \}\)/, 'Dashboard summary must include NADO rates/funding failures');
assert.match(indexHtml, /perpsSideBadgeHtml\(legs\.a\.size\)/, 'paired table legs must include long/short badges');
assert.match(indexHtml, /perpsVenueWithSideHtml\(u\.venue, u\.size\)/, 'unhedged exchange rows must include long/short badges');
assert.match(indexHtml, /<div>Liq Price<\/div>/, 'open positions must show a liquidation-price-only column');
assert.match(indexHtml, /<div>TP\/SL<\/div>/, 'open positions must show a TP/SL column after Liq Price');
assert.doesNotMatch(indexHtml, /<div>Basis uPnL<\/div>/, 'open positions must not show Basis uPnL column');
assert.match(indexHtml, /function perpsPositionLiqStackHtml\(p, displayLegs\)/, 'open positions must render only liquidation prices in the Liq Price column');
assert.match(indexHtml, /function perpsFmtTpSlStackHtml\(tpPx, slPx, currentPx, legCtx = \{\}\)/, 'open positions must render TP above SL vertically');
assert.match(indexHtml, /perpsPriceRiskStyle\(currentPx, tp\)/, 'TP rows must use the same distance-based risk color as liq price');
assert.match(indexHtml, /perpsPriceRiskStyle\(currentPx, sl\)/, 'SL rows must use the same distance-based risk color as liq price');
assert.match(indexHtml, /function perpsPositionTpSlStackHtml\(p, displayLegs\)/, 'open positions must collapse common TP/SL across venues');
assert.match(indexHtml, /function perpsComparableTpSlLegs\(displayLegs\)/, 'TP/SL mismatch must ignore Nado legs');
assert.match(indexHtml, /venue !== 'nado'/, 'TP/SL mismatch must exclude Nado from cross-venue comparison');
assert.match(indexHtml, /perps-pos-tpsl-warn.*Mismatch/, 'open positions must warn when TP/SL differ across venues');
assert.match(indexHtml, /function perpsSlLiqProximityWarn\(/, 'open positions must warn when SL is too close to liquidation');
assert.match(indexHtml, /perps-pos-sl-liq-warn/, 'SL near liquidation must use a visible warning style');
assert.match(indexHtml, /perpsSlLiqProximityWarn\(side, sl, legCtx\.liquidationPx\)/, 'TP/SL stack must compare SL against leg liquidation price');
assert.match(indexHtml, /PERPS_TPSL_HEDGE_CLOSE_PCT = 1/, 'hedged TP/SL merge must use a 1% threshold');
assert.match(indexHtml, /function perpsTpSlHedgePairAnalysis\(/, 'TP/SL must compare long TP vs short SL (hedge pairs)');
assert.match(indexHtml, /perps-tpsl-tooltip/, 'TP/SL hover must show per-exchange TP and SL');
assert.match(indexHtml, /approxTp: analysis\.tp\.kind === 'merged'/, 'merged hedge TP must show ~ prefix on averaged price');
assert.match(indexHtml, /function perpsPositionMidPx\(p, displayLegs\)/, 'open positions must calculate a mid price from both exchange marks');
assert.ok(indexHtml.includes('<span class="perps-pos-live-px">${perpsFmtPx(midPx)}</span>'), 'open positions must show live price next to OPEN without a mid pill');
assert.doesNotMatch(indexHtml, /perps-pos-mid-pill/, 'open positions must not wrap live price in a mid pill');
assert.doesNotMatch(indexHtml, /<div>Price \/ Liq<\/div>/, 'old Price / Liq header must be removed');
assert.doesNotMatch(indexHtml, /perps-pos-price-label">Px/, 'Liq Price column must not show current price labels');
assert.match(indexHtml, /function perpsLiquidationRiskStyle\(currentPx, liquidationPx\)/, 'liquidation prices must use shared perpsPriceRiskStyle');
assert.match(indexHtml, /function perpsPriceRiskStyle\(currentPx, levelPx\)/, 'liq and TP/SL must share asymmetric distance-based risk coloring');
assert.match(indexHtml, /PERPS_RISK_START_PCT_UP = 58\.3/, 'upside risk tint must start within 58.3 percent of mark');
assert.match(indexHtml, /PERPS_RISK_START_PCT_DOWN = 50/, 'downside risk tint must start within 50 percent of mark');
assert.match(indexHtml, /if \(distancePct <= PERPS_RISK_FULL_PCT\) return 1/, 'risk color must reach max red at 20 percent from mark');
assert.match(perpsJs, /function perpsPriceRiskLevel\(/, 'perps risk coloring must be shared in lib/perps.js');
assert.match(perpsJs, /PERPS_RISK_START_PCT_UP = 58\.3/, 'shared perps risk module must use 58.3 percent upside threshold');
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
assert.match(perpsJs, /type: 'frontendOpenOrders'/, 'Hyperliquid state must fetch position TP/SL from frontendOpenOrders');
assert.match(perpsJs, /grvtTradesPost\('open_orders'/, 'GRVT state must fetch TP/SL trigger orders from open_orders');
assert.match(perpsJs, /metadata\.trigger \?\? metadata\.t/, 'GRVT TP/SL parser must read trigger metadata from order.metadata');
assert.match(perpsJs, /function enrichGrvtStateWithTpsl\(/, 'GRVT fallback state must still attach TP/SL from open_orders');
assert.match(perpsJs, /tpPx: tpslPxFrom\(p\.tpTriggerPrice\)/, 'Extended positions must map API tpTriggerPrice');
assert.match(perpsJs, /slPx: tpslPxFrom\(p\.slTriggerPrice\)/, 'Extended positions must map API slTriggerPrice');
assert.doesNotMatch(perpsJs, /NADO TP\/SL unavailable/, 'NADO TP/SL lookup is skipped silently');
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
assert.match(indexHtml, /function predictionPositionSearchQuery\(/, 'Prediction Markets search must use a dedicated query helper');
assert.match(indexHtml, /id="predPositionSearch"/, 'Prediction Markets search input must use a unique id');
assert.doesNotMatch(indexHtml, /id="pmPositionSearch"/, 'Prediction Markets search must not share pmPositionSearch with hidden DeFi markup');
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

  const hlTpsl = parseHyperliquidTpslOrders([
    { coin: 'BTC', isPositionTpsl: true, orderType: 'Take Profit Market', triggerPx: '70000' },
    { coin: 'BTC', isPositionTpsl: true, orderType: 'Stop Market', triggerPx: '60000' },
  ]);
  assert.equal(hlTpsl.get('BTC')?.tpPx, 70000, 'Hyperliquid TP/SL parser must read position TP orders');
  assert.equal(hlTpsl.get('BTC')?.slPx, 60000, 'Hyperliquid TP/SL parser must read position SL orders');

  const grvtTpsl = parseGrvtTpslOrders({
    result: [{
      l: [{ i: 'BTC_USDT_Perp' }],
      m: { t: { tt: 1, t: { tp: '70000000000' } } },
    }, {
      l: [{ i: 'BTC_USDT_Perp' }],
      m: { t: { tt: 2, t: { tp: '60000000000' } } },
    }],
  });
  assert.equal(grvtTpsl.get('BTC')?.tpPx, 70, 'GRVT TP/SL parser must decode metadata.trigger prices');
  assert.equal(grvtTpsl.get('BTC')?.slPx, 60, 'GRVT TP/SL parser must decode stop-loss triggers from order metadata');

  const { normalizeGrvtOrderRow } = require('../lib/perps.js');
  const normalized = normalizeGrvtOrderRow({
    l: [{ i: 'ETH_USDT_Perp' }],
    m: { trigger: { trigger_type: 'TAKE_PROFIT', tpsl: { trigger_price: '3500000000000' } } },
  });
  assert.equal(normalized.trigger?.trigger_type, 'TAKE_PROFIT', 'GRVT order normalization must read full-format metadata.trigger');

  const nadoTp = classifyNadoTriggerSide({
    price_trigger: { price_requirement: { oracle_price_above: String(70_000 * 1e18) } },
  }, 1);
  assert.equal(nadoTp?.kind, 'tp', 'NADO trigger classifier must map above-oracle triggers to TP on longs');
  const nadoSl = classifyNadoTriggerSide({
    price_trigger: { price_requirement: { oracle_price_below: String(60_000 * 1e18) } },
  }, 1);
  assert.equal(nadoSl?.kind, 'sl', 'NADO trigger classifier must map below-oracle triggers to SL on longs');

  assert.equal(perpsTpslMismatch([
    { size: 1, tpPx: 100, slPx: 90 },
    { size: -1, tpPx: 90.2, slPx: 100.4 },
  ]), false, 'hedged TP/SL within 1% must not mismatch (long TP vs short SL)');
  assert.equal(perpsTpslMismatch([
    { size: 1, tpPx: 100, slPx: 90 },
    { size: -1, tpPx: 88, slPx: 102 },
  ]), true, 'hedged TP pair must mismatch when long TP vs short SL differ > 1%');

  const grvtLiq = liquidationPriceFrom(normalizeGrvtPositionRow({
    i: 'IP_USDT_Perp',
    el: '287500000',
  }), v => (Number(v) >= 1e6 ? Number(v) / 1e9 : Number(v)));
  assert.ok(grvtLiq > 0 && grvtLiq < 0.5, 'GRVT must use API est_liquidation_price when provided');
  assert.equal(liquidationPriceFrom(normalizeGrvtPositionRow({ i: 'IP_USDT_Perp', s: '44000' })), null, 'GRVT must show no liquidation when API omits el');
}

{
  const { perpsPriceRiskLevel, perpsPriceRiskStyle } = require('../lib/perps.js');
  const mark = 0.36;

  assert.equal(perpsPriceRiskLevel(mark, 0.57), 0, 'ONDO short SL at 0.57 must stay neutral at 58.3% upside distance');
  assert.ok(perpsPriceRiskLevel(mark, 0.569) > 0, 'upside levels just inside 58.3% must start tinting red');
  assert.equal(perpsPriceRiskLevel(mark, 0.432), 1, 'upside levels at 20% distance must be full red');
  assert.equal(perpsPriceRiskLevel(mark, 0.18), 0, 'downside levels at 50% distance must stay neutral');
  assert.ok(perpsPriceRiskLevel(mark, 0.20) > 0, 'downside levels inside 50% must start tinting red');
  assert.ok(perpsPriceRiskLevel(mark, 0.287) >= 0.99, 'downside levels at 20% distance must be full red');
  assert.equal(perpsPriceRiskStyle(mark, 0.57), '', 'neutral upside levels must not emit inline style');
  assert.match(perpsPriceRiskStyle(mark, 0.40), /color:rgb\(255,/, 'warned upside levels must emit red-tint inline style');
}

{
  const { perpsSlLiqProximityWarn } = require('../lib/perps.js');
  const liq = 100;

  assert.equal(perpsSlLiqProximityWarn('short', 105, liq), true, 'short SL above liq must warn');
  assert.equal(perpsSlLiqProximityWarn('short', 100, liq), true, 'short SL at liq must warn');
  assert.equal(perpsSlLiqProximityWarn('short', 99, liq), true, 'short SL within 2% below liq must warn');
  assert.equal(perpsSlLiqProximityWarn('short', 97, liq), false, 'short SL more than 2% below liq must not warn');
  assert.equal(perpsSlLiqProximityWarn('long', 95, liq), true, 'long SL below liq must warn');
  assert.equal(perpsSlLiqProximityWarn('long', 100, liq), true, 'long SL at liq must warn');
  assert.equal(perpsSlLiqProximityWarn('long', 101, liq), true, 'long SL within 2% above liq must warn');
  assert.equal(perpsSlLiqProximityWarn('long', 103, liq), false, 'long SL more than 2% above liq must not warn');
  assert.equal(perpsSlLiqProximityWarn('long', 105, null), false, 'missing liq must not warn');
}

{
  const merged = mergeNadoMatches(
    { wallet: '0x1', subaccount: 's', days: 30, matches: [{ submissionIdx: '1', symbol: 'ONDO', time: 1, fee: 1, realizedPnl: 2 }] },
    { wallet: '0x1', subaccount: 's', days: 30, matches: [{ submissionIdx: '2', symbol: 'MEGA', time: 2, fee: 3, realizedPnl: 4 }] },
  );
  assert.equal(merged.matches.length, 2, 'inactive-symbol Nado history must merge with active-symbol matches');
  assert.equal(merged.totalFees, 4);
}

assert.match(readFileSync(join(ROOT, 'lib/protocol-apr.js'), 'utf8'), /const PROTO_APR_FLOOR_HOURS = 24;/, 'protocol APR must floor short gaps to 24 hours');
assert.match(readFileSync(join(ROOT, 'lib/protocol-apr.js'), 'utf8'), /const PROTO_APR_EXACT_AFTER_HOURS = 8;/, 'protocol APR must use exact elapsed time once imports are 8h or more apart');
assert.match(indexHtml, /function protocolAprDaysDiff\(baselineTs, newerTs\)/, 'protocol APR must branch between 24h floor and exact elapsed time');
assert.ok(indexHtml.includes('lib/protocol-apr.js'), 'index must load protocol APR helpers');
assert.ok(indexHtml.includes('ProtocolApr.calcPositionAprFromValues'), 'calcPositionAPR must treat equal import values as 0% APR');
assert.match(readFileSync(join(ROOT, 'lib/protocol-apr.js'), 'utf8'), /const PROTO_APR_MAX_ABS = 80;/, 'protocol APR must hide rates at or above 80%');
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
assert.match(indexHtml, /const PROTO_STABLE_PEG_MIN = 0\.998;/, 'stable $1 peg must start at 0.998 unit price');
assert.match(indexHtml, /const PROTO_STABLE_PEG_MAX = 1\.004;/, 'stable $1 peg must end at 1.004 unit price');
assert.match(indexHtml, /function protocolTokenDisplayText\(pos, tokenText, unitPrices = null\)/, 'pegged tokens must display amount without symbol');
assert.match(indexHtml, /function protocolImportPositionMap\(entry\)/, 'protocol APR must resolve snapshot position maps from import history');
assert.match(indexHtml, /unitPrices/, 'protocol imports must freeze CoinGecko unit prices at import time');
assert.match(indexHtml, /if \(entry\.positions && typeof entry\.positions === 'object'\) return entry\.positions;/, 'snapshot APR must use frozen position values when available');
assert.match(indexHtml, /function protocolTokenCoingeckoUnitPrice\(pos, unitPrices = null\)/, 'protocol positions must value legs from CoinGecko with optional frozen import map');
assert.match(indexHtml, /fetchLiveTokenPrices\(\{ force: true \}\)/, 'protocol prices must prefetch on load');
assert.match(indexHtml, /let _fetchLiveTokenPricesPromise = null/, 'price fetch must dedupe in-flight requests');
assert.match(indexHtml, /async function resolveGeckoIdsForSymbols\(symbols, \{ concurrency = 3 \} = \{\}\)/, 'gecko resolve must be concurrency-limited');
assert.match(indexHtml, /let livePrices = \{\}/, 'livePrices must be initialized before protocol valuation helpers');

{
  const failed = {
    venue: 'grvt',
    subAccountId: '4860249204328359',
    configured: true,
    exists: false,
    accountValue: 0,
    positions: [],
    error: 'Access from this location is not allowed',
  };
  const override = parseGrvtPositionsOverride([
    { venue: 'grvt', symbol: 'IP', size: 44000, side: 'long', notional: 14142 },
  ]);
  const restored = applyGrvtStateFallback(failed, { positions: override, fetchedAt: Date.now() }, 'browser-cache');
  assert.equal(restored.positions.length, 1, 'GRVT fallback must restore cached positions');
  assert.equal(restored.staleSource, 'browser-cache');
  const hlLeg = { symbol: 'IP', size: -44000, side: 'short' };
  const grvtLeg = restored.positions[0];
  assert.equal(hlLeg.side, 'short');
  assert.equal(grvtLeg.side, 'long');
}

assert.match(perpsJs, /grvt-proxy/, 'GRVT fetches must use EU egress resolver');
assert.match(perpsJs, /grvtEgressRegion/, 'perps summary must expose GRVT egress region');
assert.match(vercelJson, /"api\/aave-proxy\.js"[\s\S]*?"regions":\s*\[\s*"fra1"\s*\]/, 'perps handler must run in fra1 (Germany)');
assert.match(perpsJs, /resolveGrvtStateWithFallback/, 'GRVT must resolve positions from cache when live API fails');
assert.match(perpsJs, /vault:grvt_state:/, 'GRVT positions must persist in KV for geo-block fallback');
assert.match(aaveProxyJs, /grvtPositionsOverride/, 'perps API must accept browser GRVT position cache');
assert.match(syncJs, /grvtStateCache/, 'sync API must accept GRVT state cache uploads');
assert.match(indexHtml, /PERPS_GRVT_STATE_CACHE_KEY/, 'browser must cache last-known GRVT positions');
assert.match(indexHtml, /grvtPositions/, 'perps refresh must send cached GRVT positions to the server');

assert.equal(perpHedgedSizesExactMatch(-44000, 44000), true, 'opposite-side legs with equal abs size must match');
assert.equal(perpHedgedSizesExactMatch(44000, 43999), false, 'any hedged size difference must fail exact match');
assert.match(perpsJs, /!perpHedgedSizesExactMatch/, 'paired hedges must alert on non-exact sizes');
assert.match(indexHtml, /perpsPairHasSizeMismatch/, 'perps UI must detect hedged size mismatch');
assert.match(indexHtml, /variationalPairHasSizeMismatch/, 'size mismatch must compare live variational vs exchange legs');
assert.match(indexHtml, /resolveVariationalSizesOnEntryEdit/, 'entry edit must resolve variational fill size from explicit input or live exchange leg');
assert.match(indexHtml, /perpsVariationalSizeInput/, 'variational entry modal must expose fill size when editing an open hedge');
assert.match(indexHtml, /function perpsMergeVariationalHedgeRecord\(/, 'variational hedge merge must prefer newer local fill sizes');
assert.match(indexHtml, /perps-pos-size-warn/, 'perps position cards must show size mismatch warning');

assert.match(indexHtml, /function dashWalletSuffix4\(/, 'order fills must expose wallet suffix helper');
assert.match(indexHtml, /function orderFilledEventText\(/, 'order fills must share event text formatter');
assert.match(indexHtml, /dashWalletSuffix4\(g\.wallet\)/, 'order filled text must append wallet suffix');
assert.match(indexHtml, /function orderFilledPulseItem\(/, 'market pulse must build order filled cards from event log logic');
assert.match(indexHtml, /function pmPriceMovePulseItem\(/, 'market pulse must build PM price move cards from event log logic');
assert.doesNotMatch(indexHtml, /\.\.\._predictionWalletCards/, 'market pulse must not merge watched wallet cards');
assert.match(indexHtml, /CLOUD_SYNC_TIMEOUT_MS = 35000/, 'cloud sync must allow enough time for large portfolio payload');
assert.match(indexHtml, /EVENT_LOG_WALLET_SUFFIX/, 'order fills must support custom wallet suffix labels');
assert.match(eventLogJs, /WALLET_SUFFIX_OVERRIDES/, 'server event log must support custom wallet suffix labels');
assert.match(eventLogJs, /walletSuffix4\(g\.wallet\)/, 'server event log must append wallet suffix to order fills');

{
  const { walletSuffix4 } = require('../lib/event-log.js');
  assert.equal(walletSuffix4('0x2Ec0aa99D26b703585f58bdEd217a640d09e976b'), ' (6119)');
  assert.equal(walletSuffix4('0x553a95b3c1B474D6C4b2B48772A8152c25F3177f'), ' (1240)');
  assert.equal(walletSuffix4('0x975ad39760B5e113229888d2b0FA90fD9111359a'), ' (e480)');
  assert.equal(walletSuffix4('0x1234567890abcdef1234567890abcdef12345678'), ' (5678)');
}

try {
  const loopResult = await fetchLoopRates(['0x523c4fD04438aAB5e96CADCcDC92c855390Fb459']);
  for (const p of loopResult.positions || []) {
    const supplied = Number(p.totalSupplied || 0);
    const borrowed = Number(p.totalBorrowed || 0);
    const net = Number(p.netValue || 0);
    assert.ok(Math.abs(supplied - borrowed - net) < 0.05, `loop netValue must equal supplied-borrowed for ${p.id || p.marketName}`);
    const merkl = Number(p.merklRewardsUsd || 0);
    if (merkl > 0.01 && p.economicNetValue != null) {
      assert.ok(Math.abs(net + merkl - Number(p.economicNetValue)) < 0.05, `economicNetValue must include Merkl for ${p.id || p.marketName}`);
    }
  }
} catch (e) {
  throw new Error(`loop net value live check failed: ${e.message || e}`);
}

const {
  parseVariationalListing,
  parseVariationalListings,
  createHedgeFromUnhedged,
  applyVariationalHedges,
  stripVariationalPairs,
  dedupeActiveVariationalHedges,
  buildVariationalOpenPair,
  buildVariationalClosedPair,
  estimateVariationalFundingUsd,
  buildVariationalFundingEventsAligned,
  buildVariationalFundingEventsScheduled,
  variationalNextFundingAtMs,
  variationalHedgeOpenedAtMs,
  variationalLegPnl,
} = require('../lib/variational-hedge.js');
const { buildRateSpreadRows, fetchVariationalRates } = require('../lib/perps.js');

{
  const listing = parseVariationalListing({
    ticker: 'BTC',
    mark_price: '100000',
    funding_rate: '0.1095',
    funding_interval_s: 28800,
  });
  assert.equal(listing.symbol, 'BTC');
  assert.equal(listing.fundingRateAnnual, 0.1095);
  assert.ok(Math.abs(listing.fundingRate8h - 0.1095 / 1095) < 1e-12, 'annual Variational rate must normalize to 8h equivalent');
  assert.ok(Math.abs(listing.fundingRateInterval - 0.1095 / 1095) < 1e-12, 'annual Variational rate must normalize to native interval');
  assert.equal(listing.markPx, 100000);
}

{
  const listing = parseVariationalListing({
    ticker: 'XLM',
    mark_price: '0.21675',
    funding_rate: '0.1095',
    funding_interval_s: 28800,
  });
  const annualApr = listing.fundingRateAnnual * 100;
  assert.ok(Math.abs(annualApr - 10.95) < 0.01, 'Variational stats funding_rate must be treated as annual APY');
  assert.ok(listing.fundingRate8h * 3 * 365 * 100 < 200, '8h-normalized Variational rate must not explode Current APR');
}

{
  const hedge = createHedgeFromUnhedged({
    symbol: 'ETH',
    venue: 'extended',
    size: 2.5,
    side: 'long',
  }, 3200);
  assert.equal(hedge.variationalSize, -2.5);
  assert.equal(hedge.trackedVenue, 'extended');
  const data = {
    paired: [],
    unhedged: [{ symbol: 'ETH', venue: 'extended', size: 2.5, side: 'long', notional: 8000, unrealizedPnl: 50, funding: 3, fees: 1 }],
    rateSpread: [{ symbol: 'ETH', variational8h: 0.008 / 1095, variationalMarkPx: 3180, variationalIntervalRate: 0.008 / 1095, variationalIntervalHours: 8 }],
    hyperliquid: { state: { positions: [] } },
    nado: { state: { positions: [] } },
    grvt: { state: { positions: [] } },
    extended: { state: { positions: [{ symbol: 'ETH', size: 2.5, side: 'long', entryPx: 3100, markPx: 3180, notional: 7950, unrealizedPnl: 50 }] } },
    closedPairs: [],
    closedPairRefreshes: [],
  };
  const result = applyVariationalHedges(data, [hedge], { ETH: { symbol: 'ETH', markPx: 3180, fundingRateInterval: 0.008 / 1095, fundingIntervalS: 28800, fundingRate8h: 0.008 / 1095, fundingRateAnnual: 0.008 } });
  assert.equal(result.paired.length, 1);
  assert.equal(result.unhedged.length, 0);
  assert.equal(result.paired[0].pairLabel, 'Ext + Var');
  assert.ok(!result.paired[0].alerts.includes('size_mismatch'));
  assert.equal(result.paired[0].crossLegB.venue, 'variational');
}

{
  const duped = applyVariationalHedges({
    paired: [{ symbol: 'XLM', pairType: 'grvt_variational', variationalHedgeId: 'old' }],
    unhedged: [],
    rateSpread: [],
    grvt: { state: { positions: [{ symbol: 'XLM', size: 90000, side: 'long', entryPx: 0.22, markPx: 0.217, notional: 19500, unrealizedPnl: -89 }] } },
    hyperliquid: { state: { positions: [] } },
    nado: { state: { positions: [] } },
    extended: { state: { positions: [] } },
    closedPairs: [],
    closedPairRefreshes: [],
  }, [{
    id: 'h1',
    symbol: 'XLM',
    trackedVenue: 'grvt',
    trackedSize: 90000,
    variationalSize: -90000,
    variationalEntryPx: 0.218,
    status: 'open',
    openedAt: 1,
  }], { XLM: { symbol: 'XLM', markPx: 0.217, fundingRateInterval: 0.1095 / 1095, fundingIntervalS: 28800, fundingRate8h: 0.1095 / 1095, fundingRateAnnual: 0.1095 } });
  assert.equal(duped.paired.length, 1, 're-applying variational hedges must not duplicate open pairs');
}

{
  const openedAt = Date.now() - 3 * 86400000;
  const hedge = {
    id: 'h1',
    symbol: 'XLM',
    trackedVenue: 'grvt',
    trackedSize: 90000,
    variationalEntryPx: 0.218,
    status: 'open',
    openedAt,
  };
  const result = applyVariationalHedges({
    paired: [],
    unhedged: [],
    rateSpread: [{ symbol: 'XLM', grvt8h: 0.001, variational8h: 0.0005 }],
    grvt: { state: { positions: [{ symbol: 'XLM', size: 90000, side: 'long', entryPx: 0.22, markPx: 0.217, notional: 19500, unrealizedPnl: -89, cumulativeFundingSinceOpen: 12.34 }] } },
    hyperliquid: { state: { positions: [] } },
    nado: { state: { positions: [] } },
    extended: { state: { positions: [] } },
    closedPairs: [],
    closedPairRefreshes: [],
  }, [hedge], { XLM: { symbol: 'XLM', markPx: 0.217, fundingRateInterval: 0.1095 / 1095, fundingIntervalS: 28800, fundingRate8h: 0.1095 / 1095, fundingRateAnnual: 0.1095 } });
  assert.equal(result.paired[0].legAFundingSinceOpen, 12.34, 'GRVT cumulative funding must flow into variational tracked leg');
}

assert.match(indexHtml, /function perpsEnrichVariationalPairFunding\(pair, data\)/, 'variational pairs must reattach exchange funding events after client-side merge');
assert.match(indexHtml, /buildVariationalFundingEventsScheduled/, 'variational enrichment must estimate funding on Variational native interval schedule');
assert.match(indexHtml, /function perpsResolveVariationalHedge\(pair\)/, 'variational enrichment must resolve hedge by id or symbol+venue');
assert.match(indexHtml, /variationalHedgeFromPair/, 'variational enrichment must merge pair legs into hedge funding seed');
assert.match(variationalHedgeJs, /function normalizeVariationalListing\(/, 'variational listing must derive native interval rate from spread row');
assert.match(indexHtml, /const varTotal = override != null \? override : varPaymentSum/, 'variational funding display must use scheduled interval payments only');
assert.match(variationalHedgeJs, /function variationalFundingOverrideUsd\(/, 'null variational override must not coerce to zero');
assert.match(indexHtml, /variationalListings/, 'dashboard must expose variational listings for hedge funding when spread row is sparse');
assert.doesNotMatch(indexHtml, /estimateVariationalFundingUsd\?\.\(hedge, listing\) \?\? varPaymentSum/, 'open variational funding must not use time-accrual estimate');
assert.match(indexHtml, /lib\/variational-funding-clock\.js/, 'variational funding clock must load in browser before hedge helpers');
assert.match(variationalHedgeJs, /fundingSettlementsOnAnchorGrid/, 'variational funding must use live reference-exchange settlement clock');
assert.match(variationalHedgeJs, /VariationalFundingClock/, 'variational hedge helpers must load funding clock in browser');
assert.match(indexHtml, /perpsMergeVariationalIntoDailyFundingSeries\(data\)/, 'variational estimated funding must merge into portfolio daily funding series');
assert.match(indexHtml, /~Variational est\./, 'daily funding chart must disclose variational estimates');

{
  const hedge = {
    id: 'h1',
    symbol: 'XLM',
    trackedVenue: 'grvt',
    trackedSize: 90000,
    variationalSize: -90000,
    variationalEntryPx: 0.218,
    openedAt: Date.parse('2026-06-24T09:00:00.000Z'),
    status: 'open',
  };
  const listing = {
    symbol: 'XLM',
    markPx: 0.217,
    fundingRateInterval: 0.1095 / 1095,
    fundingIntervalS: 28800,
    fundingIntervalHours: 8,
    fundingNextAtMs: Date.parse('2026-06-25T00:00:00.000Z'),
    fundingClockSource: 'bybit',
  };
  const now = Date.parse('2026-06-24T17:00:00.000Z');
  const trackedEvents = [{ time: now - 3600000, usdc: 1.25, intervalHours: 8 }];
  const scheduled = buildVariationalFundingEventsScheduled(hedge, listing, { now });
  assert.equal(scheduled.length, 1, '09:00→17:00 UTC must accrue one global 8h settlement at 16:00');
  assert.equal(scheduled[0].time, Date.parse('2026-06-24T16:00:00.000Z'));
  assert.equal(scheduled[0].venue, 'variational');
  assert.ok(scheduled[0].fundingEstimated);
  assert.notEqual(scheduled[0].usdc, 0);
  const aligned = buildVariationalFundingEventsAligned(hedge, listing, trackedEvents, { now });
  assert.equal(aligned.length, 1, 'aligned alias must follow global Variational schedule, not HL timestamps');
  assert.equal(aligned[0].time, scheduled[0].time);
}

{
  const freshHedge = {
    id: 'h2',
    symbol: 'ETH',
    trackedVenue: 'hyperliquid',
    trackedSize: 1,
    variationalSize: -1,
    variationalEntryPx: 3200,
    openedAt: Date.now() - 6 * 3600000,
    status: 'open',
  };
  const ethListing = {
    symbol: 'ETH',
    markPx: 3180,
    fundingRateInterval: 0.08 / 1095,
    fundingIntervalS: 28800,
    fundingIntervalHours: 8,
    fundingNextAtMs: Date.parse('2026-06-25T00:00:00.000Z'),
    fundingClockSource: 'bybit',
  };
  const beforeFirst = buildVariationalFundingEventsScheduled(
    { ...freshHedge, openedAt: Date.parse('2026-06-24T17:01:00.000Z') },
    ethListing,
    { now: Date.parse('2026-06-24T18:00:00.000Z') },
  );
  assert.equal(beforeFirst.length, 0, 'no settlement before first reference-clock boundary after open');
  const nextAt = variationalNextFundingAtMs(freshHedge, ethListing, Date.parse('2026-06-24T18:00:00.000Z'));
  assert.equal(nextAt, Date.parse('2026-06-25T00:00:00.000Z'));
  const hlPaid = buildVariationalFundingEventsAligned(
    { ...freshHedge, openedAt: Date.parse('2026-06-24T17:01:00.000Z') },
    ethListing,
    [{ time: Date.parse('2026-06-24T17:30:00.000Z'), usdc: 2 }],
    { now: Date.parse('2026-06-24T18:00:00.000Z') },
  );
  assert.equal(hlPaid.length, 0, 'HL funding payment must not create Variational estimate before global boundary');
  const { buildVariationalSyntheticLeg } = require('../lib/variational-hedge.js');
  const leg = buildVariationalSyntheticLeg(
    { ...freshHedge, openedAt: Date.parse('2026-06-24T17:01:00.000Z') },
    ethListing,
  );
  assert.equal(leg.fundingSinceOpen, 0, 'synthetic variational leg must stay zero until first global settlement');
}

{
  const deduped = dedupeActiveVariationalHedges([
    { id: 'a', symbol: 'XLM', trackedVenue: 'grvt', status: 'open', openedAt: 1 },
    { id: 'b', symbol: 'XLM', trackedVenue: 'grvt', status: 'open', openedAt: 2 },
    { id: 'c', symbol: 'XLM', trackedVenue: 'grvt', status: 'closed', openedAt: 0 },
  ]);
  assert.equal(deduped.filter(h => h.status !== 'closed').length, 1);
  assert.equal(deduped.find(h => h.status !== 'closed')?.id, 'b');
  assert.equal(stripVariationalPairs([{ pairType: 'grvt_variational' }, { pairType: 'hl_nado' }]).length, 1);
}

{
  const rows = buildRateSpreadRows(
    new Set(['BTC']),
    { BTC: { fundingRate8h: 0.01, markPx: 100000 } },
    {},
    {},
    {},
    { BTC: { fundingRate8h: 0.008 / 1095, markPx: 100000, fundingRateInterval: 0.008 / 1095, fundingIntervalHours: 8, fundingRateAnnual: 0.008 } },
  );
  assert.equal(rows.length, 1);
  assert.ok(Math.abs(rows[0].variational8h - 0.008 / 1095) < 1e-12);
  assert.ok(Math.abs(rows[0].spreadHlVariational8h - (0.01 - 0.008 / 1095)) < 1e-12);
}

{
  assert.equal(variationalLegPnl(-1, 100, 95), 5);
  assert.equal(variationalLegPnl(1, 100, 110), 10);
}

{
  const { buildVariationalSyntheticLeg } = require('../lib/variational-hedge.js');
  const hedge = {
    variationalSize: -90000,
    variationalEntryPx: 0.217785,
  };
  const leg = buildVariationalSyntheticLeg(hedge, { markPx: 0.213705, fundingRateInterval: 0.0001, fundingIntervalS: 28800 });
  assert.ok(Math.abs(leg.unrealizedPnl - 367.2) < 0.15, 'uPnL must use avg fill vs live Variational mark');
  assert.equal(leg.markPx, 0.213705);
}

{
  const { findTrackedCloseLeg } = require('../lib/variational-hedge.js');
  const hedge = {
    symbol: 'ETH',
    trackedVenue: 'grvt',
    openedAt: Date.now() - 86400000,
    trackedSize: 1,
    trackedLastSnapshot: null,
  };
  const staleClose = findTrackedCloseLeg({
    closedPairs: [{
      symbol: 'ETH',
      closeTime: Date.now() - 7 * 86400000,
      longLeg: { venue: 'grvt', side: 'long', size: 1, realizedPnl: 999 },
      shortLeg: { venue: 'hyperliquid', side: 'short', size: 1, realizedPnl: 0 },
    }],
  }, hedge);
  assert.equal(staleClose, null, 'close leg from before hedge open must be ignored');
  const snapClose = findTrackedCloseLeg({ closedPairs: [] }, {
    ...hedge,
    trackedLastSnapshot: { side: 'long', size: 1, entryPx: 100, unrealizedPnl: 42, funding: 1, fees: 0 },
  });
  assert.equal(snapClose?.realizedPnl, null, 'snapshot fallback must not treat uPnL as realized');
  assert.equal(snapClose?.closeLegEstimated, true);
}

{
  const trackedLeg = { venue: 'grvt', size: 90000, side: 'long', entryPx: 0.21, unrealizedPnl: -89, fundingSinceOpen: 1, fees: 0, notional: 18900 };
  const hedge = { id: 'h1', symbol: 'XLM', trackedVenue: 'grvt', trackedSize: 90000, variationalSize: -80000, variationalEntryPx: 0.218, openedAt: Date.now() - 2 * 86400000 };
  const pair = buildVariationalOpenPair(trackedLeg, hedge, { markPx: 0.22, fundingRate8h: 0.0001, fundingRateInterval: 0.0001, fundingIntervalS: 28800 }, null);
  assert.ok(pair.alerts.includes('size_mismatch'), 'variational pair must flag tracked vs synthetic size drift');
  assert.ok(pair.sizeMismatchPct > 0);
  assert.ok(pair.daysOpen != null && pair.daysOpen >= 1);
  assert.equal(pair.combinedUpnl != null, true);
}

{
  const { applyVariationalHedges, pinVariationalHedgeSizes } = require('../lib/variational-hedge.js');
  const listing = { symbol: 'ADA', markPx: 0.147, fundingRateInterval: 0.08 / 1095, fundingIntervalS: 28800, fundingRate8h: 0.08 / 1095 };
  const data = {
    paired: [],
    unhedged: [],
    rateSpread: [{ symbol: 'ADA', variational8h: 0.08 / 1095, variationalMarkPx: 0.147 }],
    hyperliquid: { state: { positions: [{ symbol: 'ADA', size: 176000, side: 'long', entryPx: 0.15, markPx: 0.147, unrealizedPnl: -437, fundingSinceOpen: 20, fees: 0 }] } },
    nado: { state: { positions: [] } },
    grvt: { state: { positions: [] } },
    extended: { state: { positions: [] } },
    closedPairs: [],
    closedPairRefreshes: [],
  };
  const hedge = {
    id: 'ada-h1',
    symbol: 'ADA',
    trackedVenue: 'hyperliquid',
    trackedSize: 160000,
    variationalEntryPx: 0.145,
    status: 'open',
    openedAt: Date.now() - 5 * 86400000,
  };
  let result = applyVariationalHedges(data, [hedge], { ADA: listing });
  assert.equal(result.hedges[0].variationalSize, -160000, 'apply must pin explicit variational fill size');
  assert.ok(result.paired[0].alerts.includes('size_mismatch'));
  hedge.variationalEntryPx = 0.146;
  hedge.variationalSize = -160000;
  hedge.updatedAt = Date.now();
  result = applyVariationalHedges(data, [hedge], { ADA: listing });
  assert.ok(result.paired[0].alerts.includes('size_mismatch'), 'entry edit must not clear size mismatch');
  assert.equal(result.paired[0].crossLegB.size, -160000);
  const serverStale = [{
    ...hedge,
    variationalEntryPx: 0.145,
    trackedSize: 176000,
    variationalSize: -176000,
    updatedAt: hedge.updatedAt - 60000,
  }];
  const merged = [mergeVariationalHedgeRecord(hedge, serverStale[0])];
  assert.equal(merged[0].variationalSize, -160000, 'merge must keep newer local variational fill size');
  assert.equal(merged[0].variationalEntryPx, 0.146);
  const localLower = { ...hedge, variationalEntryPx: 0.144, updatedAt: Date.now() };
  const serverHigher = { ...hedge, variationalEntryPx: 0.146, updatedAt: localLower.updatedAt - 60000 };
  const mergedLower = mergeVariationalHedgeRecord(localLower, serverHigher);
  assert.equal(mergedLower.variationalEntryPx, 0.144, 'merge must keep newer local entry even when price is lower');
}

{
  const { applyVariationalHedges, resolveVariationalSizesOnEntryEdit } = require('../lib/variational-hedge.js');
  const listing = { symbol: 'ADA', markPx: 0.147, fundingRateInterval: 0.08 / 1095, fundingIntervalS: 28800, fundingRate8h: 0.08 / 1095 };
  const data = {
    paired: [],
    unhedged: [],
    rateSpread: [{ symbol: 'ADA', variational8h: 0.08 / 1095, variationalMarkPx: 0.147 }],
    hyperliquid: { state: { positions: [{ symbol: 'ADA', size: 176000, side: 'long', entryPx: 0.15, markPx: 0.147, unrealizedPnl: -437, fundingSinceOpen: 20, fees: 0 }] } },
    nado: { state: { positions: [] } },
    grvt: { state: { positions: [] } },
    extended: { state: { positions: [] } },
    closedPairs: [],
    closedPairRefreshes: [],
  };
  const hedge = {
    id: 'ada-h2',
    symbol: 'ADA',
    trackedVenue: 'hyperliquid',
    trackedSize: 176000,
    variationalSize: -160000,
    variationalEntryPx: 0.145,
    status: 'open',
    openedAt: Date.now() - 5 * 86400000,
  };
  resolveVariationalSizesOnEntryEdit(hedge, { size: 176000, side: 'long' });
  let result = applyVariationalHedges(data, [hedge], { ADA: listing });
  assert.ok(!result.paired[0].alerts.includes('size_mismatch'), 'entry edit must sync variational size to exchange leg');
  assert.equal(result.paired[0].crossLegB.size, -176000);

  const priceOnly = {
    ...hedge,
    variationalSize: -160000,
    variationalEntryPx: 0.146,
  };
  resolveVariationalSizesOnEntryEdit(priceOnly, { size: 176000, side: 'long' });
  result = applyVariationalHedges(data, [priceOnly], { ADA: listing });
  assert.ok(!result.paired[0].alerts.includes('size_mismatch'), 'price edit must auto-sync size from exchange leg');
  assert.equal(result.paired[0].crossLegB.size, -176000);
}

function mergeVariationalHedgeRecord(prev, hedge) {
  const prevTs = Number(prev?.updatedAt) || Number(prev?.openedAt) || 0;
  const incTs = Number(hedge?.updatedAt) || Number(hedge?.openedAt) || 0;
  const preferPrev = prevTs >= incTs;
  const pickField = (field) => {
    const prevVal = prev?.[field];
    const incVal = hedge?.[field];
    if (preferPrev && prevVal != null && prevVal !== '' && Number(prevVal) !== 0) return prevVal;
    if (incVal != null && incVal !== '' && Number(incVal) !== 0) return incVal;
    return preferPrev ? (prevVal ?? incVal) : (incVal ?? prevVal);
  };
  return {
    ...prev,
    ...hedge,
    openedAt: Number(hedge?.openedAt) || Number(prev?.openedAt) || null,
    updatedAt: Math.max(prevTs, incTs) || null,
    variationalEntryPx: pickField('variationalEntryPx'),
    variationalSize: pickField('variationalSize'),
    trackedSize: pickField('trackedSize'),
  };
}

assert.ok(indexHtml.includes('PERPS_VARIATIONAL_HEDGES_KEY'), 'index must persist variational hedges');
assert.ok(indexHtml.includes('perpsVariationalTrackedEntryWrap'), 'variational modal must show tracked exchange entry read-only');
assert.ok(indexHtml.includes('trackedEntryPx'), 'variational modal must pass tracked exchange entry into edit flow');
assert.ok(indexHtml.includes('Hedge with Variational'), 'index must expose hedge action');
assert.ok(indexHtml.includes('lib/variational-hedge.js'), 'index must load variational hedge module');
assert.ok(perpsJs.includes('fetchVariationalRates'), 'perps.js must fetch variational rates');

const {
  variationalOpenEquityAdjust,
  variationalPendingCloseEquityAdjust,
  variationalClosedEquityAdjust,
  variationalTotalEquityAdjust,
  variationalNeutralEquity,
  equityPointChartValue,
  computeVariationalEquityAdjustFromHedges,
  snapshotVariationalAdjust,
} = require('../lib/variational-equity.js');

{
  const openAdj = variationalOpenEquityAdjust([{
    pairType: 'grvt_variational',
    venueA: 'grvt',
    crossLegA: { venue: 'grvt', unrealizedPnl: -286 },
    crossLegB: { venue: 'variational', unrealizedPnl: 294 },
  }], (p) => p.pairType === 'grvt_variational');
  assert.equal(openAdj, 286, 'open hedge adjust must neutralize tracked-leg uPnL');
  assert.equal(
    variationalNeutralEquity(10000, openAdj),
    10286,
    'hedge-neutral equity must add -trackedUpnl when tracked leg is underwater',
  );
}

{
  const closedAdj = variationalClosedEquityAdjust([{
    pairType: 'grvt_variational',
    manualVariationalClose: true,
    longLeg: { venue: 'grvt', realizedPnl: -12, funding: 4, fees: 1 },
    shortLeg: { venue: 'variational', realizedPnl: 18, funding: 2, fees: 0 },
  }]);
  assert.equal(closedAdj, 20, 'closed hedge adjust must add variational realized + funding');
}

{
  const point = { totalEquity: 10000, variationalEquityAdjust: 286, variationalNeutralEquity: 10286 };
  assert.equal(equityPointChartValue(point, 'neutral'), 10286);
  assert.equal(equityPointChartValue(point, 'raw'), 10000);
}

{
  const pendingAdj = variationalPendingCloseEquityAdjust([{
    symbol: 'XLM',
    trackedVenue: 'grvt',
    lockedEquityAdjust: 286,
    trackedLastSnapshot: { unrealizedPnl: -999 },
  }]);
  assert.equal(pendingAdj, 286, 'pending close must prefer locked equity adjust over stale snapshot');
  assert.equal(
    variationalTotalEquityAdjust([], [], () => false, [{
      lockedEquityAdjust: 286,
    }]),
    286,
  );
}

{
  const adjust = computeVariationalEquityAdjustFromHedges({
    hedges: [{
      id: 'xlm-grvt',
      symbol: 'XLM',
      trackedVenue: 'grvt',
      status: 'open',
    }],
    closedPairs: [],
    states: {
      grvt: { state: { positions: [{ symbol: 'XLM', unrealizedPnl: -120 }] } },
    },
  });
  assert.equal(adjust.openAdj, 120, 'server hedge adjust must strip tracked-leg uPnL from open hedges');
  assert.equal(adjust.totalAdj, 120, 'total hedge adjust must include open leg');
}

{
  const snap = {
    variationalOpenEquityAdjust: 120,
    variationalClosedEquityAdjust: 20,
  };
  assert.equal(snapshotVariationalAdjust(snap, 0), 140, 'snapshot adjust must sum stored components');
}

{
  const { record } = buildEquitySnapshotFromDashboard({
    fetchedAt: Date.now(),
    summary: { hlAccountValue: 1000, nadoAccountValue: 500, grvtConfigured: false, extendedConfigured: false, combinedNetDeposits: 0 },
    variationalEquityAdjust: { openAdj: 120, pendingAdj: 0, closedAdj: 20, totalAdj: 140 },
  });
  assert.equal(record.variationalEquityAdjust, 140, 'equity snapshot record must persist variational total adjust');
  assert.equal(record.variationalOpenEquityAdjust, 120, 'equity snapshot record must persist open adjust');
}

assert.match(indexHtml, /variationalPendingCloseEquityAdjust/, 'pending close must lock last tracked-leg equity adjust');
assert.match(variationalHedgeJs, /lockedEquityAdjust/, 'pending close must lock last tracked-leg equity adjust');

console.log('PASS: perps accounting and dashboard regression checks');

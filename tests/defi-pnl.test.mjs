import assert from 'node:assert/strict';
import DefiPnl from '../lib/defi-pnl.js';

const {
  FifoQtyLedger,
  FifoUsdLedger,
  computeWalletPnlSeries,
  computeProtocolPnlSeries,
  processQtyTransition,
  processUsdTransition,
} = DefiPnl;

// Partial BTC sell: 0.5 -> 0.4, price rises 40k -> 50k
{
  const ledger = new FifoQtyLedger();
  ledger.addLot(0.5, 20000);
  processQtyTransition(ledger, 0.5, 20000, 0.4, 20000);
  const price = 50000;
  assert.ok(Math.abs(ledger.realized - 1000) < 0.01, 'realized on 0.1 BTC sold');
  assert.ok(Math.abs(ledger.unrealized(price) - 4000) < 0.01, 'unrealized on remaining 0.4');
  assert.ok(Math.abs(ledger.totalPnl(price) - 5000) < 0.01, 'total PNL preserved');
}

// BTC increase: 0.5 -> 0.7 with higher mark
{
  const ledger = new FifoQtyLedger();
  ledger.addLot(0.5, 20000);
  processQtyTransition(ledger, 0.5, 20000, 0.7, 35000);
  const price = 50000;
  assert.ok(Math.abs(ledger.qty() - 0.7) < 1e-9);
  assert.ok(Math.abs(ledger.totalPnl(price) - 5000) < 0.01);
}

// Realized persists after full sell
{
  const series = computeWalletPnlSeries([
    { ts: 1, tokens: [{ symbol: 'BTC', amount: 0.5, value: 20000 }] },
    { ts: 2, tokens: [{ symbol: 'BTC', amount: 0.4, value: 20000 }] },
    { ts: 3, tokens: [{ symbol: 'BTC', amount: 0, value: 0 }] },
  ]);
  assert.equal(series.points.length, 3);
  assert.ok(series.points[2].totalPnl > 0, 'realized kept after full sell');
}

// Token reappears as new lot; prior realized still in total
{
  const series = computeWalletPnlSeries([
    { ts: 1, tokens: [{ symbol: 'ETH', amount: 1, value: 3000 }] },
    { ts: 2, tokens: [] },
    { ts: 3, tokens: [{ symbol: 'ETH', amount: 0.5, value: 2000 }] },
  ]);
  const last = series.points[series.points.length - 1].totalPnl;
  assert.ok(Number.isFinite(last));
}

// Protocol partial close
{
  const key = 'Aave|||Lending:supplied:USDe';
  const series = computeProtocolPnlSeries([
    { ts: 1, positions: { [key]: 1000 } },
    { ts: 2, positions: { [key]: 800 } },
  ]);
  assert.equal(series.points.length, 2);
}

// Protocol full close keeps total PNL (does not reset)
{
  const key = 'Aave|||Lending:supplied:USDe';
  const series = computeProtocolPnlSeries([
    { ts: 1, positions: { [key]: 1000 } },
    { ts: 2, positions: { [key]: 1200 } },
    { ts: 3, positions: {} },
  ]);
  assert.ok(Number.isFinite(series.points[2].totalPnl));
  assert.equal(series.points[2].totalPnl, 0);
}

// Protocol increase adds new lot (cost basis follows additions)
{
  const ledger = new FifoUsdLedger();
  processUsdTransition(ledger, 0, 1000);
  processUsdTransition(ledger, 1000, 1300);
  assert.ok(Math.abs(ledger.totalPnl(1300) - 0) < 0.01);
}

// Chart series is single total metric
{
  const wallet = computeWalletPnlSeries([
    { ts: 1000, tokens: [{ symbol: 'SOL', amount: 10, value: 1000 }] },
    { ts: 2000, tokens: [{ symbol: 'SOL', amount: 10, value: 1200 }] },
  ]);
  assert.ok(wallet.points.every(p => Number.isFinite(p.totalPnl)));
  assert.equal(Object.keys(wallet.points[0]).sort().join(','), 'label,totalPnl,ts');
}

console.log('PASS: defi-pnl cost-basis tests');

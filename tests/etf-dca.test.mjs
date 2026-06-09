import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  noteHasDca,
  countAccruedDcaDays,
  computeDcaApplication,
  applyDcaToPosition,
  syncDcaNoteState,
  isTradingDay,
  dcaFillHistoryForPosition,
} = require('../lib/etf-dca.js');

{
  assert.equal(noteHasDca('DCA'), true);
  assert.equal(noteHasDca('my DCA plan'), true);
  assert.equal(noteHasDca('manual'), false);
}

{
  // Fri -> Mon = Sat + Sun + Mon = 3 days
  assert.equal(countAccruedDcaDays('2026-06-05', '2026-06-08', '2026-06-01'), 3);
  // First day after enable
  assert.equal(countAccruedDcaDays('', '2026-06-08', '2026-06-08'), 1);
  // Tue after Mon fill
  assert.equal(countAccruedDcaDays('2026-06-08', '2026-06-09', '2026-06-08'), 1);
}

{
  const monday = new Date('2026-06-08T11:00:00+03:00'); // Monday in Bucharest
  assert.equal(isTradingDay(monday, 'SXR8.DE'), true);
  const saturday = new Date('2026-06-06T11:00:00+03:00');
  assert.equal(isTradingDay(saturday, 'SXR8.DE'), false);
}

{
  const monday = new Date('2026-06-08T11:00:00+03:00');
  const etf = {
    ticker: 'SXR8.DE',
    note: 'DCA',
    dcaDailyAmount: 248,
    lastDcaDate: '2026-06-05',
    shares: 10,
    avgPrice: 100,
  };
  const plan = computeDcaApplication(etf, monday);
  assert.ok(plan);
  assert.equal(plan.days, 3);
  assert.equal(plan.amount, 744);
}

{
  const etf = {
    ticker: 'SXR8.DE',
    note: 'manual',
    dcaDailyAmount: 248,
    lastDcaDate: '',
    shares: 10,
    avgPrice: 100,
  };
  const monday = new Date('2026-06-08T11:00:00+03:00');
  assert.equal(computeDcaApplication(etf, monday), null);
}

{
  const etf = { note: 'DCA', dcaDailyAmount: 100, dcaAccrualFrom: '2026-06-08' };
  syncDcaNoteState(etf, 'DCA');
  assert.equal(etf.dcaDailyAmount, 100);

  etf.note = 'manual';
  syncDcaNoteState(etf, 'DCA');
  assert.equal(etf.dcaDailyAmount, 0);
  assert.equal(etf.lastDcaDate, '');
}

{
  const etf = {
    ticker: 'SXR8.DE',
    note: 'DCA',
    dcaDailyAmount: 248,
    lastDcaDate: '2026-06-05',
    shares: 10,
    avgPrice: 100,
  };
  const monday = new Date('2026-06-08T11:00:00+03:00');
  assert.equal(applyDcaToPosition(etf, 500, monday), true);
  assert.equal(etf.lastDcaAmount, 744);
  assert.equal(etf.lastDcaDaysAccrued, 3);
  assert.equal(etf.lastDcaPrice, 500);
  assert.equal(etf.dcaFillHistory.length, 1);
  assert.equal(etf.dcaFillHistory[0].price, 500);
  assert.ok(etf.shares > 10);
}

{
  const legacy = {
    ticker: 'SPY',
    lastDcaEventAt: Date.now() - 86400000,
    lastDcaAmount: 100,
    lastDcaShares: 0.5,
    lastDcaPrice: 200,
    lastDcaDaysAccrued: 1,
  };
  const history = dcaFillHistoryForPosition(legacy);
  assert.equal(history.length, 1);
  assert.equal(history[0].price, 200);
}

console.log('PASS: etf-dca tests');

/**
 * ETF / stock DCA — daily accrual with weekend (non-trading day) catch-up.
 * Execution timezone for date keys: Europe/Bucharest (12:00 Romania).
 */

const DCA_DATE_TZ = 'Europe/Bucharest';

function noteHasDca(note) {
  return /\bdca\b/i.test(String(note || '').trim());
}

function dcaDateKey(date = new Date(), tz = DCA_DATE_TZ) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function marketProfileForTicker(ticker) {
  const t = String(ticker || '').trim().toUpperCase();
  if (/\.(DE|F|BE|PA|AS|MI|SW|VI|HA|MU|ST|HM|HE|DU|SG|OL)$/.test(t)) {
    return { tz: 'Europe/Berlin' };
  }
  if (/\.(L|IL|LS|LON)$/.test(t)) {
    return { tz: 'Europe/London' };
  }
  return { tz: 'America/New_York' };
}

function weekdayShort(date, tz) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(date);
}

function isTradingDay(date, ticker) {
  const { tz } = marketProfileForTicker(ticker);
  const wd = weekdayShort(date, tz);
  return wd !== 'Sat' && wd !== 'Sun';
}

function dateKeyToUtcNoon(dateKey) {
  const [y, m, d] = String(dateKey || '').split('-').map(Number);
  if (!y || !m || !d) return new Date();
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

function addCalendarDays(dateKey, days, tz = DCA_DATE_TZ) {
  const dt = dateKeyToUtcNoon(dateKey);
  dt.setUTCDate(dt.getUTCDate() + Number(days || 0));
  return dcaDateKey(dt, tz);
}

function countAccruedDcaDays(lastDcaDateKey, todayKey, accrualFromKey, tz = DCA_DATE_TZ) {
  if (!todayKey) return 0;
  if (lastDcaDateKey && lastDcaDateKey >= todayKey) return 0;

  let startKey = lastDcaDateKey ? addCalendarDays(lastDcaDateKey, 1, tz) : (accrualFromKey || todayKey);
  if (startKey > todayKey) return 0;

  let count = 0;
  let cur = startKey;
  while (cur <= todayKey) {
    count++;
    cur = addCalendarDays(cur, 1, tz);
  }
  return count;
}

function computeDcaApplication(etf, now = new Date(), tz = DCA_DATE_TZ) {
  const daily = Number(etf?.dcaDailyAmount || 0);
  if (!daily || !noteHasDca(etf?.note)) return null;

  const todayKey = dcaDateKey(now, tz);
  if (String(etf?.lastDcaDate || '') === todayKey) return null;
  if (!isTradingDay(now, etf?.ticker)) return null;

  const days = countAccruedDcaDays(
    etf?.lastDcaDate || '',
    todayKey,
    etf?.dcaAccrualFrom || todayKey,
    tz,
  );
  if (days <= 0) return null;

  return {
    todayKey,
    days,
    amount: daily * days,
  };
}

function applyDcaToPosition(etf, price, now = new Date(), tz = DCA_DATE_TZ) {
  const px = Number(price);
  if (!px) return false;

  const plan = computeDcaApplication(etf, now, tz);
  if (!plan) return false;

  const oldShares = Number(etf.shares || 0);
  const oldCost = oldShares * Number(etf.avgPrice || px);
  const addedShares = plan.amount / px;

  etf.shares = oldShares + addedShares;
  etf.avgPrice = etf.shares ? (oldCost + plan.amount) / etf.shares : px;
  etf.currentPrice = px;
  etf.lastDcaDate = plan.todayKey;
  etf.lastDcaEventAt = Date.now();
  etf.lastDcaAmount = plan.amount;
  etf.lastDcaDaysAccrued = plan.days;
  etf.lastDcaShares = addedShares;
  etf.updatedAt = Date.now();
  return true;
}

function syncDcaNoteState(etf, previousNote, todayKey = dcaDateKey()) {
  if (!etf || typeof etf !== 'object') return;
  const wasDca = noteHasDca(previousNote);
  const isDca = noteHasDca(etf.note);

  if (isDca && !wasDca) {
    if (!etf.dcaAccrualFrom) etf.dcaAccrualFrom = todayKey;
    return;
  }

  if (!isDca && (wasDca || Number(etf.dcaDailyAmount || 0) > 0)) {
    etf.dcaDailyAmount = 0;
    etf.lastDcaDate = '';
    etf.dcaAccrualFrom = '';
    etf.lastDcaDaysAccrued = 0;
  }
}

function ensureDcaNote(etf) {
  if (Number(etf?.dcaDailyAmount || 0) > 0 && !noteHasDca(etf?.note)) {
    etf.note = 'DCA';
    if (!etf.dcaAccrualFrom) etf.dcaAccrualFrom = dcaDateKey();
  }
}

const EtfDca = {
  DCA_DATE_TZ,
  noteHasDca,
  dcaDateKey,
  marketProfileForTicker,
  isTradingDay,
  addCalendarDays,
  countAccruedDcaDays,
  computeDcaApplication,
  applyDcaToPosition,
  syncDcaNoteState,
  ensureDcaNote,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = EtfDca;
}
if (typeof window !== 'undefined') {
  window.EtfDca = EtfDca;
}

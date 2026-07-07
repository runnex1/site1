const MS_PER_DAY = 86_400_000;
const MIN_PERIOD_DAYS = 1 / 24;
const LOOP_CAPITAL_MIN_USD = 75;
const LOOP_CAPITAL_MIN_REL = 0.025;
const LOOP_CAPITAL_NET_JUMP_REL = 0.07;

function loopPositionIdsMatch(a, b) {
  const left = String(a || '').trim().toLowerCase();
  const right = String(b || '').trim().toLowerCase();
  return !!(left && right && left === right);
}

function num(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function loopHistoryGrossExposure(point) {
  return num(point?.totalSupplied, 0) + num(point?.totalBorrowed, 0);
}

function loopHistoryPositionNet(point) {
  if (point?.positionNetValue != null && Number.isFinite(num(point.positionNetValue))) {
    return num(point.positionNetValue);
  }
  const economic = num(point?.netValue, 0);
  const merkl = num(point?.merklRewardsUsd, 0);
  if (merkl > 0.01 && economic > merkl) return economic - merkl;
  return num(point?.netValue, num(point?.totalSupplied, 0) - num(point?.totalBorrowed, 0));
}

function loopHistoryLegKey(leg) {
  return String(leg?.symbol || '').trim().toUpperCase();
}

function loopHistoryLegAmountSum(legs, symbol) {
  const key = String(symbol || '').toUpperCase();
  return (legs || []).reduce((sum, leg) => {
    if (loopHistoryLegKey(leg) !== key) return sum;
    return sum + Math.abs(num(leg?.amount, 0));
  }, 0);
}

function loopHistoryLegsAmountStable(prevLegs, currLegs, symbol, relTol = 0.01) {
  const prevAmt = loopHistoryLegAmountSum(prevLegs, symbol);
  const currAmt = loopHistoryLegAmountSum(currLegs, symbol);
  if (prevAmt <= 0.01 && currAmt <= 0.01) return true;
  if (prevAmt <= 0.01 || currAmt <= 0.01) return false;
  return Math.abs(currAmt - prevAmt) / Math.max(prevAmt, currAmt) <= relTol;
}

function loopHistoryPartialLegApiMiss(prev, curr) {
  const prevSup = Array.isArray(prev?.suppliedLegs) ? prev.suppliedLegs : [];
  const currSup = Array.isArray(curr?.suppliedLegs) ? curr.suppliedLegs : [];
  const prevBor = Array.isArray(prev?.borrowedLegs) ? prev.borrowedLegs : [];
  const currBor = Array.isArray(curr?.borrowedLegs) ? curr.borrowedLegs : [];
  if (!prevSup.length || !currSup.length || !prevBor.length || !currBor.length) return false;

  const prevSupSyms = new Set(prevSup.map(loopHistoryLegKey).filter(Boolean));
  const currSupSyms = new Set(currSup.map(loopHistoryLegKey).filter(Boolean));
  const removed = [...prevSupSyms].filter(sym => !currSupSyms.has(sym));
  if (!removed.length) return false;

  const removedValue = removed.reduce((sum, sym) => {
    const leg = prevSup.find(l => loopHistoryLegKey(l) === sym);
    return sum + Math.abs(num(leg?.value, num(leg?.amount, 0)));
  }, 0);
  if (removedValue < LOOP_CAPITAL_MIN_USD) return false;

  const sharedSup = [...currSupSyms].filter(sym => prevSupSyms.has(sym));
  if (!sharedSup.length) return false;
  if (!sharedSup.every(sym => loopHistoryLegsAmountStable(prevSup, currSup, sym))) return false;

  const sharedBor = [...new Set(currBor.map(loopHistoryLegKey).filter(Boolean))]
    .filter(sym => prevBor.some(l => loopHistoryLegKey(l) === sym));
  if (!sharedBor.length) return false;
  return sharedBor.every(sym => loopHistoryLegsAmountStable(prevBor, currBor, sym));
}

function loopHistoryCapitalEvent(prev, curr) {
  if (!prev || !curr) return false;
  if (loopHistoryPartialLegApiMiss(prev, curr)) return false;
  const prevGross = loopHistoryGrossExposure(prev);
  const currGross = loopHistoryGrossExposure(curr);
  const grossDelta = Math.abs(currGross - prevGross);
  if (grossDelta >= Math.max(LOOP_CAPITAL_MIN_USD, prevGross * LOOP_CAPITAL_MIN_REL)) return true;

  const prevNet = loopHistoryPositionNet(prev);
  const currNet = loopHistoryPositionNet(curr);
  const dtDays = Math.max(num(curr.ts, 0) - num(prev.ts, 0), 0) / MS_PER_DAY;
  if (dtDays <= 0 || prevNet <= 1) return false;

  const impliedMove = Math.abs(num(prev.netApy, 0)) / 100 * prevNet * (dtDays / 365);
  const netDelta = Math.abs(currNet - prevNet);
  return netDelta > Math.max(impliedMove * 5, prevNet * LOOP_CAPITAL_NET_JUMP_REL);
}

function loopTrimHistoryToLatestSession(points) {
  const sorted = (points || [])
    .filter(p => p && num(p.ts) && Number.isFinite(num(p.netValue)))
    .map(p => ({
      ts: num(p.ts),
      netValue: num(p.netValue),
      positionNetValue: num(p.positionNetValue, null),
      merklRewardsUsd: num(p.merklRewardsUsd, 0),
      netApy: num(p.netApy, null),
      totalSupplied: num(p.totalSupplied, 0),
      totalBorrowed: num(p.totalBorrowed, 0),
      suppliedLegs: Array.isArray(p.suppliedLegs) ? p.suppliedLegs : [],
      borrowedLegs: Array.isArray(p.borrowedLegs) ? p.borrowedLegs : [],
    }))
    .sort((a, b) => a.ts - b.ts);
  if (sorted.length < 2) return sorted;
  let sessionStart = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (loopHistoryCapitalEvent(sorted[i - 1], sorted[i])) sessionStart = i;
  }
  return sorted.slice(sessionStart);
}

function loopSnapshotRealizedApy(points, targetDays, endValue, endTs) {
  const end = num(endTs);
  const endVal = num(endValue);
  if (!end || !Number.isFinite(endVal)) return null;

  const sorted = loopTrimHistoryToLatestSession(points);

  const target = Math.max(1, num(targetDays, 7));
  const windowStart = end - target * MS_PER_DAY;
  const firstTs = sorted.length ? sorted[0].ts : end;
  const baselineTs = Math.max(windowStart, firstTs);

  let baselineVal = null;
  let baselinePointTs = baselineTs;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].ts <= baselineTs) {
      baselineVal = sorted[i].netValue;
      baselinePointTs = sorted[i].ts;
      break;
    }
  }
  if (baselineVal === null && sorted.length) {
    baselineVal = sorted[0].netValue;
    baselinePointTs = sorted[0].ts;
  }
  if (!Number.isFinite(baselineVal) || Math.abs(baselineVal) < 0.01) return null;

  const periodDays = Math.max(end - baselinePointTs, 0) / MS_PER_DAY;
  if (periodDays < MIN_PERIOD_DAYS) return null;

  const apy = ((endVal - baselineVal) / baselineVal) * (365 / periodDays) * 100;

  return {
    apy,
    periodDays,
    targetDays: target,
    partial: periodDays < target - 0.01,
    baselineValue: baselineVal,
    endValue: endVal,
    baselineTs: baselinePointTs,
    endTs: end,
  };
}

function loopSnapshotPeriodNetApy(points, targetDays, endTs) {
  const end = num(endTs);
  if (!end) return null;

  const session = loopTrimHistoryToLatestSession(points);
  if (!session.length) return null;

  const target = Math.max(1, num(targetDays, 7));
  const windowStart = end - target * MS_PER_DAY;
  const effectiveStart = Math.max(windowStart, session[0].ts);
  const inWindow = session.filter(p => p.ts >= effectiveStart && p.ts <= end);
  const apyPoints = inWindow.filter(p => Number.isFinite(num(p.netApy)));
  if (!apyPoints.length) return null;

  let weighted = 0;
  let weightSum = 0;
  for (let i = 0; i < apyPoints.length; i++) {
    const segStart = Math.max(apyPoints[i].ts, effectiveStart);
    const segEnd = i + 1 < apyPoints.length ? apyPoints[i + 1].ts : end;
    const weight = Math.max(segEnd - segStart, 0);
    if (weight <= 0) continue;
    weighted += num(apyPoints[i].netApy) * weight;
    weightSum += weight;
  }

  const apy = weightSum > 0
    ? weighted / weightSum
    : num(apyPoints[apyPoints.length - 1].netApy);
  if (!Number.isFinite(apy)) return null;

  const periodDays = Math.max(end - effectiveStart, 0) / MS_PER_DAY;
  if (periodDays < MIN_PERIOD_DAYS) return null;

  return {
    apy,
    periodDays,
    targetDays: target,
    partial: periodDays < target - 0.01,
    endTs: end,
    sessionStartTs: session[0].ts,
  };
}

function loopSnapshotApyBreakdown(points, endValue, endTs) {
  return {
    apr7d: loopSnapshotPeriodNetApy(points, 7, endTs),
    apr30d: loopSnapshotPeriodNetApy(points, 30, endTs),
  };
}

module.exports = {
  MS_PER_DAY,
  LOOP_CAPITAL_MIN_USD,
  LOOP_CAPITAL_MIN_REL,
  loopPositionIdsMatch,
  loopHistoryPartialLegApiMiss,
  loopHistoryPositionNet,
  loopHistoryCapitalEvent,
  loopTrimHistoryToLatestSession,
  loopSnapshotRealizedApy,
  loopSnapshotPeriodNetApy,
  loopSnapshotApyBreakdown,
};

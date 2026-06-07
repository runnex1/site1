const MS_PER_DAY = 86_400_000;
const MIN_PERIOD_DAYS = 1 / 24;

function num(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function loopSnapshotRealizedApy(points, targetDays, endValue, endTs) {
  const end = num(endTs);
  const endVal = num(endValue);
  if (!end || !Number.isFinite(endVal)) return null;

  const sorted = (points || [])
    .filter(p => p && num(p.ts) && Number.isFinite(num(p.netValue)))
    .map(p => ({ ts: num(p.ts), netValue: num(p.netValue) }))
    .sort((a, b) => a.ts - b.ts);

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

function loopSnapshotApyBreakdown(points, endValue, endTs) {
  return {
    apr7d: loopSnapshotRealizedApy(points, 7, endValue, endTs),
    apr30d: loopSnapshotRealizedApy(points, 30, endValue, endTs),
  };
}

module.exports = {
  MS_PER_DAY,
  loopSnapshotRealizedApy,
  loopSnapshotApyBreakdown,
};

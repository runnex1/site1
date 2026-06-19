/**
 * DeFi protocol import APR helpers (shared by dashboard + tests).
 */

const PROTO_APR_EXACT_AFTER_HOURS = 8;
const PROTO_APR_FLOOR_HOURS = 24;
const PROTO_APR_FLOOR_DAYS = PROTO_APR_FLOOR_HOURS / 24;
const PROTO_APR_MAX_ABS = 80;
const PROTO_APR_VALUE_EPSILON_ABS = 1;
const PROTO_APR_VALUE_EPSILON_REL = 0.0001;

function protocolAprRawDays(baselineTs, newerTs) {
  const raw = (Number(newerTs) - Number(baselineTs)) / 86400000;
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

function protocolAprDaysDiff(baselineTs, newerTs) {
  const rawDiff = protocolAprRawDays(baselineTs, newerTs);
  if (rawDiff === null) return null;
  const rawHours = rawDiff * 24;
  if (rawHours >= PROTO_APR_EXACT_AFTER_HOURS) return rawDiff;
  return PROTO_APR_FLOOR_DAYS;
}

function protocolPositionValuesEqual(a, b, opts = {}) {
  const absEps = opts.absEpsilon ?? PROTO_APR_VALUE_EPSILON_ABS;
  const relEps = opts.relEpsilon ?? PROTO_APR_VALUE_EPSILON_REL;
  const av = Number(a);
  const bv = Number(b);
  if (!Number.isFinite(av) || !Number.isFinite(bv)) return false;
  const delta = Math.abs(av - bv);
  const base = Math.max(Math.abs(av), Math.abs(bv), 1);
  return delta <= absEps || (delta / base) <= relEps;
}

function calcPositionAprFromValues(newerVal, olderVal, daysDiff, maxValueChange = 700, maxAbsApr = 80) {
  if (!olderVal || newerVal === null || daysDiff === null) return null;
  if (protocolPositionValuesEqual(newerVal, olderVal)) return 0;
  if (Math.abs(newerVal - olderVal) > maxValueChange) return null;
  const apr = ((newerVal - olderVal) / olderVal) * (365 / daysDiff) * 100;
  if (Math.abs(apr) >= maxAbsApr) return null;
  return apr;
}

const protocolAprExports = {
  PROTO_APR_EXACT_AFTER_HOURS,
  PROTO_APR_FLOOR_HOURS,
  PROTO_APR_FLOOR_DAYS,
  PROTO_APR_MAX_ABS,
  PROTO_APR_VALUE_EPSILON_ABS,
  PROTO_APR_VALUE_EPSILON_REL,
  protocolAprRawDays,
  protocolAprDaysDiff,
  protocolPositionValuesEqual,
  calcPositionAprFromValues,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = protocolAprExports;
}
if (typeof window !== 'undefined') {
  window.ProtocolApr = protocolAprExports;
}

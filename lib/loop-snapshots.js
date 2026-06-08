function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

const { isEvmWallet, isSolanaWallet } = require('./loop-solana-rates');

function isWallet(value) {
  return isEvmWallet(value) || isSolanaWallet(value);
}

const LOOP_SNAPSHOT_BUCKET_HOURS = 3;

function loopSnapshotBucketKey(ms) {
  const d = new Date(ms);
  const h = Math.floor(d.getUTCHours() / LOOP_SNAPSHOT_BUCKET_HOURS) * LOOP_SNAPSHOT_BUCKET_HOURS;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}T${String(h).padStart(2, '0')}`;
}

function parseLoopSnapshotBucketTime(key) {
  if (!key) return 0;
  if (String(key).includes('T')) return Date.parse(`${key}:00:00.000Z`) || 0;
  return Date.parse(key) || 0;
}

function loopPositionHistoryKey(pos) {
  const protocol = String(pos?.protocol || '').trim().toLowerCase();
  const wallet = String(pos?.wallet || '').trim().toLowerCase();
  const chainId = String(pos?.chainId ?? '');
  const marketName = String(pos?.marketName || '').trim().toLowerCase();
  if (!protocol || !wallet || chainId === '') return String(pos?.id || '');
  return `${protocol}:${wallet}:${chainId}:${marketName}`;
}

function loopYieldWalletsFromWatcherList(wallets) {
  return [...new Set((wallets || [])
    .filter(w => String(w?.category || '').toLowerCase() === 'yield')
    .map(w => String(w?.address || '').trim())
    .filter(isWallet)
    .map(w => w.toLowerCase()))];
}

function buildLoopSnapshotFromRates(data) {
  const fetchedAt = num(data?.updatedAt, Date.now());
  const key = loopSnapshotBucketKey(fetchedAt);
  return {
    key,
    record: {
      bucket: key,
      fetchedAt,
      wallets: Array.isArray(data?.wallets) ? data.wallets : [],
      positions: (data?.positions || [])
        .filter(p => num(p?.totalBorrowed) > 0.01)
        .map(p => {
          const netValue = num(p.netValue);
          const merklRewardsUsd = num(p.merklRewardsUsd);
          const economicNetValue = num(p.economicNetValue, netValue + merklRewardsUsd);
          return {
            id: p.id,
            historyKey: loopPositionHistoryKey(p),
            protocol: p.protocol,
            marketName: p.marketName,
            wallet: p.wallet,
            chainId: p.chainId,
            netValue,
            merklRewardsUsd: merklRewardsUsd > 0.01 ? merklRewardsUsd : 0,
            economicNetValue,
            totalSupplied: num(p.totalSupplied),
            totalBorrowed: num(p.totalBorrowed),
            supplyApy: p.supplyApy == null ? null : num(p.supplyApy, null),
            borrowApy: p.borrowApy == null ? null : num(p.borrowApy, null),
            netApy: p.netApy == null ? null : num(p.netApy, null),
            health: p.health == null ? null : num(p.health, null),
          };
        }),
    },
  };
}

function appendLoopSnapshotStore(store, data, maxEntries = 360) {
  const next = { ...(store || {}) };
  const { key, record } = buildLoopSnapshotFromRates(data);
  if (!record.positions.length) return next;
  if (next[key]) return next;
  next[key] = record;
  const keys = Object.keys(next).sort((a, b) => parseLoopSnapshotBucketTime(a) - parseLoopSnapshotBucketTime(b));
  while (keys.length > maxEntries) {
    delete next[keys.shift()];
  }
  return next;
}

module.exports = {
  LOOP_SNAPSHOT_BUCKET_HOURS,
  loopSnapshotBucketKey,
  parseLoopSnapshotBucketTime,
  loopPositionHistoryKey,
  loopYieldWalletsFromWatcherList,
  buildLoopSnapshotFromRates,
  appendLoopSnapshotStore,
};

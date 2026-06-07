function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function isWallet(value) {
  return typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value.trim());
}

function loopSnapshotBucketKey(ms) {
  const d = new Date(ms);
  const h = Math.floor(d.getUTCHours() / 6) * 6;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}T${String(h).padStart(2, '0')}`;
}

function parseLoopSnapshotBucketTime(key) {
  if (!key) return 0;
  if (String(key).includes('T')) return Date.parse(`${key}:00:00.000Z`) || 0;
  return Date.parse(key) || 0;
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
        .map(p => ({
          id: p.id,
          protocol: p.protocol,
          marketName: p.marketName,
          wallet: p.wallet,
          chainId: p.chainId,
          netValue: num(p.netValue),
          totalSupplied: num(p.totalSupplied),
          totalBorrowed: num(p.totalBorrowed),
          supplyApy: p.supplyApy == null ? null : num(p.supplyApy, null),
          borrowApy: p.borrowApy == null ? null : num(p.borrowApy, null),
          netApy: p.netApy == null ? null : num(p.netApy, null),
          health: p.health == null ? null : num(p.health, null),
        })),
    },
  };
}

function appendLoopSnapshotStore(store, data, maxEntries = 180) {
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
  loopSnapshotBucketKey,
  parseLoopSnapshotBucketTime,
  loopYieldWalletsFromWatcherList,
  buildLoopSnapshotFromRates,
  appendLoopSnapshotStore,
};

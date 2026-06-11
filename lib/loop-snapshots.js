function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

const { isEvmWallet, isSolanaWallet } = require('./loop-solana-rates');

function isWallet(value) {
  return isEvmWallet(value) || isSolanaWallet(value);
}

const LOOP_SNAPSHOT_BUCKET_HOURS = 2;

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
  const snapshotAt = Date.now();
  const key = loopSnapshotBucketKey(snapshotAt);
  return {
    key,
    record: {
      bucket: key,
      fetchedAt: snapshotAt,
      wallets: Array.isArray(data?.wallets) ? data.wallets : [],
      positions: (data?.positions || [])
        .filter(p => num(p?.totalBorrowed) > 0.01)
        .map(p => {
          const netValue = num(p.netValue);
          const merklRewardsUsd = num(p.merklRewardsUsd);
          const merklClaimedUsd = num(p.merklClaimedUsd);
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
            merklClaimedUsd: merklClaimedUsd > 0.01 ? merklClaimedUsd : 0,
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

function trimLoopSnapshotStore(store, maxEntries = 360) {
  const next = { ...(store || {}) };
  const keys = Object.keys(next).sort((a, b) => parseLoopSnapshotBucketTime(a) - parseLoopSnapshotBucketTime(b));
  while (keys.length > maxEntries) {
    delete next[keys.shift()];
  }
  return next;
}

function appendLoopSnapshotStore(store, data, maxEntries = 360) {
  const next = { ...(store || {}) };
  const { key, record } = buildLoopSnapshotFromRates(data);
  if (!record.positions.length) return next;
  if (next[key]) {
    next[key] = { ...next[key], ...record, bucket: key };
  } else {
    next[key] = record;
  }
  return trimLoopSnapshotStore(next, maxEntries);
}

function mergeLoopSnapshotStores(server, client, maxEntries = 360) {
  const next = { ...(server || {}) };
  for (const [key, rec] of Object.entries(client || {})) {
    if (!rec || typeof rec !== 'object') continue;
    const prev = next[key];
    if (!prev || num(rec.fetchedAt, 0) >= num(prev.fetchedAt, 0)) {
      next[key] = rec;
    }
  }
  return trimLoopSnapshotStore(next, maxEntries);
}

function normLoopMarketName(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, '');
}

function isUsdeUsdmLoopSnapshotPosition(pos) {
  const protocol = String(pos?.protocol || '').trim().toLowerCase();
  const market = normLoopMarketName(pos?.marketName);
  const chainId = String(pos?.chainId ?? '');
  if (protocol !== 'aave') return false;
  if (chainId === '4326' && market === 'aavev3megaeth') return true;
  return market.includes('usde') && market.includes('usdm');
}

function purgeLoopSnapshotPositions(store, predicate) {
  const next = {};
  let removedPositions = 0;
  let bucketsAffected = 0;
  for (const [key, rec] of Object.entries(store || {})) {
    if (!rec || typeof rec !== 'object') continue;
    const positions = (rec.positions || []).filter((pos) => {
      if (predicate(pos)) {
        removedPositions += 1;
        return false;
      }
      return true;
    });
    if (positions.length !== (rec.positions || []).length) bucketsAffected += 1;
    if (!positions.length) continue;
    next[key] = { ...rec, positions };
  }
  return { store: next, removedPositions, bucketsAffected };
}

const USDE_USDM_SNAPSHOT_PURGE_FLAG = 'vault:loop_snapshots_usde_usdm_purged';

async function ensureUsdeUsdmSnapshotsPurged({ kvGet, kvSet, parseJson }) {
  if (await kvGet(USDE_USDM_SNAPSHOT_PURGE_FLAG) === '1') {
    return { purged: false, removedPositions: 0, bucketsAffected: 0 };
  }
  const existing = parseJson(await kvGet('vault:loop_snapshots'), {});
  const { store, removedPositions, bucketsAffected } = purgeLoopSnapshotPositions(
    existing,
    isUsdeUsdmLoopSnapshotPosition,
  );
  await kvSet('vault:loop_snapshots', JSON.stringify(store));
  await kvSet(USDE_USDM_SNAPSHOT_PURGE_FLAG, '1');
  return { purged: true, removedPositions, bucketsAffected };
}

module.exports = {
  LOOP_SNAPSHOT_BUCKET_HOURS,
  loopSnapshotBucketKey,
  parseLoopSnapshotBucketTime,
  loopPositionHistoryKey,
  loopYieldWalletsFromWatcherList,
  buildLoopSnapshotFromRates,
  trimLoopSnapshotStore,
  appendLoopSnapshotStore,
  mergeLoopSnapshotStores,
  normLoopMarketName,
  isUsdeUsdmLoopSnapshotPosition,
  purgeLoopSnapshotPositions,
  ensureUsdeUsdmSnapshotsPurged,
  USDE_USDM_SNAPSHOT_PURGE_FLAG,
};

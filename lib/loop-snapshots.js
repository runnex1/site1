function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

const { isEvmWallet, isSolanaWallet } = require('./loop-solana-rates');

function isWallet(value) {
  return isEvmWallet(value) || isSolanaWallet(value);
}

const LOOP_SNAPSHOT_BUCKET_HOURS = 2;
const LOOP_YIELD_WALLETS_KV_KEY = 'vault:loop_yield_wallets';
const LOOP_SNAPSHOTS_KV_KEY = 'vault:loop_snapshots';

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
  const id = String(pos?.id || '').trim().toLowerCase();
  if (!protocol || !wallet || chainId === '') return id || String(pos?.id || '');
  if (protocol === 'fluid' && (id.startsWith('fluid-vault:') || id.startsWith('fluid-lending:'))) return id;
  const marketName = String(pos?.marketName || '').trim().toLowerCase();
  return `${protocol}:${wallet}:${chainId}:${marketName}`;
}

function normalizeLoopYieldWalletList(wallets) {
  return [...new Set((wallets || [])
    .map((w) => String(w || '').trim())
    .filter(isWallet)
    .map((w) => (isEvmWallet(w) ? w.toLowerCase() : w)))];
}

function loopYieldWalletsFromWatcherList(wallets) {
  return normalizeLoopYieldWalletList((wallets || [])
    .filter((w) => String(w?.category || '').toLowerCase() === 'yield')
    .map((w) => String(w?.address || '').trim()));
}

function parseLoopYieldWalletsFromRatesCache(raw) {
  const parsed = typeof raw === 'string'
    ? (() => { try { return JSON.parse(raw); } catch { return null; } })()
    : raw;
  const key = String(parsed?.key || '');
  const match = key.match(/^v\d+:(.+)$/i);
  if (!match) return [];
  return normalizeLoopYieldWalletList(match[1].split(','));
}

function loopYieldWalletsFromSnapshotStore(store) {
  const wallets = new Set();
  for (const rec of Object.values(store || {})) {
    for (const wallet of rec?.wallets || []) {
      const normalized = normalizeLoopYieldWalletList([wallet]);
      normalized.forEach((w) => wallets.add(w));
    }
  }
  return [...wallets];
}

async function resolveLoopYieldWallets({ kvGet, parseJson = JSON.parse }) {
  const lists = [];
  const watcherWallets = parseJson(await kvGet('vault:watcherwallets'), []);
  lists.push(loopYieldWalletsFromWatcherList(watcherWallets));
  lists.push(parseJson(await kvGet(LOOP_YIELD_WALLETS_KV_KEY), []));
  lists.push(parseLoopYieldWalletsFromRatesCache(await kvGet('vault:loop_rates_cache')));
  const snapshots = parseJson(await kvGet(LOOP_SNAPSHOTS_KV_KEY), {});
  lists.push(loopYieldWalletsFromSnapshotStore(snapshots));
  const merged = new Set();
  for (const list of lists) {
    for (const wallet of normalizeLoopYieldWalletList(list)) merged.add(wallet);
  }
  return [...merged];
}

async function persistLoopYieldWallets(kvSet, wallets) {
  const next = normalizeLoopYieldWalletList(wallets);
  if (!next.length) return [];
  await kvSet(LOOP_YIELD_WALLETS_KV_KEY, JSON.stringify(next));
  return next;
}

async function persistLoopSnapshotStore({ kvGet, kvSet, parseJson = JSON.parse, store }) {
  const payload = JSON.stringify(store || {});
  await kvSet(LOOP_SNAPSHOTS_KV_KEY, payload);
  const verify = parseJson(await kvGet(LOOP_SNAPSHOTS_KV_KEY), null);
  if (!verify || typeof verify !== 'object') {
    throw new Error('Loop snapshot verify failed: empty read-back');
  }
  const expectedLatest = Math.max(
    0,
    ...Object.values(store || {}).map((rec) => num(rec?.fetchedAt, 0)),
  );
  const actualLatest = Math.max(
    0,
    ...Object.values(verify).map((rec) => num(rec?.fetchedAt, 0)),
  );
  if (expectedLatest > 0 && actualLatest < expectedLatest) {
    throw new Error(`Loop snapshot verify failed: latest fetchedAt ${actualLatest} < ${expectedLatest}`);
  }
  return {
    bucketCount: Object.keys(verify).length,
    latestFetchedAt: actualLatest || null,
  };
}

function loopSnapshotLegs(legs) {
  return (Array.isArray(legs) ? legs : []).map(leg => ({
    symbol: String(leg?.symbol || '').toUpperCase(),
    amount: num(leg?.amount, null),
    value: num(leg?.value, 0),
    apy: leg?.apy == null ? null : num(leg.apy, null),
    priceUsd: leg?.priceUsd == null ? null : num(leg.priceUsd, null),
  })).filter(leg => num(leg.value) > 0 || num(leg.amount) > 0);
}

function loopSnapshotEligiblePosition(pos) {
  return num(pos?.totalBorrowed) > 0.01 || num(pos?.totalSupplied) > 0.01;
}

function loopSnapshotPositionKey(pos) {
  const id = String(pos?.id || '').trim().toLowerCase();
  if (id) return id;
  const historyKey = String(pos?.historyKey || '').trim().toLowerCase();
  if (historyKey) return historyKey;
  return loopPositionHistoryKey(pos);
}

function mergeLoopSnapshotBucketPositions(existingPositions, incomingPositions) {
  const byKey = new Map();
  for (const pos of existingPositions || []) {
    const key = loopSnapshotPositionKey(pos);
    if (key) byKey.set(key, pos);
  }
  for (const pos of incomingPositions || []) {
    const key = loopSnapshotPositionKey(pos);
    if (key) byKey.set(key, pos);
  }
  return [...byKey.values()];
}

function mergeLoopSnapshotBucketRecords(prev, incoming) {
  if (!prev) return incoming;
  if (!incoming) return prev;
  const prevAt = num(prev.fetchedAt, 0);
  const inAt = num(incoming.fetchedAt, 0);
  const wallets = [...new Set([
    ...(Array.isArray(prev.wallets) ? prev.wallets : []),
    ...(Array.isArray(incoming.wallets) ? incoming.wallets : []),
  ])];
  return {
    ...prev,
    ...incoming,
    bucket: incoming.bucket || prev.bucket,
    fetchedAt: Math.max(prevAt, inAt),
    wallets,
    positions: mergeLoopSnapshotBucketPositions(prev.positions, incoming.positions),
  };
}

function mapLoopSnapshotPosition(p) {
  const netValue = num(p.netValue);
  const merklRewardsUsd = num(p.merklRewardsUsd);
  const merklClaimedUsd = num(p.merklClaimedUsd);
  const totalSupplied = num(p.totalSupplied);
  const totalBorrowed = num(p.totalBorrowed);
  const lendingOnly = Boolean(p.lendingOnly) || (totalBorrowed <= 0.01 && totalSupplied > 0.01);
  const supplyApy = p.supplyApy == null ? null : num(p.supplyApy, null);
  let netApy = p.netApy == null ? null : num(p.netApy, null);
  if (netApy == null && lendingOnly && supplyApy != null) netApy = supplyApy;
  const economicNetValue = num(p.economicNetValue, netValue + merklRewardsUsd);
  return {
    id: String(p.id || '').trim().toLowerCase(),
    historyKey: loopPositionHistoryKey(p),
    protocol: p.protocol,
    marketName: p.marketName,
    wallet: p.wallet,
    chainId: p.chainId,
    netValue,
    merklRewardsUsd: merklRewardsUsd > 0.01 ? merklRewardsUsd : 0,
    merklClaimedUsd: merklClaimedUsd > 0.01 ? merklClaimedUsd : 0,
    economicNetValue,
    totalSupplied,
    totalBorrowed,
    suppliedLegs: loopSnapshotLegs(p.supplied),
    borrowedLegs: loopSnapshotLegs(p.borrowed),
    supplyApy,
    borrowApy: p.borrowApy == null ? null : num(p.borrowApy, null),
    netApy,
    health: p.health == null ? null : num(p.health, null),
    lendingOnly,
  };
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
        .filter(loopSnapshotEligiblePosition)
        .map(mapLoopSnapshotPosition),
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
  next[key] = mergeLoopSnapshotBucketRecords(next[key], record);
  return trimLoopSnapshotStore(next, maxEntries);
}

function mergeLoopSnapshotStores(server, client, maxEntries = 360) {
  const next = { ...(server || {}) };
  for (const [key, rec] of Object.entries(client || {})) {
    if (!rec || typeof rec !== 'object') continue;
    next[key] = mergeLoopSnapshotBucketRecords(next[key], rec);
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
  LOOP_YIELD_WALLETS_KV_KEY,
  LOOP_SNAPSHOTS_KV_KEY,
  loopSnapshotBucketKey,
  parseLoopSnapshotBucketTime,
  loopPositionHistoryKey,
  loopSnapshotPositionKey,
  mergeLoopSnapshotBucketPositions,
  mergeLoopSnapshotBucketRecords,
  normalizeLoopYieldWalletList,
  loopYieldWalletsFromWatcherList,
  parseLoopYieldWalletsFromRatesCache,
  loopYieldWalletsFromSnapshotStore,
  resolveLoopYieldWallets,
  persistLoopYieldWallets,
  persistLoopSnapshotStore,
  loopSnapshotLegs,
  loopSnapshotEligiblePosition,
  mapLoopSnapshotPosition,
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

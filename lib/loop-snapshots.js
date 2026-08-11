const zlib = require('zlib');
const { isEvmWallet, isSolanaWallet } = require('./loop-solana-rates');

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function isWallet(value) {
  return isEvmWallet(value) || isSolanaWallet(value);
}

const LOOP_SNAPSHOT_BUCKET_HOURS = 2;
/** ~30 days at 2h buckets — UI history window. */
const LOOP_SNAPSHOT_MAX_ENTRIES = 360;
/** Gzip+base64 marker for Upstash values (keeps SET under ~10MB without dropping history). */
const LOOP_SNAPSHOT_KV_GZIP_PREFIX = 'gz1:';
const LOOP_YIELD_WALLETS_KV_KEY = 'vault:loop_yield_wallets';
const LOOP_RATES_CACHE_KV_KEY = 'vault:loop_rates_cache';
const LOOP_SNAPSHOTS_KV_KEY = 'vault:loop_snapshots';

function encodeLoopSnapshotStore(store) {
  const json = JSON.stringify(store && typeof store === 'object' ? store : {});
  const gz = zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 9 });
  return LOOP_SNAPSHOT_KV_GZIP_PREFIX + gz.toString('base64');
}

function decodeLoopSnapshotStore(raw) {
  if (raw == null || raw === '') return {};
  if (typeof raw === 'object' && !Buffer.isBuffer(raw)) {
    return raw && typeof raw === 'object' ? raw : {};
  }
  const text = String(raw);
  if (text.startsWith(LOOP_SNAPSHOT_KV_GZIP_PREFIX)) {
    try {
      const buf = Buffer.from(text.slice(LOOP_SNAPSHOT_KV_GZIP_PREFIX.length), 'base64');
      return JSON.parse(zlib.gunzipSync(buf).toString('utf8'));
    } catch {
      return {};
    }
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function loadLoopSnapshotStore(kvGet) {
  return decodeLoopSnapshotStore(await kvGet(LOOP_SNAPSHOTS_KV_KEY));
}

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

/** Zero addresses (0x00..00 / 0x00..01) are protocol artifacts, never real wallets. */
function isZeroLoopWallet(wallet) {
  return /^0x0{40}$/i.test(String(wallet || '').trim()) || /^0x0{39}1$/i.test(String(wallet || '').trim());
}

function normalizeLoopYieldWalletList(wallets) {
  return [...new Set((wallets || [])
    .map((w) => String(w || '').trim())
    .filter(isWallet)
    .filter((w) => !isZeroLoopWallet(w))
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
      normalized.forEach((w) => { if (!isPollutedLoopWallet(w)) wallets.add(w); });
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
  lists.push(loopYieldWalletsFromSnapshotStore(await loadLoopSnapshotStore(kvGet)));
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

async function persistLoopSnapshotStore({ kvGet, kvSet, store }) {
  const trimmed = trimLoopSnapshotStore(store, LOOP_SNAPSHOT_MAX_ENTRIES);
  const payload = encodeLoopSnapshotStore(trimmed);
  await kvSet(LOOP_SNAPSHOTS_KV_KEY, payload);
  const verify = await loadLoopSnapshotStore(kvGet);
  if (!verify || typeof verify !== 'object') {
    throw new Error('Loop snapshot verify failed: empty read-back');
  }
  const expectedLatest = Math.max(
    0,
    ...Object.values(trimmed || {}).map((rec) => num(rec?.fetchedAt, 0)),
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
    encodedBytes: payload.length,
  };
}

function roundLoopNum(value, digits = 4) {
  const n = num(value, null);
  if (n == null) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function loopSnapshotLegs(legs) {
  return (Array.isArray(legs) ? legs : []).map(leg => ({
    symbol: String(leg?.symbol || '').toUpperCase(),
    amount: roundLoopNum(leg?.amount, 6),
    value: roundLoopNum(leg?.value, 2) || 0,
    // Keep amount/value for capital-event detection; drop priceUsd (recomputable).
    apy: leg?.apy == null ? null : roundLoopNum(leg.apy, 4),
  })).filter(leg => num(leg.value) > 0 || num(leg.amount) > 0);
}

function loopSnapshotEligiblePosition(pos) {
  if (isZeroLoopWallet(pos?.wallet)) return false;
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
    pendlePositions: mergeLoopSnapshotBucketPositions(prev.pendlePositions, incoming.pendlePositions),
  };
}

function pendlePositionHistoryKey(row) {
  const wallet = String(row?.wallet || '').trim().toLowerCase();
  const chainId = String(row?.chainId ?? '');
  const marketId = String(row?.marketId || row?.marketAddress || '').trim().toLowerCase();
  const legType = String(row?.legType || '').trim().toUpperCase();
  return `pendle:${wallet}:${chainId}:${marketId}:${legType}`;
}

function mapPendleSnapshotPosition(row, wallet) {
  const valueUsd = num(row?.valueUsd, 0);
  const impliedApy = row?.impliedApy == null ? null : num(row.impliedApy, null);
  const owner = row?.wallet || wallet;
  const snapshot = {
    wallet: owner,
    chainId: row?.chainId,
    marketId: row?.marketId,
    marketAddress: row?.marketAddress,
    legType: row?.legType,
    symbol: row?.symbol,
    marketName: row?.marketName,
    valueUsd,
    impliedApy,
    open: row?.open !== false,
  };
  const id = pendlePositionHistoryKey(snapshot);
  return {
    id,
    historyKey: id,
    protocol: 'Pendle',
    marketName: row?.marketName || row?.symbol || 'Pendle',
    wallet: owner,
    chainId: row?.chainId,
    legType: row?.legType,
    symbol: row?.symbol,
    netValue: valueUsd,
    economicNetValue: valueUsd,
    totalSupplied: valueUsd,
    totalBorrowed: 0,
    supplyApy: impliedApy,
    netApy: impliedApy,
    lendingOnly: true,
    open: row?.open !== false,
  };
}

function pendleSnapshotPositionsFromRates(data) {
  return (data?.pendle?.wallets || [])
    .flatMap((w) => (w.positions || [])
      .filter((p) => p.open !== false && (num(p.valueUsd) > 0.01 || num(p.balanceUnits) > 0))
      .map((p) => mapPendleSnapshotPosition(p, w.wallet)));
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
    netValue: roundLoopNum(netValue, 2) || 0,
    merklRewardsUsd: merklRewardsUsd > 0.01 ? (roundLoopNum(merklRewardsUsd, 2) || 0) : 0,
    merklClaimedUsd: merklClaimedUsd > 0.01 ? (roundLoopNum(merklClaimedUsd, 2) || 0) : 0,
    economicNetValue: roundLoopNum(economicNetValue, 2) || 0,
    totalSupplied: roundLoopNum(totalSupplied, 2) || 0,
    totalBorrowed: roundLoopNum(totalBorrowed, 2) || 0,
    suppliedLegs: loopSnapshotLegs(p.supplied),
    borrowedLegs: loopSnapshotLegs(p.borrowed),
    supplyApy: supplyApy == null ? null : roundLoopNum(supplyApy, 4),
    borrowApy: p.borrowApy == null ? null : roundLoopNum(p.borrowApy, 4),
    netApy: netApy == null ? null : roundLoopNum(netApy, 4),
    health: p.health == null ? null : roundLoopNum(p.health, 4),
    lendingOnly,
  };
}

function buildLoopSnapshotFromRates(data) {
  const snapshotAt = Date.now();
  const key = loopSnapshotBucketKey(snapshotAt);
  const positions = (data?.positions || [])
    .filter(loopSnapshotEligiblePosition)
    .map(mapLoopSnapshotPosition);
  const pendlePositions = pendleSnapshotPositionsFromRates(data);
  return {
    key,
    record: {
      bucket: key,
      fetchedAt: snapshotAt,
      wallets: Array.isArray(data?.wallets) ? data.wallets : [],
      positions,
      pendlePositions,
    },
  };
}

function trimLoopSnapshotStore(store, maxEntries = LOOP_SNAPSHOT_MAX_ENTRIES) {
  const next = { ...(store || {}) };
  const keys = Object.keys(next).sort((a, b) => parseLoopSnapshotBucketTime(a) - parseLoopSnapshotBucketTime(b));
  while (keys.length > maxEntries) {
    delete next[keys.shift()];
  }
  return next;
}

function appendLoopSnapshotStore(store, data, maxEntries = LOOP_SNAPSHOT_MAX_ENTRIES) {
  const next = { ...(store || {}) };
  const { key, record } = buildLoopSnapshotFromRates(data);
  if (!record.positions.length && !record.pendlePositions.length) return next;
  next[key] = mergeLoopSnapshotBucketRecords(next[key], record);
  return trimLoopSnapshotStore(next, maxEntries);
}

function mergeLoopSnapshotStores(server, client, maxEntries = LOOP_SNAPSHOT_MAX_ENTRIES) {
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
  if (market.includes('usde') && market.includes('usdm')) return true;
  const syms = [...(pos?.suppliedLegs || []), ...(pos?.borrowedLegs || [])]
    .map((leg) => String(leg?.symbol || '').trim().toUpperCase());
  const hasStcusd = syms.some((sym) => sym === 'STCUSD' || sym === 'STCUSDC');
  if (hasStcusd) return false;
  const hasUsde = syms.some((sym) => sym === 'USDE');
  const hasUsdm = syms.some((sym) => sym === 'USDM');
  if (hasUsde && hasUsdm) return true;
  return chainId === '4326' && market === 'aavev3megaeth';
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

async function ensureUsdeUsdmSnapshotsPurged({ kvGet, kvSet }) {
  if (await kvGet(USDE_USDM_SNAPSHOT_PURGE_FLAG) === '1') {
    return { purged: false, removedPositions: 0, bucketsAffected: 0 };
  }
  const existing = await loadLoopSnapshotStore(kvGet);
  const { store, removedPositions, bucketsAffected } = purgeLoopSnapshotPositions(
    existing,
    isUsdeUsdmLoopSnapshotPosition,
  );
  await persistLoopSnapshotStore({ kvGet, kvSet, store });
  await kvSet(USDE_USDM_SNAPSHOT_PURGE_FLAG, '1');
  return { purged: true, removedPositions, bucketsAffected };
}

/** Wallets that were never configured but leaked into the snapshot store via
 * `loopYieldWalletsFromSnapshotStore` self-perpetuation (protocol-level artifacts). */
const LOOP_POLLUTED_WALLETS = [
  '0x0000000000000000000000000000000000000001',
  '0x1601843c5e9bc251a3272907010afa41fa18347e',
];

function isPollutedLoopWallet(wallet) {
  const w = String(wallet || '').trim().toLowerCase();
  return LOOP_POLLUTED_WALLETS.includes(w) || isZeroLoopWallet(w);
}

const LOOP_SNAPSHOT_POLLUTION_PURGE_FLAG = 'vault:loop_snapshots_pollution_purged';

/** One-shot cleanup: strip polluted wallets from every bucket (positions +
 * wallets arrays), and scrub them from the wallet registry + rates-cache key
 * so `resolveLoopYieldWallets` can never re-inject them. */
async function ensureLoopSnapshotWalletPollutionPurged({ kvGet, kvSet, kvDel }) {
  if (await kvGet(LOOP_SNAPSHOT_POLLUTION_PURGE_FLAG) === '1') {
    return { purged: false, removedPositions: 0, bucketsAffected: 0 };
  }
  const existing = await loadLoopSnapshotStore(kvGet);
  let removedPositions = 0;
  let bucketsAffected = 0;
  const store = {};
  for (const [key, rec] of Object.entries(existing || {})) {
    if (!rec || typeof rec !== 'object') continue;
    const positions = (rec.positions || []).filter((pos) => {
      if (isPollutedLoopWallet(pos?.wallet)) {
        removedPositions += 1;
        return false;
      }
      return true;
    });
    const wallets = (rec.wallets || []).filter((w) => !isPollutedLoopWallet(w));
    const pendlePositions = (rec.pendlePositions || []).filter((pos) => !isPollutedLoopWallet(pos?.wallet));
    if (positions.length !== (rec.positions || []).length
      || wallets.length !== (rec.wallets || []).length
      || pendlePositions.length !== (rec.pendlePositions || []).length) {
      bucketsAffected += 1;
    }
    if (!positions.length && !pendlePositions.length) continue;
    store[key] = { ...rec, positions, wallets, pendlePositions };
  }
  await persistLoopSnapshotStore({ kvGet, kvSet, store });
  const registryRaw = await kvGet(LOOP_YIELD_WALLETS_KV_KEY);
  const registry = typeof registryRaw === 'string'
    ? (() => { try { return JSON.parse(registryRaw); } catch { return []; } })()
    : Array.isArray(registryRaw) ? registryRaw : [];
  if (registry.some(isPollutedLoopWallet)) {
    await persistLoopYieldWallets(kvSet, registry.filter((w) => !isPollutedLoopWallet(w)));
  }
  if (kvDel) await kvDel(LOOP_RATES_CACHE_KV_KEY);
  await kvSet(LOOP_SNAPSHOT_POLLUTION_PURGE_FLAG, '1');
  return { purged: true, removedPositions, bucketsAffected };
}

/**
 * Migrate plain-JSON vault:loop_snapshots → gzip without dropping buckets.
 * Safe to call on Loops hydrate; API still returns uncompressed JSON to clients.
 */
async function ensureLoopSnapshotsCompressed({ kvGet, kvSet }) {
  const raw = await kvGet(LOOP_SNAPSHOTS_KV_KEY);
  if (raw == null || raw === '') {
    return { rewritten: false, beforeBytes: 0, afterBytes: 0, bucketCount: 0 };
  }
  const rawText = typeof raw === 'string' ? raw : JSON.stringify(raw);
  if (rawText.startsWith(LOOP_SNAPSHOT_KV_GZIP_PREFIX)) {
    const store = decodeLoopSnapshotStore(rawText);
    return {
      rewritten: false,
      beforeBytes: rawText.length,
      afterBytes: rawText.length,
      bucketCount: Object.keys(store || {}).length,
    };
  }
  const store = decodeLoopSnapshotStore(rawText);
  const persisted = await persistLoopSnapshotStore({ kvGet, kvSet, store });
  return {
    rewritten: true,
    beforeBytes: rawText.length,
    afterBytes: persisted.encodedBytes || 0,
    bucketCount: persisted.bucketCount,
  };
}

module.exports = {
  LOOP_SNAPSHOT_BUCKET_HOURS,
  LOOP_SNAPSHOT_MAX_ENTRIES,
  LOOP_SNAPSHOT_KV_GZIP_PREFIX,
  LOOP_YIELD_WALLETS_KV_KEY,
  LOOP_SNAPSHOTS_KV_KEY,
  encodeLoopSnapshotStore,
  decodeLoopSnapshotStore,
  loadLoopSnapshotStore,
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
  mapPendleSnapshotPosition,
  pendlePositionHistoryKey,
  pendleSnapshotPositionsFromRates,
  buildLoopSnapshotFromRates,
  trimLoopSnapshotStore,
  appendLoopSnapshotStore,
  mergeLoopSnapshotStores,
  normLoopMarketName,
  isUsdeUsdmLoopSnapshotPosition,
  purgeLoopSnapshotPositions,
  ensureUsdeUsdmSnapshotsPurged,
  ensureLoopSnapshotWalletPollutionPurged,
  isZeroLoopWallet,
  isPollutedLoopWallet,
  LOOP_POLLUTED_WALLETS,
  LOOP_SNAPSHOT_POLLUTION_PURGE_FLAG,
  ensureLoopSnapshotsCompressed,
  USDE_USDM_SNAPSHOT_PURGE_FLAG,
};

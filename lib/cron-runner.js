const { kvGet, kvSet, kvDel } = require('./kv');
const { collectEvents } = require('./event-log');
const runCheckAlerts = require('./check-alerts-run');
const {
  fetchPerpsLiveRates,
  fetchPerpsEquitySnapshot,
  appendEquitySnapshotStore,
  buildEquitySnapshotFromDashboard,
} = require('./perps');
const { fetchLoopRates, mergeRecentLoopPositions } = require('./loop-rates');
const {
  appendLoopSnapshotStore,
  buildLoopSnapshotFromRates,
  loopYieldWalletsFromWatcherList,
} = require('./loop-snapshots');
const { ensureLoopLogoCache } = require('./logo-resolver');

const JOBS = {
  predictionActivity: { everyMs: 60 * 1000, maxRuntimeMs: 55 * 1000 },
  perpsLive: { everyMs: 60 * 1000, maxRuntimeMs: 55 * 1000 },
  fundingRates: { everyMs: 60 * 60 * 1000, minute: 2, maxRuntimeMs: 55 * 1000 },
  loopsSync: { everyMs: 5 * 60 * 1000, maxRuntimeMs: 55 * 1000 },
  equitySnapshot: { everyMs: 4 * 60 * 60 * 1000, maxRuntimeMs: 55 * 1000 },
  checkAlerts: { everyMs: 5 * 60 * 1000, maxRuntimeMs: 55 * 1000 },
};

const STATE_KEY_PREFIX = 'cron:last:';
const LOCK_KEY_PREFIX = 'cron:lock:';
const CACHE_KEYS = {
  perpsLive: 'vault:perps_live_rates',
  fundingRates: 'vault:perps_funding_rates',
  loopRates: 'vault:loop_rates_cache',
};
const LOOP_RATES_CACHE_VERSION = 'v2';

function parseJson(raw, fallback) {
  if (!raw) return fallback;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return fallback; }
}

function isWallet(v) {
  return typeof v === 'string' && /^0x[a-fA-F0-9]{40}$/.test(v.trim());
}

function nowIso(ms = Date.now()) {
  return new Date(ms).toISOString();
}

function errorMessage(e) {
  return e?.message || String(e || 'Unknown error');
}

function stateKey(job) {
  return `${STATE_KEY_PREFIX}${job}`;
}

function lockKey(job) {
  return `${LOCK_KEY_PREFIX}${job}`;
}

function nextHourlyMinute(now, minute) {
  const next = new Date(now);
  next.setUTCMinutes(minute, 0, 0);
  if (next.getTime() <= now) next.setUTCHours(next.getUTCHours() + 1);
  return next.getTime();
}

function hourlySlotAtOrBefore(now, minute) {
  const slot = new Date(now);
  slot.setUTCMinutes(minute, 0, 0);
  if (slot.getTime() > now) slot.setUTCHours(slot.getUTCHours() - 1);
  return slot.getTime();
}

function nextDueFrom(lastSuccess, spec, now = Date.now()) {
  const last = Number(lastSuccess || 0);
  if (Number.isFinite(spec.minute)) {
    if (!last) {
      const thisHour = new Date(now);
      thisHour.setUTCMinutes(spec.minute, 0, 0);
      return thisHour.getTime() <= now ? thisHour.getTime() : nextHourlyMinute(now, spec.minute);
    }
    return nextHourlyMinute(last, spec.minute);
  }
  return last ? last + spec.everyMs : 0;
}

function lastRunFromState(state) {
  return Math.max(Number(state?.lastSuccess || 0), Number(state?.lastFailure || 0));
}

function isDue(job, state, now = Date.now()) {
  const spec = JOBS[job];
  const lastSuccess = Number(state?.lastSuccess || 0);
  const lastRun = lastRunFromState(state);
  if (!lastRun) {
    if (Number.isFinite(spec.minute)) {
      const thisHour = new Date(now);
      thisHour.setUTCMinutes(spec.minute, 0, 0);
      return now >= thisHour.getTime();
    }
    return true;
  }
  if (Number.isFinite(spec.minute)) {
    const currentSlot = hourlySlotAtOrBefore(now, spec.minute);
    return lastRun < currentSlot && now >= currentSlot;
  }
  return now - lastRun >= spec.everyMs;
}

function overdueBy(job, state, now = Date.now()) {
  const dueAt = nextDueFrom(lastRunFromState(state), JOBS[job], now);
  if (!dueAt) return Number.MAX_SAFE_INTEGER;
  return Math.max(0, now - dueAt);
}

async function readJobState(job) {
  return parseJson(await kvGet(stateKey(job)), {});
}

async function writeJobState(job, patch) {
  const previous = await readJobState(job);
  const next = { ...previous, ...patch, updatedAt: Date.now() };
  await kvSet(stateKey(job), JSON.stringify(next));
  return next;
}

async function readLock(job) {
  return parseJson(await kvGet(lockKey(job)), null);
}

async function acquireLock(job, now = Date.now()) {
  const lock = await readLock(job);
  if (lock?.expiresAt && Number(lock.expiresAt) > now) return null;
  const token = `${now}:${Math.random().toString(36).slice(2)}`;
  const next = {
    token,
    startedAt: now,
    expiresAt: now + (JOBS[job]?.maxRuntimeMs || 55000),
  };
  await kvSet(lockKey(job), JSON.stringify(next));
  return next;
}

async function releaseLock(job, lock) {
  const current = await readLock(job);
  if (!current || current.token === lock?.token) await kvDel(lockKey(job));
}

function uniqueSymbols(...groups) {
  return [...new Set(groups.flat()
    .map(s => String(s || '').trim().toUpperCase())
    .filter(Boolean)
    .map(s => s.replace(/-PERP$/i, '')))];
}

async function loadPerpsConfig() {
  const savedConfig = parseJson(await kvGet('vault:perps_config'), {});
  const portfolio = parseJson(await kvGet('vault:portfolio'), {});
  const portfolioConfig = portfolio?.perpsArb && typeof portfolio.perpsArb === 'object'
    ? portfolio.perpsArb
    : {};
  const config = isWallet(savedConfig.hyperliquid) ? savedConfig : portfolioConfig;
  const hyperliquid = String(config.hyperliquid || '').trim();
  if (!isWallet(hyperliquid)) return null;
  return {
    ...config,
    hyperliquid,
    nado: String(config.nado || hyperliquid).trim(),
    grvtSubAccount: String(
      config.grvtSubAccount || process.env.GRVT_SUB_ACCOUNT_ID || '4860249204328359',
    ).trim(),
    days: Math.min(365, Math.max(1, parseInt(config.days || '30', 10) || 30)),
  };
}

async function loadPerpsSymbols(config) {
  const cachedLive = parseJson(await kvGet(CACHE_KEYS.perpsLive), {});
  const cachedFunding = parseJson(await kvGet(CACHE_KEYS.fundingRates), {});
  const savedSymbols = parseJson(await kvGet('vault:perps_symbols'), []);
  return uniqueSymbols(
    config?.symbols,
    savedSymbols,
    cachedLive?.data?.rateSpread?.map(r => r.symbol),
    cachedFunding?.data?.rateSpread?.map(r => r.symbol),
    ['BTC', 'ETH', 'SOL'],
  );
}

async function runPredictionActivity() {
  const result = await collectEvents({ force: false });
  return {
    itemCount: Array.isArray(result.items) ? result.items.length : 0,
    added: Number(result.added || 0),
    cached: Boolean(result.cached),
  };
}

async function runCheckAlertsJob() {
  return new Promise((resolve) => {
    const req = {
      method: 'GET',
      query: {},
      headers: {
        'x-cron-secret': process.env.CRON_SECRET || '',
        authorization: process.env.CRON_SECRET ? `Bearer ${process.env.CRON_SECRET}` : '',
      },
    };
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(name, value) { this.headers[name] = value; },
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, body }); return this; },
      end() { resolve({ status: this.statusCode, body: null }); return this; },
    };
    Promise.resolve(runCheckAlerts(req, res)).catch(e => resolve({
      status: 500,
      body: { error: errorMessage(e) },
    }));
  });
}

async function runPerpsLive({ funding = false } = {}) {
  const config = await loadPerpsConfig();
  if (!config) return { skipped: true, reason: 'no_perps_config' };
  const symbols = await loadPerpsSymbols(config);
  const data = await fetchPerpsLiveRates({
    grvtSubAccount: config.grvtSubAccount,
    symbols,
  });
  const cacheKey = `${config.grvtSubAccount}:${symbols.slice().sort().join(',')}`;
  const payload = {
    key: cacheKey,
    fetchedAt: Date.now(),
    data,
  };
  await kvSet(funding ? CACHE_KEYS.fundingRates : CACHE_KEYS.perpsLive, JSON.stringify(payload));
  return {
    symbolCount: symbols.length,
    rateCount: Array.isArray(data.rateSpread) ? data.rateSpread.length : 0,
    fetchedAt: data.fetchedAt,
  };
}

async function runLoopsSync() {
  const watcherWallets = parseJson(await kvGet('vault:watcherwallets'), []);
  const wallets = loopYieldWalletsFromWatcherList(watcherWallets);
  if (!wallets.length) return { skipped: true, reason: 'no_yield_wallets' };
  const previousCache = parseJson(await kvGet(CACHE_KEYS.loopRates), null);
  const freshData = await fetchLoopRates({ wallets });
  const data = mergeRecentLoopPositions(freshData, previousCache?.data, {
    previousFetchedAt: previousCache?.fetchedAt,
  });
  const savedSnapshots = parseJson(await kvGet('vault:loop_snapshots'), {});
  const store = appendLoopSnapshotStore(savedSnapshots, data);
  await kvSet('vault:loop_snapshots', JSON.stringify(store));
  const { key, record } = buildLoopSnapshotFromRates(data);
  const savedLogos = parseJson(await kvGet('vault:logo_cache'), {});
  const { cache, changed } = await ensureLoopLogoCache(savedLogos, data.positions, { maxResolve: 0 });
  if (changed) await kvSet('vault:logo_cache', JSON.stringify(cache));
  await kvSet(CACHE_KEYS.loopRates, JSON.stringify({
    key: `${LOOP_RATES_CACHE_VERSION}:${wallets.map(w => w.toLowerCase()).sort().join(',')}`,
    fetchedAt: Date.now(),
    data,
  }));
  return {
    walletCount: wallets.length,
    positionCount: Array.isArray(data.positions) ? data.positions.length : 0,
    bucket: key,
    snapshotPositionCount: record.positions.length,
    snapshotCount: Object.keys(store).length,
    logosUpdated: changed,
  };
}

async function runEquitySnapshot() {
  const config = await loadPerpsConfig();
  if (!config) return { skipped: true, reason: 'no_perps_config' };
  const savedSnapshots = parseJson(await kvGet('vault:perps_snapshots'), {});
  const previousSnapshot = Object.values(savedSnapshots)
    .sort((a, b) => (Number(a?.fetchedAt) || 0) - (Number(b?.fetchedAt) || 0))
    .at(-1);
  const data = await fetchPerpsEquitySnapshot({
    hyperliquid: config.hyperliquid,
    nado: config.nado,
    grvtSubAccount: config.grvtSubAccount,
    cumulativeNetDeposits: Number(previousSnapshot?.cumulativeNetDeposits) || 0,
  });
  const store = appendEquitySnapshotStore(savedSnapshots, data);
  await kvSet('vault:perps_snapshots', JSON.stringify(store));
  const { key, record } = buildEquitySnapshotFromDashboard(data);
  return {
    bucket: key,
    totalEquity: record.totalEquity,
    fetchedAt: record.fetchedAt,
    equityCollectionSpanMs: record.equityCollectionSpanMs,
    snapshotCount: Object.keys(store).length,
  };
}

async function runJobBody(job) {
  if (job === 'predictionActivity') return runPredictionActivity();
  if (job === 'checkAlerts') return runCheckAlertsJob();
  if (job === 'perpsLive') return runPerpsLive();
  if (job === 'fundingRates') return runPerpsLive({ funding: true });
  if (job === 'loopsSync') return runLoopsSync();
  if (job === 'equitySnapshot') return runEquitySnapshot();
  throw new Error(`Unknown cron job: ${job}`);
}

async function runJob(job) {
  const startedAt = Date.now();
  const lock = await acquireLock(job, startedAt);
  if (!lock) {
    const current = await readLock(job);
    return { job, skipped: true, reason: 'locked', lock: current };
  }
  await writeJobState(job, { lastStarted: startedAt, running: true });
  try {
    let result;
    try {
      result = await runJobBody(job);
    } catch (firstError) {
      result = await runJobBody(job).catch(secondError => {
        const e = new Error(`${errorMessage(firstError)}; retry failed: ${errorMessage(secondError)}`);
        e.firstError = firstError;
        e.secondError = secondError;
        throw e;
      });
    }
    const durationMs = Date.now() - startedAt;
    await writeJobState(job, {
      running: false,
      lastSuccess: Date.now(),
      lastDurationMs: durationMs,
      lastError: null,
      warning: null,
      lastResult: result,
    });
    return { job, ok: true, durationMs, result };
  } catch (e) {
    const durationMs = Date.now() - startedAt;
    await writeJobState(job, {
      running: false,
      lastFailure: Date.now(),
      lastDurationMs: durationMs,
      lastError: errorMessage(e),
      warning: `Retry failed for ${job}: ${errorMessage(e)}`,
    });
    return { job, ok: false, durationMs, error: errorMessage(e) };
  } finally {
    await releaseLock(job, lock);
  }
}

async function runDueJobs({ maxJobs = 2 } = {}) {
  const now = Date.now();
  const states = {};
  for (const job of Object.keys(JOBS)) states[job] = await readJobState(job);
  const due = Object.keys(JOBS)
    .filter(job => isDue(job, states[job], now))
    .sort((a, b) => overdueBy(b, states[b], now) - overdueBy(a, states[a], now));
  const selected = due.slice(0, Math.max(1, maxJobs));
  const results = [];
  for (const job of selected) results.push(await runJob(job));
  return {
    ok: results.every(r => r.ok !== false),
    checkedAt: now,
    checkedAtIso: nowIso(now),
    due,
    ran: results,
    skippedDueToLimit: due.slice(selected.length),
  };
}

async function getCronStatus() {
  const now = Date.now();
  const jobs = {};
  for (const [job, spec] of Object.entries(JOBS)) {
    const [state, lock] = await Promise.all([readJobState(job), readLock(job)]);
    const nextDue = nextDueFrom(lastRunFromState(state), spec, now);
    jobs[job] = {
      schedule: Number.isFinite(spec.minute) ? `hourly at :${String(spec.minute).padStart(2, '0')} UTC` : `every ${Math.round(spec.everyMs / 60000)}m`,
      lastStarted: state?.lastStarted || null,
      lastStartedIso: state?.lastStarted ? nowIso(state.lastStarted) : null,
      lastSuccess: state?.lastSuccess || null,
      lastSuccessIso: state?.lastSuccess ? nowIso(state.lastSuccess) : null,
      lastFailure: state?.lastFailure || null,
      lastFailureIso: state?.lastFailure ? nowIso(state.lastFailure) : null,
      lastDurationMs: state?.lastDurationMs ?? null,
      lastError: state?.lastError || null,
      warning: state?.warning || null,
      nextDue,
      nextDueIso: nextDue ? nowIso(nextDue) : null,
      due: isDue(job, state, now),
      locked: Boolean(lock?.expiresAt && Number(lock.expiresAt) > now),
      lock: lock || null,
      lastResult: state?.lastResult || null,
    };
  }
  return { ok: true, checkedAt: now, checkedAtIso: nowIso(now), jobs };
}

module.exports = {
  JOBS,
  CACHE_KEYS,
  parseJson,
  runDueJobs,
  getCronStatus,
};

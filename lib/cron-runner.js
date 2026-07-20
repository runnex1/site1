const { kvGet, kvSet, kvDel } = require('./kv');
const {
  fetchPerpsEquitySnapshotWithVariational,
  appendEquitySnapshotStore,
  buildEquitySnapshotFromDashboard,
} = require('./perps');
const { fetchLoopRates, mergeRecentLoopPositions } = require('./loop-rates');
const {
  appendLoopSnapshotStore,
  buildLoopSnapshotFromRates,
  resolveLoopYieldWallets,
  persistLoopYieldWallets,
  persistLoopSnapshotStore,
} = require('./loop-snapshots');
const { ensureLoopLogoCache } = require('./logo-resolver');
const { updateEtfPortfolioPrices } = require('./etf-update-run');

// Lightweight tick jobs only. Alerts → /api/check-alerts (cron-job.org).
// Loop 2h snapshots → /api/loop-cron-snapshot. Perps equity → /api/perps?cronSnapshot=1.
// Removed: perpsLive, fundingRates (UI never reads KV cache), predictionActivity
// (check-alerts already calls collectEvents), checkAlerts (dedicated endpoint).
const JOBS = {
  loopsSync: { everyMs: 15 * 60 * 1000, retryMs: 10 * 60 * 1000, maxRuntimeMs: 55 * 1000 },
  etfStockUpdate: { everyMs: 60 * 60 * 1000, retryMs: 10 * 60 * 1000, maxRuntimeMs: 55 * 1000 },
  equitySnapshot: { everyMs: 4 * 60 * 60 * 1000, retryMs: 15 * 60 * 1000, maxRuntimeMs: 55 * 1000 },
};

const STATE_KEY_PREFIX = 'cron:last:';
const LOCK_KEY_PREFIX = 'cron:lock:';
const CACHE_KEYS = {
  perpsLive: 'vault:perps_live_rates',
  loopRates: 'vault:loop_rates_cache',
};
const LOOP_RATES_CACHE_VERSION = 'v7';

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

function appBaseUrl() {
  const explicit = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || process.env.URL || '';
  if (/^https?:\/\//i.test(explicit)) return explicit.replace(/\/+$/, '');
  return 'https://testedefi.vercel.app';
}

function syncSecret() {
  return process.env.SYNC_SECRET || '';
}

function stateKey(job) {
  return `${STATE_KEY_PREFIX}${job}`;
}

function lockKey(job) {
  return `${LOCK_KEY_PREFIX}${job}`;
}

function nextDueFrom(lastSuccess, spec, now = Date.now()) {
  const last = Number(lastSuccess || 0);
  return last ? last + spec.everyMs : 0;
}

function nextRetryFromFailure(state, spec) {
  const lastFailure = Number(state?.lastFailure || 0);
  const lastSuccess = Number(state?.lastSuccess || 0);
  if (!lastFailure || lastFailure <= lastSuccess) return 0;
  return lastFailure + Number(spec.retryMs || Math.min(spec.everyMs || 60000, 5 * 60000));
}

function lastRunFromState(state) {
  return Math.max(Number(state?.lastSuccess || 0), Number(state?.lastFailure || 0));
}

function isDue(job, state, now = Date.now()) {
  const spec = JOBS[job];
  const retryAt = nextRetryFromFailure(state, spec);
  if (retryAt) return now >= retryAt;
  const lastRun = lastRunFromState(state);
  if (!lastRun) return true;
  return now - lastRun >= spec.everyMs;
}

function overdueBy(job, state, now = Date.now()) {
  const retryAt = nextRetryFromFailure(state, JOBS[job]);
  const dueAt = retryAt || nextDueFrom(lastRunFromState(state), JOBS[job], now);
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

async function runLoopsSync() {
  const wallets = await resolveLoopYieldWallets({ kvGet, parseJson });
  if (!wallets.length) return { skipped: true, reason: 'no_yield_wallets' };
  const previousCache = parseJson(await kvGet(CACHE_KEYS.loopRates), null);
  const freshData = await fetchLoopRates({ wallets });
  const data = mergeRecentLoopPositions(freshData, previousCache?.data, {
    previousFetchedAt: previousCache?.fetchedAt,
  });
  const savedSnapshots = parseJson(await kvGet('vault:loop_snapshots'), {});
  const store = appendLoopSnapshotStore(savedSnapshots, data);
  const persisted = await persistLoopSnapshotStore({ kvGet, kvSet, parseJson, store });
  const { key, record } = buildLoopSnapshotFromRates(data);
  const savedLogos = parseJson(await kvGet('vault:logo_cache'), {});
  const { cache, changed } = await ensureLoopLogoCache(savedLogos, data.positions, { maxResolve: 0 });
  if (changed) await kvSet('vault:logo_cache', JSON.stringify(cache));
  await persistLoopYieldWallets(kvSet, wallets);
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
    snapshotCount: persisted.bucketCount,
    latestFetchedAt: persisted.latestFetchedAt,
    logosUpdated: changed,
  };
}

async function runEquitySnapshot() {
  const secret = syncSecret();
  if (secret) {
    const url = `${appBaseUrl()}/api/perps?cronSnapshot=1`;
    const response = await fetch(url, {
      headers: { 'x-sync-secret': secret, Accept: 'application/json' },
      signal: AbortSignal.timeout(55000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body?.error || `Perps cron snapshot returned HTTP ${response.status}`);
    }
    return { ...body, via: 'perps-cron-endpoint' };
  }

  const config = await loadPerpsConfig();
  if (!config) return { skipped: true, reason: 'no_perps_config' };
  const savedSnapshots = parseJson(await kvGet('vault:perps_snapshots'), {});
  const previousSnapshot = Object.values(savedSnapshots)
    .sort((a, b) => (Number(a?.fetchedAt) || 0) - (Number(b?.fetchedAt) || 0))
    .at(-1);
  const hedges = parseJson(await kvGet('vault:perps_variational_hedges'), []);
  const closedPairs = parseJson(await kvGet('vault:perps_closed_pairs'), []);
  const data = await fetchPerpsEquitySnapshotWithVariational({
    hyperliquid: config.hyperliquid,
    nado: config.nado,
    grvtSubAccount: config.grvtSubAccount,
    cumulativeNetDeposits: Number(previousSnapshot?.cumulativeNetDeposits) || 0,
  }, { hedges, closedPairs });
  const store = appendEquitySnapshotStore(savedSnapshots, data);
  await kvSet('vault:perps_snapshots', JSON.stringify(store));
  const { key, record } = buildEquitySnapshotFromDashboard(data);
  return {
    bucket: key,
    totalEquity: record.totalEquity,
    variationalEquityAdjust: record.variationalEquityAdjust ?? null,
    fetchedAt: record.fetchedAt,
    equityCollectionSpanMs: record.equityCollectionSpanMs,
    snapshotCount: Object.keys(store).length,
  };
}

async function runJobBody(job) {
  if (job === 'etfStockUpdate') return updateEtfPortfolioPrices();
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
      lastResult: summarizeCronJobResult(job, result),
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

async function runDueJobs({ maxJobs = 1 } = {}) {
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

function summarizeCronJobResult(job, result) {
  if (!result || typeof result !== 'object') return result ?? null;
  if (job === 'loopsSync') {
    return {
      skipped: result.skipped || undefined,
      reason: result.reason || undefined,
      walletCount: result.walletCount,
      positionCount: result.positionCount,
      bucket: result.bucket,
      snapshotPositionCount: result.snapshotPositionCount,
      snapshotCount: result.snapshotCount,
      latestFetchedAt: result.latestFetchedAt,
      logosUpdated: result.logosUpdated,
    };
  }
  if (job === 'etfStockUpdate') {
    return {
      ok: result.ok,
      updated: result.updated,
      quoteFailures: result.quoteFailures,
      dcaApplied: result.dcaApplied,
      today: result.today,
      total: result.total,
      skipped: result.skipped || undefined,
      reason: result.reason || undefined,
    };
  }
  if (job === 'equitySnapshot') {
    return {
      skipped: result.skipped || undefined,
      reason: result.reason || undefined,
      bucket: result.bucket,
      totalEquity: result.totalEquity,
      variationalEquityAdjust: result.variationalEquityAdjust,
      fetchedAt: result.fetchedAt,
      snapshotCount: result.snapshotCount,
      via: result.via,
    };
  }
  return result;
}

async function getCronStatus() {
  const now = Date.now();
  const jobs = {};
  for (const [job, spec] of Object.entries(JOBS)) {
    const [state, lock] = await Promise.all([readJobState(job), readLock(job)]);
    const nextDue = nextRetryFromFailure(state, spec) || nextDueFrom(lastRunFromState(state), spec, now);
    jobs[job] = {
      schedule: `every ${Math.round(spec.everyMs / 60000)}m`,
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
      lastResult: summarizeCronJobResult(job, state?.lastResult),
    };
  }
  return { ok: true, checkedAt: now, checkedAtIso: nowIso(now), jobs };
}

function compactCronTickPayload(payload) {
  return {
    ok: payload.ok,
    checkedAt: payload.checkedAt,
    checkedAtIso: payload.checkedAtIso,
    due: payload.due,
    skippedDueToLimit: payload.skippedDueToLimit,
    ran: (payload.ran || []).map((entry) => ({
      job: entry.job,
      ok: entry.ok,
      skipped: entry.skipped,
      reason: entry.reason,
      durationMs: entry.durationMs,
      error: entry.error || undefined,
      result: summarizeCronJobResult(entry.job, entry.result),
    })),
  };
}

module.exports = {
  JOBS,
  CACHE_KEYS,
  parseJson,
  summarizeCronJobResult,
  compactCronTickPayload,
  runDueJobs,
  getCronStatus,
};

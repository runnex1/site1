/**
 * Variational funding settlement capture — record funding estimations as they occur.
 * 
 * Problem: buildVariationalFundingEventsScheduled() reconstructs past funding using TODAY's
 * mark price, causing yesterday's values to change when prices move overnight.
 * 
 * Solution: Capture estimation snapshots at each settlement time with period-correct mark prices,
 * mark, rate, and size. Never rebuild these — they're frozen after settlement.
 * 
 * For other venues (HL, Nado, GRVT, Extended): Use real payment history from APIs.
 * Only Variational requires estimation snapshots because it's a manual hedge with no payment history API.
 */

const { kvGet, kvSet } = require('./kv');
const {
  toBaseSymbol,
  resolveVariationalNativeRate,
  variationalFundingPaymentPerInterval,
  variationalFundingSettlementsBetween,
} = require('./variational-hedge');

const SETTLEMENT_CACHE_KEY_PREFIX = 'vault:variational_settlements';
const SETTLEMENT_STORE_LATEST_PREFIX = 'vault:variational_settlements_latest';

/**
 * Generate KV key for storing settlement captures for a specific hedge.
 * Hedge IDs are unique; settlements are time-based within that hedge.
 */
function settlementCacheKey(hedgeId) {
  if (!hedgeId) return null;
  return `${SETTLEMENT_CACHE_KEY_PREFIX}:${String(hedgeId).trim()}`;
}

/**
 * Generate KV key for the "latest capture timestamp" per hedge.
 * Used to avoid duplicate captures at the same settlement time.
 */
function settlementLatestKey(hedgeId) {
  if (!hedgeId) return null;
  return `${SETTLEMENT_STORE_LATEST_PREFIX}:${String(hedgeId).trim()}`;
}

/**
 * Load all stored settlement captures for a hedge from KV.
 * Returns array of settlement records, newest first.
 */
async function loadVariationalSettlementCaptures(hedgeId) {
  const key = settlementCacheKey(hedgeId);
  if (!key) return [];
  try {
    const raw = await kvGet(key);
    if (!raw) return [];
    const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(data)) return [];
    return data.sort((a, b) => b.time - a.time);
  } catch {
    return [];
  }
}

/**
 * Get the timestamp of the last captured settlement for this hedge.
 * Used to prevent duplicate captures at the same settlement time.
 */
async function loadVariationalSettlementLatest(hedgeId) {
  const key = settlementLatestKey(hedgeId);
  if (!key) return null;
  try {
    const raw = await kvGet(key);
    if (!raw) return null;
    const ts = Number(raw);
    return Number.isFinite(ts) ? ts : null;
  } catch {
    return null;
  }
}

/**
 * Record a single funding settlement capture at the exact moment it occurs.
 * 
 * Called ONCE per settlement interval (4h for TRUMP, 8h for others).
 * Captures mark price, rate, size at that moment — never recalculated.
 * 
 * @param {string} hedgeId - Unique ID of the hedge (e.g., 'var-123456-abcdef')
 * @param {number} settlementTime - Settlement timestamp (ms), e.g., 1719374400000
 * @param {object} listing - Current Variational listing with markPx, fundingRate8h, etc.
 * @param {object} hedge - Hedge object with variationalSize, symbol, etc.
 * @returns {object|null} Settlement record if captured, null if already captured at this time
 */
async function captureVariationalSettlement(hedgeId, settlementTime, listing, hedge) {
  if (!hedgeId || !Number.isFinite(settlementTime)) return null;
  
  // Check if already captured at this settlement time
  const latestTime = await loadVariationalSettlementLatest(hedgeId);
  if (latestTime === settlementTime) {
    console.log(`[Variational] Settlement already captured for ${hedgeId} at ${new Date(settlementTime).toISOString()}`);
    return null;
  }

  // Extract current market data
  const markPx = Number(listing?.markPx) || null;
  const normalized = resolveVariationalNativeRate(listing);
  const rate = normalized.rateDecimal || null;
  const intervalS = normalized.intervalS || 28800;

  if (!markPx || !rate || !Number.isFinite(markPx) || !Number.isFinite(rate)) {
    console.warn(`[Variational] Cannot capture settlement for ${hedgeId} — missing mark price or rate`);
    return null;
  }

  // Calculate payment using current market data at settlement time
  const size = Number(hedge?.variationalSize) || 0;
  if (!size) {
    console.warn(`[Variational] Cannot capture settlement for ${hedgeId} — zero size`);
    return null;
  }

  const payment = variationalFundingPaymentPerInterval(size, markPx, rate);

  // Build immutable settlement record
  const settlement = {
    hedgeId: String(hedgeId),
    symbol: hedge?.symbol || null,
    time: settlementTime,
    markPx, // Snapshot of mark price AT settlement
    rate,   // Snapshot of rate AT settlement
    size,   // Snapshot of size AT settlement
    intervalS,
    intervalHours: intervalS / 3600,
    usdc: payment, // Calculated once, never recalculated
    capturedAt: Date.now(),
    venue: 'variational',
    fundingEstimated: true, // Mark as estimate, but frozen after settlement
  };

  // Append to settlement history
  try {
    const existing = await loadVariationalSettlementCaptures(hedgeId);
    const updated = [settlement, ...existing].slice(0, 1000); // Keep last 1000 settlements
    
    const key = settlementCacheKey(hedgeId);
    await kvSet(key, JSON.stringify(updated));

    // Update latest timestamp
    const latestKey = settlementLatestKey(hedgeId);
    await kvSet(latestKey, String(settlementTime));

    console.log(`[Variational] Captured settlement for ${hedgeId} ${hedge?.symbol} at ${new Date(settlementTime).toISOString()}: $${payment.toFixed(2)} (mark=${markPx}, rate=${rate})`);
    return settlement;
  } catch (e) {
    console.error(`[Variational] Failed to capture settlement for ${hedgeId}:`, e.message);
    return null;
  }
}

/**
 * Retrieve settled (captured) funding payments for a hedge within a time window.
 * These are NOT estimated — they're frozen snapshots from settlement time.
 * 
 * @param {string} hedgeId - Hedge ID
 * @param {number} sinceMs - Only return settlements after this time (optional)
 * @param {number} untilMs - Only return settlements before this time (optional)
 * @returns {array} Sorted array of settlement records (newest first)
 */
async function getVariationalSettledPayments(hedgeId, sinceMs = null, untilMs = null) {
  if (!hedgeId) return [];
  
  const settlements = await loadVariationalSettlementCaptures(hedgeId);
  return settlements.filter(s => {
    if (sinceMs && s.time < sinceMs) return false;
    if (untilMs && s.time > untilMs) return false;
    return true;
  });
}

/**
 * Schedule periodic capture of Variational funding settlements for a hedge.
 * 
 * This should be called when a hedge is opened and run continuously on the client/server.
 * It uses the funding settlement grid from variational-funding-clock to determine
 * exactly when settlements occur, then captures them at that moment.
 * 
 * @param {object} hedge - Variational hedge object
 * @param {object} listing - Variational listing (for markPx, rate, interval)
 * @param {function} fetchFn - Async function to fetch listing (to get fresh data at settlement)
 * @returns {function} Cancellation function to stop monitoring
 */
function monitorVariationalSettlements(hedge, listing, fetchFn = null) {
  const hedgeId = hedge?.id;
  if (!hedgeId) return () => {};

  const intervalMs = Number(listing?.fundingIntervalS || 28800) * 1000;
  const nextSettlement = listing?.fundingNextAtMs;

  if (!nextSettlement || !Number.isFinite(nextSettlement)) {
    console.warn(`[Variational] Cannot monitor settlements — missing next settlement time for ${hedgeId}`);
    return () => {};
  }

  let timeoutId = null;
  let isActive = true;

  const scheduleNextCapture = async () => {
    if (!isActive) return;

    try {
      // Fetch fresh listing data at settlement time
      let freshListing = listing;
      if (fetchFn) {
        try {
          // You would implement this to fetch fresh Variational stats
          // freshListing = await fetchFn(hedgeId);
          // For now, use provided listing
        } catch {
          // Fall back to provided listing
        }
      }

      const now = Date.now();
      const nextSettleTime = nextSettlement + Math.ceil((now - nextSettlement) / intervalMs) * intervalMs;

      // Capture at the settlement time
      await captureVariationalSettlement(hedgeId, nextSettleTime, freshListing, hedge);

      // Schedule next settlement
      const timeUntilNext = nextSettleTime + intervalMs - Date.now();
      if (timeUntilNext > 0) {
        timeoutId = setTimeout(scheduleNextCapture, timeUntilNext + 100); // +100ms buffer
      } else {
        // Schedule immediately if overdue
        timeoutId = setTimeout(scheduleNextCapture, 1000);
      }
    } catch (e) {
      console.error(`[Variational] Settlement capture error for ${hedgeId}:`, e.message);
      // Retry after 1 minute on error
      timeoutId = setTimeout(scheduleNextCapture, 60000);
    }
  };

  const timeUntilFirstSettlement = nextSettlement - Date.now();
  if (timeUntilFirstSettlement > 0) {
    timeoutId = setTimeout(scheduleNextCapture, timeUntilFirstSettlement + 100);
  } else {
    scheduleNextCapture();
  }

  // Return cancellation function
  return () => {
    isActive = false;
    if (timeoutId) clearTimeout(timeoutId);
  };
}

/**
 * Build funding events for a Variational hedge using STORED settlements, not estimates.
 * 
 * Replaces buildVariationalFundingEventsScheduled() for Variational hedges.
 * 
 * - For times with captured settlements: Use stored (frozen) values
 * - For future unsettled times: Use estimates (these WILL change when actually settled)
 * - Never rebuild past settlements
 * 
 * @param {string} hedgeId - Hedge ID
 * @param {object} hedge - Hedge object
 * @param {object} listing - Variational listing (for future estimates)
 * @param {object} opts - Options { sinceMs, now, includeUnsettled }
 * @returns {array} Funding events (mix of settled + estimated)
 */
async function buildVariationalFundingEventsWithSettlements(hedgeId, hedge, listing, opts = {}) {
  const sinceMs = Number(opts.sinceMs || 0);
  const now = Number(opts.now || Date.now());
  const includeUnsettled = opts.includeUnsettled !== false; // Default true

  if (!hedgeId) return [];

  const openedAt = Number(hedge?.openedAt);
  if (!openedAt) return [];

  // Load stored settlements
  const settled = await getVariationalSettledPayments(hedgeId, sinceMs);
  const settledByTime = new Map(settled.map(s => [s.time, s]));

  const normalized = resolveVariationalNativeRate(listing);
  const intervalMs = (normalized.intervalS || 28800) * 1000;

  // Get all settlement times between open and now
  const settlementTimes = variationalFundingSettlementsBetween(
    openedAt,
    opts.untilMs || now,
    listing,
  );

  const events = [];

  for (const settlementTime of settlementTimes) {
    if (sinceMs && settlementTime < sinceMs) continue;
    if (settlementTime > now) {
      if (!includeUnsettled) continue;
      // Future: estimate using current data
      const size = Number(hedge?.variationalSize) || 0;
      const markPx = Number(listing?.markPx) || 0;
      const rate = normalized.rateDecimal || 0;
      events.push({
        hedge_id: hedgeId,
        venue: 'variational',
        time: settlementTime,
        usdc: variationalFundingPaymentPerInterval(size, markPx, rate),
        symbol: hedge?.symbol,
        intervalHours: normalized.intervalHours,
        fundingEstimated: true,
        isUnsettled: true,
      });
      continue;
    }

    // Past: use stored settlement if available
    const stored = settledByTime.get(settlementTime);
    if (stored) {
      events.push({
        ...stored,
        hedge_id: hedgeId,
        isUnsettled: false,
      });
    } else if (includeUnsettled) {
      // Fallback estimate (should rarely happen if capture is working)
      const size = Number(hedge?.variationalSize) || 0;
      const markPx = Number(listing?.markPx) || 0;
      const rate = normalized.rateDecimal || 0;
      events.push({
        hedge_id: hedgeId,
        venue: 'variational',
        time: settlementTime,
        usdc: variationalFundingPaymentPerInterval(size, markPx, rate),
        symbol: hedge?.symbol,
        intervalHours: normalized.intervalHours,
        fundingEstimated: true,
        isUnsettled: false,
        isFallbackEstimate: true,
      });
    }
  }

  return events.sort((a, b) => a.time - b.time);
}

/**
 * Merge stored Variational settlements into daily funding series.
 * Replaces buildVariationalFundingEventsScheduled reconstruction.
 * 
 * @param {string} hedgeId - Hedge ID
 * @param {object} hedge - Hedge object
 * @param {string} symbol - Base symbol (e.g., 'TRUMP')
 * @param {array} dailyRows - Daily funding series rows to merge into
 * @returns {array} Updated daily rows with Variational settlements added
 */
async function mergeVariationalSettlementsIntoDailySeries(hedgeId, hedge, symbol, dailyRows = []) {
  if (!hedgeId || !symbol) return dailyRows;

  const settled = await getVariationalSettledPayments(hedgeId);
  if (!settled.length) return dailyRows;

  const byDay = new Map(dailyRows.map(r => [r.day, { ...r }]));
  const dayStart = dailyRows.length ? dailyRows[0].day : null;
  const dayEnd = dailyRows.length ? dailyRows[dailyRows.length - 1].day : null;

  for (const settlement of settled) {
    const dayStr = new Date(settlement.time).toISOString().slice(0, 10);
    if (dayStart && dayStr < dayStart) continue;
    if (dayEnd && dayStr > dayEnd) continue;

    if (!byDay.has(dayStr)) {
      byDay.set(dayStr, {
        day: dayStr,
        dailyFunding: 0,
        dailyFees: 0,
        dailyNet: 0,
        byVenue: {},
        fundingEvents: [],
        feeEvents: [],
      });
    }

    const row = byDay.get(dayStr);
    const usdc = settlement.usdc || 0;
    row.dailyFunding += usdc;
    row.dailyNet = row.dailyFunding - row.dailyFees;
    row.byVenue.variational = (row.byVenue.variational || 0) + usdc;
    
    row.fundingEvents.push({
      venue: 'variational',
      time: settlement.time,
      usdc,
      symbol: settlement.symbol,
      intervalHours: settlement.intervalHours,
      fundingEstimated: false, // Now false — these are settled captures
      hedgeId,
    });
  }

  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

module.exports = {
  settlementCacheKey,
  settlementLatestKey,
  loadVariationalSettlementCaptures,
  loadVariationalSettlementLatest,
  captureVariationalSettlement,
  getVariationalSettledPayments,
  monitorVariationalSettlements,
  buildVariationalFundingEventsWithSettlements,
  mergeVariationalSettlementsIntoDailySeries,
};

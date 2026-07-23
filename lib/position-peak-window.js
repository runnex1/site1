/**
 * Peak → close attribution for closed perps pairs.
 * Peak is found within a lookback window (default 24h, or latest activity session bounds).
 * Shared by server (perps.js) and browser (variational-hedge.js).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PositionPeakWindow = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const PEAK_LOOKBACK_MS = 24 * 3600000;
  const ROUND_EPS = 1e-8;
  /** When peak→close is shorter than this, funding/fees use pair open (sparse fill history). */
  const PEAK_MIN_FUNDING_WINDOW_MS = 60 * 60 * 1000;

  function toBaseSymbol(symbol) {
    return String(symbol || '')
      .trim()
      .toUpperCase()
      .replace(/-PERP$/i, '')
      .replace(/USDT$/i, '')
      .replace(/USD$/i, '');
  }

  function fillSignedSize(fill) {
    const raw = Number(fill.sz ?? fill.size ?? 0);
    if (!Number.isFinite(raw) || raw === 0) return 0;
    const side = String(fill.side || '').toLowerCase();
    const abs = Math.abs(raw);
    if (side === 'b' || side === 'buy' || side === 'bid') return abs;
    if (side === 'a' || side === 'sell' || side === 'ask') return -abs;
    return raw;
  }

  function fillMarkPx(fill) {
    const px = Number(fill?.px ?? fill?.markPx ?? 0);
    return Number.isFinite(px) && px > 0 ? px : null;
  }

  function resolvePeakLookbackStart(closeTime, lookbackMsOrOpts) {
    const end = Number(closeTime || 0);
    let lookbackMs = PEAK_LOOKBACK_MS;
    let lookbackStart = null;
    if (lookbackMsOrOpts && typeof lookbackMsOrOpts === 'object') {
      if (Number.isFinite(Number(lookbackMsOrOpts.lookbackMs))) {
        lookbackMs = Number(lookbackMsOrOpts.lookbackMs);
      }
      if (Number.isFinite(Number(lookbackMsOrOpts.lookbackStartMs))) {
        lookbackStart = Number(lookbackMsOrOpts.lookbackStartMs);
      }
    } else if (Number.isFinite(Number(lookbackMsOrOpts))) {
      lookbackMs = Number(lookbackMsOrOpts);
    }
    if (lookbackStart == null || !Number.isFinite(lookbackStart)) {
      lookbackStart = end - lookbackMs;
    }
    if (end && lookbackStart > end) lookbackStart = end;
    return { lookbackStart, lookbackMs };
  }

  function computeLegPeakWindow(fills, symbol, closeTime, lookbackMsOrOpts = PEAK_LOOKBACK_MS) {
    const base = toBaseSymbol(symbol);
    const end = Number(closeTime || 0);
    if (!base || !end) {
      return {
        peakSize: 0,
        peakAt: end,
        windowStart: end,
        closeTime: end,
        positionAtClose: 0,
        side: 'long',
        peakPx: null,
        peakMargin: 0,
      };
    }
    const { lookbackStart } = resolvePeakLookbackStart(end, lookbackMsOrOpts);
    const sorted = (fills || [])
      .filter((f) => toBaseSymbol(f.symbol) === base && Number(f.time || 0) <= end)
      .sort((a, b) => Number(a.time || 0) - Number(b.time || 0));

    let pos = 0;
    let peakSize = 0;
    let peakAt = lookbackStart;
    let peakPx = null;
    let lastPx = null;
    let seededCarry = false;

    for (const fill of sorted) {
      const t = Number(fill.time || 0);
      const delta = fillSignedSize(fill);
      if (!delta) continue;
      const px = fillMarkPx(fill);
      if (px != null) lastPx = px;

      if (t >= lookbackStart && !seededCarry && Math.abs(pos) > ROUND_EPS) {
        peakSize = Math.abs(pos);
        peakAt = lookbackStart;
        peakPx = lastPx;
        seededCarry = true;
      }

      pos += delta;
      if (t < lookbackStart) continue;

      const abs = Math.abs(pos);
      if (abs > peakSize + ROUND_EPS) {
        peakSize = abs;
        peakAt = t;
        peakPx = px ?? lastPx;
        seededCarry = true;
      } else if (abs + ROUND_EPS >= peakSize && abs > ROUND_EPS) {
        peakAt = t;
        if (px != null) peakPx = px;
        else if (peakPx == null) peakPx = lastPx;
        seededCarry = true;
      }
    }

    const positionAtClose = Math.abs(pos);
    if (peakSize <= ROUND_EPS) {
      peakSize = positionAtClose;
      peakAt = end;
      if (peakPx == null) peakPx = lastPx;
    }

    const peakMargin = peakSize > 0 && peakPx > 0 ? peakSize * peakPx : 0;

    return {
      peakSize,
      peakAt,
      windowStart: peakAt,
      closeTime: end,
      positionAtClose,
      side: pos > ROUND_EPS ? 'long' : pos < -ROUND_EPS ? 'short' : 'long',
      peakPx,
      peakMargin,
    };
  }

  function sumFeesInWindow(fills, symbol, sinceMs, untilMs) {
    const base = toBaseSymbol(symbol);
    const start = Number(sinceMs || 0);
    const end = Number(untilMs || 0);
    let sum = 0;
    for (const fill of fills || []) {
      if (toBaseSymbol(fill.symbol) !== base) continue;
      const t = Number(fill.time || 0);
      if (start && t < start) continue;
      if (end && t > end) continue;
      sum += Math.abs(Number(fill.fee || 0));
    }
    return sum;
  }

  function fillsInWindow(fills, symbol, sinceMs, untilMs) {
    const base = toBaseSymbol(symbol);
    const start = Number(sinceMs || 0);
    const end = Number(untilMs || 0);
    return (fills || []).filter((fill) => {
      if (toBaseSymbol(fill.symbol) !== base) return false;
      const t = Number(fill.time || 0);
      if (start && t < start) return false;
      if (end && t > end) return false;
      return true;
    });
  }

  function sumClosedPnlInWindow(fills, symbol, sinceMs, untilMs) {
    let sum = 0;
    for (const fill of fillsInWindow(fills, symbol, sinceMs, untilMs)) {
      const pnl = Number(fill.closedPnl ?? fill.realizedPnl ?? 0);
      if (Number.isFinite(pnl)) sum += pnl;
    }
    return sum;
  }

  function hasClosedPnlEvidenceInWindow(fills, symbol, sinceMs, untilMs) {
    return fillsInWindow(fills, symbol, sinceMs, untilMs).some((fill) => {
      const raw = fill?.closedPnl ?? fill?.realizedPnl;
      if (raw == null || raw === '') return false;
      return Number.isFinite(Number(raw));
    });
  }

  function hasFeeEvidenceInWindow(fills, symbol, sinceMs, untilMs) {
    return fillsInWindow(fills, symbol, sinceMs, untilMs).some((fill) => {
      const fee = Number(fill?.fee || 0);
      return Number.isFinite(fee) && Math.abs(fee) > ROUND_EPS;
    });
  }

  function fundingInWindow(venue, symbol, sinceMs, untilMs, paymentSources, fundingForClosedLeg) {
    if (typeof fundingForClosedLeg === 'function') {
      return fundingForClosedLeg(venue, toBaseSymbol(symbol), sinceMs, untilMs, paymentSources);
    }
    const base = toBaseSymbol(symbol);
    const start = Number(sinceMs || 0);
    const end = Number(untilMs || 0);
    let sum = 0;
    for (const payment of paymentSources?.[venue] || []) {
      if (toBaseSymbol(payment.symbol) !== base) continue;
      const t = Number(payment.time || 0);
      if (start && t < start) continue;
      if (end && t > end) continue;
      sum += Number(payment.usdc || 0);
    }
    return sum;
  }

  function hasFundingEvidenceInWindow(venue, symbol, sinceMs, untilMs, paymentSources) {
    const base = toBaseSymbol(symbol);
    const start = Number(sinceMs || 0);
    const end = Number(untilMs || 0);
    return (paymentSources?.[venue] || []).some((payment) => {
      if (toBaseSymbol(payment.symbol) !== base) return false;
      const t = Number(payment.time || 0);
      if (start && t < start) return false;
      if (end && t > end) return false;
      return Number.isFinite(Number(payment.usdc));
    });
  }

  function filterDailySeriesSince(series, sinceMs) {
    if (!sinceMs || !Array.isArray(series)) return series || [];
    const startDay = new Date(Number(sinceMs)).toISOString().slice(0, 10);
    return series.filter((row) => String(row?.day || '') >= startDay);
  }

  function sessionDaysFromWindow(windowStart, closeTime) {
    const start = Number(windowStart || 0);
    const end = Number(closeTime || 0);
    if (!start || !end || end <= start) return 1 / 24;
    return Math.max((end - start) / 86400000, 1 / 24);
  }

  function resolveFundingFeesWindowStart(pairWindowStart, closeTime, pair, lookbackMs = PEAK_LOOKBACK_MS, lookbackStartMs = null) {
    const end = Number(closeTime || 0);
    const peakStart = Number(pairWindowStart || 0);
    const openTime = Number(pair?.openTime || 0);
    const sessionStart = Number.isFinite(Number(lookbackStartMs)) ? Number(lookbackStartMs) : null;
    const lookbackStart = end - lookbackMs;
    if (!end || !peakStart) return openTime || sessionStart || lookbackStart;
    if (end - peakStart >= PEAK_MIN_FUNDING_WINDOW_MS) return peakStart;
    if (openTime > 0 && openTime < peakStart) return openTime;
    if (sessionStart != null && sessionStart < peakStart) return sessionStart;
    return Math.min(peakStart, lookbackStart);
  }

  function applyPeakToCloseMetrics(pair, fillSources, paymentSources, opts = {}) {
    if (!pair) return pair;
    const closeTime = Number(pair.closeTime || 0);
    if (!closeTime) return pair;

    const symbol = pair.symbol;
    const fundingFn = opts.fundingForClosedLeg || null;
    const peakOpts = {
      lookbackMs: opts.lookbackMs,
      lookbackStartMs: opts.lookbackStartMs,
    };
    const legKeys = ['longLeg', 'shortLeg'];
    const exchangeLegs = [];

    for (const key of legKeys) {
      const leg = pair[key];
      if (!leg || leg.venue === 'variational') continue;
      const fills = fillSources?.[leg.venue] || [];
      let peak = computeLegPeakWindow(fills, symbol, closeTime, peakOpts);
      const legSize = Math.abs(Number(leg.size || 0));
      if (peak.peakSize <= ROUND_EPS && legSize > ROUND_EPS) {
        const { lookbackStart } = resolvePeakLookbackStart(closeTime, peakOpts);
        peak = {
          peakSize: legSize,
          peakAt: lookbackStart,
          windowStart: lookbackStart,
          closeTime,
          positionAtClose: legSize,
          side: leg.side || 'long',
        };
      }
      exchangeLegs.push({ key, leg, peak, fills });
    }

    if (!exchangeLegs.length) return pair;

    const peakSizes = exchangeLegs.map((row) => row.peak.peakSize).filter((s) => s > ROUND_EPS);
    const pairPeakSize = peakSizes.length
      ? Math.min(...peakSizes)
      : Math.abs(Number(pair.size || 0));
    const pairWindowStart = Math.min(...exchangeLegs.map((row) => row.peak.windowStart));
    const fundingFeesStart = resolveFundingFeesWindowStart(
      pairWindowStart,
      closeTime,
      pair,
      opts.lookbackMs || PEAK_LOOKBACK_MS,
      opts.lookbackStartMs,
    );

    for (const row of exchangeLegs) {
      const slippageStart = row.peak.windowStart;
      const priorFees = Number(row.leg.fees);
      const priorFunding = Number(row.leg.funding);
      const priorRealized = Number(row.leg.realizedPnl);
      const feeFromFills = sumFeesInWindow(row.fills, symbol, fundingFeesStart, closeTime);
      const pnlFromFills = sumClosedPnlInWindow(row.fills, symbol, slippageStart, closeTime);
      const fundingFromPayments = fundingInWindow(
        row.leg.venue,
        symbol,
        fundingFeesStart,
        closeTime,
        paymentSources,
        fundingFn,
      );
      // Empty fill/payment windows must not clobber estimated Variational tracked metrics.
      // Normal exchange legs still replace lifetime priors with window sums (including 0).
      const preserveEstimated = Boolean(row.leg.closeLegEstimated);
      const hasPnlEvidence = hasClosedPnlEvidenceInWindow(row.fills, symbol, slippageStart, closeTime);
      const hasFeeEvidence = hasFeeEvidenceInWindow(row.fills, symbol, fundingFeesStart, closeTime);
      const hasFundingEvidence = hasFundingEvidenceInWindow(
        row.leg.venue,
        symbol,
        fundingFeesStart,
        closeTime,
        paymentSources,
      );
      row.fees = hasFeeEvidence || !preserveEstimated || !Number.isFinite(priorFees)
        ? feeFromFills
        : priorFees;
      row.realizedPnl = hasPnlEvidence || !preserveEstimated || !Number.isFinite(priorRealized)
        ? pnlFromFills
        : priorRealized;
      row.funding = hasFundingEvidence || !preserveEstimated || !Number.isFinite(priorFunding)
        ? fundingFromPayments
        : priorFunding;
      row.metricsFromFills = hasPnlEvidence || hasFeeEvidence;
    }

    for (const row of exchangeLegs) {
      row.leg.size = pairPeakSize;
      row.leg.fees = row.fees;
      row.leg.funding = row.funding;
      if (Number.isFinite(row.realizedPnl)) row.leg.realizedPnl = row.realizedPnl;
    }

    const longLeg = pair.longLeg;
    const shortLeg = pair.shortLeg;
    const longPnl = Number.isFinite(Number(longLeg?.realizedPnl)) ? Number(longLeg.realizedPnl) : 0;
    const shortPnl = Number.isFinite(Number(shortLeg?.realizedPnl)) ? Number(shortLeg.realizedPnl) : 0;
    const funding = Number(longLeg?.funding ?? 0) + Number(shortLeg?.funding ?? 0);
    const fees = Number(longLeg?.fees ?? 0) + Number(shortLeg?.fees ?? 0);
    const closeSlippage = typeof opts.closeSlippageForPair === 'function'
      ? opts.closeSlippageForPair({ ...pair, longLeg, shortLeg, size: pairPeakSize })
      : longPnl + shortPnl;

    const sessionDays = sessionDaysFromWindow(pairWindowStart, closeTime);
    const startDay = new Date(pairWindowStart).toISOString().slice(0, 10);
    const endDay = new Date(closeTime).toISOString().slice(0, 10);
    const dailyPerformanceSeries = filterDailySeriesSince(pair.dailyPerformanceSeries, pairWindowStart);

    return {
      ...pair,
      size: pairPeakSize,
      closeSlippage,
      funding,
      fees,
      netPnl: closeSlippage + funding - fees,
      statsSinceMs: pairWindowStart,
      fundingSinceMs: fundingFeesStart,
      peakMetricsApplied: true,
      sessionPeakApplied: Number.isFinite(Number(opts.lookbackStartMs)),
      sessionDays,
      sessionStartDay: startDay,
      sessionEndDay: endDay,
      openTime: pairWindowStart,
      dailyPerformanceSeries,
    };
  }

  return {
    PEAK_LOOKBACK_MS,
    PEAK_MIN_FUNDING_WINDOW_MS,
    toBaseSymbol,
    fillSignedSize,
    resolvePeakLookbackStart,
    computeLegPeakWindow,
    sumFeesInWindow,
    sumClosedPnlInWindow,
    fundingInWindow,
    filterDailySeriesSince,
    sessionDaysFromWindow,
    resolveFundingFeesWindowStart,
    applyPeakToCloseMetrics,
  };
});

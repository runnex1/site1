/**
 * 24h peak → close attribution for closed perps pairs.
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

  function computeLegPeakWindow(fills, symbol, closeTime, lookbackMs = PEAK_LOOKBACK_MS) {
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
      };
    }
    const lookbackStart = end - lookbackMs;
    const sorted = (fills || [])
      .filter((f) => toBaseSymbol(f.symbol) === base && Number(f.time || 0) <= end)
      .sort((a, b) => Number(a.time || 0) - Number(b.time || 0));

    let pos = 0;
    let peakSize = 0;
    let peakAt = lookbackStart;
    let seededCarry = false;

    for (const fill of sorted) {
      const t = Number(fill.time || 0);
      const delta = fillSignedSize(fill);
      if (!delta) continue;

      if (t >= lookbackStart && !seededCarry && Math.abs(pos) > ROUND_EPS) {
        peakSize = Math.abs(pos);
        peakAt = lookbackStart;
        seededCarry = true;
      }

      pos += delta;
      if (t < lookbackStart) continue;

      const abs = Math.abs(pos);
      if (abs > peakSize + ROUND_EPS) {
        peakSize = abs;
        peakAt = t;
        seededCarry = true;
      } else if (abs + ROUND_EPS >= peakSize && abs > ROUND_EPS) {
        peakAt = t;
        seededCarry = true;
      }
    }

    const positionAtClose = Math.abs(pos);
    if (peakSize <= ROUND_EPS) {
      peakSize = positionAtClose;
      peakAt = end;
    }

    return {
      peakSize,
      peakAt,
      windowStart: peakAt,
      closeTime: end,
      positionAtClose,
      side: pos > ROUND_EPS ? 'long' : pos < -ROUND_EPS ? 'short' : 'long',
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

  function sumClosedPnlInWindow(fills, symbol, sinceMs, untilMs) {
    const base = toBaseSymbol(symbol);
    const start = Number(sinceMs || 0);
    const end = Number(untilMs || 0);
    let sum = 0;
    for (const fill of fills || []) {
      if (toBaseSymbol(fill.symbol) !== base) continue;
      const t = Number(fill.time || 0);
      if (start && t < start) continue;
      if (end && t > end) continue;
      const pnl = Number(fill.closedPnl ?? fill.realizedPnl ?? 0);
      if (Number.isFinite(pnl)) sum += pnl;
    }
    return sum;
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

  function resolveFundingFeesWindowStart(pairWindowStart, closeTime, pair, lookbackMs = PEAK_LOOKBACK_MS) {
    const end = Number(closeTime || 0);
    const peakStart = Number(pairWindowStart || 0);
    const openTime = Number(pair?.openTime || 0);
    const lookbackStart = end - lookbackMs;
    if (!end || !peakStart) return openTime || lookbackStart;
    if (end - peakStart >= PEAK_MIN_FUNDING_WINDOW_MS) return peakStart;
    if (openTime > 0 && openTime < peakStart) return openTime;
    return Math.min(peakStart, lookbackStart);
  }

  function applyPeakToCloseMetrics(pair, fillSources, paymentSources, opts = {}) {
    if (!pair) return pair;
    const closeTime = Number(pair.closeTime || 0);
    if (!closeTime) return pair;

    const symbol = pair.symbol;
    const fundingFn = opts.fundingForClosedLeg || null;
    const legKeys = ['longLeg', 'shortLeg'];
    const exchangeLegs = [];

    for (const key of legKeys) {
      const leg = pair[key];
      if (!leg || leg.venue === 'variational') continue;
      const fills = fillSources?.[leg.venue] || [];
      let peak = computeLegPeakWindow(fills, symbol, closeTime, opts.lookbackMs);
      const legSize = Math.abs(Number(leg.size || 0));
      if (peak.peakSize <= ROUND_EPS && legSize > ROUND_EPS) {
        const lookbackStart = closeTime - (opts.lookbackMs || PEAK_LOOKBACK_MS);
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
      opts.lookbackMs,
    );

    for (const row of exchangeLegs) {
      const slippageStart = row.peak.windowStart;
      row.fees = sumFeesInWindow(row.fills, symbol, fundingFeesStart, closeTime);
      row.realizedPnl = sumClosedPnlInWindow(row.fills, symbol, slippageStart, closeTime);
      row.funding = fundingInWindow(
        row.leg.venue,
        symbol,
        fundingFeesStart,
        closeTime,
        paymentSources,
        fundingFn,
      );
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
    const closeSlippage = longPnl + shortPnl;

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

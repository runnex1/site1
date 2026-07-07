const { kvGet, kvSet } = require('./kv');
const EtfDca = require('./etf-dca');

function todayRomaniaKey(date = new Date()) {
  return EtfDca.dcaDateKey(date);
}

function romaniaHour(date = new Date()) {
  return Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Bucharest',
    hour: '2-digit',
    hour12: false,
  }).format(date));
}

async function yahooQuote(symbol) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    Accept: 'application/json',
  };
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2d`;
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(7000) });
  if (!r.ok) throw new Error(`Yahoo ${symbol} ${r.status}`);
  const d = await r.json();
  const meta = d?.chart?.result?.[0]?.meta;
  const price = Number(meta?.regularMarketPrice || meta?.previousClose || 0);
  if (!price) throw new Error(`Yahoo ${symbol} no price`);
  return {
    price,
    longName: meta?.longName || '',
    shortName: meta?.shortName || '',
    instrumentType: meta?.instrumentType || '',
    symbol: meta?.symbol || symbol,
  };
}

function etfLogoSymbolFor(ticker, meta = {}) {
  const symbol = String(ticker || meta.symbol || '').trim().toUpperCase();
  const text = `${symbol} ${meta.longName || ''} ${meta.shortName || ''}`.toUpperCase();
  if (/(S&P|S AND P|STANDARD.*POOR|SPDR S&P|SXR8|CSPX|VUAA|VUSA|VOO|SPY|IVV|IUSA)/.test(text)) return 'INDEX_SP500';
  if (/(NASDAQ[\s-]*100|NASDAQ 100|NDX|QQQ|N1ES|EQQQ|CNDX|SXRV|QDVE)/.test(text)) return 'INDEX_NASDAQ100';
  if (/(MSCI WORLD|IWDA|EUNL|SWDA|URTH)/.test(text)) return 'INDEX_MSCI_WORLD';
  if (/(FTSE ALL[\s-]*WORLD|VWCE|VWRL|VWRP|VT|VWRD)/.test(text)) return 'INDEX_FTSE_ALL_WORLD';
  if (/(EURO STOXX 50|EUROSTOXX 50|STOXX 50|SX5E|EXW1)/.test(text)) return 'INDEX_EURO_STOXX50';
  if (/(^|\s)DAX(\s|$)|EXS1|DAX UCITS/.test(text)) return 'INDEX_DAX';
  return '';
}

async function updateEtfPortfolioPrices({ now = new Date() } = {}) {
  const raw = await kvGet('vault:portfolio');
  const portfolio = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
  if (!portfolio || !Array.isArray(portfolio.etfs)) {
    return { ok: true, updated: 0, dcaApplied: 0, total: 0, skipped: true, reason: 'no_etfs' };
  }

  const canDca = romaniaHour(now) >= 12;
  const today = todayRomaniaKey(now);
  let updated = 0;
  let quoteFailures = 0;
  let dcaApplied = 0;
  let changed = false;

  for (const e of portfolio.etfs) {
    EtfDca.ensureDcaNote(e);
    const ticker = String(e.ticker || '').trim().toUpperCase();
    if (!ticker) continue;
    let quote = null;
    try {
      quote = await yahooQuote(ticker);
    } catch {
      quoteFailures++;
    }
    const price = Number(quote?.price || e.currentPrice || 0);
    if (!price) continue;
    if (Number(e.currentPrice || 0) !== price) {
      e.currentPrice = price;
      e.updatedAt = Date.now();
      updated++;
      changed = true;
    }
    const longName = quote?.longName || e.longName || '';
    const shortName = quote?.shortName || e.shortName || '';
    const instrumentType = quote?.instrumentType || e.instrumentType || '';
    const logoSymbol = etfLogoSymbolFor(ticker, { ...e, longName, shortName }) || e.logoSymbol || ticker;
    if (e.longName !== longName || e.shortName !== shortName || e.instrumentType !== instrumentType || e.logoSymbol !== logoSymbol) {
      e.longName = longName;
      e.shortName = shortName;
      e.instrumentType = instrumentType;
      e.logoSymbol = logoSymbol;
      changed = true;
    }

    if (canDca && EtfDca.applyDcaToPosition(e, price, now)) {
      dcaApplied++;
      changed = true;
    }
  }

  if (changed) await kvSet('vault:portfolio', JSON.stringify(portfolio));
  return {
    ok: true,
    updated,
    quoteFailures,
    dcaApplied,
    today,
    total: portfolio.etfs.length,
  };
}

module.exports = {
  todayRomaniaKey,
  romaniaHour,
  yahooQuote,
  etfLogoSymbolFor,
  updateEtfPortfolioPrices,
};

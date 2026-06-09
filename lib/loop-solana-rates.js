const KAMINO_API = 'https://api.kamino.finance';
const JUPITER_LEND_API = 'https://api.jup.ag/lend/v1';
const JUPITER_PORTFOLIO_API = 'https://api.jup.ag/portfolio/v1';
const KAMINO_MARKET_VALUE_SF = 2n ** 60n;
const SOLANA_CHAIN_ID = 'solana';
const ZERO_RESERVE = '11111111111111111111111111111111';

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function percent(value) {
  const n = num(value, 0);
  return Math.abs(n) <= 1 ? n * 100 : n;
}

function netApy({ totalSupplied, totalBorrowed, suppliedYieldUsd = 0, borrowedCostUsd = 0 }) {
  const net = Math.max(Math.abs(num(totalSupplied) - num(totalBorrowed)), 1);
  return (num(suppliedYieldUsd) - num(borrowedCostUsd)) / net;
}

function isSolanaWallet(value) {
  const s = String(value || '').trim();
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}

function isEvmWallet(value) {
  return typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value.trim());
}

function jupiterHeaders(extra = {}) {
  const key = String(process.env.JUPITER_API_KEY || process.env.JUP_API_KEY || '').trim();
  return {
    Accept: 'application/json',
    ...(key ? { 'x-api-key': key } : {}),
    ...extra,
  };
}

async function fetchJson(url, { timeout = 25000, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch { json = null; }
    if (!response.ok) {
      const message = json?.error || json?.message || text || `HTTP ${response.status}`;
      throw new Error(message);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

function kaminoMarketValueUsd(sf) {
  try {
    const bi = BigInt(String(sf || 0));
    if (bi <= 0n) return 0;
    return Number(bi) / Number(KAMINO_MARKET_VALUE_SF);
  } catch {
    return 0;
  }
}

function jupiterRatePercent(rate) {
  const n = num(rate, NaN);
  return Number.isFinite(n) ? n / 100 : null;
}

function jupiterPortfolioApyPercent(rate) {
  const n = num(rate, NaN);
  return Number.isFinite(n) ? n * 100 : null;
}

function isJupiterPortfolioBorrowElement(element) {
  if (element?.type !== 'borrowlend') return false;
  const fetcherId = String(element?.fetcherId || '').toLowerCase();
  if (fetcherId.includes('borrow') || fetcherId.includes('lend')) return true;
  return String(element?.platformId || '').toLowerCase() === 'jupiter-exchange'
    && num(element?.data?.borrowedValue) > 0.01;
}

function portfolioAssetLeg(asset, tokenInfo = {}) {
  const addr = asset?.data?.address;
  const sym = tokenInfo?.[addr]?.symbol || tokenInfo?.[addr]?.name || 'Asset';
  const value = num(asset?.value);
  const apy = jupiterPortfolioApyPercent(asset?.data?.yields?.[0]?.apy);
  return {
    symbol: sym,
    value,
    apy,
    address: addr,
  };
}

function tokenUsdValue(token, rawAmount) {
  const amount = num(rawAmount, 0);
  if (amount <= 0) return 0;
  const decimals = num(token?.decimals, 0);
  const price = num(token?.price, 0);
  if (!decimals || !price) return 0;
  return (amount / (10 ** decimals)) * price;
}

function mapKaminoObligation(wallet, marketMeta, reservesByKey, obligation) {
  const stats = obligation?.refreshedStats || {};
  const totalBorrow = num(stats.userTotalBorrow);
  if (totalBorrow <= 0.01) return null;

  const supplied = [];
  const borrowed = [];
  let suppliedYieldUsd = 0;
  let borrowedCostUsd = 0;

  for (const dep of obligation?.state?.deposits || []) {
    if (String(dep?.depositReserve || '') === ZERO_RESERVE) continue;
    const usd = kaminoMarketValueUsd(dep?.marketValueSf);
    if (usd <= 0.01) continue;
    const meta = reservesByKey[dep.depositReserve] || {};
    const apy = percent(meta.supplyApy);
    supplied.push({
      symbol: meta.liquidityToken || 'Asset',
      value: usd,
      apy,
      address: meta.liquidityTokenMint,
      isCollateral: true,
    });
    suppliedYieldUsd += usd * apy;
  }

  for (const bor of obligation?.state?.borrows || []) {
    if (String(bor?.borrowReserve || '') === ZERO_RESERVE) continue;
    const borrowedRaw = num(bor?.borrowedAmountOutsideElevationGroups);
    const hasBorrow = borrowedRaw > 0 || kaminoMarketValueUsd(bor?.marketValueSf) > 0.01;
    if (!hasBorrow) continue;
    const usd = kaminoMarketValueUsd(bor?.marketValueSf);
    if (usd <= 0.01) continue;
    const meta = reservesByKey[bor.borrowReserve] || {};
    const apy = percent(meta.borrowApy);
    borrowed.push({
      symbol: meta.liquidityToken || 'Debt',
      value: usd,
      apy,
      address: meta.liquidityTokenMint,
    });
    borrowedCostUsd += usd * apy;
  }

  if (!borrowed.length) return null;

  const totalSupplied = num(stats.userTotalDeposit) || supplied.reduce((sum, row) => sum + row.value, 0);
  const totalBorrowed = totalBorrow || borrowed.reduce((sum, row) => sum + row.value, 0);
  const netValue = num(stats.netAccountValue, totalSupplied - totalBorrowed);

  const ltv = num(stats.loanToValue);
  const liqLtv = num(stats.liquidationLtv);
  const health = ltv > 0 && liqLtv > 0 ? liqLtv / ltv : null;

  const topSupply = [...supplied].sort((a, b) => b.value - a.value)[0];
  const topBorrow = [...borrowed].sort((a, b) => b.value - a.value)[0];
  const marketName = topSupply && topBorrow
    ? `${topSupply.symbol} / ${topBorrow.symbol}`
    : String(marketMeta?.name || 'Kamino market');

  const marketKey = marketMeta?.lendingMarket || marketMeta?.address || 'unknown';

  return {
    id: `kamino:${wallet}:${marketKey}:${obligation?.obligationAddress || 'obligation'}`,
    protocol: 'Kamino',
    source: 'kamino-api',
    confidence: 'high',
    wallet,
    chainId: SOLANA_CHAIN_ID,
    chainName: 'Solana',
    marketName,
    marketId: obligation?.obligationAddress || marketKey,
    supplied,
    borrowed,
    totalSupplied,
    totalBorrowed,
    netValue,
    suppliedYieldUsd,
    borrowedCostUsd,
    supplyApy: totalSupplied ? suppliedYieldUsd / totalSupplied : null,
    borrowApy: totalBorrowed ? borrowedCostUsd / totalBorrowed : null,
    netApy: netApy({ totalSupplied, totalBorrowed, suppliedYieldUsd, borrowedCostUsd }),
    health,
  };
}

function jupiterHealthFactor(value) {
  const h = num(value, null);
  if (!Number.isFinite(h)) return null;
  if (h >= 1) return h;
  return 1 + h;
}

function mapJupiterBorrowPosition(wallet, vaultById, position) {
  const vaultId = num(position?.vaultId ?? position?.vault?.id, NaN);
  const vault = Number.isFinite(vaultId) ? vaultById.get(vaultId) : null;
  const supplyToken = position?.supplyToken || position?.collateralToken || vault?.supplyToken || {};
  const borrowToken = position?.borrowToken || position?.debtToken || vault?.borrowToken || {};

  let collateralUsd = num(
    position?.collateralUsd
    ?? position?.supplyUsd
    ?? position?.collateralValueUsd
    ?? position?.supplyValueUsd
    ?? position?.totalSupplyUsd,
    NaN,
  );
  let debtUsd = num(
    position?.debtUsd
    ?? position?.borrowUsd
    ?? position?.debtValueUsd
    ?? position?.borrowValueUsd
    ?? position?.totalBorrowUsd,
    NaN,
  );

  if (!Number.isFinite(collateralUsd)) {
    collateralUsd = tokenUsdValue(supplyToken, position?.supply ?? position?.collateral ?? position?.supplyAmount);
  }
  if (!Number.isFinite(debtUsd)) {
    debtUsd = tokenUsdValue(borrowToken, position?.debt ?? position?.borrow ?? position?.borrowAmount);
  }
  if (debtUsd <= 0.01) return null;

  const supplyApy = jupiterRatePercent(position?.supplyRate ?? vault?.supplyRate ?? vault?.supplyRateLiquidity);
  const borrowApy = jupiterRatePercent(position?.borrowRate ?? vault?.borrowRate ?? vault?.borrowRateLiquidity);
  const collateralValue = Math.max(collateralUsd, 0);
  const debtValue = Math.max(debtUsd, 0);
  const suppliedYieldUsd = collateralValue * num(supplyApy, 0);
  const borrowedCostUsd = debtValue * num(borrowApy, 0);

  const supplySymbol = supplyToken?.uiSymbol || supplyToken?.symbol || 'Collateral';
  const borrowSymbol = borrowToken?.uiSymbol || borrowToken?.symbol || 'Debt';
  const health = jupiterHealthFactor(position?.healthRatio ?? position?.health ?? position?.riskRatio);

  const positionId = position?.positionId ?? position?.nftId ?? position?.id ?? vaultId;

  return {
    id: `jupiter-lend:${wallet}:${vaultId}:${positionId}`,
    protocol: 'Jupiter',
    source: 'jupiter-lend-api',
    confidence: 'high',
    wallet,
    chainId: SOLANA_CHAIN_ID,
    chainName: 'Solana',
    marketName: `${supplySymbol} / ${borrowSymbol}`,
    marketId: String(positionId ?? vaultId ?? ''),
    supplied: collateralValue > 0.01 ? [{
      symbol: supplySymbol,
      value: collateralValue,
      apy: supplyApy,
      address: supplyToken?.address,
      isCollateral: true,
    }] : [],
    borrowed: [{
      symbol: borrowSymbol,
      value: debtValue,
      apy: borrowApy,
      address: borrowToken?.address,
    }],
    totalSupplied: collateralValue,
    totalBorrowed: debtValue,
    netValue: num(position?.netValueUsd ?? position?.netValue, collateralValue - debtValue),
    suppliedYieldUsd,
    borrowedCostUsd,
    supplyApy,
    borrowApy,
    netApy: netApy({
      totalSupplied: collateralValue,
      totalBorrowed: debtValue,
      suppliedYieldUsd,
      borrowedCostUsd,
    }),
    health: Number.isFinite(health) ? health : null,
  };
}

function mapJupiterPortfolioBorrowLend(wallet, element, vaultById, tokenInfo = {}) {
  if (!isJupiterPortfolioBorrowElement(element)) return null;

  const data = element?.data || {};
  const borrowedValue = num(data.borrowedValue);
  if (borrowedValue <= 0.01) return null;

  const link = String(data.link || '');
  const vaultMatch = link.match(/\/borrow\/(\d+)\//);
  const nftMatch = link.match(/\/nfts\/(\d+)/);
  const vaultId = vaultMatch ? num(vaultMatch[1], NaN) : NaN;
  const nftId = nftMatch ? num(nftMatch[1], NaN) : NaN;
  const vault = Number.isFinite(vaultId) ? vaultById.get(vaultId) : null;

  const supplied = (data.suppliedAssets || [])
    .map(asset => portfolioAssetLeg(asset, tokenInfo))
    .filter(leg => leg.value > 0.01);
  const borrowed = (data.borrowedAssets || [])
    .map((asset, idx) => {
      const leg = portfolioAssetLeg(asset, tokenInfo);
      const apyRaw = data.borrowedYields?.[idx]?.[0]?.apy ?? data.borrowedYields?.[0]?.[0]?.apy;
      const borrowApy = jupiterPortfolioApyPercent(apyRaw);
      if (borrowApy != null) leg.apy = Math.abs(borrowApy);
      return leg;
    })
    .filter(leg => leg.value > 0.01);

  if (!borrowed.length) return null;

  const supplySymbol = supplied[0]?.symbol || vault?.supplyToken?.uiSymbol || vault?.supplyToken?.symbol || 'Collateral';
  const borrowSymbol = borrowed[0]?.symbol || vault?.borrowToken?.uiSymbol || vault?.borrowToken?.symbol || 'Debt';

  const totalSupplied = num(data.suppliedValue) || supplied.reduce((sum, leg) => sum + leg.value, 0);
  const totalBorrowed = borrowedValue || borrowed.reduce((sum, leg) => sum + leg.value, 0);
  const netValue = num(data.value ?? element?.value, totalSupplied - totalBorrowed);

  const supplyApy = supplied[0]?.apy ?? jupiterRatePercent(vault?.supplyRate ?? vault?.supplyRateLiquidity);
  const borrowApy = borrowed[0]?.apy ?? jupiterRatePercent(vault?.borrowRate ?? vault?.borrowRateLiquidity);
  const suppliedYieldUsd = supplied.length
    ? supplied.reduce((sum, leg) => sum + leg.value * num(leg.apy, 0), 0)
    : totalSupplied * num(supplyApy, 0);
  const borrowedCostUsd = borrowed.length
    ? borrowed.reduce((sum, leg) => sum + leg.value * num(leg.apy, 0), 0)
    : totalBorrowed * num(borrowApy, 0);
  const netApyValue = Number.isFinite(element?.netApy)
    ? element.netApy * 100
    : netApy({ totalSupplied, totalBorrowed, suppliedYieldUsd, borrowedCostUsd });

  const health = jupiterHealthFactor(data.healthRatio);
  const positionRef = data.ref || link || `${vaultId}:${nftId}`;

  return {
    id: `jupiter-lend:${wallet}:${Number.isFinite(vaultId) ? vaultId : 'vault'}:${Number.isFinite(nftId) ? nftId : positionRef}`,
    protocol: 'Jupiter',
    source: 'jupiter-portfolio-api',
    confidence: 'high',
    wallet,
    chainId: SOLANA_CHAIN_ID,
    chainName: 'Solana',
    marketName: `${supplySymbol} / ${borrowSymbol}`,
    marketId: Number.isFinite(nftId) ? String(nftId) : String(positionRef),
    supplied: supplied.length ? supplied.map(leg => ({ ...leg, isCollateral: true })) : [{
      symbol: supplySymbol,
      value: totalSupplied,
      apy: supplyApy,
      address: vault?.supplyToken?.address,
      isCollateral: true,
    }],
    borrowed,
    totalSupplied,
    totalBorrowed,
    netValue,
    suppliedYieldUsd,
    borrowedCostUsd,
    supplyApy,
    borrowApy,
    netApy: netApyValue,
    health: Number.isFinite(health) ? health : null,
  };
}

function jupiterLendPositionKey(position) {
  return `${position?.wallet}:${position?.marketName}:${position?.marketId}`;
}

async function fetchKaminoMarkets() {
  const markets = await fetchJson(`${KAMINO_API}/v2/kamino-market`);
  return Array.isArray(markets) ? markets : [];
}

async function fetchKaminoReserveMetrics(marketPubkey) {
  const metrics = await fetchJson(`${KAMINO_API}/kamino-market/${marketPubkey}/reserves/metrics`);
  const byReserve = {};
  for (const row of Array.isArray(metrics) ? metrics : []) {
    if (row?.reserve) byReserve[row.reserve] = row;
  }
  return byReserve;
}

async function fetchKaminoWallet(wallet) {
  const markets = await fetchKaminoMarkets();
  const settled = await Promise.allSettled(markets.map(async (market) => {
    const marketPubkey = market?.lendingMarket || market?.address;
    if (!marketPubkey) return [];
    const obligations = await fetchJson(
      `${KAMINO_API}/kamino-market/${marketPubkey}/users/${wallet}/obligations`,
    );
    const active = (Array.isArray(obligations) ? obligations : [])
      .filter(ob => num(ob?.refreshedStats?.userTotalBorrow) > 0.01);
    if (!active.length) return [];
    const reservesByKey = await fetchKaminoReserveMetrics(marketPubkey);
    return active
      .map(ob => mapKaminoObligation(wallet, market, reservesByKey, ob))
      .filter(Boolean);
  }));

  const positions = [];
  const errors = [];
  for (const result of settled) {
    if (result.status === 'fulfilled') positions.push(...result.value);
    else errors.push({ provider: 'kamino', wallet, message: result.reason?.message || 'Kamino fetch failed' });
  }
  return { positions, errors };
}

async function fetchJupiterLendVaults() {
  const vaults = await fetchJson(`${JUPITER_LEND_API}/borrow/vaults`, { headers: jupiterHeaders() });
  const byId = new Map();
  for (const vault of Array.isArray(vaults) ? vaults : []) {
    if (vault?.id != null) byId.set(num(vault.id), vault);
  }
  return byId;
}

async function fetchJupiterPortfolioBorrowPositions(wallet, vaultById) {
  const portfolio = await fetchJson(
    `${JUPITER_PORTFOLIO_API}/positions/${encodeURIComponent(wallet)}`,
    { headers: jupiterHeaders() },
  );
  const tokenInfo = portfolio?.tokenInfo?.solana || {};
  return (portfolio?.elements || [])
    .map(el => mapJupiterPortfolioBorrowLend(wallet, el, vaultById, tokenInfo))
    .filter(Boolean);
}

async function fetchJupiterLendWallet(wallet) {
  const vaultById = await fetchJupiterLendVaults();
  const errors = [];
  let apiPositions = [];

  try {
    const positions = await fetchJson(
      `${JUPITER_LEND_API}/borrow/positions?wallet=${encodeURIComponent(wallet)}`,
      { headers: jupiterHeaders() },
    );
    apiPositions = (Array.isArray(positions) ? positions : [])
      .map(pos => mapJupiterBorrowPosition(wallet, vaultById, pos))
      .filter(Boolean);
  } catch (e) {
    errors.push({
      provider: 'jupiter-lend',
      wallet,
      message: e.message || 'Jupiter Lend borrow positions fetch failed',
    });
  }

  let portfolioPositions = [];
  try {
    portfolioPositions = await fetchJupiterPortfolioBorrowPositions(wallet, vaultById);
  } catch (e) {
    errors.push({
      provider: 'jupiter-portfolio',
      wallet,
      message: e.message || 'Jupiter Portfolio borrow positions fetch failed',
    });
  }

  const merged = new Map();
  for (const pos of [...apiPositions, ...portfolioPositions]) {
    merged.set(jupiterLendPositionKey(pos), pos);
  }

  return { positions: [...merged.values()], errors };
}

async function fetchSolanaLoopRates(wallets) {
  const cleanWallets = [...new Set((wallets || []).map(w => String(w || '').trim()).filter(isSolanaWallet))];
  if (!cleanWallets.length) {
    return { positions: [], errors: [] };
  }

  const kaminoSettled = await Promise.allSettled(cleanWallets.map(fetchKaminoWallet));
  const jupiterSettled = await Promise.allSettled(cleanWallets.map(fetchJupiterLendWallet));

  const positions = [];
  const errors = [];

  for (let i = 0; i < kaminoSettled.length; i++) {
    const result = kaminoSettled[i];
    if (result.status === 'fulfilled') {
      positions.push(...result.value.positions);
      errors.push(...result.value.errors);
    } else {
      errors.push({
        provider: 'kamino',
        wallet: cleanWallets[i],
        message: result.reason?.message || 'Kamino fetch failed',
      });
    }
  }

  for (let i = 0; i < jupiterSettled.length; i++) {
    const result = jupiterSettled[i];
    if (result.status === 'fulfilled') {
      positions.push(...result.value.positions);
      errors.push(...result.value.errors);
    } else {
      errors.push({
        provider: 'jupiter-lend',
        wallet: cleanWallets[i],
        message: result.reason?.message || 'Jupiter Lend fetch failed',
      });
    }
  }

  return { positions, errors, wallets: cleanWallets };
}

module.exports = {
  isSolanaWallet,
  isEvmWallet,
  kaminoMarketValueUsd,
  jupiterHealthFactor,
  mapKaminoObligation,
  mapJupiterBorrowPosition,
  mapJupiterPortfolioBorrowLend,
  isJupiterPortfolioBorrowElement,
  fetchSolanaLoopRates,
  fetchKaminoWallet,
  fetchJupiterLendWallet,
};

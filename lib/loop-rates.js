const { fetchSolanaLoopRates, isEvmWallet, isSolanaWallet } = require('./loop-solana-rates');
const { officialLoopPageUrl } = require('./loop-official-urls');

const AAVE_GQL = 'https://api.v3.aave.com/graphql';
const MORPHO_GQL = 'https://api.morpho.org/graphql';
const FLUID_API = 'https://api.fluid.instadapp.io';
const MERKL_API = 'https://api.merkl.xyz';
const DEFILLAMA_POOLS = 'https://yields.llama.fi/pools';

const AAVE_MARKETS = [
  { name: 'AaveV3Ethereum', chainId: 1, chainName: 'Ethereum', address: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2' },
  { name: 'AaveV3EthereumEtherFi', chainId: 1, chainName: 'Ethereum', address: '0x0AA97c284e98396202b6A04024F5E2c65026F3c0' },
  { name: 'AaveV3EthereumLido', chainId: 1, chainName: 'Ethereum', address: '0x4e033931ad43597d96D6bcc25c280717730B58B1' },
  { name: 'AaveV3EthereumHorizon', chainId: 1, chainName: 'Ethereum', address: '0xAe05Cd22df81871bc7cC2a04BeCfb516bFe332C8' },
  { name: 'AaveV3Optimism', chainId: 10, chainName: 'Optimism', address: '0x794a61358D6845594F94dc1DB02A252b5b4814aD' },
  { name: 'AaveV3BNB', chainId: 56, chainName: 'BSC', address: '0x6807dc923806fE8Fd134338EABCA509979a7e0cB' },
  { name: 'AaveV3Gnosis', chainId: 100, chainName: 'Gnosis', address: '0xb50201558B00496A145fE76f7424749556E326D8' },
  { name: 'AaveV3Polygon', chainId: 137, chainName: 'Polygon', address: '0x794a61358D6845594F94dc1DB02A252b5b4814aD' },
  { name: 'AaveV3ZkSync', chainId: 324, chainName: 'zkSync', address: '0x78e30497a3c7527d953c6B1E3541b021A98Ac43c' },
  { name: 'AaveV3Metis', chainId: 1088, chainName: 'Metis', address: '0x90df02551bB792286e8D4f13E0e357b4Bf1D6a57' },
  { name: 'AaveV3Base', chainId: 8453, chainName: 'Base', address: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5' },
  { name: 'AaveV3Arbitrum', chainId: 42161, chainName: 'Arbitrum', address: '0x794a61358D6845594F94dc1DB02A252b5b4814aD' },
  { name: 'AaveV3Avalanche', chainId: 43114, chainName: 'Avalanche', address: '0x794a61358D6845594F94dc1DB02A252b5b4814aD' },
  { name: 'AaveV3Scroll', chainId: 534352, chainName: 'Scroll', address: '0x11fCfe756c05AD438e312a7fd934381537D3cFfe' },
  { name: 'AaveV3MegaETH', chainId: 4326, chainName: 'MegaETH', address: '0x7e324AbC5De01d112AfC03a584966ff199741C28' },
  { name: 'AaveV3Sonic', chainId: 146, chainName: 'Sonic', address: '0x5362dBb1e601abF3a4c14c22ffEdA64042E5eAA3' },
  { name: 'AaveV3Linea', chainId: 59144, chainName: 'Linea', address: '0xc47b8C00b0f69a36fa203Ffeac0334874574a8Ac' },
  { name: 'AaveV3Mantle', chainId: 5000, chainName: 'Mantle', address: '0x458F293454fE0d67EC0655f3672301301DD51422' },
];

const MORPHO_CHAINS = [
  { chainId: 1, chainName: 'Ethereum' },
  { chainId: 10, chainName: 'Optimism' },
  { chainId: 130, chainName: 'Unichain' },
  { chainId: 137, chainName: 'Polygon' },
  { chainId: 480, chainName: 'World Chain' },
  { chainId: 999, chainName: 'HyperEVM' },
  { chainId: 4217, chainName: 'Tempo' },
  { chainId: 8453, chainName: 'Base' },
  { chainId: 42161, chainName: 'Arbitrum' },
  { chainId: 747474, chainName: 'Katana' },
  { chainId: 988, chainName: 'Stable' },
  { chainId: 143, chainName: 'Monad' },
];

const FLUID_CHAIN_NAME_TO_ID = {
  solana: 'solana',
  ethereum: 1,
  arbitrum: 42161,
  base: 8453,
  polygon: 137,
  plasma: 9745,
  optimism: 10,
  sonic: 146,
};

const FLUID_CHAINS = [
  { chainId: 1, chainName: 'Ethereum' },
  { chainId: 42161, chainName: 'Arbitrum' },
  { chainId: 8453, chainName: 'Base' },
  { chainId: 137, chainName: 'Polygon' },
  { chainId: 9745, chainName: 'Plasma' },
  { chainId: 10, chainName: 'Optimism' },
  { chainId: 146, chainName: 'Sonic' },
];

function isWallet(value) {
  return isEvmWallet(value);
}

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

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

async function gql(url, query, variables, { headers = {}, timeout = 25000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch (e) { json = { errors: [{ message: text || 'Invalid JSON' }] }; }
    if (!response.ok || json.errors?.length) {
      const message = json.errors?.map(e => e.message).join('; ') || `HTTP ${response.status}`;
      throw new Error(message);
    }
    return json.data;
  } finally {
    clearTimeout(timer);
  }
}

function chainKey(chainId, marketAddress) {
  return `${chainId}:${String(marketAddress || '').toLowerCase()}`;
}

function groupAavePositions(wallet, supplies, borrows, marketStates) {
  const byMarket = new Map();
  const ensure = (market) => {
    const key = chainKey(market?.chain?.chainId, market?.address);
    if (!byMarket.has(key)) {
      byMarket.set(key, {
        id: `aave:${wallet}:${key}`,
        protocol: 'Aave',
        source: 'aave-api',
        confidence: 'high',
        wallet,
        chainId: market?.chain?.chainId,
        chainName: market?.chain?.name,
        marketName: market?.name || 'Aave market',
        marketAddress: market?.address || null,
        supplied: [],
        borrowed: [],
        totalSupplied: 0,
        totalBorrowed: 0,
        suppliedYieldUsd: 0,
        borrowedCostUsd: 0,
        health: null,
      });
    }
    return byMarket.get(key);
  };

  for (const item of supplies || []) {
    const usd = num(item?.balance?.usd);
    if (usd <= 0.01) continue;
    const apy = percent(item?.apy?.value);
    const row = ensure(item.market);
    row.supplied.push({
      symbol: item?.currency?.symbol || 'Asset',
      value: usd,
      amount: num(item?.balance?.amount?.value),
      apy,
      address: item?.currency?.address,
      isCollateral: Boolean(item?.isCollateral),
    });
    row.totalSupplied += usd;
    row.suppliedYieldUsd += usd * apy;
  }

  for (const item of borrows || []) {
    const usd = num(item?.debt?.usd);
    if (usd <= 0.01) continue;
    const apy = percent(item?.apy?.value);
    const row = ensure(item.market);
    row.borrowed.push({
      symbol: item?.currency?.symbol || 'Debt',
      value: usd,
      amount: num(item?.debt?.amount?.value),
      apy,
      address: item?.currency?.address,
    });
    row.totalBorrowed += usd;
    row.borrowedCostUsd += usd * apy;
  }

  for (const [key, state] of Object.entries(marketStates || {})) {
    const row = byMarket.get(key);
    if (row) row.health = state?.healthFactor == null ? null : num(state.healthFactor, null);
  }

  return [...byMarket.values()]
    .filter(p => p.totalBorrowed > 0.01)
    .map(p => {
      p.netValue = p.totalSupplied - p.totalBorrowed;
      p.supplyApy = p.totalSupplied ? p.suppliedYieldUsd / p.totalSupplied : null;
      p.borrowApy = p.totalBorrowed ? p.borrowedCostUsd / p.totalBorrowed : null;
      p.netApy = netApy(p);
      return p;
    });
}

async function fetchAaveWallet(wallet) {
  const marketInputs = AAVE_MARKETS.map(({ address, chainId }) => ({ address, chainId }));
  const query = `query AaveLoops($markets:[MarketInput!]!, $user:EvmAddress!) {
    userSupplies(request:{markets:$markets,user:$user,collateralsOnly:false,orderBy:{balance:DESC}}) {
      market { name address chain { chainId name } }
      currency { symbol address decimals }
      balance { amount { value } usd }
      apy { value formatted }
      isCollateral
      canBeCollateral
    }
    userBorrows(request:{markets:$markets,user:$user,orderBy:{debt:DESC}}) {
      market { name address chain { chainId name } }
      currency { symbol address decimals }
      debt { amount { value } usd }
      apy { value formatted }
    }
  }`;
  const data = await gql(AAVE_GQL, query, { markets: marketInputs, user: wallet }, {
    headers: { Origin: 'https://app.aave.com', Referer: 'https://app.aave.com/' },
    timeout: 35000,
  });
  const activeMarkets = new Map();
  for (const item of [...(data.userSupplies || []), ...(data.userBorrows || [])]) {
    const market = item.market;
    if (!market?.address || !market?.chain?.chainId) continue;
    const usd = num(item?.balance?.usd ?? item?.debt?.usd);
    if (usd <= 0.01) continue;
    activeMarkets.set(chainKey(market.chain.chainId, market.address), {
      address: market.address,
      chainId: market.chain.chainId,
    });
  }
  const states = {};
  const active = [...activeMarkets.entries()];
  for (let i = 0; i < active.length; i += 8) {
    const chunk = active.slice(i, i + 8);
    const stateFields = chunk.map(([, m], idx) => (
      `s${idx}: userMarketState(request:{market:"${m.address}",user:$user,chainId:${m.chainId}}){ healthFactor netWorth totalCollateralBase totalDebtBase }`
    )).join('\n');
    if (!stateFields) continue;
    const stateData = await gql(AAVE_GQL, `query AaveLoopStates($user:EvmAddress!) { ${stateFields} }`, { user: wallet }, {
      headers: { Origin: 'https://app.aave.com', Referer: 'https://app.aave.com/' },
      timeout: 20000,
    });
    chunk.forEach(([key], idx) => { states[key] = stateData[`s${idx}`]; });
  }
  return groupAavePositions(wallet, data.userSupplies, data.userBorrows, states);
}

function morphoAssetLabel(asset) {
  return asset?.symbol || 'Asset';
}

function morphoRawUnits(value, decimals = 18) {
  if (value == null || value === '') return 0;
  const dec = Math.max(0, num(decimals, 18));
  try {
    const bi = BigInt(String(value).split('.')[0]);
    return Number(bi) / (10 ** dec);
  } catch {
    return num(value, 0) / (10 ** dec);
  }
}

function morphoAssetPriceUsd(asset) {
  const usd = asset?.price?.usd ?? asset?.priceUsd;
  const px = num(usd, 0);
  return px > 0 ? px : null;
}

function morphoUsdLikeSymbol(symbol) {
  const s = String(symbol || '').toUpperCase();
  return /USD|DAI|FRAX|GHO|LUSD|EURC|PYUSD|USDS|USDT|USDC|RLUSD|REUSD|JRUSDE|SUSDE|CUSDO|USR|ETH/i.test(s)
    || s.endsWith('USD');
}

function morphoUsdFromRaw(amountRaw, asset) {
  if (amountRaw == null || amountRaw === '' || amountRaw === 0) return 0;
  const units = morphoRawUnits(amountRaw, asset?.decimals);
  if (!units) return 0;
  const px = morphoAssetPriceUsd(asset);
  if (px) return units * px;
  if (morphoUsdLikeSymbol(morphoAssetLabel(asset))) return units;
  return 0;
}

function morphoUsdField(stateValueUsd, amountRaw, asset) {
  const direct = num(stateValueUsd, 0);
  if (direct > 0.01) return direct;
  return morphoUsdFromRaw(amountRaw, asset);
}

function mapMorphoMarketPosition(wallet, chain, pos) {
  const state = pos?.state || {};
  const market = pos?.market || {};
  const marketState = market?.state || {};
  const collateralUsd = morphoUsdField(state.collateralUsd, state.collateral, market.collateralAsset);
  const supplyUsd = morphoUsdField(state.supplyAssetsUsd, state.supplyAssets, market.loanAsset);
  const borrowUsd = morphoUsdField(state.borrowAssetsUsd, state.borrowAssets, market.loanAsset);
  if (borrowUsd <= 0.01 && supplyUsd <= 0.01 && collateralUsd <= 0.01) return null;
  if (borrowUsd <= 0.01 && supplyUsd <= 0.01) return null;

  const supplyApy = percent(marketState.avgNetSupplyApy ?? marketState.supplyApy);
  const borrowApy = percent(marketState.avgNetBorrowApy ?? marketState.borrowApy);
  const supplied = [];
  let totalSupplied = 0;
  let suppliedYieldUsd = 0;

  if (collateralUsd > 0.01) {
    supplied.push({
      symbol: morphoAssetLabel(market.collateralAsset),
      value: collateralUsd,
      amount: morphoRawUnits(state.collateral, market.collateralAsset?.decimals),
      apy: 0,
      role: 'collateral',
      address: market.collateralAsset?.address,
    });
    totalSupplied += collateralUsd;
  }
  if (supplyUsd > 0.01) {
    supplied.push({
      symbol: morphoAssetLabel(market.loanAsset),
      value: supplyUsd,
      amount: morphoRawUnits(state.supplyAssets, market.loanAsset?.decimals),
      apy: supplyApy,
      role: 'supply',
      address: market.loanAsset?.address,
    });
    totalSupplied += supplyUsd;
    suppliedYieldUsd += supplyUsd * supplyApy;
  }

  const borrowed = borrowUsd > 0.01 ? [{
    symbol: morphoAssetLabel(market.loanAsset),
    value: borrowUsd,
    amount: morphoRawUnits(state.borrowAssets, market.loanAsset?.decimals),
    apy: borrowApy,
    address: market.loanAsset?.address,
  }] : [];

  return {
    id: `morpho:${wallet}:${chain.chainId}:${market.marketId}`,
    protocol: 'Morpho',
    source: 'morpho-api',
    confidence: 'high',
    wallet,
    chainId: chain.chainId,
    chainName: chain.chainName,
    marketName: `${morphoAssetLabel(market.collateralAsset)} / ${morphoAssetLabel(market.loanAsset)}`,
    marketId: market.marketId,
    supplied,
    borrowed,
    totalSupplied,
    totalBorrowed: borrowUsd,
    netValue: totalSupplied - borrowUsd,
    suppliedYieldUsd,
    borrowedCostUsd: borrowUsd * borrowApy,
    supplyApy: totalSupplied ? suppliedYieldUsd / totalSupplied : null,
    borrowApy: borrowUsd ? borrowApy : null,
    netApy: netApy({ totalSupplied, totalBorrowed: borrowUsd, suppliedYieldUsd, borrowedCostUsd: borrowUsd * borrowApy }),
    health: pos?.healthFactor == null ? null : num(pos.healthFactor, null),
  };
}

function mapMorphoVaultPosition(wallet, chain, pos, version) {
  const vault = pos?.vault || {};
  const assetsUsd = morphoUsdField(
    pos?.state?.assetsUsd ?? pos?.assetsUsd,
    pos?.state?.assets ?? pos?.assets,
    vault.asset,
  );
  if (assetsUsd <= 0.01) return null;
  const apy = percent(vault?.state?.netApy ?? vault?.state?.apy ?? vault?.netApy ?? vault?.apy);
  return {
    id: `morpho-vault:${version}:${wallet}:${chain.chainId}:${vault.address}`,
    protocol: 'Morpho',
    source: 'morpho-api',
    confidence: 'high',
    wallet,
    chainId: chain.chainId,
    chainName: chain.chainName,
    marketName: vault.name || `Morpho vault ${version}`,
    marketId: vault.address,
    supplied: [{
      symbol: morphoAssetLabel(vault.asset),
      value: assetsUsd,
      apy,
      role: 'vault',
      address: vault.asset?.address,
    }],
    borrowed: [],
    totalSupplied: assetsUsd,
    totalBorrowed: 0,
    netValue: assetsUsd,
    supplyApy: apy,
    borrowApy: null,
    netApy: apy,
    health: null,
    vaultOnly: true,
  };
}

async function fetchMorphoWalletChain(wallet, chain) {
  const query = `query MorphoLoops($address:String!, $chainId:Int!) {
    userByAddress(address:$address, chainId:$chainId) {
      marketPositions {
        healthFactor
        market {
          marketId
          loanAsset { symbol address decimals price { usd } }
          collateralAsset { symbol address decimals price { usd } }
          state { supplyApy avgSupplyApy avgNetSupplyApy borrowApy avgBorrowApy avgNetBorrowApy utilization }
        }
        state {
          collateral collateralUsd
          supplyAssets supplyAssetsUsd
          borrowAssets borrowAssetsUsd
        }
      }
      vaultPositions {
        vault { address name asset { symbol address decimals price { usd } } state { apy netApy avgNetApy } }
        state { assets assetsUsd }
      }
      vaultV2Positions {
        vault { address name asset { symbol address decimals price { usd } } apy netApy avgNetApy }
        assets assetsUsd
        shares
      }
    }
  }`;
  const data = await gql(MORPHO_GQL, query, { address: wallet, chainId: chain.chainId }, { timeout: 15000 });
  const user = data?.userByAddress;
  if (!user) return [];
  return [
    ...(user.marketPositions || []).map(pos => mapMorphoMarketPosition(wallet, chain, pos)),
    ...(user.vaultPositions || []).map(pos => mapMorphoVaultPosition(wallet, chain, pos, 'v1')),
    ...(user.vaultV2Positions || []).map(pos => mapMorphoVaultPosition(wallet, chain, pos, 'v2')),
  ].filter(Boolean);
}

async function fetchMorphoWallet(wallet) {
  const settled = await Promise.allSettled(MORPHO_CHAINS.map(chain => fetchMorphoWalletChain(wallet, chain)));
  return {
    positions: settled.flatMap(r => r.status === 'fulfilled' ? r.value : []),
    errors: settled
      .map((r, i) => r.status === 'rejected' ? { provider: 'morpho', wallet, chainId: MORPHO_CHAINS[i].chainId, message: r.reason?.message || 'Morpho fetch failed' } : null)
      .filter(Boolean),
  };
}

async function fetchDefillamaFluidPools() {
  try {
    const response = await fetch(DEFILLAMA_POOLS, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error(`DeFiLlama HTTP ${response.status}`);
    const json = await response.json();
    return (json.data || [])
      .filter(p => /^fluid/i.test(String(p.project || '')))
      .map(p => ({
        chain: p.chain,
        chainId: FLUID_CHAIN_NAME_TO_ID[String(p.chain || '').toLowerCase()] || null,
        project: p.project,
        symbol: p.symbol,
        apy: num(p.apy, null),
        apyBase: num(p.apyBase, null),
        apyReward: num(p.apyReward, null),
        tvlUsd: num(p.tvlUsd, null),
        pool: p.pool,
        underlyingTokens: p.underlyingTokens || [],
      }));
  } catch (e) {
    return { error: e.message || 'Fluid pool rate fetch failed' };
  }
}

function fluidPairToken0(pair) {
  const t0 = pair?.token0;
  if (t0?.address && !/^0x0+$/i.test(String(t0.address))) return t0;
  return pair?.token1;
}

function fluidTokenUsd(amountRaw, token) {
  if (amountRaw == null || amountRaw === '' || amountRaw === '0') return 0;
  const units = morphoRawUnits(amountRaw, token?.decimals);
  if (!units) return 0;
  const px = num(token?.price, 0);
  return px > 0 ? units * px : 0;
}

function fluidApyFromBps(bps) {
  return num(bps, 0) / 100;
}

function fluidMaxRateBps(rateObj) {
  if (!rateObj) return 0;
  const liq = rateObj.liquidity || {};
  const vault = rateObj.vault || {};
  return Math.max(num(liq.token0), num(liq.token1), num(rateObj.dex?.trading), num(vault.rate));
}

function fluidEstimateHealth(supplyUsd, borrowUsd, liquidationThresholdBps) {
  if (!borrowUsd || borrowUsd <= 0.01 || !supplyUsd) return null;
  const lt = num(liquidationThresholdBps, 0) / 10000;
  if (!lt) return null;
  return (supplyUsd * lt) / borrowUsd;
}

function mapFluidVaultNft(wallet, chain, nft) {
  const supplyRaw = nft?.supply;
  const borrowRaw = nft?.borrow;
  if ((!supplyRaw || supplyRaw === '0') && (!borrowRaw || borrowRaw === '0')) return null;

  const vault = nft?.vault || {};
  const supplyToken = fluidPairToken0(vault.supplyToken);
  const borrowToken = fluidPairToken0(vault.borrowToken);
  const supplyUsd = fluidTokenUsd(supplyRaw, supplyToken);
  const borrowUsd = fluidTokenUsd(borrowRaw, borrowToken);
  if (supplyUsd <= 0.01 && borrowUsd <= 0.01) return null;

  const supplyApy = fluidApyFromBps(fluidMaxRateBps(vault.supplyRate));
  const borrowApy = fluidApyFromBps(fluidMaxRateBps(vault.borrowRate));
  const health = fluidEstimateHealth(supplyUsd, borrowUsd, vault.liquidationThreshold);

  return {
    id: `fluid-vault:${wallet}:${chain.chainId}:${vault.id || vault.address || nft.id || nft.nftId}`,
    protocol: 'Fluid',
    source: 'fluid-official-api',
    confidence: 'high',
    wallet,
    chainId: chain.chainId,
    chainName: chain.chainName,
    marketName: vault.metadata?.name || `Fluid Vault #${nft.id || ''}`.trim(),
    supplied: supplyUsd > 0.01 ? [{
      symbol: supplyToken?.symbol || 'Collateral',
      value: supplyUsd,
      amount: morphoRawUnits(supplyRaw, supplyToken?.decimals),
      apy: supplyApy,
      address: supplyToken?.address,
    }] : [],
    borrowed: borrowUsd > 0.01 ? [{
      symbol: borrowToken?.symbol || 'Debt',
      value: borrowUsd,
      amount: morphoRawUnits(borrowRaw, borrowToken?.decimals),
      apy: borrowApy,
    }] : [],
    totalSupplied: supplyUsd,
    totalBorrowed: borrowUsd,
    netValue: supplyUsd - borrowUsd,
    supplyApy,
    borrowApy: borrowUsd > 0.01 ? borrowApy : null,
    netApy: netApy({
      totalSupplied: supplyUsd,
      totalBorrowed: borrowUsd,
      suppliedYieldUsd: supplyUsd * supplyApy,
      borrowedCostUsd: borrowUsd * borrowApy,
    }),
    health,
  };
}

function mapFluidLendingPosition(wallet, chain, row) {
  const underlying = row?.underlyingAssets ?? row?.underlyingBalance;
  if (!underlying || underlying === '0') return null;
  const token = row?.token || {};
  const asset = token?.asset || {};
  const usd = fluidTokenUsd(underlying, asset);
  if (usd <= 0.01) return null;
  const supplyApy = fluidApyFromBps(token.totalRate || token.supplyRate);
  const symbol = token.symbol || asset.symbol || 'Asset';
  return {
    id: `fluid-lending:${wallet}:${chain.chainId}:${symbol}`,
    protocol: 'Fluid',
    source: 'fluid-official-api',
    confidence: 'high',
    wallet,
    chainId: chain.chainId,
    chainName: chain.chainName,
    marketName: symbol,
    supplied: [{ symbol: asset.symbol || symbol, value: usd, apy: supplyApy }],
    borrowed: [],
    totalSupplied: usd,
    totalBorrowed: 0,
    netValue: usd,
    supplyApy,
    borrowApy: null,
    netApy: supplyApy,
    health: null,
    vaultOnly: true,
  };
}

async function fluidFetchJson(path, timeout = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(`${FLUID_API}${path}`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Fluid HTTP ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFluidWalletChain(wallet, chain) {
  const positions = [];
  const errors = [];
  try {
    const lending = await fluidFetchJson(`/v2/lending/${chain.chainId}/users/${wallet}/positions`);
    for (const row of lending?.data || []) {
      const mapped = mapFluidLendingPosition(wallet, chain, row);
      if (mapped) positions.push(mapped);
    }
  } catch (e) {
    errors.push({ provider: 'fluid', wallet, chainId: chain.chainId, message: e.message || 'Fluid lending fetch failed' });
  }
  try {
    const nfts = await fluidFetchJson(`/v2/${chain.chainId}/users/${wallet}/nfts`);
    for (const nft of Array.isArray(nfts) ? nfts : []) {
      const mapped = mapFluidVaultNft(wallet, chain, nft);
      if (mapped) positions.push(mapped);
    }
  } catch (e) {
    errors.push({ provider: 'fluid', wallet, chainId: chain.chainId, message: e.message || 'Fluid vault fetch failed' });
  }
  return { positions, errors };
}

function merklIndexKey(wallet, chainId, address) {
  return `${wallet}:${chainId}:${String(address || '').toLowerCase()}`;
}

function buildMerklAprIndex(walletEntries) {
  const byUnderlying = new Map();
  const byExplorer = new Map();

  for (const { wallet, items } of walletEntries) {
    for (const item of items || []) {
      const opp = item?.opportunity;
      if (!opp || opp.status !== 'LIVE') continue;
      const apr = num(opp.apr, 0);
      if (apr <= 0) continue;
      const meta = {
        apr,
        name: opp.name,
        opportunityId: opp.id,
        type: opp.type,
      };

      if (opp.explorerAddress) {
        const key = merklIndexKey(wallet, opp.chainId, opp.explorerAddress);
        const prev = byExplorer.get(key);
        if (!prev || apr > prev.apr) byExplorer.set(key, meta);
      }

      const underlyingAddrs = new Set(
        (opp.tokens || [])
          .filter(t => t?.address && !/^a[A-Za-z]/.test(String(t.symbol || '')))
          .map(t => String(t.address).toLowerCase()),
      );
      for (const token of opp.tokens || []) {
        const addr = String(token.address || '').toLowerCase();
        if (!addr || /^0x0+$/.test(addr)) continue;
        const sym = String(token.symbol || '');
        if (/^a[A-Za-z]/.test(sym) && underlyingAddrs.size) continue;
        const key = merklIndexKey(wallet, opp.chainId, addr);
        const prev = byUnderlying.get(key);
        if (!prev || apr > prev.apr) byUnderlying.set(key, meta);
      }
    }
  }

  return { byUnderlying, byExplorer };
}

function normalizeYieldSymbol(symbol) {
  return String(symbol || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

const DEFILLAMA_NATIVE_PROJECTS = {
  REUSD: new Set(['re', 'resupply']),
  USDE: new Set(['ethena', 're']),
  SUSDE: new Set(['ethena']),
  WSTETH: new Set(['lido']),
  STETH: new Set(['lido']),
};

function defillamaPoolScore(pool) {
  const apy = num(pool.apy, 0);
  if (apy <= 0.01) return -1;
  const symbol = normalizeYieldSymbol(pool.symbol);
  const project = String(pool.project || '').toLowerCase();
  if (/^(PT|YT)/.test(symbol)) return -1;
  if (/pendle|penpie|equilibria|beefy|stake-dao|morpho-blue|fluid-lending|aave-v3/i.test(project)) {
    return apy * 0.05;
  }
  const preferred = DEFILLAMA_NATIVE_PROJECTS[symbol];
  if (preferred?.has(project)) return 1000 + apy;
  return apy;
}

async function fetchDefillamaYieldApyIndex() {
  const empty = { bySymbolChain: new Map(), byAddress: new Map() };
  try {
    const response = await fetch(DEFILLAMA_POOLS, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`DeFiLlama HTTP ${response.status}`);
    const json = await response.json();
    const bySymbolChain = new Map();
    const byAddress = new Map();

    for (const pool of json.data || []) {
      const chainId = FLUID_CHAIN_NAME_TO_ID[String(pool.chain || '').toLowerCase()];
      if (!chainId) continue;
      const score = defillamaPoolScore(pool);
      if (score < 0) continue;
      const apy = num(pool.apy, 0);

      const symbol = normalizeYieldSymbol(pool.symbol);
      if (symbol) {
        const key = `${chainId}:${symbol}`;
        const prev = bySymbolChain.get(key);
        if (!prev || score > prev.score) {
          bySymbolChain.set(key, { apy, score, project: pool.project, symbol });
        }
      }

      for (const addr of pool.underlyingTokens || []) {
        const address = String(addr || '').toLowerCase();
        if (!address || /^0x0+$/.test(address)) continue;
        const key = `${chainId}:${address}`;
        const prev = byAddress.get(key);
        if (!prev || score > prev.score) {
          byAddress.set(key, { apy, score, project: pool.project, symbol: pool.symbol });
        }
      }
    }

    return { ...empty, bySymbolChain, byAddress };
  } catch (e) {
    return { ...empty, error: e.message || 'DeFiLlama yield APY fetch failed' };
  }
}

function canonicalNativeYieldApy(chainId, leg, index) {
  if (!index) return null;
  const symbol = normalizeYieldSymbol(leg?.symbol);
  if (!symbol || !DEFILLAMA_NATIVE_PROJECTS[symbol]) return null;
  const bySym = index.bySymbolChain?.get(`${chainId}:${symbol}`);
  return bySym?.apy > 0.01 ? bySym.apy : null;
}

function defillamaApyForLeg(chainId, leg, index) {
  if (!index) return null;
  const canonical = canonicalNativeYieldApy(chainId, leg, index);
  if (canonical) return canonical;
  const address = String(leg?.address || '').toLowerCase();
  if (address) {
    const byAddr = index.byAddress?.get(`${chainId}:${address}`);
    if (byAddr?.apy > 0.01) return byAddr.apy;
  }
  const symbol = normalizeYieldSymbol(leg?.symbol);
  if (symbol) {
    const bySym = index.bySymbolChain?.get(`${chainId}:${symbol}`);
    if (bySym?.apy > 0.01) return bySym.apy;
  }
  return null;
}

function recomputePositionApy(position) {
  position.supplyApy = position.totalSupplied
    ? position.suppliedYieldUsd / position.totalSupplied
    : position.supplyApy;
  position.netApy = netApy({
    totalSupplied: position.totalSupplied,
    totalBorrowed: position.totalBorrowed,
    suppliedYieldUsd: position.suppliedYieldUsd,
    borrowedCostUsd: position.borrowedCostUsd,
  });
}

function enrichPositionWithDefillamaYield(position, index) {
  if (!position || !index) return position;
  let touched = false;
  const yieldBase = positionYieldBase(position);
  position.suppliedYieldUsd = yieldBase.suppliedYieldUsd;
  position.borrowedCostUsd = yieldBase.borrowedCostUsd;

  for (const leg of position.supplied || []) {
    const dlApy = defillamaApyForLeg(position.chainId, leg, index);
    if (!dlApy || dlApy <= 0.01) continue;
    const canonical = canonicalNativeYieldApy(position.chainId, leg, index);
    if (!canonical && num(leg.apy, 0) > 0.01) continue;
    leg.nativeApy = leg.nativeApy ?? leg.apy;
    leg.defillamaApy = dlApy;
    leg.apy = dlApy;
    touched = true;
  }

  if (touched) {
    position.suppliedYieldUsd = (position.supplied || []).reduce(
      (sum, leg) => sum + num(leg.value) * num(leg.apy, 0),
      0,
    );
    position.defillamaBoost = true;
    recomputePositionApy(position);
  }
  return position;
}

function positionMatchesMerklOpportunity(position, opportunity) {
  if (!position || !opportunity) return false;
  if (num(position.chainId) !== num(opportunity.chainId)) return false;

  const tokenAddrs = new Set(
    (opportunity.tokens || [])
      .map(t => String(t.address || '').toLowerCase())
      .filter(addr => addr && !/^0x0+$/.test(addr)),
  );
  for (const leg of position.supplied || []) {
    const addr = String(leg.address || '').toLowerCase();
    if (addr && tokenAddrs.has(addr)) return true;
  }

  const explorer = String(opportunity.explorerAddress || '').toLowerCase();
  if (explorer) {
    const keys = [position.marketId, position.vaultAddress, position.id?.split(':').pop()]
      .filter(Boolean)
      .map(v => String(v).toLowerCase());
    if (keys.includes(explorer)) return true;
  }
  return false;
}

function merklTokenUsd(reward, rawAmount) {
  const decimals = num(reward?.token?.decimals, 18);
  const price = num(reward?.token?.price, 0);
  return morphoRawUnits(rawAmount, decimals) * price;
}

function merklUnclaimedUsdFromBreakdown(reward, breakdown) {
  const decimals = num(reward?.token?.decimals, 18);
  const price = num(reward?.token?.price, 0);
  const amount = morphoRawUnits(breakdown?.amount, decimals);
  const claimed = morphoRawUnits(breakdown?.claimed, decimals);
  return Math.max(0, amount - claimed) * price;
}

function merklUnclaimedUsdFromReward(reward) {
  const decimals = num(reward?.token?.decimals, 18);
  const price = num(reward?.token?.price, 0);
  const amount = morphoRawUnits(reward?.amount, decimals);
  const claimed = morphoRawUnits(reward?.claimed, decimals);
  return Math.max(0, amount - claimed) * price;
}

function merklClaimedUsdFromReward(reward) {
  return merklTokenUsd(reward, reward?.claimed);
}

function buildMerklOpportunityIndex(activeEntries) {
  const byId = new Map();
  for (const { wallet, items } of activeEntries || []) {
    for (const item of items || []) {
      const id = item?.opportunity?.id;
      if (!id) continue;
      byId.set(`${String(wallet).toLowerCase()}:${id}`, item.opportunity);
    }
  }
  return byId;
}

function distributeMerklUsdToPositions(positions, walletKey, opportunityIds, oppById, usd, bucket) {
  if (usd <= 0.01) return;
  const matchIds = new Set();
  const matches = [];
  for (const oppId of opportunityIds || []) {
    const opportunity = oppById.get(`${walletKey}:${oppId}`);
    if (!opportunity) continue;
    for (const position of positions || []) {
      if (String(position.wallet || '').toLowerCase() !== walletKey) continue;
      if (!positionMatchesMerklOpportunity(position, opportunity)) continue;
      if (matchIds.has(position.id)) continue;
      matchIds.add(position.id);
      matches.push(position);
    }
  }
  if (!matches.length) return;
  const weightTotal = matches.reduce(
    (sum, p) => sum + (Math.abs(num(p.netValue)) || num(p.totalSupplied) || 1),
    0,
  ) || matches.length;
  for (const position of matches) {
    const weight = Math.abs(num(position.netValue)) || num(position.totalSupplied) || 1;
    const share = weight / weightTotal;
    bucket[position.id] = num(bucket[position.id]) + usd * share;
  }
}

function buildMerklUnclaimedUsdMap(rewardEntries, activeEntries, positions) {
  const oppById = buildMerklOpportunityIndex(activeEntries);
  const earnedByPosition = {};
  const claimedByPosition = {};

  for (const { wallet, chains } of rewardEntries || []) {
    const walletKey = String(wallet || '').toLowerCase();
    for (const chainBlock of chains || []) {
      for (const reward of chainBlock.rewards || []) {
        const opportunityIds = uniq((reward.breakdowns || []).map(b => b.opportunityId).filter(Boolean));
        const unclaimedUsd = merklUnclaimedUsdFromReward(reward);
        const claimedUsd = merklClaimedUsdFromReward(reward);
        distributeMerklUsdToPositions(positions, walletKey, opportunityIds, oppById, unclaimedUsd, earnedByPosition);
        distributeMerklUsdToPositions(positions, walletKey, opportunityIds, oppById, claimedUsd, claimedByPosition);
      }
    }
  }

  return { unclaimedByPosition: earnedByPosition, claimedByPosition };
}

function merklRewardChainIds() {
  return uniq([
    ...AAVE_MARKETS.map(m => m.chainId),
    ...MORPHO_CHAINS.map(m => m.chainId),
    ...FLUID_CHAINS.map(c => c.chainId),
  ]);
}

async function fetchMerklUserRewards(wallets, chainIds) {
  const headers = { Accept: 'application/json' };
  const apiKey = process.env.MERKL_API_KEY;
  if (apiKey) headers['X-API-Key'] = apiKey;

  const ids = uniq((chainIds || []).map(c => num(c)).filter(Boolean));
  const tasks = [];
  for (const wallet of wallets || []) {
    for (const chainId of ids) {
      tasks.push((async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
          const response = await fetch(`${MERKL_API}/v4/users/${wallet}/rewards?chainId=${chainId}`, {
            headers,
            signal: controller.signal,
          });
          if (!response.ok) throw new Error(`Merkl rewards HTTP ${response.status}`);
          const json = await response.json();
          return { wallet, chainId, chains: Array.isArray(json) ? json : [] };
        } finally {
          clearTimeout(timer);
        }
      })());
    }
  }

  const settled = await Promise.allSettled(tasks);
  const entries = [];
  const errors = [];
  for (const result of settled) {
    if (result.status === 'fulfilled') entries.push(result.value);
    else errors.push({ provider: 'merkl-rewards', message: result.reason?.message || 'Merkl rewards fetch failed' });
  }
  return { entries, errors };
}

function applyMerklRewardsToPositions(positions, merklByPosition) {
  const unclaimedByPosition = merklByPosition?.unclaimedByPosition || merklByPosition || {};
  const claimedByPosition = merklByPosition?.claimedByPosition || {};
  for (const position of positions || []) {
    const merklRewardsUsd = num(unclaimedByPosition?.[position.id]);
    const merklClaimedUsd = num(claimedByPosition?.[position.id]);
    if (merklRewardsUsd <= 0.01 && merklClaimedUsd <= 0.01) continue;
    if (merklRewardsUsd > 0.01) {
      position.merklRewardsUsd = merklRewardsUsd;
      position.economicNetValue = num(position.netValue) + merklRewardsUsd;
    }
    if (merklClaimedUsd > 0.01) position.merklClaimedUsd = merklClaimedUsd;
  }
  return positions;
}

function positionYieldBase(position) {
  let suppliedYieldUsd = num(position.suppliedYieldUsd, NaN);
  let borrowedCostUsd = num(position.borrowedCostUsd, NaN);
  if (!Number.isFinite(suppliedYieldUsd)) {
    suppliedYieldUsd = (position.supplied || []).reduce(
      (sum, leg) => sum + num(leg.value) * num(leg.nativeApy ?? leg.apy, 0),
      0,
    );
  }
  if (!Number.isFinite(borrowedCostUsd)) {
    borrowedCostUsd = (position.borrowed || []).reduce(
      (sum, leg) => sum + num(leg.value) * num(leg.apy, 0),
      0,
    );
  }
  return { suppliedYieldUsd, borrowedCostUsd };
}

function enrichPositionWithMerkl(position, merklIndex) {
  if (!position || !merklIndex) return position;
  let touched = false;
  const yieldBase = positionYieldBase(position);
  position.suppliedYieldUsd = yieldBase.suppliedYieldUsd;
  position.borrowedCostUsd = yieldBase.borrowedCostUsd;

  for (const leg of position.supplied || []) {
    const addr = String(leg.address || '').toLowerCase();
    if (!addr) continue;
    const meta = merklIndex.byUnderlying.get(merklIndexKey(position.wallet, position.chainId, addr));
    if (!meta) continue;
    leg.nativeApy = leg.apy;
    leg.merklApy = meta.apr;
    leg.merklCampaign = meta.name;
    leg.apy = num(leg.apy, 0) + meta.apr;
    position.suppliedYieldUsd = num(position.suppliedYieldUsd, 0) + num(leg.value) * meta.apr;
    touched = true;
  }

  const explorerKeys = [
    position.marketId,
    position.vaultAddress,
    position.id?.split(':').pop(),
  ].filter(Boolean);
  if (!touched && explorerKeys.length) {
    for (const keyAddr of explorerKeys) {
      const meta = merklIndex.byExplorer.get(merklIndexKey(position.wallet, position.chainId, keyAddr));
      if (!meta) continue;
      for (const leg of position.supplied || []) {
        leg.nativeApy = leg.apy;
        leg.merklApy = meta.apr;
        leg.merklCampaign = meta.name;
        leg.apy = num(leg.apy, 0) + meta.apr;
        position.suppliedYieldUsd = num(position.suppliedYieldUsd, 0) + num(leg.value) * meta.apr;
      }
      touched = true;
      break;
    }
  }

  if (touched) {
    position.merklBoost = true;
    recomputePositionApy(position);
  }

  return position;
}

function loopPositionStableKey(position) {
  const protocol = String(position?.protocol || '').trim().toLowerCase();
  const wallet = String(position?.wallet || '').trim().toLowerCase();
  const chainId = String(position?.chainId ?? '').trim().toLowerCase();
  const marketName = String(position?.marketName || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!protocol || !wallet || !chainId || !marketName) return String(position?.id || '');
  return `${protocol}:${wallet}:${chainId}:${marketName}`;
}

function shouldPreserveMissingSolanaPosition(position, currentPositions, errors) {
  const protocol = String(position?.protocol || '').trim().toLowerCase();
  if (protocol !== 'kamino' && protocol !== 'jupiter') return false;
  const rawWallet = String(position?.wallet || '').trim();
  const wallet = rawWallet.toLowerCase();
  if (!isSolanaWallet(rawWallet)) return false;
  const providerErrored = (errors || []).some((e) => {
    const provider = String(e?.provider || '').toLowerCase();
    return (protocol === 'kamino' && provider.includes('kamino'))
      || (protocol === 'jupiter' && provider.includes('jupiter'));
  });
  if (providerErrored) return true;
  const currentHasProtocolForWallet = (currentPositions || []).some((p) => (
    String(p?.protocol || '').trim().toLowerCase() === protocol
    && String(p?.wallet || '').trim().toLowerCase() === wallet
  ));
  return !currentHasProtocolForWallet;
}

function mergeRecentLoopPositions(currentData, previousData, { previousFetchedAt = 0, maxAgeMs = 30 * 60 * 1000 } = {}) {
  const now = Date.now();
  if (!previousData || !Array.isArray(previousData.positions)) return currentData;
  if (!previousFetchedAt || now - Number(previousFetchedAt) > maxAgeMs) return currentData;
  const positions = Array.isArray(currentData?.positions) ? [...currentData.positions] : [];
  const seen = new Set(positions.map(loopPositionStableKey).filter(Boolean));
  let preserved = 0;
  for (const prev of previousData.positions) {
    const key = loopPositionStableKey(prev);
    if (!key || seen.has(key)) continue;
    if (!shouldPreserveMissingSolanaPosition(prev, positions, currentData?.errors)) continue;
    positions.push({
      ...prev,
      stale: true,
      staleReason: 'Preserved from recent cache because the Solana provider omitted it on the latest poll.',
      staleSince: currentData?.updatedAt || now,
    });
    seen.add(key);
    preserved++;
  }
  if (!preserved) return currentData;
  return {
    ...currentData,
    positions,
    warnings: [
      ...new Set([
        ...(currentData?.warnings || []),
        `${preserved} recent Solana loop position${preserved === 1 ? '' : 's'} preserved after a transient provider miss`,
      ]),
    ],
  };
}

async function fetchMerklActiveOpportunities(wallets) {
  const headers = { Accept: 'application/json' };
  const apiKey = process.env.MERKL_API_KEY;
  if (apiKey) headers['X-API-Key'] = apiKey;

  const settled = await Promise.allSettled(wallets.map(async wallet => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`${MERKL_API}/v4/users/${wallet}/rewards/active-opportunities`, {
        headers,
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Merkl HTTP ${response.status}`);
      const json = await response.json();
      return { wallet, items: Array.isArray(json) ? json : [] };
    } finally {
      clearTimeout(timer);
    }
  }));

  const entries = [];
  const errors = [];
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    if (result.status === 'fulfilled') entries.push(result.value);
    else errors.push({ provider: 'merkl', wallet: wallets[i], message: result.reason?.message || 'Merkl fetch failed' });
  }

  return {
    entries,
    errors,
    index: buildMerklAprIndex(entries),
  };
}

async function fetchFluidOfficial(wallets, chainIds) {
  const chains = chainIds?.length
    ? FLUID_CHAINS.filter(c => chainIds.includes(c.chainId))
    : FLUID_CHAINS;
  const tasks = [];
  for (const wallet of wallets) {
    for (const chain of chains) tasks.push(fetchFluidWalletChain(wallet, chain));
  }
  const settled = await Promise.allSettled(tasks);
  return {
    positions: settled.flatMap(r => r.status === 'fulfilled' ? r.value.positions : []),
    errors: settled.flatMap(r => r.status === 'fulfilled'
      ? r.value.errors
      : [{ provider: 'fluid', message: r.reason?.message || 'Fluid fetch failed' }]),
  };
}

async function fetchLoopRates({ wallets }) {
  const cleanInputs = uniq((wallets || []).map(w => String(w || '').trim()).filter(Boolean));
  const evmWallets = uniq(cleanInputs.filter(isWallet));
  const solanaWallets = uniq(cleanInputs.filter(isSolanaWallet));
  const errors = [];
  if (!evmWallets.length && !solanaWallets.length) {
    return {
      updatedAt: Date.now(),
      wallets: [],
      positions: [],
      errors: [{ provider: 'loops', message: 'No valid yield wallets supplied (EVM 0x… or Solana base58).' }],
      coverage: { aave: AAVE_MARKETS, morpho: MORPHO_CHAINS, fluid: [], kamino: [], jupiterLend: [] },
    };
  }

  const cleanWallets = evmWallets;

  const solana = await fetchSolanaLoopRates(solanaWallets);
  errors.push(...solana.errors);

  let aavePositions = [];
  let morphoPositions = [];
  let fluid = { positions: [], errors: [] };
  let fluidPools = [];
  let defillamaYield = { bySymbolChain: new Map(), byAddress: new Map(), error: null };
  let merkl = { entries: [], index: { byUnderlying: new Map(), byExplorer: new Map() }, errors: [] };

  if (evmWallets.length) {
    const aaveSettled = await Promise.allSettled(evmWallets.map(fetchAaveWallet));
    aavePositions = aaveSettled.flatMap((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      errors.push({ provider: 'aave', wallet: evmWallets[i], message: r.reason?.message || 'Aave fetch failed' });
      return [];
    });

    const morphoSettled = await Promise.allSettled(evmWallets.map(fetchMorphoWallet));
    for (let i = 0; i < morphoSettled.length; i++) {
      const r = morphoSettled[i];
      if (r.status === 'fulfilled') {
        morphoPositions.push(...r.value.positions);
        errors.push(...r.value.errors);
      } else {
        errors.push({ provider: 'morpho', wallet: evmWallets[i], message: r.reason?.message || 'Morpho fetch failed' });
      }
    }

    fluidPools = await fetchDefillamaFluidPools();
    const fluidChainIds = Array.isArray(fluidPools)
      ? uniq(fluidPools.map(p => p.chainId).filter(Boolean))
      : [1, 42161, 8453, 137];
    fluid = await fetchFluidOfficial(evmWallets, fluidChainIds);
    errors.push(...fluid.errors);

    merkl = await fetchMerklActiveOpportunities(evmWallets);
    errors.push(...merkl.errors);
  }

  defillamaYield = await fetchDefillamaYieldApyIndex();
  if (defillamaYield.error) errors.push({ provider: 'defillama', message: defillamaYield.error });

  let positions = [...aavePositions, ...morphoPositions, ...fluid.positions, ...solana.positions]
    .filter(p => p.totalBorrowed > 0.01 || p.vaultOnly)
    .map(pos => enrichPositionWithDefillamaYield(pos, defillamaYield.error ? null : defillamaYield))
    .map(pos => enrichPositionWithMerkl(pos, merkl.index));

  if (evmWallets.length) {
    const merklRewards = await fetchMerklUserRewards(evmWallets, merklRewardChainIds());
    errors.push(...merklRewards.errors);
    const merklUnclaimedByPosition = buildMerklUnclaimedUsdMap(merklRewards.entries, merkl.entries, positions);
    positions = applyMerklRewardsToPositions(positions, merklUnclaimedByPosition)
      .map(pos => ({ ...pos, officialUrl: officialLoopPageUrl(pos) }))
      .sort((a, b) => Math.abs(b.netValue || 0) - Math.abs(a.netValue || 0));
  } else {
    positions = positions
      .map(pos => ({ ...pos, officialUrl: officialLoopPageUrl(pos) }))
      .sort((a, b) => Math.abs(b.netValue || 0) - Math.abs(a.netValue || 0));
  }

  return {
    updatedAt: Date.now(),
    wallets: [...evmWallets, ...solanaWallets],
    positions,
    errors,
    coverage: {
      aave: AAVE_MARKETS,
      morpho: MORPHO_CHAINS,
      fluid: evmWallets.length ? (Array.isArray(fluidPools) ? fluidPools : []) : [],
      fluidRatesError: fluidPools?.error || null,
      fluidPositionSource: 'fluid-official-api',
      kamino: { source: 'api.kamino.finance', markets: 'v2/kamino-market' },
      jupiterLend: {
        source: 'api.jup.ag/lend/v1',
        borrowPositions: '/borrow/positions',
        portfolioFallback: 'api.jup.ag/portfolio/v1/positions/{wallet}',
      },
      defillamaYieldSource: defillamaYield.error ? 'unavailable' : 'yields.llama.fi',
      merklRewardSource: 'merkl-user-rewards-unclaimed',
      merklCampaigns: merkl.entries.reduce((n, e) => n + (e.items?.length || 0), 0),
    },
  };
}

module.exports = {
  fetchLoopRates,
  AAVE_MARKETS,
  MORPHO_CHAINS,
  mergeRecentLoopPositions,
  merklUnclaimedUsdFromBreakdown,
  merklUnclaimedUsdFromReward,
  merklClaimedUsdFromReward,
  buildMerklUnclaimedUsdMap,
  enrichPositionWithDefillamaYield,
  fetchDefillamaYieldApyIndex,
};

const AAVE_GQL = 'https://api.v3.aave.com/graphql';
const MORPHO_GQL = 'https://api.morpho.org/graphql';
const DEFINITIV_GQL = 'https://api.definitiv.io/graphql';
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
  ethereum: 1,
  arbitrum: 42161,
  base: 8453,
  polygon: 137,
  plasma: 9745,
  optimism: 10,
  sonic: 146,
};

function isWallet(value) {
  return typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value.trim());
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

function mapDefinitivFluidPosition(item) {
  const positions = [];
  for (const p of item?.lendingPositions || []) {
    const usd = num(p.balanceUsd);
    if (usd <= 0.01) continue;
    const apy = percent(p.apy);
    positions.push({
      id: `fluid-lending:${item.walletAddress}:${item.chainId}:${p.fTokenSymbol || p.underlyingAsset?.symbol}`,
      protocol: 'Fluid',
      source: 'definitiv-api',
      confidence: 'high',
      wallet: item.walletAddress,
      chainId: item.chainId,
      chainName: item.chainName || `Chain ${item.chainId}`,
      marketName: p.fTokenSymbol || `Fluid ${p.underlyingAsset?.symbol || 'Lending'}`,
      supplied: [{ symbol: p.underlyingAsset?.symbol || p.fTokenSymbol || 'Asset', value: usd, apy }],
      borrowed: [],
      totalSupplied: usd,
      totalBorrowed: 0,
      netValue: usd,
      supplyApy: apy,
      borrowApy: null,
      netApy: apy,
      health: null,
      vaultOnly: true,
    });
  }
  for (const p of item?.vaultPositions || []) {
    const supplyUsd = num(p.supply?.assetsUsd ?? p.supplyUsd ?? p.collateralUsd);
    const borrowUsd = num(p.borrow?.assetsUsd ?? p.borrowUsd ?? p.debtUsd);
    if (borrowUsd <= 0.01 && supplyUsd <= 0.01) continue;
    const supplyApy = percent(p.supply?.apy ?? p.supplyApy ?? 0);
    const borrowApy = percent(p.borrow?.apy ?? p.borrowApy ?? 0);
    positions.push({
      id: `fluid-vault:${item.walletAddress}:${item.chainId}:${p.nftId || p.vaultAddress || positions.length}`,
      protocol: 'Fluid',
      source: 'definitiv-api',
      confidence: 'high',
      wallet: item.walletAddress,
      chainId: item.chainId,
      chainName: item.chainName || `Chain ${item.chainId}`,
      marketName: p.name || p.vaultName || `Fluid Vault ${p.nftId || ''}`.trim(),
      supplied: [{ symbol: p.supply?.asset?.symbol || p.collateralAsset?.symbol || 'Collateral', value: supplyUsd, apy: supplyApy }],
      borrowed: borrowUsd > 0.01 ? [{ symbol: p.borrow?.asset?.symbol || p.debtAsset?.symbol || 'Debt', value: borrowUsd, apy: borrowApy }] : [],
      totalSupplied: supplyUsd,
      totalBorrowed: borrowUsd,
      netValue: supplyUsd - borrowUsd,
      supplyApy,
      borrowApy: borrowUsd ? borrowApy : null,
      netApy: netApy({ totalSupplied: supplyUsd, totalBorrowed: borrowUsd, suppliedYieldUsd: supplyUsd * supplyApy, borrowedCostUsd: borrowUsd * borrowApy }),
      health: p.healthFactor == null ? null : num(p.healthFactor, null),
    });
  }
  return positions;
}

async function fetchDefinitivFluid(wallets, chains) {
  const apiKey = process.env.DEFINITIV_API_KEY;
  if (!apiKey) return { positions: [], errors: [{ provider: 'fluid', message: 'DEFINITIV_API_KEY is not configured; Fluid wallet positions are unavailable.' }] };
  const inputs = [];
  for (const wallet of wallets) {
    for (const chainId of chains) inputs.push({ protocol: 'fluid', chainId, walletAddress: wallet });
  }
  const query = `query FluidWalletPositions($inputs:[PositionInput!]!) {
    walletPositions(inputs:$inputs) {
      data {
        ... on FluidWalletPositions {
          protocol
          walletAddress
          chainId
          lendingPositions {
            fTokenSymbol
            underlyingAsset { symbol }
            balanceUsd
            apy
          }
          vaultPositions {
            nftId
            vaultAddress
            name
            vaultName
            healthFactor
            collateralAsset { symbol }
            debtAsset { symbol }
            supply { assetsUsd apy asset { symbol } }
            borrow { assetsUsd apy asset { symbol } }
          }
        }
      }
      errors { protocol chainId walletAddress error { code message retryable } }
    }
  }`;
  const chunks = [];
  for (let i = 0; i < inputs.length; i += 5) chunks.push(inputs.slice(i, i + 5));
  const settled = await Promise.allSettled(chunks.map(chunk => gql(DEFINITIV_GQL, query, { inputs: chunk }, {
    headers: { 'x-api-key': apiKey },
    timeout: 20000,
  })));
  return {
    positions: settled.flatMap(r => r.status === 'fulfilled'
      ? (r.value?.walletPositions?.data || []).flatMap(mapDefinitivFluidPosition)
      : []),
    errors: settled.flatMap(r => r.status === 'fulfilled'
      ? (r.value?.walletPositions?.errors || []).map(e => ({ provider: 'fluid', chainId: e.chainId, wallet: e.walletAddress, message: e.error?.message || 'Fluid fetch failed' }))
      : [{ provider: 'fluid', message: r.reason?.message || 'Fluid fetch failed' }]),
  };
}

async function fetchLoopRates({ wallets }) {
  const cleanWallets = uniq((wallets || []).map(w => String(w || '').trim()).filter(isWallet));
  const errors = [];
  if (!cleanWallets.length) {
    return {
      updatedAt: Date.now(),
      wallets: [],
      positions: [],
      errors: [{ provider: 'loops', message: 'No valid EVM yield wallets supplied.' }],
      coverage: { aave: AAVE_MARKETS, morpho: MORPHO_CHAINS, fluid: [] },
    };
  }

  const aaveSettled = await Promise.allSettled(cleanWallets.map(fetchAaveWallet));
  const aavePositions = aaveSettled.flatMap((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    errors.push({ provider: 'aave', wallet: cleanWallets[i], message: r.reason?.message || 'Aave fetch failed' });
    return [];
  });

  const morphoSettled = await Promise.allSettled(cleanWallets.map(fetchMorphoWallet));
  const morphoPositions = [];
  for (let i = 0; i < morphoSettled.length; i++) {
    const r = morphoSettled[i];
    if (r.status === 'fulfilled') {
      morphoPositions.push(...r.value.positions);
      errors.push(...r.value.errors);
    } else {
      errors.push({ provider: 'morpho', wallet: cleanWallets[i], message: r.reason?.message || 'Morpho fetch failed' });
    }
  }

  const fluidPools = await fetchDefillamaFluidPools();
  const fluidChainIds = Array.isArray(fluidPools)
    ? uniq(fluidPools.map(p => p.chainId).filter(Boolean))
    : [1, 42161, 8453, 137];
  const fluid = await fetchDefinitivFluid(cleanWallets, fluidChainIds);
  errors.push(...fluid.errors);

  return {
    updatedAt: Date.now(),
    wallets: cleanWallets,
    positions: [...aavePositions, ...morphoPositions, ...fluid.positions]
      .filter(p => p.totalBorrowed > 0.01 || p.vaultOnly)
      .sort((a, b) => Math.abs(b.netValue || 0) - Math.abs(a.netValue || 0)),
    errors,
    coverage: {
      aave: AAVE_MARKETS,
      morpho: MORPHO_CHAINS,
      fluid: Array.isArray(fluidPools) ? fluidPools : [],
      fluidRatesError: fluidPools?.error || null,
      fluidPositionSource: process.env.DEFINITIV_API_KEY ? 'definitiv-api' : 'not-configured',
    },
  };
}

module.exports = {
  fetchLoopRates,
  AAVE_MARKETS,
  MORPHO_CHAINS,
};

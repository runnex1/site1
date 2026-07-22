'use strict';

const AAVE_MARKET_QUERY = {
  AaveV3Ethereum: 'proto_mainnet_v3',
  AaveV3EthereumEtherFi: 'proto_mainnet_v3',
  AaveV3EthereumLido: 'proto_mainnet_v3',
  AaveV3EthereumHorizon: 'proto_mainnet_v3',
  AaveV3Optimism: 'proto_optimism_v3',
  AaveV3BNB: 'proto_bnb_v3',
  AaveV3Gnosis: 'proto_gnosis_v3',
  AaveV3Polygon: 'proto_polygon_v3',
  AaveV3Monad: 'proto_monad_v3',
  AaveV3Sonic: 'proto_sonic_v3',
  AaveV3XLayer: 'proto_xlayer_v3',
  AaveV3ZkSync: 'proto_zksync_v3',
  AaveV3Metis: 'proto_metis_v3',
  AaveV3Soneium: 'proto_soneium_v3',
  AaveV3MegaETH: 'proto_megaeth_v3',
  AaveV3Mantle: 'proto_mantle_v3',
  AaveV3Base: 'proto_base_v3',
  AaveV3Arbitrum: 'proto_arbitrum_v3',
  AaveV3Celo: 'proto_celo_v3',
  AaveV3Avalanche: 'proto_avalanche_v3',
  AaveV3Ink: 'proto_ink_v3',
  AaveV3Linea: 'proto_linea_v3',
  AaveV3Plasma: 'proto_plasma_v3',
  AaveV3Scroll: 'proto_scroll_v3',
};

const MORPHO_CHAIN_SLUG = {
  1: 'ethereum',
  10: 'optimism',
  130: 'unichain',
  137: 'polygon',
  143: 'monad',
  480: 'world-chain',
  8453: 'base',
  42161: 'arbitrum',
  4217: 'tempo',
  747474: 'katana',
  988: 'stable',
  999: 'hyperevm',
};

const PROTOCOL_HOME = {
  aave: 'https://app.aave.com',
  morpho: 'https://app.morpho.org',
  fluid: 'https://fluid.io',
  jupiter: 'https://jup.ag/lend',
  kamino: 'https://app.kamino.finance',
  spark: 'https://app.spark.fi/savings',
  sparklend: 'https://app.spark.fi/borrow',
};


function aaveOfficialUrl(position) {
  const marketName = String(position?.marketName || '').trim();
  const marketParam = AAVE_MARKET_QUERY[marketName];
  if (marketParam) {
    return `https://app.aave.com/markets/?marketName=${encodeURIComponent(marketParam)}`;
  }
  return PROTOCOL_HOME.aave;
}

function morphoOfficialUrl(position) {
  const chainId = Number(position?.chainId);
  const slug = MORPHO_CHAIN_SLUG[chainId];
  const marketId = String(position?.marketId || '').trim();
  if (slug && marketId) {
    const path = position?.vaultOnly ? 'vault' : 'market';
    return `https://app.morpho.org/${slug}/${path}/${encodeURIComponent(marketId)}`;
  }
  if (slug) return `https://app.morpho.org/${slug}`;
  return PROTOCOL_HOME.morpho;
}

function fluidOfficialUrl(position) {
  const chainId = Number(position?.chainId);
  if (!Number.isFinite(chainId)) return PROTOCOL_HOME.fluid;
  const borrowed = Number(position?.totalBorrowed || 0);
  if (borrowed > 0.01) return `https://fluid.io/borrow/${chainId}`;
  return `https://fluid.io/lending/${chainId}`;
}

function protocolHomeUrl(protocol) {
  const key = String(protocol || '').trim().toLowerCase();
  return PROTOCOL_HOME[key] || '';
}

function officialLoopPageUrl(position) {
  const protocol = String(position?.protocol || '').trim().toLowerCase();
  if (protocol === 'aave') return aaveOfficialUrl(position);
  if (protocol === 'morpho') return morphoOfficialUrl(position);
  if (protocol === 'fluid') return fluidOfficialUrl(position);
  if (protocol === 'jupiter') return PROTOCOL_HOME.jupiter;
  if (protocol === 'kamino') return PROTOCOL_HOME.kamino;
  if (protocol === 'spark' || protocol === 'sky') return PROTOCOL_HOME.spark;
  if (protocol === 'sparklend') return PROTOCOL_HOME.sparklend;
  return protocolHomeUrl(position?.protocol || protocol);
}

module.exports = {
  AAVE_MARKET_QUERY,
  MORPHO_CHAIN_SLUG,
  PROTOCOL_HOME,
  officialLoopPageUrl,
  protocolHomeUrl,
};

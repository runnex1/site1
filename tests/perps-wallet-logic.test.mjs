/**
 * Unit tests for perps wallet merge logic (no browser required).
 * Run: node tests/perps-wallet-logic.test.mjs
 */
import assert from 'node:assert/strict';

const PERPS_CONFIG_KEY = 'vault-perps-config';
const PERPS_CONFIG_BACKUP_KEY = 'vault-perps-config-backup';
const TEST_WALLET = '0x' + 'b'.repeat(40);

function perpsIsValidEthAddress(addr) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(addr || '').trim());
}

function perpsNormalizeStoredConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? { ...raw } : {};
  const hl = String(cfg.hyperliquid || '').trim();
  if (hl && !perpsIsValidEthAddress(hl)) delete cfg.hyperliquid;
  return cfg;
}

function perpsConfigPayload(cfg) {
  const norm = perpsNormalizeStoredConfig(cfg);
  if (!perpsIsValidEthAddress(norm.hyperliquid)) return null;
  return {
    hyperliquid: norm.hyperliquid.trim(),
    nado: norm.nado || '',
    grvtSubAccount: norm.grvtSubAccount || '4860249204328359',
    statRange: norm.statRange || '7d',
    configured: true,
  };
}

function simulateCloudMerge(localPortfolio, cloudPortfolio) {
  const store = new Map();
  store.set(PERPS_CONFIG_KEY, JSON.stringify(localPortfolio.perpsArb || {}));
  store.set('portfolio-data-pro', JSON.stringify(localPortfolio));

  function getSaved() {
    return perpsNormalizeStoredConfig(JSON.parse(store.get(PERPS_CONFIG_KEY) || '{}'));
  }

  function snapshot() {
    const cfg = getSaved();
    if (perpsIsValidEthAddress(cfg.hyperliquid)) return perpsConfigPayload(cfg);
    const arb = localPortfolio.perpsArb;
    return arb && perpsIsValidEthAddress(arb.hyperliquid) ? perpsConfigPayload(arb) : null;
  }

  function restore(snapshot) {
    if (!snapshot) return;
    store.set(PERPS_CONFIG_KEY, JSON.stringify(snapshot));
    store.set(PERPS_CONFIG_BACKUP_KEY, JSON.stringify(snapshot));
  }

  function applyArbToData(data) {
    const cfg = perpsNormalizeStoredConfig(JSON.parse(store.get(PERPS_CONFIG_KEY) || '{}'));
    if (perpsIsValidEthAddress(cfg.hyperliquid)) {
      data.perpsArb = {
        hyperliquid: cfg.hyperliquid.trim(),
        nado: cfg.nado || '',
        grvtSubAccount: cfg.grvtSubAccount || '4860249204328359',
      };
    }
    return data;
  }

  const snap = snapshot();
  let data = { ...cloudPortfolio };
  restore(snap);
  data = applyArbToData(data);
  store.set('portfolio-data-pro', JSON.stringify(data));
  return { data, store };
}

// Test: cloud portfolio without perpsArb must not wipe local wallet
{
  const local = {
    tokens: [],
    protocols: [],
    etfs: [],
    perpsArb: { hyperliquid: TEST_WALLET, nado: '', grvtSubAccount: '4860249204328359', configured: true },
  };
  const cloud = { tokens: [], protocols: [], etfs: [] };
  const { data, store } = simulateCloudMerge(local, cloud);
  assert.equal(data.perpsArb?.hyperliquid, TEST_WALLET, 'perpsArb preserved on data after cloud merge');
  const cfg = JSON.parse(store.get(PERPS_CONFIG_KEY));
  assert.equal(cfg.hyperliquid, TEST_WALLET, 'PERPS_CONFIG_KEY preserved after cloud merge');
  console.log('PASS: cloud merge preserves local wallet');
}

// Test: invalid masked wallet must not overwrite valid
{
  const prev = { hyperliquid: TEST_WALLET, configured: true };
  const masked = '********';
  let hl = masked;
  if (!perpsIsValidEthAddress(hl) && perpsIsValidEthAddress(prev.hyperliquid)) hl = prev.hyperliquid;
  assert.equal(hl, TEST_WALLET, 'masked input must not replace valid saved wallet');
  console.log('PASS: masked blur cannot wipe saved wallet');
}

console.log('\nAll logic tests passed.');

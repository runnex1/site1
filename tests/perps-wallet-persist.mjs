/**
 * Verifies perps wallet survives page reload without Save & connect.
 * Run: node tests/perps-wallet-persist.mjs
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const TEST_WALLET = '0x' + 'a'.repeat(40);
const PORT = 4177;
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function mockPerpsPayload() {
  return {
    paired: [],
    unhedged: [],
    summary: { hlAccountValue: 1000, nadoAccountValue: 0, grvtAccountValue: 0, extendedAccountValue: 0 },
    dailyFundingSeries: [],
    fetchedAt: Date.now(),
  };
}

function startServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);

      if (url.pathname === '/api/sync' && req.method === 'GET') {
        if (url.searchParams.get('perpsConfig') === '1') {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({
            ok: true,
            perpsConfig: {
              hyperliquid: TEST_WALLET,
              nado: '',
              grvtSubAccount: '4860249204328359',
              configured: true,
            },
          }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({
          ok: true,
          result: JSON.stringify({
            tokens: [],
            protocols: [],
            etfs: [],
            predictionMarkets: [],
            opinionMarkets: [],
            polymarketWallets: [],
            defiPanelNotes: [],
            etfRealizedPnl: 0,
            _perpsConfig: {
              hyperliquid: TEST_WALLET,
              nado: '',
              grvtSubAccount: '4860249204328359',
              configured: true,
            },
          }),
        }));
        return;
      }

      if (url.pathname === '/api/sync' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ ok: true, saved: { perpsConfig: true } }));
        return;
      }

      if (url.pathname === '/api/perps') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(mockPerpsPayload()));
        return;
      }

      let filePath = join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
      if (!existsSync(filePath) || filePath.includes('..')) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const ext = extname(filePath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(readFileSync(filePath));
    });
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

async function waitFor(fn, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

async function run() {
  const server = await startServer();
  const browser = await chromium.launch({ headless: true });
  const base = `http://127.0.0.1:${PORT}`;

  try {
    // Test 1: localStorage wallet survives reload
    {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
      await page.evaluate((wallet) => {
        const cfg = { hyperliquid: wallet, nado: '', grvtSubAccount: '4860249204328359', configured: true };
        localStorage.setItem('vault-perps-config', JSON.stringify(cfg));
        localStorage.setItem('vault-perps-config-backup', JSON.stringify(cfg));
        sessionStorage.setItem('vault-perps-wallets-session', JSON.stringify(cfg));
        localStorage.setItem('portfolio-data-pro', JSON.stringify({
          tokens: [], protocols: [], etfs: [], predictionMarkets: [], opinionMarkets: [],
          polymarketWallets: [], defiPanelNotes: [], etfRealizedPnl: 0,
          perpsArb: cfg,
        }));
        localStorage.setItem('vault-active-tab', 'perps');
      }, TEST_WALLET);

      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForTimeout(3000);

      const state = await page.evaluate(() => ({
        valid: typeof perpsHasValidWallet === 'function' && perpsHasValidWallet(),
        status: document.getElementById('perpsStatus')?.textContent || '',
        collapsed: document.getElementById('perpsConfigFoot')?.classList.contains('collapsed'),
        hl: typeof perpsResolveHlWallet === 'function' ? perpsResolveHlWallet() : '',
      }));

      if (!state.valid) throw new Error(`Test 1 failed: wallet not valid after reload. hl=${state.hl}`);
      if (!state.collapsed) throw new Error('Test 1 failed: config panel not collapsed');
      if (state.status.includes('Add wallets')) throw new Error(`Test 1 failed: status still prompts save: ${state.status}`);
      console.log('PASS test 1: localStorage wallet survives reload');
      await ctx.close();
    }

    // Test 2: empty local, cloud restore on bootstrap
    {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
        localStorage.setItem('vault-active-tab', 'perps');
      });
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForTimeout(4000);

      const ok = await waitFor(async () => page.evaluate(() =>
        typeof perpsHasValidWallet === 'function' && perpsHasValidWallet()
      ));
      if (!ok) throw new Error('Test 2 failed: cloud wallet not restored on fresh load');

      const status = await page.textContent('#perpsStatus');
      if (status?.includes('Add wallets')) throw new Error(`Test 2 failed: status prompts save: ${status}`);
      console.log('PASS test 2: cloud wallet restored without Save & connect');
      await ctx.close();
    }

    // Test 3: cloud merge must not wipe local wallet from portfolio
    {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
      await page.evaluate((wallet) => {
        const cfg = { hyperliquid: wallet, nado: '', grvtSubAccount: '4860249204328359', configured: true };
        localStorage.setItem('vault-perps-config', JSON.stringify(cfg));
        localStorage.setItem('portfolio-data-pro', JSON.stringify({
          tokens: [], protocols: [], etfs: [], perpsArb: cfg,
        }));
        localStorage.setItem('vault-active-tab', 'perps');
      }, TEST_WALLET);
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForTimeout(5000);

      const portfolio = await page.evaluate(() => {
        try { return JSON.parse(localStorage.getItem('portfolio-data-pro') || '{}'); } catch { return {}; }
      });
      if (!portfolio.perpsArb?.hyperliquid) throw new Error('Test 3 failed: cloud merge wiped perpsArb from portfolio');
      console.log('PASS test 3: cloud merge preserves local wallet in portfolio');
      await ctx.close();
    }

    console.log('\nAll perps wallet persistence tests passed.');
  } finally {
    await browser.close();
    server.close();
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});

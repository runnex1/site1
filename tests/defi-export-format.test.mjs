/**

 * Verifies DeFi Excel export matches preview layout (ui-previews/defi-positions-excel-preview.html).

 * Run: node tests/defi-export-format.test.mjs

 */

import assert from 'node:assert/strict';

import { readFileSync, unlinkSync } from 'node:fs';

import { createRequire } from 'node:module';

import { fileURLToPath } from 'node:url';

import { dirname, join } from 'node:path';

import { tmpdir } from 'node:os';



const require = createRequire(import.meta.url);

const XLSX = require('xlsx-js-style');

const {

  EXPORT_POS_HEADERS,

  EXPORT_TITLE_ROW_COUNT,

  STYLE,

  defiExportFmtUsd,

  defiExportFmtPct,

  defiExportFmtBorrowPct,

  defiExportPositionLabel,

  buildDefiPositionsSheetAoA,

  buildDefiSummarySheetAoA,

  buildDefiPositionsWorksheet,

  buildDefiSummaryWorksheet,

} = require('../lib/defi-export.js');



const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const indexHtml = readFileSync(join(ROOT, 'index.html'), 'utf8');

const previewHtml = readFileSync(join(ROOT, 'ui-previews', 'defi-positions-excel-preview.html'), 'utf8');



assert.deepEqual(EXPORT_POS_HEADERS, [

  '#', 'Protocol', 'Type', 'Position', 'Leg', 'Asset',

  'Qty', 'Unit Price', 'USD Value', 'Supply APY', 'Borrow APY', 'Net APY',

  'Health', 'Chain', 'Notes',

], 'headers must match preview (no % suffix)');



assert.equal(defiExportFmtUsd(6487.47), '$6,487.47');

assert.equal(defiExportFmtUsd(-385123.04), '-$385,123.04');

assert.equal(defiExportFmtPct(11.3), '+11.3%');

assert.equal(defiExportFmtBorrowPct(6.2), '-6.2%');

assert.equal(defiExportPositionLabel('USDC/USDT loop'), 'USDC / USDT loop');



const previewGroups = [

  {

    label: 'Fluid · reUSD supply',

    rows: [{

      protocol: 'Fluid', type: 'Lending', position: 'reUSD', leg: 'Supplied', asset: 'reUSD',

      qty: 5984.75, unitPrice: 1.084, usdValue: 6487.47, supplyApy: 11.3, borrowApy: '', netApy: 11.3,

      health: '', chain: 'Ethereum', notes: '',

    }],

  },

  {

    label: 'Aave V3 · USDC / USDT loop',

    rows: [

      {

        protocol: 'Aave V3', type: 'Lending', position: 'USDC / USDT loop', leg: 'Supplied', asset: 'USDC',

        qty: 412500, unitPrice: 1.0001, usdValue: 412541.25, supplyApy: 4.8, borrowApy: '', netApy: 2.1,

        health: '1.42', chain: 'Ethereum', notes: 'e-mode',

      },

      {

        protocol: 'Aave V3', type: 'Lending', position: 'USDC / USDT loop', leg: 'Borrowed', asset: 'USDT',

        qty: 385200, unitPrice: 0.9998, usdValue: -385123.04, supplyApy: '', borrowApy: 6.2, netApy: 2.1,

        health: '1.42', chain: 'Ethereum', notes: '',

      },

    ],

  },

];



const layout = buildDefiPositionsSheetAoA(previewGroups, {

  exportDate: '2026-06-10 14:32 UTC',

  protocolCount: 7,

});

const { aoa, merges, totalUsd, legCount, headerRow } = layout;

assert.equal(legCount, 3);

assert.equal(headerRow, EXPORT_TITLE_ROW_COUNT);

assert.equal(totalUsd, 6487.47 + 412541.25 - 385123.04);

assert.equal(aoa[0][0], 'DeFi Positions');

assert.equal(aoa[1][0], 'Exported 2026-06-10 14:32 UTC · 7 protocols · 3 legs');

assert.equal(aoa[headerRow][8], 'USD Value');

assert.equal(aoa[headerRow + 1][1], 'Fluid · reUSD supply');

assert.equal(aoa[headerRow + 2][0], 1);

assert.equal(aoa[headerRow + 2][8], '$6,487.47');

assert.equal(aoa[headerRow + 2][9], '+11.3%');

assert.equal(aoa[headerRow + 4][8], '$412,541.25');

assert.equal(aoa[headerRow + 5][8], '-$385,123.04');

assert.equal(aoa[headerRow + 5][10], '-6.2%');

assert.ok(merges.some(m => m.s.r === headerRow + 1 && m.s.c === 1), 'group row must merge label cells');

const totalRow = aoa[aoa.length - 1];

assert.equal(totalRow[1], 'TOTAL (net)');

assert.equal(totalRow[8], defiExportFmtUsd(totalUsd));



const summaryLayout = buildDefiSummarySheetAoA({

  exportDate: '2026-06-10 14:32 UTC',

  protocols: 7,

  activeLoops: 2,

  totalSupplied: 623718.48,

  totalBorrowed: 561140.64,

  netLendingValue: 62577.84,

  weightedNetApy: 4.6,

  lowestHealth: '1.18',

  stablecoinNetExposure: 251042.51,

});

assert.equal(summaryLayout.aoa[0][0], 'Portfolio Summary');

assert.equal(summaryLayout.aoa[summaryLayout.headerRow][0], 'Metric');

assert.equal(summaryLayout.aoa[summaryLayout.headerRow + 1][0], 'Export date');

assert.equal(summaryLayout.aoa[summaryLayout.headerRow + 1][1], '2026-06-10 14:32 UTC');

assert.equal(summaryLayout.aoa[summaryLayout.headerRow + 7][0], 'Weighted net APY');

assert.equal(summaryLayout.aoa[summaryLayout.headerRow + 7][1], '+4.6%');

assert.equal(summaryLayout.aoa.length, 13, 'summary must have title block + 9 metrics + header');



const tmpPath = join(tmpdir(), `defi-export-verify-${Date.now()}.xlsx`);

const wb = XLSX.utils.book_new();

const wsPos = buildDefiPositionsWorksheet(XLSX, previewGroups, {

  exportDate: '2026-06-10 14:32 UTC',

  protocolCount: 7,

});

const wsSum = buildDefiSummaryWorksheet(XLSX, {

  exportDate: '2026-06-10 14:32 UTC',

  protocols: 7,

  activeLoops: 2,

  totalSupplied: 623718.48,

  totalBorrowed: 561140.64,

  netLendingValue: 62577.84,

  weightedNetApy: 4.6,

  lowestHealth: '1.18',

  stablecoinNetExposure: 251042.51,

});

const headerRef = XLSX.utils.encode_cell({ r: headerRow, c: 0 });
assert.ok(String(wsPos[headerRef]?.s?.fill?.fgColor?.rgb || '').includes(STYLE.excelGreen), 'header row must use Excel green fill');
assert.ok(wsPos['!autofilter'], 'positions sheet must have autofilter');
assert.ok(wsPos['!sheetViews'], 'positions sheet must freeze header pane');

XLSX.utils.book_append_sheet(wb, wsPos, 'Positions');

XLSX.utils.book_append_sheet(wb, wsSum, 'Summary');

XLSX.writeFile(wb, tmpPath, { cellStyles: true });



const readBack = XLSX.readFile(tmpPath, { cellStyles: true });

assert.ok(readBack.Sheets.Positions, 'workbook must have Positions sheet');

assert.ok(readBack.Sheets.Summary, 'workbook must have Summary sheet');

const posRows = XLSX.utils.sheet_to_json(readBack.Sheets.Positions, { header: 1, defval: '' });

assert.equal(posRows[headerRow][9], 'Supply APY');

assert.equal(posRows[headerRow + 1][1], 'Fluid · reUSD supply');

assert.equal(posRows[headerRow + 2][4], 'Supplied');

assert.equal(posRows[posRows.length - 1][8], defiExportFmtUsd(totalUsd));

unlinkSync(tmpPath);



assert.ok(indexHtml.includes('xlsx-js-style'), 'index must load styled xlsx library');

assert.ok(indexHtml.includes('buildDefiPositionsWorksheet'), 'index must use styled worksheet builder');

assert.ok(indexHtml.includes('lib/defi-export.js'), 'index must load defi-export formatter');

assert.ok(previewHtml.includes('Supply APY'), 'preview reference still valid');



console.log('PASS: defi export format matches preview');


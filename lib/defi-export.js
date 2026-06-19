/**
 * DeFi positions Excel export — workbook layout + display formatting.
 * Matches ui-previews/defi-positions-excel-preview.html structure.
 */

const EXPORT_POS_HEADERS = [
  '#', 'Protocol', 'Type', 'Position', 'Leg', 'Asset',
  'Qty', 'Unit Price', 'USD Value', 'Supply APY', 'Borrow APY', 'Net APY',
  'Health', 'Chain', 'Notes',
];

const EXPORT_POS_COL_WIDTHS = [
  { wch: 4 }, { wch: 14 }, { wch: 12 }, { wch: 24 }, { wch: 10 }, { wch: 12 },
  { wch: 14 }, { wch: 12 }, { wch: 14 }, { wch: 11 }, { wch: 11 }, { wch: 11 },
  { wch: 8 }, { wch: 14 }, { wch: 24 },
];

function defiExportFmtDash(v) {
  if (v === '' || v === null || v === undefined) return '—';
  return v;
}

function defiExportFmtUsd(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function defiExportFmtUnitPrice(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '—';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`;
}

function defiExportFmtQty(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function defiExportFmtPct(apr) {
  const n = Number(apr);
  if (!Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}%`;
}

function defiExportFmtBorrowPct(apr) {
  const n = Number(apr);
  if (!Number.isFinite(n)) return '—';
  const signed = n > 0 ? -n : n;
  if (signed === 0) return '0.0%';
  const sign = signed > 0 ? '+' : '';
  return `${sign}${signed.toFixed(1)}%`;
}

function defiExportFmtHealth(h) {
  if (h === '' || h === null || h === undefined) return '—';
  return String(h);
}

function defiExportPositionLabel(label) {
  return String(label || '')
    .replace(/([A-Za-z0-9]+)\/([A-Za-z0-9]+)(\s+loop)?/g, '$1 / $2$3');
}

function defiExportExportDate(d = new Date()) {
  const iso = d.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function defiExportLegRowToDisplay(r) {
  return [
    r.rowNum,
    r.protocol,
    r.type,
    defiExportPositionLabel(r.position),
    r.leg,
    r.asset,
    defiExportFmtQty(r.qty),
    defiExportFmtUnitPrice(r.unitPrice),
    defiExportFmtUsd(r.usdValue),
    defiExportFmtPct(r.supplyApy),
    r.borrowApy !== '' && r.borrowApy != null ? defiExportFmtBorrowPct(r.borrowApy) : '—',
    defiExportFmtPct(r.netApy),
    defiExportFmtHealth(r.health),
    r.chain || '',
    r.notes || '',
  ];
}

/**
 * @param {Array<{ label: string, rows: object[] }>} groups
 */
function buildDefiPositionsSheetAoA(groups) {
  const aoa = [EXPORT_POS_HEADERS];
  const merges = [];
  let legNum = 0;
  let totalUsd = 0;

  for (const group of groups || []) {
    const groupRowIdx = aoa.length;
    aoa.push(['', group.label, ...Array(EXPORT_POS_HEADERS.length - 2).fill('')]);
    merges.push({
      s: { r: groupRowIdx, c: 1 },
      e: { r: groupRowIdx, c: EXPORT_POS_HEADERS.length - 1 },
    });

    for (const r of group.rows || []) {
      legNum += 1;
      totalUsd += Number(r.usdValue) || 0;
      aoa.push(defiExportLegRowToDisplay({ ...r, rowNum: legNum }));
    }
  }

  const totalRowIdx = aoa.length;
  aoa.push([
    '', 'TOTAL (net)', '', '', '', '', '', '',
    defiExportFmtUsd(totalUsd),
    '', '', '', '', '', '',
  ]);
  merges.push({ s: { r: totalRowIdx, c: 1 }, e: { r: totalRowIdx, c: 7 } });

  return { aoa, merges, totalUsd, legCount: legNum };
}

function buildDefiSummarySheetAoA(summary) {
  return [
    ['Metric', 'Value'],
    ['Export date', summary.exportDate || defiExportExportDate()],
    ['Protocols', summary.protocols ?? 0],
    ['Active loops', summary.activeLoops ?? 0],
    ['Total supplied', defiExportFmtUsd(summary.totalSupplied)],
    ['Total borrowed', defiExportFmtUsd(summary.totalBorrowed)],
    ['Net lending value', defiExportFmtUsd(summary.netLendingValue)],
    ['Weighted net APY', defiExportFmtPct(summary.weightedNetApy)],
    ['Lowest health factor', defiExportFmtHealth(summary.lowestHealth)],
    ['Stablecoin net exposure', defiExportFmtUsd(summary.stablecoinNetExposure)],
  ];
}

const defiExportBundle = {
  EXPORT_POS_HEADERS,
  EXPORT_POS_COL_WIDTHS,
  defiExportFmtUsd,
  defiExportFmtUnitPrice,
  defiExportFmtQty,
  defiExportFmtPct,
  defiExportFmtBorrowPct,
  defiExportFmtHealth,
  defiExportPositionLabel,
  defiExportExportDate,
  buildDefiPositionsSheetAoA,
  buildDefiSummarySheetAoA,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = defiExportBundle;
}
if (typeof window !== 'undefined') {
  window.DefiExport = defiExportBundle;
}

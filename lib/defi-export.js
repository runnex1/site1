/**
 * DeFi positions Excel export — workbook layout, display formatting, and cell styles.
 * Matches ui-previews/defi-positions-excel-preview.html (green header, group rows, totals).
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

const EXPORT_POS_COL_COUNT = EXPORT_POS_HEADERS.length;
const EXPORT_TITLE_ROW_COUNT = 3;

const STYLE = {
  excelGreen: '217346',
  excelGreenText: 'FFFFFF',
  groupBg: 'E8F5EE',
  groupText: '1B5E3A',
  totalBg: 'F2F2F2',
  zebraBg: 'FAFAFA',
  grid: 'D4D4D4',
  pos: '107C41',
  neg: 'C00000',
  muted: '666666',
  titleText: '1B5E3A',
  subtitleText: '666666',
};

const NUM_COLS = new Set([6, 7, 8, 9, 10, 11, 12]);
const APY_COLS = new Set([9, 10, 11]);

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

function defiExportOffsetMerges(merges, offset) {
  return (merges || []).map(m => ({
    s: { r: m.s.r + offset, c: m.s.c },
    e: { r: m.e.r + offset, c: m.e.c },
  }));
}

function defiExportTitleBlock(meta = {}) {
  const exportDate = meta.exportDate || defiExportExportDate();
  const protocols = meta.protocolCount ?? '—';
  const legs = meta.legCount ?? '—';
  const fill = () => Array(EXPORT_POS_COL_COUNT - 1).fill('');
  return [
    ['DeFi Positions', ...fill()],
    [`Exported ${exportDate} · ${protocols} protocols · ${legs} legs`, ...fill()],
    Array(EXPORT_POS_COL_COUNT).fill(''),
  ];
}

function defiExportTitleMerges() {
  const lastCol = EXPORT_POS_COL_COUNT - 1;
  return [
    { s: { r: 0, c: 0 }, e: { r: 0, c: lastCol } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: lastCol } },
  ];
}

/**
 * @param {Array<{ label: string, rows: object[] }>} groups
 * @param {{ exportDate?: string, protocolCount?: number }} meta
 */
function buildDefiPositionsSheetAoA(groups, meta = {}) {
  const body = [EXPORT_POS_HEADERS];
  const bodyMerges = [];
  let legNum = 0;
  let totalUsd = 0;

  for (const group of groups || []) {
    const groupRowIdx = body.length;
    body.push(['', group.label, ...Array(EXPORT_POS_COL_COUNT - 2).fill('')]);
    bodyMerges.push({
      s: { r: groupRowIdx, c: 1 },
      e: { r: groupRowIdx, c: EXPORT_POS_COL_COUNT - 1 },
    });

    for (const r of group.rows || []) {
      legNum += 1;
      totalUsd += Number(r.usdValue) || 0;
      body.push(defiExportLegRowToDisplay({ ...r, rowNum: legNum }));
    }
  }

  const totalBodyIdx = body.length;
  body.push([
    '', 'TOTAL (net)', '', '', '', '', '', '',
    defiExportFmtUsd(totalUsd),
    '', '', '', '', '', '',
  ]);
  bodyMerges.push({ s: { r: totalBodyIdx, c: 1 }, e: { r: totalBodyIdx, c: 7 } });

  const titleRows = defiExportTitleBlock({ ...meta, legCount: legNum });
  const headerRow = EXPORT_TITLE_ROW_COUNT;
  const totalRow = EXPORT_TITLE_ROW_COUNT + body.length - 1;
  const groupRows = bodyMerges
    .filter(m => m.s.r !== totalBodyIdx)
    .map(m => EXPORT_TITLE_ROW_COUNT + m.s.r);
  const legRows = [];
  for (let i = headerRow + 1; i < totalRow; i += 1) {
    if (!groupRows.includes(i)) legRows.push(i);
  }

  return {
    aoa: [...titleRows, ...body],
    merges: [...defiExportTitleMerges(), ...defiExportOffsetMerges(bodyMerges, EXPORT_TITLE_ROW_COUNT)],
    totalUsd,
    legCount: legNum,
    headerRow,
    totalRow,
    groupRows,
    legRows,
  };
}

function buildDefiSummarySheetAoA(summary) {
  const metrics = [
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
  return {
    aoa: [
      ['Portfolio Summary', ''],
      [`As of ${summary.exportDate || defiExportExportDate()}`, ''],
      ['', ''],
      ['Metric', 'Value'],
      ...metrics,
    ],
    merges: [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 1 } },
      { s: { r: 1, c: 0 }, e: { r: 1, c: 1 } },
    ],
    headerRow: 3,
    metricsStart: 4,
    metricsEnd: 3 + metrics.length,
  };
}

function defiExportThinBorder(color = STYLE.grid) {
  const edge = { style: 'thin', color: { rgb: color } };
  return { top: edge, bottom: edge, left: edge, right: edge };
}

function defiExportCellStyle(base, overrides = {}) {
  return { ...base, ...overrides };
}

function defiExportEnsureCell(ws, ref) {
  if (!ws[ref]) ws[ref] = { t: 's', v: '' };
  return ws[ref];
}

function defiExportApyColor(text) {
  const s = String(text || '');
  if (s === '—' || s === '') return STYLE.muted;
  if (s.startsWith('+')) return STYLE.pos;
  if (s.startsWith('-')) return STYLE.neg;
  return null;
}

function defiExportEncodeCell(XLSXLib, r, c) {
  return XLSXLib.utils.encode_cell({ r, c });
}

function defiExportApplyPositionsSheetStyles(ws, layout, XLSXLib) {
  const enc = (r, c) => defiExportEncodeCell(XLSXLib, r, c);
  const { aoa, headerRow, totalRow, groupRows, legRows } = layout;
  const lastCol = EXPORT_POS_COL_COUNT - 1;
  const lastRow = aoa.length - 1;
  const headerBase = {
    font: { bold: true, color: { rgb: STYLE.excelGreenText }, sz: 11, name: 'Calibri' },
    fill: { patternType: 'solid', fgColor: { rgb: STYLE.excelGreen } },
    alignment: { horizontal: 'left', vertical: 'center' },
    border: defiExportThinBorder(),
  };
  const groupBase = {
    font: { bold: true, color: { rgb: STYLE.groupText }, sz: 11, name: 'Calibri' },
    fill: { patternType: 'solid', fgColor: { rgb: STYLE.groupBg } },
    alignment: { horizontal: 'left', vertical: 'center' },
    border: defiExportThinBorder('B7DFC8'),
  };
  const totalBase = {
    font: { bold: true, sz: 11, name: 'Calibri' },
    fill: { patternType: 'solid', fgColor: { rgb: STYLE.totalBg } },
    alignment: { horizontal: 'left', vertical: 'center' },
    border: defiExportThinBorder('999999'),
  };
  const legBase = {
    font: { sz: 11, name: 'Calibri', color: { rgb: '111111' } },
    fill: { patternType: 'solid', fgColor: { rgb: 'FFFFFF' } },
    alignment: { horizontal: 'left', vertical: 'center' },
    border: defiExportThinBorder(),
  };

  for (let c = 0; c <= lastCol; c += 1) {
    const ref = enc(headerRow, c);
    const cell = defiExportEnsureCell(ws, ref);
    cell.s = defiExportCellStyle(headerBase, {
      alignment: { horizontal: NUM_COLS.has(c) ? 'right' : 'left', vertical: 'center' },
    });
  }

  for (const r of groupRows) {
    for (let c = 0; c <= lastCol; c += 1) {
      const ref = enc(r, c);
      const cell = defiExportEnsureCell(ws, ref);
      cell.s = { ...groupBase };
    }
  }

  for (const r of legRows) {
    const zebra = legRows.indexOf(r) % 2 === 1;
    for (let c = 0; c <= lastCol; c += 1) {
      const ref = enc(r, c);
      const cell = defiExportEnsureCell(ws, ref);
      const value = aoa[r]?.[c];
      const style = {
        ...legBase,
        fill: { patternType: 'solid', fgColor: { rgb: zebra ? STYLE.zebraBg : 'FFFFFF' } },
        alignment: {
          horizontal: NUM_COLS.has(c) ? 'right' : 'left',
          vertical: 'center',
        },
      };
      if (c === 0) {
        style.font = { ...style.font, color: { rgb: STYLE.muted } };
      }
      if (c === 8 && String(value).startsWith('-')) {
        style.font = { ...style.font, color: { rgb: STYLE.neg } };
      }
      if (APY_COLS.has(c)) {
        const apyColor = defiExportApyColor(value);
        if (apyColor) style.font = { ...style.font, color: { rgb: apyColor } };
      }
      cell.s = style;
    }
  }

  for (let c = 0; c <= lastCol; c += 1) {
    const ref = enc(totalRow, c);
    const cell = defiExportEnsureCell(ws, ref);
    const value = aoa[totalRow]?.[c];
    cell.s = defiExportCellStyle(totalBase, {
      alignment: {
        horizontal: c === 8 ? 'right' : 'left',
        vertical: 'center',
      },
      font: c === 8
        ? { bold: true, sz: 11, name: 'Calibri', color: { rgb: '111111' } }
        : totalBase.font,
    });
    if (c === 8 && String(value).startsWith('-')) {
      cell.s.font = { ...cell.s.font, color: { rgb: STYLE.neg } };
    }
  }

  for (let c = 0; c <= lastCol; c += 1) {
    const titleRef = enc(0, c);
    const titleCell = defiExportEnsureCell(ws, titleRef);
    titleCell.s = {
      font: { bold: true, sz: 16, name: 'Calibri', color: { rgb: STYLE.titleText } },
      alignment: { horizontal: 'left', vertical: 'center' },
    };
    const subRef = enc(1, c);
    const subCell = defiExportEnsureCell(ws, subRef);
    subCell.s = {
      font: { sz: 10, name: 'Calibri', color: { rgb: STYLE.subtitleText } },
      alignment: { horizontal: 'left', vertical: 'center' },
    };
  }

  ws['!sheetViews'] = [{
    workbookViewId: 0,
    rightToLeft: false,
    state: 'frozen',
    showGridLines: true,
    xSplit: 0,
    ySplit: headerRow + 1,
    topLeftCell: enc(headerRow + 1, 0),
    activeCell: enc(headerRow + 1, 0),
  }];
  ws['!autofilter'] = { ref: `${enc(headerRow, 0)}:${enc(lastRow, lastCol)}` };
}

function defiExportApplySummarySheetStyles(ws, layout, XLSXLib) {
  const enc = (r, c) => defiExportEncodeCell(XLSXLib, r, c);
  const { aoa, headerRow, metricsStart, metricsEnd } = layout;
  const headerBase = {
    font: { bold: true, color: { rgb: STYLE.excelGreenText }, sz: 11, name: 'Calibri' },
    fill: { patternType: 'solid', fgColor: { rgb: STYLE.excelGreen } },
    alignment: { horizontal: 'left', vertical: 'center' },
    border: defiExportThinBorder(),
  };
  for (let c = 0; c <= 1; c += 1) {
    const ref = enc(headerRow, c);
    const cell = defiExportEnsureCell(ws, ref);
    cell.s = defiExportCellStyle(headerBase, {
      alignment: { horizontal: c === 1 ? 'right' : 'left', vertical: 'center' },
    });
  }
  for (let r = 0; r <= 1; r += 1) {
    for (let c = 0; c <= 1; c += 1) {
      const ref = enc(r, c);
      const cell = defiExportEnsureCell(ws, ref);
      cell.s = {
        font: {
          bold: r === 0,
          sz: r === 0 ? 14 : 10,
          name: 'Calibri',
          color: { rgb: r === 0 ? STYLE.titleText : STYLE.subtitleText },
        },
        alignment: { horizontal: 'left', vertical: 'center' },
      };
    }
  }
  for (let r = metricsStart; r <= metricsEnd; r += 1) {
    for (let c = 0; c <= 1; c += 1) {
      const ref = enc(r, c);
      const cell = defiExportEnsureCell(ws, ref);
      const value = aoa[r]?.[c];
      const zebra = (r - metricsStart) % 2 === 1;
      const style = {
        font: { sz: 11, name: 'Calibri', color: { rgb: '111111' } },
        fill: { patternType: 'solid', fgColor: { rgb: zebra ? STYLE.zebraBg : 'FFFFFF' } },
        alignment: { horizontal: c === 1 ? 'right' : 'left', vertical: 'center' },
        border: defiExportThinBorder(),
      };
      if (c === 1 && String(aoa[r]?.[0]).includes('APY')) {
        const apyColor = defiExportApyColor(value);
        if (apyColor) style.font = { ...style.font, color: { rgb: apyColor } };
      }
      cell.s = style;
    }
  }
}

/**
 * Build styled Positions worksheet (requires xlsx-js-style global XLSX).
 * @param {Array<{ label: string, rows: object[] }>} groups
 * @param {{ exportDate?: string, protocolCount?: number }} meta
 */
function buildDefiPositionsWorksheet(XLSXLib, groups, meta = {}) {
  const layout = buildDefiPositionsSheetAoA(groups, meta);
  const ws = XLSXLib.utils.aoa_to_sheet(layout.aoa);
  ws['!cols'] = EXPORT_POS_COL_WIDTHS;
  ws['!merges'] = layout.merges;
  defiExportApplyPositionsSheetStyles(ws, layout, XLSXLib);
  return ws;
}

/**
 * Build styled Summary worksheet (requires xlsx-js-style global XLSX).
 */
function buildDefiSummaryWorksheet(XLSXLib, summary) {
  const layout = buildDefiSummarySheetAoA(summary);
  const ws = XLSXLib.utils.aoa_to_sheet(layout.aoa);
  ws['!cols'] = [{ wch: 26 }, { wch: 28 }];
  ws['!merges'] = layout.merges;
  defiExportApplySummarySheetStyles(ws, layout, XLSXLib);
  return ws;
}

function buildDefiWorkbookProps() {
  return {
    Title: 'DeFi Positions Export',
    Subject: 'Portfolio DeFi positions',
    Author: 'DeFi Portfolio Tracker',
    CreatedDate: new Date(),
  };
}

const defiExportBundle = {
  EXPORT_POS_HEADERS,
  EXPORT_POS_COL_WIDTHS,
  EXPORT_TITLE_ROW_COUNT,
  STYLE,
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
  buildDefiPositionsWorksheet,
  buildDefiSummaryWorksheet,
  buildDefiWorkbookProps,
  defiExportApplyPositionsSheetStyles,
  defiExportApplySummarySheetStyles,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = defiExportBundle;
}
if (typeof window !== 'undefined') {
  window.DefiExport = defiExportBundle;
}

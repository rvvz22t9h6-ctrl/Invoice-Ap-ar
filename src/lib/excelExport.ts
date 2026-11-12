/**
 * Excel 匯出（.xlsx）
 *
 * 產生可直接向主管簡報的 Excel 活頁簿：
 *   - 摘要（Summary）：關鍵指標、帳齡、每月趨勢
 *   - AP 發票、AR 發票、付款紀錄、AP 帳齡、AR 帳齡
 * 格式：海軍藍標題列、RM 金額格式、真正的 Excel 日期、凍結標題列、自動篩選、
 *       合計列使用 SUBTOTAL 公式（篩選後合計會自動更新）。
 *
 * 所有數字都由 domain 層計算後寫入，與畫面上的數字完全一致。
 * exceljs 體積較大，因此以動態載入（只有按下匯出時才下載）。
 */
import type { Workbook, Worksheet } from 'exceljs';
import { AGING_BUCKETS, buildAgingReport, type AgingReport } from '@/domain/aging';
import { buildDashboard } from '@/domain/dashboard';
import { formatDate, formatMonth } from '@/domain/dates';
import { saveFile } from './download';
import { APPROVAL_LABEL, PAYMENT_KIND_LABEL, TYPE_LABELS, type CompanySettings, type ComputedInvoice, type Counterparty, type InvoiceType, type PaymentKind } from '@/domain/types';
import { buildCashFlowForecast, type CashFlowForecast } from '@/domain/cashflow';
import type { Statement } from '@/domain/statement';

const NAVY = 'FF0F1F3D';
const LIGHT = 'FFF1F4FA';
const MONEY_FMT = '"RM" #,##0.00;[Red]-"RM" #,##0.00';
const DATE_FMT = 'dd mmm yyyy';

type ColType = 'text' | 'money' | 'date' | 'int';
interface Col<T> { header: string; width: number; type: ColType; value: (row: T) => string | number | null; total?: boolean }

/** 整數仙 → 令吉（Excel 儲存格數值）。 */
const rm = (sen: number) => sen / 100;
/** ISO 日期 → Excel 日期（以 UTC 午夜避免時區偏移）。 */
const xlDate = (iso: string | null) => (iso ? new Date(`${iso}T00:00:00Z`) : null);

async function newWorkbook(): Promise<Workbook> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Finance Portal';
  wb.created = new Date();
  return wb;
}

/** 列印設定：寬度縮放為一頁、橫向（摘要為直向）、每頁重複標題列。 */
function printSetup(ws: Worksheet, landscape = true, repeatHeader = true) {
  ws.pageSetup = { orientation: landscape ? 'landscape' : 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 } };
  if (repeatHeader) ws.pageSetup.printTitlesRow = '1:1';
  ws.headerFooter = { oddFooter: '&L&8Finance Portal · &A&R&8Page &P of &N' };
}

function styleHeader(ws: Worksheet, rowNumber: number, count: number) {
  const row = ws.getRow(rowNumber);
  for (let c = 1; c <= count; c += 1) {
    const cell = row.getCell(c);
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
    cell.alignment = { vertical: 'middle', wrapText: true };
  }
  row.height = 22;
}

/**
 * 在工作表的指定列開始寫入一個表格（含標題列、資料列、合計列）。
 * 回傳下一個可用的列號。
 */
function writeTable<T>(ws: Worksheet, startRow: number, cols: Col<T>[], rows: T[], opts: { totalLabel?: string; filter?: boolean } = {}): number {
  cols.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.width = Math.max(col.width ?? 0, c.width);
  });
  ws.getRow(startRow).values = cols.map((c) => c.header);
  styleHeader(ws, startRow, cols.length);
  // 金額與數字欄的標題靠右，與數字對齊
  cols.forEach((c, j) => { if (c.type === 'money' || c.type === 'int') ws.getRow(startRow).getCell(j + 1).alignment = { vertical: 'middle', horizontal: 'right', wrapText: true }; });

  rows.forEach((r, i) => {
    const row = ws.getRow(startRow + 1 + i);
    cols.forEach((c, j) => {
      const cell = row.getCell(j + 1);
      const v = c.value(r);
      cell.value = c.type === 'date' ? xlDate(v as string | null) : v;
      if (c.type === 'money') cell.numFmt = MONEY_FMT;
      if (c.type === 'date') cell.numFmt = DATE_FMT;
      if (c.type === 'money' || c.type === 'int') cell.alignment = { horizontal: 'right' };
      // 付款狀態上色，方便一眼辨識
      if (c.header.endsWith('Status') && typeof v === 'string') {
        if (v === 'Overdue') cell.font = { color: { argb: 'FFC0392B' }, bold: true };
        else if (v === 'Paid') cell.font = { color: { argb: 'FF1E7B4F' } };
        else if (v === 'Partially Paid') cell.font = { color: { argb: 'FFB7791F' } };
        else if (v === 'Cancelled') cell.font = { color: { argb: 'FF8A94A6' }, italic: true };
      }
    });
  });

  const lastDataRow = startRow + rows.length;
  let next = lastDataRow + 1;
  if (opts.totalLabel && rows.length) {
    const totalRow = ws.getRow(next);
    totalRow.getCell(1).value = opts.totalLabel;
    cols.forEach((c, j) => {
      if (!c.total) return;
      const letter = ws.getColumn(j + 1).letter;
      const cached = rows.reduce((t, r) => t + Number(c.value(r) ?? 0), 0);
      // SUBTOTAL(109, …)：只加總「篩選後仍可見」的列
      totalRow.getCell(j + 1).value = { formula: `SUBTOTAL(109,${letter}${startRow + 1}:${letter}${lastDataRow})`, result: Math.round(cached * 100) / 100 };
      totalRow.getCell(j + 1).numFmt = c.type === 'money' ? MONEY_FMT : '0';
    });
    for (let c = 1; c <= cols.length; c += 1) {
      const cell = totalRow.getCell(c);
      cell.font = { bold: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LIGHT } };
      cell.border = { top: { style: 'thin', color: { argb: NAVY } } };
    }
    next += 1;
  }
  if (opts.filter && rows.length) {
    ws.autoFilter = { from: { row: startRow, column: 1 }, to: { row: lastDataRow, column: cols.length } };
  }
  return next;
}

// ---------------------------------------------------------------------------
// 各工作表
// ---------------------------------------------------------------------------

function invoiceColumns(type: InvoiceType): Col<ComputedInvoice>[] {
  const L = TYPE_LABELS[type];
  return [
    { header: 'Invoice Number', width: 16, type: 'text', value: (i) => i.invoiceNumber },
    { header: L.party, width: 36, type: 'text', value: (i) => i.counterpartyName },
    { header: 'Invoice Date', width: 13, type: 'date', value: (i) => i.invoiceDate },
    { header: 'Due Date', width: 13, type: 'date', value: (i) => i.dueDate },
    { header: 'Description', width: 34, type: 'text', value: (i) => i.description },
    { header: 'Invoice Amount', width: 16, type: 'money', value: (i) => rm(i.invoiceAmount), total: true },
    { header: 'Tax Amount', width: 14, type: 'money', value: (i) => rm(i.taxAmount), total: true },
    { header: 'Total Amount', width: 16, type: 'money', value: (i) => rm(i.totalAmount), total: true },
    { header: L.paid, width: 16, type: 'money', value: (i) => rm(i.amountPaid), total: true },
    { header: 'Outstanding Balance', width: 18, type: 'money', value: (i) => rm(i.outstandingBalance), total: true },
    { header: L.status, width: 16, type: 'text', value: (i) => i.status },
    ...(type === 'AP' ? [{ header: 'Approval', width: 16, type: 'text' as const, value: (i: ComputedInvoice) => (i.approvalStatus ? APPROVAL_LABEL[i.approvalStatus] : '') }] : []),
    { header: 'Days Overdue', width: 12, type: 'int', value: (i) => i.daysOverdue },
    { header: 'Last Payment', width: 13, type: 'date', value: (i) => i.lastPaymentDate },
    { header: 'Remarks', width: 40, type: 'text', value: (i) => i.remarks ?? '' },
  ];
}

function addInvoiceSheet(wb: Workbook, name: string, type: InvoiceType, rows: ComputedInvoice[]) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1, xSplit: 1 }] });
  printSetup(ws);
  const sorted = [...rows].sort((a, b) => a.invoiceDate.localeCompare(b.invoiceDate) || a.invoiceNumber.localeCompare(b.invoiceNumber));
  writeTable(ws, 1, invoiceColumns(type), sorted, { totalLabel: 'Total', filter: true });
}

function addPaymentsSheet(wb: Workbook, invoices: ComputedInvoice[]) {
  const ws = wb.addWorksheet('Payments', { views: [{ state: 'frozen', ySplit: 1 }] });
  printSetup(ws);
  type Row = { inv: ComputedInvoice; date: string; amount: number; method: string; reference: string; kind: PaymentKind };
  const rows: Row[] = invoices.flatMap((inv) => inv.payments.map((p) => ({ inv, date: p.paymentDate, amount: p.amount, method: p.method, reference: p.reference, kind: p.kind ?? 'payment' })))
    .sort((a, b) => a.date.localeCompare(b.date));
  writeTable<Row>(ws, 1, [
    { header: 'Payment Date', width: 13, type: 'date', value: (r) => r.date },
    { header: 'Type', width: 22, type: 'text', value: (r) => (r.kind !== 'payment' ? `${r.inv.type} – ${PAYMENT_KIND_LABEL[r.kind]}` : r.inv.type === 'AR' ? 'AR – Collected' : 'AP – Paid') },
    { header: 'Invoice Number', width: 16, type: 'text', value: (r) => r.inv.invoiceNumber },
    { header: 'Customer / Supplier', width: 36, type: 'text', value: (r) => r.inv.counterpartyName },
    { header: 'Method', width: 26, type: 'text', value: (r) => r.method },
    { header: 'Reference', width: 18, type: 'text', value: (r) => r.reference },
    { header: 'Amount', width: 16, type: 'money', value: (r) => rm(r.amount), total: true },
  ], rows, { totalLabel: 'Total', filter: true });
}

function addAgingSheet(wb: Workbook, name: string, report: AgingReport) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1, xSplit: 1 }] });
  printSetup(ws);
  const L = TYPE_LABELS[report.type];
  writeTable(ws, 1, [
    { header: L.party, width: 38, type: 'text', value: (r) => r.counterpartyName },
    ...AGING_BUCKETS.map((b): Col<AgingReport['byCounterparty'][number]> => ({ header: b.label, width: 15, type: 'money', value: (r) => rm(r.buckets[b.key]), total: true })),
    { header: 'Total Outstanding', width: 18, type: 'money', value: (r) => rm(r.total), total: true },
  ], report.byCounterparty, { totalLabel: 'Total', filter: true });
}

function addSummarySheet(wb: Workbook, invoices: ComputedInvoice[], today: string, companyName?: string) {
  const d = buildDashboard(invoices, today);
  const aging = { AR: buildAgingReport(invoices, 'AR'), AP: buildAgingReport(invoices, 'AP') };
  const ws = wb.addWorksheet('Summary', { views: [{ showGridLines: false }] });
  printSetup(ws, false, false);
  ws.getColumn(1).width = 34;
  [2, 3, 4, 5].forEach((c) => { ws.getColumn(c).width = 20; });

  ws.getCell('A1').value = companyName ? `${companyName} — AP & AR Summary` : 'AP & AR Summary';
  ws.getCell('A1').font = { bold: true, size: 16, color: { argb: NAVY } };
  ws.getCell('A2').value = `As of ${formatDate(today)} · amounts in Malaysian Ringgit (RM) · cancelled invoices excluded`;
  ws.getCell('A2').font = { italic: true, color: { argb: 'FF64748B' } };

  const section = (row: number, title: string) => {
    ws.getCell(`A${row}`).value = title;
    ws.getCell(`A${row}`).font = { bold: true, size: 12, color: { argb: NAVY } };
    return row + 1;
  };

  // 關鍵指標
  let r = section(4, 'Key figures');
  type K = { label: string; ar: number; ap: number; money: boolean };
  const kpis: K[] = [
    { label: 'Outstanding balance', ar: rm(d.AR.outstanding), ap: rm(d.AP.outstanding), money: true },
    { label: 'Overdue balance', ar: rm(d.AR.overdue), ap: rm(d.AP.overdue), money: true },
    { label: 'Collected / Paid — all time', ar: rm(d.AR.settled), ap: rm(d.AP.settled), money: true },
    { label: 'Collected / Paid — this month', ar: rm(d.AR.settledThisMonth), ap: rm(d.AP.settledThisMonth), money: true },
    { label: 'Credit notes — all time', ar: rm(d.AR.creditNotes), ap: rm(d.AP.creditNotes), money: true },
    { label: 'Written off (bad debt) — all time', ar: rm(d.AR.writtenOff), ap: 0, money: true },
    { label: 'Invoiced — this month', ar: rm(d.AR.invoicedThisMonth), ap: rm(d.AP.invoicedThisMonth), money: true },
    { label: 'Unpaid invoices (count)', ar: d.AR.outstandingCount, ap: d.AP.outstandingCount, money: false },
    { label: 'Overdue invoices (count)', ar: d.AR.overdueCount, ap: d.AP.overdueCount, money: false },
  ];
  ws.getRow(r).values = ['Metric', 'Receivables (AR)', 'Payables (AP)'];
  styleHeader(ws, r, 3);
  kpis.forEach((k, i) => {
    const row = ws.getRow(r + 1 + i);
    row.values = [k.label, k.ar, k.ap];
    [2, 3].forEach((c) => { row.getCell(c).numFmt = k.money ? MONEY_FMT : '0'; });
  });
  r += kpis.length + 1;
  const net = ws.getRow(r);
  net.values = ['Net position (AR − AP outstanding)', rm(d.netPosition)];
  net.getCell(2).numFmt = MONEY_FMT;
  net.font = { bold: true };
  [1, 2, 3].forEach((c) => { net.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LIGHT } }; });

  // 帳齡
  r = section(r + 2, 'Aging of outstanding balances');
  r = writeTable(ws, r, [
    { header: 'Bucket', width: 34, type: 'text', value: (b: (typeof AGING_BUCKETS)[number]) => b.label },
    { header: 'Receivables (AR)', width: 20, type: 'money', value: (b) => rm(aging.AR.buckets[b.key].amount), total: true },
    { header: 'Payables (AP)', width: 20, type: 'money', value: (b) => rm(aging.AP.buckets[b.key].amount), total: true },
  ], AGING_BUCKETS, { totalLabel: 'Total' });

  // 每月趨勢
  r = section(r + 1, 'Monthly trends — last 12 months');
  writeTable(ws, r, [
    { header: 'Month', width: 34, type: 'text', value: (t: (typeof d.trends)[number]) => formatMonth(t.month) },
    { header: 'AR invoiced', width: 20, type: 'money', value: (t) => rm(t.arInvoiced), total: true },
    { header: 'AR collected', width: 20, type: 'money', value: (t) => rm(t.arCollected), total: true },
    { header: 'AP billed', width: 20, type: 'money', value: (t) => rm(t.apInvoiced), total: true },
    { header: 'AP paid', width: 20, type: 'money', value: (t) => rm(t.apPaid), total: true },
  ], d.trends, { totalLabel: '12-month total' });
}

// ---------------------------------------------------------------------------
// 對外函式
// ---------------------------------------------------------------------------

function addCashFlowSheet(wb: Workbook, f: CashFlowForecast, today: string, companyName?: string) {
  const ws = wb.addWorksheet('Cash Flow Forecast', { views: [{ state: 'frozen', ySplit: 4 }] });
  printSetup(ws, true, false);
  ws.getCell('A1').value = `${companyName ? `${companyName} — ` : ''}Cash Flow Forecast (next ${f.rows.length - 1} weeks)`;
  ws.getCell('A1').font = { bold: true, size: 14, color: { argb: NAVY } };
  ws.getCell('A2').value = `As of ${formatDate(today)}. Starting balance ${f.hasOpeningBalance ? 'from your opening bank balance plus payments recorded since then' : 'is RM 0 (no opening bank balance set)'}. Assumes each open invoice is settled on its due date.`;
  ws.getCell('A2').font = { italic: true, color: { argb: 'FF64748B' } };
  type R = CashFlowForecast['rows'][number];
  const start: R = { key: 'start', label: 'Starting balance (today)', start: null, end: null, inflow: 0, outflow: 0, net: 0, closing: f.currentBalance, inflowCount: 0, outflowCount: 0 };
  writeTable<R>(ws, 4, [
    { header: 'Period', width: 30, type: 'text', value: (r) => r.label },
    { header: 'Expected receipts (AR)', width: 22, type: 'money', value: (r) => rm(r.inflow), total: true },
    { header: 'Expected payments (AP)', width: 22, type: 'money', value: (r) => rm(r.outflow), total: true },
    { header: 'Net', width: 18, type: 'money', value: (r) => rm(r.net), total: true },
    { header: 'Projected balance', width: 20, type: 'money', value: (r) => rm(r.closing) },
  ], [start, ...f.rows], { totalLabel: 'Total' });
}

/** 現金流預測活頁簿。 */
export async function buildCashFlowWorkbook(f: CashFlowForecast, today: string, companyName?: string): Promise<Workbook> {
  const wb = await newWorkbook();
  addCashFlowSheet(wb, f, today, companyName);
  return wb;
}

/** 對帳單活頁簿。 */
export async function buildStatementWorkbook(st: Statement, type: InvoiceType, companyName?: string, contact?: Counterparty): Promise<Workbook> {
  const wb = await newWorkbook();
  const ws = wb.addWorksheet('Statement', { views: [{ showGridLines: false }] });
  printSetup(ws, false, false);
  ws.getCell('A1').value = companyName || 'Statement of Account';
  ws.getCell('A1').font = { bold: true, size: 16, color: { argb: NAVY } };
  ws.getCell('A2').value = 'STATEMENT OF ACCOUNT';
  ws.getCell('A2').font = { bold: true, size: 11, color: { argb: 'FF64748B' } };
  ws.getCell('A4').value = `${TYPE_LABELS[type].party}: ${st.counterpartyName}`;
  ws.getCell('A4').font = { bold: true };
  const info = [contact?.contactPerson && `Attn: ${contact.contactPerson}`, contact?.address, [contact?.phone, contact?.email].filter(Boolean).join(' · ')].filter(Boolean) as string[];
  info.forEach((t, i) => { ws.getCell(`A${5 + i}`).value = t; });
  const r0 = 6 + info.length;
  ws.getCell(`A${r0}`).value = `Period: ${formatDate(st.from)} to ${formatDate(st.to)}`;
  ws.getCell(`A${r0 + 1}`).value = `Opening balance: RM ${(st.openingBalance / 100).toLocaleString('en-MY', { minimumFractionDigits: 2 })}`;
  type L = Statement['lines'][number];
  const open: L = { date: st.from, kind: 'invoice', reference: '', description: 'Balance brought forward', dueDate: null, debit: 0, credit: 0, balance: st.openingBalance };
  let r = writeTable<L>(ws, r0 + 3, [
    { header: 'Date', width: 13, type: 'date', value: (l) => l.date },
    { header: 'Invoice No.', width: 16, type: 'text', value: (l) => l.reference },
    { header: 'Description', width: 40, type: 'text', value: (l) => l.description },
    { header: 'Due Date', width: 13, type: 'date', value: (l) => l.dueDate },
    { header: 'Debit (RM)', width: 15, type: 'money', value: (l) => rm(l.debit), total: true },
    { header: 'Credit (RM)', width: 15, type: 'money', value: (l) => rm(l.credit), total: true },
    { header: 'Balance (RM)', width: 16, type: 'money', value: (l) => rm(l.balance) },
  ], [open, ...st.lines], { totalLabel: 'Total' });
  const close = ws.getRow(r);
  close.values = ['Closing balance', '', '', '', '', '', rm(st.closingBalance)];
  close.font = { bold: true };
  close.getCell(7).numFmt = MONEY_FMT;
  r += 2;
  ws.getCell(`A${r}`).value = 'Ageing of outstanding balance (as of today)';
  ws.getCell(`A${r}`).font = { bold: true, color: { argb: NAVY } };
  ws.getRow(r + 1).values = AGING_BUCKETS.map((b) => b.label);
  styleHeader(ws, r + 1, AGING_BUCKETS.length);
  const ar = ws.getRow(r + 2);
  ar.values = AGING_BUCKETS.map((b) => rm(st.aging[b.key]));
  AGING_BUCKETS.forEach((_, i) => { ar.getCell(i + 1).numFmt = MONEY_FMT; });
  return wb;
}

/** 完整報表：摘要 + AP + AR + 付款 + 帳齡 + 現金流。 */
export async function buildFullReport(invoices: ComputedInvoice[], today: string, companyName?: string, settings?: Pick<CompanySettings, 'openingBalance' | 'openingBalanceDate'>): Promise<Workbook> {
  const wb = await newWorkbook();
  addSummarySheet(wb, invoices, today, companyName);
  addInvoiceSheet(wb, 'AR Invoices', 'AR', invoices.filter((i) => i.type === 'AR'));
  addInvoiceSheet(wb, 'AP Invoices', 'AP', invoices.filter((i) => i.type === 'AP'));
  addPaymentsSheet(wb, invoices);
  addAgingSheet(wb, 'AR Aging', buildAgingReport(invoices, 'AR'));
  addAgingSheet(wb, 'AP Aging', buildAgingReport(invoices, 'AP'));
  addCashFlowSheet(wb, buildCashFlowForecast(invoices, today, settings ?? { openingBalance: 0, openingBalanceDate: null }), today, companyName);
  return wb;
}

/** 單一清單（AP 或 AR，依畫面目前的篩選結果）。 */
export async function buildInvoiceListWorkbook(rows: ComputedInvoice[], type: InvoiceType): Promise<Workbook> {
  const wb = await newWorkbook();
  addInvoiceSheet(wb, type === 'AP' ? 'AP Invoices' : 'AR Invoices', type, rows);
  return wb;
}

/** 帳齡報表（AP 或 AR）。 */
export async function buildAgingWorkbook(report: AgingReport): Promise<Workbook> {
  const wb = await newWorkbook();
  addAgingSheet(wb, `${report.type} Aging`, report);
  return wb;
}

/** 下載活頁簿（一般瀏覽器或 claude.ai 皆可）。 */
export async function downloadWorkbook(wb: Workbook, fileName: string) {
  const buffer = await wb.xlsx.writeBuffer();
  await saveFile(fileName, new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
}

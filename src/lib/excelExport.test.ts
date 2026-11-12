// @vitest-environment node
/**
 * Excel 匯出測試：產生活頁簿 → 寫成檔案 → 重新讀取，核對工作表、數字與格式。
 */
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { buildInitialDemoState } from '@/data/demoRepository';
import { buildAgingReport } from '@/domain/aging';
import { buildDashboard } from '@/domain/dashboard';
import { computeInvoices } from '@/domain/invoice';
import type { Invoice } from '@/domain/types';
import { buildAgingWorkbook, buildFullReport, buildInvoiceListWorkbook } from './excelExport';

const TODAY = '2026-11-12';
const state = buildInitialDemoState(TODAY);
const names = new Map(state.counterparties.map((c) => [c.id, c.name]));
const invoices = computeInvoices(state.invoices.map((i): Invoice => ({ ...i, counterpartyName: names.get(i.counterpartyId)! })), TODAY);
const d = buildDashboard(invoices, TODAY);

async function roundTrip(wb: ExcelJS.Workbook) {
  const buf = await wb.xlsx.writeBuffer();
  const back = new ExcelJS.Workbook();
  await back.xlsx.load(buf);
  return back;
}

/** 找出第一欄等於 label 的列。 */
function rowWith(ws: ExcelJS.Worksheet, label: string) {
  let found: ExcelJS.Row | undefined;
  ws.eachRow((row) => { if (!found && row.getCell(1).value === label) found = row; });
  if (!found) throw new Error(`row "${label}" not found`);
  return found;
}
const num = (v: ExcelJS.CellValue) => (typeof v === 'object' && v && 'result' in v ? Number(v.result) : Number(v));

describe('Excel full report', () => {
  it('contains all six sheets', async () => {
    const wb = await roundTrip(await buildFullReport(invoices, TODAY, 'Sample Sdn Bhd'));
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Summary', 'AR Invoices', 'AP Invoices', 'Payments', 'AR Aging', 'AP Aging']);
  });

  it('summary figures equal the dashboard calculation', async () => {
    const ws = (await roundTrip(await buildFullReport(invoices, TODAY))).getWorksheet('Summary')!;
    const out = rowWith(ws, 'Outstanding balance');
    expect(num(out.getCell(2).value)).toBeCloseTo(d.AR.outstanding / 100, 2);
    expect(num(out.getCell(3).value)).toBeCloseTo(d.AP.outstanding / 100, 2);
    const overdue = rowWith(ws, 'Overdue balance');
    expect(num(overdue.getCell(2).value)).toBeCloseTo(d.AR.overdue / 100, 2);
    expect(num(overdue.getCell(3).value)).toBeCloseTo(d.AP.overdue / 100, 2);
    expect(num(rowWith(ws, 'Collected / Paid — all time').getCell(2).value)).toBeCloseTo(d.AR.settled / 100, 2);
    expect(num(rowWith(ws, 'Net position (AR − AP outstanding)').getCell(2).value)).toBeCloseTo(d.netPosition / 100, 2);
    expect(out.getCell(2).numFmt).toContain('"RM"');
  });

  it('invoice sheet has one row per invoice, real dates, RM format and SUBTOTAL totals', async () => {
    const ws = (await roundTrip(await buildFullReport(invoices, TODAY))).getWorksheet('AR Invoices')!;
    const ar = invoices.filter((i) => i.type === 'AR');
    expect(ws.getRow(1).getCell(2).value).toBe('Customer');
    expect(ws.rowCount).toBe(ar.length + 2); // 標題 + 資料 + 合計
    expect(ws.getRow(2).getCell(3).value).toBeInstanceOf(Date);
    const total = ws.getRow(ar.length + 2);
    expect(total.getCell(1).value).toBe('Total');
    const outCell = total.getCell(10).value as ExcelJS.CellFormulaValue;
    expect(outCell.formula).toBe(`SUBTOTAL(109,J2:J${ar.length + 1})`);
    expect(Number(outCell.result)).toBeCloseTo(d.AR.outstanding / 100, 2);
    expect(ws.autoFilter).toBeTruthy();
  });

  it('payments sheet totals all payments', async () => {
    const ws = (await roundTrip(await buildFullReport(invoices, TODAY))).getWorksheet('Payments')!;
    const count = invoices.reduce((n, i) => n + i.payments.length, 0);
    const total = ws.getRow(count + 2);
    expect(num(total.getCell(7).value)).toBeCloseTo((d.AR.settled + d.AP.settled) / 100, 2);
  });

  it('list and aging workbooks', async () => {
    const ap = invoices.filter((i) => i.type === 'AP' && i.status === 'Overdue');
    const list = await roundTrip(await buildInvoiceListWorkbook(ap, 'AP'));
    expect(list.worksheets[0]!.rowCount).toBe(ap.length + 2);
    expect(list.worksheets[0]!.getRow(1).getCell(12).value).toBe('Approval');
    const aging = await roundTrip(await buildAgingWorkbook(buildAgingReport(invoices, 'AP')));
    const ws = aging.worksheets[0]!;
    const totalRow = ws.getRow(ws.rowCount);
    expect(num(totalRow.getCell(7).value)).toBeCloseTo(d.AP.outstanding / 100, 2);
  });
});

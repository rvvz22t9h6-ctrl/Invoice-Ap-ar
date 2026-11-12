/**
 * 端對端測試：模擬真實使用者操作所有主要流程，並核對畫面上的數字。
 */
import { expect, test } from '@playwright/test';
import { addDays } from '../src/domain/dates';
import { AGING_BUCKETS } from '../src/domain/aging';
import ExcelJS from 'exceljs';
import { expectedDashboard, fillInvoiceForm, kpi, login, money, today } from './helpers';

test.describe('Dashboard', () => {
  test('every KPI equals the figure calculated from the invoice and payment records', async ({ page }) => {
    const { dashboard: d } = expectedDashboard();
    await login(page, 'viewer');
    await expect(kpi(page, 'kpi-ar-outstanding')).toHaveText(money(d.AR.outstanding));
    await expect(kpi(page, 'kpi-ap-outstanding')).toHaveText(money(d.AP.outstanding));
    await expect(kpi(page, 'kpi-ar-collected')).toHaveText(money(d.AR.settled));
    await expect(kpi(page, 'kpi-ap-paid')).toHaveText(money(d.AP.settled));
    await expect(kpi(page, 'kpi-ar-overdue')).toHaveText(money(d.AR.overdue));
    await expect(kpi(page, 'kpi-ap-overdue')).toHaveText(money(d.AP.overdue));
    await expect(page.getByTestId('net-position')).toHaveText(money(d.netPosition));
    // 數字不可為 0（確認確實有計算，不是空資料）
    expect(d.AR.outstanding).toBeGreaterThan(0);
    expect(d.AP.overdue).toBeGreaterThan(0);
  });

  test('trend chart renders 24 bars and its table view matches the data', async ({ page }) => {
    const { dashboard: d } = expectedDashboard();
    await login(page, 'viewer');
    await expect(page.locator('.recharts-bar-rectangle')).toHaveCount(24);
    await page.getByRole('button', { name: 'Show table' }).click();
    const last = d.trends.at(-1)!;
    const lastRow = page.getByTestId('trend-table').locator('tbody tr').last();
    await expect(lastRow).toContainText(money(last.arInvoiced));
    await expect(lastRow).toContainText(money(last.apInvoiced));
    await page.getByRole('tab', { name: 'Paid / Collected' }).click();
    await expect(lastRow).toContainText(money(last.arCollected));
    await expect(lastRow).toContainText(money(last.apPaid));
  });

  test('recent activity lists 10 entries and opens the related invoice', async ({ page }) => {
    await login(page, 'viewer');
    const items = page.getByTestId('recent-activity').locator('li');
    await expect(items).toHaveCount(10);
    await items.first().getByRole('button').click();
    await expect(page.getByRole('dialog')).toContainText('History');
  });
});

test.describe('Viewer (boss) access', () => {
  test('is read-only everywhere', async ({ page }) => {
    await login(page, 'viewer');
    await page.getByRole('link', { name: 'Accounts Payable' }).click();
    await expect(page.getByTestId('new-invoice')).toHaveCount(0);
    await page.getByTestId('invoice-table').locator('tbody tr').first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    for (const name of ['Edit', 'Record Payment', 'Delete', 'Cancel invoice', 'Approve', 'Reverse']) {
      await expect(dialog.getByRole('button', { name, exact: true })).toHaveCount(0);
    }
    await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
    await expect(dialog).toHaveCount(0);
  });
});

test.describe('Accounts Receivable', () => {
  test('create invoice with validation, duplicate check, partial and full collection', async ({ page }) => {
    await login(page, 'finance');
    const { dashboard: before } = expectedDashboard();
    await page.getByRole('link', { name: 'Accounts Receivable' }).click();
    await page.getByTestId('new-invoice').click();
    const dialog = page.getByRole('dialog');

    // 1. 空白送出 → 顯示欄位錯誤
    await dialog.getByTestId('save-invoice').click();
    await expect(dialog.getByText('Invoice number is required')).toBeVisible();
    await expect(dialog.getByText('Name is required')).toBeVisible();
    await expect(dialog.getByText('Invoice amount is required')).toBeVisible();

    // 2. 無效金額與到期日早於發票日
    await fillInvoiceForm(page, { number: 'INV-E2E-1', party: 'Orkid Bakery Sdn Bhd', amount: '12.345', due: addDays(today, -5) });
    await dialog.getByTestId('save-invoice').click();
    await expect(dialog.getByText(/valid amount with up to 2 decimals/)).toBeVisible();
    await expect(dialog.getByText('Due date cannot be before the invoice date')).toBeVisible();

    // 3. 重複發票號碼（範例資料已有 INV-10201）
    await fillInvoiceForm(page, { number: 'inv-10201', party: 'Orkid Bakery Sdn Bhd', amount: '1000', due: addDays(today, 30) });
    await dialog.getByTestId('save-invoice').click();
    await expect(dialog.getByText(/INV-10201 already exists/)).toBeVisible();

    // 4. 正確資料：SST 10% → 稅額 1,000.00，總額即時顯示
    await fillInvoiceForm(page, { number: 'INV-E2E-1', party: 'Orkid Bakery Sdn Bhd', amount: '10,000', rate: '10', due: addDays(today, 30), description: 'Wedding cake boxes' });
    await expect(dialog.getByLabel('Tax Amount (RM)')).toHaveValue('1000.00');
    await expect(dialog.getByTestId('form-total')).toHaveText('RM 11,000.00');
    await dialog.getByTestId('save-invoice').click();

    // 建立後自動開啟明細
    await expect(dialog).toContainText('INV-E2E-1');
    await expect(dialog.getByTestId('detail-outstanding')).toHaveText('RM 11,000.00');
    await expect(dialog).toContainText('Pending');

    // 5. 部分收款
    await dialog.getByTestId('record-payment').click();
    const pay = page.getByRole('dialog');
    await pay.getByLabel('Amount (RM) *').fill('4000');
    await expect(pay.getByTestId('balance-after')).toHaveText('Balance after: RM 7,000.00 (partial payment)');
    await pay.getByLabel('Reference').fill('DuitNow 88123');
    await pay.getByTestId('save-payment').click();
    await expect(page.getByRole('dialog').getByTestId('detail-outstanding')).toHaveText('RM 7,000.00');
    await expect(page.getByRole('dialog')).toContainText('Partially Paid');

    // 6. 超額付款被阻擋
    await page.getByRole('dialog').getByTestId('record-payment').click();
    await page.getByRole('dialog').getByLabel('Amount (RM) *').fill('7000.01');
    await page.getByRole('dialog').getByTestId('save-payment').click();
    await expect(page.getByRole('dialog').getByText(/exceeds the outstanding balance of RM 7,000.00/)).toBeVisible();

    // 7. 未來日期被阻擋
    await page.getByRole('dialog').getByLabel('Amount (RM) *').fill('7000');
    await page.getByRole('dialog').getByLabel('Payment Date *').fill(addDays(today, 1));
    await page.getByRole('dialog').getByTestId('save-payment').click();
    await expect(page.getByRole('dialog').getByText('Payment date cannot be in the future')).toBeVisible();

    // 8. 收清
    await page.getByRole('dialog').getByLabel('Payment Date *').fill(today);
    await page.getByRole('dialog').getByRole('button', { name: 'Use full balance' }).click();
    await page.getByRole('dialog').getByTestId('save-payment').click();
    const detail = page.getByRole('dialog');
    await expect(detail.getByTestId('detail-outstanding')).toHaveText('RM 0.00');
    await expect(detail.getByTestId('payments-table').locator('tbody tr')).toHaveCount(2);
    await expect(detail).toContainText('Collected RM 4,000.00 on AR invoice INV-E2E-1');
    await page.keyboard.press('Escape');

    // 9. 儀表板：AR 已收增加 11,000；未付不變（新發票已收清）
    await page.getByRole('link', { name: 'Dashboard' }).click();
    await expect(kpi(page, 'kpi-ar-collected')).toHaveText(money(before.AR.settled + 1_100_000));
    await expect(kpi(page, 'kpi-ar-outstanding')).toHaveText(money(before.AR.outstanding));
  });

  test('a new unpaid invoice increases AR outstanding by exactly its total', async ({ page }) => {
    const { dashboard: before } = expectedDashboard();
    await login(page, 'finance');
    await page.getByRole('link', { name: 'Accounts Receivable' }).click();
    await page.getByTestId('new-invoice').click();
    await fillInvoiceForm(page, { number: 'INV-E2E-2', party: 'Gemilang Retail Holdings Bhd', amount: '2500.50', tax: '150.03' });
    await expect(page.getByRole('dialog').getByTestId('form-total')).toHaveText('RM 2,650.53');
    await page.getByRole('dialog').getByTestId('save-invoice').click();
    await expect(page.getByRole('dialog')).toContainText('INV-E2E-2');
    await page.keyboard.press('Escape');
    await page.getByRole('link', { name: 'Dashboard' }).click();
    await expect(kpi(page, 'kpi-ar-outstanding')).toHaveText(money(before.AR.outstanding + 265_053));
  });

  test('editing an invoice recalculates totals; total cannot go below paid', async ({ page }) => {
    await login(page, 'finance');
    await page.goto('/ar?status=Partially+Paid');
    await page.getByTestId('invoice-table').locator('tbody tr').first().click();
    const dialog = page.getByRole('dialog');
    const paidText = await dialog.getByTestId('detail-amount-received').textContent();
    await dialog.getByTestId('edit-invoice').click();
    await expect(page.getByRole('dialog')).toContainText('Edit invoice'); // 等待編輯表單完全取代明細
    await page.getByRole('dialog').getByLabel('Tax rate').selectOption('custom');
    await page.getByRole('dialog').getByLabel('Tax Amount (RM)').fill('0');
    await page.getByRole('dialog').getByLabel('Invoice Amount (RM) *').fill('1');
    await page.getByRole('dialog').getByTestId('save-invoice').click();
    await expect(page.getByRole('dialog').getByText(/cannot be less than the .* already paid/)).toBeVisible();
    expect(paidText).toMatch(/^RM /);
  });
});

test.describe('Accounts Payable', () => {
  test('approval workflow: finance creates → cannot pay → admin approves → payment recorded', async ({ page }) => {
    await login(page, 'finance');
    await page.getByRole('link', { name: 'Accounts Payable' }).click();
    await page.getByTestId('new-invoice').click();
    await fillInvoiceForm(page, { number: 'TNB-778812', party: 'Bekalan Elektrik Murni Sdn Bhd', amount: '3200', rate: '8' });
    await page.getByRole('dialog').getByTestId('save-invoice').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Pending Approval');
    await expect(dialog).toContainText('awaiting approval');
    await expect(dialog.getByTestId('record-payment')).toHaveCount(0);
    await expect(dialog.getByTestId('approve')).toHaveCount(0); // finance 不可審批
    await page.keyboard.press('Escape');

    // 同一張發票號碼、不同供應商 → 允許
    await page.getByTestId('new-invoice').click();
    await fillInvoiceForm(page, { number: 'TNB-778812', party: 'Another Supplier Sdn Bhd', amount: '100' });
    await page.getByRole('dialog').getByTestId('save-invoice').click();
    await expect(page.getByRole('dialog')).toContainText('Another Supplier Sdn Bhd');
    await page.keyboard.press('Escape');
    // 同一供應商 → 重複
    await page.getByTestId('new-invoice').click();
    await fillInvoiceForm(page, { number: 'tnb-778812', party: 'Bekalan Elektrik Murni Sdn Bhd', amount: '100' });
    await page.getByRole('dialog').getByTestId('save-invoice').click();
    await expect(page.getByRole('dialog').getByText(/already has invoice TNB-778812/)).toBeVisible();
    await page.keyboard.press('Escape');

    // 管理員登入審批
    await page.getByRole('button', { name: 'Sign out' }).click();
    await login(page, 'admin');
    await page.goto('/ap?q=TNB-778812&party=Bekalan+Elektrik+Murni+Sdn+Bhd');
    await expect(page.getByTestId('invoice-table').locator('tbody tr')).toHaveCount(1);
    await page.getByTestId('invoice-table').locator('tbody tr').first().click();
    await page.getByRole('dialog').getByTestId('approve').click();
    await expect(page.getByRole('dialog')).toContainText('Approved');
    await page.getByRole('dialog').getByTestId('record-payment').click();
    await expect(page.getByRole('dialog').getByLabel('Amount (RM) *')).toHaveValue('3456.00'); // 3,200 + 8% SST
    await page.getByRole('dialog').getByTestId('save-payment').click();
    await expect(page.getByRole('dialog').getByTestId('detail-outstanding')).toHaveText('RM 0.00');
    await expect(page.getByRole('dialog')).toContainText('Paid RM 3,456.00 on AP invoice TNB-778812');
  });

  test('filters by supplier, status and approval; totals and CSV follow the filter', async ({ page }) => {
    const { computed } = expectedDashboard();
    await login(page, 'viewer');
    await page.getByRole('link', { name: 'Accounts Payable' }).click();
    const table = page.getByTestId('invoice-table');

    await page.getByLabel('Filter by payment status').selectOption('Overdue');
    const overdue = computed.filter((i) => i.type === 'AP' && i.status === 'Overdue');
    await expect(table.locator('tfoot')).toContainText(`${overdue.length} invoices`);
    await expect(page.getByTestId('footer-outstanding')).toHaveText(money(overdue.reduce((t, i) => t + i.outstandingBalance, 0)));

    const supplier = 'Nusantara Cloud Services Sdn Bhd';
    await page.getByLabel('Filter by supplier').selectOption(supplier);
    const both = overdue.filter((i) => i.counterpartyName === supplier);
    await expect(table.locator('tfoot')).toContainText(`${both.length} invoices`);

    // CSV 匯出內容與篩選結果一致
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-csv').click()]);
    expect(download.suggestedFilename()).toBe(`AP-invoices-${today}.csv`);
    const csv = (await (await download.createReadStream()).toArray()).join('');
    const lines = csv.replace('﻿', '').trim().split('\r\n');
    expect(lines[0]).toContain('Invoice Number,Supplier,Invoice Date,Due Date');
    expect(lines).toHaveLength(both.length + 1);
    expect(lines.slice(1).every((l) => l.includes(supplier) && l.includes(',Overdue,'))).toBe(true);

    await page.getByRole('button', { name: 'Clear filters' }).click();
    await page.getByLabel('Filter by approval status').selectOption('pending');
    const pending = computed.filter((i) => i.type === 'AP' && i.approvalStatus === 'pending');
    await expect(table.locator('tfoot')).toContainText(`${pending.length} invoices`);

    // 搜尋
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await page.getByLabel('Search invoices').fill('KPS/INV');
    const kps = computed.filter((i) => i.type === 'AP' && i.invoiceNumber.includes('KPS/INV'));
    await expect(table.locator('tfoot')).toContainText(`${kps.length} invoices`);
  });

  test('column sorting toggles direction', async ({ page }) => {
    await login(page, 'viewer');
    await page.getByRole('link', { name: 'Accounts Payable' }).click();
    const header = page.getByRole('button', { name: /^Outstanding/ });
    await header.click(); // 由小到大
    await header.click(); // 由大到小
    const first = await page.getByTestId('invoice-table').locator('tbody tr').first().locator('td').nth(8).textContent();
    const { computed } = expectedDashboard();
    const max = Math.max(...computed.filter((i) => i.type === 'AP').map((i) => i.outstandingBalance));
    expect(first).toBe(money(max));
  });
});

test.describe('Admin controls', () => {
  test('cancel requires a reason, is excluded from totals, and can be restored; delete works', async ({ page }) => {
    await login(page, 'admin');
    await page.getByRole('link', { name: 'Accounts Receivable' }).click();
    await page.getByTestId('new-invoice').click();
    await fillInvoiceForm(page, { number: 'INV-CANCEL-1', party: 'Test Customer Sdn Bhd', amount: '500' });
    await page.getByRole('dialog').getByTestId('save-invoice').click();
    await expect(page.getByRole('dialog')).toContainText('INV-CANCEL-1');
    const outstandingWith = await page.getByTestId('summary-outstanding').textContent();

    await page.getByRole('dialog').getByRole('button', { name: 'Cancel invoice' }).click();
    await page.getByRole('dialog').getByTestId('confirm-cancel').click();
    await expect(page.getByRole('dialog').getByText('Please give a reason for cancelling')).toBeVisible();
    await page.getByRole('dialog').getByLabel('Reason *').fill('Raised in error');
    await page.getByRole('dialog').getByTestId('confirm-cancel').click();
    await expect(page.getByRole('dialog')).toContainText('Cancelled: Raised in error');
    await expect(page.getByRole('dialog').getByTestId('detail-outstanding')).toHaveText('RM 0.00');
    const toNum = (s: string | null) => Number((s ?? '').replace(/[^0-9.]/g, ''));
    expect(toNum(outstandingWith) - toNum(await page.getByTestId('summary-outstanding').textContent())).toBeCloseTo(500, 2);

    await page.getByRole('dialog').getByRole('button', { name: 'Restore' }).click();
    await expect(page.getByRole('dialog').getByTestId('detail-outstanding')).toHaveText('RM 500.00');

    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('dialog').getByTestId('confirm-danger').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByLabel('Search invoices').fill('INV-CANCEL-1');
    await expect(page.getByText('No invoices match these filters')).toBeVisible();
  });

  test('reversing a payment restores the outstanding balance and is logged', async ({ page }) => {
    await login(page, 'admin');
    await page.goto('/ar?status=Paid');
    await page.getByTestId('invoice-table').locator('tbody tr').first().click();
    const dialog = page.getByRole('dialog');
    const total = await dialog.getByTestId('detail-total-amount').textContent();
    await expect(dialog.getByTestId('detail-outstanding')).toHaveText('RM 0.00');
    const rows = dialog.getByTestId('payments-table').locator('tbody tr');
    const count = await rows.count();
    const lastAmount = await rows.last().locator('td').nth(3).textContent();
    await rows.last().getByRole('button', { name: 'Reverse' }).click();
    await page.getByRole('dialog').getByTestId('confirm-danger').click();
    await expect(page.getByRole('dialog').getByTestId('payments-table').locator('tbody tr')).toHaveCount(count - 1);
    await expect(page.getByRole('dialog').getByTestId('detail-outstanding')).toHaveText(lastAmount!);
    await expect(page.getByRole('dialog')).toContainText(`Reversed collection of ${lastAmount}`);
    expect(total).toMatch(/^RM /);
  });

});

test.describe('Aging report', () => {
  test('bucket totals add up and equal outstanding; AP/AR toggle; CSV export', async ({ page }) => {
    const { dashboard: d } = expectedDashboard();
    await login(page, 'viewer');
    await page.getByRole('link', { name: 'Aging Report' }).click();
    await expect(page.getByTestId('aging-total')).toHaveText(money(d.AR.outstanding));
    const buckets = page.getByTestId('aging-buckets');
    for (const b of AGING_BUCKETS) await expect(buckets).toContainText(b.label);
    await page.getByRole('tab', { name: 'Payables (AP)' }).click();
    await expect(page.getByTestId('aging-total')).toHaveText(money(d.AP.outstanding));
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'CSV', exact: true }).click()]);
    expect(download.suggestedFilename()).toBe(`AP-aging-${today}.csv`);
    const csv = (await (await download.createReadStream()).toArray()).join('');
    expect(csv).toContain('Supplier,Current (MYR),1–30 days (MYR)');
    expect(csv.trim().split('\r\n').at(-1)).toContain('TOTAL');
  });

  test('dashboard aging snapshot matches the full report', async ({ page }) => {
    const { dashboard: d } = expectedDashboard();
    await login(page, 'viewer');
    await expect(page.getByTestId('aging-snapshot').locator('tfoot')).toContainText(money(d.AR.outstanding));
    await expect(page.getByTestId('aging-snapshot').locator('tfoot')).toContainText(money(d.AP.outstanding));
  });
});

test.describe('Authentication', () => {
  test('wrong password is rejected; sign-out returns to login; protected pages redirect', async ({ page }) => {
    await page.goto('/ap');
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel('Email').fill('admin@demo.my');
    await page.getByLabel('Password').fill('wrong');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText('Incorrect email or password');
    await page.getByLabel('Password').fill('demo1234');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByTestId('kpi-ar-outstanding')).toBeVisible();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login$/);
  });
});

/** 下載並讀取 Excel 檔。 */
async function readXlsx(download: import('@playwright/test').Download) {
  const chunks: Buffer[] = [];
  for await (const c of await download.createReadStream()) chunks.push(c as Buffer);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.concat(chunks) as unknown as ArrayBuffer);
  return wb;
}
const cellNum = (v: ExcelJS.CellValue) => (typeof v === 'object' && v && 'result' in v ? Number(v.result) : Number(v));

test.describe('Excel export', () => {
  test('full report from the dashboard has every sheet and matching figures', async ({ page }) => {
    const { dashboard: d } = expectedDashboard();
    await login(page, 'viewer');
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-full-report').click()]);
    expect(download.suggestedFilename()).toBe(`Finance-Report-${today}.xlsx`);
    const wb = await readXlsx(download);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Summary', 'AR Invoices', 'AP Invoices', 'Payments', 'AR Aging', 'AP Aging', 'Cash Flow Forecast']);
    const summary = wb.getWorksheet('Summary')!;
    let outstanding: ExcelJS.Row | undefined;
    summary.eachRow((r) => { if (r.getCell(1).value === 'Outstanding balance') outstanding = r; });
    expect(cellNum(outstanding!.getCell(2).value)).toBeCloseTo(d.AR.outstanding / 100, 2);
    expect(cellNum(outstanding!.getCell(3).value)).toBeCloseTo(d.AP.outstanding / 100, 2);
  });

  test('AP list export follows the current filter', async ({ page }) => {
    const { computed } = expectedDashboard();
    await login(page, 'viewer');
    await page.getByRole('link', { name: 'Accounts Payable' }).click();
    await page.getByLabel('Filter by payment status').selectOption('Overdue');
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-excel').click()]);
    const ws = (await readXlsx(download)).worksheets[0]!;
    const overdue = computed.filter((i) => i.type === 'AP' && i.status === 'Overdue');
    expect(ws.rowCount).toBe(overdue.length + 2);
    expect(cellNum(ws.getRow(ws.rowCount).getCell(10).value)).toBeCloseTo(overdue.reduce((t, i) => t + i.outstandingBalance, 0) / 100, 2);
  });

  test('aging export', async ({ page }) => {
    await login(page, 'viewer');
    await page.getByRole('link', { name: 'Aging Report' }).click();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-aging-excel').click()]);
    expect(download.suggestedFilename()).toBe(`AR-aging-${today}.xlsx`);
    expect((await readXlsx(download)).worksheets[0]!.name).toBe('AR Aging');
  });
});

test.describe('My data (saved in this browser)', () => {
  test('start fresh, enter real data, back up, restore', async ({ page }) => {
    await login(page, 'admin');
    await expect(page.getByTestId('sample-banner')).toBeVisible();

    // 1. 清除範例資料
    await page.getByRole('button', { name: 'Start with my own data…' }).click();
    await page.getByTestId('start-fresh').click();
    await page.getByTestId('confirm-data-action').click();
    await expect(page.getByTestId('sample-banner')).toHaveCount(0);
    await expect(kpi(page, 'kpi-ar-outstanding')).toHaveText('RM 0.00');

    // 2. 輸入真實資料 → 出現備份提醒
    await page.getByRole('link', { name: 'Accounts Receivable' }).click();
    await page.getByTestId('new-invoice').click();
    await fillInvoiceForm(page, { number: 'INV-0001', party: 'My First Customer Sdn Bhd', amount: '1500' });
    await page.getByRole('dialog').getByTestId('save-invoice').click();
    await expect(page.getByRole('dialog')).toContainText('INV-0001');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('backup-banner')).toBeVisible();

    // 3. 下載備份 → 提醒消失
    const [backup] = await Promise.all([page.waitForEvent('download'), page.getByTestId('backup-banner').getByRole('button', { name: 'Download backup' }).click()]);
    expect(backup.suggestedFilename()).toBe(`invoice-backup-${today}.json`);
    const backupPath = await backup.path();
    await expect(page.getByTestId('backup-banner')).toHaveCount(0);

    // 4. 刪除全部 → 由備份還原
    await page.getByTestId('open-data-manager').click();
    await page.getByTestId('start-fresh').click();
    await page.getByTestId('confirm-data-action').click();
    await expect(page.getByText('No accounts receivable invoices yet')).toBeVisible();
    await page.getByTestId('open-data-manager').click();
    await page.getByTestId('restore-input').setInputFiles(backupPath);
    await page.getByTestId('confirm-data-action').click();
    await expect(page.getByText('Backup restored')).toBeVisible();
    await expect(page.getByTestId('invoice-table')).toContainText('INV-0001');

    // 5. 重新整理頁面後資料仍在
    await page.reload();
    await expect(page.getByTestId('invoice-table')).toContainText('INV-0001');
  });
});

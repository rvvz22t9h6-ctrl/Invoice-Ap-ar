/**
 * 新財務功能端對端測試：聯絡資料與付款期限、對帳單、催款信、現金流、批次付款與審批、折讓與沖銷、公司設定。
 */
import ExcelJS from 'exceljs';
import { expect, test, type Download } from '@playwright/test';
import { addDays } from '../src/domain/dates';
import { buildCashFlowForecast } from '../src/domain/cashflow';
import { expectedDashboard, fillInvoiceForm, kpi, login, money, today, openNav } from './helpers';

async function readXlsx(download: Download) {
  const chunks: Buffer[] = [];
  for await (const c of await download.createReadStream()) chunks.push(c as Buffer);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.concat(chunks) as unknown as ArrayBuffer);
  return wb;
}

test('contact payment terms set the due date on new invoices; statement and reminder', async ({ page }) => {
  await login(page, 'finance');
  await openNav(page, 'Suppliers & Customers');
  await page.getByLabel('Search contacts').fill('Puncak');
  await page.getByTestId('contacts-table').locator('tbody tr').first().click();
  const dlg = page.getByRole('dialog');
  await expect(dlg).toContainText('Puncak Healthcare Sdn Bhd');

  // 對帳單：期末餘額 = 期初 + 借方 − 貸方；匯出 Excel
  await expect(dlg.getByTestId('statement-lines')).toContainText('Balance brought forward');
  const [stmt] = await Promise.all([page.waitForEvent('download'), dlg.getByTestId('export-statement').click()]);
  const ws = (await readXlsx(stmt)).getWorksheet('Statement')!;
  expect(ws.getCell('A2').value).toBe('STATEMENT OF ACCOUNT');

  // 催款信
  await dlg.getByTestId('tab-reminder').click();
  await expect(dlg.getByTestId('reminder-text')).toHaveValue(/Payment reminder: RM [\d,.]+ overdue – Sample Trading Sdn Bhd[\s\S]*Dear Puncak Healthcare Sdn Bhd Accounts Team/);

  // 設定付款期限 45 天
  await dlg.getByTestId('tab-details').click();
  await dlg.getByLabel('Contact person').fill('Ms Aisyah');
  await dlg.getByLabel('Payment terms (days)').fill('45');
  await dlg.getByTestId('save-contact').click();
  await expect(page.getByText('Contact details saved')).toBeVisible();
  await page.keyboard.press('Escape');

  // 新增發票時選擇此客戶 → 到期日自動 = 發票日 + 45 天
  await openNav(page, 'Accounts Receivable');
  await page.getByTestId('new-invoice').click();
  await page.getByRole('dialog').getByLabel('Customer Name *').fill('Puncak Healthcare Sdn Bhd');
  await expect(page.getByRole('dialog').getByLabel('Due Date *')).toHaveValue(addDays(today, 45));
});

test('credit note and write-off settle invoices without counting as cash', async ({ page }) => {
  const { dashboard: d } = expectedDashboard();
  await login(page, 'admin');
  await openNav(page, 'Accounts Receivable');
  await page.getByTestId('new-invoice').click();
  await fillInvoiceForm(page, { number: 'CN-TEST-1', party: 'Credit Test Sdn Bhd', amount: '1000' });
  await page.getByRole('dialog').getByTestId('save-invoice').click();
  await page.getByRole('dialog').getByTestId('record-payment').click();
  await page.getByRole('dialog').getByTestId('kind-credit_note').click();
  await expect(page.getByRole('dialog').getByLabel('Payment Method *')).toHaveCount(0);
  await page.getByRole('dialog').getByLabel('Amount (RM) *').fill('200');
  await page.getByRole('dialog').getByLabel('Credit note number').fill('CN-0012');
  await page.getByRole('dialog').getByTestId('save-payment').click();
  await expect(page.getByRole('dialog').getByTestId('detail-outstanding')).toHaveText('RM 800.00');
  await page.getByRole('dialog').getByTestId('record-payment').click();
  await page.getByRole('dialog').getByTestId('kind-write_off').click();
  await page.getByRole('dialog').getByTestId('save-payment').click();
  const detail = page.getByRole('dialog');
  await expect(detail.getByTestId('detail-outstanding')).toHaveText('RM 0.00');
  await expect(detail.getByTestId('payments-table')).toContainText('Credit note');
  await expect(detail.getByTestId('payments-table')).toContainText('Write-off (bad debt)');
  await page.keyboard.press('Escape');
  await openNav(page, 'Finance Overview');
  await expect(kpi(page, 'kpi-ar-collected')).toHaveText(money(d.AR.settled)); // 現金不變
  await expect(page.getByTestId('metrics')).toContainText('RM 800.00'); // 沖銷金額
});

test('AP payment run and bulk approval', async ({ page }) => {
  await login(page, 'admin');
  await openNav(page, 'Accounts Payable');
  await page.getByLabel('Filter by approval status').selectOption('pending');
  const pendingRows = page.getByTestId('invoice-table').locator('tbody tr');
  const nPending = await pendingRows.count();
  expect(nPending).toBeGreaterThan(0);
  await page.getByTestId('select-all').check();
  await page.getByTestId('bulk-approve').click();
  await expect(page.getByText(`${nPending} bill${nPending === 1 ? '' : 's'} approved`)).toBeVisible();
  await expect(page.getByText('No invoices match these filters')).toBeVisible();

  await page.getByRole('button', { name: 'Clear filters' }).click();
  await page.getByLabel('Filter by payment status').selectOption('Overdue');
  const boxes = page.getByTestId('select-row');
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  await page.getByTestId('bulk-pay').click();
  const total = await page.getByTestId('payment-run-total').textContent();
  await page.getByRole('dialog').getByLabel('Reference').fill('BATCH-NOV');
  await page.getByTestId('confirm-payment-run').click();
  await expect(page.getByText(`2 bills paid, ${total} in total`)).toBeVisible();
  await expect(page.getByTestId('bulk-bar')).toHaveCount(0);
});

test('cash flow forecast follows the bank balance; settings change the company name', async ({ page }) => {
  const { computed } = expectedDashboard();
  await login(page, 'admin');
  await openNav(page, 'Company Settings');
  await page.getByLabel('Company name').fill('Carrie Trading Sdn Bhd');
  await page.getByTestId('save-settings').click();
  await expect(page.getByTestId('company-name')).toHaveText('Carrie Trading Sdn Bhd');
  await page.getByLabel('Balance in all company bank accounts (RM)').fill('250000');
  await page.getByLabel('As of date').fill(today);
  await page.getByTestId('save-balance').click();
  await expect(page.getByText('Bank balance saved')).toBeVisible();

  await openNav(page, 'Cash Flow');
  const f = buildCashFlowForecast(computed, today, { openingBalance: 25_000_000, openingBalanceDate: today });
  await expect(kpi(page, 'cf-current')).toHaveText('RM 250,000.00');
  await expect(kpi(page, 'cf-in')).toHaveText(money(f.totals.inflow));
  await expect(kpi(page, 'cf-end')).toHaveText(money(f.rows.at(-1)!.closing));
  await expect(page.getByTestId('cashflow-table').locator('tbody tr')).toHaveCount(14);
  const [x] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-cashflow').click()]);
  const sheet = (await readXlsx(x)).getWorksheet('Cash Flow Forecast')!;
  expect(String(sheet.getCell('A1').value)).toContain('Carrie Trading Sdn Bhd');
});

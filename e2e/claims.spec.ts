/**
 * 員工報銷：新增 → 核准 → 付款、里程計算、退回、刪除、批次、匯出、唯讀權限。
 */
import { expect, test, type Page } from '@playwright/test';
import { login, openNav, today } from './helpers';

async function openClaims(page: Page, who: 'admin' | 'viewer' = 'admin') {
  await login(page, who);
  await openNav(page, 'Staff Claims');
  await expect(page.getByTestId('claims-table')).toBeVisible();
}
const row = (page: Page, text: string) => page.getByTestId('claims-table').locator('tbody tr').filter({ hasText: text });

test('add a claim, approve it, pay it with salary; it persists after reload', async ({ page }) => {
  await openClaims(page);
  await expect(page.getByTestId('claims-kpi-approve-value')).toHaveText('RM 454.00'); // 範例：3 筆待核准
  await page.getByTestId('new-claim').click();
  await page.getByTestId('save-claim').click();
  await expect(page.getByRole('dialog')).toContainText('Enter the staff name');
  await page.getByTestId('claim-staff').fill('Nadia Rahman');
  await page.getByTestId('claim-category').selectOption('Parking & Toll');
  await page.getByTestId('claim-amount').fill('18.40');
  await page.getByTestId('claim-description').fill('Parking at client office');
  await page.getByTestId('claim-has-receipt').check();
  await page.getByTestId('save-claim').click();
  await expect(page.getByText(/Added CL-\d{4}-\d{3} for Nadia Rahman/)).toBeVisible();
  await expect(page.getByTestId('claims-kpi-approve-value')).toHaveText('RM 472.40');

  await row(page, 'Nadia Rahman').getByTestId('claim-approve').click();
  await expect(row(page, 'Nadia Rahman')).toHaveCount(0); // 移到「To pay」
  await page.getByTestId('claims-tab-approved').click();
  await expect(row(page, 'Nadia Rahman').getByTestId('claim-status')).toHaveText('Approved · to pay');
  await expect(page.getByTestId('to-pay-by-staff')).toContainText('Nadia Rahman');

  await row(page, 'Nadia Rahman').getByTestId('claim-pay').click();
  await expect(page.getByTestId('pay-method')).toHaveValue('With salary');
  await expect(page.getByTestId('pay-ref')).toHaveValue(/salary/);
  await page.getByTestId('confirm-pay').click();
  await page.getByTestId('claims-tab-paid').click();
  await expect(row(page, 'Nadia Rahman')).toContainText('With salary');

  await page.reload();
  await openNav(page, 'Staff Claims');
  await page.getByTestId('claims-tab-paid').click();
  await expect(row(page, 'Nadia Rahman').getByTestId('claim-status')).toHaveText('✓ Paid');
  // 復原付款 → 回到待付款
  await row(page, 'Nadia Rahman').getByTestId('claim-undo').click();
  await page.getByTestId('claims-tab-approved').click();
  await expect(row(page, 'Nadia Rahman')).toBeVisible();
});

test('mileage is calculated, checks are flagged, reject needs a reason, delete has a quick confirm', async ({ page }) => {
  await openClaims(page);
  await page.getByTestId('new-claim').click();
  await page.getByTestId('claim-staff').fill('Ahmad Faizal'); // 從已有名字自動提示
  await page.getByTestId('claim-category').selectOption('Mileage');
  await expect(page.getByTestId('claim-amount')).toHaveCount(0);
  await page.getByTestId('claim-km').fill('85');
  await expect(page.getByTestId('claim-rate')).toHaveValue('0.60');
  await expect(page.getByTestId('mileage-preview')).toContainText('RM 51.00');
  await page.getByTestId('claim-description').fill('Office to Seremban supplier, return');
  await page.getByTestId('save-claim').click();
  await expect(row(page, 'Seremban')).toContainText('85 km × RM 0.60');
  await expect(row(page, 'Seremban')).toContainText('RM 51.00');

  // 範例：Kumar 的碳粉沒有收據 → 提示
  await expect(row(page, 'Printer toner').getByTestId('claim-flag')).toHaveText('! No receipt');
  await row(page, 'Printer toner').getByTestId('claim-reject').click();
  await page.getByTestId('confirm-reject').click();
  await expect(page.getByRole('dialog')).toContainText('Enter a reason');
  await page.getByTestId('reject-reason').fill('Please attach the toner receipt');
  await page.getByTestId('confirm-reject').click();
  await page.getByTestId('claims-tab-rejected').click();
  await expect(row(page, 'Printer toner')).toContainText('Reason: Please attach the toner receipt');

  await page.getByTestId('claims-tab-submitted').click();
  const r = row(page, 'Seremban');
  await r.getByTestId('claim-delete').click();
  await r.getByRole('button', { name: 'No' }).click();
  await expect(r).toBeVisible();
  await r.getByTestId('claim-delete').click();
  await r.getByTestId('claim-delete-yes').click();
  await expect(r).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('bulk approve, pay all with salary, edit, and export to Excel', async ({ page }) => {
  await openClaims(page);
  await page.getByTestId('select-all').check();
  await expect(page.getByTestId('claims-bulk')).toContainText('3 selected · RM 454.00');
  await page.getByTestId('bulk-approve').click();
  await expect(page.getByText('Approved 3 claims')).toBeVisible();
  await expect(page.getByTestId('claims-kpi-approve-value')).toHaveText('RM 0.00');
  await expect(page.getByTestId('claims-kpi-pay-value')).toHaveText('RM 663.50'); // 209.50 + 454.00

  // 點一列可編輯
  await page.getByTestId('claims-tab-approved').click();
  await row(page, 'Clinic visit').locator('td').nth(2).click();
  await page.getByTestId('claim-remarks').fill('MC attached');
  await page.getByTestId('save-claim').click();
  await expect(row(page, 'Clinic visit')).toContainText('✎ MC attached');

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('claims-export').click()]);
  expect(download.suggestedFilename()).toBe(`Staff-Claims-${today}.xlsx`);

  await page.getByTestId('pay-all').click();
  await expect(page.getByRole('dialog')).toContainText('to 4 staff');
  await page.getByTestId('confirm-pay').click();
  await expect(page.getByText(/Marked \d+ claims paid/)).toBeVisible();
  await expect(page.getByTestId('claims-kpi-pay-value')).toHaveText('RM 0.00');
  await expect(page.getByTestId('to-pay-by-staff')).toHaveCount(0);
});

test('dashboard and payroll show claims waiting; the boss can view but not change', async ({ page }) => {
  await login(page, 'admin');
  await expect(page.getByTestId('strip-claims')).toContainText('RM 209.50');
  await expect(page.getByTestId('strip-claims')).toContainText('3 to approve');
  await openNav(page, 'Payroll');
  await expect(page.getByTestId('payroll-claims')).toContainText('RM 209.50 approved for 2 staff');
  await page.getByTestId('payroll-claims').click();
  await expect(page.getByRole('heading', { name: 'Staff Claims' })).toBeVisible();

  await openClaims(page, 'viewer');
  await expect(page.getByTestId('new-claim')).toHaveCount(0);
  await expect(page.getByTestId('claim-approve')).toHaveCount(0);
  await expect(page.getByTestId('claim-delete')).toHaveCount(0);
  await expect(page.getByTestId('claims-export')).toBeEnabled();
});

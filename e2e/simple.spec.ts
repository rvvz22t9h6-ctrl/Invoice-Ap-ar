/**
 * 簡化版功能：薪資與月結檢查清單、發票備註、簡化側邊欄、提醒頁的逾期追蹤。
 */
import { expect, test } from '@playwright/test';
import { fillInvoiceForm, login, openNav } from './helpers';

test('sidebar shows only the essential modules; the rest is under More', async ({ page }) => {
  await login(page, 'admin');
  const nav = page.getByRole('navigation', { name: 'Main' });
  for (const name of ['Dashboard', 'Accounts Payable', 'Accounts Receivable', 'Payroll', 'Monthly Closing', 'Reminders']) {
    await expect(nav.getByRole('link', { name, exact: true })).toBeVisible();
  }
  await expect(nav.getByRole('link', { name: 'Cash Flow', exact: true })).toHaveCount(0);
  await page.getByTestId('nav-more').click();
  await expect(nav.getByRole('link', { name: 'Cash Flow', exact: true })).toBeVisible();
  await expect(page.getByTestId('month-strip')).toContainText('Payroll');
});

test('payroll checklist: one-click ticks, salary payment, notes and remarks persist', async ({ page }) => {
  await login(page, 'admin');
  await openNav(page, 'Payroll');
  await expect(page.getByTestId('checklist-month')).toHaveText(/\w+ \d{4}/);
  await expect(page.getByTestId('checklist-pct')).toHaveText('0%');
  const item = (label: string) => page.getByTestId('checklist-item').filter({ hasText: label });
  await item('Verify attendance records').getByTestId('checklist-check').click();
  await item('Verify overtime hours').getByTestId('checklist-check').click();
  await item('Verify EPF (KWSP)').getByTestId('checklist-check').click();
  await expect(page.getByTestId('checklist-pct')).toHaveText('27%'); // 3 / 11
  await item('Verify SOCSO').getByRole('button', { name: 'Add note' }).click();
  await page.getByLabel('Note for Verify SOCSO (PERKESO) contributions').fill('2 new joiners registered');
  await page.keyboard.press('Enter');
  await expect(item('Verify SOCSO')).toContainText('2 new joiners registered');
  await page.getByTestId('mark-paid').click();
  await expect(page.getByTestId('salary-status')).toContainText('Paid');
  await page.getByTestId('month-remarks').fill('Bonus paid separately on 30th');
  await page.getByTestId('checklist-pct').click(); // 點擊外面以儲存
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();

  await page.reload();
  await expect(page.getByTestId('checklist-pct')).toHaveText('36%'); // 4 / 11（含薪資已付）
  await expect(item('Verify SOCSO')).toContainText('2 new joiners registered');
  await expect(page.getByTestId('month-remarks')).toHaveValue('Bonus paid separately on 30th');
  await expect(page.getByTestId('checklist-history')).toContainText('36%');
  await page.getByTestId('mark-all').click();
  await expect(page.getByTestId('checklist-pct')).toHaveText('100%');
  await expect(page.getByText('✓ Completed').first()).toBeVisible();

  // 儀表板顯示本月薪資進度
  await openNav(page, 'Dashboard');
  await expect(page.getByTestId('strip-payroll')).toContainText('100%');
});

test('monthly closing: tick steps, add and remove a custom step, previous month', async ({ page }) => {
  await login(page, 'finance');
  await openNav(page, 'Monthly Closing');
  await expect(page.getByTestId('checklist-item').first()).toBeVisible();
  const before = await page.getByTestId('checklist-item').count();
  await page.getByTestId('checklist-item').filter({ hasText: 'Bank reconciliation done' }).getByTestId('checklist-check').click();
  await page.getByTestId('add-item').fill('Confirm intercompany balances');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByTestId('checklist-item')).toHaveCount(before + 1);
  const pct = Math.round((1 / (before + 1)) * 100);
  await expect(page.getByTestId('checklist-pct')).toHaveText(`${pct}%`);
  await page.getByRole('button', { name: 'Remove Confirm intercompany balances' }).click();
  await expect(page.getByTestId('checklist-item')).toHaveCount(before);
  const month = await page.getByTestId('checklist-month').textContent();
  await page.getByRole('button', { name: 'Previous month' }).click();
  await expect(page.getByTestId('checklist-month')).not.toHaveText(month!);
  await expect(page.getByTestId('checklist-pct')).toHaveText('0%');
  await expect(page.getByText(/Overdue|Pending/).first()).toBeVisible();
});

test('viewer can see checklists but not change them', async ({ page }) => {
  await login(page, 'viewer');
  await openNav(page, 'Payroll');
  await expect(page.getByTestId('checklist-check').first()).toBeDisabled();
  await expect(page.getByTestId('mark-paid')).toHaveCount(0);
});

test('invoice remarks: saved, shown in the list and detail, searchable', async ({ page }) => {
  await login(page, 'finance');
  await openNav(page, 'Accounts Receivable');
  await page.getByTestId('new-invoice').click();
  await fillInvoiceForm(page, { number: 'REM-001', party: 'Remarks Test Sdn Bhd', amount: '500' });
  await page.getByRole('dialog').getByLabel('Remarks').fill('Customer promised payment on Friday');
  await page.getByRole('dialog').getByTestId('save-invoice').click();
  await expect(page.getByRole('dialog').getByTestId('detail-remarks')).toHaveText('Customer promised payment on Friday');
  await page.keyboard.press('Escape');
  await page.getByLabel('Search invoices').fill('promised payment');
  await expect(page.getByTestId('invoice-table').locator('tbody tr')).toHaveCount(1);
  await expect(page.getByTestId('invoice-table')).toContainText('✎ Customer promised payment on Friday');
});

test('reminders page tracks overdue tasks and completes them in one click', async ({ page }) => {
  await login(page, 'admin');
  await openNav(page, 'Reminders');
  const list = page.getByTestId('overdue-list').getByTestId('task-item');
  await expect(list.first()).toBeVisible();
  const n = await list.count();
  expect(n).toBeGreaterThan(0);
  await list.first().getByTestId('task-check').click();
  await expect(page.getByTestId('overdue-list').getByTestId('task-item')).toHaveCount(n - 1);
  await expect(page.getByTestId('rule-list')).toContainText('Every week on Mon');
});

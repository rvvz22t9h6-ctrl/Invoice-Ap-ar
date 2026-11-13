/**
 * 催款跟進紀錄與給主管的每週摘要。
 */
import { expect, test } from '@playwright/test';
import { addDays, formatDate } from '../src/domain/dates';
import { expectedDashboard, login, openFinance, openNav, today } from './helpers';

test('record a follow-up with a promise and a reminder; it shows on the list, in tasks and in the weekly summary', async ({ page }) => {
  await login(page, 'admin');
  const inv = expectedDashboard().computed.filter((i) => i.type === 'AR' && i.isOverdue).sort((a, b) => b.outstandingBalance - a.outstandingBalance)[0]!;
  await page.getByTestId('search-open').click();
  await page.getByTestId('search-input').fill(inv.invoiceNumber);
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(inv.invoiceNumber);

  await dialog.getByTestId('add-followup').click();
  await dialog.getByTestId('save-followup').click();
  await expect(dialog.getByTestId('followup-form')).toContainText('Write what was said');
  await dialog.getByTestId('fu-contact').fill('Puan Aida');
  await dialog.getByTestId('fu-note').fill('Cheque is with the director for signing');
  await dialog.getByTestId('fu-promised').fill(addDays(today, 3));
  await dialog.getByTestId('fu-next').fill(addDays(today, 2));
  await dialog.getByTestId('save-followup').click();
  await expect(page.getByText(`Follow-up saved. Reminder set for ${formatDate(addDays(today, 2))}`)).toBeVisible();
  await expect(dialog.getByTestId('followup-list')).toContainText('Cheque is with the director for signing');
  await expect(dialog.getByTestId('followup-list')).toContainText(`Promised ${formatDate(addDays(today, 3))}`);
  await page.keyboard.press('Escape');

  // 清單上顯示「Promised …」
  await page.getByLabel('Search invoices').fill(inv.invoiceNumber);
  await expect(page.getByTestId('invoice-table').getByTestId('promise-tag')).toHaveText(`Promised ${formatDate(addDays(today, 3))}`);

  // 自動建立的提醒任務
  await openNav(page, 'All Tasks');
  await page.getByLabel('Search tasks').fill(inv.invoiceNumber);
  await expect(page.getByTestId('task-table')).toContainText(`Follow up ${inv.counterpartyName} on ${inv.invoiceNumber}`);

  // 每週摘要
  await openFinance(page);
  await page.getByTestId('weekly-summary').click();
  const text = page.getByTestId('summary-text');
  await expect(text).toHaveValue(/Weekly finance summary/);
  await expect(text).toHaveValue(/This week[\s\S]*Collected from customers: RM [\d,.]+ \(\d+ payments?\)/);
  await expect(text).toHaveValue(new RegExp(`Customers who promised to pay[\\s\\S]*${inv.invoiceNumber}`));
  await expect(text).toHaveValue(/Largest overdue customers\*\n1\. /);
  await expect(text).toHaveValue(/Next 7 days/);
  const thisWeek = await text.inputValue();
  await page.getByTestId('summary-week--1').click();
  await expect(text).not.toHaveValue(thisWeek);
  await page.getByTestId('summary-copy').click();
  await expect(page.getByText(/Summary copied|The text is selected/)).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('summary-excel').click()]);
  expect(download.suggestedFilename()).toMatch(/^Weekly-Summary-\d{4}-\d{2}-\d{2}\.xlsx$/);
});

test('the boss sees follow-ups and the weekly summary but cannot add follow-ups', async ({ page }) => {
  await login(page, 'viewer');
  const inv = expectedDashboard().computed.filter((i) => i.type === 'AR' && i.isOverdue)[0]!;
  await page.getByTestId('search-open').click();
  await page.getByTestId('search-input').fill(inv.invoiceNumber);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toContainText(inv.invoiceNumber);
  await expect(page.getByTestId('add-followup')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await openFinance(page);
  await page.getByTestId('weekly-summary').click();
  await expect(page.getByTestId('summary-text')).toHaveValue(/Position as of/);
});

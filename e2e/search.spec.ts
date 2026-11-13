/**
 * 全域搜尋：以號碼、名稱、金額或任何字詞搜尋，並直接開啟結果。
 */
import { expect, test, type Page } from '@playwright/test';
import { expectedDashboard, login, openNav } from './helpers';

const hits = (page: Page) => page.getByTestId('search-hit');
const type = async (page: Page, text: string) => { await page.getByTestId('search-input').fill(text); };

test('find an invoice by number or amount and open it; keyboard shortcuts work', async ({ page }) => {
  await login(page, 'admin');
  const inv = expectedDashboard().computed.find((i) => i.type === 'AR' && !i.isCancelled && i.totalAmount >= 100_000)!;
  await page.getByTestId('search-open').click();
  await expect(page.getByTestId('search-results')).toContainText('Type at least 2 characters');
  await type(page, inv.invoiceNumber);
  await expect(hits(page).first()).toContainText(inv.invoiceNumber);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('search-dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Accounts Receivable' })).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText(inv.invoiceNumber); // 發票明細已開啟
  await page.keyboard.press('Escape');

  // Ctrl+K，以金額搜尋（含千分位逗號）
  await page.keyboard.press('Control+k');
  await type(page, (inv.totalAmount / 100).toLocaleString('en-MY', { minimumFractionDigits: 2 }));
  await expect(page.getByTestId('search-results')).toContainText(inv.invoiceNumber);
  await type(page, 'zzzz-not-there');
  await expect(page.getByTestId('search-none')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('search-dialog')).toHaveCount(0);
});

test('find claims, tasks, notes, contacts and pages', async ({ page }) => {
  await login(page, 'admin');
  // 先寫一則筆記
  await openNav(page, 'Notes');
  await page.getByTestId('new-note').click();
  await page.getByTestId('note-title').fill('How to pay Supplier ABC');
  await page.getByTestId('note-body').fill('Cheque only. Call Ms Lim.');
  await page.getByTestId('save-note').click();
  await expect(page.getByTestId('note-card')).toHaveCount(1);
  await expect(page.getByRole('dialog')).toHaveCount(0); // 等筆記視窗關閉

  // 「/」開啟；報銷
  await page.keyboard.press('/');
  await type(page, 'printer toner');
  await hits(page).filter({ hasText: 'Kumar Raj' }).click();
  await expect(page.getByRole('heading', { name: 'Staff Claims' })).toBeVisible();
  await expect(page.getByTestId('claims-table').locator('tbody tr')).toHaveCount(1);
  await expect(page.getByTestId('claims-table')).toContainText('Printer toner');

  // 任務
  await page.getByTestId('search-open').click();
  await type(page, 'insurance');
  await hits(page).first().click();
  await expect(page.getByRole('dialog')).toContainText('Edit task');
  await expect(page.getByLabel('Task title *')).toHaveValue('Renew company insurance policy');
  await page.keyboard.press('Escape');

  // 筆記（搜尋內文）
  await page.getByTestId('search-open').click();
  await type(page, 'ms lim');
  await hits(page).first().click();
  await expect(page.getByTestId('note-body')).toHaveValue('Cheque only. Call Ms Lim.');
  await page.keyboard.press('Escape');

  // 供應商／客戶
  await page.getByTestId('search-open').click();
  await type(page, 'gemilang');
  await page.getByTestId('search-results').locator('section').filter({ hasText: 'Suppliers & customers' }).getByTestId('search-hit').first().click();
  await expect(page.getByRole('dialog')).toContainText('Gemilang Retail');
  await page.keyboard.press('Escape');

  // 頁面
  await page.getByTestId('search-open').click();
  await type(page, 'aging');
  await hits(page).filter({ hasText: 'Aging Report' }).click();
  await expect(page.getByRole('heading', { name: 'Aging Report' })).toBeVisible();
});

test('the boss can search, but never sees private notes', async ({ page }) => {
  await login(page, 'admin');
  await openNav(page, 'Notes');
  await page.getByTestId('new-note').click();
  await page.getByTestId('note-title').fill('Secret salary remark');
  await page.getByTestId('save-note').click();
  await expect(page.getByTestId('note-card')).toHaveCount(1);
  await login(page, 'viewer');
  await page.getByTestId('search-open').click();
  await type(page, 'secret salary');
  await expect(page.getByTestId('search-none')).toBeVisible();
  await type(page, 'siti hajar');
  await expect(hits(page).first()).toContainText('Siti Hajar');
});

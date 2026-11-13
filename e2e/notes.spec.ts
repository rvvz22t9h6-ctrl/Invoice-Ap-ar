/**
 * 私人筆記：新增、搜尋、類別、釘選、編輯、刪除；檢視者看不到。
 */
import { expect, test } from '@playwright/test';
import { login, openNav } from './helpers';

test('write, search, pin, edit and delete notes; they persist after reload', async ({ page }) => {
  await login(page, 'admin');
  await openNav(page, 'Notes');
  await expect(page.getByTestId('notes-empty')).toContainText('No notes yet');
  await page.getByTestId('new-note').click();
  await page.getByTestId('save-note').click();
  await expect(page.getByRole('dialog')).toContainText('Write a title or some text');
  await page.getByTestId('note-title').fill('How to pay Supplier ABC');
  await page.getByTestId('note-body').fill('Cheque only.\nCall Ms Lim before sending.\nNeeds 2 signatures.');
  await page.getByTestId('note-category').selectOption('AP');
  await page.getByTestId('save-note').click();
  await expect(page.getByText('Note added')).toBeVisible();

  // 第二則：沒有標題 → 以第一行當標題
  await page.getByTestId('new-note').click();
  await page.getByTestId('note-body').fill('EPF login is under the company secretary\nForm A upload by the 15th');
  await page.getByTestId('note-category').selectOption('Payroll');
  await page.getByTestId('save-note').click();
  const cards = page.getByTestId('note-card');
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toContainText('EPF login is under the company secretary'); // 最新的在前

  // 搜尋內文、類別篩選
  await page.getByTestId('notes-search').fill('ms lim cheque');
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('How to pay Supplier ABC');
  await page.getByTestId('notes-search').fill('');
  await page.getByTestId('notes-cat-Payroll').click();
  await expect(cards).toHaveCount(1);
  await page.getByTestId('notes-cat-all').click();

  // 釘選 → 排到最前；不會打開編輯視窗
  await cards.filter({ hasText: 'Supplier ABC' }).getByTestId('note-pin').click();
  await expect(cards.first()).toContainText('How to pay Supplier ABC');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // 編輯
  await cards.first().click();
  await page.getByTestId('note-body').fill('Cheque only. Bank in by Thursday.');
  await page.getByTestId('save-note').click();
  await expect(cards.first()).toContainText('Bank in by Thursday');

  await page.reload();
  await openNav(page, 'Notes');
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toContainText('Bank in by Thursday');

  // 刪除（兩步確認）
  await cards.filter({ hasText: 'EPF login' }).click();
  await page.getByTestId('note-delete').click();
  await page.getByTestId('note-delete-yes').click();
  await expect(cards).toHaveCount(1);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('notes-export').click()]);
  expect(download.suggestedFilename()).toMatch(/^my-notes-.*\.txt$/);
});

test('the boss (view-only) has no Notes page', async ({ page }) => {
  await login(page, 'admin');
  await openNav(page, 'Notes');
  await page.getByTestId('new-note').click();
  await page.getByTestId('note-title').fill('Private thought');
  await page.getByTestId('save-note').click();
  await expect(page.getByTestId('note-card')).toHaveCount(1);
  await login(page, 'viewer');
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Notes', exact: true })).toHaveCount(0);
  await page.goto('/notes');
  await expect(page.getByText('not available in view-only access')).toBeVisible();
  await expect(page.getByText('Private thought')).toHaveCount(0);
});

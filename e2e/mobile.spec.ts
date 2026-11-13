/**
 * 手機版端對端測試：選單開合、頁面切換、表格不超出畫面寬度。
 */
import { expect, test } from '@playwright/test';
import { login, openNav } from './helpers';

test('mobile navigation and layout', async ({ page }) => {
  await login(page, 'viewer');
  const noHorizontalScroll = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  expect(await noHorizontalScroll()).toBe(true);

  await page.getByRole('button', { name: 'Open menu' }).click();
  await openNav(page, 'Accounts Receivable');
  await expect(page.getByRole('heading', { name: 'Accounts Receivable' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Dashboard', exact: true })).toBeHidden(); // 選單已自動關閉
  expect(await noHorizontalScroll()).toBe(true);

  await page.getByTestId('invoice-table').locator('tbody tr').first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).first().click();

  await page.getByRole('button', { name: 'Open menu' }).click();
  await openNav(page, 'Aging Report');
  await expect(page.getByRole('heading', { name: 'Invoice Aging Report' })).toBeVisible();
  expect(await noHorizontalScroll()).toBe(true);
});

test('staff claims on a phone: cards with amount and one-tap approve', async ({ page }) => {
  await login(page, 'admin');
  await page.getByRole('button', { name: 'Open menu' }).click();
  await openNav(page, 'Staff Claims');
  const card = page.getByTestId('claim-card').filter({ hasText: 'Kumar Raj' });
  await expect(card).toContainText('RM 329.00');
  await card.scrollIntoViewIfNeeded();
  const box = (await card.getByTestId('claim-approve').boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width); // 按鈕完整顯示，沒有被擠出畫面
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await card.getByTestId('claim-approve').click();
  await expect(page.getByText(/Approved CL-/)).toBeVisible();
  await expect(card).toHaveCount(0);
  await page.getByTestId('new-claim').click();
  await expect(page.getByTestId('claim-staff')).toBeVisible();
});

test('phone bottom bar: tabs and the + button open the right form on the spot', async ({ page }) => {
  await login(page, 'admin');
  await expect(page.getByTestId('mobile-bar')).toBeVisible();
  // ＋ → 員工報銷：切到報銷頁並直接開啟表單
  await page.getByTestId('quick-record').click();
  await page.getByTestId('quick-claim').click();
  await expect(page.getByRole('heading', { name: 'New staff claim' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('heading', { name: 'Staff Claims' })).toBeVisible();
  // 已在報銷頁時再按一次也會開啟
  await page.getByTestId('quick-record').click();
  await page.getByTestId('quick-claim').click();
  await expect(page.getByTestId('claim-staff')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  // ＋ → 任務
  await page.getByTestId('quick-record').click();
  await page.getByTestId('quick-task').click();
  await expect(page.getByRole('heading', { name: 'New task' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  // ＋ → 供應商帳單
  await page.getByTestId('quick-record').click();
  await page.getByTestId('quick-ap').click();
  await expect(page.getByRole('dialog')).toContainText(/supplier/i);
  await page.keyboard.press('Escape');
  // 分頁切換
  await page.getByTestId('tab-receivable').click();
  await expect(page.getByRole('heading', { name: 'Accounts Receivable' })).toBeVisible();
  await page.getByTestId('tab-home').click();
  await expect(page.getByTestId('task-kpi-today')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test('the boss (read-only) gets the tabs but no + button', async ({ page }) => {
  await login(page, 'viewer');
  await expect(page.getByTestId('tab-claims')).toBeVisible();
  await expect(page.getByTestId('quick-record')).toHaveCount(0);
});

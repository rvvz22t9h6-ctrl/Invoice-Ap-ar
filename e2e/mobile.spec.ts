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

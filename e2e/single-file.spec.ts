/**
 * 單一 HTML 檔版本測試：直接以 file:// 開啟（模擬使用者雙擊檔案），
 * 驗證登入、頁面切換、新增資料、重新開啟後資料仍在、Excel 匯出與備份。
 * 需先執行 npm run build:file。
 */
import { expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fillInvoiceForm } from './helpers';

const file = resolve('dist-file/InvoiceTracker.html');
const url = pathToFileURL(file).href;

test.skip(!existsSync(file), 'Run "npm run build:file" first');

test('works when opened directly from disk', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.getByRole('button', { name: /Mei Ling/ }).click();
  await expect(page.getByTestId('kpi-ar-outstanding')).toBeVisible();
  await expect(page.locator('.recharts-bar-rectangle')).toHaveCount(24);

  await page.getByRole('link', { name: 'Accounts Payable' }).click();
  await expect(page).toHaveURL(/#\/ap$/);
  await page.getByTestId('new-invoice').click();
  await fillInvoiceForm(page, { number: 'FILE-001', party: 'Disk Test Supplier', amount: '99.90' });
  await page.getByRole('dialog').getByTestId('save-invoice').click();
  await expect(page.getByRole('dialog')).toContainText('FILE-001');
  await page.keyboard.press('Escape');

  // 關閉後重新開啟檔案：資料仍在
  await page.goto('about:blank');
  await page.goto(`${url}#/ap`);
  await expect(page.getByTestId('invoice-table')).toContainText('FILE-001');

  const [xlsx] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-excel').click()]);
  expect(xlsx.suggestedFilename()).toMatch(/^AP-invoices-.*\.xlsx$/);
  const [backup] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Backup', exact: true }).click()]);
  expect(backup.suggestedFilename()).toMatch(/^invoice-backup-.*\.json$/);
  expect(errors).toEqual([]);
});

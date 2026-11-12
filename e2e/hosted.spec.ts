/**
 * claude.ai Artifact 版本測試：
 * 以平台相同的外框包住 finance-portal.html，並注入模擬的 window.claude
 * （db 存在 localStorage、user = 擁有者或檢視者、downloads 記錄下載）。
 * 需先執行 npm run build:artifact。
 */
import { expect, test, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { fillInvoiceForm } from './helpers';

const file = 'dist-artifact/finance-portal.html';
test.skip(!existsSync(file), 'Run "npm run build:artifact" first');

const skeleton = () => `<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light}body{margin:0;font:14px system-ui}img{max-width:100%}[hidden]{display:none!important}</style></head><body>${readFileSync(file, 'utf8')}</body></html>`;

/** 注入模擬的 claude 執行環境。 */
async function open(page: Page, role: 'owner' | 'viewer' = 'owner') {
  await page.addInitScript((r) => {
    const KEY = 'fake-artifact-db';
    const load = () => JSON.parse(localStorage.getItem(KEY) || '{}');
    const store = (d: Record<string, unknown>) => localStorage.setItem(KEY, JSON.stringify(d));
    const snap = (path: string) => { const d = load(); return { id: path.split('/').pop(), exists: path in d, data: () => d[path] }; };
    const doc = (path: string) => ({
      get: async () => snap(path),
      set: async (body: unknown) => { if (r === 'viewer') throw { code: 'invalid_argument' }; const d = load(); d[path] = body; store(d); },
      delete: async () => { const d = load(); delete d[path]; store(d); },
    });
    const db = { doc, collection: (p: string) => ({ doc: (id: string) => doc(`${p}/${id}`), limit: () => ({ get: async () => ({ docs: Object.keys(load()).filter((k) => k.startsWith(`${p}/`)).sort().map(snap) }) }) }) };
    const user = { canEdit: async () => r === 'owner', me: async () => ({ name: r === 'owner' ? 'Carrie' : '', id: r }) };
    const saved: { filename: string; size: number }[] = [];
    (window as unknown as { __saved: unknown }).__saved = saved;
    const downloads = { save: async ({ filename, data }: { filename: string; data: Blob }) => { saved.push({ filename, size: data.size }); return { status: 'saved' }; } };
    const caps: Record<string, unknown> = { db, user, downloads };
    (window as unknown as { claude: unknown }).claude = { use: async (n: string) => caps[n] ?? null };
    // 平台不支援 confirm()：模擬其行為（立即回傳 false）
    window.confirm = () => false;
  }, role);
  await page.route('http://artifact.test/', (route) => route.fulfill({ contentType: 'text/html', body: skeleton() }));
  await page.goto('http://artifact.test/');
}
const saved = (page: Page) => page.evaluate(() => (window as unknown as { __saved: { filename: string; size: number }[] }).__saved);

test('owner: empty start, add invoice, saved to cloud, reload keeps it, Excel via downloads', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await expect(page.getByTestId('welcome')).toBeVisible();
  await expect(page.getByText('Carrie')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);

  await page.getByRole('link', { name: '+ New customer invoice (AR)' }).click();
  await fillInvoiceForm(page, { number: 'INV-1001', party: 'Real Customer Sdn Bhd', amount: '2500', rate: '8' });
  await page.getByRole('dialog').getByTestId('save-invoice').click();
  await expect(page.getByRole('dialog')).toContainText('INV-1001');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('save-status')).toHaveText('All changes saved');

  await page.reload();
  await page.getByRole('link', { name: 'Accounts Receivable' }).click();
  await expect(page.getByTestId('invoice-table')).toContainText('INV-1001');
  await expect(page.getByTestId('footer-outstanding')).toHaveText('RM 2,700.00');

  await page.getByTestId('export-excel').click();
  await expect.poll(() => saved(page)).toEqual([expect.objectContaining({ filename: expect.stringMatching(/^AR-invoices-.*\.xlsx$/) })]);
  expect((await saved(page))[0]!.size).toBeGreaterThan(5000);
  expect(errors).toEqual([]);
});

test('owner: load sample data and remove it with in-page confirmation', async ({ page }) => {
  await open(page);
  await page.getByTestId('open-data-manager').click();
  await page.getByTestId('load-sample').click();
  await page.getByTestId('confirm-data-action').click();
  await expect(page.getByTestId('sample-banner')).toBeVisible();
  await expect(page.locator('.recharts-bar-rectangle')).toHaveCount(24);
  await page.getByTestId('export-full-report').click();
  await expect.poll(async () => (await saved(page)).map((s) => s.filename)).toEqual([expect.stringMatching(/^Finance-Report-.*\.xlsx$/)]);
  await expect(page.getByTestId('save-status')).toHaveText('All changes saved');
  await page.reload();
  await expect(page.getByTestId('sample-banner')).toBeVisible();
  await page.getByRole('button', { name: 'Start with my own data…' }).click();
  await page.getByTestId('start-fresh').click();
  await page.getByTestId('confirm-data-action').click();
  await expect(page.getByTestId('welcome')).toBeVisible();
  await expect(page.getByTestId('save-status')).toHaveText('All changes saved');
  await page.reload();
  await expect(page.getByTestId('welcome')).toBeVisible();
});

test('shared viewer is read-only', async ({ page }) => {
  await open(page, 'viewer');
  await expect(page.getByText('Viewer · read-only')).toBeVisible();
  await expect(page.getByRole('link', { name: '+ New customer invoice (AR)' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Accounts Payable' }).click();
  await expect(page.getByTestId('new-invoice')).toHaveCount(0);
});

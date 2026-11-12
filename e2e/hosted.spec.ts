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
    // 模擬附件儲存與 Claude 擷取：記錄收到的提示文字與圖片數量
    const calls: { prompt: string; images: number }[] = [];
    const deleted: string[] = [];
    (window as unknown as { __calls: unknown; __deleted: unknown }).__calls = calls;
    (window as unknown as { __deleted: unknown }).__deleted = deleted;
    let n = 0;
    const assets = r === 'owner' ? {
      upload: async (blob: Blob, o?: { type?: string }) => { n += 1; const id = String(n).padStart(32, 'a'); return { id, url: `/_blob/${id}`, sizeBytes: blob.size, contentType: o?.type ?? blob.type }; },
      delete: async (id: string) => { deleted.push(id); return { deleted: true }; },
    } : null;
    const sample = {
      limits: async () => ({ maxPromptBytes: 262144, images: { maxCount: 5, maxInputBytes: 20_000_000, mediaTypes: ['image/png', 'image/jpeg'] } }),
      json: async (prompt: string, opts?: { images?: Blob[] }) => {
        calls.push({ prompt, images: opts?.images?.length ?? 0 });
        return { invoiceNumber: 'KKJ-INV-7788', counterpartyName: 'Kilang Kotak Jaya Sdn Bhd', invoiceDate: '2026-10-15', dueDate: null, paymentTermsDays: 30,
          description: 'Corrugated carton boxes (2,000 pcs)', subtotal: 4800, taxAmount: 480, total: 5280, currency: 'MYR' };
      },
    };
    const caps: Record<string, unknown> = { db, user, downloads, assets, sample };
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

test('upload a PDF invoice: details fill in automatically, file is attached on save', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await page.getByRole('link', { name: 'Accounts Payable' }).click();
  await page.getByTestId('upload-invoice-input').setInputFiles('e2e/fixtures/sample-supplier-invoice.pdf');
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByTestId('read-note')).toContainText('Details filled in from sample-supplier-invoice.pdf', { timeout: 20_000 });

  // PDF.js 讀到的文字與第 1 頁圖片都送去擷取
  const calls = await page.evaluate(() => (window as unknown as { __calls: { prompt: string; images: number }[] }).__calls);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.prompt).toContain('KKJ-INV-7788');
  expect(calls[0]!.prompt).toContain('SELLER');
  expect(calls[0]!.images).toBe(1);

  // 表單已自動填好
  await expect(dialog.getByLabel('Invoice Number *')).toHaveValue('KKJ-INV-7788');
  await expect(dialog.getByLabel('Supplier Name *')).toHaveValue('Kilang Kotak Jaya Sdn Bhd');
  await expect(dialog.getByLabel('Invoice Date *')).toHaveValue('2026-10-15');
  await expect(dialog.getByLabel('Due Date *')).toHaveValue('2026-11-14');
  await expect(dialog.getByLabel('Invoice Amount (RM) *')).toHaveValue('4800.00');
  await expect(dialog.getByLabel('Tax rate')).toHaveValue('10');
  await expect(dialog.getByTestId('form-total')).toHaveText('RM 5,280.00');
  await expect(dialog.getByText('✓ From attachment', { exact: true }).first()).toBeVisible();
  await expect(dialog.getByTestId('attachment-list')).toContainText('sample-supplier-invoice.pdf');

  await dialog.getByTestId('save-invoice').click();
  const detail = page.getByRole('dialog');
  await expect(detail).toContainText('KKJ-INV-7788');
  await expect(detail.getByTestId('attachment-list')).toContainText('sample-supplier-invoice.pdf');
  await expect(detail).toContainText('Attached sample-supplier-invoice.pdf to AP invoice KKJ-INV-7788');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('has-attachment')).toBeVisible();

  // 重新載入後附件仍在；再次上傳同一張發票會提示重複
  await expect(page.getByTestId('save-status')).toHaveText('All changes saved');
  await page.reload();
  await page.getByRole('link', { name: 'Accounts Payable' }).click();
  await expect(page.getByTestId('has-attachment')).toBeVisible();
  await page.getByTestId('upload-invoice-input').setInputFiles('e2e/fixtures/sample-supplier-invoice.pdf');
  await expect(page.getByRole('dialog').getByText(/already in the system/)).toBeVisible({ timeout: 20_000 });
  // 取消 → 剛上傳的檔案被刪除
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __deleted: string[] }).__deleted.length)).toBe(1);
  expect(errors).toEqual([]);
});

test('remove an attachment from an invoice', async ({ page }) => {
  await open(page);
  await page.getByRole('link', { name: 'Accounts Payable' }).click();
  await page.getByTestId('upload-invoice-input').setInputFiles('e2e/fixtures/sample-supplier-invoice.pdf');
  await expect(page.getByRole('dialog').getByTestId('read-note')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('dialog').getByTestId('save-invoice').click();
  await page.getByRole('dialog').getByTestId('attachment-list').getByRole('button', { name: /Remove/ }).click();
  await page.getByTestId('confirm-remove-attachment').click();
  await expect(page.getByRole('dialog').getByTestId('attachment-list')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toContainText('Removed attachment sample-supplier-invoice.pdf');
});

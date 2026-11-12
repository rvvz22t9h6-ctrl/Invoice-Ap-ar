/**
 * 端對端測試共用工具：登入、計算預期數字（以領域層計算，作為「正確答案」）。
 */
import { expect, type Page } from '@playwright/test';
import { buildInitialDemoState } from '../src/data/demoRepository';
import { buildDashboard } from '../src/domain/dashboard';
import { todayIso } from '../src/domain/dates';
import { computeInvoices } from '../src/domain/invoice';
import { formatMYR } from '../src/domain/money';
import type { Invoice } from '../src/domain/types';

export const today = todayIso();

/** 以範例資料計算儀表板預期數值。 */
export function expectedDashboard() {
  const state = buildInitialDemoState(today);
  const names = new Map(state.counterparties.map((c) => [c.id, c.name]));
  const invoices: Invoice[] = state.invoices.map((i) => ({ ...i, counterpartyName: names.get(i.counterpartyId) ?? '' }));
  const computed = computeInvoices(invoices, today);
  return { computed, dashboard: buildDashboard(computed, today) };
}

export const money = formatMYR;

export async function login(page: Page, who: 'admin' | 'finance' | 'viewer') {
  const name = { admin: /Mei Ling/, finance: /Nurul Aina/, viewer: /Richard Wong/ }[who];
  await page.goto('/login');
  await page.getByRole('button', { name }).click();
  await expect(page.getByTestId('kpi-ar-outstanding')).toBeVisible();
}

/** 讀取 KPI 卡片的金額文字。 */
export const kpi = (page: Page, id: string) => page.getByTestId(`${id}-value`);

/** 填寫並送出發票表單。 */
export async function fillInvoiceForm(page: Page, v: { number: string; party: string; amount: string; tax?: string; rate?: string; due?: string; description?: string }) {
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Invoice Number *').fill(v.number);
  await dialog.getByLabel(/Name \*/).fill(v.party);
  if (v.due) await dialog.getByLabel('Due Date *').fill(v.due);
  if (v.description) await dialog.getByLabel('Description').fill(v.description);
  await dialog.getByLabel('Invoice Amount (RM) *').fill(v.amount);
  if (v.rate) await dialog.getByLabel('Tax rate').selectOption(v.rate);
  if (v.tax !== undefined) await dialog.getByLabel('Tax Amount (RM)').fill(v.tax);
}

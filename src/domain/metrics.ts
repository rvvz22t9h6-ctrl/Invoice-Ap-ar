/**
 * 財務績效指標（Finance KPIs）
 *
 *   DSO 應收帳款週轉天數 = AR 未付餘額 ÷ 近 90 天 AR 開立金額 × 90
 *       （平均要多少天才能把賣出去的錢收回來；越低越好）
 *   DPO 應付帳款週轉天數 = AP 未付餘額 ÷ 近 90 天 AP 開立金額 × 90
 *       （平均多久付款給供應商）
 *   平均收款天數        = 近 12 個月「已收清」的 AR：最後一筆收款日 − 發票日 的平均
 *   準時收款率          = 上述發票中，在到期日當天或之前收清的比例
 *   呆帳率              = 近 12 個月沖銷金額 ÷ 近 12 個月 AR 開立金額
 */
import { addDays, daysBetween, type IsoDate } from './dates';
import type { ComputedInvoice, InvoiceType } from './types';

export interface FinanceMetrics {
  dso: number | null;
  dpo: number | null;
  avgDaysToCollect: number | null;
  avgDaysToPay: number | null;
  onTimeCollectionRate: number | null; // 0–1
  onTimePaymentRate: number | null; // 0–1
  badDebtRate: number | null; // 0–1
  sampleSizes: { collected: number; paid: number };
}

function turnoverDays(invoices: ComputedInvoice[], type: InvoiceType, today: IsoDate, window = 90): number | null {
  const from = addDays(today, -window);
  const live = invoices.filter((i) => i.type === type && !i.isCancelled);
  const outstanding = live.reduce((t, i) => t + i.outstandingBalance, 0);
  const invoiced = live.filter((i) => i.invoiceDate > from && i.invoiceDate <= today).reduce((t, i) => t + i.totalAmount, 0);
  if (invoiced === 0) return null;
  return Math.round((outstanding / invoiced) * window);
}

function settlement(invoices: ComputedInvoice[], type: InvoiceType, today: IsoDate) {
  const from = addDays(today, -365);
  // 只看以「實際付款」結清的發票（排除折讓／沖銷結清的）
  const done = invoices.filter((i) => i.type === type && i.status === 'Paid' && i.lastPaymentDate && i.lastPaymentDate > from
    && i.payments.some((p) => (p.kind ?? 'payment') === 'payment'));
  if (!done.length) return { avg: null, onTime: null, count: 0 };
  const days = done.map((i) => Math.max(daysBetween(i.invoiceDate, i.lastPaymentDate!), 0));
  const onTime = done.filter((i) => i.lastPaymentDate! <= i.dueDate).length;
  return { avg: Math.round(days.reduce((a, b) => a + b, 0) / done.length), onTime: onTime / done.length, count: done.length };
}

export function buildMetrics(invoices: ComputedInvoice[], today: IsoDate): FinanceMetrics {
  const ar = settlement(invoices, 'AR', today);
  const ap = settlement(invoices, 'AP', today);
  const from = addDays(today, -365);
  const arYear = invoices.filter((i) => i.type === 'AR' && !i.isCancelled && i.invoiceDate > from);
  const invoicedYear = arYear.reduce((t, i) => t + i.totalAmount, 0);
  const writtenOff = invoices.filter((i) => i.type === 'AR').flatMap((i) => i.payments)
    .filter((p) => p.kind === 'write_off' && p.paymentDate > from).reduce((t, p) => t + p.amount, 0);
  return {
    dso: turnoverDays(invoices, 'AR', today),
    dpo: turnoverDays(invoices, 'AP', today),
    avgDaysToCollect: ar.avg,
    avgDaysToPay: ap.avg,
    onTimeCollectionRate: ar.onTime,
    onTimePaymentRate: ap.onTime,
    badDebtRate: invoicedYear ? writtenOff / invoicedYear : null,
    sampleSizes: { collected: ar.count, paid: ap.count },
  };
}

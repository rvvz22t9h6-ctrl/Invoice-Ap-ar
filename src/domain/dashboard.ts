/**
 * 儀表板計算（Dashboard figures）
 *
 * 所有數字都由發票與付款紀錄即時計算，絕不寫死。
 * 已取消的發票一律排除在外。
 *
 *   應付／應收未付總額  = Σ 未付餘額
 *   應付已付／應收已收  = Σ 實際付款金額（全部期間，另提供「本月」；不含折讓單與呆帳沖銷）
 *   逾期應付／逾期應收  = Σ 逾期發票的未付餘額
 *   每月趨勢（近 12 個月）：
 *     - 開立金額：依「發票日期」所在月份加總總金額
 *     - 現金收付：依「付款日期」所在月份加總付款金額
 */
import { lastNMonths, monthKey, type IsoDate } from './dates';
import type { Sen } from './money';
import type { ComputedInvoice, InvoiceType } from './types';

export interface TypeTotals {
  outstanding: Sen;
  outstandingCount: number;
  /** 全部期間實際已付（AP）／已收（AR）的現金（不含折讓與沖銷）。 */
  settled: Sen;
  settledThisMonth: Sen;
  /** 折讓單總額（減少帳款，但不是現金）。 */
  creditNotes: Sen;
  /** 呆帳沖銷總額（僅 AR）。 */
  writtenOff: Sen;
  overdue: Sen;
  overdueCount: number;
  invoicedThisMonth: Sen;
}

export interface MonthlyTrendPoint {
  month: string; // "YYYY-MM"
  apInvoiced: Sen;
  arInvoiced: Sen;
  apPaid: Sen;
  arCollected: Sen;
}

export interface DashboardData {
  today: IsoDate;
  AP: TypeTotals;
  AR: TypeTotals;
  /** 淨部位 = 應收未付 − 應付未付。 */
  netPosition: Sen;
  trends: MonthlyTrendPoint[];
  /** 逾期最久的發票（AP 與 AR 合併）。 */
  topOverdue: ComputedInvoice[];
  /** 未來 7 天內到期的未付發票。 */
  dueSoon: ComputedInvoice[];
}

function emptyTotals(): TypeTotals {
  return { outstanding: 0, outstandingCount: 0, settled: 0, settledThisMonth: 0, creditNotes: 0, writtenOff: 0, overdue: 0, overdueCount: 0, invoicedThisMonth: 0 };
}

export function buildDashboard(invoices: ComputedInvoice[], today: IsoDate, months = 12): DashboardData {
  const totals: Record<InvoiceType, TypeTotals> = { AP: emptyTotals(), AR: emptyTotals() };
  const thisMonth = monthKey(today);
  const monthKeys = lastNMonths(today, months);
  const trendMap = new Map<string, MonthlyTrendPoint>(
    monthKeys.map((m) => [m, { month: m, apInvoiced: 0, arInvoiced: 0, apPaid: 0, arCollected: 0 }]),
  );
  const in7Days = new Date(Date.parse(`${today}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
  const topOverdue: ComputedInvoice[] = [];
  const dueSoon: ComputedInvoice[] = [];

  for (const inv of invoices) {
    if (inv.isCancelled) continue;
    const t = totals[inv.type];

    // 未付餘額與逾期
    if (inv.outstandingBalance > 0) {
      t.outstanding += inv.outstandingBalance;
      t.outstandingCount += 1;
      if (inv.isOverdue) {
        t.overdue += inv.outstandingBalance;
        t.overdueCount += 1;
        topOverdue.push(inv);
      } else if (inv.dueDate <= in7Days) {
        dueSoon.push(inv);
      }
    }

    // 本月開立金額與趨勢（依發票日期）
    const invMonth = monthKey(inv.invoiceDate);
    if (invMonth === thisMonth) t.invoicedThisMonth += inv.totalAmount;
    const invPoint = trendMap.get(invMonth);
    if (invPoint) {
      if (inv.type === 'AP') invPoint.apInvoiced += inv.totalAmount;
      else invPoint.arInvoiced += inv.totalAmount;
    }

    // 已付／已收與趨勢（依付款日期）；折讓與沖銷另計，不算現金
    for (const p of inv.payments) {
      const kind = p.kind ?? 'payment';
      if (kind === 'credit_note') { t.creditNotes += p.amount; continue; }
      if (kind === 'write_off') { t.writtenOff += p.amount; continue; }
      t.settled += p.amount;
      const payMonth = monthKey(p.paymentDate);
      if (payMonth === thisMonth) t.settledThisMonth += p.amount;
      const payPoint = trendMap.get(payMonth);
      if (payPoint) {
        if (inv.type === 'AP') payPoint.apPaid += p.amount;
        else payPoint.arCollected += p.amount;
      }
    }
  }

  return {
    today,
    AP: totals.AP,
    AR: totals.AR,
    netPosition: totals.AR.outstanding - totals.AP.outstanding,
    trends: monthKeys.map((m) => trendMap.get(m)!),
    topOverdue: topOverdue.sort((a, b) => b.daysOverdue - a.daysOverdue || b.outstandingBalance - a.outstandingBalance).slice(0, 8),
    dueSoon: dueSoon.sort((a, b) => a.dueDate.localeCompare(b.dueDate)).slice(0, 8),
  };
}

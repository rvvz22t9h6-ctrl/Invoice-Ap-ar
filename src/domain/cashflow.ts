/**
 * 現金流預測（Cash flow forecast）
 *
 * 假設：每張未付發票會在「到期日」收到／付出其未付餘額；已逾期的帳款歸入「逾期（應立即）」列。
 *
 *   目前估計銀行餘額 = 期初餘額 + 期初日期之後的實際收款 − 期初日期之後的實際付款
 *   每週淨額         = 預計收款（AR 到期）− 預計付款（AP 到期）
 *   預計期末餘額     = 目前餘額 + 累計淨額
 *
 * 已取消、已退回（AP 審批被拒）的發票不列入；折讓與沖銷不是現金，不影響銀行餘額。
 */
import { addDays, daysBetween, formatDate, type IsoDate } from './dates';
import type { Sen } from './money';
import type { CompanySettings, ComputedInvoice } from './types';

export interface CashFlowRow {
  key: string;
  label: string;
  /** 期間起訖（逾期列為 null）。 */
  start: IsoDate | null;
  end: IsoDate | null;
  inflow: Sen;
  outflow: Sen;
  net: Sen;
  closing: Sen;
  inflowCount: number;
  outflowCount: number;
}

export interface CashFlowForecast {
  /** 預測起點：目前估計的銀行餘額。 */
  currentBalance: Sen;
  /** 期初餘額之後已實際收付的淨額。 */
  movementSinceOpening: Sen;
  hasOpeningBalance: boolean;
  rows: CashFlowRow[];
  /** 超出預測期間的帳款。 */
  later: { inflow: Sen; outflow: Sen };
  totals: { inflow: Sen; outflow: Sen; net: Sen };
  /** 預測期間內的最低餘額（用來提早發現資金缺口）。 */
  lowest: { amount: Sen; label: string };
}

const isOpen = (i: ComputedInvoice) => !i.isCancelled && i.outstandingBalance > 0 && i.approvalStatus !== 'rejected';

export function buildCashFlowForecast(invoices: ComputedInvoice[], today: IsoDate, settings: Pick<CompanySettings, 'openingBalance' | 'openingBalanceDate'>, weeks = 12): CashFlowForecast {
  // 1. 目前估計餘額
  let movement = 0;
  if (settings.openingBalanceDate) {
    for (const inv of invoices) {
      for (const p of inv.payments) {
        if ((p.kind ?? 'payment') !== 'payment') continue;
        if (p.paymentDate <= settings.openingBalanceDate || p.paymentDate > today) continue;
        movement += inv.type === 'AR' ? p.amount : -p.amount;
      }
    }
  }
  const currentBalance = settings.openingBalance + movement;

  // 2. 建立期間：逾期 + 每週
  const rows: CashFlowRow[] = [{ key: 'overdue', label: 'Overdue (due now)', start: null, end: null, inflow: 0, outflow: 0, net: 0, closing: 0, inflowCount: 0, outflowCount: 0 }];
  for (let w = 0; w < weeks; w += 1) {
    const start = addDays(today, w * 7);
    const end = addDays(start, 6);
    rows.push({ key: `w${w + 1}`, label: `${formatDate(start).slice(0, 6)} – ${formatDate(end).slice(0, 6)}`, start, end, inflow: 0, outflow: 0, net: 0, closing: 0, inflowCount: 0, outflowCount: 0 });
  }
  const horizonEnd = addDays(today, weeks * 7 - 1);
  const later = { inflow: 0, outflow: 0 };

  // 3. 依到期日分配
  for (const inv of invoices) {
    if (!isOpen(inv)) continue;
    let row: CashFlowRow | undefined;
    if (inv.dueDate < today) row = rows[0];
    else if (inv.dueDate <= horizonEnd) row = rows[1 + Math.floor(daysBetween(today, inv.dueDate) / 7)];
    if (!row) {
      if (inv.type === 'AR') later.inflow += inv.outstandingBalance; else later.outflow += inv.outstandingBalance;
      continue;
    }
    if (inv.type === 'AR') { row.inflow += inv.outstandingBalance; row.inflowCount += 1; } else { row.outflow += inv.outstandingBalance; row.outflowCount += 1; }
  }

  // 4. 累計餘額
  let running = currentBalance;
  let lowest = { amount: currentBalance, label: 'Today' };
  for (const r of rows) {
    r.net = r.inflow - r.outflow;
    running += r.net;
    r.closing = running;
    if (running < lowest.amount) lowest = { amount: running, label: r.label };
  }
  const totals = rows.reduce((t, r) => ({ inflow: t.inflow + r.inflow, outflow: t.outflow + r.outflow, net: t.net + r.net }), { inflow: 0, outflow: 0, net: 0 });

  return { currentBalance, movementSinceOpening: movement, hasOpeningBalance: !!settings.openingBalanceDate || settings.openingBalance !== 0, rows, later, totals, lowest };
}

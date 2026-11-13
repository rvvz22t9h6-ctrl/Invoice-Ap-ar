/**
 * 給主管的每週摘要（Weekly summary）
 *
 * 期間為週一至週日。內容全部由發票、付款與報銷紀錄計算：
 *   本週：實際收款、實際付款、已付報銷、新開發票與新收帳單
 *   目前：AR／AP 未付與逾期
 *   最大的逾期客戶（前 5 名）、客戶答應的付款日
 *   未來 7 天：要付的帳單、預計收款、待付報銷
 * 折讓與沖銷不是現金，不計入收付款。
 */
import type { StaffClaim } from './claims';
import { addDays, formatDate, type IsoDate } from './dates';
import { promiseStatus } from './followups';
import { formatMYR, sumSen, type Sen } from './money';
import type { ComputedInvoice } from './types';

export interface Amount { count: number; total: Sen }
export interface WeeklySummary {
  from: IsoDate; to: IsoDate; asOf: IsoDate;
  collected: Amount; paid: Amount; claimsPaid: Amount;
  invoiced: Amount; billed: Amount;
  arOutstanding: Amount; arOverdue: Amount; apOutstanding: Amount; apOverdue: Amount;
  topOverdue: { name: string; total: Sen; count: number; oldestDays: number }[];
  promises: { name: string; invoiceNumber: string; amount: Sen; date: IsoDate; broken: boolean }[];
  next: { from: IsoDate; to: IsoDate; apDue: Amount; apList: { name: string; invoiceNumber: string; dueDate: IsoDate; amount: Sen }[]; arDue: Amount; claimsToPay: Amount };
}

/** 包含指定日期的那一週（週一至週日）。offset = -1 為上一週。 */
export function weekRange(today: IsoDate, offset = 0): { from: IsoDate; to: IsoDate } {
  const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7; // 週一 = 0
  const from = addDays(today, -dow + offset * 7);
  return { from, to: addDays(from, 6) };
}

const amount = (values: Sen[]): Amount => ({ count: values.length, total: sumSen(values) });

export function buildWeeklySummary(invoices: ComputedInvoice[], claims: StaffClaim[], today: IsoDate, offset = 0): WeeklySummary {
  const { from, to } = weekRange(today, offset);
  const within = (d: string | null | undefined) => !!d && d >= from && d <= to;
  const live = invoices.filter((i) => !i.isCancelled);
  const cash = (type: 'AR' | 'AP') => live.filter((i) => i.type === type).flatMap((i) => i.payments.filter((p) => (p.kind ?? 'payment') === 'payment' && within(p.paymentDate)).map((p) => p.amount));
  const open = (type: 'AR' | 'AP') => live.filter((i) => i.type === type && i.outstandingBalance > 0 && (type === 'AR' || i.approvalStatus !== 'rejected'));
  const arOpen = open('AR');
  const apOpen = open('AP');

  const byCustomer = new Map<string, { name: string; total: Sen; count: number; oldestDays: number }>();
  for (const i of arOpen.filter((x) => x.isOverdue)) {
    const e = byCustomer.get(i.counterpartyId) ?? { name: i.counterpartyName, total: 0, count: 0, oldestDays: 0 };
    e.total += i.outstandingBalance; e.count += 1; e.oldestDays = Math.max(e.oldestDays, i.daysOverdue);
    byCustomer.set(i.counterpartyId, e);
  }
  const promises = arOpen.map((i) => ({ i, p: promiseStatus(i.followUps, today) })).filter((x) => x.p)
    .map(({ i, p }) => ({ name: i.counterpartyName, invoiceNumber: i.invoiceNumber, amount: i.outstandingBalance, date: p!.date, broken: p!.broken }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const nFrom = addDays(today, 1);
  const nTo = addDays(today, 7);
  const dueNext = (list: ComputedInvoice[]) => list.filter((i) => i.dueDate >= nFrom && i.dueDate <= nTo);
  const apNext = dueNext(apOpen).sort((a, b) => a.dueDate.localeCompare(b.dueDate) || b.outstandingBalance - a.outstandingBalance);

  return {
    from, to, asOf: today,
    collected: amount(cash('AR')), paid: amount(cash('AP')),
    claimsPaid: amount(claims.filter((c) => c.status === 'paid' && within(c.paidDate)).map((c) => c.amount)),
    invoiced: amount(live.filter((i) => i.type === 'AR' && within(i.invoiceDate)).map((i) => i.totalAmount)),
    billed: amount(live.filter((i) => i.type === 'AP' && within(i.invoiceDate)).map((i) => i.totalAmount)),
    arOutstanding: amount(arOpen.map((i) => i.outstandingBalance)), arOverdue: amount(arOpen.filter((i) => i.isOverdue).map((i) => i.outstandingBalance)),
    apOutstanding: amount(apOpen.map((i) => i.outstandingBalance)), apOverdue: amount(apOpen.filter((i) => i.isOverdue).map((i) => i.outstandingBalance)),
    topOverdue: [...byCustomer.values()].sort((a, b) => b.total - a.total).slice(0, 5),
    promises: promises.slice(0, 8),
    next: {
      from: nFrom, to: nTo, apDue: amount(apNext.map((i) => i.outstandingBalance)),
      apList: apNext.slice(0, 5).map((i) => ({ name: i.counterpartyName, invoiceNumber: i.invoiceNumber, dueDate: i.dueDate, amount: i.outstandingBalance })),
      arDue: amount(dueNext(arOpen).map((i) => i.outstandingBalance)),
      claimsToPay: amount(claims.filter((c) => c.status === 'approved').map((c) => c.amount)),
    },
  };
}

/** 純文字版（可貼到 WhatsApp 或電郵）。 */
export function weeklySummaryText(s: WeeklySummary, companyName?: string): string {
  const n = (a: Amount, word: string) => `${formatMYR(a.total)} (${a.count} ${word}${a.count === 1 ? '' : 's'})`;
  const lines: string[] = [
    `*${companyName ? `${companyName} · ` : ''}Weekly finance summary*`,
    `${formatDate(s.from)} to ${formatDate(s.to)}`,
    '',
    '*This week*',
    `• Collected from customers: ${n(s.collected, 'payment')}`,
    `• Paid to suppliers: ${n(s.paid, 'payment')}`,
    ...(s.claimsPaid.count ? [`• Staff claims paid: ${n(s.claimsPaid, 'claim')}`] : []),
    `• New customer invoices: ${n(s.invoiced, 'invoice')}`,
    `• New supplier bills: ${n(s.billed, 'bill')}`,
    '',
    `*Position as of ${formatDate(s.asOf)}*`,
    `• Customers owe us: ${formatMYR(s.arOutstanding.total)}, of which ${formatMYR(s.arOverdue.total)} is overdue (${s.arOverdue.count} invoice${s.arOverdue.count === 1 ? '' : 's'})`,
    `• We owe suppliers: ${formatMYR(s.apOutstanding.total)}, of which ${formatMYR(s.apOverdue.total)} is overdue (${s.apOverdue.count} bill${s.apOverdue.count === 1 ? '' : 's'})`,
  ];
  if (s.topOverdue.length) {
    lines.push('', '*Largest overdue customers*');
    s.topOverdue.forEach((c, i) => lines.push(`${i + 1}. ${c.name}: ${formatMYR(c.total)} (${c.count} invoice${c.count === 1 ? '' : 's'}, oldest ${c.oldestDays} days overdue)`));
  }
  if (s.promises.length) {
    lines.push('', '*Customers who promised to pay*');
    s.promises.forEach((p) => lines.push(`• ${p.name} (${p.invoiceNumber}): ${formatMYR(p.amount)} by ${formatDate(p.date)}${p.broken ? ' · NOT YET RECEIVED' : ''}`));
  }
  lines.push('', `*Next 7 days (${formatDate(s.next.from)} to ${formatDate(s.next.to)})*`,
    `• Supplier bills due: ${n(s.next.apDue, 'bill')}`);
  s.next.apList.forEach((b) => lines.push(`   - ${b.name} (${b.invoiceNumber}): ${formatMYR(b.amount)} due ${formatDate(b.dueDate)}`));
  if (s.next.apDue.count > s.next.apList.length) lines.push(`   - and ${s.next.apDue.count - s.next.apList.length} more`);
  lines.push(`• Customer payments expected: ${n(s.next.arDue, 'invoice')}`);
  if (s.next.claimsToPay.count) lines.push(`• Approved staff claims to pay: ${n(s.next.claimsToPay, 'claim')}`);
  return lines.join('\n');
}

/**
 * 對帳單（Statement of Account）與催款信
 *
 * 對帳單：某客戶／供應商在期間內的所有交易，依日期排序並計算累計餘額。
 *   借方（Debit）= 發票金額（對方欠款增加）
 *   貸方（Credit）= 付款、折讓、沖銷（欠款減少）
 *   期初餘額 = 期間開始前的 借方 − 貸方；期末餘額 = 期初 + 期間借方 − 期間貸方
 * 已取消的發票不列入。
 */
import { AGING_BUCKETS, buildAgingReport, type AgingBucketKey } from './aging';
import { formatDate, type IsoDate } from './dates';
import { formatMYR, type Sen } from './money';
import { PAYMENT_KIND_LABEL, type ComputedInvoice } from './types';

export interface StatementLine {
  date: IsoDate;
  kind: 'invoice' | 'payment' | 'credit_note' | 'write_off';
  reference: string;
  description: string;
  dueDate: IsoDate | null;
  debit: Sen;
  credit: Sen;
  balance: Sen;
}

export interface Statement {
  counterpartyId: string;
  counterpartyName: string;
  from: IsoDate;
  to: IsoDate;
  openingBalance: Sen;
  lines: StatementLine[];
  totalDebit: Sen;
  totalCredit: Sen;
  closingBalance: Sen;
  /** 目前（今天）的帳齡分布。 */
  aging: Record<AgingBucketKey, Sen>;
  overdue: ComputedInvoice[];
}

export function buildStatement(invoices: ComputedInvoice[], counterpartyId: string, from: IsoDate, to: IsoDate): Statement {
  const mine = invoices.filter((i) => i.counterpartyId === counterpartyId && !i.isCancelled);
  type Raw = Omit<StatementLine, 'balance'>;
  const raw: Raw[] = [];
  for (const inv of mine) {
    raw.push({ date: inv.invoiceDate, kind: 'invoice', reference: inv.invoiceNumber, description: inv.description || 'Invoice', dueDate: inv.dueDate, debit: inv.totalAmount, credit: 0 });
    for (const p of inv.payments) {
      const kind = p.kind ?? 'payment';
      raw.push({
        date: p.paymentDate, kind, reference: inv.invoiceNumber,
        description: `${PAYMENT_KIND_LABEL[kind]}${p.reference ? ` · ${p.reference}` : ''}${kind === 'payment' && p.method ? ` · ${p.method}` : ''}`,
        dueDate: null, debit: 0, credit: p.amount,
      });
    }
  }
  // 同一天：先列發票，再列沖帳
  raw.sort((a, b) => a.date.localeCompare(b.date) || (a.kind === 'invoice' ? -1 : 1) - (b.kind === 'invoice' ? -1 : 1) || a.reference.localeCompare(b.reference));

  let opening = 0;
  for (const r of raw) if (r.date < from) opening += r.debit - r.credit;
  let running = opening;
  const lines: StatementLine[] = [];
  for (const r of raw) {
    if (r.date < from || r.date > to) continue;
    running += r.debit - r.credit;
    lines.push({ ...r, balance: running });
  }
  const totalDebit = lines.reduce((t, l) => t + l.debit, 0);
  const totalCredit = lines.reduce((t, l) => t + l.credit, 0);

  const type = mine[0]?.type ?? 'AR';
  const agingReport = buildAgingReport(mine, type);
  const aging = Object.fromEntries(AGING_BUCKETS.map((b) => [b.key, agingReport.buckets[b.key].amount])) as Record<AgingBucketKey, Sen>;

  return {
    counterpartyId,
    counterpartyName: mine[0]?.counterpartyName ?? '',
    from, to, openingBalance: opening, lines, totalDebit, totalCredit, closingBalance: opening + totalDebit - totalCredit,
    aging,
    overdue: mine.filter((i) => i.isOverdue).sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
  };
}

/** 產生禮貌的催款信內容（使用者複製後自行寄出）。 */
export function buildReminderText(customerName: string, overdue: ComputedInvoice[], companyName: string, contactPerson?: string): { subject: string; body: string } {
  const total = overdue.reduce((t, i) => t + i.outstandingBalance, 0);
  const lines = overdue.map((i) => `  • ${i.invoiceNumber} dated ${formatDate(i.invoiceDate)}, due ${formatDate(i.dueDate)}: ${formatMYR(i.outstandingBalance)} outstanding (${i.daysOverdue} days overdue)`);
  const sender = companyName || 'our company';
  return {
    subject: `Payment reminder: ${formatMYR(total)} overdue${companyName ? ` – ${companyName}` : ''}`,
    body: [
      `Dear ${contactPerson || `${customerName} Accounts Team`},`,
      '',
      `This is a friendly reminder that the following invoice${overdue.length === 1 ? ' is' : 's are'} now overdue:`,
      '',
      ...lines,
      '',
      `Total overdue: ${formatMYR(total)}`,
      '',
      'We would appreciate payment at your earliest convenience. If payment has already been made, please send us the remittance details so we can update our records, and kindly disregard this reminder.',
      '',
      'Thank you for your continued business.',
      '',
      'Best regards,',
      `Accounts Receivable, ${sender}`,
    ].join('\n'),
  };
}

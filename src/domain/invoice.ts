/**
 * 發票計算核心（Invoice calculations）
 *
 * 本檔實作所有會計公式，是系統「唯一」的計算來源：
 *
 *   總金額 Total Amount         = 發票金額 Invoice Amount + 稅額 Tax Amount
 *   已付金額 Total Payments      = 該發票所有付款紀錄加總
 *   未付餘額 Outstanding Balance = 總金額 − 已付金額（不會小於 0）
 *   逾期 Overdue                = 未付餘額 > 0 且 今天 > 到期日 且 未取消
 *
 *   付款狀態判斷順序（先符合者優先）：
 *     1. Cancelled       已取消
 *     2. Paid            未付餘額 = 0
 *     3. Overdue         未付餘額 > 0 且 今天 > 到期日
 *     4. Partially Paid  已付金額 > 0 且 未付餘額 > 0
 *     5. Pending         尚無付款，等待處理
 *
 *   「逾期」優先於「部分付款」，因為逾期是較高的風險；
 *   部分付款資訊仍保留在 isPartiallyPaid 旗標中供畫面標示。
 */
import { daysBetween, type IsoDate } from './dates';
import { sumSen, type Sen } from './money';
import type { ComputedInvoice, Invoice, PaymentStatus } from './types';

/** 總金額 = 發票金額 + 稅額。 */
export function totalAmount(invoice: Pick<Invoice, 'invoiceAmount' | 'taxAmount'>): Sen {
  return invoice.invoiceAmount + invoice.taxAmount;
}

/** 已付金額 = 所有付款加總。 */
export function amountPaid(invoice: Pick<Invoice, 'payments'>): Sen {
  return sumSen(invoice.payments.map((p) => p.amount));
}

/** 未付餘額 = 總金額 − 已付金額；已取消的發票不再有應收／應付餘額。 */
export function outstandingBalance(invoice: Pick<Invoice, 'invoiceAmount' | 'taxAmount' | 'payments' | 'isCancelled'>): Sen {
  if (invoice.isCancelled) return 0;
  return Math.max(totalAmount(invoice) - amountPaid(invoice), 0);
}

/** 依公式判斷付款狀態。 */
export function paymentStatus(
  invoice: Pick<Invoice, 'invoiceAmount' | 'taxAmount' | 'payments' | 'isCancelled' | 'dueDate'>,
  today: IsoDate,
): PaymentStatus {
  if (invoice.isCancelled) return 'Cancelled';
  const outstanding = outstandingBalance(invoice);
  const paid = amountPaid(invoice);
  if (outstanding === 0) return 'Paid';
  if (today > invoice.dueDate) return 'Overdue';
  if (paid > 0) return 'Partially Paid';
  return 'Pending';
}

/** 逾期天數：僅在逾期時大於 0。 */
export function daysOverdue(invoice: Pick<Invoice, 'dueDate'>, status: PaymentStatus, today: IsoDate): number {
  return status === 'Overdue' ? daysBetween(invoice.dueDate, today) : 0;
}

/** 將原始發票資料加上所有計算欄位。 */
export function computeInvoice(invoice: Invoice, today: IsoDate): ComputedInvoice {
  const total = totalAmount(invoice);
  const paid = amountPaid(invoice);
  const outstanding = outstandingBalance(invoice);
  const status = paymentStatus(invoice, today);
  const lastPaymentDate = invoice.payments.reduce<IsoDate | null>(
    (latest, p) => (latest === null || p.paymentDate > latest ? p.paymentDate : latest),
    null,
  );
  return {
    ...invoice,
    totalAmount: total,
    amountPaid: paid,
    outstandingBalance: outstanding,
    status,
    isOverdue: status === 'Overdue',
    daysOverdue: daysOverdue(invoice, status, today),
    isPartiallyPaid: !invoice.isCancelled && paid > 0 && outstanding > 0,
    lastPaymentDate,
  };
}

export function computeInvoices(invoices: Invoice[], today: IsoDate): ComputedInvoice[] {
  return invoices.map((inv) => computeInvoice(inv, today));
}

/** 到期描述（畫面用），例如「15 days overdue」「Due in 3 days」。 */
export function dueDescription(inv: ComputedInvoice, today: IsoDate): string {
  if (inv.status === 'Paid' || inv.status === 'Cancelled') return '';
  if (inv.daysOverdue > 0) return `${inv.daysOverdue} day${inv.daysOverdue === 1 ? '' : 's'} overdue`;
  const days = daysBetween(today, inv.dueDate);
  if (days === 0) return 'Due today';
  return `Due in ${days} day${days === 1 ? '' : 's'}`;
}

/**
 * 表單驗證與業務規則（Validation & business rules）
 *
 * 分兩層：
 * 1. zod 結構驗證：欄位格式（必填、日期格式、金額格式）。
 * 2. 業務規則：需要參考其他資料才能判斷（例如重複發票號碼、超額付款）。
 *
 * 前端在送出前先檢查，給使用者清楚的錯誤訊息；
 * 資料庫（觸發器與唯一索引）會「再次」強制執行同樣規則，確保資料正確。
 */
import { z } from 'zod';
import { isValidIsoDate, type IsoDate } from './dates';
import { formatMYR, MAX_SEN, toSen, type Sen } from './money';
import type { ComputedInvoice, Invoice, InvoiceType, PaymentKind } from './types';

/** 業務規則錯誤：code 供程式判斷，message 直接顯示給使用者。 */
export class DomainError extends Error {
  constructor(public readonly code: DomainErrorCode, message: string, public readonly field?: string) {
    super(message);
    this.name = 'DomainError';
  }
}

export type DomainErrorCode =
  | 'DUPLICATE_INVOICE'
  | 'OVERPAYMENT'
  | 'NOT_APPROVED'
  | 'CANCELLED'
  | 'HAS_PAYMENTS'
  | 'TOTAL_BELOW_PAID'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION';

// ---------------------------------------------------------------------------
// 共用欄位驗證
// ---------------------------------------------------------------------------

const isoDate = (label: string) =>
  z.string({ required_error: `${label} is required` })
    .trim()
    .min(1, `${label} is required`)
    .refine(isValidIsoDate, `${label} is not a valid date`);

/** 金額欄位：接受 "1,234.50" 這類輸入，轉為整數仙。 */
const moneyField = (label: string, { allowZero }: { allowZero: boolean }) =>
  z.string({ required_error: `${label} is required` })
    .trim()
    .min(1, `${label} is required`)
    .transform((value, ctx) => {
      const sen = toSen(value);
      if (sen === null || !/^\s*(RM\s*)?[\d,]*(\.\d{1,2})?\s*$/i.test(value)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} must be a valid amount with up to 2 decimals` });
        return z.NEVER;
      }
      if (sen < 0 || (!allowZero && sen === 0)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} must be ${allowZero ? 'zero or more' : 'greater than zero'}` });
        return z.NEVER;
      }
      if (sen > MAX_SEN) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} is too large` });
        return z.NEVER;
      }
      return sen;
    });

// ---------------------------------------------------------------------------
// 發票表單
// ---------------------------------------------------------------------------

export const invoiceFormSchema = z.object({
  invoiceNumber: z.string().trim().min(1, 'Invoice number is required').max(50, 'Invoice number is too long (max 50)')
    .regex(/^[A-Za-z0-9][A-Za-z0-9\-/._ #]*$/, 'Use letters, numbers and - / . _ # only'),
  counterpartyName: z.string().trim().min(2, 'Name is required').max(150, 'Name is too long (max 150)'),
  invoiceDate: isoDate('Invoice date'),
  dueDate: isoDate('Due date'),
  description: z.string().trim().max(500, 'Description is too long (max 500)').default(''),
  invoiceAmount: moneyField('Invoice amount', { allowZero: false }),
  taxAmount: moneyField('Tax amount', { allowZero: true }),
}).superRefine((v, ctx) => {
  // 到期日不可早於發票日期
  if (isValidIsoDate(v.invoiceDate) && isValidIsoDate(v.dueDate) && v.dueDate < v.invoiceDate) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dueDate'], message: 'Due date cannot be before the invoice date' });
  }
  if (typeof v.invoiceAmount === 'number' && typeof v.taxAmount === 'number' && v.invoiceAmount + v.taxAmount > MAX_SEN) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['taxAmount'], message: 'Total amount is too large' });
  }
});

/** 表單原始輸入（皆為字串）。 */
export type InvoiceFormInput = z.input<typeof invoiceFormSchema>;
/** 驗證後的資料（金額已轉為整數仙）。 */
export type InvoiceFormValues = z.output<typeof invoiceFormSchema>;

// ---------------------------------------------------------------------------
// 付款表單
// ---------------------------------------------------------------------------

export const paymentFormSchema = (today: IsoDate) => z.object({
  kind: z.enum(['payment', 'credit_note', 'write_off']).default('payment'),
  paymentDate: isoDate('Payment date').refine((d) => d <= today, 'Payment date cannot be in the future'),
  amount: moneyField('Payment amount', { allowZero: false }),
  method: z.string().trim().min(1, 'Payment method is required').max(50),
  reference: z.string().trim().max(100, 'Reference is too long (max 100)').default(''),
  notes: z.string().trim().max(500, 'Notes are too long (max 500)').default(''),
});

export type PaymentFormInput = z.input<ReturnType<typeof paymentFormSchema>>;
export type PaymentFormValues = z.output<ReturnType<typeof paymentFormSchema>>;

/** 折讓單與沖銷不需要付款方式，使用固定值。 */
export const KIND_METHOD: Record<Exclude<PaymentKind, 'payment'>, string> = { credit_note: 'Credit note', write_off: 'Write-off' };

export const PAYMENT_METHODS = ['Bank Transfer (IBG/DuitNow)', 'FPX', 'Cheque', 'Cash', 'Credit Card', 'Contra / Offset', 'Other'];

/** 將 zod 錯誤轉為 { 欄位: 訊息 }，方便表單逐欄顯示。 */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? '_');
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 業務規則
// ---------------------------------------------------------------------------

/** 發票號碼正規化：去除前後空白並忽略大小寫，"inv-001 " 與 "INV-001" 視為相同。 */
export const normalizeInvoiceNumber = (n: string) => n.trim().toLowerCase();
export const normalizeName = (n: string) => n.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * 檢查重複發票號碼：
 * - AR（本公司開立）：所有 AR 發票號碼不可重複。
 * - AP（供應商開立）：同一供應商的發票號碼不可重複；不同供應商可相同。
 */
export function findDuplicateInvoice(
  existing: Pick<Invoice, 'id' | 'type' | 'invoiceNumber' | 'counterpartyName'>[],
  candidate: { type: InvoiceType; invoiceNumber: string; counterpartyName: string; id?: string },
): Pick<Invoice, 'id' | 'invoiceNumber' | 'counterpartyName'> | null {
  const num = normalizeInvoiceNumber(candidate.invoiceNumber);
  const party = normalizeName(candidate.counterpartyName);
  return existing.find((inv) =>
    inv.id !== candidate.id
    && inv.type === candidate.type
    && normalizeInvoiceNumber(inv.invoiceNumber) === num
    && (candidate.type === 'AR' || normalizeName(inv.counterpartyName) === party),
  ) ?? null;
}

export function assertNotDuplicate(...args: Parameters<typeof findDuplicateInvoice>): void {
  const [, candidate] = args;
  const dup = findDuplicateInvoice(...args);
  if (dup) {
    throw new DomainError('DUPLICATE_INVOICE', candidate.type === 'AR'
      ? `Invoice number ${dup.invoiceNumber} already exists`
      : `Invoice ${dup.invoiceNumber} from ${dup.counterpartyName} already exists`, 'invoiceNumber');
  }
}

/** 記錄付款前的檢查：已取消、AP 未審批（僅限實際付款）、超額付款、AP 不可沖銷呆帳。 */
export function assertCanRecordPayment(inv: ComputedInvoice, amount: Sen, kind: PaymentKind = 'payment'): void {
  if (inv.isCancelled) throw new DomainError('CANCELLED', 'Cannot record a payment on a cancelled invoice');
  if (kind === 'write_off' && inv.type !== 'AR') throw new DomainError('VALIDATION', 'Only customer invoices can be written off');
  if (kind === 'payment' && inv.type === 'AP' && inv.approvalStatus !== 'approved') {
    throw new DomainError('NOT_APPROVED', 'This supplier invoice must be approved before payment');
  }
  if (inv.outstandingBalance === 0) throw new DomainError('OVERPAYMENT', 'This invoice is already fully paid', 'amount');
  if (amount > inv.outstandingBalance) {
    throw new DomainError('OVERPAYMENT', `Amount exceeds the outstanding balance of ${formatMYR(inv.outstandingBalance)}`, 'amount');
  }
}

/** 取消前檢查：已有付款的發票不可取消（須先沖銷付款）。 */
export function assertCanCancel(inv: ComputedInvoice): void {
  if (inv.amountPaid > 0) {
    throw new DomainError('HAS_PAYMENTS', 'This invoice has payments. Reverse the payments before cancelling it.');
  }
}

/** 修改金額時，新總額不可低於已付金額。 */
export function assertTotalCoversPaid(newTotal: Sen, paid: Sen): void {
  if (newTotal < paid) {
    throw new DomainError('TOTAL_BELOW_PAID', `Total amount cannot be less than the ${formatMYR(paid)} already paid`, 'invoiceAmount');
  }
}

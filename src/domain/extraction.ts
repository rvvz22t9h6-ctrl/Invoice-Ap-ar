/**
 * 從發票附件自動擷取欄位（Invoice extraction）
 *
 * 流程：頁面讀取 PDF 文字／圖片 → 交給 Claude 擷取 → 本檔負責：
 *   1. buildExtractionPrompt：產生指示（AP 與 AR 要擷取的「對象」不同）
 *   2. normalizeExtraction：檢查並整理 Claude 回傳的 JSON，轉成表單欄位
 * 擷取結果只會「填入表單」，使用者確認後才儲存，因此錯誤不會直接進入帳務資料。
 */
import { addDays, isValidIsoDate, type IsoDate } from './dates';
import { senToDecimalString, toSen } from './money';
import type { InvoiceType } from './types';
import type { InvoiceFormInput } from './validation';

/** Claude 回傳的原始結構（每個欄位都可能缺漏或格式錯誤）。 */
export interface RawExtraction {
  invoiceNumber?: unknown;
  counterpartyName?: unknown;
  invoiceDate?: unknown;
  dueDate?: unknown;
  paymentTermsDays?: unknown;
  description?: unknown;
  subtotal?: unknown;
  taxAmount?: unknown;
  total?: unknown;
  currency?: unknown;
}

export interface ExtractionResult {
  /** 可直接填入表單的欄位（只包含有讀到的欄位）。 */
  fields: Partial<InvoiceFormInput>;
  /** 需要使用者注意的事項（例如幣別不是 MYR）。 */
  warnings: string[];
}

const MAX_TEXT = 15_000;

export function buildExtractionPrompt(type: InvoiceType, documentText: string, hasImage: boolean): string {
  const who = type === 'AP'
    ? 'This is a SUPPLIER INVOICE (a bill our company received). "counterpartyName" is the SELLER / ISSUER company that sent the invoice, never the buyer or "bill to" party.'
    : 'This is a CUSTOMER INVOICE that our company issued. "counterpartyName" is the CUSTOMER being billed (the "Bill To" / "Sold To" party), never our own company in the letterhead.';
  const text = documentText.trim().slice(0, MAX_TEXT);
  return [
    'Extract the key fields from an invoice for an accounts system in Malaysia.',
    who,
    'Reply with only one JSON object of this exact shape (use null for anything not shown on the document; never guess):',
    '{"invoiceNumber": string|null, "counterpartyName": string|null, "invoiceDate": "YYYY-MM-DD"|null, "dueDate": "YYYY-MM-DD"|null, "paymentTermsDays": number|null, "description": string|null, "subtotal": number|null, "taxAmount": number|null, "total": number|null, "currency": string|null}',
    'Rules:',
    '- Amounts are plain numbers without currency symbols or commas, e.g. 12500.5.',
    '- subtotal is the amount BEFORE tax; taxAmount is SST / service tax / sales tax / GST / VAT (0 if the invoice shows no tax); total is the final amount payable.',
    '- Malaysian invoices usually write dates as DD/MM/YYYY: 03/04/2026 means 3 April 2026.',
    '- paymentTermsDays: e.g. 30 for "Net 30" or "30 days"; null if not stated.',
    '- description: what was bought or sold, at most 120 characters, e.g. "Corrugated carton boxes (2,000 pcs)".',
    '- currency: the ISO code such as "MYR" (RM), "USD", "SGD".',
    hasImage ? 'An image of the document (first page) is attached.' : '',
    text ? `Document text:\n"""\n${text}\n"""` : 'No text could be read from the file; use the attached image.',
  ].filter(Boolean).join('\n');
}

const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ').slice(0, max) : null);

/** 數字或數字字串 → 整數仙；無效時回傳 null。 */
function amount(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.round(v * 100);
  if (typeof v === 'string') {
    const sen = toSen(v.replace(/[^\d.,-]/g, ''));
    return sen !== null && sen >= 0 ? sen : null;
  }
  return null;
}

/** 接受 YYYY-MM-DD；也容錯 DD/MM/YYYY。 */
function date(v: unknown): IsoDate | null {
  if (typeof v !== 'string') return null;
  const t: string = v.trim();
  const isIso: (x: string) => boolean = isValidIsoDate; // 避免型別收窄成 never
  if (isIso(t)) return t;
  const m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) {
    const iso = `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
    if (isValidIsoDate(iso)) return iso;
  }
  return null;
}

/** 整理 Claude 的回覆，並互相推算缺少的金額與到期日。 */
export function normalizeExtraction(raw: unknown): ExtractionResult {
  const r = (raw && typeof raw === 'object' ? raw : {}) as RawExtraction;
  const fields: Partial<InvoiceFormInput> = {};
  const warnings: string[] = [];

  const number = str(r.invoiceNumber, 50)?.replace(/[^A-Za-z0-9\-/._ #]/g, '').trim();
  if (number) fields.invoiceNumber = number;
  const party = str(r.counterpartyName, 150);
  if (party) fields.counterpartyName = party;
  const description = str(r.description, 500);
  if (description) fields.description = description;

  const invoiceDate = date(r.invoiceDate);
  let dueDate = date(r.dueDate);
  const terms = typeof r.paymentTermsDays === 'number' && r.paymentTermsDays >= 0 && r.paymentTermsDays <= 365 ? Math.round(r.paymentTermsDays) : null;
  if (!dueDate && invoiceDate && terms !== null) dueDate = addDays(invoiceDate, terms);
  if (invoiceDate) fields.invoiceDate = invoiceDate;
  if (dueDate && (!invoiceDate || dueDate >= invoiceDate)) fields.dueDate = dueDate;
  else if (dueDate) warnings.push('The due date on the document is before the invoice date. Please check it.');
  if (!dueDate) warnings.push('No due date was found. Please set the payment terms.');

  // 金額：小計、稅額、總額，三者知道其二即可推算第三個
  let subtotal = amount(r.subtotal);
  let tax = amount(r.taxAmount);
  const total = amount(r.total);
  if (subtotal === null && total !== null) subtotal = total - (tax ?? 0);
  if (tax === null && subtotal !== null && total !== null && total >= subtotal) tax = total - subtotal;
  if (subtotal !== null && subtotal > 0) fields.invoiceAmount = senToDecimalString(subtotal);
  if (tax !== null) fields.taxAmount = senToDecimalString(tax);
  if (subtotal !== null && tax !== null && total !== null && Math.abs(subtotal + tax - total) > 1) {
    warnings.push('Subtotal plus tax does not match the total on the document. Please check the amounts.');
  }
  if (fields.invoiceAmount === undefined) warnings.push('No amount was found. Please enter it.');

  const currency = str(r.currency, 10)?.toUpperCase();
  if (currency && currency !== 'MYR' && currency !== 'RM') {
    warnings.push(`This invoice is in ${currency}. Convert the amounts to MYR before saving.`);
  }
  return { fields, warnings };
}

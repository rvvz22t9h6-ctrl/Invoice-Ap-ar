/**
 * 員工報銷（Staff Claims）
 *
 * 流程只有一層：提交（To approve）→ 核准（Approved, to pay）→ 已付款（Paid），或退回（Rejected）。
 * 金額一律為整數仙（Sen）。里程報銷：公里 × 每公里費率，自動計算金額。
 * 自動檢查：沒有收據、超過 60 天才報銷、可能重複（同一員工、同一天、同金額）。
 */
import { daysBetween, isValidIsoDate, monthKey, type IsoDate } from './dates';
import { MAX_SEN, sumSen, toSen, type Sen } from './money';
import type { Attachment } from './types';

export const CLAIM_CATEGORIES = [
  'Mileage', 'Petrol', 'Parking & Toll', 'Travel & Accommodation', 'Meals & Entertainment',
  'Medical', 'Phone & Internet', 'Office Supplies', 'Training', 'Others',
] as const;
export type ClaimCategory = (typeof CLAIM_CATEGORIES)[number];

export type ClaimStatus = 'submitted' | 'approved' | 'rejected' | 'paid';
export const CLAIM_STATUS_LABEL: Record<ClaimStatus, string> = {
  submitted: 'To approve', approved: 'Approved · to pay', rejected: 'Rejected', paid: 'Paid',
};

export const PAY_METHODS = ['With salary', 'Bank transfer', 'Cash'] as const;
export type PayMethod = (typeof PAY_METHODS)[number];

/** 預設里程費率：每公里 RM0.60（可在每筆報銷修改）。 */
export const DEFAULT_RATE_PER_KM: Sen = 60;
/** 超過此天數才報銷會提示。 */
export const LATE_CLAIM_DAYS = 60;

export interface StaffClaim {
  id: string;
  /** 報銷編號，例如 CL-2611-001。 */
  claimNo: string;
  staffName: string;
  expenseDate: IsoDate;
  category: ClaimCategory;
  description: string;
  amount: Sen;
  /** 里程報銷才有。 */
  mileageKm: number | null;
  ratePerKm: Sen | null;
  /** 有收據（紙本或已上傳）。 */
  hasReceipt: boolean;
  receipt: Attachment | null;
  status: ClaimStatus;
  /** 核准或退回的日期。 */
  decidedOn: IsoDate | null;
  rejectReason: string;
  paidDate: IsoDate | null;
  payMethod: PayMethod | null;
  paymentRef: string;
  remarks: string;
  /** 建立日（公司時區）。 */
  submittedOn: IsoDate;
  createdAt: string;
  updatedAt: string;
}

/** 表單欄位（文字輸入，金額以令吉表示）。 */
export interface ClaimFormValues {
  staffName: string;
  expenseDate: string;
  category: ClaimCategory;
  description: string;
  amount: string;
  mileageKm: string;
  ratePerKm: string;
  hasReceipt: boolean;
  remarks: string;
}

export type ClaimErrors = Partial<Record<keyof ClaimFormValues, string>>;

export interface ValidClaimFields {
  staffName: string; expenseDate: IsoDate; category: ClaimCategory; description: string; amount: Sen;
  mileageKm: number | null; ratePerKm: Sen | null; hasReceipt: boolean; remarks: string;
}

/** 里程金額：公里 × 費率，四捨五入到仙。 */
export function mileageAmount(km: number, ratePerKm: Sen): Sen {
  // 以 0.1 公里為整數單位計算，避免 33.3 × 55 = 1831.4999… 的浮點誤差
  return Math.round((Math.round(km * 10) * ratePerKm) / 10);
}

export function validateClaim(v: ClaimFormValues, today: IsoDate): { ok: true; value: ValidClaimFields } | { ok: false; errors: ClaimErrors } {
  const errors: ClaimErrors = {};
  const staffName = v.staffName.trim().replace(/\s+/g, ' ');
  if (!staffName) errors.staffName = 'Enter the staff name';
  else if (staffName.length > 80) errors.staffName = 'Keep the name under 80 characters';
  if (!isValidIsoDate(v.expenseDate)) errors.expenseDate = 'Enter the date of the expense';
  else if (v.expenseDate > today) errors.expenseDate = 'The expense date cannot be in the future';
  if (!CLAIM_CATEGORIES.includes(v.category)) errors.category = 'Choose a category';
  const description = v.description.trim();
  if (!description) errors.description = v.category === 'Mileage' ? 'Enter the trip, e.g. "Office to Shah Alam client, return"' : 'Describe what was bought';
  else if (description.length > 200) errors.description = 'Keep the description under 200 characters';
  if (v.remarks.length > 1000) errors.remarks = 'Keep remarks under 1000 characters';

  let amount: Sen | null = null;
  let mileageKm: number | null = null;
  let ratePerKm: Sen | null = null;
  if (v.category === 'Mileage') {
    const km = Number(v.mileageKm);
    if (!v.mileageKm.trim() || !Number.isFinite(km) || km <= 0) errors.mileageKm = 'Enter the distance in km';
    else if (km > 10_000) errors.mileageKm = 'Distance looks too large';
    else mileageKm = Math.round(km * 10) / 10;
    const rate = toSen(v.ratePerKm);
    if (rate === null || rate <= 0) errors.ratePerKm = 'Enter the rate per km, e.g. 0.60';
    else ratePerKm = rate;
    if (mileageKm !== null && ratePerKm !== null) amount = mileageAmount(mileageKm, ratePerKm);
  } else {
    amount = toSen(v.amount);
    if (amount === null || amount <= 0) { errors.amount = 'Enter an amount above RM 0.00'; amount = null; }
  }
  if (amount !== null && amount > MAX_SEN) errors.amount = 'Amount is too large';
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value: { staffName, expenseDate: v.expenseDate as IsoDate, category: v.category, description, amount: amount!, mileageKm, ratePerKm, hasReceipt: v.hasReceipt, remarks: v.remarks.trim() } };
}

/** 下一個報銷編號：CL-YYMM-###（依提交月份，每月重新編號）。 */
export function nextClaimNo(existing: Pick<StaffClaim, 'claimNo'>[], submittedOn: IsoDate): string {
  const prefix = `CL-${submittedOn.slice(2, 4)}${submittedOn.slice(5, 7)}-`;
  const max = existing.reduce((m, c) => (c.claimNo.startsWith(prefix) ? Math.max(m, Number(c.claimNo.slice(prefix.length)) || 0) : m), 0);
  return `${prefix}${String(max + 1).padStart(3, '0')}`;
}

export function newClaim(fields: ValidClaimFields, existing: StaffClaim[], today: IsoDate, now: string, id: string): StaffClaim {
  return {
    id, claimNo: nextClaimNo(existing, today), ...fields, receipt: null, status: 'submitted', decidedOn: null, rejectReason: '',
    paidDate: null, payMethod: null, paymentRef: '', submittedOn: today, createdAt: now, updatedAt: now,
  };
}

/** 修改內容；已付款的報銷不可修改金額相關欄位。 */
export function editClaim(c: StaffClaim, fields: ValidClaimFields, now: string): StaffClaim {
  if (c.status === 'paid' && (fields.amount !== c.amount || fields.staffName !== c.staffName)) {
    throw new Error('This claim is already paid. Undo the payment before changing the staff or amount.');
  }
  return { ...c, ...fields, updatedAt: now };
}

export const canApprove = (c: StaffClaim) => c.status === 'submitted' || c.status === 'rejected';
export const canPay = (c: StaffClaim) => c.status === 'approved';

export function approveClaim(c: StaffClaim, today: IsoDate, now: string): StaffClaim {
  if (!canApprove(c)) throw new Error(`${c.claimNo} cannot be approved now`);
  return { ...c, status: 'approved', decidedOn: today, rejectReason: '', updatedAt: now };
}

export function rejectClaim(c: StaffClaim, reason: string, today: IsoDate, now: string): StaffClaim {
  if (c.status === 'paid') throw new Error(`${c.claimNo} is already paid`);
  const r = reason.trim();
  if (!r) throw new Error('Enter a reason so the staff knows what to fix');
  return { ...c, status: 'rejected', decidedOn: today, rejectReason: r.slice(0, 300), updatedAt: now };
}

export interface PaymentDetails { paidDate: IsoDate; payMethod: PayMethod; paymentRef: string }

export function payClaim(c: StaffClaim, p: PaymentDetails, now: string): StaffClaim {
  if (!canPay(c)) throw new Error(`${c.claimNo} must be approved before it is paid`);
  if (!isValidIsoDate(p.paidDate)) throw new Error('Enter the payment date');
  if (!PAY_METHODS.includes(p.payMethod)) throw new Error('Choose how it was paid');
  return { ...c, status: 'paid', paidDate: p.paidDate, payMethod: p.payMethod, paymentRef: p.paymentRef.trim().slice(0, 100), updatedAt: now };
}

/** 復原：已付款 → 已核准；已核准／退回 → 待核准。 */
export function undoClaim(c: StaffClaim, now: string): StaffClaim {
  if (c.status === 'paid') return { ...c, status: 'approved', paidDate: null, payMethod: null, paymentRef: '', updatedAt: now };
  return { ...c, status: 'submitted', decidedOn: null, rejectReason: '', updatedAt: now };
}

export type ClaimFlag = 'No receipt' | 'Late claim' | 'Possible duplicate';

/** 需要注意的事項（只提示，不阻擋）。 */
export function claimFlags(c: StaffClaim, all: StaffClaim[]): ClaimFlag[] {
  const out: ClaimFlag[] = [];
  if (!c.hasReceipt && !c.receipt && c.category !== 'Mileage') out.push('No receipt');
  if (daysBetween(c.expenseDate, c.submittedOn) > LATE_CLAIM_DAYS) out.push('Late claim');
  const key = c.staffName.toLowerCase();
  if (all.some((o) => o.id !== c.id && o.status !== 'rejected' && o.staffName.toLowerCase() === key && o.expenseDate === c.expenseDate && o.amount === c.amount)) out.push('Possible duplicate');
  return out;
}

export interface ClaimTotals {
  toApprove: { count: number; total: Sen };
  toPay: { count: number; total: Sen };
  paidThisMonth: { count: number; total: Sen };
  missingReceipts: number;
}

export function claimTotals(claims: StaffClaim[], today: IsoDate): ClaimTotals {
  const pick = (f: (c: StaffClaim) => boolean) => { const l = claims.filter(f); return { count: l.length, total: sumSen(l.map((c) => c.amount)) }; };
  const month = monthKey(today);
  return {
    toApprove: pick((c) => c.status === 'submitted'),
    toPay: pick((c) => c.status === 'approved'),
    paidThisMonth: pick((c) => c.status === 'paid' && !!c.paidDate && monthKey(c.paidDate) === month),
    missingReceipts: claims.filter((c) => c.status !== 'rejected' && claimFlags(c, []).includes('No receipt')).length,
  };
}

export interface StaffSummary { staffName: string; count: number; total: Sen; claimIds: string[] }

/** 依員工合計（預設：已核准未付款，方便隨薪資一起發放）。 */
export function summaryByStaff(claims: StaffClaim[], status: ClaimStatus = 'approved'): StaffSummary[] {
  const m = new Map<string, StaffSummary>();
  for (const c of claims) {
    if (c.status !== status) continue;
    const k = c.staffName.toLowerCase();
    const s = m.get(k) ?? { staffName: c.staffName, count: 0, total: 0, claimIds: [] };
    s.count += 1; s.total += c.amount; s.claimIds.push(c.id);
    m.set(k, s);
  }
  return [...m.values()].sort((a, b) => b.total - a.total || a.staffName.localeCompare(b.staffName));
}

/** 曾經輸入過的員工姓名（輸入時自動提示）。 */
export function staffNames(claims: StaffClaim[]): string[] {
  const m = new Map<string, string>();
  for (const c of claims) if (!m.has(c.staffName.toLowerCase())) m.set(c.staffName.toLowerCase(), c.staffName);
  return [...m.values()].sort((a, b) => a.localeCompare(b));
}

/** 依類別合計（指定月份的支出，不含退回）。 */
export function totalsByCategory(claims: StaffClaim[], month: string): { category: ClaimCategory; total: Sen; count: number }[] {
  return CLAIM_CATEGORIES.map((category) => {
    const l = claims.filter((c) => c.category === category && c.status !== 'rejected' && monthKey(c.expenseDate) === month);
    return { category, total: sumSen(l.map((c) => c.amount)), count: l.length };
  }).filter((x) => x.count > 0);
}

/** 儲存前的基本檢查（資料層使用）。 */
export function isValidClaimRecord(c: StaffClaim): boolean {
  return typeof c.id === 'string' && !!c.id && /^CL-\d{4}-\d{3,}$/.test(c.claimNo) && !!c.staffName.trim() && isValidIsoDate(c.expenseDate)
    && CLAIM_CATEGORIES.includes(c.category) && Number.isInteger(c.amount) && c.amount > 0 && ['submitted', 'approved', 'rejected', 'paid'].includes(c.status)
    && (c.status !== 'paid' || (isValidIsoDate(c.paidDate) && !!c.payMethod));
}

// ---------------------------------------------------------------------------
// 收據自動填寫：產生指示、整理 Claude 回傳的 JSON（只填入表單，使用者確認後才儲存）
// ---------------------------------------------------------------------------

export function buildReceiptPrompt(documentText: string, hasImage: boolean): string {
  const text = documentText.trim().slice(0, 8000);
  return [
    'Read this receipt for a staff expense claim at a company in Malaysia.',
    'Reply with only one JSON object of this exact shape (use null for anything not shown; never guess):',
    `{"date": "YYYY-MM-DD"|null, "total": number|null, "merchant": string|null, "description": string|null, "category": one of ${JSON.stringify(CLAIM_CATEGORIES.filter((c) => c !== 'Mileage'))}|null, "currency": string|null}`,
    'Rules:',
    '- total is the final amount paid, a plain number without symbols or commas, e.g. 45.9.',
    '- Malaysian receipts usually write dates as DD/MM/YYYY: 03/04/2026 means 3 April 2026.',
    '- description: what was bought, at most 80 characters, e.g. "Lunch with client" or "Parking at KLCC".',
    '- category: Petrol for fuel stations (Petronas, Shell, BHPetrol, Caltex); Parking & Toll for parking, Touch \'n Go, toll; Medical for clinics and pharmacies.',
    hasImage ? 'An image of the receipt is attached.' : '',
    text ? `Receipt text:\n"""\n${text}\n"""` : 'No text could be read; use the attached image.',
  ].filter(Boolean).join('\n');
}

export interface ReceiptExtraction { fields: Partial<Pick<ClaimFormValues, 'expenseDate' | 'amount' | 'description' | 'category'>>; warnings: string[] }

export function normalizeReceipt(raw: unknown, today: IsoDate): ReceiptExtraction {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const fields: ReceiptExtraction['fields'] = {};
  const warnings: string[] = [];
  if (isValidIsoDate(r.date) && r.date <= today) fields.expenseDate = r.date;
  const total = typeof r.total === 'number' ? r.total : typeof r.total === 'string' ? Number(r.total.replace(/[^\d.]/g, '')) : NaN;
  const sen = Number.isFinite(total) && total > 0 ? toSen(total) : null;
  if (sen) fields.amount = (sen / 100).toFixed(2);
  const merchant = typeof r.merchant === 'string' ? r.merchant.trim().slice(0, 60) : '';
  const what = typeof r.description === 'string' ? r.description.trim().slice(0, 80) : '';
  const desc = [what, merchant && !what.toLowerCase().includes(merchant.toLowerCase()) ? merchant : ''].filter(Boolean).join(' · ');
  if (desc) fields.description = desc.slice(0, 200);
  if (typeof r.category === 'string' && (CLAIM_CATEGORIES as readonly string[]).includes(r.category) && r.category !== 'Mileage') fields.category = r.category as ClaimCategory;
  const cur = typeof r.currency === 'string' ? r.currency.trim().toUpperCase() : '';
  if (cur && !['MYR', 'RM'].includes(cur)) warnings.push(`This receipt is in ${cur}. Enter the amount in RM.`);
  return { fields, warnings };
}

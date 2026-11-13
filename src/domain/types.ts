/**
 * 領域模型型別（Domain types）
 *
 * 這些型別描述「業務資料」本身，與資料來源（Supabase 或示範模式）無關。
 * 金額欄位皆為整數仙（Sen），日期皆為 ISO 字串。
 *
 * 注意：「已付金額」「未付餘額」「付款狀態」不儲存於資料庫，
 * 一律由 invoice.ts 中的函式根據付款紀錄即時計算。
 */
import type { FollowUp } from './followups';
import type { Sen } from './money';
import type { IsoDate } from './dates';

/** 發票類別：AP = 應付帳款（供應商帳單）、AR = 應收帳款（客戶發票）。 */
export type InvoiceType = 'AP' | 'AR';

/** 往來對象類別：AP 對應供應商、AR 對應客戶。 */
export type CounterpartyKind = 'supplier' | 'customer';

/** 審批狀態（僅 AP 使用），與付款狀態分開管理。 */
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

/** 付款狀態（由系統計算，非人工設定）。 */
export type PaymentStatus = 'Pending' | 'Partially Paid' | 'Paid' | 'Overdue' | 'Cancelled';

/** 使用者角色：admin 管理員、finance 財務人員、viewer 唯讀（例如老闆／管理層）。 */
export type UserRole = 'admin' | 'finance' | 'viewer';

export interface Counterparty {
  id: string;
  kind: CounterpartyKind;
  name: string;
  /** 以下為聯絡資料（皆為選填；舊資料可能沒有）。 */
  contactPerson?: string;
  email?: string;
  phone?: string;
  address?: string;
  /** 預設付款期限（天），新增發票時自動帶入到期日。 */
  paymentTermsDays?: number | null;
  notes?: string;
}

/**
 * 沖帳類型：
 *   payment     實際收／付款（計入現金）
 *   credit_note 折讓單（減少應收／應付，但不是現金）
 *   write_off   呆帳沖銷（僅 AR：確定收不到的款項）
 */
export type PaymentKind = 'payment' | 'credit_note' | 'write_off';

export const PAYMENT_KIND_LABEL: Record<PaymentKind, string> = {
  payment: 'Payment',
  credit_note: 'Credit note',
  write_off: 'Write-off (bad debt)',
};

/** 公司設定。 */
export interface CompanySettings {
  companyName: string;
  /** 期初銀行餘額（仙），現金流預測的起點。 */
  openingBalance: Sen;
  /** 期初餘額的日期；之後的實際收付款會自動加減。 */
  openingBalanceDate: IsoDate | null;
  defaultTermsAR: number;
  defaultTermsAP: number;
}

export const DEFAULT_SETTINGS: CompanySettings = {
  companyName: '',
  openingBalance: 0,
  openingBalanceDate: null,
  defaultTermsAR: 30,
  defaultTermsAP: 30,
};

export interface Payment {
  id: string;
  invoiceId: string;
  /** 沖帳類型；舊資料沒有此欄位，視為 payment。 */
  kind?: PaymentKind;
  paymentDate: IsoDate;
  amount: Sen;
  method: string;
  reference: string;
  notes: string;
  createdAt: string;
  createdByName: string | null;
}

/** 附件（發票 PDF 或照片）。檔案本身存在平台的 assets，這裡只記錄指標與資訊。 */
export interface Attachment {
  /** 平台 asset id（長期有效的指標）。 */
  id: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  uploadedAt: string;
}

/** 發票主檔（含其付款紀錄）。 */
export interface Invoice {
  id: string;
  type: InvoiceType;
  invoiceNumber: string;
  counterpartyId: string;
  counterpartyName: string;
  invoiceDate: IsoDate;
  dueDate: IsoDate;
  description: string;
  /** 備註（跟進情況、聯絡紀錄等）；舊資料可能沒有。 */
  remarks?: string;
  invoiceAmount: Sen;
  taxAmount: Sen;
  /** 僅 AP 有值；AR 為 null。 */
  approvalStatus: ApprovalStatus | null;
  isCancelled: boolean;
  cancelReason: string;
  createdAt: string;
  updatedAt: string;
  createdByName: string | null;
  payments: Payment[];
  /** 附件；舊資料可能沒有此欄位。 */
  attachments?: Attachment[];
  /** 催款／付款跟進紀錄；舊資料可能沒有此欄位。 */
  followUps?: FollowUp[];
}

/** 經計算後的發票（畫面與報表使用）。 */
export interface ComputedInvoice extends Invoice {
  totalAmount: Sen;
  amountPaid: Sen;
  outstandingBalance: Sen;
  status: PaymentStatus;
  isOverdue: boolean;
  daysOverdue: number;
  /** 有付款但尚未付清（即使狀態顯示為 Overdue 也會標示）。 */
  isPartiallyPaid: boolean;
  lastPaymentDate: IsoDate | null;
}

/** 活動紀錄（由資料庫觸發器自動寫入）。 */
export interface ActivityEntry {
  id: string;
  invoiceId: string | null;
  action: string;
  summary: string;
  actorName: string | null;
  createdAt: string;
}

export interface UserProfile {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
}

export const PAYMENT_STATUSES: PaymentStatus[] = ['Pending', 'Partially Paid', 'Overdue', 'Paid', 'Cancelled'];
export const APPROVAL_STATUSES: ApprovalStatus[] = ['pending', 'approved', 'rejected'];

export const APPROVAL_LABEL: Record<ApprovalStatus, string> = {
  pending: 'Pending Approval',
  approved: 'Approved',
  rejected: 'Rejected',
};

export const ROLE_LABEL: Record<UserRole, string> = {
  admin: 'Admin',
  finance: 'Finance',
  viewer: 'Viewer',
};

/** 依發票類別取得畫面用字（AP 與 AR 共用同一套元件）。 */
export const TYPE_LABELS: Record<InvoiceType, {
  module: string; party: string; partyPlural: string; paid: string; status: string; newInvoice: string; pay: string;
}> = {
  AP: { module: 'Accounts Payable', party: 'Supplier', partyPlural: 'Suppliers', paid: 'Amount Paid', status: 'Payment Status', newInvoice: 'New Supplier Invoice', pay: 'Record Payment' },
  AR: { module: 'Accounts Receivable', party: 'Customer', partyPlural: 'Customers', paid: 'Amount Received', status: 'Collection Status', newInvoice: 'New Customer Invoice', pay: 'Record Collection' },
};

export const kindForType = (type: InvoiceType): CounterpartyKind => (type === 'AP' ? 'supplier' : 'customer');

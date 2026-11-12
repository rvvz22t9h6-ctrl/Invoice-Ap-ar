/**
 * 領域模型型別（Domain types）
 *
 * 這些型別描述「業務資料」本身，與資料來源（Supabase 或示範模式）無關。
 * 金額欄位皆為整數仙（Sen），日期皆為 ISO 字串。
 *
 * 注意：「已付金額」「未付餘額」「付款狀態」不儲存於資料庫，
 * 一律由 invoice.ts 中的函式根據付款紀錄即時計算。
 */
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
}

export interface Payment {
  id: string;
  invoiceId: string;
  paymentDate: IsoDate;
  amount: Sen;
  method: string;
  reference: string;
  notes: string;
  createdAt: string;
  createdByName: string | null;
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

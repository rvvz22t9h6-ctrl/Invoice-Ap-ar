/**
 * 資料存取介面（Repository interface）
 *
 * 前端頁面只透過這個介面存取資料，不直接呼叫 Supabase。
 * 好處：
 *   - 前端、後端、資料庫邏輯分離，日後更換後端只需新增一個實作。
 *   - 同一套畫面可在「Supabase 正式模式」與「瀏覽器示範模式」下運作。
 *
 * 所有金額參數與回傳值皆為整數仙（Sen）。
 */
import type { IsoDate } from '@/domain/dates';
import type { ActivityEntry, ApprovalStatus, Counterparty, CounterpartyKind, Invoice, InvoiceType, UserProfile } from '@/domain/types';
import type { InvoiceFormValues, PaymentFormValues } from '@/domain/validation';

export type DataMode = 'supabase' | 'demo' | 'hosted';

export interface Repository {
  readonly mode: DataMode;

  // ---------- 身分驗證 ----------
  /** 取得目前登入者；未登入回傳 null。 */
  currentUser(): Promise<UserProfile | null>;
  signIn(email: string, password: string): Promise<UserProfile>;
  signOut(): Promise<void>;

  // ---------- 讀取 ----------
  /** 公司時區的今天（計算逾期用）。 */
  today(): IsoDate;
  /** 所有發票（含付款紀錄）；計算欄位由 domain/invoice.ts 處理。 */
  listInvoices(): Promise<Invoice[]>;
  listCounterparties(kind?: CounterpartyKind): Promise<Counterparty[]>;
  /** 最近活動；可指定發票 ID 取得單張發票的歷程。 */
  listActivity(options?: { limit?: number; invoiceId?: string }): Promise<ActivityEntry[]>;

  // ---------- 寫入 ----------
  createInvoice(type: InvoiceType, values: InvoiceFormValues): Promise<Invoice>;
  updateInvoice(id: string, values: InvoiceFormValues): Promise<Invoice>;
  /** 變更 AP 審批狀態（僅管理員）。 */
  setApproval(id: string, status: ApprovalStatus): Promise<void>;
  cancelInvoice(id: string, reason: string): Promise<void>;
  restoreInvoice(id: string): Promise<void>;
  /** 永久刪除（僅管理員，且不可有付款）。 */
  deleteInvoice(id: string): Promise<void>;
  recordPayment(invoiceId: string, values: PaymentFormValues): Promise<void>;
  /** 沖銷付款（僅管理員）。 */
  reversePayment(paymentId: string): Promise<void>;

  // ---------- 僅本機模式（資料存在瀏覽器）----------
  /** 載入範例資料（會取代目前所有資料）。 */
  resetDemoData?(): Promise<void>;
  /** 清空所有資料，從空白開始。 */
  clearAllData?(): Promise<void>;
  /** 匯出備份（JSON 文字）。 */
  exportBackup?(): string;
  /** 由備份還原（會取代目前所有資料）。 */
  importBackup?(text: string): Promise<void>;
  /** 資料狀態：是否為範例、筆數、最後修改與最後備份時間。 */
  dataStatus?(): { isSample: boolean; invoiceCount: number; modifiedAt: string | null; lastBackupAt: string | null };
}

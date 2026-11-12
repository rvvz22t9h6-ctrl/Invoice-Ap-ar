/**
 * 示範模式資料來源（Demo repository）
 *
 * 在未設定 Supabase 時使用：資料存放在瀏覽器 localStorage，重新整理後仍保留。
 * 為了讓示範與正式環境行為一致，這裡實作與資料庫觸發器「相同」的業務規則：
 *   - 角色權限（viewer 唯讀、finance 可新增修改、admin 可刪除／審批／沖銷）
 *   - 重複發票號碼、超額付款、未審批不可付款、有付款不可取消
 *   - 活動紀錄文字格式與資料庫相同
 */
import { addDays, todayIso, type IsoDate } from '@/domain/dates';
import { computeInvoice } from '@/domain/invoice';
import { formatMYR } from '@/domain/money';
import type { ActivityEntry, ApprovalStatus, Attachment, Counterparty, CounterpartyKind, Invoice, InvoiceType, Payment, UserProfile } from '@/domain/types';
import { kindForType } from '@/domain/types';
import {
  assertCanCancel, assertCanRecordPayment, assertNotDuplicate, assertTotalCoversPaid, DomainError,
  normalizeName, type InvoiceFormValues, type PaymentFormValues,
} from '@/domain/validation';
import type { Repository } from './repository';
import { buildSampleActivity, buildSampleInvoices, SAMPLE_COUNTERPARTIES } from './sampleData';

/** 示範帳號（密碼皆為 demo1234）。 */
export const DEMO_USERS: (UserProfile & { password: string; description: string })[] = [
  { id: 'demo-admin', email: 'admin@demo.my', fullName: 'Mei Ling Tan (Finance Manager)', role: 'admin', password: 'demo1234', description: 'Full access, approves AP, reverses payments' },
  { id: 'demo-finance', email: 'finance@demo.my', fullName: 'Nurul Aina (AP Executive)', role: 'finance', password: 'demo1234', description: 'Creates invoices and records payments' },
  { id: 'demo-viewer', email: 'boss@demo.my', fullName: 'Dato\' Richard Wong (Director)', role: 'viewer', password: 'demo1234', description: 'Read-only management view' },
];

export interface DemoState {
  version: number;
  counterparties: Counterparty[];
  invoices: Omit<Invoice, 'counterpartyName'>[];
  activity: ActivityEntry[];
  /** true = 仍是範例資料（提醒使用者改用自己的資料）。舊版資料沒有此欄位，視為範例。 */
  isSample?: boolean;
  /** 最後一次修改時間（ISO），用於備份提醒。 */
  modifiedAt?: string | null;
}

/** 備份檔格式。 */
interface BackupFile {
  app: 'invoice-ap-ar';
  version: number;
  exportedAt: string;
  data: DemoState;
}

export const STATE_VERSION = 1;

/** 簡易儲存介面，方便測試時替換。 */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const memoryStore = (): KeyValueStore => {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
};

let idCounter = 0;
const newId = () => (globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${(idCounter += 1)}`);

/** 依「今天」將相對日期的範例資料轉成實際日期。 */
export function buildInitialDemoState(today: IsoDate): DemoState {
  const sample = buildSampleInvoices();
  const counterparties: Counterparty[] = SAMPLE_COUNTERPARTIES.map((c) => ({ id: c.id, kind: c.kind, name: c.name }));
  const at = (dayOffset: number, minutes: number) => new Date(Date.parse(`${addDays(today, dayOffset)}T00:00:00+08:00`) + minutes * 60_000).toISOString();
  const invoices = sample.map((s) => ({
    id: s.id,
    type: s.type,
    invoiceNumber: s.invoiceNumber,
    counterpartyId: s.counterpartyId,
    invoiceDate: addDays(today, s.invoiceDayOffset),
    dueDate: addDays(today, s.dueDayOffset),
    description: s.description,
    invoiceAmount: s.invoiceAmount,
    taxAmount: s.taxAmount,
    approvalStatus: s.approvalStatus,
    isCancelled: s.isCancelled,
    cancelReason: s.cancelReason,
    createdAt: at(s.invoiceDayOffset, 540),
    updatedAt: at(s.invoiceDayOffset, 540),
    createdByName: s.type === 'AP' ? 'Nurul Aina (AP Executive)' : 'Jason Lim (AR Executive)',
    payments: s.payments.map((p): Payment => ({
      id: p.id, invoiceId: s.id, paymentDate: addDays(today, p.dayOffset), amount: p.amount, method: p.method,
      reference: p.reference, notes: '', createdAt: at(p.dayOffset, 660), createdByName: null,
    })),
  }));
  const activity: ActivityEntry[] = buildSampleActivity(sample, formatMYR).map((a, i) => ({
    id: `seed-${i}`, invoiceId: a.invoiceId, action: a.action, summary: a.summary, actorName: a.actorName, createdAt: at(a.dayOffset, a.minuteOfDay),
  }));
  return { version: STATE_VERSION, counterparties, invoices, activity, isSample: true, modifiedAt: null };
}

export class DemoRepository implements Repository {
  readonly mode: 'demo' | 'hosted' = 'demo';
  protected state: DemoState;
  protected user: UserProfile | null = null;
  private static readonly DATA_KEY = 'invoice-ap-ar:demo-data';
  private static readonly USER_KEY = 'invoice-ap-ar:demo-user';
  private static readonly BACKUP_KEY = 'invoice-ap-ar:last-backup';

  constructor(
    private readonly store: KeyValueStore = typeof localStorage !== 'undefined' ? safeStore(localStorage) : memoryStore(),
    private readonly todayFn: () => IsoDate = () => todayIso(),
    /** 模擬網路延遲（毫秒），讓載入狀態在示範時也看得到；測試時設為 0。 */
    private readonly latencyMs = 120,
  ) {
    this.state = this.load();
    const savedUser = this.store.getItem(DemoRepository.USER_KEY);
    this.user = DEMO_USERS.find((u) => u.id === savedUser) ?? null;
  }

  // ---------- 內部工具 ----------

  private load(): DemoState {
    try {
      const raw = this.store.getItem(DemoRepository.DATA_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as DemoState;
        if (parsed.version === STATE_VERSION) return parsed;
      }
    } catch {
      // 資料損毀時改用新的範例資料
    }
    const fresh = buildInitialDemoState(this.todayFn());
    this.save(fresh);
    return fresh;
  }

  protected save(state = this.state) {
    this.store.setItem(DemoRepository.DATA_KEY, JSON.stringify(state));
  }

  /** 使用者修改資料後呼叫：記錄修改時間並儲存。 */
  private commit() {
    this.state.modifiedAt = new Date().toISOString();
    this.save();
  }

  protected delay<T>(value: T): Promise<T> {
    // 回傳深拷貝，避免畫面意外修改內部狀態
    const copy = structuredClone(value);
    return this.latencyMs ? new Promise((r) => setTimeout(() => r(copy), this.latencyMs)) : Promise.resolve(copy);
  }

  /** 權限檢查：與資料庫 RLS 相同。 */
  protected require(...roles: UserProfile['role'][]): UserProfile {
    if (!this.user) throw new DomainError('FORBIDDEN', 'Please sign in');
    if (roles.length && !roles.includes(this.user.role)) {
      throw new DomainError('FORBIDDEN', this.user.role === 'viewer' ? 'You have read-only access' : 'Only an admin can do this');
    }
    return this.user;
  }

  private withName(inv: Omit<Invoice, 'counterpartyName'>): Invoice {
    const cp = this.state.counterparties.find((c) => c.id === inv.counterpartyId);
    return { ...inv, counterpartyName: cp?.name ?? '' };
  }

  private find(id: string) {
    const inv = this.state.invoices.find((i) => i.id === id);
    if (!inv) throw new DomainError('NOT_FOUND', 'Invoice not found');
    return inv;
  }

  private log(invoiceId: string | null, action: string, summary: string) {
    this.state.activity.unshift({
      id: newId(), invoiceId, action, summary, actorName: this.user?.fullName ?? 'System', createdAt: new Date().toISOString(),
    });
    this.state.activity = this.state.activity.slice(0, 500);
  }

  private label(inv: Omit<Invoice, 'counterpartyName'>) {
    return `${inv.type} invoice ${inv.invoiceNumber} · ${this.withName(inv).counterpartyName}`;
  }

  /** 依名稱找到往來對象，不存在則新增（與 Supabase 實作相同行為）。 */
  private ensureCounterparty(kind: CounterpartyKind, name: string): Counterparty {
    const clean = name.trim().replace(/\s+/g, ' ');
    const existing = this.state.counterparties.find((c) => c.kind === kind && normalizeName(c.name) === normalizeName(clean));
    if (existing) return existing;
    const created = { id: newId(), kind, name: clean };
    this.state.counterparties.push(created);
    return created;
  }

  // ---------- 身分驗證 ----------

  async currentUser() {
    return this.delay(this.user);
  }

  async signIn(email: string, password: string) {
    const u = DEMO_USERS.find((d) => d.email.toLowerCase() === email.trim().toLowerCase() && d.password === password);
    if (!u) throw new DomainError('FORBIDDEN', 'Incorrect email or password');
    const { password: _pw, description: _d, ...profile } = u;
    this.user = profile;
    this.store.setItem(DemoRepository.USER_KEY, u.id);
    return this.delay(profile);
  }

  async signOut() {
    this.user = null;
    this.store.removeItem(DemoRepository.USER_KEY);
  }

  // ---------- 讀取 ----------

  today() {
    return this.todayFn();
  }

  async listInvoices() {
    this.require();
    return this.delay(this.state.invoices.map((i) => this.withName(i)));
  }

  async listCounterparties(kind?: CounterpartyKind) {
    this.require();
    return this.delay(this.state.counterparties.filter((c) => !kind || c.kind === kind).sort((a, b) => a.name.localeCompare(b.name)));
  }

  async listActivity({ limit = 10, invoiceId }: { limit?: number; invoiceId?: string } = {}) {
    this.require();

    const rows = this.state.activity
      .filter((a) => !invoiceId || a.invoiceId === invoiceId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
    return this.delay(rows);
  }

  // ---------- 寫入 ----------

  async createInvoice(type: InvoiceType, v: InvoiceFormValues) {
    const user = this.require('admin', 'finance');
    assertNotDuplicate(this.state.invoices.map((i) => this.withName(i)), { type, invoiceNumber: v.invoiceNumber, counterpartyName: v.counterpartyName });
    const cp = this.ensureCounterparty(kindForType(type), v.counterpartyName);
    const now = new Date().toISOString();
    const inv: Omit<Invoice, 'counterpartyName'> = {
      id: newId(), type, invoiceNumber: v.invoiceNumber.trim(), counterpartyId: cp.id, invoiceDate: v.invoiceDate, dueDate: v.dueDate,
      description: v.description, invoiceAmount: v.invoiceAmount, taxAmount: v.taxAmount,
      approvalStatus: type === 'AP' ? 'pending' : null, // 新 AP 帳單一律從待審批開始
      isCancelled: false, cancelReason: '', createdAt: now, updatedAt: now, createdByName: user.fullName, payments: [],
    };
    this.state.invoices.push(inv);
    this.log(inv.id, 'invoice.created', `Created ${this.label(inv)} · ${formatMYR(inv.invoiceAmount + inv.taxAmount)}`);
    this.commit();
    return this.delay(this.withName(inv));
  }

  async updateInvoice(id: string, v: InvoiceFormValues) {
    this.require('admin', 'finance');
    const inv = this.find(id);
    assertNotDuplicate(this.state.invoices.map((i) => this.withName(i)), { id, type: inv.type, invoiceNumber: v.invoiceNumber, counterpartyName: v.counterpartyName });
    const paid = inv.payments.reduce((t, p) => t + p.amount, 0);
    assertTotalCoversPaid(v.invoiceAmount + v.taxAmount, paid);
    const cp = this.ensureCounterparty(kindForType(inv.type), v.counterpartyName);
    Object.assign(inv, {
      invoiceNumber: v.invoiceNumber.trim(), counterpartyId: cp.id, invoiceDate: v.invoiceDate, dueDate: v.dueDate,
      description: v.description, invoiceAmount: v.invoiceAmount, taxAmount: v.taxAmount, updatedAt: new Date().toISOString(),
    });
    this.log(inv.id, 'invoice.updated', `Updated ${this.label(inv)}`);
    this.commit();
    return this.delay(this.withName(inv));
  }

  async setApproval(id: string, status: ApprovalStatus) {
    this.require('admin');
    const inv = this.find(id);
    if (inv.type !== 'AP') throw new DomainError('VALIDATION', 'Only supplier invoices need approval');
    if (inv.approvalStatus === status) return;
    if (inv.approvalStatus === 'approved' && inv.payments.length > 0) {
      throw new DomainError('HAS_PAYMENTS', 'Cannot change approval of an invoice that already has payments');
    }
    inv.approvalStatus = status;
    inv.updatedAt = new Date().toISOString();
    this.log(inv.id, `invoice.${status}`, `${status.charAt(0).toUpperCase()}${status.slice(1)} ${this.label(inv)}`);
    this.commit();
  }

  async cancelInvoice(id: string, reason: string) {
    this.require('admin', 'finance');
    const inv = this.find(id);
    if (inv.isCancelled) return;
    assertCanCancel(computeInvoice(this.withName(inv), this.today()));
    inv.isCancelled = true;
    inv.cancelReason = reason.trim();
    inv.updatedAt = new Date().toISOString();
    this.log(inv.id, 'invoice.cancelled', `Cancelled ${this.label(inv)}`);
    this.commit();
  }

  async restoreInvoice(id: string) {
    this.require('admin', 'finance');
    const inv = this.find(id);
    if (!inv.isCancelled) return;
    inv.isCancelled = false;
    inv.cancelReason = '';
    inv.updatedAt = new Date().toISOString();
    this.log(inv.id, 'invoice.restored', `Restored ${this.label(inv)}`);
    this.commit();
  }

  async deleteInvoice(id: string) {
    this.require('admin');
    const inv = this.find(id);
    if (inv.payments.length) throw new DomainError('HAS_PAYMENTS', 'This invoice has payments. Reverse the payments before deleting it.');
    this.state.invoices = this.state.invoices.filter((i) => i.id !== id);
    this.state.activity.forEach((a) => { if (a.invoiceId === id) a.invoiceId = null; });
    this.log(null, 'invoice.deleted', `Deleted ${this.label(inv)}`);
    this.commit();
  }

  async recordPayment(invoiceId: string, v: PaymentFormValues) {
    const user = this.require('admin', 'finance');
    const inv = this.find(invoiceId);
    assertCanRecordPayment(computeInvoice(this.withName(inv), this.today()), v.amount);
    inv.payments.push({
      id: newId(), invoiceId, paymentDate: v.paymentDate, amount: v.amount, method: v.method, reference: v.reference,
      notes: v.notes, createdAt: new Date().toISOString(), createdByName: user.fullName,
    });
    inv.payments.sort((a, b) => a.paymentDate.localeCompare(b.paymentDate));
    this.log(inv.id, 'payment.recorded', `${inv.type === 'AR' ? 'Collected' : 'Paid'} ${formatMYR(v.amount)} on ${this.label(inv)}`);
    this.commit();
  }

  async reversePayment(paymentId: string) {
    this.require('admin');
    const inv = this.state.invoices.find((i) => i.payments.some((p) => p.id === paymentId));
    if (!inv) throw new DomainError('NOT_FOUND', 'Payment not found');
    const p = inv.payments.find((x) => x.id === paymentId)!;
    inv.payments = inv.payments.filter((x) => x.id !== paymentId);
    this.log(inv.id, 'payment.reversed', `Reversed ${inv.type === 'AR' ? 'collection of' : 'payment of'} ${formatMYR(p.amount)} on ${this.label(inv)}`);
    this.commit();
  }

  async addAttachment(invoiceId: string, attachment: Attachment) {
    this.require('admin', 'finance');
    const inv = this.find(invoiceId);
    inv.attachments = [...(inv.attachments ?? []).filter((a) => a.id !== attachment.id), attachment];
    inv.updatedAt = new Date().toISOString();
    this.log(inv.id, 'attachment.added', `Attached ${attachment.name} to ${this.label(inv)}`);
    this.commit();
  }

  async removeAttachment(invoiceId: string, attachmentId: string) {
    this.require('admin', 'finance');
    const inv = this.find(invoiceId);
    const att = (inv.attachments ?? []).find((a) => a.id === attachmentId);
    if (!att) return;
    inv.attachments = (inv.attachments ?? []).filter((a) => a.id !== attachmentId);
    inv.updatedAt = new Date().toISOString();
    this.log(inv.id, 'attachment.removed', `Removed attachment ${att.name} from ${this.label(inv)}`);
    this.commit();
  }

  async resetDemoData() {
    this.state = buildInitialDemoState(this.todayFn());
    this.save();
  }

  // ---------- 本機資料管理（備份／還原／清空）----------

  /** 清除所有資料（含範例），從空白開始使用自己的資料。 */
  async clearAllData() {
    this.require('admin');
    this.state = { version: STATE_VERSION, counterparties: [], invoices: [], activity: [], isSample: false, modifiedAt: new Date().toISOString() };
    this.save();
  }

  /** 產生備份檔內容（JSON 文字）。 */
  exportBackup(): string {
    this.require();
    const file: BackupFile = { app: 'invoice-ap-ar', version: STATE_VERSION, exportedAt: new Date().toISOString(), data: this.state };
    this.store.setItem(DemoRepository.BACKUP_KEY, file.exportedAt);
    return JSON.stringify(file, null, 1);
  }

  /** 由備份檔還原；格式不正確時拋出錯誤，原有資料不受影響。 */
  async importBackup(text: string) {
    this.require('admin');
    let file: BackupFile;
    try {
      file = JSON.parse(text) as BackupFile;
    } catch {
      throw new DomainError('VALIDATION', 'This file is not a valid backup (it is not JSON).');
    }
    const d = file?.data;
    const ok = file?.app === 'invoice-ap-ar' && d && Array.isArray(d.invoices) && Array.isArray(d.counterparties) && Array.isArray(d.activity)
      && d.invoices.every((i) => typeof i.id === 'string' && (i.type === 'AP' || i.type === 'AR') && Number.isInteger(i.invoiceAmount)
        && Number.isInteger(i.taxAmount) && Array.isArray(i.payments) && i.payments.every((p) => Number.isInteger(p.amount)));
    if (!ok) throw new DomainError('VALIDATION', 'This file is not a backup from this system.');
    if (file.version > STATE_VERSION) throw new DomainError('VALIDATION', 'This backup was made by a newer version of the system.');
    this.state = { ...d, version: STATE_VERSION };
    this.save();
    this.store.setItem(DemoRepository.BACKUP_KEY, file.exportedAt);
  }

  /** 本機資料狀態（畫面提醒用）。 */
  dataStatus() {
    return {
      isSample: this.state.isSample !== false,
      invoiceCount: this.state.invoices.length,
      modifiedAt: this.state.modifiedAt ?? null,
      lastBackupAt: this.store.getItem(DemoRepository.BACKUP_KEY),
    };
  }
}

/** localStorage 在私密瀏覽等情況可能無法使用，失敗時改用記憶體儲存。 */
function safeStore(ls: Storage): KeyValueStore {
  const fallback = memoryStore();
  return {
    getItem: (k) => { try { return ls.getItem(k); } catch { return fallback.getItem(k); } },
    setItem: (k, v) => { try { ls.setItem(k, v); } catch { fallback.setItem(k, v); } },
    removeItem: (k) => { try { ls.removeItem(k); } catch { fallback.removeItem(k); } },
  };
}

export { memoryStore };

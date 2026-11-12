/**
 * Supabase 正式資料來源（Supabase repository）
 *
 * - 透過 supabase-js 呼叫 PostgREST API，權限由資料庫 RLS 控管。
 * - 業務規則（超額付款、重複號碼、審批）由資料庫觸發器強制執行；
 *   這裡負責把資料庫錯誤轉為清楚的使用者訊息。
 * - 資料庫金額為 numeric（令吉），進出時轉換為整數仙。
 */
import type { PostgrestError, SupabaseClient } from '@supabase/supabase-js';
import { todayIso } from '@/domain/dates';
import { fromSen, toSen } from '@/domain/money';
import type { ActivityEntry, ApprovalStatus, Counterparty, CounterpartyKind, Invoice, InvoiceType, Payment, UserProfile } from '@/domain/types';
import { kindForType } from '@/domain/types';
import { DomainError, normalizeName, type InvoiceFormValues, type PaymentFormValues } from '@/domain/validation';
import type { Repository } from './repository';

// ---------- 資料庫列型別 ----------
interface PaymentRow {
  id: string; invoice_id: string; payment_date: string; amount: number | string; method: string;
  reference: string; notes: string; created_at: string;
}
interface InvoiceRow {
  id: string; invoice_type: InvoiceType; invoice_number: string; counterparty_id: string;
  invoice_date: string; due_date: string; description: string; invoice_amount: number | string; tax_amount: number | string;
  approval_status: ApprovalStatus | null; is_cancelled: boolean; cancel_reason: string; created_at: string; updated_at: string;
  counterparty: { name: string } | null;
  payments: PaymentRow[];
}

const INVOICE_SELECT = '*, counterparty:counterparties(name), payments(*)';
const PAGE_SIZE = 1000; // PostgREST 預設單次最多回傳 1000 筆

/** 資料庫金額 → 整數仙。 */
const sen = (v: number | string) => toSen(v) ?? 0;

function mapPayment(p: PaymentRow): Payment {
  return {
    id: p.id, invoiceId: p.invoice_id, paymentDate: p.payment_date, amount: sen(p.amount), method: p.method,
    reference: p.reference, notes: p.notes, createdAt: p.created_at, createdByName: null,
  };
}

function mapInvoice(r: InvoiceRow): Invoice {
  return {
    id: r.id, type: r.invoice_type, invoiceNumber: r.invoice_number, counterpartyId: r.counterparty_id,
    counterpartyName: r.counterparty?.name ?? '', invoiceDate: r.invoice_date, dueDate: r.due_date, description: r.description,
    invoiceAmount: sen(r.invoice_amount), taxAmount: sen(r.tax_amount), approvalStatus: r.approval_status,
    isCancelled: r.is_cancelled, cancelReason: r.cancel_reason, createdAt: r.created_at, updatedAt: r.updated_at,
    createdByName: null, payments: (r.payments ?? []).map(mapPayment).sort((a, b) => a.paymentDate.localeCompare(b.paymentDate)),
  };
}

/** 將 PostgreSQL / PostgREST 錯誤轉為使用者看得懂的 DomainError。 */
export function toDomainError(error: PostgrestError | Error): DomainError {
  const code = 'code' in error ? error.code : '';
  const msg = error.message ?? 'Unexpected error';
  if (code === '23505') {
    if (msg.includes('invoices_ar_number_uq')) return new DomainError('DUPLICATE_INVOICE', 'This invoice number already exists', 'invoiceNumber');
    if (msg.includes('invoices_ap_number_uq')) return new DomainError('DUPLICATE_INVOICE', 'This supplier already has an invoice with this number', 'invoiceNumber');
    return new DomainError('DUPLICATE_INVOICE', 'This record already exists');
  }
  if (code === '42501' || /row-level security|permission denied/i.test(msg)) {
    return new DomainError('FORBIDDEN', /Only an admin/.test(msg) ? msg : 'You do not have permission to do this');
  }
  if (code === '23503') return new DomainError('HAS_PAYMENTS', 'This invoice has payments. Reverse the payments first.');
  if (code === '23514') return new DomainError('VALIDATION', 'Some values are not allowed. Please check the form.');
  if (/exceeds the outstanding/.test(msg)) return new DomainError('OVERPAYMENT', msg, 'amount');
  if (/must be approved/.test(msg)) return new DomainError('NOT_APPROVED', msg);
  if (/cancelled invoice/.test(msg)) return new DomainError('CANCELLED', msg);
  if (/cannot be less than/.test(msg)) return new DomainError('TOTAL_BELOW_PAID', msg, 'invoiceAmount');
  if (/has payments/.test(msg)) return new DomainError('HAS_PAYMENTS', msg);
  if (code === 'P0001') return new DomainError('VALIDATION', msg);
  return new DomainError('VALIDATION', msg);
}

function check<T>(res: { data: T; error: PostgrestError | null }): T {
  if (res.error) throw toDomainError(res.error);
  return res.data;
}

export class SupabaseRepository implements Repository {
  readonly mode = 'supabase' as const;

  constructor(private readonly db: SupabaseClient) {}

  // ---------- 身分驗證 ----------

  private async loadProfile(userId: string, email: string): Promise<UserProfile> {
    const { data, error } = await this.db.from('profiles').select('id, email, full_name, role').eq('id', userId).maybeSingle();
    if (error) throw toDomainError(error);
    if (!data) throw new DomainError('FORBIDDEN', 'Your account has no profile yet. Ask an admin to set it up.');
    return { id: data.id, email: data.email || email, fullName: data.full_name || email, role: data.role };
  }

  async currentUser() {
    const { data } = await this.db.auth.getSession();
    const u = data.session?.user;
    return u ? this.loadProfile(u.id, u.email ?? '') : null;
  }

  async signIn(email: string, password: string) {
    const { data, error } = await this.db.auth.signInWithPassword({ email: email.trim(), password });
    if (error || !data.user) throw new DomainError('FORBIDDEN', error?.message === 'Invalid login credentials' ? 'Incorrect email or password' : (error?.message ?? 'Sign-in failed'));
    return this.loadProfile(data.user.id, data.user.email ?? '');
  }

  async signOut() {
    await this.db.auth.signOut();
  }

  // ---------- 讀取 ----------

  today() {
    return todayIso();
  }

  async listInvoices() {
    // 分頁讀取，確保超過 1000 筆時也能取得全部資料
    const all: Invoice[] = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      const rows = check(await this.db.from('invoices').select(INVOICE_SELECT)
        .order('invoice_date', { ascending: false }).order('id').range(from, from + PAGE_SIZE - 1)) as unknown as InvoiceRow[];
      all.push(...rows.map(mapInvoice));
      if (rows.length < PAGE_SIZE) break;
    }
    return all;
  }

  async listCounterparties(kind?: CounterpartyKind) {
    let q = this.db.from('counterparties').select('id, kind, name').order('name');
    if (kind) q = q.eq('kind', kind);
    return check(await q) as Counterparty[];
  }

  async listActivity({ limit = 10, invoiceId }: { limit?: number; invoiceId?: string } = {}) {
    let q = this.db.from('activity_log').select('id, invoice_id, action, summary, actor_name, created_at')
      .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(limit);
    if (invoiceId) q = q.eq('invoice_id', invoiceId);
    const rows = check(await q) as { id: number; invoice_id: string | null; action: string; summary: string; actor_name: string | null; created_at: string }[];
    return rows.map((r): ActivityEntry => ({
      id: String(r.id), invoiceId: r.invoice_id, action: r.action, summary: r.summary, actorName: r.actor_name, createdAt: r.created_at,
    }));
  }

  // ---------- 寫入 ----------

  /** 依名稱找出供應商／客戶，不存在則建立。 */
  private async ensureCounterparty(kind: CounterpartyKind, name: string): Promise<string> {
    const clean = name.trim().replace(/\s+/g, ' ');
    const list = await this.listCounterparties(kind);
    const found = list.find((c) => normalizeName(c.name) === normalizeName(clean));
    if (found) return found.id;
    const { data, error } = await this.db.from('counterparties').insert({ kind, name: clean }).select('id').single();
    if (error) {
      // 另一位使用者剛好同時建立了同名對象：重新查詢即可
      if (error.code === '23505') {
        const again = (await this.listCounterparties(kind)).find((c) => normalizeName(c.name) === normalizeName(clean));
        if (again) return again.id;
      }
      throw toDomainError(error);
    }
    return data.id as string;
  }

  private async getInvoice(id: string): Promise<Invoice> {
    const row = check(await this.db.from('invoices').select(INVOICE_SELECT).eq('id', id).single()) as unknown as InvoiceRow;
    return mapInvoice(row);
  }

  private invoicePayload(v: InvoiceFormValues, counterpartyId: string) {
    return {
      invoice_number: v.invoiceNumber.trim(), counterparty_id: counterpartyId, invoice_date: v.invoiceDate, due_date: v.dueDate,
      description: v.description, invoice_amount: fromSen(v.invoiceAmount), tax_amount: fromSen(v.taxAmount),
    };
  }

  async createInvoice(type: InvoiceType, v: InvoiceFormValues) {
    const counterpartyId = await this.ensureCounterparty(kindForType(type), v.counterpartyName);
    const payload = { ...this.invoicePayload(v, counterpartyId), invoice_type: type, approval_status: type === 'AP' ? 'pending' : null };
    const row = check(await this.db.from('invoices').insert(payload).select('id').single()) as { id: string };
    return this.getInvoice(row.id);
  }

  async updateInvoice(id: string, v: InvoiceFormValues) {
    const current = await this.getInvoice(id);
    const counterpartyId = await this.ensureCounterparty(kindForType(current.type), v.counterpartyName);
    check(await this.db.from('invoices').update(this.invoicePayload(v, counterpartyId)).eq('id', id).select('id').single());
    return this.getInvoice(id);
  }

  async setApproval(id: string, status: ApprovalStatus) {
    check(await this.db.from('invoices').update({ approval_status: status }).eq('id', id).select('id').single());
  }

  async cancelInvoice(id: string, reason: string) {
    check(await this.db.from('invoices').update({ is_cancelled: true, cancel_reason: reason.trim() }).eq('id', id).select('id').single());
  }

  async restoreInvoice(id: string) {
    check(await this.db.from('invoices').update({ is_cancelled: false }).eq('id', id).select('id').single());
  }

  async deleteInvoice(id: string) {
    const res = await this.db.from('invoices').delete().eq('id', id).select('id');
    const rows = check(res) as { id: string }[];
    if (!rows.length) throw new DomainError('FORBIDDEN', 'Only an admin can delete invoices');
  }

  async recordPayment(invoiceId: string, v: PaymentFormValues) {
    check(await this.db.from('payments').insert({
      invoice_id: invoiceId, payment_date: v.paymentDate, amount: fromSen(v.amount), method: v.method, reference: v.reference, notes: v.notes,
    }).select('id').single());
  }

  async reversePayment(paymentId: string) {
    const rows = check(await this.db.from('payments').delete().eq('id', paymentId).select('id')) as { id: string }[];
    if (!rows.length) throw new DomainError('FORBIDDEN', 'Only an admin can reverse payments');
  }
}

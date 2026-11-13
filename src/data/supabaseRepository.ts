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
import type { ActivityEntry, ApprovalStatus, CompanySettings, Counterparty, CounterpartyKind, Invoice, InvoiceType, Payment, PaymentKind, UserProfile } from '@/domain/types';
import { DEFAULT_SETTINGS } from '@/domain/types';
import { kindForType } from '@/domain/types';
import { DomainError, KIND_METHOD, normalizeName, type InvoiceFormValues, type PaymentFormValues } from '@/domain/validation';
import type { CounterpartyPatch, RecurrenceInput, Repository } from './repository';
import { validateTaskInput, type Task, type TaskCategory, type TaskInput, type TaskPriority, type TaskStatus } from '@/domain/tasks';
import { generateRecurringTasks, resetFutureOccurrences, type RecurrenceRule } from '@/domain/recurrence';
import type { Checklist } from '@/domain/checklists';
import type { StaffClaim } from '@/domain/claims';
import type { Note } from '@/domain/notes';

// ---------- 資料庫列型別 ----------
interface PaymentRow {
  id: string; invoice_id: string; payment_date: string; amount: number | string; method: string;
  reference: string; notes: string; created_at: string; kind?: PaymentKind;
}
interface CounterpartyRow {
  id: string; kind: CounterpartyKind; name: string; email: string | null; phone: string | null;
  contact_person: string; address: string; payment_terms_days: number | null; notes: string;
}
interface InvoiceRow {
  id: string; invoice_type: InvoiceType; invoice_number: string; counterparty_id: string;
  invoice_date: string; due_date: string; description: string; remarks?: string; invoice_amount: number | string; tax_amount: number | string;
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
    reference: p.reference, notes: p.notes, createdAt: p.created_at, createdByName: null, kind: p.kind ?? 'payment',
  };
}

function mapCounterparty(r: CounterpartyRow): Counterparty {
  return {
    id: r.id, kind: r.kind, name: r.name, email: r.email ?? '', phone: r.phone ?? '', contactPerson: r.contact_person ?? '',
    address: r.address ?? '', paymentTermsDays: r.payment_terms_days, notes: r.notes ?? '',
  };
}

function mapInvoice(r: InvoiceRow): Invoice {
  return {
    id: r.id, type: r.invoice_type, invoiceNumber: r.invoice_number, counterpartyId: r.counterparty_id,
    counterpartyName: r.counterparty?.name ?? '', invoiceDate: r.invoice_date, dueDate: r.due_date, description: r.description, remarks: r.remarks ?? '',
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
  if (/Only customer invoices can be written off/.test(msg)) return new DomainError('VALIDATION', msg);
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
    let q = this.db.from('counterparties').select('id, kind, name, email, phone, contact_person, address, payment_terms_days, notes').order('name');
    if (kind) q = q.eq('kind', kind);
    return (check(await q) as CounterpartyRow[]).map(mapCounterparty);
  }

  async updateCounterparty(id: string, patch: CounterpartyPatch) {
    const row: Record<string, unknown> = {};
    if (patch.name !== undefined) row.name = patch.name.trim().replace(/\s+/g, ' ');
    if (patch.email !== undefined) row.email = patch.email;
    if (patch.phone !== undefined) row.phone = patch.phone;
    if (patch.contactPerson !== undefined) row.contact_person = patch.contactPerson;
    if (patch.address !== undefined) row.address = patch.address;
    if (patch.paymentTermsDays !== undefined) row.payment_terms_days = patch.paymentTermsDays;
    if (patch.notes !== undefined) row.notes = patch.notes;
    const data = check(await this.db.from('counterparties').update(row).eq('id', id)
      .select('id, kind, name, email, phone, contact_person, address, payment_terms_days, notes').single()) as CounterpartyRow;
    return mapCounterparty(data);
  }

  async getSettings(): Promise<CompanySettings> {
    const r = check(await this.db.from('app_settings').select('*').eq('id', 1).maybeSingle()) as {
      company_name: string; opening_balance: number | string; opening_balance_date: string | null; default_terms_ar: number; default_terms_ap: number;
    } | null;
    if (!r) return { ...DEFAULT_SETTINGS };
    return { companyName: r.company_name, openingBalance: sen(r.opening_balance), openingBalanceDate: r.opening_balance_date, defaultTermsAR: r.default_terms_ar, defaultTermsAP: r.default_terms_ap };
  }

  async updateSettings(patch: Partial<CompanySettings>) {
    const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (patch.companyName !== undefined) row.company_name = patch.companyName;
    if (patch.openingBalance !== undefined) row.opening_balance = fromSen(patch.openingBalance);
    if (patch.openingBalanceDate !== undefined) row.opening_balance_date = patch.openingBalanceDate;
    if (patch.defaultTermsAR !== undefined) row.default_terms_ar = patch.defaultTermsAR;
    if (patch.defaultTermsAP !== undefined) row.default_terms_ap = patch.defaultTermsAP;
    check(await this.db.from('app_settings').update(row).eq('id', 1).select('id').single());
    return this.getSettings();
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
      description: v.description, remarks: v.remarks ?? '', invoice_amount: fromSen(v.invoiceAmount), tax_amount: fromSen(v.taxAmount),
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
      invoice_id: invoiceId, kind: v.kind ?? 'payment', payment_date: v.paymentDate, amount: fromSen(v.amount),
      method: (v.kind ?? 'payment') === 'payment' ? v.method : KIND_METHOD[v.kind as 'credit_note' | 'write_off'], reference: v.reference, notes: v.notes,
    }).select('id').single());
  }

  async reversePayment(paymentId: string) {
    const rows = check(await this.db.from('payments').delete().eq('id', paymentId).select('id')) as { id: string }[];
    if (!rows.length) throw new DomainError('FORBIDDEN', 'Only an admin can reverse payments');
  }

  // ---------- 每日工作與提醒中心 ----------

  async listTasks() {
    const all: Task[] = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      const rows = check(await this.db.from('tasks').select('*').order('due_date').order('id').range(from, from + PAGE_SIZE - 1)) as TaskRow[];
      all.push(...rows.map(mapTask));
      if (rows.length < PAGE_SIZE) break;
    }
    return all;
  }

  async listRecurrences() {
    return (check(await this.db.from('task_recurrences').select('*').order('created_at')) as RecurrenceRow[]).map(mapRecurrence);
  }

  async saveTask(input: TaskInput, id?: string) {
    const errors = validateTaskInput(input);
    const first = Object.entries(errors)[0];
    if (first) throw new DomainError('VALIDATION', first[1], first[0]);
    const row = {
      title: input.title.trim(), description: (input.description ?? '').trim(), category: input.category, priority: input.priority,
      start_date: input.startDate || null, due_date: input.dueDate, remarks: (input.remarks ?? '').trim(),
      ...(input.status ? { status: input.status } : {}),
    };
    const res = id
      ? await this.db.from('tasks').update(row).eq('id', id).select('*').single()
      : await this.db.from('tasks').insert({ ...row, id: crypto.randomUUID(), status: input.status ?? 'todo' }).select('*').single();
    return mapTask(check(res) as TaskRow);
  }

  async setTaskStatus(id: string, status: TaskStatus) {
    return mapTask(check(await this.db.from('tasks').update({ status }).eq('id', id).select('*').single()) as TaskRow);
  }

  async deleteTask(id: string) {
    const t = check(await this.db.from('tasks').select('*').eq('id', id).maybeSingle()) as TaskRow | null;
    if (!t) return;
    if (t.recurrence_id && t.occurrence_date) {
      const r = check(await this.db.from('task_recurrences').select('skip_dates').eq('id', t.recurrence_id).maybeSingle()) as { skip_dates: string[] } | null;
      if (r && !r.skip_dates.includes(t.occurrence_date)) {
        check(await this.db.from('task_recurrences').update({ skip_dates: [...r.skip_dates, t.occurrence_date] }).eq('id', t.recurrence_id).select('id'));
      }
    }
    check(await this.db.from('tasks').delete().eq('id', id).select('id'));
  }

  async saveRecurrence(input: RecurrenceInput, id?: string) {
    const row = recurrenceRow(input);
    let rule: RecurrenceRule;
    if (!id) {
      rule = mapRecurrence(check(await this.db.from('task_recurrences').insert(row).select('*').single()) as RecurrenceRow);
    } else {
      const cur = (await this.listRecurrences()).find((r) => r.id === id);
      if (!cur) throw new DomainError('NOT_FOUND', 'Recurring task not found');
      const reset = resetFutureOccurrences({ ...cur, ...input }, await this.listTasks(), this.today());
      if (reset.removedIds.length) check(await this.db.from('tasks').delete().in('id', reset.removedIds).select('id'));
      rule = mapRecurrence(check(await this.db.from('task_recurrences').update({ ...row, generated_through: reset.rule.generatedThrough, updated_at: new Date().toISOString() })
        .eq('id', id).select('*').single()) as RecurrenceRow);
    }
    await this.generateTasks();
    return rule;
  }

  async deleteRecurrence(id: string) {
    const cur = (await this.listRecurrences()).find((r) => r.id === id);
    if (!cur) return;
    const reset = resetFutureOccurrences(cur, await this.listTasks(), this.today());
    if (reset.removedIds.length) check(await this.db.from('tasks').delete().in('id', reset.removedIds).select('id'));
    check(await this.db.from('task_recurrences').delete().eq('id', id).select('id'));
  }

  async generateTasks() {
    const rules = await this.listRecurrences();
    if (!rules.length) return 0;
    const existing = new Set((await this.listTasks()).map((t) => t.id));
    const { tasks, rules: updated } = generateRecurringTasks(rules, existing, this.today(), new Date().toISOString());
    if (tasks.length) {
      // ON CONFLICT DO NOTHING：另一個裝置同時產生也不會重複
      check(await this.db.from('tasks').upsert(tasks.map(taskRow), { onConflict: 'id', ignoreDuplicates: true }).select('id'));
    }
    for (const r of updated) {
      const before = rules.find((x) => x.id === r.id);
      if (before?.generatedThrough !== r.generatedThrough) {
        check(await this.db.from('task_recurrences').update({ generated_through: r.generatedThrough }).eq('id', r.id).select('id'));
      }
    }
    return tasks.length;
  }

  // ---------- 薪資與月結檢查清單 ----------

  async listChecklists() {
    const rows = check(await this.db.from('checklists').select('*').order('month', { ascending: false })) as ChecklistRow[];
    return rows.map((r): Checklist => ({ id: r.id, kind: r.kind, month: r.month, items: r.items ?? [], remarks: r.remarks, dueDate: r.due_date, createdAt: r.created_at, updatedAt: r.updated_at }));
  }

  async saveChecklist(c: Checklist) {
    check(await this.db.from('checklists').upsert({ id: c.id, kind: c.kind, month: c.month, items: c.items, remarks: c.remarks, due_date: c.dueDate, updated_at: new Date().toISOString() }).select('id'));
    return c;
  }

  // ---------- 私人筆記（RLS：只有建立者本人可讀寫）----------

  notesAvailable() {
    return true; // 實際權限由資料庫決定（檢視者寫入會被拒絕，畫面上也會隱藏）
  }

  async listNotes() {
    const rows = check(await this.db.from('notes').select('*').order('updated_at', { ascending: false })) as NoteRow[];
    return rows.map((r): Note => ({ id: r.id, title: r.title, body: r.body, category: r.category, pinned: r.pinned, createdAt: r.created_at, updatedAt: r.updated_at }));
  }

  async saveNote(n: Note) {
    check(await this.db.from('notes').upsert({ id: n.id, title: n.title, body: n.body, category: n.category, pinned: n.pinned, updated_at: n.updatedAt }).select('id'));
  }

  async deleteNote(id: string) {
    check(await this.db.from('notes').delete().eq('id', id).select('id'));
  }

  // ---------- 員工報銷 ----------

  async listClaims() {
    const rows = check(await this.db.from('staff_claims').select('*').order('expense_date', { ascending: false })) as ClaimRow[];
    return rows.map(claimFromRow);
  }

  async saveClaims(claims: StaffClaim[]) {
    if (!claims.length) return;
    check(await this.db.from('staff_claims').upsert(claims.map(claimToRow)).select('id'));
  }

  async deleteClaim(id: string) {
    check(await this.db.from('staff_claims').delete().eq('id', id).select('id'));
  }
}

interface NoteRow { id: string; title: string; body: string; category: Note['category']; pinned: boolean; created_at: string; updated_at: string }

interface ClaimRow {
  id: string; claim_no: string; staff_name: string; expense_date: string; category: StaffClaim['category']; description: string; amount_sen: number | string;
  mileage_km: number | string | null; rate_per_km_sen: number | null; has_receipt: boolean; receipt: StaffClaim['receipt']; status: StaffClaim['status'];
  decided_on: string | null; reject_reason: string; paid_date: string | null; pay_method: StaffClaim['payMethod']; payment_ref: string; remarks: string;
  submitted_on: string; created_at: string; updated_at: string;
}
const claimFromRow = (r: ClaimRow): StaffClaim => ({
  id: r.id, claimNo: r.claim_no, staffName: r.staff_name, expenseDate: r.expense_date, category: r.category, description: r.description, amount: Number(r.amount_sen),
  mileageKm: r.mileage_km === null ? null : Number(r.mileage_km), ratePerKm: r.rate_per_km_sen, hasReceipt: r.has_receipt, receipt: r.receipt ?? null, status: r.status,
  decidedOn: r.decided_on, rejectReason: r.reject_reason, paidDate: r.paid_date, payMethod: r.pay_method, paymentRef: r.payment_ref, remarks: r.remarks,
  submittedOn: r.submitted_on, createdAt: r.created_at, updatedAt: r.updated_at,
});
const claimToRow = (c: StaffClaim) => ({
  id: c.id, claim_no: c.claimNo, staff_name: c.staffName, expense_date: c.expenseDate, category: c.category, description: c.description, amount_sen: c.amount,
  mileage_km: c.mileageKm, rate_per_km_sen: c.ratePerKm, has_receipt: c.hasReceipt, receipt: c.receipt, status: c.status, decided_on: c.decidedOn,
  reject_reason: c.rejectReason, paid_date: c.paidDate, pay_method: c.payMethod, payment_ref: c.paymentRef, remarks: c.remarks, submitted_on: c.submittedOn,
  updated_at: new Date().toISOString(),
});

interface ChecklistRow { id: string; kind: Checklist['kind']; month: string; items: Checklist['items']; remarks: string; due_date: string; created_at: string; updated_at: string }

// ---------- 任務列對應 ----------
interface TaskRow {
  id: string; title: string; description: string; category: TaskCategory; priority: TaskPriority; start_date: string | null; due_date: string;
  status: TaskStatus; remarks: string; completed_at: string | null; completed_on: string | null; recurrence_id: string | null;
  occurrence_date: string | null; created_at: string; updated_at: string;
}
interface RecurrenceRow {
  id: string; title: string; description: string; category: TaskCategory; priority: TaskPriority; remarks: string; frequency: RecurrenceRule['frequency'];
  interval: number; custom_unit: RecurrenceRule['customUnit']; weekdays: number[]; day_of_month: number; month: number;
  weekend_adjust: RecurrenceRule['weekendAdjust']; lead_days: number; start_date: string; end_date: string | null; active: boolean;
  generated_through: string | null; skip_dates: string[]; created_at: string; updated_at: string;
}
function mapTask(r: TaskRow): Task {
  return {
    id: r.id, title: r.title, description: r.description, category: r.category, priority: r.priority, startDate: r.start_date, dueDate: r.due_date,
    status: r.status, remarks: r.remarks, createdAt: r.created_at, updatedAt: r.updated_at, completedAt: r.completed_at, completedOn: r.completed_on,
    recurrenceId: r.recurrence_id, occurrenceDate: r.occurrence_date,
  };
}
function taskRow(t: Task) {
  return {
    id: t.id, title: t.title, description: t.description, category: t.category, priority: t.priority, start_date: t.startDate, due_date: t.dueDate,
    status: t.status, remarks: t.remarks, recurrence_id: t.recurrenceId, occurrence_date: t.occurrenceDate,
  };
}
function mapRecurrence(r: RecurrenceRow): RecurrenceRule {
  return {
    id: r.id, title: r.title, description: r.description, category: r.category, priority: r.priority, remarks: r.remarks, frequency: r.frequency,
    interval: r.interval, customUnit: r.custom_unit, weekdays: r.weekdays ?? [], dayOfMonth: r.day_of_month, month: r.month, weekendAdjust: r.weekend_adjust,
    leadDays: r.lead_days, startDate: r.start_date, endDate: r.end_date, active: r.active, generatedThrough: r.generated_through, skipDates: r.skip_dates ?? [],
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function recurrenceRow(i: RecurrenceInput) {
  return {
    title: i.title.trim(), description: i.description, category: i.category, priority: i.priority, remarks: i.remarks, frequency: i.frequency,
    interval: i.interval, custom_unit: i.customUnit, weekdays: i.weekdays, day_of_month: i.dayOfMonth, month: i.month, weekend_adjust: i.weekendAdjust,
    lead_days: i.leadDays, start_date: i.startDate, end_date: i.endDate, active: i.active,
  };
}

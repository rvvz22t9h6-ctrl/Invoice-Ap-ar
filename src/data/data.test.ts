/**
 * 資料層測試：示範模式的權限與業務規則必須與資料庫一致。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { buildDashboard } from '@/domain/dashboard';
import { computeInvoices } from '@/domain/invoice';
import { invoiceFormSchema, paymentFormSchema } from '@/domain/validation';
import { DemoRepository, memoryStore } from './demoRepository';
import { newChecklist, toggleItem } from '@/domain/checklists';
import { approveClaim, newClaim, payClaim, validateClaim } from '@/domain/claims';
import { toDomainError } from './supabaseRepository';

const TODAY = '2026-11-12';
const form = (over: Record<string, string> = {}) => invoiceFormSchema.parse({
  invoiceNumber: 'TEST-1', counterpartyName: 'New Supplier Sdn Bhd', invoiceDate: '2026-11-01', dueDate: '2026-12-01',
  description: 'Test', invoiceAmount: '1000', taxAmount: '80', ...over,
});
const payment = (amount: string) => paymentFormSchema(TODAY).parse({ paymentDate: TODAY, amount, method: 'FPX' });

let repo: DemoRepository;
beforeEach(() => {
  repo = new DemoRepository(memoryStore(), () => TODAY, 0);
});

describe('DemoRepository', () => {
  it('requires sign-in and rejects bad credentials', async () => {
    await expect(repo.listInvoices()).rejects.toThrow(/sign in/);
    await expect(repo.signIn('admin@demo.my', 'wrong')).rejects.toThrow(/Incorrect/);
    const u = await repo.signIn('ADMIN@demo.my', 'demo1234');
    expect(u.role).toBe('admin');
    expect((await repo.currentUser())?.email).toBe('admin@demo.my');
  });

  it('loads realistic sample data whose dashboard figures are computed, not hard-coded', async () => {
    await repo.signIn('boss@demo.my', 'demo1234');
    const invoices = await repo.listInvoices();
    expect(invoices.length).toBeGreaterThan(100);
    const d = buildDashboard(computeInvoices(invoices, TODAY), TODAY);
    expect(d.AR.outstanding).toBeGreaterThan(0);
    expect(d.AP.overdue).toBeGreaterThan(0);
    expect(d.AR.settled).toBeGreaterThan(0);
    // 未付總額必須等於逐張加總
    const manual = computeInvoices(invoices, TODAY).filter((i) => i.type === 'AR').reduce((t, i) => t + i.outstandingBalance, 0);
    expect(d.AR.outstanding).toBe(manual);
    expect((await repo.listActivity()).length).toBe(10);
  });

  it('viewer is read-only', async () => {
    await repo.signIn('boss@demo.my', 'demo1234');
    await expect(repo.createInvoice('AR', form())).rejects.toThrow(/read-only/);
    const [first] = await repo.listInvoices();
    await expect(repo.recordPayment(first!.id, payment('1'))).rejects.toThrow(/read-only/);
  });

  it('finance creates invoices (AP starts pending) but cannot approve, delete or reverse', async () => {
    await repo.signIn('finance@demo.my', 'demo1234');
    const bill = await repo.createInvoice('AP', form());
    expect(bill.approvalStatus).toBe('pending');
    expect(bill.counterpartyName).toBe('New Supplier Sdn Bhd');
    await expect(repo.recordPayment(bill.id, payment('10'))).rejects.toThrow(/approved/);
    await expect(repo.setApproval(bill.id, 'approved')).rejects.toThrow(/admin/);
    await expect(repo.deleteInvoice(bill.id)).rejects.toThrow(/admin/);
  });

  it('blocks duplicates: AR globally, AP per supplier', async () => {
    await repo.signIn('finance@demo.my', 'demo1234');
    await repo.createInvoice('AR', form({ invoiceNumber: 'AR-DUP', counterpartyName: 'Cust A' }));
    await expect(repo.createInvoice('AR', form({ invoiceNumber: 'ar-dup', counterpartyName: 'Cust B' }))).rejects.toThrow(/already exists/);
    await repo.createInvoice('AP', form({ invoiceNumber: 'X-1', counterpartyName: 'Sup A' }));
    await repo.createInvoice('AP', form({ invoiceNumber: 'X-1', counterpartyName: 'Sup B' }));
    await expect(repo.createInvoice('AP', form({ invoiceNumber: 'x-1', counterpartyName: 'sup a' }))).rejects.toThrow(/already exists/);
  });

  it('full payment flow with partial payments, overpayment guard, reversal and audit log', async () => {
    await repo.signIn('admin@demo.my', 'demo1234');
    const bill = await repo.createInvoice('AP', form({ invoiceNumber: 'FLOW-1' }));
    await repo.setApproval(bill.id, 'approved');
    await repo.recordPayment(bill.id, payment('500'));
    let [c] = computeInvoices((await repo.listInvoices()).filter((i) => i.id === bill.id), TODAY);
    expect(c!.status).toBe('Partially Paid');
    expect(c!.outstandingBalance).toBe(58_000);
    await expect(repo.recordPayment(bill.id, payment('580.01'))).rejects.toThrow(/exceeds/);
    await expect(repo.cancelInvoice(bill.id, 'x')).rejects.toThrow(/Reverse the payments/);
    await expect(repo.setApproval(bill.id, 'rejected')).rejects.toThrow(/already has payments/);
    await expect(repo.updateInvoice(bill.id, form({ invoiceNumber: 'FLOW-1', invoiceAmount: '400', taxAmount: '0' }))).rejects.toThrow(/cannot be less/);
    await repo.recordPayment(bill.id, payment('580'));
    [c] = computeInvoices((await repo.listInvoices()).filter((i) => i.id === bill.id), TODAY);
    expect(c!.status).toBe('Paid');

    await repo.reversePayment(c!.payments[1]!.id);
    [c] = computeInvoices((await repo.listInvoices()).filter((i) => i.id === bill.id), TODAY);
    expect(c!.outstandingBalance).toBe(58_000);

    const log = await repo.listActivity({ invoiceId: bill.id, limit: 20 });
    expect(log.map((a) => a.action)).toEqual(['payment.reversed', 'payment.recorded', 'payment.recorded', 'invoice.approved', 'invoice.created']);
    expect(log[0]!.summary).toBe('Reversed payment of RM 580.00 on AP invoice FLOW-1 · New Supplier Sdn Bhd');
    expect(log[0]!.actorName).toMatch(/Mei Ling/);
  });

  it('cancel, restore and delete an unpaid invoice', async () => {
    await repo.signIn('admin@demo.my', 'demo1234');
    const inv = await repo.createInvoice('AR', form({ invoiceNumber: 'DEL-1' }));
    await repo.cancelInvoice(inv.id, 'Wrong customer');
    let found = (await repo.listInvoices()).find((i) => i.id === inv.id)!;
    expect([found.isCancelled, found.cancelReason]).toEqual([true, 'Wrong customer']);
    await repo.restoreInvoice(inv.id);
    found = (await repo.listInvoices()).find((i) => i.id === inv.id)!;
    expect(found.isCancelled).toBe(false);
    await repo.deleteInvoice(inv.id);
    expect((await repo.listInvoices()).some((i) => i.id === inv.id)).toBe(false);
  });

  it('persists changes and can reset to sample data', async () => {
    const store = memoryStore();
    const a = new DemoRepository(store, () => TODAY, 0);
    await a.signIn('finance@demo.my', 'demo1234');
    await a.createInvoice('AR', form({ invoiceNumber: 'KEEP-1' }));
    const b = new DemoRepository(store, () => TODAY, 0); // 模擬重新整理頁面
    expect((await b.currentUser())?.role).toBe('finance');
    expect((await b.listInvoices()).some((i) => i.invoiceNumber === 'KEEP-1')).toBe(true);
    await b.resetDemoData();
    expect((await b.listInvoices()).some((i) => i.invoiceNumber === 'KEEP-1')).toBe(false);
  });
});

describe('Local data: start fresh, backup and restore', () => {
  it('starts with sample data, can be cleared, and tracks changes', async () => {
    await repo.signIn('admin@demo.my', 'demo1234');
    expect(repo.dataStatus().isSample).toBe(true);
    await repo.clearAllData();
    expect(await repo.listInvoices()).toHaveLength(0);
    expect(repo.dataStatus()).toMatchObject({ isSample: false, invoiceCount: 0, lastBackupAt: null });
    await repo.createInvoice('AR', form({ invoiceNumber: 'REAL-1' }));
    expect(repo.dataStatus().invoiceCount).toBe(1);
    expect(repo.dataStatus().modifiedAt).not.toBeNull();
  });

  it('backup → clear → restore brings everything back exactly', async () => {
    await repo.signIn('admin@demo.my', 'demo1234');
    await repo.clearAllData();
    const inv = await repo.createInvoice('AR', form({ invoiceNumber: 'REAL-2' }));
    await repo.recordPayment(inv.id, payment('300'));
    const backup = repo.exportBackup();
    expect(repo.dataStatus().lastBackupAt).not.toBeNull();
    const before = await repo.listInvoices();
    await repo.clearAllData();
    expect(await repo.listInvoices()).toHaveLength(0);
    await repo.importBackup(backup);
    expect(await repo.listInvoices()).toEqual(before);
    expect((await repo.listActivity({ invoiceId: inv.id })).length).toBe(2);
  });

  it('rejects invalid backup files and keeps existing data', async () => {
    await repo.signIn('admin@demo.my', 'demo1234');
    const count = (await repo.listInvoices()).length;
    await expect(repo.importBackup('not json')).rejects.toThrow(/not a valid backup/);
    await expect(repo.importBackup(JSON.stringify({ app: 'other', data: {} }))).rejects.toThrow(/not a backup from this system/);
    const tampered = JSON.parse(repo.exportBackup());
    tampered.data.invoices[0].invoiceAmount = 12.5; // 金額必須是整數仙
    await expect(repo.importBackup(JSON.stringify(tampered))).rejects.toThrow(/not a backup/);
    expect((await repo.listInvoices()).length).toBe(count);
  });

  it('only admin can clear or restore', async () => {
    await repo.signIn('finance@demo.my', 'demo1234');
    await expect(repo.clearAllData()).rejects.toThrow(/admin/);
    await expect(repo.importBackup(repo.exportBackup())).rejects.toThrow(/admin/);
  });
});

describe('Attachments', () => {
  it('records and removes attachments, logs them and keeps them in backups', async () => {
    await repo.signIn('finance@demo.my', 'demo1234');
    const inv = await repo.createInvoice('AP', form({ invoiceNumber: 'ATT-1' }));
    const att = { id: 'a'.repeat(32), name: 'bill.pdf', contentType: 'application/pdf', sizeBytes: 1234, uploadedAt: '2026-11-12T00:00:00Z' };
    await repo.addAttachment(inv.id, att);
    expect((await repo.listInvoices()).find((i) => i.id === inv.id)!.attachments).toEqual([att]);
    expect((await repo.listActivity({ invoiceId: inv.id }))[0]!.summary).toBe('Attached bill.pdf to AP invoice ATT-1 · New Supplier Sdn Bhd');
    expect(JSON.parse(repo.exportBackup()).data.invoices.find((i: { id: string }) => i.id === inv.id).attachments).toHaveLength(1);
    await repo.removeAttachment(inv.id, att.id);
    expect((await repo.listInvoices()).find((i) => i.id === inv.id)!.attachments).toEqual([]);
  });

  it('viewer cannot attach', async () => {
    await repo.signIn('boss@demo.my', 'demo1234');
    const [first] = await repo.listInvoices();
    await expect(repo.addAttachment(first!.id, { id: 'x', name: 'x.pdf', contentType: 'application/pdf', sizeBytes: 1, uploadedAt: '' })).rejects.toThrow(/read-only/);
  });
});

describe('Contacts, settings and settlement types', () => {
  it('updates contact details and blocks duplicate names', async () => {
    await repo.signIn('finance@demo.my', 'demo1234');
    const [a, b] = await repo.listCounterparties('customer');
    const updated = await repo.updateCounterparty(a!.id, { contactPerson: 'Ms Tan', email: 'ap@example.com', paymentTermsDays: 45 });
    expect(updated).toMatchObject({ contactPerson: 'Ms Tan', paymentTermsDays: 45 });
    await expect(repo.updateCounterparty(a!.id, { name: b!.name.toUpperCase() })).rejects.toThrow(/already called/);
  });

  it('settings: sample has a company name; only admin can change', async () => {
    await repo.signIn('finance@demo.my', 'demo1234');
    expect((await repo.getSettings()).companyName).toBe('Sample Trading Sdn Bhd');
    await expect(repo.updateSettings({ companyName: 'X' })).rejects.toThrow(/admin/);
    await repo.signIn('admin@demo.my', 'demo1234');
    expect((await repo.updateSettings({ companyName: 'My Co Sdn Bhd', defaultTermsAR: 14 })).defaultTermsAR).toBe(14);
    expect((await repo.getSettings()).companyName).toBe('My Co Sdn Bhd');
  });

  it('records credit notes and write-offs with their own labels', async () => {
    await repo.signIn('admin@demo.my', 'demo1234');
    const inv = await repo.createInvoice('AR', form({ invoiceNumber: 'K-1' }));
    await repo.recordPayment(inv.id, paymentFormSchema(TODAY).parse({ kind: 'credit_note', paymentDate: TODAY, amount: '80', method: 'x' }));
    await repo.recordPayment(inv.id, paymentFormSchema(TODAY).parse({ kind: 'write_off', paymentDate: TODAY, amount: '1000', method: 'x' }));
    const [c] = computeInvoices((await repo.listInvoices()).filter((i) => i.id === inv.id), TODAY);
    expect(c!.status).toBe('Paid');
    expect(c!.payments.map((p) => [p.kind, p.method])).toEqual([['credit_note', 'Credit note'], ['write_off', 'Write-off']]);
    expect((await repo.listActivity({ invoiceId: inv.id })).map((a) => a.summary.split(' on ')[0])).toEqual(['Wrote off RM 1,000.00', 'Credit note RM 80.00', 'Created AR invoice K-1 · New Supplier Sdn Bhd · RM 1,080.00']);
  });
});

describe('Tasks and recurring tasks', () => {
  const ruleInput = (o: Record<string, unknown> = {}) => ({
    title: 'Pay EPF', description: '', category: 'Payroll' as const, priority: 'Urgent' as const, remarks: '', frequency: 'monthly' as const,
    interval: 1, customUnit: 'month' as const, weekdays: [], dayOfMonth: 15, month: 1, weekendAdjust: 'previous' as const, leadDays: 5,
    startDate: '2026-10-01', endDate: null, active: true, ...o,
  });

  // 範例資料含任務；這些測試從空白開始
  beforeEach(async () => {
    await repo.signIn('admin@demo.my', 'demo1234');
    await repo.clearAllData();
  });

  it('starts sample data with realistic tasks: some done, some overdue, no duplicates', async () => {
    await repo.resetDemoData();
    const tasks = await repo.listTasks();
    expect(tasks.length).toBeGreaterThan(20);
    expect(new Set(tasks.map((t) => t.id)).size).toBe(tasks.length);
    expect(tasks.some((t) => t.status === 'done')).toBe(true);
    expect(tasks.some((t) => t.status === 'todo' && t.dueDate < TODAY)).toBe(true);
    expect(await repo.generateTasks()).toBe(0);
  });

  it('creates, completes, reopens and deletes tasks', async () => {
    await repo.signIn('finance@demo.my', 'demo1234');
    const t = await repo.saveTask({ title: 'Call bank', category: 'Banking', priority: 'High', dueDate: TODAY });
    expect((await repo.setTaskStatus(t.id, 'done'))).toMatchObject({ status: 'done', completedOn: TODAY });
    expect((await repo.setTaskStatus(t.id, 'todo'))).toMatchObject({ status: 'todo', completedOn: null, completedAt: null });
    await expect(repo.saveTask({ title: '', category: 'Banking', priority: 'High', dueDate: TODAY })).rejects.toThrow(/Title is required/);
    await repo.deleteTask(t.id);
    expect(await repo.listTasks()).toHaveLength(0);
  });

  it('generates recurring tasks without duplicates, and deleted occurrences stay deleted', async () => {
    await repo.signIn('admin@demo.my', 'demo1234');
    const rule = await repo.saveRecurrence(ruleInput());
    const first = await repo.listTasks();
    expect(first.map((t) => t.dueDate)).toEqual(['2026-10-15', '2026-11-13']); // 11/15 是週日 → 提前到週五
    expect(await repo.generateTasks()).toBe(0);
    expect(await repo.generateTasks()).toBe(0);
    expect(await repo.listTasks()).toHaveLength(2);
    await repo.deleteTask(first[1]!.id);
    expect((await repo.listRecurrences())[0]!.skipDates).toEqual(['2026-11-15']);
    // 規則修改後重新產生，被刪除的日期也不會回來
    await repo.saveRecurrence(ruleInput({ priority: 'High' }), rule.id);
    expect((await repo.listTasks()).map((t) => t.dueDate)).toEqual(['2026-10-15']);
  });

  it('a rule change keeps overdue tasks with their original due dates', async () => {
    await repo.signIn('admin@demo.my', 'demo1234');
    const rule = await repo.saveRecurrence(ruleInput({ frequency: 'weekly', weekdays: [1], dayOfMonth: 0, startDate: '2026-11-01', weekendAdjust: 'none' }));
    const before = await repo.listTasks();
    expect(before.filter((t) => t.dueDate < TODAY).map((t) => t.dueDate)).toEqual(['2026-11-02', '2026-11-09']);
    await repo.saveRecurrence(ruleInput({ frequency: 'weekly', weekdays: [5], dayOfMonth: 0, startDate: '2026-11-01', weekendAdjust: 'none' }), rule.id);
    const after = await repo.listTasks();
    expect(after.filter((t) => t.dueDate < TODAY).map((t) => t.dueDate)).toEqual(['2026-11-02', '2026-11-09']); // 逾期保留
    expect(after.filter((t) => t.dueDate > TODAY).every((t) => new Date(`${t.dueDate}T00:00:00Z`).getUTCDay() === 5)).toBe(true);
    await repo.deleteRecurrence(rule.id);
    expect((await repo.listTasks()).map((t) => t.dueDate)).toEqual(['2026-11-02', '2026-11-09']); // 未來未開始的移除，逾期保留
  });

  it('viewer cannot change tasks and generation is skipped', async () => {
    await repo.signIn('boss@demo.my', 'demo1234');
    await expect(repo.saveTask({ title: 'x', category: 'AP', priority: 'Low', dueDate: TODAY })).rejects.toThrow(/read-only/);
    expect(await repo.generateTasks()).toBe(0);
  });
});

describe('Payroll and closing checklists', () => {
  it('saves one checklist per kind and month; viewer cannot save', async () => {
    await repo.signIn('finance@demo.my', 'demo1234');
    let c = newChecklist('payroll', '2026-11', '2026-11-12T00:00:00Z');
    c = toggleItem(c, 'epf', '2026-11-12T00:00:00Z');
    await repo.saveChecklist(c);
    await repo.saveChecklist(toggleItem(c, 'socso', '2026-11-12T01:00:00Z'));
    const all = await repo.listChecklists();
    expect(all).toHaveLength(1);
    expect(all[0]!.items.filter((i) => i.done).map((i) => i.key)).toEqual(['epf', 'socso']);
    await expect(repo.saveChecklist({ ...c, id: 'payroll-2026-12' })).rejects.toThrow(/Invalid/);
    await repo.signIn('boss@demo.my', 'demo1234');
    await expect(repo.saveChecklist(c)).rejects.toThrow(/read-only/);
  });

  it('keeps invoice remarks', async () => {
    await repo.signIn('finance@demo.my', 'demo1234');
    const inv = await repo.createInvoice('AR', form({ invoiceNumber: 'RM-1', remarks: 'Call on Friday' }));
    expect(inv.remarks).toBe('Call on Friday');
    expect((await repo.updateInvoice(inv.id, form({ invoiceNumber: 'RM-1', remarks: '' }))).remarks).toBe('');
  });
});

describe('Staff claims', () => {
  it('saves, updates in a batch and deletes claims; viewer cannot change them', async () => {
    await repo.signIn('finance@demo.my', 'demo1234');
    const before = (await repo.listClaims()).length;
    const v = validateClaim({ staffName: 'Ali', expenseDate: TODAY, category: 'Petrol', description: 'Fuel', amount: '50', mileageKm: '', ratePerKm: '', hasReceipt: true, remarks: '' }, TODAY);
    if (!v.ok) throw new Error('invalid');
    const a = newClaim(v.value, await repo.listClaims(), TODAY, new Date().toISOString(), 'claim-a');
    const b = newClaim(v.value, [a], TODAY, new Date().toISOString(), 'claim-b');
    expect(b.claimNo).not.toBe(a.claimNo);
    await repo.saveClaims([a, b]);
    expect(await repo.listClaims()).toHaveLength(before + 2);
    const paid = payClaim(approveClaim(a, TODAY, ''), { paidDate: TODAY, payMethod: 'With salary', paymentRef: '' }, '');
    await repo.saveClaims([paid, approveClaim(b, TODAY, '')]);
    const list = await repo.listClaims();
    expect(list.find((c) => c.id === 'claim-a')!.status).toBe('paid');
    expect(list.find((c) => c.id === 'claim-b')!.status).toBe('approved');
    await expect(repo.saveClaims([{ ...a, amount: 0 }])).rejects.toThrow(/Invalid/);
    await repo.deleteClaim('claim-b');
    expect((await repo.listClaims()).some((c) => c.id === 'claim-b')).toBe(false);
    await repo.signIn('boss@demo.my', 'demo1234');
    await expect(repo.saveClaims([a])).rejects.toThrow(/read-only/);
    await expect(repo.deleteClaim('claim-a')).rejects.toThrow(/read-only/);
  });
});

describe('Private notes (local mode)', () => {
  it('finance can save and delete notes; the viewer cannot use them', async () => {
    await repo.signIn('finance@demo.my', 'demo1234');
    const n = { id: 'n1', title: 'Petty cash', body: 'Float is RM 500', category: 'General' as const, pinned: true, createdAt: '', updatedAt: '' };
    await repo.saveNote(n);
    await repo.saveNote({ ...n, body: 'Float is RM 800' });
    expect(await repo.listNotes()).toEqual([{ ...n, body: 'Float is RM 800' }]);
    await expect(repo.saveNote({ ...n, title: '' })).rejects.toThrow(/Invalid/);
    await repo.signIn('boss@demo.my', 'demo1234');
    expect(repo.notesAvailable()).toBe(false);
    await expect(repo.listNotes()).rejects.toThrow();
    await repo.signIn('finance@demo.my', 'demo1234');
    await repo.deleteNote('n1');
    expect(await repo.listNotes()).toEqual([]);
  });
});

describe('Supabase error mapping', () => {
  it('turns database errors into user-friendly messages', () => {
    expect(toDomainError({ code: '23505', message: 'duplicate key value violates unique constraint "invoices_ar_number_uq"', details: '', hint: '', name: '' }).message)
      .toBe('This invoice number already exists');
    expect(toDomainError({ code: 'P0001', message: 'Amount exceeds the outstanding balance of RM 580.00', details: '', hint: '', name: '' }).code)
      .toBe('OVERPAYMENT');
    expect(toDomainError({ code: '42501', message: 'new row violates row-level security policy', details: '', hint: '', name: '' }).code)
      .toBe('FORBIDDEN');
  });
});

/**
 * 資料層測試：示範模式的權限與業務規則必須與資料庫一致。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { buildDashboard } from '@/domain/dashboard';
import { computeInvoices } from '@/domain/invoice';
import { invoiceFormSchema, paymentFormSchema } from '@/domain/validation';
import { DemoRepository, memoryStore } from './demoRepository';
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

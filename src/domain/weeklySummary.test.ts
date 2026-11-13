import { describe, expect, it } from 'vitest';
import { promiseStatus, validateFollowUp, latestFollowUp, type FollowUp } from './followups';
import { computeInvoices } from './invoice';
import type { Invoice } from './types';
import { buildWeeklySummary, weekRange, weeklySummaryText } from './weeklySummary';
import type { StaffClaim } from './claims';

const today = '2026-11-14'; // 星期六
const inv = (over: Partial<Invoice>): Invoice => ({
  id: 'i', type: 'AR', invoiceNumber: 'INV-1', counterpartyId: 'c1', counterpartyName: 'Alpha Sdn Bhd', invoiceDate: '2026-10-01', dueDate: '2026-10-31', description: '',
  invoiceAmount: 100_000, taxAmount: 0, approvalStatus: null, isCancelled: false, cancelReason: '', createdAt: '', updatedAt: '', createdByName: null, payments: [], ...over,
});
const pay = (id: string, date: string, amount: number, kind?: 'payment' | 'credit_note') => ({ id, invoiceId: 'i', paymentDate: date, amount, method: 'FPX', reference: '', notes: '', createdAt: '', createdByName: null, kind });
const fu = (over: Partial<FollowUp>): FollowUp => ({ id: 'f', date: '2026-11-10', contact: '', note: 'Called', promisedDate: null, nextDate: null, createdAt: '2026-11-10T00:00:00Z', ...over });

describe('follow-ups', () => {
  it('validates input', () => {
    const bad = validateFollowUp({ date: '2026-11-20', contact: '', note: ' ', promisedDate: 'x', nextDate: '' }, today);
    expect(!bad.ok && Object.keys(bad.errors).sort()).toEqual(['date', 'note', 'promisedDate']);
    const early = validateFollowUp({ date: '2026-11-12', contact: '', note: 'ok', promisedDate: '', nextDate: '2026-11-10' }, today);
    expect(!early.ok && early.errors.nextDate).toMatch(/after/);
    const ok = validateFollowUp({ date: '2026-11-12', contact: ' Aida ', note: ' Will pay ', promisedDate: '2026-11-20', nextDate: '' }, today);
    expect(ok.ok && ok.value).toEqual({ date: '2026-11-12', contact: 'Aida', note: 'Will pay', promisedDate: '2026-11-20', nextDate: null });
  });
  it('uses the latest promise and flags a missed one', () => {
    const list = [fu({ id: 'a', date: '2026-11-01', promisedDate: '2026-11-05' }), fu({ id: 'b', date: '2026-11-10', promisedDate: '2026-11-20' }), fu({ id: 'c', date: '2026-11-12' })];
    expect(latestFollowUp(list)!.id).toBe('c');
    expect(promiseStatus(list, today)).toEqual({ date: '2026-11-20', broken: false });
    expect(promiseStatus(list, '2026-11-21')).toEqual({ date: '2026-11-20', broken: true });
    expect(promiseStatus([], today)).toBeNull();
  });
});

describe('weekly summary', () => {
  it('weeks run Monday to Sunday', () => {
    expect(weekRange(today)).toEqual({ from: '2026-11-09', to: '2026-11-15' });
    expect(weekRange('2026-11-09')).toEqual({ from: '2026-11-09', to: '2026-11-15' });
    expect(weekRange(today, -1)).toEqual({ from: '2026-11-02', to: '2026-11-08' });
  });
  it('counts cash in the week only, excludes credit notes and cancelled invoices, and lists what comes next', () => {
    const invoices = computeInvoices([
      inv({ id: 'a', payments: [pay('p1', '2026-11-10', 40_000), pay('p2', '2026-11-03', 10_000), pay('p3', '2026-11-11', 5_000, 'credit_note')], followUps: [fu({ promisedDate: '2026-11-12' })] }),
      inv({ id: 'b', invoiceNumber: 'INV-2', counterpartyId: 'c2', counterpartyName: 'Beta Sdn Bhd', invoiceDate: '2026-11-12', dueDate: '2026-11-18', invoiceAmount: 30_000 }),
      inv({ id: 'x', invoiceNumber: 'INV-X', isCancelled: true, payments: [pay('p9', '2026-11-10', 99_000)] }),
      inv({ id: 'c', type: 'AP', invoiceNumber: 'B-1', counterpartyName: 'Supplier One', dueDate: '2026-11-17', invoiceAmount: 20_000, approvalStatus: 'approved', payments: [pay('p4', '2026-11-13', 5_000)] }),
      inv({ id: 'd', type: 'AP', invoiceNumber: 'B-2', counterpartyName: 'Supplier Two', dueDate: '2026-11-30', invoiceAmount: 7_000, approvalStatus: 'rejected' }),
    ], today);
    const claims = [{ status: 'paid', paidDate: '2026-11-12', amount: 1_500 }, { status: 'approved', paidDate: null, amount: 2_500 }, { status: 'paid', paidDate: '2026-10-01', amount: 9_999 }] as StaffClaim[];
    const s = buildWeeklySummary(invoices, claims, today);
    expect(s.collected).toEqual({ count: 1, total: 40_000 });
    expect(s.paid).toEqual({ count: 1, total: 5_000 });
    expect(s.claimsPaid).toEqual({ count: 1, total: 1_500 });
    expect(s.invoiced).toEqual({ count: 1, total: 30_000 });
    expect(s.arOutstanding.total).toBe(45_000 + 30_000);
    expect(s.arOverdue).toEqual({ count: 1, total: 45_000 });
    expect(s.apOutstanding).toEqual({ count: 1, total: 15_000 }); // 已退回的帳單不算
    expect(s.topOverdue).toEqual([{ name: 'Alpha Sdn Bhd', total: 45_000, count: 1, oldestDays: 14 }]);
    expect(s.promises).toEqual([{ name: 'Alpha Sdn Bhd', invoiceNumber: 'INV-1', amount: 45_000, date: '2026-11-12', broken: true }]);
    expect(s.next.apDue).toEqual({ count: 1, total: 15_000 });
    expect(s.next.arDue).toEqual({ count: 1, total: 30_000 });
    expect(s.next.claimsToPay).toEqual({ count: 1, total: 2_500 });
    const text = weeklySummaryText(s, 'Demo Co');
    expect(text).toContain('*Demo Co · Weekly finance summary*');
    expect(text).toContain('Collected from customers: RM 400.00 (1 payment)');
    expect(text).toContain('Alpha Sdn Bhd (INV-1): RM 450.00 by 12 Nov 2026 · NOT YET RECEIVED');
    expect(text).toContain('Supplier One (B-1): RM 150.00 due 17 Nov 2026');
    expect(buildWeeklySummary(invoices, claims, today, -1).collected).toEqual({ count: 1, total: 10_000 });
  });
});

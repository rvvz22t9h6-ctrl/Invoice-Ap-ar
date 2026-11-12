/**
 * 領域層單元測試：驗證所有會計公式、狀態判斷、帳齡與儀表板計算。
 */
import { describe, expect, it } from 'vitest';
import { agingBucket, buildAgingReport } from './aging';
import { buildDashboard } from './dashboard';
import { addDays, daysBetween, isValidIsoDate, lastNMonths, todayIso } from './dates';
import { computeInvoice, computeInvoices, dueDescription } from './invoice';
import { formatMYR, senToDecimalString, taxFromRate, toSen } from './money';
import { csvCell, invoicesToCsv } from './csv';
import {
  assertCanCancel, assertCanRecordPayment, assertNotDuplicate, assertTotalCoversPaid, DomainError,
  fieldErrors, findDuplicateInvoice, invoiceFormSchema, paymentFormSchema,
} from './validation';
import type { Invoice, Payment } from './types';

const TODAY = '2026-11-12';
let seq = 0;

function pay(amount: number, paymentDate = '2026-11-01'): Payment {
  seq += 1;
  return { id: `p${seq}`, invoiceId: 'x', paymentDate, amount, method: 'FPX', reference: '', notes: '', createdAt: '', createdByName: null };
}

function inv(over: Partial<Invoice> = {}): Invoice {
  seq += 1;
  return {
    id: `i${seq}`, type: 'AR', invoiceNumber: `INV-${seq}`, counterpartyId: 'c1', counterpartyName: 'Acme Sdn Bhd',
    invoiceDate: '2026-10-01', dueDate: '2026-11-30', description: '', invoiceAmount: 100_000, taxAmount: 8_000,
    approvalStatus: null, isCancelled: false, cancelReason: '', createdAt: '', updatedAt: '', createdByName: null, payments: [],
    ...over,
  };
}

describe('money', () => {
  it('converts ringgit to integer sen without float errors', () => {
    expect(toSen('1,234.50')).toBe(123_450);
    expect(toSen('RM 10')).toBe(1_000);
    expect(toSen('0.1')).toBe(10);
    expect(toSen(0.1 + 0.2)).toBe(30); // 0.30000000000000004 → 30 仙
    expect(toSen('12.345')).toBeNull();
    expect(toSen('abc')).toBeNull();
    expect(toSen('')).toBeNull();
  });
  it('formats MYR', () => {
    expect(formatMYR(123_450)).toBe('RM 1,234.50');
    expect(formatMYR(0)).toBe('RM 0.00');
    expect(formatMYR(-5_000)).toBe('-RM 50.00');
    expect(senToDecimalString(5)).toBe('0.05');
  });
  it('calculates SST tax with rounding', () => {
    expect(taxFromRate(100_000, 8)).toBe(8_000);
    expect(taxFromRate(12_345, 6)).toBe(741); // 740.7 → 741
  });
});

describe('dates', () => {
  it('validates real dates only', () => {
    expect(isValidIsoDate('2026-02-28')).toBe(true);
    expect(isValidIsoDate('2026-02-30')).toBe(false);
    expect(isValidIsoDate('12/11/2026')).toBe(false);
  });
  it('computes day differences and month lists', () => {
    expect(daysBetween('2026-10-31', '2026-11-12')).toBe(12);
    expect(addDays('2026-12-25', 10)).toBe('2027-01-04');
    expect(lastNMonths('2026-02-15', 3)).toEqual(['2025-12', '2026-01', '2026-02']);
  });
  it('uses the Malaysia time zone for "today"', () => {
    // 2026-11-11 20:00 UTC = 2026-11-12 04:00 馬來西亞時間
    expect(todayIso(new Date('2026-11-11T20:00:00Z'))).toBe('2026-11-12');
  });
});

describe('invoice calculations', () => {
  it('total = invoice amount + tax; outstanding = total − payments', () => {
    const c = computeInvoice(inv({ payments: [pay(30_000), pay(20_000)] }), TODAY);
    expect(c.totalAmount).toBe(108_000);
    expect(c.amountPaid).toBe(50_000);
    expect(c.outstandingBalance).toBe(58_000);
  });

  it('Pending: no payments and not yet due', () => {
    expect(computeInvoice(inv(), TODAY).status).toBe('Pending');
  });

  it('Pending on the due date itself (not overdue until the next day)', () => {
    const c = computeInvoice(inv({ dueDate: TODAY }), TODAY);
    expect(c.status).toBe('Pending');
    expect(c.isOverdue).toBe(false);
    expect(dueDescription(c, TODAY)).toBe('Due today');
  });

  it('Partially Paid: payments > 0 and outstanding > 0, not overdue', () => {
    const c = computeInvoice(inv({ payments: [pay(1)] }), TODAY);
    expect(c.status).toBe('Partially Paid');
    expect(c.isPartiallyPaid).toBe(true);
  });

  it('Paid: outstanding = 0, even if past due', () => {
    const c = computeInvoice(inv({ dueDate: '2026-10-15', payments: [pay(100_000), pay(8_000)] }), TODAY);
    expect(c.status).toBe('Paid');
    expect(c.isOverdue).toBe(false);
    expect(c.daysOverdue).toBe(0);
  });

  it('Overdue: outstanding > 0 and today > due date; overrides Partially Paid but keeps the flag', () => {
    const c = computeInvoice(inv({ dueDate: '2026-10-13', payments: [pay(10_000)] }), TODAY);
    expect(c.status).toBe('Overdue');
    expect(c.daysOverdue).toBe(30);
    expect(c.isPartiallyPaid).toBe(true);
    expect(dueDescription(c, TODAY)).toBe('30 days overdue');
  });

  it('Cancelled: excluded from outstanding and never overdue', () => {
    const c = computeInvoice(inv({ dueDate: '2026-01-01', isCancelled: true }), TODAY);
    expect(c.status).toBe('Cancelled');
    expect(c.outstandingBalance).toBe(0);
    expect(c.isOverdue).toBe(false);
  });

  it('tracks the last payment date', () => {
    const c = computeInvoice(inv({ payments: [pay(1, '2026-11-05'), pay(1, '2026-10-01')] }), TODAY);
    expect(c.lastPaymentDate).toBe('2026-11-05');
  });
});

describe('aging', () => {
  it('assigns bucket boundaries correctly', () => {
    expect(agingBucket(0)).toBe('current');
    expect(agingBucket(1)).toBe('d1_30');
    expect(agingBucket(30)).toBe('d1_30');
    expect(agingBucket(31)).toBe('d31_60');
    expect(agingBucket(60)).toBe('d31_60');
    expect(agingBucket(61)).toBe('d61_90');
    expect(agingBucket(90)).toBe('d61_90');
    expect(agingBucket(91)).toBe('d90_plus');
  });

  it('ages the outstanding balance (not the total) and excludes paid / cancelled / other type', () => {
    const list = computeInvoices([
      inv({ dueDate: '2026-11-20' }), // current 108,000
      inv({ dueDate: '2026-11-02', payments: [pay(8_000)] }), // 10 天 → 1-30，未付 100,000
      inv({ dueDate: '2026-09-13', counterpartyId: 'c2', counterpartyName: 'Beta' }), // 60 天 → 31-60
      inv({ dueDate: '2026-08-01' }), // 103 天 → 90+
      inv({ dueDate: '2026-08-01', payments: [pay(108_000)] }), // 已付清 → 排除
      inv({ dueDate: '2026-08-01', isCancelled: true }), // 已取消 → 排除
      inv({ type: 'AP', approvalStatus: 'approved', dueDate: '2026-08-01' }), // AP → 不計入 AR 報表
    ], TODAY);
    const r = buildAgingReport(list, 'AR');
    expect(r.buckets.current).toEqual({ amount: 108_000, count: 1 });
    expect(r.buckets.d1_30).toEqual({ amount: 100_000, count: 1 });
    expect(r.buckets.d31_60).toEqual({ amount: 108_000, count: 1 });
    expect(r.buckets.d61_90).toEqual({ amount: 0, count: 0 });
    expect(r.buckets.d90_plus).toEqual({ amount: 108_000, count: 1 });
    expect(r.total).toEqual({ amount: 424_000, count: 4 });
    expect(r.byCounterparty[0]!.counterpartyName).toBe('Acme Sdn Bhd');
    expect(r.byCounterparty[0]!.total).toBe(316_000);
    expect(r.byCounterparty[1]!.buckets.d31_60).toBe(108_000);
    expect(r.invoices[0]!.daysOverdue).toBe(103);
  });
});

describe('dashboard', () => {
  const list = computeInvoices([
    // AR：一筆逾期部分收款、一筆未到期、一筆已收清（本月收款）、一筆取消
    inv({ invoiceDate: '2026-09-01', dueDate: '2026-10-01', payments: [pay(50_000, '2026-10-20')] }),
    inv({ invoiceDate: '2026-11-03', dueDate: '2026-11-15' }),
    inv({ invoiceDate: '2026-10-10', dueDate: '2026-10-30', payments: [pay(108_000, '2026-11-02')] }),
    inv({ invoiceDate: '2026-11-01', isCancelled: true }),
    // AP：一筆逾期、一筆已付一半（本月）
    inv({ type: 'AP', approvalStatus: 'approved', invoiceDate: '2026-10-01', dueDate: '2026-11-01', invoiceAmount: 20_000, taxAmount: 0 }),
    inv({ type: 'AP', approvalStatus: 'approved', invoiceDate: '2026-11-05', dueDate: '2026-12-05', invoiceAmount: 40_000, taxAmount: 0, payments: [pay(20_000, '2026-11-10')] }),
    // 一年多前的發票：計入總額，但不在 12 個月趨勢內
    inv({ invoiceDate: '2025-06-01', dueDate: '2025-07-01', payments: [pay(108_000, '2025-07-01')] }),
  ], TODAY);
  const d = buildDashboard(list, TODAY);

  it('computes AR totals from records', () => {
    expect(d.AR.outstanding).toBe(58_000 + 108_000);
    expect(d.AR.outstandingCount).toBe(2);
    expect(d.AR.overdue).toBe(58_000);
    expect(d.AR.overdueCount).toBe(1);
    expect(d.AR.settled).toBe(50_000 + 108_000 + 108_000);
    expect(d.AR.settledThisMonth).toBe(108_000);
  });

  it('computes AP totals from records', () => {
    expect(d.AP.outstanding).toBe(20_000 + 20_000);
    expect(d.AP.overdue).toBe(20_000);
    expect(d.AP.settled).toBe(20_000);
    expect(d.netPosition).toBe(166_000 - 40_000);
  });

  it('builds 12-month trends by invoice date and payment date', () => {
    expect(d.trends).toHaveLength(12);
    expect(d.trends[0]!.month).toBe('2025-12');
    const nov = d.trends.at(-1)!;
    expect(nov.month).toBe('2026-11');
    expect(nov.arInvoiced).toBe(108_000); // 取消的那筆不計
    expect(nov.arCollected).toBe(108_000);
    expect(nov.apInvoiced).toBe(40_000);
    expect(nov.apPaid).toBe(20_000);
    const oct = d.trends.at(-2)!;
    expect(oct.arCollected).toBe(50_000);
    expect(oct.arInvoiced).toBe(108_000);
  });

  it('lists overdue and due-soon invoices', () => {
    expect(d.topOverdue.map((i) => i.daysOverdue)).toEqual([42, 11]);
    expect(d.dueSoon).toHaveLength(1);
    expect(d.dueSoon[0]!.dueDate).toBe('2026-11-15');
  });

  it('returns zeros for an empty data set', () => {
    const empty = buildDashboard([], TODAY);
    expect(empty.AP.outstanding).toBe(0);
    expect(empty.trends.every((t) => t.apPaid === 0 && t.arInvoiced === 0)).toBe(true);
  });
});

describe('validation', () => {
  const valid = { invoiceNumber: 'INV-1', counterpartyName: 'Acme', invoiceDate: '2026-11-01', dueDate: '2026-11-30', description: '', invoiceAmount: '1,000.00', taxAmount: '80' };

  it('accepts a valid invoice and converts amounts to sen', () => {
    const r = invoiceFormSchema.safeParse(valid);
    expect(r.success).toBe(true);
    if (r.success) expect([r.data.invoiceAmount, r.data.taxAmount]).toEqual([100_000, 8_000]);
  });

  it('rejects bad input with field-level messages', () => {
    const r = invoiceFormSchema.safeParse({ ...valid, invoiceNumber: '', invoiceAmount: '-5', taxAmount: '1.234', dueDate: '2026-10-01' });
    expect(r.success).toBe(false);
    if (!r.success) {
      const e = fieldErrors(r.error);
      expect(e.invoiceNumber).toMatch(/required/);
      expect(e.invoiceAmount).toBeDefined();
      expect(e.taxAmount).toBeDefined();
      expect(e.dueDate).toMatch(/before/);
    }
  });

  it('rejects zero invoice amount and future payment dates', () => {
    expect(invoiceFormSchema.safeParse({ ...valid, invoiceAmount: '0' }).success).toBe(false);
    const p = paymentFormSchema(TODAY).safeParse({ paymentDate: '2026-11-13', amount: '10', method: 'FPX' });
    expect(p.success).toBe(false);
  });

  it('detects duplicates: AR globally, AP per supplier, case-insensitive', () => {
    const existing = [
      { id: '1', type: 'AR' as const, invoiceNumber: 'INV-100', counterpartyName: 'Acme' },
      { id: '2', type: 'AP' as const, invoiceNumber: 'B-1', counterpartyName: 'Supplier A' },
    ];
    expect(findDuplicateInvoice(existing, { type: 'AR', invoiceNumber: ' inv-100 ', counterpartyName: 'Other' })).not.toBeNull();
    expect(findDuplicateInvoice(existing, { type: 'AP', invoiceNumber: 'b-1', counterpartyName: 'supplier a' })).not.toBeNull();
    expect(findDuplicateInvoice(existing, { type: 'AP', invoiceNumber: 'B-1', counterpartyName: 'Supplier B' })).toBeNull();
    // 編輯自己不算重複
    expect(findDuplicateInvoice(existing, { id: '1', type: 'AR', invoiceNumber: 'INV-100', counterpartyName: 'Acme' })).toBeNull();
    expect(() => assertNotDuplicate(existing, { type: 'AR', invoiceNumber: 'INV-100', counterpartyName: 'x' })).toThrow(DomainError);
  });

  it('enforces payment rules', () => {
    const open = computeInvoice(inv({ payments: [pay(100_000)] }), TODAY); // 未付 8,000
    expect(() => assertCanRecordPayment(open, 8_000)).not.toThrow();
    expect(() => assertCanRecordPayment(open, 8_001)).toThrow(/exceeds/);
    const apPending = computeInvoice(inv({ type: 'AP', approvalStatus: 'pending' }), TODAY);
    expect(() => assertCanRecordPayment(apPending, 1)).toThrow(/approved/);
    const cancelled = computeInvoice(inv({ isCancelled: true }), TODAY);
    expect(() => assertCanRecordPayment(cancelled, 1)).toThrow(/cancelled/);
    expect(() => assertCanCancel(open)).toThrow(/payments/);
    expect(() => assertTotalCoversPaid(99_999, 100_000)).toThrow(/cannot be less/);
  });
});

describe('csv', () => {
  it('escapes cells and blocks formula injection', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('-12.50')).toBe('-12.50');
  });
  it('exports AP with approval column and decimal amounts', () => {
    const csv = invoicesToCsv(computeInvoices([inv({ type: 'AP', approvalStatus: 'approved', payments: [pay(8_000)] })], TODAY), 'AP');
    const [header, row] = csv.replace('﻿', '').trim().split('\r\n');
    expect(header).toContain('Supplier');
    expect(header).toContain('Approval Status');
    expect(row).toContain('1000.00,80.00,1080.00,80.00,1000.00,Partially Paid,Approved');
  });
});

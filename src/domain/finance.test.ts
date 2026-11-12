/**
 * 新財務功能測試：折讓／沖銷、現金流預測、績效指標、對帳單、催款信。
 */
import { describe, expect, it } from 'vitest';
import { buildCashFlowForecast } from './cashflow';
import { buildDashboard } from './dashboard';
import { computeInvoices } from './invoice';
import { buildMetrics } from './metrics';
import { buildReminderText, buildStatement } from './statement';
import type { Invoice, Payment, PaymentKind } from './types';
import { assertCanRecordPayment } from './validation';

const TODAY = '2026-11-12';
let seq = 0;
const pay = (amount: number, paymentDate: string, kind?: PaymentKind): Payment => ({ id: `p${(seq += 1)}`, invoiceId: '', paymentDate, amount, method: 'FPX', reference: 'R1', notes: '', createdAt: '', createdByName: null, kind });
const inv = (o: Partial<Invoice>): Invoice => ({
  id: `i${(seq += 1)}`, type: 'AR', invoiceNumber: `N${seq}`, counterpartyId: 'c1', counterpartyName: 'Acme', invoiceDate: '2026-10-01', dueDate: '2026-11-30',
  description: '', invoiceAmount: 100_000, taxAmount: 0, approvalStatus: null, isCancelled: false, cancelReason: '', createdAt: '', updatedAt: '', createdByName: null, payments: [], ...o,
});

describe('credit notes and write-offs', () => {
  const list = computeInvoices([
    inv({ payments: [pay(60_000, '2026-11-01'), pay(10_000, '2026-11-02', 'credit_note'), pay(30_000, '2026-11-05', 'write_off')] }),
  ], TODAY);
  it('settle the invoice but are not counted as cash collected', () => {
    expect(list[0]!.status).toBe('Paid');
    expect(list[0]!.outstandingBalance).toBe(0);
    const d = buildDashboard(list, TODAY);
    expect(d.AR.settled).toBe(60_000);
    expect(d.AR.creditNotes).toBe(10_000);
    expect(d.AR.writtenOff).toBe(30_000);
    expect(d.trends.at(-1)!.arCollected).toBe(60_000);
  });
  it('write-offs are AR only; credit notes allowed on unapproved AP', () => {
    const ap = computeInvoices([inv({ type: 'AP', approvalStatus: 'pending' })], TODAY)[0]!;
    expect(() => assertCanRecordPayment(ap, 100, 'write_off')).toThrow(/Only customer invoices/);
    expect(() => assertCanRecordPayment(ap, 100, 'credit_note')).not.toThrow();
    expect(() => assertCanRecordPayment(ap, 100, 'payment')).toThrow(/approved/);
  });
});

describe('cash flow forecast', () => {
  const list = computeInvoices([
    inv({ dueDate: '2026-11-01', invoiceAmount: 50_000 }), // AR 逾期 → 逾期列
    inv({ dueDate: '2026-11-12', invoiceAmount: 20_000 }), // AR 今天到期 → 第 1 週
    inv({ dueDate: '2026-11-20', invoiceAmount: 30_000, payments: [pay(10_000, '2026-11-10')] }), // AR 第 2 週，未付 20,000
    inv({ type: 'AP', approvalStatus: 'approved', dueDate: '2026-11-18', invoiceAmount: 80_000 }), // AP 第 1 週
    inv({ type: 'AP', approvalStatus: 'rejected', dueDate: '2026-11-18', invoiceAmount: 999_999 }), // 退回 → 不列入
    inv({ dueDate: '2027-06-01', invoiceAmount: 5_000 }), // 超出 12 週 → later
    inv({ type: 'AP', approvalStatus: 'approved', invoiceDate: '2026-09-01', dueDate: '2026-10-01', invoiceAmount: 7_000, payments: [pay(7_000, '2026-11-05')] }),
  ], TODAY);
  const f = buildCashFlowForecast(list, TODAY, { openingBalance: 100_000, openingBalanceDate: '2026-11-01' });

  it('starts from opening balance plus actual movements since then', () => {
    // 期初 1,000 + AR 收 100 − AP 付 70 = 1,030
    expect(f.movementSinceOpening).toBe(10_000 - 7_000);
    expect(f.currentBalance).toBe(103_000);
  });
  it('places invoices by due date and projects the balance', () => {
    expect(f.rows).toHaveLength(13);
    expect(f.rows[0]).toMatchObject({ key: 'overdue', inflow: 50_000, outflow: 0 });
    expect(f.rows[1]).toMatchObject({ start: '2026-11-12', end: '2026-11-18', inflow: 20_000, outflow: 80_000, net: -60_000 });
    expect(f.rows[2]).toMatchObject({ inflow: 20_000 });
    expect(f.rows[1]!.closing).toBe(103_000 + 50_000 - 60_000);
    expect(f.later).toEqual({ inflow: 5_000, outflow: 0 });
    expect(f.totals.inflow).toBe(90_000);
  });
  it('reports the lowest projected balance', () => {
    const tight = buildCashFlowForecast(list, TODAY, { openingBalance: 0, openingBalanceDate: null });
    expect(tight.lowest.amount).toBe(-10_000);
    expect(tight.hasOpeningBalance).toBe(false);
  });
});

describe('finance metrics', () => {
  it('computes DSO, collection days, on-time rate and bad-debt rate', () => {
    const list = computeInvoices([
      inv({ invoiceDate: '2026-10-01', dueDate: '2026-10-31', payments: [pay(100_000, '2026-10-21')] }), // 20 天，準時
      inv({ invoiceDate: '2026-09-01', dueDate: '2026-10-01', payments: [pay(100_000, '2026-10-11')] }), // 40 天，逾期收
      inv({ invoiceDate: '2026-10-15', dueDate: '2026-11-14' }), // 未付 1,000
      inv({ invoiceDate: '2026-08-01', dueDate: '2026-08-31', payments: [pay(100_000, '2026-10-01', 'write_off')] }), // 呆帳
    ], TODAY);
    const m = buildMetrics(list, TODAY);
    expect(m.avgDaysToCollect).toBe(30);
    expect(m.onTimeCollectionRate).toBe(0.5);
    expect(m.sampleSizes.collected).toBe(2); // 以沖銷結清的不算
    // 近 90 天（8/14 之後）開立：9/01、10/01、10/15 = 3,000；未付 1,000 → 1,000 ÷ 3,000 × 90 = 30 天
    expect(m.dso).toBe(30);
    expect(m.badDebtRate).toBeCloseTo(100_000 / 400_000);
    expect(m.dpo).toBeNull();
  });
});

describe('statement of account', () => {
  const list = computeInvoices([
    inv({ id: 'a', invoiceNumber: 'A-1', invoiceDate: '2026-08-10', dueDate: '2026-09-10', payments: [pay(40_000, '2026-09-05')] }),
    inv({ id: 'b', invoiceNumber: 'A-2', invoiceDate: '2026-10-05', dueDate: '2026-10-20', invoiceAmount: 50_000, payments: [pay(5_000, '2026-10-25', 'credit_note')] }),
    inv({ id: 'c', invoiceNumber: 'A-3', invoiceDate: '2026-10-10', isCancelled: true }),
    inv({ id: 'd', invoiceNumber: 'X-1', counterpartyId: 'other' }),
  ], TODAY);
  const s = buildStatement(list, 'c1', '2026-10-01', '2026-10-31');

  it('carries the opening balance and a running balance', () => {
    expect(s.openingBalance).toBe(60_000); // 1,000 − 400
    expect(s.lines.map((l) => [l.reference, l.debit, l.credit, l.balance])).toEqual([
      ['A-2', 50_000, 0, 110_000],
      ['A-2', 0, 5_000, 105_000],
    ]);
    expect(s.lines[1]!.description).toMatch(/Credit note/);
    expect(s.closingBalance).toBe(105_000);
    expect(s.overdue.map((i) => i.invoiceNumber)).toEqual(['A-1', 'A-2']);
  });

  it('builds a reminder email listing the overdue invoices', () => {
    const r = buildReminderText('Acme', s.overdue, 'Sample Trading Sdn Bhd', 'Ms Tan');
    expect(r.subject).toBe('Payment reminder: RM 1,050.00 overdue – Sample Trading Sdn Bhd');
    expect(r.body).toMatch(/^Dear Ms Tan,/);
    expect(r.body).toContain('A-1 dated 10 Aug 2026, due 10 Sept 2026: RM 600.00 outstanding (63 days overdue)');
    expect(r.body).toContain('Total overdue: RM 1,050.00');
  });
});

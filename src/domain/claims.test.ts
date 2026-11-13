import { describe, expect, it } from 'vitest';
import {
  approveClaim, claimFlags, claimTotals, editClaim, isValidClaimRecord, mileageAmount, newClaim, nextClaimNo, normalizeReceipt, payClaim,
  rejectClaim, staffNames, summaryByStaff, totalsByCategory, undoClaim, validateClaim, type ClaimFormValues, type StaffClaim,
} from './claims';

const today = '2026-11-14';
const T = '2026-11-14T02:00:00.000Z';
const form = (over: Partial<ClaimFormValues> = {}): ClaimFormValues => ({
  staffName: 'Siti Hajar', expenseDate: '2026-11-10', category: 'Meals & Entertainment', description: 'Client lunch', amount: '86.50',
  mileageKm: '', ratePerKm: '0.60', hasReceipt: true, remarks: '', ...over,
});
const make = (over: Partial<ClaimFormValues> = {}, existing: StaffClaim[] = [], id = 'c1') => {
  const r = validateClaim(form(over), today);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return newClaim(r.value, existing, today, T, id);
};

describe('validateClaim', () => {
  it('accepts a normal claim and converts RM to sen', () => {
    const r = validateClaim(form({ staffName: '  Siti   Hajar ' }), today);
    expect(r.ok && r.value).toMatchObject({ staffName: 'Siti Hajar', amount: 8650, mileageKm: null });
  });
  it('requires staff, description, a positive amount and a past date', () => {
    const r = validateClaim(form({ staffName: '', description: ' ', amount: '0', expenseDate: '2026-11-20' }), today);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['amount', 'description', 'expenseDate', 'staffName']);
  });
  it('computes mileage as km × rate', () => {
    const r = validateClaim(form({ category: 'Mileage', amount: '', mileageKm: '42.5', ratePerKm: '0.60', description: 'Office to Klang' }), today);
    expect(r.ok && r.value).toMatchObject({ amount: 2550, mileageKm: 42.5, ratePerKm: 60 });
    expect(mileageAmount(33.3, 55)).toBe(1832);
    const bad = validateClaim(form({ category: 'Mileage', mileageKm: '', ratePerKm: '' }), today);
    expect(!bad.ok && Object.keys(bad.errors).sort()).toEqual(['mileageKm', 'ratePerKm']);
  });
});

describe('claim numbers and status flow', () => {
  it('numbers claims per submission month', () => {
    expect(nextClaimNo([], today)).toBe('CL-2611-001');
    expect(nextClaimNo([{ claimNo: 'CL-2611-007' }, { claimNo: 'CL-2610-020' }], today)).toBe('CL-2611-008');
  });
  it('approve → pay → undo; reject needs a reason; paid amount is locked', () => {
    const c = make();
    expect(c.status).toBe('submitted');
    expect(isValidClaimRecord(c)).toBe(true);
    expect(() => payClaim(c, { paidDate: today, payMethod: 'Cash', paymentRef: '' }, T)).toThrow(/approved/);
    const a = approveClaim(c, today, T);
    expect(a).toMatchObject({ status: 'approved', decidedOn: today });
    const p = payClaim(a, { paidDate: today, payMethod: 'With salary', paymentRef: ' Nov salary ' }, T);
    expect(p).toMatchObject({ status: 'paid', payMethod: 'With salary', paymentRef: 'Nov salary' });
    expect(isValidClaimRecord(p)).toBe(true);
    const r = validateClaim(form({ amount: '90' }), today);
    expect(() => r.ok && editClaim(p, r.value, T)).toThrow(/already paid/);
    expect(undoClaim(p, T)).toMatchObject({ status: 'approved', paidDate: null, payMethod: null });
    expect(() => rejectClaim(c, '  ', today, T)).toThrow(/reason/);
    const rj = rejectClaim(c, 'No receipt', today, T);
    expect(rj).toMatchObject({ status: 'rejected', rejectReason: 'No receipt' });
    expect(approveClaim(rj, today, T).status).toBe('approved'); // 補件後可直接核准
    expect(undoClaim(a, T)).toMatchObject({ status: 'submitted', decidedOn: null });
  });
});

describe('checks and summaries', () => {
  it('flags missing receipts, late claims and possible duplicates', () => {
    const a = make({ hasReceipt: false });
    expect(claimFlags(a, [a])).toEqual(['No receipt']);
    const late = make({ expenseDate: '2026-08-01' }, [], 'c2');
    expect(claimFlags(late, [])).toEqual(['Late claim']);
    const dup = make({ staffName: 'siti hajar' }, [], 'c3');
    expect(claimFlags(dup, [a, dup])).toEqual(['Possible duplicate']);
    expect(claimFlags(dup, [rejectClaim(a, 'x', today, T), dup])).toEqual([]);
    const km = make({ category: 'Mileage', mileageKm: '10', hasReceipt: false }, [], 'c4');
    expect(claimFlags(km, [])).toEqual([]); // 里程不需要收據
  });
  it('totals, per-staff and per-category summaries', () => {
    const a = approveClaim(make({ amount: '100' }), today, T);
    const b = approveClaim(make({ staffName: 'Kumar', amount: '250', category: 'Petrol' }, [], 'b'), today, T);
    const c = payClaim(approveClaim(make({ amount: '40' }, [], 'c'), today, T), { paidDate: today, payMethod: 'Cash', paymentRef: '' }, T);
    const d = make({ staffName: 'Kumar', amount: '15', hasReceipt: false }, [], 'd');
    const all = [a, b, c, d];
    expect(claimTotals(all, today)).toEqual({ toApprove: { count: 1, total: 1500 }, toPay: { count: 2, total: 35000 }, paidThisMonth: { count: 1, total: 4000 }, missingReceipts: 1 });
    expect(summaryByStaff(all)).toEqual([
      { staffName: 'Kumar', count: 1, total: 25000, claimIds: ['b'] },
      { staffName: 'Siti Hajar', count: 1, total: 10000, claimIds: ['c1'] },
    ]);
    expect(staffNames(all)).toEqual(['Kumar', 'Siti Hajar']);
    expect(totalsByCategory(all, '2026-11').map((x) => [x.category, x.total])).toEqual([['Petrol', 25000], ['Meals & Entertainment', 15500]]);
  });
});

describe('normalizeReceipt', () => {
  it('keeps valid fields only and warns on foreign currency', () => {
    expect(normalizeReceipt({ date: '2026-11-12', total: '1,245.90', merchant: 'Shell Bangsar', description: 'Petrol', category: 'Petrol', currency: 'MYR' }, today))
      .toEqual({ fields: { expenseDate: '2026-11-12', amount: '1245.90', description: 'Petrol · Shell Bangsar', category: 'Petrol' }, warnings: [] });
    const r = normalizeReceipt({ date: '2027-01-01', total: -3, category: 'Mileage', currency: 'SGD' }, today);
    expect(r.fields).toEqual({});
    expect(r.warnings[0]).toMatch(/SGD/);
    expect(normalizeReceipt(null, today)).toEqual({ fields: {}, warnings: [] });
  });
});

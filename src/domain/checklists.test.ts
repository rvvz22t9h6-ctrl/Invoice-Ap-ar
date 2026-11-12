import { describe, expect, it } from 'vitest';
import {
  addItem, checklistProgress, checklistStatus, defaultDueDate, defaultMonth, newChecklist, removeItem, salaryPayment, setAll,
  setItemRemark, shiftMonth, toggleItem, SALARY_PAID_KEY,
} from './checklists';

const NOW = '2026-11-12T02:00:00Z';

describe('monthly checklists', () => {
  it('creates payroll and closing checklists from templates with Malaysian items', () => {
    const p = newChecklist('payroll', '2026-11', NOW);
    expect(p.id).toBe('payroll-2026-11');
    expect(p.items.map((i) => i.key)).toEqual(expect.arrayContaining(['attendance', 'overtime', 'epf', 'socso', 'eis', 'pcb', SALARY_PAID_KEY]));
    expect(newChecklist('closing', '2026-10', NOW).items.some((i) => i.key === 'bank-rec')).toBe(true);
  });

  it('due dates: payroll on the 25th, closing on the 7th of next month, moved off weekends', () => {
    expect(defaultDueDate('payroll', '2026-11')).toBe('2026-11-25'); // 週三
    expect(defaultDueDate('payroll', '2026-10')).toBe('2026-10-23'); // 25 日是週日 → 週五
    expect(defaultDueDate('closing', '2026-10')).toBe('2026-11-06'); // 11/07 是週六 → 週五
    expect(defaultDueDate('closing', '2026-12')).toBe('2027-01-07');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
  });

  it('chooses the month to work on', () => {
    expect(defaultMonth('payroll', '2026-11-05')).toBe('2026-11');
    expect(defaultMonth('closing', '2026-11-05')).toBe('2026-10');
    expect(defaultMonth('closing', '2026-11-20')).toBe('2026-11');
  });

  it('tracks completion %, status and salary payment', () => {
    let c = newChecklist('payroll', '2026-11', NOW);
    expect(checklistStatus(c, '2026-11-12')).toBe('Pending');
    c = toggleItem(c, 'attendance', NOW);
    expect(checklistProgress(c)).toEqual({ done: 1, total: 11, pct: 9 });
    expect(checklistStatus(c, '2026-11-12')).toBe('In progress');
    expect(checklistStatus(c, '2026-11-26')).toBe('Overdue');
    expect(salaryPayment(c, '2026-11-12').status).toBe('Pending');
    expect(salaryPayment(c, '2026-11-26').status).toBe('Overdue');
    c = toggleItem(c, SALARY_PAID_KEY, NOW);
    expect(salaryPayment(c, '2026-11-26')).toEqual({ status: 'Paid', paidAt: NOW });
    c = setAll(c, true, NOW);
    expect(checklistProgress(c).pct).toBe(100);
    expect(checklistStatus(c, '2027-01-01')).toBe('Completed');
    c = toggleItem(c, 'attendance', NOW);
    expect(c.items.find((i) => i.key === 'attendance')).toMatchObject({ done: false, doneAt: null });
  });

  it('adds, removes and annotates items', () => {
    let c = newChecklist('closing', '2026-10', NOW);
    c = addItem(c, '  Confirm intercompany balances ', NOW);
    expect(c.items.at(-1)).toMatchObject({ label: 'Confirm intercompany balances', group: 'Other' });
    expect(addItem(c, '   ', NOW)).toBe(c);
    c = setItemRemark(c, 'bank-rec', 'Maybank done, CIMB pending', NOW);
    expect(c.items.find((i) => i.key === 'bank-rec')!.remark).toBe('Maybank done, CIMB pending');
    const n = c.items.length;
    expect(removeItem(c, 'depreciation', NOW).items).toHaveLength(n - 1);
  });
});

import { describe, expect, it } from 'vitest';
import { newChecklist, setAll } from './checklists';
import { monthsAgo, planCleanup } from './retention';

describe('retention', () => {
  it('monthsAgo handles month ends and year boundaries', () => {
    expect(monthsAgo('2026-11-14', 3)).toBe('2026-08-14');
    expect(monthsAgo('2026-05-31', 3)).toBe('2026-02-28');
    expect(monthsAgo('2026-02-10', 3)).toBe('2025-11-10');
  });
  it('removes only completed checklists from months before the cut-off', () => {
    const done = setAll(newChecklist('payroll', '2026-06', ''), true, '');
    const open = newChecklist('closing', '2026-06', '');
    const recent = setAll(newChecklist('payroll', '2026-09', ''), true, '');
    const plan = planCleanup({ invoices: [], tasks: [], claims: [], checklists: [done, open, recent] }, '2026-11-14');
    expect(plan.checklistIds).toEqual(['payroll-2026-06']);
    expect(plan.cutoff).toBe('2026-08-14');
  });
});

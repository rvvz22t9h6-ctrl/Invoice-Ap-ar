/**
 * 每月檢查清單（Monthly checklists）：薪資（Payroll）與月結（Monthly Closing）共用同一個簡單模型。
 *
 *   - 每個月份一份清單，ID = <類型>-<YYYY-MM>，同一月份不會重複。
 *   - 只有在使用者第一次勾選或修改時才儲存（打開頁面不會寫入資料）。
 *   - 完成百分比 = 已完成項目 ÷ 全部項目。
 *   - 狀態：全部完成 → Completed；未完成且已過到期日 → Overdue；有進度 → In progress；否則 Pending。
 *   - 薪資的「薪資付款狀態」= 「Salaries paid」項目是否完成（以及完成日期）。
 *
 * 到期日（遇週末提前到週五）：薪資 = 當月 25 日；月結 = 次月 7 日。
 */
import { adjustForWeekend, daysInMonth } from './recurrence';
import { addDays, type IsoDate } from './dates';

export type ChecklistKind = 'payroll' | 'closing';

export interface ChecklistItem {
  key: string;
  label: string;
  group: string;
  done: boolean;
  /** 完成時間（ISO）。 */
  doneAt: string | null;
  remark: string;
}

export interface Checklist {
  id: string;
  kind: ChecklistKind;
  /** 月份 YYYY-MM。 */
  month: string;
  items: ChecklistItem[];
  remarks: string;
  dueDate: IsoDate;
  createdAt: string;
  updatedAt: string;
}

export type ChecklistStatus = 'Completed' | 'Overdue' | 'In progress' | 'Pending';

/** 薪資付款項目的固定 key。 */
export const SALARY_PAID_KEY = 'salaries-paid';

const T = (group: string, items: [string, string][]) => items.map(([key, label]) => ({ key, label, group }));

export const PAYROLL_TEMPLATE = [
  ...T('Salary preparation', [
    ['staff-changes', 'Update new joiners, resignations and salary changes'],
    ['claims-leave', 'Collect approved claims, allowances and unpaid leave'],
    ['calculate', 'Calculate gross pay, deductions and net pay'],
  ]),
  ...T('Attendance & overtime', [
    ['attendance', 'Verify attendance records'],
    ['overtime', 'Verify overtime hours and rates'],
  ]),
  ...T('Statutory verification', [
    ['epf', 'Verify EPF (KWSP) contributions'],
    ['socso', 'Verify SOCSO (PERKESO) contributions'],
    ['eis', 'Verify EIS contributions'],
    ['pcb', 'Verify PCB / MTD deductions'],
  ]),
  ...T('Salary payment', [
    [SALARY_PAID_KEY, 'Salaries paid (bank transfer)'],
    ['payslips', 'Payslips sent to employees'],
  ]),
];

export const CLOSING_TEMPLATE = [
  ...T('Ledgers', [
    ['ap-recorded', 'All supplier invoices recorded (AP)'],
    ['ar-recorded', 'All customer invoices and receipts recorded (AR)'],
    ['payroll-journal', 'Payroll journal posted'],
  ]),
  ...T('Reconciliations', [
    ['bank-rec', 'Bank reconciliation done'],
    ['petty-cash', 'Petty cash reconciled'],
    ['ar-aging', 'AR aging reviewed, overdue customers chased'],
    ['ap-aging', 'AP aging reviewed'],
  ]),
  ...T('Adjustments', [
    ['accruals', 'Accruals and prepayments posted'],
    ['depreciation', 'Depreciation posted'],
    ['tax', 'SST and tax accruals checked'],
  ]),
  ...T('Reporting', [
    ['mgmt-report', 'Management report sent to director'],
    ['lock', 'Month closed and documents filed'],
  ]),
];

export const checklistId = (kind: ChecklistKind, month: string) => `${kind}-${month}`;

/** 月份加減。 */
export function shiftMonth(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

/** 顯示用月份，例如 "2026-11" → "November 2026"。 */
export const monthName = (month: string) => new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-MY', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** 預設到期日：薪資當月 25 日；月結次月 7 日；遇週末提前到週五。 */
export function defaultDueDate(kind: ChecklistKind, month: string): IsoDate {
  if (kind === 'payroll') {
    const [y, m] = month.split('-').map(Number) as [number, number];
    return adjustForWeekend(`${month}-${String(Math.min(25, daysInMonth(y, m))).padStart(2, '0')}`, 'previous');
  }
  return adjustForWeekend(`${shiftMonth(month, 1)}-07`, 'previous');
}

/** 預設要處理的月份：薪資 = 本月；月結 = 每月 10 日前處理上個月，之後處理本月。 */
export function defaultMonth(kind: ChecklistKind, today: IsoDate): string {
  const month = today.slice(0, 7);
  return kind === 'closing' && Number(today.slice(8)) <= 10 ? shiftMonth(month, -1) : month;
}

/** 由範本建立新清單（尚未儲存）。 */
export function newChecklist(kind: ChecklistKind, month: string, nowIso: string): Checklist {
  const template = kind === 'payroll' ? PAYROLL_TEMPLATE : CLOSING_TEMPLATE;
  return {
    id: checklistId(kind, month), kind, month, remarks: '', dueDate: defaultDueDate(kind, month), createdAt: nowIso, updatedAt: nowIso,
    items: template.map((t) => ({ ...t, done: false, doneAt: null, remark: '' })),
  };
}

export function checklistProgress(c: Pick<Checklist, 'items'>) {
  const total = c.items.length;
  const done = c.items.filter((i) => i.done).length;
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
}

export function checklistStatus(c: Checklist, today: IsoDate): ChecklistStatus {
  const { done, total } = checklistProgress(c);
  if (total > 0 && done === total) return 'Completed';
  if (today > c.dueDate) return 'Overdue';
  return done > 0 ? 'In progress' : 'Pending';
}

/** 薪資付款狀態。 */
export function salaryPayment(c: Checklist, today: IsoDate): { status: 'Paid' | 'Overdue' | 'Pending'; paidAt: string | null } {
  const item = c.items.find((i) => i.key === SALARY_PAID_KEY);
  if (item?.done) return { status: 'Paid', paidAt: item.doneAt };
  return { status: today > c.dueDate ? 'Overdue' : 'Pending', paidAt: null };
}

/** 勾選／取消勾選一個項目。 */
export function toggleItem(c: Checklist, key: string, nowIso: string): Checklist {
  return { ...c, updatedAt: nowIso, items: c.items.map((i) => (i.key === key ? { ...i, done: !i.done, doneAt: i.done ? null : nowIso } : i)) };
}

export function setItemRemark(c: Checklist, key: string, remark: string, nowIso: string): Checklist {
  return { ...c, updatedAt: nowIso, items: c.items.map((i) => (i.key === key ? { ...i, remark: remark.slice(0, 500) } : i)) };
}

/** 新增自訂項目（放在「Other」群組）。 */
export function addItem(c: Checklist, label: string, nowIso: string): Checklist {
  const clean = label.trim().slice(0, 150);
  if (!clean) return c;
  return { ...c, updatedAt: nowIso, items: [...c.items, { key: `custom-${Date.now().toString(36)}-${c.items.length}`, label: clean, group: 'Other', done: false, doneAt: null, remark: '' }] };
}

export function removeItem(c: Checklist, key: string, nowIso: string): Checklist {
  return { ...c, updatedAt: nowIso, items: c.items.filter((i) => i.key !== key) };
}

/** 一次全部勾選／全部取消。 */
export function setAll(c: Checklist, done: boolean, nowIso: string): Checklist {
  return { ...c, updatedAt: nowIso, items: c.items.map((i) => ({ ...i, done, doneAt: done ? (i.doneAt ?? nowIso) : null })) };
}

/** 依月份排序（新 → 舊）。 */
export const byMonthDesc = (a: Checklist, b: Checklist) => b.month.localeCompare(a.month);

export { addDays };

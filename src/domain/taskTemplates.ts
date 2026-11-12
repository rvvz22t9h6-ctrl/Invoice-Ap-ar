/**
 * 馬來西亞財務與薪資常用週期任務範本（Recurring task templates）
 *
 * 法定期限依一般規定（截至 2026 年），實際以 KWSP、PERKESO、LHDN、HRD Corp、JKDM 最新公告為準：
 *   - EPF（KWSP）、SOCSO（PERKESO）與 EIS、PCB／MTD、HRD Corp 人力資源發展稅：次月 15 日前繳交
 *   - CP204 公司所得稅預估分期：每月 15 日前
 *   - Form EA：每年 2 月底前發給員工；Form E：每年 3 月 31 日前申報
 *   - SST-02：每兩個月申報一次，於課稅期結束後次月月底前（依公司課稅期調整開始月份）
 * 週末遇到截止日時一律「提前到週五」，避免遲交。
 */
import type { RecurrenceRule } from './recurrence';

export type RuleTemplate = Omit<RecurrenceRule, 'id' | 'startDate' | 'endDate' | 'active' | 'generatedThrough' | 'skipDates' | 'createdAt' | 'updatedAt'> & {
  key: string;
  group: 'Payroll & statutory' | 'Month-end closing' | 'Weekly routines' | 'Annual';
  note?: string;
};

const base = { description: '', remarks: '', interval: 1, customUnit: 'month' as const, weekdays: [] as number[], month: 1, weekendAdjust: 'previous' as const };

export const RULE_TEMPLATES: RuleTemplate[] = [
  { ...base, key: 'payroll-run', group: 'Payroll & statutory', title: 'Run monthly payroll and send payslips', category: 'Payroll', priority: 'High', frequency: 'monthly', dayOfMonth: 25, leadDays: 3,
    description: 'Update attendance, overtime, claims and new joiners/leavers; approve payroll; bank transfer of salaries; send payslips.' },
  { ...base, key: 'epf', group: 'Payroll & statutory', title: 'Pay EPF (KWSP) contribution', category: 'Payroll', priority: 'Urgent', frequency: 'monthly', dayOfMonth: 15, leadDays: 5,
    description: 'Employer and employee EPF for last month\'s wages, via i-Akaun (Employer). Due by the 15th.' },
  { ...base, key: 'socso', group: 'Payroll & statutory', title: 'Pay SOCSO (PERKESO) and EIS contribution', category: 'Payroll', priority: 'Urgent', frequency: 'monthly', dayOfMonth: 15, leadDays: 5,
    description: 'SOCSO and EIS for last month\'s wages via the PERKESO portal. Due by the 15th.' },
  { ...base, key: 'pcb', group: 'Payroll & statutory', title: 'Remit PCB / MTD to LHDN', category: 'Payroll', priority: 'Urgent', frequency: 'monthly', dayOfMonth: 15, leadDays: 5,
    description: 'Monthly tax deduction for last month\'s wages via e-PCB / MyTax. Due by the 15th.' },
  { ...base, key: 'hrdf', group: 'Payroll & statutory', title: 'Pay HRD Corp levy', category: 'Payroll', priority: 'High', frequency: 'monthly', dayOfMonth: 15, leadDays: 5,
    description: 'Human resources development levy for last month\'s wages. Due by the 15th.' },
  { ...base, key: 'cp204', group: 'Payroll & statutory', title: 'Pay CP204 tax instalment', category: 'GL', priority: 'High', frequency: 'monthly', dayOfMonth: 15, leadDays: 3,
    description: 'Monthly instalment of estimated company income tax. Due by the 15th.' },
  { ...base, key: 'sst', group: 'Payroll & statutory', title: 'Submit SST-02 return and payment', category: 'GL', priority: 'Urgent', frequency: 'custom', interval: 2, customUnit: 'month', dayOfMonth: -1, leadDays: 7,
    description: 'Bi-monthly sales & service tax return via MySST, due by the end of the month after the taxable period.',
    note: 'Set the start month to the first due month of your taxable period.' },
  { ...base, key: 'close-ledgers', group: 'Month-end closing', title: 'Close AP and AR sub-ledgers', category: 'Month-End Closing', priority: 'High', frequency: 'monthly', dayOfMonth: 3, leadDays: 2,
    description: 'Ensure all invoices and payments for last month are posted; review AP/AR aging; record credit notes.' },
  { ...base, key: 'bank-rec', group: 'Month-end closing', title: 'Bank reconciliation for last month', category: 'Banking', priority: 'High', frequency: 'monthly', dayOfMonth: 5, leadDays: 2,
    description: 'Reconcile all bank accounts to statements; follow up unpresented cheques and unidentified receipts.' },
  { ...base, key: 'accruals', group: 'Month-end closing', title: 'Post accruals, prepayments and depreciation', category: 'Month-End Closing', priority: 'Medium', frequency: 'monthly', dayOfMonth: 5, leadDays: 2,
    description: 'Accrue unbilled expenses, amortise prepayments, run depreciation, review provisions.' },
  { ...base, key: 'mgmt-report', group: 'Month-end closing', title: 'Send monthly management report to director', category: 'Month-End Closing', priority: 'High', frequency: 'monthly', dayOfMonth: 7, leadDays: 2,
    description: 'P&L, balance sheet, cash position, AR/AP aging (export the full Excel report from the Dashboard).' },
  { ...base, key: 'ap-run', group: 'Weekly routines', title: 'Weekly AP payment run', category: 'AP', priority: 'Medium', frequency: 'weekly', weekdays: [4], dayOfMonth: 1, leadDays: 0, weekendAdjust: 'none',
    description: 'Approve due supplier bills and pay them in one batch (Accounts Payable → select → Pay).' },
  { ...base, key: 'ar-chase', group: 'Weekly routines', title: 'Chase overdue customers', category: 'AR', priority: 'Medium', frequency: 'weekly', weekdays: [1], dayOfMonth: 1, leadDays: 0, weekendAdjust: 'none',
    description: 'Send payment reminders (Suppliers & Customers → customer → Payment reminder) and update notes.' },
  { ...base, key: 'bank-check', group: 'Weekly routines', title: 'Check bank and record receipts', category: 'Banking', priority: 'Medium', frequency: 'weekly', weekdays: [1, 2, 3, 4, 5], dayOfMonth: 1, leadDays: 0, weekendAdjust: 'none',
    description: 'Check online banking every working day and record customer receipts against invoices.' },
  { ...base, key: 'form-ea', group: 'Annual', title: 'Issue Form EA to all employees', category: 'Payroll', priority: 'Urgent', frequency: 'yearly', month: 2, dayOfMonth: -1, leadDays: 21,
    description: 'Prepare and distribute EA forms for the previous year. Due by the end of February.' },
  { ...base, key: 'form-e', group: 'Annual', title: 'Submit Form E to LHDN', category: 'Payroll', priority: 'Urgent', frequency: 'yearly', month: 3, dayOfMonth: 31, leadDays: 21,
    description: 'Employer\'s annual return with C.P.8D. Due by 31 March.' },
];

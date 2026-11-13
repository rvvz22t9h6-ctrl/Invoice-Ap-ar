/**
 * 資料保留（Retention）：清除超過 3 個月的「已結束」紀錄，節省儲存空間。
 *
 * 只清除已經結束、不再需要追蹤的紀錄：
 *   - 發票：已付清或已取消，且最後一次異動（發票日／最後付款日）早於 3 個月前
 *   - 任務：已完成或已取消，且完成日（或到期日）早於 3 個月前
 *   - 報銷：已付款或已退回，且付款日／退回日早於 3 個月前
 *   - 清單：已全部完成，且該月份結束於 3 個月前
 * 永遠保留：未付清的發票（不論多舊）、未完成的任務、未付款的報銷、供應商與客戶名錄。
 */
import { checklistProgress, type Checklist } from './checklists';
import type { StaffClaim } from './claims';
import type { IsoDate } from './dates';
import { computeInvoice } from './invoice';
import type { Task } from './tasks';
import type { Invoice } from './types';

export const RETENTION_MONTHS = 3;

/** 今天往前 N 個月的同一天（月底自動調整，例如 5/31 → 2/28）。 */
export function monthsAgo(today: IsoDate, months: number): IsoDate {
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const first = new Date(Date.UTC(y, m - 1 - months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, last))).toISOString().slice(0, 10);
}

export interface CleanupPlan {
  cutoff: IsoDate;
  invoiceIds: string[];
  taskIds: string[];
  claimIds: string[];
  checklistIds: string[];
  /** 隨紀錄一併刪除的附件檔案。 */
  attachmentIds: string[];
  total: number;
}

type InvoiceLike = Omit<Invoice, 'counterpartyName'>;

export function planCleanup(data: { invoices: InvoiceLike[]; tasks: Task[]; claims: StaffClaim[]; checklists: Checklist[] }, today: IsoDate, months = RETENTION_MONTHS): CleanupPlan {
  const cutoff = monthsAgo(today, months);
  const attachmentIds: string[] = [];
  const invoiceIds = data.invoices.filter((raw) => {
    const inv = computeInvoice({ ...raw, counterpartyName: '' }, today);
    if (inv.status !== 'Paid' && inv.status !== 'Cancelled') return false; // 還有欠款：保留
    const last = [inv.invoiceDate, inv.lastPaymentDate ?? '', inv.isCancelled ? inv.updatedAt.slice(0, 10) : ''].sort().pop()!;
    if (last >= cutoff) return false;
    attachmentIds.push(...(inv.attachments ?? []).map((a) => a.id));
    return true;
  }).map((i) => i.id);
  const taskIds = data.tasks.filter((t) => (t.status === 'done' || t.status === 'cancelled') && (t.completedOn ?? t.dueDate) < cutoff).map((t) => t.id);
  const claimIds = data.claims.filter((c) => {
    const ended = c.status === 'paid' ? c.paidDate : c.status === 'rejected' ? (c.decidedOn ?? c.expenseDate) : null;
    if (!ended || ended >= cutoff) return false;
    if (c.receipt) attachmentIds.push(c.receipt.id);
    return true;
  }).map((c) => c.id);
  const cutoffMonth = cutoff.slice(0, 7);
  const checklistIds = data.checklists.filter((c) => c.month < cutoffMonth && checklistProgress(c).pct === 100).map((c) => c.id);
  return { cutoff, invoiceIds, taskIds, claimIds, checklistIds, attachmentIds, total: invoiceIds.length + taskIds.length + claimIds.length + checklistIds.length };
}

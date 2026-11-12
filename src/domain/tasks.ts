/**
 * 每日工作與提醒中心：任務模型（Task model）
 *
 * 設計原則：
 *   - 日期一律為馬來西亞時區（Asia/Kuala_Lumpur）的 ISO 日期字串。
 *   - 未完成的任務「不會」被移動或刪除：保留原到期日，於今天清單中顯示為「逾期（延續）」。
 *   - 由週期規則產生的任務，ID 固定為 rec-<規則ID>-<排程日期>，因此重複產生也只會是同一筆，不會出現重複任務。
 */
import { addDays, daysBetween, type IsoDate } from './dates';

export const TASK_CATEGORIES = ['AP', 'AR', 'GL', 'Payroll', 'Banking', 'Administration', 'Month-End Closing'] as const;
export type TaskCategory = (typeof TASK_CATEGORIES)[number];

export const TASK_PRIORITIES = ['Low', 'Medium', 'High', 'Urgent'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/** 任務狀態：待辦、進行中、已完成、已取消（取消的任務不計入完成率）。 */
export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'cancelled';
export const TASK_STATUS_LABEL: Record<TaskStatus, string> = { todo: 'To do', in_progress: 'In progress', done: 'Completed', cancelled: 'Cancelled' };

export const PRIORITY_RANK: Record<TaskPriority, number> = { Urgent: 0, High: 1, Medium: 2, Low: 3 };

export interface Task {
  id: string;
  title: string;
  description: string;
  category: TaskCategory;
  priority: TaskPriority;
  startDate: IsoDate | null;
  dueDate: IsoDate;
  status: TaskStatus;
  remarks: string;
  createdAt: string;
  updatedAt: string;
  /** 完成時間（ISO 時間戳）與完成日（馬來西亞日期），用於完成率與歷史紀錄。 */
  completedAt: string | null;
  completedOn: IsoDate | null;
  /** 由週期規則產生時：規則 ID 與原排程日期（去重複的依據）。 */
  recurrenceId: string | null;
  occurrenceDate: IsoDate | null;
}

export const isOpen = (t: Pick<Task, 'status'>) => t.status === 'todo' || t.status === 'in_progress';

/** 是否逾期：未完成且今天已超過到期日。 */
export const isTaskOverdue = (t: Pick<Task, 'status' | 'dueDate'>, today: IsoDate) => isOpen(t) && t.dueDate < today;

export const taskDaysOverdue = (t: Pick<Task, 'status' | 'dueDate'>, today: IsoDate) => (isTaskOverdue(t, today) ? daysBetween(t.dueDate, today) : 0);

/** 排序：逾期最久 → 到期日 → 優先度 → 標題。 */
export function compareTasks(a: Task, b: Task): number {
  return a.dueDate.localeCompare(b.dueDate) || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.title.localeCompare(b.title);
}

/** 新任務欄位（表單）。 */
export interface TaskInput {
  title: string;
  description?: string;
  category: TaskCategory;
  priority: TaskPriority;
  startDate?: IsoDate | null;
  dueDate: IsoDate;
  status?: TaskStatus;
  remarks?: string;
}

/** 由表單建立任務物件。 */
export function newTask(id: string, input: TaskInput, nowIso: string, today: IsoDate): Task {
  const status = input.status ?? 'todo';
  return {
    id,
    title: input.title.trim(),
    description: (input.description ?? '').trim(),
    category: input.category,
    priority: input.priority,
    startDate: input.startDate || null,
    dueDate: input.dueDate,
    status,
    remarks: (input.remarks ?? '').trim(),
    createdAt: nowIso,
    updatedAt: nowIso,
    completedAt: status === 'done' ? nowIso : null,
    completedOn: status === 'done' ? today : null,
    recurrenceId: null,
    occurrenceDate: null,
  };
}

/** 變更狀態：完成時記錄完成時間；重新打開時清除。 */
export function withStatus(task: Task, status: TaskStatus, nowIso: string, today: IsoDate): Task {
  const done = status === 'done';
  return {
    ...task,
    status,
    updatedAt: nowIso,
    completedAt: done ? (task.status === 'done' ? task.completedAt : nowIso) : null,
    completedOn: done ? (task.status === 'done' ? task.completedOn : today) : null,
  };
}

/** 驗證任務欄位，回傳 { 欄位: 錯誤訊息 }。 */
export function validateTaskInput(input: Partial<TaskInput>): Record<string, string> {
  const e: Record<string, string> = {};
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (!input.title?.trim()) e.title = 'Title is required';
  else if (input.title.trim().length > 150) e.title = 'Title is too long (max 150)';
  if (!input.category || !TASK_CATEGORIES.includes(input.category)) e.category = 'Choose a category';
  if (!input.priority || !TASK_PRIORITIES.includes(input.priority)) e.priority = 'Choose a priority';
  if (!input.dueDate || !iso.test(input.dueDate)) e.dueDate = 'Due date is required';
  if (input.startDate && !iso.test(input.startDate)) e.startDate = 'Start date is not valid';
  if (input.startDate && input.dueDate && input.startDate > input.dueDate) e.startDate = 'Start date cannot be after the due date';
  if ((input.description ?? '').length > 2000) e.description = 'Description is too long (max 2000)';
  if ((input.remarks ?? '').length > 2000) e.remarks = 'Remarks are too long (max 2000)';
  return e;
}

export { addDays };

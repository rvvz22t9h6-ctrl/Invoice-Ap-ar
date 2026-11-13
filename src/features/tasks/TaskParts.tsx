/**
 * 任務共用元件：優先度／類別標籤、任務列（勾選完成）、新增／編輯表單、快速新增。
 */
import { useMemo, useState, type ReactNode, type SyntheticEvent } from 'react';
import { Alert, Button, cx, Modal, SelectInput, TextArea, TextInput } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import { daysBetween, formatDate, type IsoDate } from '@/domain/dates';
import { can } from '@/domain/permissions';
import { parseQuickAdd } from '@/domain/taskInsights';
import {
  isOpen, isTaskOverdue, TASK_CATEGORIES, TASK_PRIORITIES, TASK_STATUS_LABEL, validateTaskInput,
  type Task, type TaskCategory, type TaskInput, type TaskPriority, type TaskStatus,
} from '@/domain/tasks';
import { useAuth } from '@/features/auth/AuthContext';
import { useRecurrences, useTaskMutations, useToday } from '@/hooks/useTasks';

// ---------------------------------------------------------------------------
// 標籤
// ---------------------------------------------------------------------------

const PRIORITY_STYLE: Record<TaskPriority, string> = {
  Urgent: 'bg-red-600 text-white',
  High: 'bg-orange-100 text-orange-800 ring-1 ring-inset ring-orange-200',
  Medium: 'bg-slate-100 text-slate-700 ring-1 ring-inset ring-slate-200',
  Low: 'bg-white text-slate-500 ring-1 ring-inset ring-slate-200',
};
export function PriorityBadge({ priority }: { priority: TaskPriority }) {
  return <span className={cx('inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-semibold whitespace-nowrap', PRIORITY_STYLE[priority])}>{priority === 'Urgent' ? '▲ ' : ''}{priority}</span>;
}

/** 類別顏色：與狀態色分開，只用來辨識類別（並附文字）。 */
export const CATEGORY_DOT: Record<TaskCategory, string> = {
  AP: 'bg-[#ec6f57]', AR: 'bg-[#3b8fc7]', GL: 'bg-[#6250d6]', Payroll: 'bg-[#1baf7a]', Banking: 'bg-[#392c5e]', Administration: 'bg-slate-400', 'Month-End Closing': 'bg-[#e87ba4]',
};
export function CategoryChip({ category }: { category: TaskCategory }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap text-slate-600">
      <span className={cx('size-2 rounded-full', CATEGORY_DOT[category])} aria-hidden />{category}
    </span>
  );
}

const STATUS_STYLE: Record<TaskStatus, string> = {
  todo: 'bg-white text-slate-600 ring-slate-300', in_progress: 'bg-sky-50 text-sky-800 ring-sky-200',
  done: 'bg-emerald-50 text-emerald-800 ring-emerald-200', cancelled: 'bg-slate-50 text-slate-400 ring-slate-200 line-through',
};
export function TaskStatusBadge({ task, today }: { task: Task; today: IsoDate }) {
  if (isTaskOverdue(task, today)) return <span className="inline-flex rounded-full bg-red-50 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-red-700 ring-1 ring-inset ring-red-200">Overdue</span>;
  return <span className={cx('inline-flex rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset', STATUS_STYLE[task.status])}>{TASK_STATUS_LABEL[task.status]}</span>;
}

/** 到期描述：逾期保留原到期日，例如「3 days overdue · was due 9 Nov」。 */
export function dueLabel(t: Task, today: IsoDate): { text: string; tone: 'red' | 'amber' | 'slate' | 'green' } {
  if (t.status === 'done') return { text: `Completed ${t.completedOn ? formatDate(t.completedOn) : ''}`.trim(), tone: 'green' };
  if (t.status === 'cancelled') return { text: 'Cancelled', tone: 'slate' };
  const d = daysBetween(today, t.dueDate);
  if (d < 0) return { text: `${-d} day${d === -1 ? '' : 's'} overdue · was due ${formatDate(t.dueDate)}`, tone: 'red' };
  if (d === 0) return { text: 'Due today', tone: 'amber' };
  if (d === 1) return { text: 'Due tomorrow', tone: 'slate' };
  return { text: `Due ${new Date(`${t.dueDate}T00:00:00Z`).toLocaleDateString('en-MY', { weekday: 'short', timeZone: 'UTC' })} ${formatDate(t.dueDate)}`, tone: 'slate' };
}

// ---------------------------------------------------------------------------
// 刪除按鈕（每列都有，兩步確認：點垃圾桶 → 「Delete? Yes / No」）
// ---------------------------------------------------------------------------

export function TaskDeleteButton({ task }: { task: Task }) {
  const { user } = useAuth();
  const { remove } = useTaskMutations();
  const toast = useToast();
  const [asking, setAsking] = useState(false);
  if (!can(user?.role, 'invoice.edit')) return null;
  const stop = (e: SyntheticEvent) => e.stopPropagation();
  if (asking) {
    return (
      <span className="flex shrink-0 items-center gap-1 text-xs" onClick={stop} data-testid="task-delete-confirm">
        <span className="text-slate-600">Delete?</span>
        <button type="button" disabled={remove.isPending} data-testid="task-delete-yes"
          className="rounded-md bg-red-600 px-2 py-1 font-semibold text-white hover:bg-red-700 disabled:opacity-60"
          onClick={async (e) => {
            stop(e);
            try { await remove.mutateAsync(task.id); toast(`Deleted: ${task.title}`); } catch (err) { toast(err instanceof Error ? err.message : 'Could not delete the task', 'error'); setAsking(false); }
          }}>Yes</button>
        <button type="button" className="rounded-md px-2 py-1 font-medium text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50" onClick={(e) => { stop(e); setAsking(false); }}>No</button>
      </span>
    );
  }
  return (
    <button type="button" onClick={(e) => { stop(e); setAsking(true); }} aria-label={`Delete "${task.title}"`} title="Delete task" data-testid="task-delete"
      className="grid size-8 shrink-0 place-items-center rounded-md text-slate-400 hover:bg-red-50 hover:text-red-600 focus-visible:outline-2 focus-visible:outline-navy-600">
      <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></svg>
    </button>
  );
}

// ---------------------------------------------------------------------------
// 任務列
// ---------------------------------------------------------------------------

export function TaskItem({ task, today, onOpen, compact }: { task: Task; today: IsoDate; onOpen: (t: Task) => void; compact?: boolean }) {
  const { user } = useAuth();
  const { setStatus } = useTaskMutations();
  const toast = useToast();
  const editable = can(user?.role, 'invoice.edit');
  const done = task.status === 'done';
  const due = dueLabel(task, today);
  const toggle = async () => {
    try {
      await setStatus.mutateAsync([task.id, done ? 'todo' : 'done']);
      toast(done ? `Reopened: ${task.title}` : `Completed: ${task.title}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not update the task', 'error');
    }
  };
  return (
    <li className={cx('group flex items-start gap-3 px-4 py-3 hover:bg-slate-50/70', compact && 'py-2')} data-testid="task-item">
      <button type="button" onClick={toggle} disabled={!editable || setStatus.isPending} aria-label={done ? `Mark "${task.title}" as not done` : `Mark "${task.title}" as done`}
        aria-pressed={done} data-testid="task-check"
        className={cx('mt-0.5 grid size-5 shrink-0 place-items-center rounded-md border-2 transition-colors disabled:cursor-default',
          done ? 'border-emerald-600 bg-emerald-600 text-white' : isTaskOverdue(task, today) ? 'border-red-400 hover:bg-red-50' : 'border-slate-300 hover:border-navy-500 hover:bg-navy-50')}>
        {done && <svg viewBox="0 0 20 20" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="3"><path d="m4.5 10.5 3.5 3.5 7.5-8" strokeLinecap="round" strokeLinejoin="round" /></svg>}
      </button>
      <button type="button" onClick={() => onOpen(task)} className="min-w-0 flex-1 text-left">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={cx('text-sm font-medium', done ? 'text-slate-400 line-through' : 'text-slate-900')}>{task.title}</span>
          {task.priority !== 'Medium' && !done && <PriorityBadge priority={task.priority} />}
          {task.recurrenceId && <span className="text-xs text-slate-400" title="Recurring task" aria-label="Recurring task">↻</span>}
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
          <CategoryChip category={task.category} />
          <span className={cx(due.tone === 'red' ? 'font-medium text-red-700' : due.tone === 'amber' ? 'font-medium text-amber-700' : due.tone === 'green' ? 'text-emerald-700' : 'text-slate-500')}>{due.text}</span>
          {!compact && task.remarks && <span className="truncate text-slate-400">· {task.remarks}</span>}
        </span>
      </button>
      <TaskDeleteButton task={task} />
    </li>
  );
}

export function TaskList({ tasks, today, onOpen, empty, compact, testId }: { tasks: Task[]; today: IsoDate; onOpen: (t: Task) => void; empty: ReactNode; compact?: boolean; testId?: string }) {
  if (!tasks.length) return <p className="px-4 py-6 text-center text-sm text-slate-500">{empty}</p>;
  return <ul className="divide-y divide-slate-100" data-testid={testId}>{tasks.map((t) => <TaskItem key={t.id} task={t} today={today} onOpen={onOpen} compact={compact} />)}</ul>;
}

// ---------------------------------------------------------------------------
// 新增／編輯表單
// ---------------------------------------------------------------------------

export function TaskFormModal({ task, defaults, onClose }: { task?: Task | null; defaults?: Partial<TaskInput>; onClose: () => void }) {
  const today = useToday();
  const { user } = useAuth();
  const editable = can(user?.role, 'invoice.edit');
  const { save, remove } = useTaskMutations();
  const { rules } = useRecurrences();
  const toast = useToast();
  const [v, setV] = useState({
    title: task?.title ?? defaults?.title ?? '', description: task?.description ?? '', category: (task?.category ?? defaults?.category ?? 'Administration') as TaskCategory,
    priority: (task?.priority ?? defaults?.priority ?? 'Medium') as TaskPriority, startDate: task?.startDate ?? '', dueDate: task?.dueDate ?? defaults?.dueDate ?? today,
    status: (task?.status ?? 'todo') as TaskStatus, remarks: task?.remarks ?? '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const rule = task?.recurrenceId ? rules.find((r) => r.id === task.recurrenceId) : undefined;
  const set = (k: keyof typeof v, value: string) => { setV((x) => ({ ...x, [k]: value })); setErrors((e) => ({ ...e, [k]: '' })); };

  const submit = async () => {
    const input: TaskInput = { ...v, startDate: v.startDate || null };
    const e = validateTaskInput(input);
    if (Object.keys(e).length) { setErrors(e); return; }
    try {
      await save.mutateAsync([input, task?.id]);
      toast(task ? 'Task updated' : 'Task added');
      onClose();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not save the task');
    }
  };
  const del = async () => {
    await remove.mutateAsync(task!.id);
    toast('Task deleted');
    onClose();
  };

  if (confirmDelete && task) {
    return (
      <Modal open onClose={() => setConfirmDelete(false)} size="sm" title="Delete this task?"
        footer={<><Button onClick={() => setConfirmDelete(false)}>Keep it</Button><Button variant="danger" loading={remove.isPending} onClick={del} data-testid="confirm-delete-task">Delete task</Button></>}>
        <p className="text-sm text-slate-600">{task.recurrenceId ? 'This occurrence is removed and will not be created again. Other occurrences of the recurring task are not affected.' : 'The task is removed permanently. To keep a record, mark it as Cancelled instead.'}</p>
      </Modal>
    );
  }

  return (
    <Modal open onClose={onClose} size="md" title={task ? (editable ? 'Edit task' : 'Task') : 'New task'}
      subtitle={rule ? `Part of recurring task: ${rule.title}` : task?.recurrenceId ? 'Created by a recurring task' : undefined}
      footer={editable ? <>
        {task && <Button variant="danger" className="mr-auto" onClick={() => setConfirmDelete(true)} data-testid="delete-task">Delete</Button>}
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={submit} loading={save.isPending} data-testid="save-task">{task ? 'Save changes' : 'Add task'}</Button>
      </> : <Button onClick={onClose}>Close</Button>}>
      <form className="grid grid-cols-1 gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate>
        <TextInput label="Task title *" containerClassName="sm:col-span-2" value={v.title} error={errors.title} maxLength={150} disabled={!editable} onChange={(e) => set('title', e.target.value)} />
        <SelectInput label="Category *" value={v.category} error={errors.category} disabled={!editable} onChange={(e) => set('category', e.target.value)}>
          {TASK_CATEGORIES.map((c) => <option key={c}>{c}</option>)}
        </SelectInput>
        <SelectInput label="Priority *" value={v.priority} error={errors.priority} disabled={!editable} onChange={(e) => set('priority', e.target.value)}>
          {TASK_PRIORITIES.map((p) => <option key={p}>{p}</option>)}
        </SelectInput>
        <TextInput label="Start date" type="date" value={v.startDate} error={errors.startDate} max={v.dueDate} disabled={!editable} onChange={(e) => set('startDate', e.target.value)} hint="Optional: when you plan to begin" />
        <TextInput label="Due date *" type="date" value={v.dueDate} error={errors.dueDate} disabled={!editable} onChange={(e) => set('dueDate', e.target.value)} />
        <SelectInput label="Status" value={v.status} disabled={!editable} onChange={(e) => set('status', e.target.value)}>
          {(Object.keys(TASK_STATUS_LABEL) as TaskStatus[]).map((s) => <option key={s} value={s}>{TASK_STATUS_LABEL[s]}</option>)}
        </SelectInput>
        <div className="text-xs text-slate-500 sm:self-end sm:pb-2">
          {task?.completedAt ? `Completed ${formatDate(task.completedOn)}` : task && isTaskOverdue(task, today) ? <span className="font-medium text-red-700">Overdue since {formatDate(task.dueDate)}. The original due date is kept.</span> : null}
        </div>
        <TextArea label="Description" containerClassName="sm:col-span-2" rows={2} value={v.description} error={errors.description} maxLength={2000} disabled={!editable} onChange={(e) => set('description', e.target.value)} />
        <TextArea label="Remarks" containerClassName="sm:col-span-2" rows={2} value={v.remarks} error={errors.remarks} maxLength={2000} disabled={!editable} placeholder="Progress notes, reference numbers, who to follow up" onChange={(e) => set('remarks', e.target.value)} />
        {formError && <div className="sm:col-span-2"><Alert>{formError}</Alert></div>}
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// 快速新增
// ---------------------------------------------------------------------------

const LAST_CAT_KEY = 'invoice-ap-ar:quick-add-category';

export function QuickAdd({ defaultDue }: { defaultDue?: IsoDate }) {
  const today = useToday();
  const { save } = useTaskMutations();
  const toast = useToast();
  const [text, setText] = useState('');
  const [category, setCategory] = useState<TaskCategory>(() => {
    try { return (localStorage.getItem(LAST_CAT_KEY) as TaskCategory) || 'Administration'; } catch { return 'Administration'; }
  });
  const [priority, setPriority] = useState<TaskPriority>('Medium');
  const [due, setDue] = useState(defaultDue ?? today);
  const parsed = useMemo(() => parseQuickAdd(text, today), [text, today]);
  const final = { title: parsed.title, category: parsed.category ?? category, priority: parsed.priority ?? priority, dueDate: parsed.dueDate ?? due };

  const submit = async () => {
    if (!final.title) return;
    try {
      await save.mutateAsync([{ title: final.title, category: final.category, priority: final.priority, dueDate: final.dueDate }]);
      try { localStorage.setItem(LAST_CAT_KEY, category); } catch { /* 略過 */ }
      toast(`Added "${final.title}" · due ${formatDate(final.dueDate)}`);
      setText('');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not add the task', 'error');
    }
  };
  const field = 'rounded-lg border-0 bg-white py-2 text-sm shadow-sm ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-navy-600';
  return (
    <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void submit(); }} data-testid="quick-add">
      <div className="flex flex-wrap gap-2">
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a task… e.g. Pay TNB bill tomorrow #banking !high" aria-label="Quick add task"
          className={cx(field, 'min-w-[220px] flex-[3] px-3')} maxLength={200} data-testid="quick-add-input" />
        <select aria-label="Category" value={parsed.category ?? category} onChange={(e) => setCategory(e.target.value as TaskCategory)} className={cx(field, 'flex-1 pr-8 pl-3')} disabled={!!parsed.category}>
          {TASK_CATEGORIES.map((c) => <option key={c}>{c}</option>)}
        </select>
        <select aria-label="Priority" value={parsed.priority ?? priority} onChange={(e) => setPriority(e.target.value as TaskPriority)} className={cx(field, 'w-32 pr-8 pl-3')} disabled={!!parsed.priority}>
          {TASK_PRIORITIES.map((p) => <option key={p}>{p}</option>)}
        </select>
        <input type="date" aria-label="Due date" value={parsed.dueDate ?? due} onChange={(e) => setDue(e.target.value || today)} className={cx(field, 'w-40 px-2')} disabled={!!parsed.dueDate} />
        <Button type="submit" variant="primary" loading={save.isPending} disabled={!final.title} data-testid="quick-add-submit">Add</Button>
      </div>
      <p className="text-xs text-slate-500">
        {text.trim() && final.title
          ? <>Will add <strong className="text-slate-700">{final.title}</strong> · {final.category} · {final.priority} · due {formatDate(final.dueDate)}</>
          : <>Shortcuts: <code>today</code> <code>tomorrow</code> <code>fri</code> <code>25/11</code> <code>eom</code> · <code>#payroll</code> <code>#ap</code> <code>#monthend</code> · <code>!high</code> <code>!!</code> for urgent</>}
      </p>
    </form>
  );
}

export { isOpen };

/**
 * 全部任務：搜尋與篩選（檢視、類別、優先度、日期區間），可排序。
 */
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, Card, FilterSelect, PageHeader } from '@/components/ui';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { addDays, formatDate } from '@/domain/dates';
import { can } from '@/domain/permissions';
import { isOpen, isTaskOverdue, PRIORITY_RANK, TASK_CATEGORIES, TASK_PRIORITIES, type Task } from '@/domain/tasks';
import { useAuth } from '@/features/auth/AuthContext';
import { useTasks, useToday } from '@/hooks/useTasks';
import { CategoryChip, dueLabel, PriorityBadge, TaskFormModal, TaskStatusBadge } from './TaskParts';

type ViewKey = 'open' | 'overdue' | 'next30' | 'done' | 'all';

export function AllTasksPage() {
  const { tasks } = useTasks();
  const today = useToday();
  const { user } = useAuth();
  const [params] = useSearchParams();
  const [view, setView] = useState<ViewKey>(() => (params.get('view') as ViewKey) || 'open');
  const [category, setCategory] = useState('');
  const [priority, setPriority] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Task | null>(null);
  const [creating, setCreating] = useState(false);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return tasks.filter((t) =>
      (view === 'all' || (view === 'open' && isOpen(t)) || (view === 'overdue' && isTaskOverdue(t, today)) || (view === 'done' && t.status === 'done')
        || (view === 'next30' && isOpen(t) && t.dueDate >= today && t.dueDate <= addDays(today, 30)))
      && (!category || t.category === category) && (!priority || t.priority === priority)
      && (!needle || [t.title, t.description, t.remarks].some((s) => s.toLowerCase().includes(needle))));
  }, [tasks, view, category, priority, q, today]);

  const cols: Column<Task>[] = [
    { key: 'title', header: 'Task', sortValue: (t) => t.title, render: (t) => <><span className="font-medium text-slate-900">{t.title}{t.recurrenceId && <span className="ml-1 text-xs text-slate-400" title="Recurring">↻</span>}</span>{t.description && <span className="block max-w-md truncate text-xs text-slate-500">{t.description}</span>}</> },
    { key: 'cat', header: 'Category', hideOnMobile: true, sortValue: (t) => t.category, render: (t) => <CategoryChip category={t.category} /> },
    { key: 'pri', header: 'Priority', sortValue: (t) => PRIORITY_RANK[t.priority], render: (t) => <PriorityBadge priority={t.priority} /> },
    { key: 'start', header: 'Start', hideOnMobile: true, sortValue: (t) => t.startDate ?? '', render: (t) => <span className="whitespace-nowrap">{formatDate(t.startDate)}</span> },
    { key: 'due', header: 'Due', sortValue: (t) => t.dueDate, render: (t) => { const d = dueLabel(t, today); return <span className="whitespace-nowrap">{formatDate(t.dueDate)}<span className={`block text-xs ${d.tone === 'red' ? 'text-red-700' : 'text-slate-500'}`}>{isOpen(t) ? d.text.split(' · ')[0] : ''}</span></span>; } },
    { key: 'status', header: 'Status', sortValue: (t) => t.status, render: (t) => <TaskStatusBadge task={t} today={today} /> },
    { key: 'remarks', header: 'Remarks', wideOnly: true, render: (t) => <span className="block max-w-xs truncate text-xs text-slate-500">{t.remarks || '—'}</span> },
  ];

  return (
    <>
      <PageHeader eyebrow="My Day" title="All Tasks" subtitle="Search and filter every task. Overdue tasks are never removed automatically."
        actions={can(user?.role, 'invoice.edit') ? <Button variant="primary" onClick={() => setCreating(true)} data-testid="new-task-all">+ New task</Button> : undefined} />
      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-4">
          <FilterSelect label="View" value={view} onChange={(x) => setView(x as ViewKey)}>
            <option value="open">Open tasks</option><option value="overdue">Overdue</option><option value="next30">Due in the next 30 days</option><option value="done">Completed</option><option value="all">All tasks</option>
          </FilterSelect>
          <FilterSelect label="Category" value={category} onChange={setCategory}><option value="">All categories</option>{TASK_CATEGORIES.map((c) => <option key={c}>{c}</option>)}</FilterSelect>
          <FilterSelect label="Priority" value={priority} onChange={setPriority}><option value="">All priorities</option>{TASK_PRIORITIES.map((p) => <option key={p}>{p}</option>)}</FilterSelect>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search title, description or remarks" aria-label="Search tasks"
            className="min-w-[200px] flex-1 rounded-lg border-0 px-3 py-2 text-sm shadow-sm ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-navy-600" />
        </div>
        <DataTable testId="task-table" rows={rows} columns={cols} rowKey={(t) => t.id} onRowClick={setOpen} initialSort={{ key: 'due', dir: 'asc' }}
          emptyTitle={tasks.length ? 'No tasks match these filters' : 'No tasks yet'} emptyDescription={tasks.length ? undefined : 'Add tasks from My Day, or set up recurring tasks.'} />
      </Card>
      {(open || creating) && <TaskFormModal task={open} onClose={() => { setOpen(null); setCreating(false); }} />}
    </>
  );
}

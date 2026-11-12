/**
 * 任務行事曆（日／週／月檢視）。依到期日顯示；點日期可新增任務，點任務可編輯。
 * 週一為一週的第一天；顏色依類別，逾期以紅色外框標示。
 */
import { useMemo, useState } from 'react';
import { Button, Card, cx, PageHeader } from '@/components/ui';
import { addDays, formatDate, type IsoDate } from '@/domain/dates';
import { can } from '@/domain/permissions';
import { compareTasks, isTaskOverdue, type Task } from '@/domain/tasks';
import { useAuth } from '@/features/auth/AuthContext';
import { useTasks, useToday } from '@/hooks/useTasks';
import { CATEGORY_DOT, TaskFormModal, TaskList } from './TaskParts';

type View = 'day' | 'week' | 'month';
const WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const mondayOf = (d: IsoDate) => addDays(d, -((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7));
const monthLabel = (d: IsoDate) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-MY', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const dayNum = (d: IsoDate) => Number(d.slice(8));

export function TaskCalendarPage() {
  const { tasks } = useTasks();
  const today = useToday();
  const { user } = useAuth();
  const [view, setView] = useState<View>('month');
  const [cursor, setCursor] = useState(today);
  const [open, setOpen] = useState<Task | null>(null);
  const [newOn, setNewOn] = useState<IsoDate | null>(null);
  const canEdit = can(user?.role, 'invoice.edit');
  const byDate = useMemo(() => {
    const m = new Map<IsoDate, Task[]>();
    for (const t of tasks.filter((x) => x.status !== 'cancelled').sort(compareTasks)) (m.get(t.dueDate) ?? m.set(t.dueDate, []).get(t.dueDate)!).push(t);
    return m;
  }, [tasks]);

  const move = (dir: number) => {
    if (view === 'day') setCursor(addDays(cursor, dir));
    else if (view === 'week') setCursor(addDays(cursor, dir * 7));
    else { const [y, m] = cursor.split('-').map(Number) as [number, number]; const d = new Date(Date.UTC(y, m - 1 + dir, 1)); setCursor(d.toISOString().slice(0, 10)); }
  };
  const title = view === 'day' ? new Date(`${cursor}T00:00:00Z`).toLocaleDateString('en-MY', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
    : view === 'week' ? `Week of ${formatDate(mondayOf(cursor))}` : monthLabel(cursor);

  const chip = (t: Task) => (
    <button key={t.id} type="button" onClick={(e) => { e.stopPropagation(); setOpen(t); }} title={`${t.title} · ${t.category} · ${t.priority}`} data-testid="cal-task"
      className={cx('flex w-full items-center gap-1.5 truncate rounded px-1.5 py-0.5 text-left text-[11px] leading-tight',
        t.status === 'done' ? 'text-slate-400 line-through' : isTaskOverdue(t, today) ? 'bg-red-50 font-medium text-red-800 ring-1 ring-red-200' : 'bg-slate-50 text-slate-800 hover:bg-navy-50')}>
      <span className={cx('size-1.5 shrink-0 rounded-full', CATEGORY_DOT[t.category])} aria-hidden /><span className="truncate">{t.title}</span>
    </button>
  );

  const dayCell = (d: IsoDate, inMonth: boolean, max: number) => {
    const list = byDate.get(d) ?? [];
    return (
      <div key={d} role="gridcell" aria-label={`${formatDate(d)}, ${list.length} tasks`} onClick={() => canEdit && setNewOn(d)}
        className={cx('min-h-24 min-w-0 border-t border-l border-slate-100 p-1.5', canEdit && 'cursor-pointer hover:bg-slate-50/60', !inMonth && 'bg-slate-50/50')}>
        <div className="mb-1 flex items-center justify-between">
          <span className={cx('grid size-6 place-items-center rounded-full text-xs', d === today ? 'bg-navy-800 font-semibold text-white' : inMonth ? 'text-slate-700' : 'text-slate-400')}>{dayNum(d)}</span>
          {list.length > max && <span className="text-[10px] text-slate-400">{list.length}</span>}
        </div>
        <div className="space-y-0.5">{list.slice(0, max).map(chip)}{list.length > max && <button type="button" onClick={(e) => { e.stopPropagation(); setView('day'); setCursor(d); }} className="px-1.5 text-[11px] font-medium text-navy-700 hover:underline">+{list.length - max} more</button>}</div>
      </div>
    );
  };

  let body;
  if (view === 'month') {
    const first = `${cursor.slice(0, 7)}-01`;
    const start = mondayOf(first);
    const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
    const weeks = days[35]!.slice(0, 7) === cursor.slice(0, 7) ? 6 : 5;
    body = (
      <div className="overflow-x-auto"><div className="min-w-[640px]" role="grid" data-testid="cal-month">
        <div className="grid grid-cols-7 text-center text-[11px] font-semibold uppercase tracking-wide text-slate-500">{WEEK.map((w) => <div key={w} className="py-2">{w}</div>)}</div>
        <div className="grid grid-cols-7 border-r border-b border-slate-100">{days.slice(0, weeks * 7).map((d) => dayCell(d, d.slice(0, 7) === cursor.slice(0, 7), 3))}</div>
      </div></div>
    );
  } else if (view === 'week') {
    const start = mondayOf(cursor);
    body = (
      <div className="overflow-x-auto"><div className="grid min-w-[760px] grid-cols-7 border-r border-b border-slate-100" role="grid" data-testid="cal-week">
        {Array.from({ length: 7 }, (_, i) => addDays(start, i)).map((d, i) => (
          <div key={d} className="min-w-0">
            <div className={cx('border-l border-slate-100 py-2 text-center text-xs font-semibold', d === today ? 'text-navy-800' : 'text-slate-500')}>{WEEK[i]} {dayNum(d)}</div>
            {dayCell(d, true, 12)}
          </div>
        ))}
      </div></div>
    );
  } else {
    body = <TaskList tasks={byDate.get(cursor) ?? []} today={today} onOpen={setOpen} empty="No tasks are due on this day." testId="cal-day" />;
  }

  return (
    <>
      <PageHeader eyebrow="My Day" title="Task Calendar" subtitle="Tasks by due date. Click a day to add a task." />
      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-3">
          <div className="inline-flex rounded-lg bg-slate-100 p-0.5 text-sm font-medium" role="tablist" aria-label="Calendar view">
            {(['day', 'week', 'month'] as View[]).map((v) => (
              <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => setView(v)} data-testid={`view-${v}`}
                className={cx('rounded-md px-3 py-1.5 capitalize', view === v ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800')}>{v === 'day' ? 'Daily' : v === 'week' ? 'Weekly' : 'Monthly'}</button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            <Button size="sm" variant="ghost" onClick={() => move(-1)} aria-label="Previous">‹</Button>
            <Button size="sm" onClick={() => setCursor(today)}>Today</Button>
            <Button size="sm" variant="ghost" onClick={() => move(1)} aria-label="Next">›</Button>
          </div>
          <h2 className="font-display text-base font-semibold text-slate-900" data-testid="cal-title">{title}</h2>
        </div>
        {body}
      </Card>
      {(open || newOn) && <TaskFormModal task={open} defaults={newOn ? { dueDate: newOn } : undefined} onClose={() => { setOpen(null); setNewOn(null); }} />}
    </>
  );
}

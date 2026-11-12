/**
 * 我的一天（My Day）— 每日工作總覽
 *
 * 今日任務（含延續的逾期任務）、已完成、待辦、逾期、即將到期，以及快速新增與提醒中心。
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, PageHeader, Spinner, StatCard } from '@/components/ui';
import { COMPANY_TIME_ZONE, formatDate } from '@/domain/dates';
import { can } from '@/domain/permissions';
import { buildProductivity, buildReminders, buildTaskOverview } from '@/domain/taskInsights';
import type { Task } from '@/domain/tasks';
import { useAuth } from '@/features/auth/AuthContext';
import { useTasks, useToday } from '@/hooks/useTasks';
import { NotificationToggle, ReminderList } from './ReminderCentre';
import { QuickAdd, TaskFormModal, TaskList } from './TaskParts';

export function MyDayPage() {
  const { tasks, isLoading } = useTasks();
  const today = useToday();
  const { user } = useAuth();
  const [open, setOpen] = useState<Task | null>(null);
  const [creating, setCreating] = useState(false);
  const o = useMemo(() => buildTaskOverview(tasks, today), [tasks, today]);
  const reminders = useMemo(() => buildReminders(tasks, today), [tasks, today]);
  const p = useMemo(() => buildProductivity(tasks, today), [tasks, today]);
  const canEdit = can(user?.role, 'invoice.edit');
  const weekday = new Date().toLocaleDateString('en-MY', { weekday: 'long', timeZone: COMPANY_TIME_ZONE });

  if (isLoading) return <div className="grid h-64 place-items-center text-slate-400"><Spinner /></div>;
  const pct = (r: number | null) => (r === null ? '—' : `${Math.round(r * 100)}%`);

  return (
    <>
      <PageHeader eyebrow={`My Day · ${weekday}, ${formatDate(today)} (MYT)`} title="Daily Task & Reminder Centre"
        subtitle="Every finance and payroll responsibility in one place. Unfinished tasks carry forward with their original due dates until you complete them." />

      {canEdit && <Card className="mb-6"><QuickAdd /></Card>}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <StatCard testId="task-kpi-today" accent="navy" icon="doc" label="Today's tasks" value={o.counts.today} hint={`${o.dueToday.length} due today · ${o.carriedForward.length} carried over`} />
        <StatCard testId="task-kpi-completed" accent="green" icon="check" label="Completed today" value={o.counts.completedToday} hint={`Today's rate ${pct(p.todayRate)}`} />
        <StatCard testId="task-kpi-pending" accent="slate" icon="clock" label="Pending" value={o.counts.pending} hint="Open, not yet due" />
        <StatCard testId="task-kpi-overdue" accent="red" icon="alert" label="Overdue" value={o.counts.overdue} hint={o.counts.overdue ? 'Still on your list' : 'All caught up'} />
        <StatCard testId="task-kpi-upcoming" accent="amber" icon="trend" label="Due in 7 days" value={o.counts.upcoming} hint={`This week ${pct(p.weekRate)} done`} />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card title={`Today · ${formatDate(today)}`} padded={false}
            action={canEdit ? <button type="button" className="text-xs font-medium text-navy-700 hover:underline" onClick={() => setCreating(true)} data-testid="new-task">+ New task</button> : undefined}>
            {o.carriedForward.length > 0 && (
              <div className="border-b border-red-100 bg-red-50/40">
                <p className="px-4 pt-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-red-700">Carried over · overdue ({o.carriedForward.length})</p>
                <TaskList tasks={o.carriedForward} today={today} onOpen={setOpen} empty="" testId="carried-list" />
              </div>
            )}
            <p className="px-4 pt-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">Due today ({o.dueToday.length})</p>
            <TaskList tasks={o.dueToday} today={today} onOpen={setOpen} testId="today-list"
              empty={o.carriedForward.length ? 'Nothing else is due today.' : 'Nothing is due today. Add a task above or check upcoming deadlines.'} />
            {o.inProgress.length > 0 && (
              <>
                <p className="border-t border-slate-100 px-4 pt-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">Started, due later ({o.inProgress.length})</p>
                <TaskList tasks={o.inProgress} today={today} onOpen={setOpen} empty="" compact />
              </>
            )}
          </Card>

          <Card title="Upcoming deadlines · next 7 days" padded={false} action={<Link to="/tasks/calendar" className="text-xs font-medium text-navy-700 hover:underline">Calendar →</Link>}>
            <TaskList tasks={o.upcoming} today={today} onOpen={setOpen} empty="No deadlines in the next 7 days." testId="upcoming-list" compact />
          </Card>
        </div>

        <div className="space-y-6">
          <Card title="Reminder Centre">
            <ReminderList reminders={reminders} />
            <div className="mt-4 border-t border-slate-100 pt-3"><NotificationToggle /></div>
          </Card>
          <Card title={`Completed today (${o.completedToday.length})`} padded={false} action={<Link to="/tasks/productivity" className="text-xs font-medium text-navy-700 hover:underline">History →</Link>}>
            <TaskList tasks={o.completedToday} today={today} onOpen={setOpen} empty="Tick a task when it's done and it appears here." testId="completed-list" compact />
          </Card>
        </div>
      </div>

      {(open || creating) && <TaskFormModal task={open} onClose={() => { setOpen(null); setCreating(false); }} />}
    </>
  );
}

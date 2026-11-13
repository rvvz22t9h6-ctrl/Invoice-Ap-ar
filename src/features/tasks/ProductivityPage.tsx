/**
 * 生產力追蹤：每日／每週完成率、逾期數、準時率、連續達成天數、近 14 天趨勢與完成紀錄。
 */
import { useMemo } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card, PageHeader, StatCard } from '@/components/ui';
import { formatDate, formatDateTime } from '@/domain/dates';
import { buildProductivity } from '@/domain/taskInsights';
import { useTasks, useToday } from '@/hooks/useTasks';
import { CategoryChip } from './TaskParts';

const pct = (r: number | null) => (r === null ? '—' : `${Math.round(r * 100)}%`);

export function ProductivityPage() {
  const { tasks } = useTasks();
  const today = useToday();
  const p = useMemo(() => buildProductivity(tasks, today), [tasks, today]);
  const data = p.history.map((d) => ({ label: formatDate(d.date).slice(0, 6), Due: d.due, Completed: d.completed }));
  return (
    <>
      <PageHeader eyebrow="My Day" title="Productivity" subtitle="How well you keep up with tasks as they fall due." />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <StatCard testId="prod-today" accent="navy" icon="check" label="Today's completion" value={pct(p.todayRate)} hint={`${p.history.at(-1)!.completed} of ${p.history.at(-1)!.due} due today`} />
        <StatCard testId="prod-week" accent="green" icon="trend" label="This week" value={pct(p.weekRate)} hint={`${p.weekCompleted} of ${p.weekDue} since ${formatDate(p.weekStart).slice(0, 6)}`} />
        <StatCard testId="prod-overdue" accent="red" icon="alert" label="Overdue tasks" value={p.overdueCount} hint="Open and past due" />
        <StatCard testId="prod-ontime" accent="amber" icon="clock" label="On time · 30 days" value={pct(p.onTimeRate30)} hint="Completed by the due date" />
        <StatCard testId="prod-streak" accent="slate" icon="doc" label="Streak" value={`${p.streak} day${p.streak === 1 ? '' : 's'}`} hint="Days with every task done" />
      </div>
      <Card className="mt-6" title="Last 14 days">
        <div className="h-64" data-testid="prod-chart">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} barGap={2} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="#eef0f3" />
              <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: '#d5d9e0' }} tick={{ fontSize: 11, fill: '#64748b' }} interval="preserveStartEnd" />
              <YAxis allowDecimals={false} tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: '#64748b' }} />
              <Tooltip cursor={{ fill: 'rgba(57,44,94,0.05)' }} contentStyle={{ borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 12 }} />
              <Legend verticalAlign="top" align="right" iconType="circle" iconSize={8} height={28} wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="Due" fill="#c4afe8" radius={[4, 4, 0, 0]} maxBarSize={16} animationDuration={400} />
              <Bar dataKey="Completed" fill="#1e7b4f" radius={[4, 4, 0, 0]} maxBarSize={16} animationDuration={400} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full text-sm" data-testid="prod-table">
            <thead className="text-xs uppercase tracking-wide text-slate-500"><tr><th className="py-2 text-left">Day</th><th className="py-2 text-right">Due</th><th className="py-2 text-right">Completed</th><th className="py-2 text-right">On time</th><th className="py-2 text-right">Rate</th></tr></thead>
            <tbody className="divide-y divide-slate-100">
              {[...p.history].reverse().map((d) => (
                <tr key={d.date}><td className="py-1.5">{formatDate(d.date)}{d.date === today ? ' (today)' : ''}</td><td className="tabular py-1.5 text-right">{d.due}</td><td className="tabular py-1.5 text-right">{d.completed}</td><td className="tabular py-1.5 text-right">{d.onTime}</td><td className="tabular py-1.5 text-right font-medium">{pct(d.rate)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Card className="mt-6" title="Completion history" padded={false}>
        {p.recentlyCompleted.length === 0 ? <p className="px-5 py-6 text-center text-sm text-slate-500">Completed tasks will be listed here.</p> : (
          <ul className="divide-y divide-slate-100" data-testid="history-list">
            {p.recentlyCompleted.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-2.5 text-sm">
                <span className="min-w-0"><span className="font-medium text-slate-800">{t.title}</span> <CategoryChip category={t.category} /></span>
                <span className={t.completedOn && t.completedOn > t.dueDate ? 'text-xs text-amber-700' : 'text-xs text-slate-500'}>
                  Done {formatDateTime(t.completedAt)}{t.completedOn && t.completedOn > t.dueDate ? ` · ${formatDate(t.dueDate)} due (late)` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

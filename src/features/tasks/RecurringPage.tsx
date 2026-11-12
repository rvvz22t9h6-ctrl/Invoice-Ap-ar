/**
 * 週期任務（Recurring tasks）：建立／修改規則、啟用／停用、由範本加入馬來西亞常見的薪資與月結任務。
 */
import { useMemo, useState } from 'react';
import { Alert, Button, Card, cx, Modal, PageHeader, SelectInput, TextArea, TextInput } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import type { RecurrenceInput } from '@/data/repository';
import { addDays, formatDate } from '@/domain/dates';
import { can } from '@/domain/permissions';
import {
  adjustForWeekend, describeRule, FREQUENCY_LABEL, nextDueDate, scheduledDates, WEEKDAY_SHORT,
  type CustomUnit, type Frequency, type RecurrenceRule, type WeekendAdjust,
} from '@/domain/recurrence';
import { TASK_CATEGORIES, TASK_PRIORITIES, type TaskCategory, type TaskPriority } from '@/domain/tasks';
import { RULE_TEMPLATES } from '@/domain/taskTemplates';
import { useAuth } from '@/features/auth/AuthContext';
import { useRecurrences, useTaskMutations, useTasks, useToday } from '@/hooks/useTasks';
import { CategoryChip, PriorityBadge, TaskFormModal, TaskList } from './TaskParts';
import { Link } from 'react-router-dom';
import { isTaskOverdue, type Task } from '@/domain/tasks';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function RecurringPage() {
  const { rules, isLoading } = useRecurrences();
  const { tasks } = useTasks();
  const today = useToday();
  const { user } = useAuth();
  const canEdit = can(user?.role, 'invoice.edit');
  const [editing, setEditing] = useState<RecurrenceRule | 'new' | null>(null);
  const [templates, setTemplates] = useState(false);
  const { saveRule } = useTaskMutations();
  const toast = useToast();
  const [openTask, setOpenTask] = useState<Task | null>(null);
  const overdue = tasks.filter((t) => isTaskOverdue(t, today)).sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  const toggle = async (r: RecurrenceRule) => {
    const { id, generatedThrough: _g, skipDates: _s, createdAt: _c, updatedAt: _u, ...input } = r;
    await saveRule.mutateAsync([{ ...input, active: !r.active }, id]);
    toast(r.active ? `Paused: ${r.title}` : `Resumed: ${r.title}`);
  };

  return (
    <>
      <PageHeader eyebrow="Reminders" title="Reminders"
        subtitle="Daily, weekly and monthly reminders are created automatically, never twice for the same date. Unfinished ones stay on your list as overdue."
        actions={canEdit ? <>
          <Button onClick={() => setTemplates(true)} data-testid="open-templates">Add Malaysian payroll & month-end templates</Button>
          <Button variant="primary" onClick={() => setEditing('new')} data-testid="new-rule">+ New recurring task</Button>
        </> : undefined} />
      {/* 逾期追蹤：一鍵完成 */}
      <Card className="mb-6" title={`Overdue tasks (${overdue.length})`} padded={false}
        action={<Link to="/tasks/all?view=overdue" className="text-xs font-medium text-navy-700 hover:underline">All overdue →</Link>}>
        <TaskList tasks={overdue.slice(0, 15)} today={today} onOpen={setOpenTask} testId="overdue-list" compact empty="Nothing is overdue. Well done." />
      </Card>

      <Card padded={false} title="Recurring schedules">
        {isLoading ? null : rules.length === 0 ? (
          <div className="px-6 py-10 text-center">
            <p className="text-sm font-medium text-slate-800">No recurring tasks yet</p>
            <p className="mt-1 text-sm text-slate-500">Start with the templates for EPF, SOCSO, PCB, payroll and month-end closing, or create your own.</p>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100" data-testid="rule-list">
            {rules.map((r) => {
              const next = nextDueDate(r, today);
              const open = tasks.filter((t) => t.recurrenceId === r.id && (t.status === 'todo' || t.status === 'in_progress') && t.dueDate < today).length;
              return (
                <li key={r.id} className={cx('flex flex-wrap items-center gap-3 px-5 py-3.5', !r.active && 'opacity-60')} data-testid="rule-item">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-900">{r.title} <PriorityBadge priority={r.priority} /> {!r.active && <span className="text-xs font-medium text-slate-500">Paused</span>}</p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-slate-500">
                      <CategoryChip category={r.category} /><span>{describeRule(r)}</span>
                      {r.leadDays > 0 && <span>· starts {r.leadDays} day{r.leadDays === 1 ? '' : 's'} before</span>}
                    </p>
                  </div>
                  <div className="text-right text-xs">
                    <p className="text-slate-500">Next due</p>
                    <p className="font-medium text-slate-800">{r.active && next ? formatDate(next) : '—'}</p>
                    {open > 0 && <p className="font-medium text-red-700">{open} overdue</p>}
                  </div>
                  {canEdit && (
                    <div className="flex gap-1">
                      <Button size="sm" variant="ghost" onClick={() => toggle(r)}>{r.active ? 'Pause' : 'Resume'}</Button>
                      <Button size="sm" onClick={() => setEditing(r)}>Edit</Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      {openTask && <TaskFormModal task={openTask} onClose={() => setOpenTask(null)} />}
      {editing && <RuleFormModal rule={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {templates && <TemplatesModal existing={rules} onClose={() => setTemplates(false)} />}
    </>
  );
}

function RuleFormModal({ rule, onClose }: { rule: RecurrenceRule | null; onClose: () => void }) {
  const today = useToday();
  const { saveRule, removeRule } = useTaskMutations();
  const toast = useToast();
  const [v, setV] = useState<RecurrenceInput>(() => rule ? (({ id: _i, generatedThrough: _g, skipDates: _s, createdAt: _c, updatedAt: _u, ...x }) => x)(rule) : {
    title: '', description: '', category: 'Payroll', priority: 'High', remarks: '', frequency: 'monthly', interval: 1, customUnit: 'week',
    weekdays: [], dayOfMonth: Number(today.slice(8)), month: Number(today.slice(5, 7)), weekendAdjust: 'previous', leadDays: 0, startDate: today, endDate: null, active: true,
  });
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const set = <K extends keyof RecurrenceInput>(k: K, value: RecurrenceInput[K]) => { setV((x) => ({ ...x, [k]: value })); setError(''); };
  const usesWeekdays = v.frequency === 'weekly' || (v.frequency === 'custom' && v.customUnit === 'week');
  const usesDay = ['monthly', 'quarterly', 'yearly'].includes(v.frequency) || (v.frequency === 'custom' && v.customUnit === 'month');
  // 預覽接下來 5 次
  const preview = useMemo(() => {
    try {
      const r = { ...v, id: 'preview', generatedThrough: null, skipDates: [], createdAt: '', updatedAt: '' } as RecurrenceRule;
      return scheduledDates(r, today > v.startDate ? today : v.startDate, addDays(today, 1500), 5).map((d) => adjustForWeekend(d, v.weekendAdjust));
    } catch { return []; }
  }, [v, today]);

  const submit = async () => {
    if (!v.title.trim()) { setError('Title is required'); return; }
    if (!Number.isInteger(v.interval) || v.interval < 1 || v.interval > 366) { setError('Repeat every must be a whole number from 1'); return; }
    if (v.endDate && v.endDate < v.startDate) { setError('End date cannot be before the start date'); return; }
    if (usesWeekdays && v.weekdays.length === 0) { setError('Choose at least one day of the week'); return; }
    if (!preview.length) { setError('This schedule has no upcoming dates. Check the start and end dates.'); return; }
    await saveRule.mutateAsync([v, rule?.id]);
    toast(rule ? 'Recurring task updated. Future tasks follow the new schedule' : 'Recurring task created');
    onClose();
  };

  if (confirmDelete && rule) {
    return (
      <Modal open onClose={() => setConfirmDelete(false)} size="sm" title={`Delete "${rule.title}"?`}
        footer={<><Button onClick={() => setConfirmDelete(false)}>Keep it</Button>
          <Button variant="danger" loading={removeRule.isPending} data-testid="confirm-delete-rule" onClick={async () => { await removeRule.mutateAsync(rule.id); toast('Recurring task deleted'); onClose(); }}>Delete schedule</Button></>}>
        <p className="text-sm text-slate-600">No new tasks will be created. Upcoming tasks that have not been started are removed. Completed and overdue tasks stay on your list.</p>
      </Modal>
    );
  }

  return (
    <Modal open onClose={onClose} size="md" title={rule ? 'Edit recurring task' : 'New recurring task'}
      footer={<>
        {rule && <Button variant="danger" className="mr-auto" onClick={() => setConfirmDelete(true)}>Delete</Button>}
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" loading={saveRule.isPending} onClick={submit} data-testid="save-rule">{rule ? 'Save changes' : 'Create'}</Button>
      </>}>
      <form className="grid grid-cols-1 gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate>
        <TextInput label="Task title *" containerClassName="sm:col-span-2" value={v.title} maxLength={150} onChange={(e) => set('title', e.target.value)} placeholder="e.g. Pay EPF contribution" />
        <SelectInput label="Category" value={v.category} onChange={(e) => set('category', e.target.value as TaskCategory)}>{TASK_CATEGORIES.map((c) => <option key={c}>{c}</option>)}</SelectInput>
        <SelectInput label="Priority" value={v.priority} onChange={(e) => set('priority', e.target.value as TaskPriority)}>{TASK_PRIORITIES.map((p) => <option key={p}>{p}</option>)}</SelectInput>

        <SelectInput label="Repeats" value={v.frequency} onChange={(e) => set('frequency', e.target.value as Frequency)} data-testid="rule-frequency">
          {(Object.keys(FREQUENCY_LABEL) as Frequency[]).map((f) => <option key={f} value={f}>{FREQUENCY_LABEL[f]}</option>)}
        </SelectInput>
        <div className="grid grid-cols-2 gap-3">
          <TextInput label="Every" inputMode="numeric" value={String(v.interval)} onChange={(e) => set('interval', Math.max(0, Number(e.target.value.replace(/\D/g, '')) || 0))} />
          {v.frequency === 'custom' ? (
            <SelectInput label="Unit" value={v.customUnit} onChange={(e) => set('customUnit', e.target.value as CustomUnit)}>
              <option value="day">days</option><option value="week">weeks</option><option value="month">months</option>
            </SelectInput>
          ) : <div className="self-end pb-2 text-sm text-slate-500">{({ daily: 'day(s)', weekly: 'week(s)', monthly: 'month(s)', quarterly: 'quarter(s)', yearly: 'year(s)', custom: '' } as const)[v.frequency]}</div>}
        </div>

        {usesWeekdays && (
          <div className="sm:col-span-2">
            <p className="mb-1 text-sm font-medium text-slate-700">On these days</p>
            <div className="flex flex-wrap gap-1.5">
              {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                <button key={d} type="button" aria-pressed={v.weekdays.includes(d)} onClick={() => set('weekdays', v.weekdays.includes(d) ? v.weekdays.filter((x) => x !== d) : [...v.weekdays, d])}
                  className={cx('rounded-md px-2.5 py-1 text-sm font-medium ring-1', v.weekdays.includes(d) ? 'bg-navy-800 text-white ring-navy-800' : 'bg-white text-slate-600 ring-slate-300 hover:bg-slate-50')}>{WEEKDAY_SHORT[d]}</button>
              ))}
              <button type="button" className="rounded-md px-2 py-1 text-xs font-medium text-navy-700 hover:underline" onClick={() => set('weekdays', [1, 2, 3, 4, 5])}>Working days</button>
            </div>
          </div>
        )}
        {usesDay && (
          <>
            {v.frequency === 'yearly' && (
              <SelectInput label="Month" value={String(v.month)} onChange={(e) => set('month', Number(e.target.value))}>
                {MONTH_NAMES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
              </SelectInput>
            )}
            <SelectInput label="Day of month" value={String(v.dayOfMonth)} onChange={(e) => set('dayOfMonth', Number(e.target.value))}>
              {Array.from({ length: 31 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}
              <option value={-1}>Last day of the month</option>
            </SelectInput>
          </>
        )}
        <SelectInput label="If it falls on a weekend" value={v.weekendAdjust} onChange={(e) => set('weekendAdjust', e.target.value as WeekendAdjust)}>
          <option value="previous">Move earlier to Friday</option><option value="next">Move later to Monday</option><option value="none">Keep the date</option>
        </SelectInput>
        <TextInput label="Start working on it (days before due)" inputMode="numeric" value={String(v.leadDays)} onChange={(e) => set('leadDays', Math.min(90, Number(e.target.value.replace(/\D/g, '')) || 0))} />
        <TextInput label="First date" type="date" value={v.startDate} onChange={(e) => set('startDate', e.target.value || today)} hint="Occurrences before this date are not created" />
        <TextInput label="End date (optional)" type="date" value={v.endDate ?? ''} min={v.startDate} onChange={(e) => set('endDate', e.target.value || null)} />
        <TextArea label="Description" containerClassName="sm:col-span-2" rows={2} value={v.description} maxLength={2000} onChange={(e) => set('description', e.target.value)} />
        <div className="rounded-lg bg-slate-50 px-4 py-3 text-sm ring-1 ring-slate-200 sm:col-span-2" data-testid="rule-preview">
          <p className="font-medium text-slate-800">{describeRule(v)}</p>
          <p className="mt-1 text-xs text-slate-500">Next due: {preview.length ? preview.map((d) => formatDate(d)).join(' · ') : 'none'}</p>
          <p className="mt-1 text-xs text-slate-500">Weekend moves only skip Saturdays and Sundays. Check public holidays yourself.</p>
        </div>
        {error && <div className="sm:col-span-2"><Alert>{error}</Alert></div>}
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  );
}

function TemplatesModal({ existing, onClose }: { existing: RecurrenceRule[]; onClose: () => void }) {
  const today = useToday();
  const { saveRule } = useTaskMutations();
  const toast = useToast();
  const have = new Set(existing.map((r) => r.title.toLowerCase()));
  const [picked, setPicked] = useState<Set<string>>(() => new Set(RULE_TEMPLATES.filter((t) => t.group !== 'Weekly routines' && !have.has(t.title.toLowerCase())).map((t) => t.key)));
  const [busy, setBusy] = useState(false);
  const groups = [...new Set(RULE_TEMPLATES.map((t) => t.group))];
  const add = async () => {
    setBusy(true);
    for (const t of RULE_TEMPLATES.filter((x) => picked.has(x.key))) {
      const { key: _k, group: _g, note: _n, ...rest } = t;
      await saveRule.mutateAsync([{ ...rest, startDate: today, endDate: null, active: true }]);
    }
    setBusy(false);
    toast(`${picked.size} recurring task${picked.size === 1 ? '' : 's'} added`);
    onClose();
  };
  return (
    <Modal open onClose={onClose} size="lg" title="Templates for Malaysian finance & payroll"
      subtitle="Statutory deadlines as generally published (EPF, SOCSO/EIS, PCB and HRD Corp by the 15th; Form EA by end-February; Form E by 31 March). Always confirm against the latest KWSP, PERKESO, LHDN, HRD Corp and JKDM notices."
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!picked.size} onClick={add} data-testid="add-templates">Add {picked.size} recurring task{picked.size === 1 ? '' : 's'}</Button></>}>
      <div className="space-y-5">
        {groups.map((g) => (
          <section key={g}>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{g}</h3>
            <ul className="divide-y divide-slate-100 rounded-lg ring-1 ring-slate-200">
              {RULE_TEMPLATES.filter((t) => t.group === g).map((t) => {
                const exists = have.has(t.title.toLowerCase());
                return (
                  <li key={t.key}>
                    <label className={cx('flex cursor-pointer items-start gap-3 px-3 py-2.5', exists && 'cursor-default opacity-50')}>
                      <input type="checkbox" className="mt-1 size-4 accent-navy-700" disabled={exists} checked={picked.has(t.key)}
                        onChange={() => setPicked((s) => { const n = new Set(s); if (n.has(t.key)) n.delete(t.key); else n.add(t.key); return n; })} data-testid={`tpl-${t.key}`} />
                      <span className="min-w-0 text-sm">
                        <span className="font-medium text-slate-900">{t.title}</span> <PriorityBadge priority={t.priority} />{exists && <span className="ml-1 text-xs text-slate-500">(already added)</span>}
                        <span className="block text-xs text-slate-500">{describeRule({ ...t, startDate: today })}{t.leadDays ? ` · starts ${t.leadDays} days before` : ''}</span>
                        {t.note && <span className="block text-xs text-amber-700">{t.note}</span>}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </Modal>
  );
}

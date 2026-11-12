/**
 * 薪資（Payroll）與月結（Monthly Closing）每月檢查清單頁面 — 共用同一個元件。
 *
 * 設計重點：一鍵勾選、即時儲存、狀態一眼可見（待辦／進行中／已完成／逾期）。
 * 第一次勾選或輸入時才建立該月份的紀錄。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Button, Card, cx, PageHeader, Spinner } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import { repository } from '@/data';
import {
  addItem, byMonthDesc, checklistId, checklistProgress, checklistStatus, defaultMonth, monthName, newChecklist, removeItem,
  salaryPayment, SALARY_PAID_KEY, setAll, setItemRemark, shiftMonth, toggleItem, type Checklist, type ChecklistKind, type ChecklistStatus,
} from '@/domain/checklists';
import { formatDate, formatDateTime } from '@/domain/dates';
import { can } from '@/domain/permissions';
import { useAuth } from '@/features/auth/AuthContext';
import { useToday } from '@/hooks/useTasks';

export const checklistKey = ['checklists'] as const;

export function useChecklists() {
  const q = useQuery({ queryKey: checklistKey, queryFn: () => repository.listChecklists() });
  return { ...q, checklists: q.data ?? [] };
}

const STATUS_STYLE: Record<ChecklistStatus, string> = {
  Completed: 'bg-emerald-50 text-emerald-800 ring-emerald-300',
  'In progress': 'bg-sky-50 text-sky-800 ring-sky-200',
  Pending: 'bg-slate-100 text-slate-700 ring-slate-300',
  Overdue: 'bg-red-50 text-red-700 ring-red-300',
};
export function ChecklistStatusBadge({ status }: { status: ChecklistStatus | 'Paid' }) {
  const style = status === 'Paid' ? STATUS_STYLE.Completed : STATUS_STYLE[status];
  return <span className={cx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap ring-1 ring-inset', style)}>
    {status === 'Completed' || status === 'Paid' ? '✓ ' : status === 'Overdue' ? '! ' : ''}{status}</span>;
}

function ProgressBar({ pct, status }: { pct: number; status: ChecklistStatus }) {
  return (
    <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className={cx('h-full rounded-full transition-all', status === 'Completed' ? 'bg-emerald-600' : status === 'Overdue' ? 'bg-red-500' : 'bg-navy-600')} style={{ width: `${pct}%` }} />
    </div>
  );
}

const TEXT: Record<ChecklistKind, { title: string; subtitle: string; eyebrow: string }> = {
  payroll: { title: 'Payroll', eyebrow: 'Monthly payroll', subtitle: 'Prepare, verify and pay salaries. Tick each step as you go; everything saves automatically.' },
  closing: { title: 'Monthly Closing', eyebrow: 'Month-end', subtitle: 'Close the books each month. Tick each step as you go; everything saves automatically.' },
};

export function ChecklistPage({ kind }: { kind: ChecklistKind }) {
  const today = useToday();
  const { user } = useAuth();
  const canEdit = can(user?.role, 'invoice.edit');
  const { checklists, isLoading } = useChecklists();
  const qc = useQueryClient();
  const toast = useToast();
  const [month, setMonth] = useState(() => defaultMonth(kind, today));
  const [newItem, setNewItem] = useState('');
  const saved = checklists.find((c) => c.id === checklistId(kind, month));
  // 尚未儲存的月份：以範本顯示（不寫入）
  const [draft, setDraft] = useState<Checklist | null>(null);
  useEffect(() => { setDraft(null); }, [month, kind]);
  const current = saved ?? draft ?? newChecklist(kind, month, new Date().toISOString());

  const save = useMutation({
    mutationFn: (c: Checklist) => repository.saveChecklist(c),
    onMutate: async (c) => {
      // 立即更新畫面（樂觀更新），儲存失敗時還原
      await qc.cancelQueries({ queryKey: checklistKey });
      const prev = qc.getQueryData<Checklist[]>(checklistKey) ?? [];
      qc.setQueryData<Checklist[]>(checklistKey, [...prev.filter((x) => x.id !== c.id), c]);
      return { prev };
    },
    onError: (e, _c, ctx) => { if (ctx) qc.setQueryData(checklistKey, ctx.prev); toast(e instanceof Error ? e.message : 'Could not save', 'error'); },
    onSettled: () => qc.invalidateQueries({ queryKey: checklistKey }),
  });
  const update = (fn: (c: Checklist, now: string) => Checklist) => { if (canEdit) save.mutate(fn(current, new Date().toISOString())); };

  const progress = checklistProgress(current);
  const status = checklistStatus(current, today);
  const pay = salaryPayment(current, today);
  const groups = useMemo(() => [...new Set(current.items.map((i) => i.group))], [current.items]);
  const history = checklists.filter((c) => c.kind === kind).sort(byMonthDesc);
  const T = TEXT[kind];

  if (isLoading) return <div className="grid h-64 place-items-center text-slate-400"><Spinner /></div>;

  return (
    <>
      <PageHeader eyebrow={T.eyebrow} title={T.title} subtitle={T.subtitle} />

      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-5 py-4">
          <div className="flex items-center gap-1">
            <Button size="sm" variant="ghost" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month">‹</Button>
            <h2 className="font-display min-w-[10rem] text-center text-lg font-semibold text-slate-900" data-testid="checklist-month">{monthName(month)}</h2>
            <Button size="sm" variant="ghost" onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Next month">›</Button>
          </div>
          <ChecklistStatusBadge status={status} />
          <span className="text-xs text-slate-500">Due {formatDate(current.dueDate)}</span>
          {month !== defaultMonth(kind, today) && <Button size="sm" variant="ghost" onClick={() => setMonth(defaultMonth(kind, today))}>Back to current</Button>}
        </div>

        <div className="grid grid-cols-1 gap-4 border-b border-slate-100 px-5 py-4 sm:grid-cols-[1fr_auto] sm:items-center">
          <div>
            <div className="mb-1.5 flex items-baseline justify-between text-sm">
              <span className="font-semibold text-slate-900"><span data-testid="checklist-pct">{progress.pct}%</span> complete</span>
              <span className="text-slate-500">{progress.done} of {progress.total} done</span>
            </div>
            <ProgressBar pct={progress.pct} status={status} />
          </div>
          {kind === 'payroll' && (
            <div className="flex flex-wrap items-center gap-2 sm:justify-end" data-testid="salary-status">
              <span className="text-sm text-slate-600">Salary payment:</span>
              <ChecklistStatusBadge status={pay.status === 'Paid' ? 'Paid' : pay.status} />
              {pay.paidAt && <span className="text-xs text-slate-500">{formatDateTime(pay.paidAt)}</span>}
              {canEdit && pay.status !== 'Paid' && <Button size="sm" variant="success" onClick={() => update((c, now) => toggleItem(c, SALARY_PAID_KEY, now))} data-testid="mark-paid">Mark salaries paid</Button>}
            </div>
          )}
        </div>

        <div className="divide-y divide-slate-100" data-testid="checklist">
          {groups.map((g) => (
            <section key={g} className="px-5 py-3">
              <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">{g}</h3>
              <ul>
                {current.items.filter((i) => i.group === g).map((i) => (
                  <ChecklistRow key={i.key} item={i} canEdit={canEdit}
                    onToggle={() => update((c, now) => toggleItem(c, i.key, now))}
                    onRemark={(r) => update((c, now) => setItemRemark(c, i.key, r, now))}
                    onRemove={i.group === 'Other' ? () => update((c, now) => removeItem(c, i.key, now)) : undefined} />
                ))}
              </ul>
            </section>
          ))}
        </div>

        {canEdit && (
          <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-5 py-3">
            <form className="flex min-w-[220px] flex-1 gap-2" onSubmit={(e) => { e.preventDefault(); if (newItem.trim()) { update((c, now) => addItem(c, newItem, now)); setNewItem(''); } }}>
              <input value={newItem} onChange={(e) => setNewItem(e.target.value)} placeholder="Add a step for this month…" aria-label="Add checklist item" maxLength={150}
                className="min-w-0 flex-1 rounded-lg border-0 px-3 py-2 text-sm shadow-sm ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-navy-600" data-testid="add-item" />
              <Button type="submit" disabled={!newItem.trim()}>Add</Button>
            </form>
            {progress.done < progress.total
              ? <Button variant="ghost" size="sm" onClick={() => update((c, now) => setAll(c, true, now))} data-testid="mark-all">Mark all done</Button>
              : <Button variant="ghost" size="sm" onClick={() => update((c, now) => setAll(c, false, now))}>Untick all</Button>}
          </div>
        )}
      </Card>

      <Card className="mt-6" title="Remarks for this month">
        <MonthRemarks key={current.id} value={current.remarks} disabled={!canEdit} onSave={(r) => update((c) => ({ ...c, remarks: r }))} />
      </Card>

      {history.length > 0 && (
        <Card className="mt-6" title="Previous months" padded={false}>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm" data-testid="checklist-history">
              <thead className="border-b border-slate-200 bg-slate-50/80 text-xs uppercase tracking-wide text-slate-500">
                <tr><th className="px-5 py-2.5 text-left">Month</th><th className="px-4 py-2.5 text-left">Progress</th><th className="px-4 py-2.5 text-left">Status</th>{kind === 'payroll' && <th className="px-4 py-2.5 text-left">Salaries</th>}<th className="hidden px-4 py-2.5 text-left sm:table-cell">Remarks</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {history.map((c) => {
                  const p = checklistProgress(c);
                  const s = checklistStatus(c, today);
                  return (
                    <tr key={c.id} className={cx('cursor-pointer hover:bg-navy-50/50', c.month === month && 'bg-navy-50/60')} onClick={() => setMonth(c.month)}>
                      <td className="px-5 py-2.5 font-medium whitespace-nowrap">{monthName(c.month)}</td>
                      <td className="px-4 py-2.5"><span className="tabular">{p.pct}%</span> <span className="text-xs text-slate-500">({p.done}/{p.total})</span></td>
                      <td className="px-4 py-2.5"><ChecklistStatusBadge status={s} /></td>
                      {kind === 'payroll' && <td className="px-4 py-2.5"><ChecklistStatusBadge status={salaryPayment(c, today).status} /></td>}
                      <td className="hidden max-w-xs truncate px-4 py-2.5 text-xs text-slate-500 sm:table-cell">{c.remarks || '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}

function ChecklistRow({ item, canEdit, onToggle, onRemark, onRemove }: {
  item: Checklist['items'][number]; canEdit: boolean; onToggle: () => void; onRemark: (r: string) => void; onRemove?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(item.remark);
  useEffect(() => setText(item.remark), [item.remark]);
  return (
    <li className="flex items-start gap-3 py-2" data-testid="checklist-item">
      <button type="button" onClick={onToggle} disabled={!canEdit} aria-pressed={item.done} aria-label={item.done ? `Untick ${item.label}` : `Tick ${item.label}`} data-testid="checklist-check"
        className={cx('mt-0.5 grid size-6 shrink-0 place-items-center rounded-md border-2 transition-colors disabled:cursor-default',
          item.done ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-slate-300 hover:border-navy-500 hover:bg-navy-50')}>
        {item.done && <svg viewBox="0 0 20 20" className="size-4" fill="none" stroke="currentColor" strokeWidth="3"><path d="m4.5 10.5 3.5 3.5 7.5-8" strokeLinecap="round" strokeLinejoin="round" /></svg>}
      </button>
      <div className="min-w-0 flex-1">
        <p className={cx('text-sm', item.done ? 'text-slate-500 line-through decoration-slate-300' : 'font-medium text-slate-900')}>{item.label}</p>
        {editing ? (
          <input autoFocus value={text} maxLength={500} onChange={(e) => setText(e.target.value)} aria-label={`Note for ${item.label}`}
            onBlur={() => { setEditing(false); if (text !== item.remark) onRemark(text); }}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setText(item.remark); setEditing(false); } }}
            className="mt-1 w-full rounded-md border-0 px-2 py-1 text-xs ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-navy-600" />
        ) : (
          <p className="mt-0.5 text-xs text-slate-500">
            {item.done && item.doneAt && <span className="text-emerald-700">Done {formatDateTime(item.doneAt)}</span>}
            {item.remark && <span className={item.done ? ' ml-2' : ''}>✎ {item.remark}</span>}
            {canEdit && <button type="button" className="ml-2 font-medium text-navy-700 hover:underline" onClick={() => setEditing(true)}>{item.remark ? 'Edit note' : 'Add note'}</button>}
          </p>
        )}
      </div>
      {canEdit && onRemove && <button type="button" onClick={onRemove} className="rounded px-1.5 text-xs text-slate-400 hover:bg-red-50 hover:text-red-700" aria-label={`Remove ${item.label}`}>✕</button>}
    </li>
  );
}

function MonthRemarks({ value, disabled, onSave }: { value: string; disabled: boolean; onSave: (v: string) => void }) {
  const [text, setText] = useState(value);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  return (
    <div>
      <textarea value={text} disabled={disabled} rows={3} maxLength={2000} onChange={(e) => setText(e.target.value)} aria-label="Remarks for this month"
        onBlur={() => { if (text !== value) { onSave(text); setSavedAt(Date.now()); } }} placeholder="e.g. 2 new joiners this month; bonus paid separately on 30th" data-testid="month-remarks"
        className="block w-full rounded-lg border-0 px-3 py-2 text-sm shadow-sm ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-navy-600 disabled:bg-slate-50" />
      <p className="mt-1 text-xs text-slate-500">{savedAt ? 'Saved' : 'Saves automatically when you click outside the box.'}</p>
    </div>
  );
}

/**
 * 跟進紀錄（Follow-ups）：顯示在發票明細中。
 * AR：催款紀錄（聯絡了誰、對方答應哪天付、下次何時再追）；AP：供應商催款與我方承諾的付款日。
 * 設定「下次跟進日」會自動建立任務，當天出現在 Dashboard。
 */
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Button, cx, TextArea, TextInput } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import { repository } from '@/data';
import { formatDate } from '@/domain/dates';
import { promiseStatus, sortFollowUps, validateFollowUp, type FollowUpErrors, type FollowUpInput } from '@/domain/followups';
import type { ComputedInvoice } from '@/domain/types';
import { useToday } from '@/hooks/useTasks';

const newId = () => globalThis.crypto?.randomUUID?.() ?? `fu-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** 清單上的小標籤：對方答應的付款日（過期未付則標紅）。 */
export function PromiseTag({ invoice, today }: { invoice: ComputedInvoice; today: string }) {
  if (invoice.outstandingBalance <= 0 || invoice.isCancelled) return null;
  const p = promiseStatus(invoice.followUps, today);
  if (!p) return null;
  return (
    <span className={cx('mt-0.5 inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ring-1', p.broken ? 'bg-red-50 text-red-700 ring-red-200' : 'bg-sky-50 text-sky-800 ring-sky-200')} data-testid="promise-tag">
      {p.broken ? `Promise missed · ${formatDate(p.date)}` : `Promised ${formatDate(p.date)}`}
    </span>
  );
}

export function FollowUpSection({ invoice, canEdit }: { invoice: ComputedInvoice; canEdit: boolean }) {
  const today = useToday();
  const qc = useQueryClient();
  const toast = useToast();
  const list = sortFollowUps(invoice.followUps ?? []);
  const open = invoice.outstandingBalance > 0 && !invoice.isCancelled;
  const ar = invoice.type === 'AR';
  const blank = (): FollowUpInput => ({ date: today, contact: '', note: '', promisedDate: '', nextDate: '' });
  const [adding, setAdding] = useState(false);
  const [v, setV] = useState<FollowUpInput>(blank);
  const [errors, setErrors] = useState<FollowUpErrors>({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof FollowUpInput, value: string) => { setV((x) => ({ ...x, [k]: value })); setErrors((e) => ({ ...e, [k]: undefined })); };
  if (!list.length && !(canEdit && open)) return null;

  const submit = async () => {
    const r = validateFollowUp(v, today);
    if (!r.ok) { setErrors(r.errors); return; }
    setBusy(true);
    setFormError('');
    try {
      await repository.addFollowUp(invoice.id, { id: newId(), ...r.value, createdAt: new Date().toISOString() });
      if (r.value.nextDate) {
        // 下次跟進日 → 自動建立任務
        await repository.saveTask({ title: `Follow up ${invoice.counterpartyName} on ${invoice.invoiceNumber}`.slice(0, 150), category: ar ? 'AR' : 'AP', priority: 'High', dueDate: r.value.nextDate,
          remarks: `Last contact ${formatDate(r.value.date)}${r.value.contact ? ` (${r.value.contact})` : ''}: ${r.value.note}`.slice(0, 2000) });
      }
      await qc.invalidateQueries();
      toast(r.value.nextDate ? `Follow-up saved. Reminder set for ${formatDate(r.value.nextDate)}` : 'Follow-up saved');
      setAdding(false);
      setV(blank());
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Could not save the follow-up');
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string) => {
    try { await repository.deleteFollowUp(invoice.id, id); await qc.invalidateQueries(); toast('Follow-up removed'); } catch (e) { toast(e instanceof Error ? e.message : 'Could not remove', 'error'); }
  };

  return (
    <section data-testid="followups">
      <div className="mt-6 mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Follow-ups ({list.length})</h3>
        {canEdit && open && !adding && <Button size="sm" onClick={() => setAdding(true)} data-testid="add-followup">+ Add follow-up</Button>}
      </div>
      {adding && (
        <div className="mb-3 grid grid-cols-1 gap-3 rounded-xl bg-navy-50/60 p-3 ring-1 ring-navy-100 sm:grid-cols-2" data-testid="followup-form">
          <TextInput label="Date contacted *" type="date" value={v.date} max={today} error={errors.date} onChange={(e) => set('date', e.target.value)} data-testid="fu-date" />
          <TextInput label="Spoke to" value={v.contact} maxLength={80} error={errors.contact} placeholder="e.g. Puan Aida, accounts" onChange={(e) => set('contact', e.target.value)} data-testid="fu-contact" />
          <TextArea label="What was said *" containerClassName="sm:col-span-2" rows={2} value={v.note} maxLength={500} error={errors.note}
            placeholder={ar ? 'e.g. Cheque is with the director for signing' : 'e.g. Supplier called; told them payment is in this week\'s run'} onChange={(e) => set('note', e.target.value)} data-testid="fu-note" />
          <TextInput label={ar ? 'They promised to pay by' : 'We promised to pay by'} type="date" value={v.promisedDate} error={errors.promisedDate} onChange={(e) => set('promisedDate', e.target.value)} data-testid="fu-promised" />
          <TextInput label="Remind me to follow up on" type="date" value={v.nextDate} min={v.date} error={errors.nextDate} hint="Adds a task to your Dashboard on that day" onChange={(e) => set('nextDate', e.target.value)} data-testid="fu-next" />
          {formError && <div className="sm:col-span-2"><Alert>{formError}</Alert></div>}
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Button size="sm" onClick={() => { setAdding(false); setErrors({}); }}>Cancel</Button>
            <Button size="sm" variant="primary" loading={busy} onClick={() => void submit()} data-testid="save-followup">Save follow-up</Button>
          </div>
        </div>
      )}
      {list.length === 0 ? <p className="text-sm text-slate-500">No follow-ups recorded yet.</p> : (
        <ol className="space-y-2 border-l-2 border-navy-100 pl-4" data-testid="followup-list">
          {list.map((f) => (
            <li key={f.id} className="group text-sm">
              <p className="text-slate-800">{f.note}</p>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
                <span>{formatDate(f.date)}{f.contact ? ` · ${f.contact}` : ''}</span>
                {f.promisedDate && <span className={cx('rounded px-1.5 py-0.5 font-medium ring-1', open && f.promisedDate < today ? 'bg-red-50 text-red-700 ring-red-200' : 'bg-sky-50 text-sky-800 ring-sky-200')}>
                  {ar ? 'Promised' : 'We promised'} {formatDate(f.promisedDate)}{open && f.promisedDate < today ? ' · missed' : ''}</span>}
                {f.nextDate && <span className="rounded bg-slate-100 px-1.5 py-0.5 font-medium text-slate-600">Follow up again {formatDate(f.nextDate)}</span>}
                {canEdit && <button type="button" className="font-medium text-slate-400 hover:text-red-600 hover:underline" onClick={() => void remove(f.id)} aria-label={`Remove follow-up of ${formatDate(f.date)}`}>Remove</button>}
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

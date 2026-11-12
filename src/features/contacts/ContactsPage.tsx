/**
 * 供應商與客戶（Suppliers & Customers）
 *
 * - 名錄：每個對象的聯絡資料、預設付款期限、未付與逾期金額。
 * - 對帳單：選擇期間，列出發票與收付款、累計餘額，可匯出 Excel。
 * - 催款信：對有逾期帳款的客戶，一鍵產生可複製的提醒信內容。
 */
import { useMemo, useState } from 'react';
import { Alert, Button, Card, cx, FilterSelect, Modal, PageHeader, Spinner, TextArea, TextInput } from '@/components/ui';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { ExportExcelButton } from '@/components/ui/ExportExcelButton';
import { useToast } from '@/components/ui/Toast';
import { AGING_BUCKETS } from '@/domain/aging';
import { addDays, formatDate } from '@/domain/dates';
import { formatMYR } from '@/domain/money';
import { can } from '@/domain/permissions';
import { buildReminderText, buildStatement } from '@/domain/statement';
import { TYPE_LABELS, type ComputedInvoice, type Counterparty, type CounterpartyKind, type InvoiceType } from '@/domain/types';
import { useAuth } from '@/features/auth/AuthContext';
import { InvoiceDetailModal } from '@/features/invoices/InvoiceDetailModal';
import { useCounterparties, useCounterpartyMutation, useInvoices, useSettings } from '@/hooks/useFinanceData';
import { buildStatementWorkbook } from '@/lib/excelExport';

interface Row extends Counterparty {
  invoiceCount: number;
  outstanding: number;
  overdue: number;
  lastActivity: string | null;
}

export function ContactsPage() {
  const [kind, setKind] = useState<CounterpartyKind>('customer');
  const [q, setQ] = useState('');
  const [show, setShow] = useState<'all' | 'owing' | 'overdue'>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  const { invoices, isLoading } = useInvoices();
  const parties = useCounterparties();
  const type: InvoiceType = kind === 'customer' ? 'AR' : 'AP';

  const rows = useMemo<Row[]>(() => (parties.data ?? []).filter((c) => c.kind === kind).map((c) => {
    const mine = invoices.filter((i) => i.counterpartyId === c.id && !i.isCancelled);
    return {
      ...c,
      invoiceCount: mine.length,
      outstanding: mine.reduce((t, i) => t + i.outstandingBalance, 0),
      overdue: mine.filter((i) => i.isOverdue).reduce((t, i) => t + i.outstandingBalance, 0),
      lastActivity: mine.reduce<string | null>((d, i) => [d, i.invoiceDate, i.lastPaymentDate].filter(Boolean).sort().at(-1) ?? null, null),
    };
  }), [parties.data, invoices, kind]);

  const needle = q.trim().toLowerCase();
  const visible = rows.filter((r) => (!needle || [r.name, r.contactPerson, r.email, r.phone].some((v) => (v ?? '').toLowerCase().includes(needle)))
    && (show === 'all' || (show === 'owing' ? r.outstanding > 0 : r.overdue > 0)));
  const L = TYPE_LABELS[type];

  const cols: Column<Row>[] = [
    { key: 'name', header: L.party, sortValue: (r) => r.name, render: (r) => <><span className="font-medium text-slate-900">{r.name}</span>{r.contactPerson && <span className="block text-xs text-slate-500">{r.contactPerson}</span>}</> },
    { key: 'contact', header: 'Contact', hideOnMobile: true, render: (r) => <span className="text-xs text-slate-600">{[r.phone, r.email].filter(Boolean).join(' · ') || '—'}</span> },
    { key: 'terms', header: 'Terms', hideOnMobile: true, sortValue: (r) => r.paymentTermsDays ?? -1, render: (r) => (r.paymentTermsDays != null ? `${r.paymentTermsDays} days` : <span className="text-slate-400">Default</span>) },
    { key: 'count', header: 'Invoices', align: 'right', hideOnMobile: true, sortValue: (r) => r.invoiceCount, render: (r) => r.invoiceCount },
    { key: 'out', header: 'Outstanding', align: 'right', sortValue: (r) => r.outstanding, render: (r) => <span className="font-semibold text-slate-900">{formatMYR(r.outstanding)}</span>, footer: formatMYR(visible.reduce((t, r) => t + r.outstanding, 0)) },
    { key: 'overdue', header: 'Overdue', align: 'right', sortValue: (r) => r.overdue, render: (r) => <span className={r.overdue ? 'font-medium text-red-700' : 'text-slate-300'}>{formatMYR(r.overdue)}</span>, footer: formatMYR(visible.reduce((t, r) => t + r.overdue, 0)) },
  ];

  return (
    <>
      <PageHeader eyebrow="Ledgers" title="Suppliers & Customers" subtitle="Contact details, payment terms, statements of account and payment reminders." />
      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-4">
          <div className="inline-flex rounded-lg bg-slate-100 p-0.5 text-sm font-medium" role="tablist" aria-label="Contact type">
            {(['customer', 'supplier'] as const).map((k) => (
              <button key={k} type="button" role="tab" aria-selected={kind === k} onClick={() => setKind(k)}
                className={cx('rounded-md px-3 py-1.5', kind === k ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800')}>
                {k === 'customer' ? 'Customers' : 'Suppliers'} <span className="text-slate-400">{(parties.data ?? []).filter((c) => c.kind === k).length}</span>
              </button>
            ))}
          </div>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, contact, phone or email" aria-label="Search contacts"
            className="min-w-[200px] flex-1 rounded-lg border-0 px-3 py-2 text-sm shadow-sm ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-navy-600" />
          <FilterSelect label="Show" value={show} onChange={(v) => setShow(v as typeof show)}>
            <option value="all">All</option>
            <option value="owing">With a balance</option>
            <option value="overdue">With overdue invoices</option>
          </FilterSelect>
        </div>
        {isLoading || parties.isLoading ? <div className="grid h-40 place-items-center text-slate-400"><Spinner /></div> : (
          <DataTable testId="contacts-table" rows={visible} columns={cols} rowKey={(r) => r.id} onRowClick={(r) => setOpenId(r.id)}
            initialSort={{ key: 'out', dir: 'desc' }} emptyTitle={rows.length ? 'No contacts match' : `No ${kind}s yet`}
            emptyDescription={rows.length ? undefined : `${kind === 'customer' ? 'Customers' : 'Suppliers'} are added automatically when you create an invoice.`} />
        )}
      </Card>
      {openId && <ContactModal id={openId} type={type} onClose={() => setOpenId(null)} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// 對象明細：資料、對帳單、催款信
// ---------------------------------------------------------------------------

function ContactModal({ id, type, onClose }: { id: string; type: InvoiceType; onClose: () => void }) {
  const parties = useCounterparties();
  const contact = parties.data?.find((c) => c.id === id);
  const { invoices, today } = useInvoices();
  const { settings } = useSettings();
  const { user } = useAuth();
  const [tab, setTab] = useState<'statement' | 'details' | 'reminder'>('statement');
  const [from, setFrom] = useState(() => `${addDays(today, -90).slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const [invoiceId, setInvoiceId] = useState<string | null>(null);
  const st = useMemo(() => buildStatement(invoices, id, from, to <= today ? to : today), [invoices, id, from, to, today]);
  if (!contact) return null;
  const L = TYPE_LABELS[type];
  const canEdit = can(user?.role, 'invoice.edit');

  if (invoiceId) return <InvoiceDetailModal invoiceId={invoiceId} onClose={() => setInvoiceId(null)} />;

  return (
    <Modal open onClose={onClose} size="lg" title={contact.name}
      subtitle={`${L.party}${contact.paymentTermsDays != null ? ` · ${contact.paymentTermsDays}-day terms` : ''}${contact.phone ? ` · ${contact.phone}` : ''}`}>
      <div className="mb-4 inline-flex rounded-lg bg-slate-100 p-0.5 text-sm font-medium" role="tablist" aria-label="Contact sections">
        {([['statement', 'Statement of account'], ['details', 'Details'], ...(type === 'AR' ? [['reminder', `Payment reminder${st.overdue.length ? ` (${st.overdue.length})` : ''}`]] : [])] as [typeof tab, string][]).map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} data-testid={`tab-${k}`}
            className={cx('rounded-md px-3 py-1.5', tab === k ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800')}>{label}</button>
        ))}
      </div>

      {tab === 'statement' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <TextInput label="From" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
            <TextInput label="To" type="date" value={to} max={today} onChange={(e) => setTo(e.target.value)} />
            <div className="ml-auto">
              <ExportExcelButton testId="export-statement" label="Export statement" fileName={`Statement-${contact.name.replace(/[^A-Za-z0-9]+/g, '-')}-${to}.xlsx`}
                build={() => buildStatementWorkbook(st, type, settings.companyName, contact)} />
            </div>
          </div>
          <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-slate-200 ring-1 ring-slate-200 sm:grid-cols-4" data-testid="statement-summary">
            {[['Opening balance', st.openingBalance], ['Invoiced', st.totalDebit], [type === 'AR' ? 'Received & credited' : 'Paid & credited', st.totalCredit], ['Closing balance', st.closingBalance]].map(([k, v]) => (
              <div key={k as string} className="bg-white px-4 py-3"><dt className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{k as string}</dt><dd className="tabular mt-0.5 text-sm font-semibold">{formatMYR(v as number)}</dd></div>
            ))}
          </dl>
          <div className="overflow-x-auto rounded-lg ring-1 ring-slate-200">
            <table className="min-w-full text-sm" data-testid="statement-lines">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr><th className="px-3 py-2 text-left">Date</th><th className="px-3 py-2 text-left">Invoice</th><th className="hidden px-3 py-2 text-left sm:table-cell">Description</th>
                  <th className="px-3 py-2 text-right">Debit</th><th className="px-3 py-2 text-right">Credit</th><th className="px-3 py-2 text-right">Balance</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                <tr className="bg-slate-50/50 text-slate-500"><td className="px-3 py-2">{formatDate(from)}</td><td className="px-3 py-2" colSpan={2}>Balance brought forward</td><td /><td /><td className="tabular px-3 py-2 text-right">{formatMYR(st.openingBalance)}</td></tr>
                {st.lines.map((l, i) => {
                  const inv = invoices.find((x) => x.counterpartyId === id && x.invoiceNumber === l.reference);
                  return (
                    <tr key={i}>
                      <td className="px-3 py-2 whitespace-nowrap">{formatDate(l.date)}</td>
                      <td className="px-3 py-2 whitespace-nowrap"><button type="button" className="font-medium text-navy-700 hover:underline" onClick={() => inv && setInvoiceId(inv.id)}>{l.reference}</button></td>
                      <td className="hidden px-3 py-2 text-slate-600 sm:table-cell">{l.description}</td>
                      <td className="tabular px-3 py-2 text-right whitespace-nowrap">{l.debit ? formatMYR(l.debit) : ''}</td>
                      <td className="tabular px-3 py-2 text-right whitespace-nowrap">{l.credit ? formatMYR(l.credit) : ''}</td>
                      <td className="tabular px-3 py-2 text-right font-medium whitespace-nowrap">{formatMYR(l.balance)}</td>
                    </tr>
                  );
                })}
                {!st.lines.length && <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-500">No transactions in this period.</td></tr>}
              </tbody>
            </table>
          </div>
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Ageing of current balance</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              {AGING_BUCKETS.map((b) => (
                <div key={b.key} className="rounded-lg bg-slate-50 px-3 py-2 ring-1 ring-slate-200">
                  <p className="text-[11px] text-slate-500">{b.label}</p>
                  <p className={cx('tabular text-sm font-semibold', b.key !== 'current' && st.aging[b.key] > 0 ? 'text-red-700' : 'text-slate-900')}>{formatMYR(st.aging[b.key])}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {tab === 'details' && <ContactDetailsForm contact={contact} canEdit={canEdit} />}
      {tab === 'reminder' && <ReminderPanel contact={contact} overdue={st.overdue} companyName={settings.companyName} />}
    </Modal>
  );
}

function ContactDetailsForm({ contact, canEdit }: { contact: Counterparty; canEdit: boolean }) {
  const save = useCounterpartyMutation();
  const toast = useToast();
  const [v, setV] = useState({
    name: contact.name, contactPerson: contact.contactPerson ?? '', email: contact.email ?? '', phone: contact.phone ?? '',
    address: contact.address ?? '', terms: contact.paymentTermsDays == null ? '' : String(contact.paymentTermsDays), notes: contact.notes ?? '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const set = (k: keyof typeof v, value: string) => { setV((x) => ({ ...x, [k]: value })); setErrors((e) => ({ ...e, [k]: '' })); };

  const submit = async () => {
    const e: Record<string, string> = {};
    if (v.name.trim().length < 2) e.name = 'Name is required';
    if (v.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email.trim())) e.email = 'Enter a valid email address';
    const terms = v.terms.trim() === '' ? null : Number(v.terms);
    if (terms !== null && (!Number.isInteger(terms) || terms < 0 || terms > 365)) e.terms = 'Enter whole days between 0 and 365';
    if (Object.keys(e).length) { setErrors(e); return; }
    setFormError('');
    try {
      await save.mutateAsync([contact.id, { name: v.name, contactPerson: v.contactPerson.trim(), email: v.email.trim(), phone: v.phone.trim(), address: v.address.trim(), paymentTermsDays: terms, notes: v.notes.trim() }]);
      toast('Contact details saved');
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not save');
    }
  };

  return (
    <form className="grid grid-cols-1 gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate>
      <TextInput label="Company name *" value={v.name} error={errors.name} disabled={!canEdit} maxLength={150} onChange={(e) => set('name', e.target.value)} />
      <TextInput label="Contact person" value={v.contactPerson} disabled={!canEdit} maxLength={150} onChange={(e) => set('contactPerson', e.target.value)} />
      <TextInput label="Email" type="email" value={v.email} error={errors.email} disabled={!canEdit} onChange={(e) => set('email', e.target.value)} />
      <TextInput label="Phone" value={v.phone} disabled={!canEdit} placeholder="e.g. 03-5511 2233" onChange={(e) => set('phone', e.target.value)} />
      <TextArea label="Address" containerClassName="sm:col-span-2" rows={2} value={v.address} disabled={!canEdit} maxLength={500} onChange={(e) => set('address', e.target.value)} />
      <TextInput label="Payment terms (days)" inputMode="numeric" value={v.terms} error={errors.terms} disabled={!canEdit} placeholder="Company default"
        hint="Used to set the due date automatically on new invoices." onChange={(e) => set('terms', e.target.value)} />
      <TextArea label="Notes" rows={2} value={v.notes} disabled={!canEdit} maxLength={1000} placeholder="e.g. Pays by cheque, send statements to finance@…" onChange={(e) => set('notes', e.target.value)} />
      {formError && <div className="sm:col-span-2"><Alert>{formError}</Alert></div>}
      {canEdit && <div className="flex justify-end sm:col-span-2"><Button variant="primary" type="submit" loading={save.isPending} data-testid="save-contact">Save details</Button></div>}
    </form>
  );
}

function ReminderPanel({ contact, overdue, companyName }: { contact: Counterparty; overdue: ComputedInvoice[]; companyName: string }) {
  const toast = useToast();
  const { subject, body } = useMemo(() => buildReminderText(contact.name, overdue, companyName, contact.contactPerson), [contact, overdue, companyName]);
  const text = `Subject: ${subject}\n\n${body}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast('Reminder copied. Paste it into your email.');
    } catch {
      // 剪貼簿無法使用時，選取文字讓使用者自行複製
      const el = document.getElementById('reminder-text') as HTMLTextAreaElement | null;
      el?.focus();
      el?.select();
      toast('Press Ctrl+C (or ⌘C) to copy the selected text');
    }
  };
  if (!overdue.length) return <p className="py-6 text-center text-sm text-slate-500">{contact.name} has no overdue invoices. Nothing to remind them about.</p>;
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">A ready-to-send reminder for the {overdue.length} overdue invoice{overdue.length === 1 ? '' : 's'}. Copy it into your email{contact.email ? ` to ${contact.email}` : ''}.</p>
      <textarea id="reminder-text" readOnly value={text} rows={14} data-testid="reminder-text"
        className="block w-full rounded-lg border-0 bg-slate-50 px-3 py-2 font-mono text-xs text-slate-800 ring-1 ring-inset ring-slate-200" />
      <div className="flex justify-end"><Button variant="primary" onClick={copy} data-testid="copy-reminder">Copy reminder</Button></div>
    </div>
  );
}

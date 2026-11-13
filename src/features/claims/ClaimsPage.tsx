/**
 * 員工報銷（Staff Claims）頁面
 *
 * 一頁完成：新增（可上傳收據自動填寫）→ 核准／退回 → 付款（可隨薪資發放），並可批次處理與匯出 Excel。
 * 只有一層核准；所有變更立即儲存。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type SyntheticEvent } from 'react';
import { Alert, Button, Card, cx, FilterSelect, Modal, PageHeader, SelectInput, StatCard, TextArea, TextInput } from '@/components/ui';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { useToast } from '@/components/ui/Toast';
import { repository } from '@/data';
import {
  approveClaim, canApprove, canPay, CLAIM_CATEGORIES, CLAIM_STATUS_LABEL, claimFlags, claimTotals, DEFAULT_RATE_PER_KM, editClaim, mileageAmount, newClaim,
  PAY_METHODS, payClaim, rejectClaim, staffNames, summaryByStaff, undoClaim, validateClaim,
  type ClaimErrors, type ClaimFormValues, type ClaimStatus, type PayMethod, type StaffClaim,
} from '@/domain/claims';
import { formatDate, formatMonth, lastNMonths, monthKey } from '@/domain/dates';
import { formatMYR, sumSen, toSen } from '@/domain/money';
import { can } from '@/domain/permissions';
import type { Attachment } from '@/domain/types';
import { useAuth } from '@/features/auth/AuthContext';
import { AttachmentDrop, AttachmentList } from '@/features/invoices/AttachmentDrop';
import { useToday } from '@/hooks/useTasks';
import { AttachmentError, attachmentsEnabled, autoFillEnabled, deleteAttachmentFile, extractReceiptDetails, uploadAttachment } from '@/lib/attachments';
import { isDeclined } from '@/lib/download';
import { useOpenRequest, useQuickNew } from '@/lib/quickRecord';

export const claimsKey = ['claims'] as const;

export function useClaims() {
  const q = useQuery({ queryKey: claimsKey, queryFn: () => repository.listClaims() });
  return { ...q, claims: q.data ?? [] };
}

/** 儲存（樂觀更新：畫面立即反映，失敗時還原）。 */
function useSaveClaims() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (list: StaffClaim[]) => repository.saveClaims(list),
    onMutate: async (list) => {
      await qc.cancelQueries({ queryKey: claimsKey });
      const prev = qc.getQueryData<StaffClaim[]>(claimsKey) ?? [];
      const ids = new Set(list.map((c) => c.id));
      qc.setQueryData<StaffClaim[]>(claimsKey, [...prev.filter((c) => !ids.has(c.id)), ...list]);
      return { prev };
    },
    onError: (e, _l, ctx) => { if (ctx) qc.setQueryData(claimsKey, ctx.prev); toast(e instanceof Error ? e.message : 'Could not save', 'error'); },
    onSettled: () => qc.invalidateQueries({ queryKey: claimsKey }),
  });
}

const STATUS_STYLE: Record<ClaimStatus, string> = {
  submitted: 'bg-amber-50 text-amber-800 ring-amber-200',
  approved: 'bg-sky-50 text-sky-800 ring-sky-200',
  paid: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  rejected: 'bg-slate-100 text-slate-500 ring-slate-200',
};
export function ClaimStatusBadge({ status }: { status: ClaimStatus }) {
  return <span className={cx('inline-flex rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset', STATUS_STYLE[status])} data-testid="claim-status">{status === 'paid' ? '✓ ' : ''}{CLAIM_STATUS_LABEL[status]}</span>;
}

type Tab = 'submitted' | 'approved' | 'paid' | 'rejected' | 'all';
const TABS: { key: Tab; label: string }[] = [
  { key: 'submitted', label: 'To approve' }, { key: 'approved', label: 'To pay' }, { key: 'paid', label: 'Paid' }, { key: 'rejected', label: 'Rejected' }, { key: 'all', label: 'All' },
];

const now = () => new Date().toISOString();
const newId = () => globalThis.crypto?.randomUUID?.() ?? `claim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export function ClaimsPage() {
  const today = useToday();
  const { user } = useAuth();
  const canEdit = can(user?.role, 'invoice.edit');
  const { claims, isLoading } = useClaims();
  const save = useSaveClaims();
  const qc = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('submitted');
  const [month, setMonth] = useState('');
  const [staff, setStaff] = useState('');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<StaffClaim | null>(null);
  const [creating, setCreating] = useState(false);
  const [paying, setPaying] = useState<StaffClaim[] | null>(null);
  const [rejecting, setRejecting] = useState<StaffClaim | null>(null);
  const [exporting, setExporting] = useState(false);
  useEffect(() => setSelected(new Set()), [tab]);
  useQuickNew('claim', () => { if (canEdit) setCreating(true); });
  // 從搜尋開啟：切到「All」並以報銷編號篩選（檢視者也適用）
  useOpenRequest('claim', (id) => { const c = claims.find((x) => x.id === id); if (c) { setTab('all'); setMonth(''); setStaff(''); setQ(c.claimNo); } }, !isLoading);

  const totals = useMemo(() => claimTotals(claims, today), [claims, today]);
  const names = useMemo(() => staffNames(claims), [claims]);
  const toPayByStaff = useMemo(() => summaryByStaff(claims, 'approved'), [claims]);
  const counts = useMemo(() => {
    const m: Record<Tab, number> = { submitted: 0, approved: 0, paid: 0, rejected: 0, all: claims.length };
    claims.forEach((c) => { m[c.status] += 1; });
    return m;
  }, [claims]);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return claims.filter((c) => (tab === 'all' || c.status === tab) && (!month || monthKey(c.expenseDate) === month)
      && (!staff || c.staffName === staff)
      && (!needle || [c.claimNo, c.staffName, c.description, c.remarks, c.category, c.paymentRef].some((s) => s.toLowerCase().includes(needle))));
  }, [claims, tab, month, staff, q]);
  const picked = rows.filter((r) => selected.has(r.id));

  const approve = async (list: StaffClaim[]) => {
    const ok = list.filter(canApprove);
    if (!ok.length) return;
    await save.mutateAsync(ok.map((c) => approveClaim(c, today, now())));
    toast(ok.length === 1 ? `Approved ${ok[0]!.claimNo}` : `Approved ${ok.length} claims`);
    setSelected(new Set());
  };
  const undo = async (c: StaffClaim) => {
    await save.mutateAsync([undoClaim(c, now())]);
    toast(c.status === 'paid' ? `Payment undone: ${c.claimNo}` : `Moved back to To approve: ${c.claimNo}`);
  };
  const remove = async (c: StaffClaim) => {
    const prev = qc.getQueryData<StaffClaim[]>(claimsKey) ?? [];
    qc.setQueryData<StaffClaim[]>(claimsKey, prev.filter((x) => x.id !== c.id));
    try {
      await repository.deleteClaim(c.id);
      if (c.receipt) void deleteAttachmentFile(c.receipt.id);
      toast(`Deleted ${c.claimNo}`);
    } catch (e) {
      qc.setQueryData(claimsKey, prev);
      toast(e instanceof Error ? e.message : 'Could not delete', 'error');
    } finally {
      void qc.invalidateQueries({ queryKey: claimsKey });
    }
  };

  const exportExcel = async () => {
    setExporting(true);
    try {
      const { buildClaimsWorkbook, downloadWorkbook } = await import('@/lib/excelExport');
      const settings = await repository.getSettings().catch(() => null);
      const wb = await buildClaimsWorkbook(rows, claims, today, settings?.companyName);
      await downloadWorkbook(wb, `Staff-Claims-${today}.xlsx`);
      toast('Excel file downloaded');
    } catch (e) {
      if (!isDeclined(e)) toast(e instanceof Error ? e.message : 'Export failed', 'error');
    } finally {
      setExporting(false);
    }
  };

  const allFlags = (c: StaffClaim) => claimFlags(c, claims);
  const details = (c: StaffClaim) => (
    <>
      <span className="text-xs font-medium text-slate-500">{c.category}{c.mileageKm ? ` · ${c.mileageKm} km × ${formatMYR(c.ratePerKm ?? 0)}` : ''}</span>
      <span className="block text-slate-700">{c.description}</span>
      {(allFlags(c).length > 0 || c.receipt || c.rejectReason || c.remarks) && (
        <span className="mt-0.5 flex flex-wrap gap-1.5 text-xs">
          {allFlags(c).map((f) => <span key={f} className="rounded bg-amber-50 px-1.5 py-0.5 font-medium text-amber-800 ring-1 ring-amber-200" data-testid="claim-flag">! {f}</span>)}
          {c.receipt && <a href={`/_blob/${c.receipt.id}`} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="font-medium text-navy-700 hover:underline">📎 Receipt</a>}
          {c.status === 'rejected' && c.rejectReason && <span className="text-slate-500">Reason: {c.rejectReason}</span>}
          {c.remarks && <span className="text-slate-500">✎ {c.remarks}</span>}
        </span>
      )}
    </>
  );
  const actions = (c: StaffClaim) => (
    <div className="flex flex-wrap items-center justify-end gap-1.5" onClick={(e: SyntheticEvent) => e.stopPropagation()}>
      {canApprove(c) && <Button size="sm" variant="primary" onClick={() => void approve([c])} data-testid="claim-approve">Approve</Button>}
      {c.status === 'submitted' && <Button size="sm" onClick={() => setRejecting(c)} data-testid="claim-reject">Reject</Button>}
      {canPay(c) && <Button size="sm" variant="primary" onClick={() => setPaying([c])} data-testid="claim-pay">Mark paid</Button>}
      {(c.status === 'approved' || c.status === 'paid') && <button type="button" className="px-1.5 text-xs font-medium text-slate-500 hover:text-navy-700 hover:underline" onClick={() => void undo(c)} data-testid="claim-undo">Undo</button>}
      <InlineDelete label={c.claimNo} onConfirm={() => remove(c)} />
    </div>
  );
  const cols: Column<StaffClaim>[] = [
    { key: 'no', header: 'Claim', sortValue: (c) => c.claimNo, render: (c) => <span className="whitespace-nowrap"><span className="font-medium text-slate-900">{c.claimNo}</span><span className="block text-xs text-slate-500">{formatDate(c.expenseDate)}</span></span> },
    { key: 'staff', header: 'Staff', sortValue: (c) => c.staffName.toLowerCase(), render: (c) => <span className="font-medium text-slate-800">{c.staffName}</span> },
    { key: 'desc', header: 'Details', render: (c) => <span className="block max-w-md">{details(c)}</span> },
    { key: 'amount', header: 'Amount', align: 'right', sortValue: (c) => c.amount, render: (c) => <span className="font-semibold text-slate-900">{formatMYR(c.amount)}</span>, footer: rows.length ? formatMYR(sumSen(rows.map((r) => r.amount))) : undefined },
    {
      key: 'status', header: 'Status', sortValue: (c) => c.status, render: (c) => (
        <span className="whitespace-nowrap"><ClaimStatusBadge status={c.status} />
          {c.status === 'paid' && <span className="mt-0.5 block text-xs text-slate-500">{formatDate(c.paidDate)} · {c.payMethod}</span>}</span>
      ),
    },
    ...(canEdit ? [{ key: 'actions', header: '', render: actions } as Column<StaffClaim>] : []),
  ];

  const selectable = canEdit && (tab === 'submitted' || tab === 'approved');
  return (
    <>
      <PageHeader eyebrow="Staff expenses" title="Staff Claims"
        subtitle="Record staff claims, approve them in one click, and pay them by bank transfer or together with salary."
        actions={<>
          <Button onClick={() => void exportExcel()} loading={exporting} disabled={!claims.length} data-testid="claims-export">Export Excel</Button>
          {canEdit && <Button variant="primary" onClick={() => setCreating(true)} data-testid="new-claim">+ New claim</Button>}
        </>} />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard testId="claims-kpi-approve" accent="amber" icon="clock" label="To approve" value={formatMYR(totals.toApprove.total)} hint={`${totals.toApprove.count} claim${totals.toApprove.count === 1 ? '' : 's'} waiting`} />
        <StatCard testId="claims-kpi-pay" accent="navy" icon="doc" label="Approved · to pay" value={formatMYR(totals.toPay.total)} hint={`${totals.toPay.count} claims · ${toPayByStaff.length} staff`} />
        <StatCard testId="claims-kpi-paid" accent="green" icon="check" label="Paid this month" value={formatMYR(totals.paidThisMonth.total)} hint={`${totals.paidThisMonth.count} claim${totals.paidThisMonth.count === 1 ? '' : 's'} in ${formatMonth(monthKey(today))}`} />
        <StatCard testId="claims-kpi-receipts" accent={totals.missingReceipts ? 'red' : 'slate'} icon="alert" label="Missing receipts" value={totals.missingReceipts} hint={totals.missingReceipts ? 'Ask staff for the receipt' : 'All receipts in'} />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-4">
        <Card padded={false} className="xl:col-span-3">
          <div className="flex flex-wrap gap-1 border-b border-slate-100 px-3 pt-3" role="tablist" aria-label="Claim status">
            {TABS.map((t) => (
              <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)} data-testid={`claims-tab-${t.key}`}
                className={cx('-mb-px rounded-t-lg border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap', tab === t.key ? 'border-navy-700 text-navy-800' : 'border-transparent text-slate-500 hover:text-slate-800')}>
                {t.label} <span className={cx('ml-1 rounded-full px-1.5 text-xs', tab === t.key ? 'bg-navy-100 text-navy-800' : 'bg-slate-100 text-slate-500')}>{counts[t.key]}</span>
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-3">
            <FilterSelect label="Month" value={month} onChange={setMonth}><option value="">All months</option>{lastNMonths(today, 12).reverse().map((m) => <option key={m} value={m}>{formatMonth(m)}</option>)}</FilterSelect>
            <FilterSelect label="Staff" value={staff} onChange={setStaff}><option value="">All staff</option>{names.map((n) => <option key={n}>{n}</option>)}</FilterSelect>
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search claim no., staff, description" aria-label="Search claims"
              className="min-w-[180px] flex-1 rounded-lg border-0 px-3 py-2 text-sm shadow-sm ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-navy-600" />
          </div>
          {picked.length > 0 && (
            <div className="flex flex-wrap items-center gap-3 border-b border-navy-100 bg-navy-50/70 px-4 py-2.5 text-sm" data-testid="claims-bulk">
              <span className="font-medium text-navy-900">{picked.length} selected · {formatMYR(sumSen(picked.map((c) => c.amount)))}</span>
              {tab === 'submitted' && <Button size="sm" variant="primary" onClick={() => void approve(picked)} data-testid="bulk-approve">Approve selected</Button>}
              {tab === 'approved' && <Button size="sm" variant="primary" onClick={() => setPaying(picked)} data-testid="bulk-pay">Mark selected paid</Button>}
              <button type="button" className="text-xs font-medium text-slate-600 hover:underline" onClick={() => setSelected(new Set())}>Clear</button>
            </div>
          )}
          {isLoading ? <p className="px-4 py-8 text-center text-sm text-slate-500">Loading…</p> : (
            <>
              {/* 桌面：表格；手機：卡片（金額與按鈕不會被擠出畫面） */}
              <div className="hidden md:block">
                <DataTable testId="claims-table" rows={rows} columns={cols} rowKey={(c) => c.id} onRowClick={canEdit ? setEditing : undefined} initialSort={{ key: 'no', dir: 'desc' }}
                  selection={selectable ? { selected, onChange: setSelected } : undefined}
                  emptyTitle={claims.length ? (tab === 'submitted' ? 'Nothing waiting for approval' : tab === 'approved' ? 'Nothing waiting to be paid' : 'No claims match these filters') : 'No staff claims yet'}
                  emptyDescription={claims.length ? undefined : 'Click "+ New claim" to record the first one.'} />
              </div>
              <ul className="divide-y divide-slate-100 md:hidden" data-testid="claims-cards">
                {rows.length === 0 && <li className="px-4 py-8 text-center text-sm text-slate-500">{claims.length ? 'Nothing here' : 'No staff claims yet. Tap "+ New claim" to add one.'}</li>}
                {[...rows].sort((a, b) => b.claimNo.localeCompare(a.claimNo)).map((c) => (
                  <li key={c.id} className="flex gap-3 px-4 py-3" data-testid="claim-card" onClick={canEdit ? () => setEditing(c) : undefined}>
                    {selectable && <input type="checkbox" className="mt-1 size-4 shrink-0 rounded border-slate-300 accent-navy-700" aria-label={`Select ${c.claimNo}`} checked={selected.has(c.id)}
                      onClick={(e) => e.stopPropagation()} onChange={() => setSelected((x) => { const n = new Set(x); if (n.has(c.id)) n.delete(c.id); else n.add(c.id); return n; })} />}
                    <div className="min-w-0 flex-1 text-sm">
                      <div className="flex items-start justify-between gap-2">
                        <span className="font-semibold text-slate-900">{c.staffName}</span>
                        <span className="tabular font-semibold text-slate-900">{formatMYR(c.amount)}</span>
                      </div>
                      <p className="text-xs text-slate-500">{c.claimNo} · {formatDate(c.expenseDate)}</p>
                      <div className="mt-1">{details(c)}</div>
                      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                        <span><ClaimStatusBadge status={c.status} />{c.status === 'paid' && <span className="ml-1.5 text-xs text-slate-500">{formatDate(c.paidDate)} · {c.payMethod}</span>}</span>
                        {canEdit && actions(c)}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>

        <Card title="To pay by staff" className="self-start">
          {toPayByStaff.length === 0 ? <p className="text-sm text-slate-500">No approved claims waiting for payment.</p> : (
            <>
              <ul className="divide-y divide-slate-100" data-testid="to-pay-by-staff">
                {toPayByStaff.map((s) => (
                  <li key={s.staffName} className="flex items-center gap-2 py-2 text-sm">
                    <span className="min-w-0 flex-1"><span className="block truncate font-medium text-slate-800">{s.staffName}</span><span className="text-xs text-slate-500">{s.count} claim{s.count === 1 ? '' : 's'}</span></span>
                    <span className="tabular font-semibold text-slate-900">{formatMYR(s.total)}</span>
                    {canEdit && <Button size="sm" onClick={() => setPaying(claims.filter((c) => s.claimIds.includes(c.id)))} data-testid="staff-pay">Pay</Button>}
                  </li>
                ))}
              </ul>
              <div className="mt-2 flex items-center justify-between border-t border-slate-200 pt-2 text-sm font-semibold"><span>Total</span><span className="tabular">{formatMYR(totals.toPay.total)}</span></div>
              {canEdit && <Button className="mt-3 w-full" variant="primary" onClick={() => setPaying(claims.filter(canPay))} data-testid="pay-all">Pay all with salary</Button>}
              <p className="mt-2 text-xs text-slate-500">Tip: add these amounts to each staff member's salary, then mark them paid here.</p>
            </>
          )}
        </Card>
      </div>

      {(creating || editing) && <ClaimFormModal claim={editing} claims={claims} names={names} onClose={() => { setCreating(false); setEditing(null); }} />}
      {paying && <PayModal claims={paying} onClose={() => setPaying(null)} onDone={() => setSelected(new Set())} />}
      {rejecting && <RejectModal claim={rejecting} onClose={() => setRejecting(null)} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// 刪除（兩步確認，不開視窗）
// ---------------------------------------------------------------------------

function InlineDelete({ label, onConfirm }: { label: string; onConfirm: () => Promise<void> | void }) {
  const [asking, setAsking] = useState(false);
  if (asking) {
    return (
      <span className="flex items-center gap-1 text-xs" data-testid="claim-delete-confirm">
        <span className="text-slate-600">Delete?</span>
        <button type="button" className="rounded-md bg-red-600 px-2 py-1 font-semibold text-white hover:bg-red-700" onClick={() => { setAsking(false); void onConfirm(); }} data-testid="claim-delete-yes">Yes</button>
        <button type="button" className="rounded-md px-2 py-1 font-medium text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50" onClick={() => setAsking(false)}>No</button>
      </span>
    );
  }
  return (
    <button type="button" onClick={() => setAsking(true)} aria-label={`Delete ${label}`} title="Delete claim" data-testid="claim-delete"
      className="grid size-8 shrink-0 place-items-center rounded-md text-slate-400 hover:bg-red-50 hover:text-red-600">
      <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></svg>
    </button>
  );
}

// ---------------------------------------------------------------------------
// 新增／編輯
// ---------------------------------------------------------------------------

const RATE_KEY = 'invoice-ap-ar:mileage-rate';
const lastRate = () => { try { return localStorage.getItem(RATE_KEY) || (DEFAULT_RATE_PER_KM / 100).toFixed(2); } catch { return (DEFAULT_RATE_PER_KM / 100).toFixed(2); } };

function ClaimFormModal({ claim, claims, names, onClose }: { claim: StaffClaim | null; claims: StaffClaim[]; names: string[]; onClose: () => void }) {
  const today = useToday();
  const save = useSaveClaims();
  const toast = useToast();
  const [v, setV] = useState<ClaimFormValues>(() => ({
    staffName: claim?.staffName ?? '', expenseDate: claim?.expenseDate ?? today, category: claim?.category ?? 'Meals & Entertainment', description: claim?.description ?? '',
    amount: claim ? (claim.amount / 100).toFixed(2) : '', mileageKm: claim?.mileageKm ? String(claim.mileageKm) : '',
    ratePerKm: claim?.ratePerKm ? (claim.ratePerKm / 100).toFixed(2) : lastRate(), hasReceipt: claim?.hasReceipt ?? false, remarks: claim?.remarks ?? '',
  }));
  const [errors, setErrors] = useState<ClaimErrors>({});
  const [formError, setFormError] = useState('');
  const [receipt, setReceipt] = useState<Attachment | null>(claim?.receipt ?? null);
  const [reading, setReading] = useState(false);
  const [note, setNote] = useState<{ tone: 'info' | 'warning' | 'error'; text: string } | null>(null);
  const [filled, setFilled] = useState<Set<string>>(new Set());
  // 尚未儲存就關閉：刪除這次上傳的收據檔案
  const uploaded = useRef<string | null>(null);
  const saved = useRef(false);
  useEffect(() => () => { if (!saved.current && uploaded.current) void deleteAttachmentFile(uploaded.current); }, []);

  const set = <K extends keyof ClaimFormValues>(k: K, value: ClaimFormValues[K]) => {
    setV((x) => ({ ...x, [k]: value }));
    setErrors((e) => ({ ...e, [k]: undefined }));
    setFilled((s) => { if (!s.has(k)) return s; const n = new Set(s); n.delete(k); return n; });
  };
  const mileage = v.category === 'Mileage';
  const km = Number(v.mileageKm);
  const rate = toSen(v.ratePerKm);
  const mileagePreview = mileage && km > 0 && rate ? mileageAmount(Math.round(km * 10) / 10, rate) : null;
  const filledHint = (k: string) => (filled.has(k) ? '✓ From receipt' : undefined);

  const handleFile = async (file: File) => {
    setReading(true);
    setNote(null);
    const readP = autoFillEnabled() ? extractReceiptDetails(file, today) : Promise.reject(new AttachmentError(''));
    try {
      const att = await uploadAttachment(file);
      if (uploaded.current) void deleteAttachmentFile(uploaded.current);
      uploaded.current = att.id;
      setReceipt(att);
      setV((x) => ({ ...x, hasReceipt: true }));
    } catch (e) {
      setNote({ tone: 'error', text: e instanceof Error ? e.message : 'Upload failed' });
      setReading(false);
      readP.catch(() => undefined);
      return;
    }
    try {
      const r = await readP;
      const keys = Object.keys(r.fields) as (keyof typeof r.fields)[];
      if (keys.length) {
        setV((x) => ({ ...x, ...r.fields, category: r.fields.category ?? x.category }));
        setFilled(new Set(keys));
        setErrors({});
      }
      setNote({ tone: r.warnings.length || !keys.length ? 'warning' : 'info', text: keys.length ? `${file.name} is attached. Details were filled in from the receipt; please check them.${r.warnings.length ? ` ${r.warnings.join(' ')}` : ''}` : `${file.name} is attached, but no details could be read. Please fill them in.` });
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      setNote({ tone: msg ? 'warning' : 'info', text: msg ? `${file.name} is attached. ${msg}` : `${file.name} is attached.` });
    } finally {
      setReading(false);
    }
  };
  const removeReceipt = () => {
    if (receipt && receipt.id === uploaded.current) { void deleteAttachmentFile(receipt.id); uploaded.current = null; }
    setReceipt(null);
  };

  const submit = async () => {
    const r = validateClaim(v, today);
    if (!r.ok) { setErrors(r.errors); return; }
    try {
      const t = now();
      let next = claim ? editClaim(claim, r.value, t) : newClaim(r.value, claims, today, t, newId());
      // 編輯時換掉舊收據：儲存成功後才刪除舊檔
      const oldReceipt = claim?.receipt && claim.receipt.id !== receipt?.id ? claim.receipt : null;
      next = { ...next, receipt, hasReceipt: r.value.hasReceipt || !!receipt };
      await save.mutateAsync([next]);
      saved.current = true;
      if (oldReceipt) void deleteAttachmentFile(oldReceipt.id);
      if (mileage) { try { localStorage.setItem(RATE_KEY, v.ratePerKm); } catch { /* 略過 */ } }
      toast(claim ? `Updated ${next.claimNo}` : `Added ${next.claimNo} for ${next.staffName}`);
      onClose();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Could not save the claim');
    }
  };

  return (
    <Modal open onClose={onClose} size="md" title={claim ? `Edit ${claim.claimNo}` : 'New staff claim'}
      subtitle={claim ? `${CLAIM_STATUS_LABEL[claim.status]} · submitted ${formatDate(claim.submittedOn)}` : 'Saved as "To approve". Approve it from the list in one click.'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => void submit()} loading={save.isPending} disabled={reading} data-testid="save-claim">{claim ? 'Save changes' : 'Add claim'}</Button></>}>
      <form className="grid grid-cols-1 gap-4 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate>
        {attachmentsEnabled() && !mileage && (
          <div className="space-y-2 sm:col-span-2" data-testid="receipt-area">
            {!receipt && <AttachmentDrop onFile={(f) => void handleFile(f)} busy={reading}
              label={reading ? 'Reading receipt…' : autoFillEnabled() ? 'Upload the receipt to fill in the details' : 'Attach the receipt'}
              hint={autoFillEnabled() ? 'Date, amount and category are filled in automatically. PDF or photo, max 20 MB.' : 'PDF, JPG, PNG or WebP, up to 20 MB.'} />}
            {receipt && <AttachmentList items={[receipt]} onRemove={removeReceipt} />}
            {note && <Alert tone={note.tone}>{note.text}</Alert>}
          </div>
        )}
        <TextInput label="Staff name *" value={v.staffName} error={errors.staffName} list="claim-staff-names" maxLength={80} autoComplete="off" onChange={(e) => set('staffName', e.target.value)} data-testid="claim-staff" />
        <datalist id="claim-staff-names">{names.map((n) => <option key={n} value={n} />)}</datalist>
        <SelectInput label="Category *" value={v.category} error={errors.category} hint={filledHint('category')} onChange={(e) => set('category', e.target.value as ClaimFormValues['category'])} data-testid="claim-category">
          {CLAIM_CATEGORIES.map((c) => <option key={c}>{c}</option>)}
        </SelectInput>
        <TextInput label="Expense date *" type="date" value={v.expenseDate} max={today} error={errors.expenseDate} hint={filledHint('expenseDate')} onChange={(e) => set('expenseDate', e.target.value)} data-testid="claim-date" />
        {mileage ? (
          <div className="grid grid-cols-2 gap-3">
            <TextInput label="Distance (km) *" inputMode="decimal" value={v.mileageKm} error={errors.mileageKm} onChange={(e) => set('mileageKm', e.target.value)} data-testid="claim-km" />
            <TextInput label="Rate per km (RM) *" inputMode="decimal" value={v.ratePerKm} error={errors.ratePerKm} onChange={(e) => set('ratePerKm', e.target.value)} data-testid="claim-rate" />
          </div>
        ) : (
          <TextInput label="Amount (RM) *" inputMode="decimal" value={v.amount} error={errors.amount} hint={filledHint('amount')} placeholder="0.00" onChange={(e) => set('amount', e.target.value)} data-testid="claim-amount" />
        )}
        {mileage && <p className="text-sm text-slate-600 sm:col-span-2" data-testid="mileage-preview">Claim amount: <strong className="text-slate-900">{mileagePreview !== null ? formatMYR(mileagePreview) : '—'}</strong> <span className="text-xs text-slate-500">(km × rate)</span></p>}
        <TextInput label={mileage ? 'Trip *' : 'Description *'} containerClassName="sm:col-span-2" value={v.description} error={errors.description} hint={filledHint('description')} maxLength={200}
          placeholder={mileage ? 'e.g. Office to Shah Alam client, return' : 'e.g. Lunch with client, Parking at KLCC'} onChange={(e) => set('description', e.target.value)} data-testid="claim-description" />
        {!mileage && (
          <label className="flex items-center gap-2 text-sm text-slate-700 sm:col-span-2">
            <input type="checkbox" className="size-4 rounded border-slate-300 accent-navy-700" checked={v.hasReceipt || !!receipt} disabled={!!receipt} onChange={(e) => set('hasReceipt', e.target.checked)} data-testid="claim-has-receipt" />
            Receipt received{receipt ? ' (attached)' : ' (paper or e-receipt)'}
          </label>
        )}
        <TextArea label="Remarks" containerClassName="sm:col-span-2" rows={2} value={v.remarks} error={errors.remarks} maxLength={1000} placeholder="Optional: project, client, notes for payroll" onChange={(e) => set('remarks', e.target.value)} data-testid="claim-remarks" />
        {formError && <div className="sm:col-span-2"><Alert>{formError}</Alert></div>}
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// 付款與退回
// ---------------------------------------------------------------------------

function PayModal({ claims, onClose, onDone }: { claims: StaffClaim[]; onClose: () => void; onDone: () => void }) {
  const today = useToday();
  const save = useSaveClaims();
  const toast = useToast();
  const [paidDate, setPaidDate] = useState(today);
  const [payMethod, setPayMethod] = useState<PayMethod>('With salary');
  const [paymentRef, setPaymentRef] = useState(() => `${formatMonth(monthKey(today))} salary`);
  const [error, setError] = useState('');
  const list = claims.filter(canPay);
  const people = summaryByStaff(list, 'approved');
  const submit = async () => {
    try {
      await save.mutateAsync(list.map((c) => payClaim(c, { paidDate, payMethod, paymentRef }, now())));
      toast(list.length === 1 ? `Paid ${list[0]!.claimNo}` : `Marked ${list.length} claims paid`);
      onDone();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    }
  };
  return (
    <Modal open onClose={onClose} size="sm" title={list.length === 1 ? `Mark ${list[0]!.claimNo} paid` : `Mark ${list.length} claims paid`}
      subtitle={`${formatMYR(sumSen(list.map((c) => c.amount)))} to ${people.length} staff`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={() => void submit()} loading={save.isPending} disabled={!list.length} data-testid="confirm-pay">Mark paid</Button></>}>
      <div className="space-y-4">
        <SelectInput label="Paid by" value={payMethod} onChange={(e) => { const m = e.target.value as PayMethod; setPayMethod(m); setPaymentRef(m === 'With salary' ? `${formatMonth(monthKey(paidDate))} salary` : ''); }} data-testid="pay-method">
          {PAY_METHODS.map((m) => <option key={m}>{m}</option>)}
        </SelectInput>
        <TextInput label="Payment date" type="date" value={paidDate} onChange={(e) => setPaidDate(e.target.value)} data-testid="pay-date" />
        <TextInput label="Reference" value={paymentRef} maxLength={100} placeholder="e.g. IBG reference" onChange={(e) => setPaymentRef(e.target.value)} data-testid="pay-ref" />
        {people.length > 1 && (
          <ul className="max-h-40 overflow-y-auto rounded-lg bg-slate-50 px-3 py-2 text-sm">
            {people.map((p) => <li key={p.staffName} className="flex justify-between py-0.5"><span>{p.staffName}</span><span className="tabular font-medium">{formatMYR(p.total)}</span></li>)}
          </ul>
        )}
        {error && <Alert>{error}</Alert>}
      </div>
    </Modal>
  );
}

function RejectModal({ claim, onClose }: { claim: StaffClaim; onClose: () => void }) {
  const today = useToday();
  const save = useSaveClaims();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const submit = async () => {
    try {
      await save.mutateAsync([rejectClaim(claim, reason, today, now())]);
      toast(`Rejected ${claim.claimNo}`);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    }
  };
  return (
    <Modal open onClose={onClose} size="sm" title={`Reject ${claim.claimNo}?`} subtitle={`${claim.staffName} · ${formatMYR(claim.amount)}`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="danger" onClick={() => void submit()} loading={save.isPending} data-testid="confirm-reject">Reject claim</Button></>}>
      <TextArea label="Reason *" rows={2} value={reason} maxLength={300} placeholder="e.g. No receipt. Please resubmit with the receipt." onChange={(e) => { setReason(e.target.value); setError(''); }} error={error} data-testid="reject-reason" />
      <p className="mt-2 text-xs text-slate-500">You can approve it later if the staff provides what is missing.</p>
    </Modal>
  );
}

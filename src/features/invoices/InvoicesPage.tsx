/**
 * 應付／應收發票清單（AP / AR invoice list）
 *
 * 同一個元件同時用於 AP 與 AR（以 type 區分），功能：
 *   - 搜尋（發票號碼、對象名稱、描述）
 *   - 篩選：供應商／客戶、付款狀態、審批狀態（AP）、發票日期區間
 *   - 欄位排序、分頁、合計列
 *   - 匯出 CSV（匯出「目前篩選後」的資料）
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApprovalBadge, Button, Card, FilterSelect, PageHeader, Spinner, StatusBadge } from '@/components/ui';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { useToast } from '@/components/ui/Toast';
import { csvFileName, invoicesToCsv } from '@/domain/csv';
import { formatDate } from '@/domain/dates';
import { dueDescription } from '@/domain/invoice';
import { formatMYR, sumSen } from '@/domain/money';
import { can } from '@/domain/permissions';
import { APPROVAL_LABEL, APPROVAL_STATUSES, PAYMENT_STATUSES, TYPE_LABELS, type ComputedInvoice, type InvoiceType } from '@/domain/types';
import { useAuth } from '@/features/auth/AuthContext';
import { useInvoices } from '@/hooks/useFinanceData';
import { downloadTextFile } from '@/lib/download';
import { InvoiceDetailModal } from './InvoiceDetailModal';
import { InvoiceFormModal } from './InvoiceFormModal';
import { ExportExcelButton } from '@/components/ui/ExportExcelButton';
import { buildInvoiceListWorkbook } from '@/lib/excelExport';
import { ACCEPT_ATTR, attachmentsEnabled } from '@/lib/attachments';

/** 「未付清」= 未取消且有未付餘額（含 Pending、Partially Paid、Overdue）。 */
const OUTSTANDING = 'Outstanding';

export function InvoicesPage({ type }: { type: InvoiceType }) {
  const L = TYPE_LABELS[type];
  const { user } = useAuth();
  const { invoices, today, isLoading, error } = useInvoices();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  // 從儀表板「新增發票」連結進入時（?new=1）直接開啟表單
  const [creating, setCreating] = useState(() => params.get('new') === '1' && can(user?.role, 'invoice.create'));
  const [openId, setOpenId] = useState<string | null>(null);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);

  // 篩選條件以 React state 為準（同步更新，連續快速操作也不會遺失），
  // 並同步寫回網址參數，方便分享連結或重新整理後保留。
  const FILTER_KEYS = ['q', 'party', 'status', 'approval', 'from', 'to'] as const;
  type FilterKey = (typeof FILTER_KEYS)[number];
  const [filters, setFilters] = useState<Record<FilterKey, string>>(() =>
    Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) ?? ''])) as Record<FilterKey, string>);
  const { q, party, status, approval, from, to } = filters;
  const setParam = (key: FilterKey, value: string) => setFilters((f) => ({ ...f, [key]: value }));
  const clearFilters = () => setFilters(Object.fromEntries(FILTER_KEYS.map((k) => [k, ''])) as Record<FilterKey, string>);
  useEffect(() => {
    const next = new URLSearchParams();
    FILTER_KEYS.forEach((k) => { if (filters[k]) next.set(k, filters[k]); });
    if (next.toString() !== params.toString()) setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在篩選條件改變時寫回網址
  }, [filters]);
  const hasFilters = !!(q || party || status || approval || from || to);

  const ofType = useMemo(() => invoices.filter((i) => i.type === type), [invoices, type]);
  const parties = useMemo(() => [...new Set(ofType.map((i) => i.counterpartyName))].sort(), [ofType]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return ofType.filter((i) =>
      (!needle || [i.invoiceNumber, i.counterpartyName, i.description].some((v) => v.toLowerCase().includes(needle)))
      && (!party || i.counterpartyName === party)
      && (!status || (status === OUTSTANDING ? i.outstandingBalance > 0 : i.status === status))
      && (!approval || i.approvalStatus === approval)
      && (!from || i.invoiceDate >= from)
      && (!to || i.invoiceDate <= to));
  }, [ofType, q, party, status, approval, from, to]);

  const totals = useMemo(() => ({
    total: sumSen(rows.map((r) => r.totalAmount)),
    paid: sumSen(rows.map((r) => r.amountPaid)),
    outstanding: sumSen(rows.map((r) => r.outstandingBalance)),
    overdue: sumSen(rows.filter((r) => r.isOverdue).map((r) => r.outstandingBalance)),
  }), [rows]);

  const exportCsv = async () => {
    try { await downloadTextFile(invoicesToCsv(rows, type), csvFileName(type, today)); } catch { return; }
    toast(`Exported ${rows.length} invoice${rows.length === 1 ? '' : 's'} to CSV`);
  };

  const columns: Column<ComputedInvoice>[] = [
    { key: 'invoiceNumber', header: 'Invoice No.', sortValue: (r) => r.invoiceNumber, render: (r) => <span className="whitespace-nowrap"><span className="font-medium text-navy-800">{r.invoiceNumber}</span>{(r.attachments?.length ?? 0) > 0 && (
      <span className="ml-1.5 inline-flex items-center gap-0.5 align-middle text-xs text-slate-500" title={`${r.attachments!.length} attachment(s)`} data-testid="has-attachment">
        <svg viewBox="0 0 20 20" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden><path d="m13.5 7-5.8 5.8a1.8 1.8 0 0 0 2.5 2.5l6.3-6.3a3.5 3.5 0 0 0-5-5L5 10.5a5.3 5.3 0 0 0 7.5 7.5L17 13.5" strokeLinecap="round" /></svg>
        {r.attachments!.length}<span className="sr-only"> attachments</span></span>)}<span className="block text-xs text-slate-500 2xl:hidden">{formatDate(r.invoiceDate)}</span></span>, footer: `${rows.length} invoices` },
    {
      key: 'party', header: L.party, sortValue: (r) => r.counterpartyName,
      render: (r) => <><span className="font-medium text-slate-900">{r.counterpartyName}</span>{r.description && <span className="block max-w-[16rem] truncate text-xs text-slate-500">{r.description}</span>}</>,
    },
    { key: 'invoiceDate', header: 'Invoice Date', sortValue: (r) => r.invoiceDate, wideOnly: true, render: (r) => <span className="whitespace-nowrap">{formatDate(r.invoiceDate)}</span> },
    {
      key: 'dueDate', header: 'Due Date', sortValue: (r) => r.dueDate,
      render: (r) => <span className="whitespace-nowrap">{formatDate(r.dueDate)}<span className={`block text-xs ${r.isOverdue ? 'font-medium text-red-700' : 'text-slate-500'}`}>{dueDescription(r, today)}</span></span>,
    },
    { key: 'invoiceAmount', header: 'Invoice Amt', align: 'right', wideOnly: true, sortValue: (r) => r.invoiceAmount, render: (r) => formatMYR(r.invoiceAmount) },
    { key: 'taxAmount', header: 'Tax', align: 'right', wideOnly: true, sortValue: (r) => r.taxAmount, render: (r) => formatMYR(r.taxAmount) },
    { key: 'total', header: 'Total', align: 'right', hideOnMobile: true, sortValue: (r) => r.totalAmount, render: (r) => formatMYR(r.totalAmount), footer: formatMYR(totals.total) },
    { key: 'paid', header: type === 'AR' ? 'Received' : 'Paid', align: 'right', hideOnMobile: true, sortValue: (r) => r.amountPaid, render: (r) => formatMYR(r.amountPaid), footer: formatMYR(totals.paid) },
    { key: 'outstanding', header: 'Outstanding', align: 'right', sortValue: (r) => r.outstandingBalance, render: (r) => <span className="font-semibold text-slate-900">{formatMYR(r.outstandingBalance)}</span>, footer: <span data-testid="footer-outstanding">{formatMYR(totals.outstanding)}</span> },
    {
      key: 'status', header: L.status, sortValue: (r) => PAYMENT_STATUSES.indexOf(r.status),
      render: (r) => (
        <div className="flex flex-col items-start gap-1">
          <StatusBadge status={r.status} />
          {r.isOverdue && r.isPartiallyPaid && <span className="text-[11px] text-slate-500">part paid</span>}
          {type === 'AP' && r.approvalStatus !== 'approved' && <ApprovalBadge status={r.approvalStatus} />}
        </div>
      ),
    },
  ];

  if (isLoading) return <div className="grid h-64 place-items-center text-slate-400"><Spinner /></div>;
  if (error) return <p className="text-sm text-red-600">{(error as Error).message}</p>;

  return (
    <>
      <PageHeader title={L.module}
        subtitle={type === 'AP' ? 'Supplier invoices — money the company owes.' : 'Customer invoices — money owed to the company.'}
        actions={<>
          <ExportExcelButton testId="export-excel" fileName={`${type}-invoices-${today}.xlsx`} build={() => buildInvoiceListWorkbook(rows, type)} disabled={!rows.length} />
          <Button onClick={exportCsv} disabled={!rows.length} data-testid="export-csv"
            icon={<svg viewBox="0 0 20 20" className="size-4" fill="currentColor" aria-hidden><path d="M10 3v8.6l3.3-3.3 1.1 1.1L10 14.8 5.6 9.4l1.1-1.1L10 11.6V3zM4 15h12v2H4z" /></svg>}>CSV</Button>
          {can(user?.role, 'invoice.create') && attachmentsEnabled() && (
            <>
              <Button onClick={() => uploadRef.current?.click()} data-testid="upload-invoice"
                icon={<svg viewBox="0 0 20 20" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden><path d="M10 13V4m0 0L6.5 7.5M10 4l3.5 3.5M4 13v3h12v-3" strokeLinecap="round" strokeLinejoin="round" /></svg>}>
                Upload invoice
              </Button>
              <input ref={uploadRef} type="file" accept={ACCEPT_ATTR} className="hidden" id={`upload-${type}`} data-testid="upload-invoice-input"
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) { setUploadFile(f); setCreating(true); } }} />
            </>
          )}
          {can(user?.role, 'invoice.create') && <Button variant="primary" onClick={() => { setUploadFile(null); setCreating(true); }} data-testid="new-invoice">+ {L.newInvoice}</Button>}
        </>} />

      {/* 篩選後的摘要 */}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          ['Total invoiced', totals.total], [type === 'AR' ? 'Received' : 'Paid', totals.paid],
          ['Outstanding', totals.outstanding], ['Overdue', totals.overdue],
        ].map(([label, v]) => (
          <div key={label as string} className="rounded-lg bg-slate-50 px-4 py-2.5 ring-1 ring-slate-200">
            <p className="text-xs text-slate-500">{label as string}{hasFilters ? ' (filtered)' : ''}</p>
            <p className={`tabular text-base font-semibold ${label === 'Overdue' && (v as number) > 0 ? 'text-red-700' : 'text-slate-900'}`} data-testid={`summary-${(label as string).toLowerCase().replace(/\s+/g, '-')}`}>{formatMYR(v as number)}</p>
          </div>
        ))}
      </div>

      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 p-4">
          <div className="relative min-w-[220px] flex-1">
            <svg viewBox="0 0 20 20" className="pointer-events-none absolute top-2.5 left-3 size-4 text-slate-400" fill="currentColor" aria-hidden><path d="M8.5 3a5.5 5.5 0 0 1 4.4 8.8l3.7 3.7-1.1 1.1-3.7-3.7A5.5 5.5 0 1 1 8.5 3zm0 1.5a4 4 0 1 0 0 8 4 4 0 0 0 0-8z" /></svg>
            <input type="search" value={q} onChange={(e) => setParam('q', e.target.value)} placeholder={`Search invoice no., ${L.party.toLowerCase()} or description`}
              aria-label="Search invoices" className="w-full rounded-lg border-0 py-2 pr-3 pl-9 text-sm shadow-sm ring-1 ring-inset ring-slate-300 placeholder:text-slate-400 focus:ring-2 focus:ring-navy-600" />
          </div>
          <FilterSelect label={`Filter by ${L.party.toLowerCase()}`} value={party} onChange={(v) => setParam('party', v)}>
            <option value="">All {L.partyPlural.toLowerCase()}</option>
            {parties.map((p) => <option key={p} value={p}>{p}</option>)}
          </FilterSelect>
          <FilterSelect label={`Filter by ${L.status.toLowerCase()}`} value={status} onChange={(v) => setParam('status', v)}>
            <option value="">All statuses</option>
            <option value={OUTSTANDING}>Outstanding (unpaid)</option>
            {PAYMENT_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </FilterSelect>
          {type === 'AP' && (
            <FilterSelect label="Filter by approval status" value={approval} onChange={(v) => setParam('approval', v)}>
              <option value="">All approvals</option>
              {APPROVAL_STATUSES.map((s) => <option key={s} value={s}>{APPROVAL_LABEL[s]}</option>)}
            </FilterSelect>
          )}
          <div className="flex items-center gap-1.5 text-sm text-slate-500">
            <input type="date" aria-label="Invoice date from" value={from} onChange={(e) => setParam('from', e.target.value)} className="rounded-lg border-0 px-2 py-2 text-sm shadow-sm ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-navy-600" />
            <span>to</span>
            <input type="date" aria-label="Invoice date to" value={to} onChange={(e) => setParam('to', e.target.value)} className="rounded-lg border-0 px-2 py-2 text-sm shadow-sm ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-navy-600" />
          </div>
          {hasFilters && <Button variant="ghost" size="sm" onClick={clearFilters}>Clear filters</Button>}
        </div>
        <DataTable testId="invoice-table" rows={rows} columns={columns} rowKey={(r) => r.id} onRowClick={(r) => setOpenId(r.id)}
          initialSort={{ key: 'invoiceDate', dir: 'desc' }}
          rowClassName={(r) => (r.isCancelled ? 'opacity-60' : '')}
          emptyTitle={hasFilters ? 'No invoices match these filters' : `No ${L.module.toLowerCase()} invoices yet`}
          emptyDescription={hasFilters ? 'Try clearing a filter.' : undefined} />
      </Card>

      {creating && <InvoiceFormModal open type={type} initialFile={uploadFile} onClose={() => { setCreating(false); setUploadFile(null); }} onSaved={(id) => setOpenId(id)} />}
      <InvoiceDetailModal invoiceId={openId} onClose={() => setOpenId(null)} />
    </>
  );
}

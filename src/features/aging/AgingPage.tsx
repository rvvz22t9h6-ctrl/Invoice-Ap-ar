/**
 * 帳齡報表（Invoice aging report）
 *
 * 依未付餘額與逾期天數分組（Current / 1–30 / 31–60 / 61–90 / 90+），
 * 提供：區間摘要、依供應商／客戶彙總表、逾期明細，以及 CSV 匯出。
 */
import { useMemo, useState } from 'react';
import { Button, Card, cx, PageHeader, Spinner, StatusBadge } from '@/components/ui';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { useToast } from '@/components/ui/Toast';
import { AGING_BUCKETS, agingBucket, buildAgingReport, type AgingRow } from '@/domain/aging';
import { toCsv } from '@/domain/csv';
import { formatDate } from '@/domain/dates';
import { formatMYR, senToDecimalString } from '@/domain/money';
import { TYPE_LABELS, type ComputedInvoice, type InvoiceType } from '@/domain/types';
import { InvoiceDetailModal } from '@/features/invoices/InvoiceDetailModal';
import { useInvoices } from '@/hooks/useFinanceData';
import { downloadTextFile } from '@/lib/download';
import { ExportExcelButton } from '@/components/ui/ExportExcelButton';
import { buildAgingWorkbook } from '@/lib/excelExport';

export function AgingPage() {
  const { invoices, today, isLoading } = useInvoices();
  const [type, setType] = useState<InvoiceType>('AR');
  const [openId, setOpenId] = useState<string | null>(null);
  const toast = useToast();
  const report = useMemo(() => buildAgingReport(invoices, type), [invoices, type]);
  const L = TYPE_LABELS[type];

  if (isLoading) return <div className="grid h-64 place-items-center text-slate-400"><Spinner /></div>;

  const exportCsv = async () => {
    const header = [L.party, ...AGING_BUCKETS.map((b) => `${b.label} (MYR)`), 'Total Outstanding (MYR)'];
    const body = report.byCounterparty.map((r) => [r.counterpartyName, ...AGING_BUCKETS.map((b) => senToDecimalString(r.buckets[b.key])), senToDecimalString(r.total)]);
    const foot = ['TOTAL', ...AGING_BUCKETS.map((b) => senToDecimalString(report.buckets[b.key].amount)), senToDecimalString(report.total.amount)];
    try { await downloadTextFile(toCsv([header, ...body, foot]), `${type}-aging-${today}.csv`); } catch { return; }
    toast('Aging report exported');
  };

  const max = Math.max(...AGING_BUCKETS.map((b) => report.buckets[b.key].amount), 1);

  const byPartyCols: Column<AgingRow>[] = [
    { key: 'name', header: L.party, sortValue: (r) => r.counterpartyName, render: (r) => <span className="font-medium text-slate-900">{r.counterpartyName}</span>, footer: 'Total' },
    ...AGING_BUCKETS.map((b): Column<AgingRow> => ({
      key: b.key, header: b.label, align: 'right', sortValue: (r) => r.buckets[b.key], hideOnMobile: b.key !== 'current' && b.key !== 'd90_plus',
      render: (r) => <span className={r.buckets[b.key] === 0 ? 'text-slate-300' : b.key === 'current' ? '' : 'text-red-700'}>{formatMYR(r.buckets[b.key])}</span>,
      footer: formatMYR(report.buckets[b.key].amount),
    })),
    { key: 'total', header: 'Total', align: 'right', sortValue: (r) => r.total, render: (r) => <span className="font-semibold">{formatMYR(r.total)}</span>, footer: <span data-testid="aging-total">{formatMYR(report.total.amount)}</span> },
  ];

  const detailCols: Column<ComputedInvoice>[] = [
    { key: 'no', header: 'Invoice No.', sortValue: (r) => r.invoiceNumber, render: (r) => <span className="font-medium text-navy-800">{r.invoiceNumber}</span> },
    { key: 'party', header: L.party, sortValue: (r) => r.counterpartyName, render: (r) => r.counterpartyName },
    { key: 'due', header: 'Due Date', sortValue: (r) => r.dueDate, hideOnMobile: true, render: (r) => formatDate(r.dueDate) },
    { key: 'days', header: 'Days Overdue', align: 'right', sortValue: (r) => r.daysOverdue, render: (r) => (r.daysOverdue > 0 ? <span className="font-medium text-red-700">{r.daysOverdue}</span> : '—') },
    { key: 'bucket', header: 'Bucket', hideOnMobile: true, render: (r) => AGING_BUCKETS.find((b) => b.key === agingBucket(r.daysOverdue))!.label },
    { key: 'out', header: 'Outstanding', align: 'right', sortValue: (r) => r.outstandingBalance, render: (r) => <span className="font-semibold">{formatMYR(r.outstandingBalance)}</span> },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} /> },
  ];

  return (
    <>
      <PageHeader title="Invoice Aging Report" subtitle={`Outstanding balances grouped by days past due date, as of ${formatDate(today)}.`}
        actions={<>
          <div className="inline-flex rounded-lg bg-slate-100 p-0.5 text-sm font-medium" role="tablist" aria-label="Report type">
            {(['AR', 'AP'] as const).map((t) => (
              <button key={t} type="button" role="tab" aria-selected={type === t} onClick={() => setType(t)}
                className={cx('rounded-md px-3 py-1.5', type === t ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800')}>
                {t === 'AR' ? 'Receivables (AR)' : 'Payables (AP)'}
              </button>
            ))}
          </div>
          <ExportExcelButton testId="export-aging-excel" fileName={`${type}-aging-${today}.xlsx`} build={() => buildAgingWorkbook(report)} disabled={!report.byCounterparty.length} />
          <Button onClick={exportCsv} disabled={!report.byCounterparty.length}>CSV</Button>
        </>} />

      {/* 各區間摘要 */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6" data-testid="aging-buckets">
        {AGING_BUCKETS.map((b) => {
          const v = report.buckets[b.key];
          return (
            <div key={b.key} className="rounded-xl border border-slate-200 bg-white p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{b.label}</p>
              <p className="tabular mt-1 text-lg font-semibold text-slate-900">{formatMYR(v.amount)}</p>
              <p className="text-xs text-slate-500">{v.count} invoice{v.count === 1 ? '' : 's'} · {report.total.amount ? Math.round((v.amount / report.total.amount) * 100) : 0}%</p>
              <div className="mt-2 h-1.5 rounded-full bg-slate-100" aria-hidden>
                <div className={cx('h-1.5 rounded-full', b.key === 'current' ? (type === 'AR' ? 'bg-series-ar' : 'bg-series-ap') : 'bg-red-600')} style={{ width: `${(v.amount / max) * 100}%` }} />
              </div>
            </div>
          );
        })}
        <div className="rounded-xl deep-panel p-4 text-white">
          <p className="text-xs font-medium uppercase tracking-wide text-navy-200">Total outstanding</p>
          <p className="tabular mt-1 text-lg font-semibold">{formatMYR(report.total.amount)}</p>
          <p className="text-xs text-navy-200">{report.total.count} invoices</p>
        </div>
      </div>

      <Card className="mt-6" title={`Aging by ${L.party.toLowerCase()}`} padded={false}>
        <DataTable rows={report.byCounterparty} columns={byPartyCols} rowKey={(r) => r.counterpartyId} initialSort={{ key: 'total', dir: 'desc' }}
          emptyTitle="Nothing outstanding" pageSize={50} />
      </Card>

      <Card className="mt-6" title="Outstanding invoices" padded={false}>
        <DataTable rows={report.invoices} columns={detailCols} rowKey={(r) => r.id} onRowClick={(r) => setOpenId(r.id)}
          initialSort={{ key: 'days', dir: 'desc' }} emptyTitle="Nothing outstanding" />
      </Card>

      <InvoiceDetailModal invoiceId={openId} onClose={() => setOpenId(null)} />
    </>
  );
}

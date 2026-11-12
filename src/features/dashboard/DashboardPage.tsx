/**
 * 儀表板（Dashboard）
 *
 * 所有數字都由 domain/dashboard.ts 根據發票與付款紀錄即時計算，
 * 沒有任何寫死的總額。新增發票或付款後，數字會自動更新。
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, EmptyState, PageHeader, Spinner, StatCard, TypeTag } from '@/components/ui';
import { AGING_BUCKETS, buildAgingReport } from '@/domain/aging';
import { buildDashboard } from '@/domain/dashboard';
import { formatDate, formatDateTime } from '@/domain/dates';
import { dueDescription } from '@/domain/invoice';
import { formatMYR } from '@/domain/money';
import type { ComputedInvoice } from '@/domain/types';
import { useActivity, useInvoices } from '@/hooks/useFinanceData';
import { can } from '@/domain/permissions';
import { useAuth } from '@/features/auth/AuthContext';
import { InvoiceDetailModal } from '@/features/invoices/InvoiceDetailModal';
import { TrendChart } from './TrendChart';
import { ExportExcelButton } from '@/components/ui/ExportExcelButton';
import { buildFullReport } from '@/lib/excelExport';

export function DashboardPage() {
  const { invoices, today, isLoading, error } = useInvoices();
  const activity = useActivity({ limit: 10 });
  const { user } = useAuth();
  const [openId, setOpenId] = useState<string | null>(null);

  const d = useMemo(() => buildDashboard(invoices, today), [invoices, today]);
  const aging = useMemo(() => ({ AR: buildAgingReport(invoices, 'AR'), AP: buildAgingReport(invoices, 'AP') }), [invoices]);

  if (isLoading) return <div className="grid h-64 place-items-center text-slate-400"><Spinner /></div>;
  if (error) return <EmptyState title="Could not load data" description={(error as Error).message} />;

  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

  return (
    <>
      <PageHeader title="Dashboard" subtitle="Live position of payables and receivables, calculated from invoice and payment records."
        actions={<ExportExcelButton variant="primary" label="Export full report to Excel" testId="export-full-report"
          fileName={`Finance-Report-${today}.xlsx`} build={() => buildFullReport(invoices, today)} disabled={!invoices.length} />} />

      {invoices.length === 0 && (
        <section className="mb-6 rounded-xl border border-navy-100 bg-navy-50 p-6" data-testid="welcome">
          <h2 className="text-lg font-semibold text-navy-900">Welcome. Add your first invoice to get started.</h2>
          <p className="mt-1 max-w-2xl text-sm text-navy-800">
            Enter supplier bills under Accounts Payable and customer invoices under Accounts Receivable, then record payments as they happen.
            Every total below updates automatically, and <strong>Export full report to Excel</strong> turns it into a workbook for management.
          </p>
          {can(user?.role, 'invoice.create') && (
            <div className="mt-4 flex flex-wrap gap-2">
              <Link to="/ar?new=1" className="rounded-lg bg-navy-800 px-3.5 py-2 text-sm font-medium text-white hover:bg-navy-700">+ New customer invoice (AR)</Link>
              <Link to="/ap?new=1" className="rounded-lg bg-white px-3.5 py-2 text-sm font-medium text-navy-800 ring-1 ring-navy-200 hover:bg-navy-50">+ New supplier invoice (AP)</Link>
            </div>
          )}
          <p className="mt-3 text-xs text-navy-700">Want to explore first? Open <strong>My data…</strong> in the sidebar and choose <strong>Load sample data</strong>.</p>
        </section>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard testId="kpi-ar-outstanding" accent="ar" label="Total AR Outstanding" value={formatMYR(d.AR.outstanding)} hint={`${plural(d.AR.outstandingCount, 'unpaid customer invoice')}`} />
        <StatCard testId="kpi-ar-collected" accent="green" label="Total AR Collected" value={formatMYR(d.AR.settled)} hint={`${formatMYR(d.AR.settledThisMonth)} collected this month`} />
        <StatCard testId="kpi-ar-overdue" accent="red" label="Overdue AR" value={formatMYR(d.AR.overdue)} hint={`${plural(d.AR.overdueCount, 'invoice')} past due date`} />
        <StatCard testId="kpi-ap-outstanding" accent="ap" label="Total AP Outstanding" value={formatMYR(d.AP.outstanding)} hint={`${plural(d.AP.outstandingCount, 'unpaid supplier invoice')}`} />
        <StatCard testId="kpi-ap-paid" accent="green" label="Total AP Paid" value={formatMYR(d.AP.settled)} hint={`${formatMYR(d.AP.settledThisMonth)} paid this month`} />
        <StatCard testId="kpi-ap-overdue" accent="red" label="Overdue AP" value={formatMYR(d.AP.overdue)} hint={`${plural(d.AP.overdueCount, 'invoice')} past due date`} />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-1 rounded-xl bg-navy-50 px-5 py-3 text-sm text-navy-900 ring-1 ring-navy-100">
        <span>Net position (AR − AP outstanding): <strong className="tabular" data-testid="net-position">{formatMYR(d.netPosition)}</strong></span>
        <span className="text-navy-700">Invoiced this month: AR {formatMYR(d.AR.invoicedThisMonth)} · AP {formatMYR(d.AP.invoicedThisMonth)}</span>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="xl:col-span-2"><TrendChart data={d.trends} /></div>

        <Card title="Aging snapshot" action={<Link to="/aging" className="text-xs font-medium text-navy-700 hover:underline">Full report →</Link>} padded={false}>
          <table className="min-w-full text-[13px]" data-testid="aging-snapshot">
            <thead className="bg-slate-50/80 text-xs uppercase tracking-wide text-slate-500">
              <tr><th className="px-4 py-2.5 text-left">Bucket</th><th className="px-3 py-2.5 text-right">AR</th><th className="px-4 py-2.5 text-right">AP</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {AGING_BUCKETS.map((b) => (
                <tr key={b.key}>
                  <td className="whitespace-nowrap px-4 py-2.5 text-slate-600">{b.label}</td>
                  <td className="tabular whitespace-nowrap px-3 py-2.5 text-right">{formatMYR(aging.AR.buckets[b.key].amount)}</td>
                  <td className="tabular whitespace-nowrap px-4 py-2.5 text-right">{formatMYR(aging.AP.buckets[b.key].amount)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t-2 border-slate-200 font-semibold">
              <tr><td className="px-4 py-2.5">Total</td><td className="tabular whitespace-nowrap px-3 py-2.5 text-right">{formatMYR(aging.AR.total.amount)}</td><td className="tabular whitespace-nowrap px-4 py-2.5 text-right">{formatMYR(aging.AP.total.amount)}</td></tr>
            </tfoot>
          </table>
        </Card>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-3">
        <InvoiceMiniList title="Most overdue" rows={d.topOverdue} today={today} onOpen={setOpenId} empty="Nothing is overdue" />
        <InvoiceMiniList title="Due in the next 7 days" rows={d.dueSoon} today={today} onOpen={setOpenId} empty="Nothing due in the next 7 days" />
        <Card title="Recent invoice activity" padded={false}>
          {activity.isLoading ? <div className="grid h-32 place-items-center text-slate-400"><Spinner /></div>
            : !activity.data?.length ? <EmptyState title="No activity yet" />
              : (
                <ul className="divide-y divide-slate-100" data-testid="recent-activity">
                  {activity.data.map((a) => (
                    <li key={a.id} className="px-5 py-3">
                      {a.invoiceId ? (
                        <button type="button" onClick={() => setOpenId(a.invoiceId)} className="text-left text-sm text-slate-800 hover:text-navy-700">{a.summary}</button>
                      ) : <p className="text-sm text-slate-800">{a.summary}</p>}
                      <p className="mt-0.5 text-xs text-slate-500">{a.actorName ?? 'System'} · {formatDateTime(a.createdAt)}</p>
                    </li>
                  ))}
                </ul>
              )}
        </Card>
      </div>

      <InvoiceDetailModal invoiceId={openId} onClose={() => setOpenId(null)} />
    </>
  );
}

function InvoiceMiniList({ title, rows, today, onOpen, empty }: {
  title: string; rows: ComputedInvoice[]; today: string; onOpen: (id: string) => void; empty: string;
}) {
  return (
    <Card title={title} padded={false}>
      {!rows.length ? <EmptyState title={empty} /> : (
        <ul className="divide-y divide-slate-100">
          {rows.map((i) => (
            <li key={i.id}>
              <button type="button" onClick={() => onOpen(i.id)} className="flex w-full items-start justify-between gap-3 px-5 py-3 text-left hover:bg-navy-50/50">
                <span className="min-w-0">
                  <span className="flex items-center gap-2"><TypeTag type={i.type} /><span className="truncate text-sm font-medium text-slate-800">{i.counterpartyName}</span></span>
                  <span className="mt-0.5 block text-xs text-slate-500">{i.invoiceNumber} · due {formatDate(i.dueDate)} · <span className={i.isOverdue ? 'font-medium text-red-700' : ''}>{dueDescription(i, today)}</span></span>
                </span>
                <span className="tabular shrink-0 text-sm font-semibold text-slate-900">{formatMYR(i.outstandingBalance)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}


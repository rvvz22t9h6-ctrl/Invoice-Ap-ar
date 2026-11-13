/**
 * 儀表板（Dashboard）
 *
 * 所有數字都由 domain/dashboard.ts 根據發票與付款紀錄即時計算，
 * 沒有任何寫死的總額。新增發票或付款後，數字會自動更新。
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, EmptyState, PageHeader, Spinner, StatCard, TypeTag } from '@/components/ui';
import { WeeklySummaryModal } from './WeeklySummaryModal';
import { AGING_BUCKETS, buildAgingReport } from '@/domain/aging';
import { buildDashboard } from '@/domain/dashboard';
import { COMPANY_TIME_ZONE, formatDate, formatDateTime } from '@/domain/dates';
import { buildMetrics } from '@/domain/metrics';
import { buildCashFlowForecast } from '@/domain/cashflow';
import { dueDescription } from '@/domain/invoice';
import { formatMYR } from '@/domain/money';
import type { ComputedInvoice } from '@/domain/types';
import { useActivity, useInvoices, useSettings } from '@/hooks/useFinanceData';
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
  const { settings } = useSettings();
  const m = useMemo(() => buildMetrics(invoices, today), [invoices, today]);
  const cf = useMemo(() => buildCashFlowForecast(invoices, today, settings, 4), [invoices, today, settings]);
  // 未來 4 週（含逾期）預計收付
  const next4 = cf.rows.reduce((t, r) => ({ in: t.in + r.inflow, out: t.out + r.outflow }), { in: 0, out: 0 });
  const hour = Number(new Date().toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: COMPANY_TIME_ZONE }));
  const greeting = `${hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'}${user?.fullName && !/^(Owner|Viewer)$/.test(user.fullName) ? `, ${user.fullName.split(' ')[0]}` : ''}`;
  const aging = useMemo(() => ({ AR: buildAgingReport(invoices, 'AR'), AP: buildAgingReport(invoices, 'AP') }), [invoices]);

  if (isLoading) return <div className="grid h-64 place-items-center text-slate-400"><Spinner /></div>;
  if (error) return <EmptyState title="Could not load data" description={(error as Error).message} />;

  const [summaryOpen, setSummaryOpen] = useState(false);
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

  return (
    <>
      <PageHeader eyebrow={`${greeting} · ${formatDate(today)}`} title="Dashboard" subtitle={`Live position of ${settings.companyName || 'your company'}'s payables and receivables, calculated from invoice and payment records.`}
        actions={<>
          <Button onClick={() => setSummaryOpen(true)} disabled={!invoices.length} data-testid="weekly-summary">Weekly summary</Button>
          <ExportExcelButton variant="primary" label="Export full report to Excel" testId="export-full-report"
            fileName={`Finance-Report-${today}.xlsx`} build={() => buildFullReport(invoices, today, settings.companyName, settings)} disabled={!invoices.length} />
        </>} />
      {summaryOpen && <WeeklySummaryModal invoices={invoices} today={today} companyName={settings.companyName} onClose={() => setSummaryOpen(false)} />}

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
        <StatCard testId="kpi-ar-outstanding" accent="ar" icon="in" label="Total AR Outstanding" value={formatMYR(d.AR.outstanding)} hint={`${plural(d.AR.outstandingCount, 'unpaid customer invoice')}`} />
        <StatCard testId="kpi-ar-collected" accent="green" icon="check" label="Total AR Collected" value={formatMYR(d.AR.settled)} hint={`${formatMYR(d.AR.settledThisMonth)} collected this month`} />
        <StatCard testId="kpi-ar-overdue" accent="red" icon="alert" label="Overdue AR" value={formatMYR(d.AR.overdue)} hint={`${plural(d.AR.overdueCount, 'invoice')} past due date`} />
        <StatCard testId="kpi-ap-outstanding" accent="ap" icon="out" label="Total AP Outstanding" value={formatMYR(d.AP.outstanding)} hint={`${plural(d.AP.outstandingCount, 'unpaid supplier invoice')}`} />
        <StatCard testId="kpi-ap-paid" accent="green" icon="check" label="Total AP Paid" value={formatMYR(d.AP.settled)} hint={`${formatMYR(d.AP.settledThisMonth)} paid this month`} />
        <StatCard testId="kpi-ap-overdue" accent="red" icon="alert" label="Overdue AP" value={formatMYR(d.AP.overdue)} hint={`${plural(d.AP.overdueCount, 'invoice')} past due date`} />
      </div>

      {/* 現金與淨部位 */}
      <section className="mt-4 grid grid-cols-1 overflow-hidden rounded-2xl deep-panel text-white sm:grid-cols-2 xl:grid-cols-4" data-testid="cash-band">
        {[
          ['Net position (AR − AP)', <span data-testid="net-position">{formatMYR(d.netPosition)}</span>, 'Owed to us minus what we owe'],
          ['Bank balance today (est.)', formatMYR(cf.currentBalance), settings.openingBalanceDate ? 'From your bank balance and payments since' : <Link to="/settings" className="underline">Set your bank balance</Link>],
          ['Next 4 weeks: in', formatMYR(next4.in), `${formatMYR(cf.rows[0]!.inflow)} of it already overdue`],
          ['Next 4 weeks: out', formatMYR(next4.out), <Link to="/cash-flow" className="underline">Open cash flow forecast →</Link>],
        ].map(([label, value, hint], i) => (
          <div key={i} className="border-white/10 px-5 py-4 sm:[&:nth-child(n+3)]:border-t xl:[&:nth-child(n+3)]:border-t-0 xl:[&:not(:first-child)]:border-l">
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-navy-300">{label}</p>
            <p className="font-display tabular mt-1 text-xl font-semibold">{value}</p>
            <p className="mt-0.5 text-xs text-navy-300">{hint}</p>
          </div>
        ))}
      </section>

      {/* 績效指標 */}
      <Card className="mt-6" title="Performance" action={<span className="text-xs text-slate-500">Last 90 days for DSO / DPO, last 12 months for the rest</span>} padded={false}>
        <dl className="grid grid-cols-2 divide-slate-100 sm:grid-cols-3 xl:grid-cols-6 xl:divide-x" data-testid="metrics">
          {[
            ['DSO', m.dso === null ? '—' : `${m.dso} days`, 'Days sales outstanding: how long customers take to pay on average'],
            ['DPO', m.dpo === null ? '—' : `${m.dpo} days`, 'Days payables outstanding: how long you take to pay suppliers'],
            ['Avg. days to collect', m.avgDaysToCollect === null ? '—' : `${m.avgDaysToCollect} days`, `From invoice date to full payment (${m.sampleSizes.collected} invoices)`],
            ['Collected on time', m.onTimeCollectionRate === null ? '—' : `${Math.round(m.onTimeCollectionRate * 100)}%`, 'Customer invoices paid by their due date'],
            ['Credit notes', formatMYR(d.AR.creditNotes + d.AP.creditNotes), `AR ${formatMYR(d.AR.creditNotes)} · AP ${formatMYR(d.AP.creditNotes)}`],
            ['Written off', formatMYR(d.AR.writtenOff), m.badDebtRate === null ? 'Bad debt' : `${(m.badDebtRate * 100).toFixed(1)}% of 12-month sales`],
          ].map(([label, value, hint]) => (
            <div key={label} className="px-5 py-4" title={hint}>
              <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-500">{label}</dt>
              <dd className="font-display tabular mt-1 text-lg font-semibold text-slate-900">{value}</dd>
              <dd className="mt-0.5 text-[11px] leading-snug text-slate-500">{hint}</dd>
            </div>
          ))}
        </dl>
      </Card>

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


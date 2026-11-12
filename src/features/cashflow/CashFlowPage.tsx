/**
 * 現金流預測（Cash flow forecast）
 *
 * 由目前估計的銀行餘額開始，依發票到期日預測未來 12 週的收付款與餘額。
 * 圖表：每週預計收款（藍）與付款（橘）長條，及預計餘額折線（同一個 RM 座標軸）。
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Alert, Button, Card, cx, PageHeader, Spinner, StatCard, TextInput } from '@/components/ui';
import { ExportExcelButton } from '@/components/ui/ExportExcelButton';
import { useToast } from '@/components/ui/Toast';
import { buildCashFlowForecast } from '@/domain/cashflow';
import { formatDate } from '@/domain/dates';
import { formatMYR, formatMYRCompact, senToDecimalString, toSen } from '@/domain/money';
import { can } from '@/domain/permissions';
import { useAuth } from '@/features/auth/AuthContext';
import { useInvoices, useSettings, useSettingsMutation } from '@/hooks/useFinanceData';
import { buildCashFlowWorkbook } from '@/lib/excelExport';

const AR = '#2a78d6';
const AP = '#eb6834';
const BAL = '#0f1f3d';

export function CashFlowPage() {
  const { invoices, today, isLoading } = useInvoices();
  const { settings } = useSettings();
  const { user } = useAuth();
  const [editing, setEditing] = useState(false);
  const f = useMemo(() => buildCashFlowForecast(invoices, today, settings), [invoices, today, settings]);
  if (isLoading) return <div className="grid h-64 place-items-center text-slate-400"><Spinner /></div>;

  const data = [{ label: 'Today', inflow: 0, outflow: 0, closing: f.currentBalance }, ...f.rows.map((r) => ({ label: r.key === 'overdue' ? 'Overdue' : r.label.split(' – ')[0], inflow: r.inflow, outflow: -r.outflow, closing: r.closing }))];
  const end = f.rows.at(-1)!.closing;

  return (
    <>
      <PageHeader eyebrow="Overview" title="Cash Flow Forecast"
        subtitle="Expected receipts and payments for the next 12 weeks, assuming each open invoice is settled on its due date."
        actions={<ExportExcelButton testId="export-cashflow" fileName={`Cash-Flow-Forecast-${today}.xlsx`} build={() => buildCashFlowWorkbook(f, today, settings.companyName)} />} />

      {!f.hasOpeningBalance && (
        <div className="mb-4"><Alert tone="info">
          Set your bank balance to see a realistic forecast. Until then the forecast starts from RM 0.{' '}
          {can(user?.role, 'invoice.approve') && <button type="button" className="font-semibold underline" onClick={() => setEditing(true)}>Set bank balance</button>}
        </Alert></div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard testId="cf-current" accent="navy" icon="bank" label="Bank balance today (est.)" value={formatMYR(f.currentBalance)}
          hint={settings.openingBalanceDate ? `${formatMYR(settings.openingBalance)} on ${formatDate(settings.openingBalanceDate)} ${f.movementSinceOpening >= 0 ? '+' : '−'} ${formatMYR(Math.abs(f.movementSinceOpening))} since` : 'Opening balance'} />
        <StatCard testId="cf-in" accent="ar" icon="in" label="Expected receipts · 12 weeks" value={formatMYR(f.totals.inflow)} hint={`incl. ${formatMYR(f.rows[0]!.inflow)} already overdue`} />
        <StatCard testId="cf-out" accent="ap" icon="out" label="Expected payments · 12 weeks" value={formatMYR(f.totals.outflow)} hint={`incl. ${formatMYR(f.rows[0]!.outflow)} already overdue`} />
        <StatCard testId="cf-end" accent={f.lowest.amount < 0 ? 'red' : 'green'} icon="trend" label="Projected balance in 12 weeks" value={formatMYR(end)}
          hint={f.lowest.amount < 0 ? `Shortfall: lowest ${formatMYR(f.lowest.amount)} (${f.lowest.label})` : `Lowest point ${formatMYR(f.lowest.amount)}`} />
      </div>
      {f.lowest.amount < 0 && (
        <div className="mt-4"><Alert tone="warning">
          The balance is projected to go below zero ({formatMYR(f.lowest.amount)}) in {f.lowest.label}. Consider chasing overdue receivables or rescheduling supplier payments.{' '}
          <Link to="/ar?status=Overdue" className="font-semibold underline">See overdue receivables</Link>
        </Alert></div>
      )}

      {editing && <OpeningBalanceForm onDone={() => setEditing(false)} />}

      <Card className="mt-6" title="Weekly outlook" action={can(user?.role, 'invoice.approve') && !editing ? <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>Adjust bank balance</Button> : undefined}>
        <div className="h-80" data-testid="cashflow-chart">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 8, right: 8, left: 4, bottom: 0 }} barGap={2}>
              <CartesianGrid vertical={false} stroke="#eef0f3" />
              <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: '#d5d9e0' }} tick={{ fontSize: 11, fill: '#64748b' }} interval="preserveStartEnd" />
              <YAxis tickFormatter={formatMYRCompact} tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: '#64748b' }} width={80} />
              <ReferenceLine y={0} stroke="#94a3b8" />
              <Tooltip formatter={(v, name) => [formatMYR(Math.abs(Number(v ?? 0))), String(name)]} cursor={{ fill: 'rgba(15,31,61,0.05)' }}
                contentStyle={{ borderRadius: 8, border: '1px solid #e2e8f0', fontSize: 12 }} />
              <Legend verticalAlign="top" align="right" iconType="circle" iconSize={8} height={28} wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="inflow" name="Expected receipts" fill={AR} radius={[4, 4, 0, 0]} maxBarSize={18} animationDuration={400} />
              <Bar dataKey="outflow" name="Expected payments" fill={AP} radius={[0, 0, 4, 4]} maxBarSize={18} animationDuration={400} />
              <Line dataKey="closing" name="Projected balance" stroke={BAL} strokeWidth={2} dot={{ r: 3, fill: BAL }} type="monotone" animationDuration={400} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <Card className="mt-6" title="Forecast by week" padded={false}>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm" data-testid="cashflow-table">
            <thead className="border-b border-slate-200 bg-slate-50/80 text-xs uppercase tracking-wide text-slate-500">
              <tr><th className="px-4 py-2.5 text-left">Period</th><th className="px-4 py-2.5 text-right">Receipts (AR)</th><th className="px-4 py-2.5 text-right">Payments (AP)</th><th className="px-4 py-2.5 text-right">Net</th><th className="px-4 py-2.5 text-right">Projected balance</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              <tr className="bg-navy-50/40"><td className="px-4 py-2.5 font-medium">Bank balance today</td><td /><td /><td /><td className="tabular px-4 py-2.5 text-right font-semibold">{formatMYR(f.currentBalance)}</td></tr>
              {f.rows.map((r) => (
                <tr key={r.key} className={r.key === 'overdue' ? 'bg-red-50/40' : ''}>
                  <td className="px-4 py-2.5">{r.label}{r.key === 'overdue' && <span className="block text-xs text-slate-500">Past due, expected as soon as possible</span>}</td>
                  <td className="tabular px-4 py-2.5 text-right whitespace-nowrap">{r.inflow ? formatMYR(r.inflow) : <span className="text-slate-300">—</span>}{r.inflowCount > 0 && <span className="block text-[11px] text-slate-400">{r.inflowCount} invoice{r.inflowCount === 1 ? '' : 's'}</span>}</td>
                  <td className="tabular px-4 py-2.5 text-right whitespace-nowrap">{r.outflow ? formatMYR(r.outflow) : <span className="text-slate-300">—</span>}{r.outflowCount > 0 && <span className="block text-[11px] text-slate-400">{r.outflowCount} bill{r.outflowCount === 1 ? '' : 's'}</span>}</td>
                  <td className={cx('tabular px-4 py-2.5 text-right whitespace-nowrap', r.net < 0 ? 'text-red-700' : 'text-slate-700')}>{formatMYR(r.net)}</td>
                  <td className={cx('tabular px-4 py-2.5 text-right font-semibold whitespace-nowrap', r.closing < 0 ? 'text-red-700' : 'text-slate-900')}>{formatMYR(r.closing)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {(f.later.inflow > 0 || f.later.outflow > 0) && (
          <p className="border-t border-slate-100 px-4 py-3 text-xs text-slate-500">Due after 12 weeks: {formatMYR(f.later.inflow)} to collect, {formatMYR(f.later.outflow)} to pay. Not shown above.</p>
        )}
      </Card>
    </>
  );
}

/** 設定期初銀行餘額（僅管理員）。 */
export function OpeningBalanceForm({ onDone }: { onDone?: () => void }) {
  const { settings, today } = { ...useSettings(), today: useInvoices().today };
  const save = useSettingsMutation();
  const toast = useToast();
  const [amount, setAmount] = useState(senToDecimalString(settings.openingBalance));
  const [date, setDate] = useState(settings.openingBalanceDate ?? today);
  const [error, setError] = useState('');
  const submit = async () => {
    const sen = toSen(amount);
    if (sen === null) { setError('Enter the bank balance, e.g. 125000.00 (use a minus sign if overdrawn)'); return; }
    if (!date || date > today) { setError('The date cannot be in the future'); return; }
    await save.mutateAsync({ openingBalance: sen, openingBalanceDate: date });
    toast('Bank balance saved');
    onDone?.();
  };
  return (
    <Card className="mt-4" title="Bank balance">
      <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate>
        <TextInput label="Balance in all company bank accounts (RM)" inputMode="decimal" value={amount} onChange={(e) => { setAmount(e.target.value); setError(''); }} containerClassName="min-w-[220px] flex-1" />
        <TextInput label="As of date" type="date" value={date} max={today} onChange={(e) => { setDate(e.target.value); setError(''); }} />
        <div className="flex gap-2">
          {onDone && <Button onClick={onDone}>Cancel</Button>}
          <Button variant="primary" type="submit" loading={save.isPending} data-testid="save-balance">Save</Button>
        </div>
      </form>
      <p className="mt-2 text-xs text-slate-500">Payments recorded after this date are added to or taken from this balance automatically.</p>
      {error && <div className="mt-3"><Alert>{error}</Alert></div>}
    </Card>
  );
}

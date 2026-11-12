/**
 * 每月趨勢圖（Monthly AP & AR trends）
 *
 * - 分組長條圖：每月 AR（藍）與 AP（橘）並排，單一 Y 軸。
 * - 可切換「開立金額」（依發票日期）與「現金收付」（依付款日期）。
 * - 滑鼠移入顯示該月明細；並提供表格檢視，方便無障礙閱讀與核對。
 */
import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatMonth } from '@/domain/dates';
import type { MonthlyTrendPoint } from '@/domain/dashboard';
import { formatMYR, formatMYRCompact } from '@/domain/money';
import { Card, cx } from '@/components/ui';

const AR_COLOR = '#2a78d6';
const AP_COLOR = '#eb6834';

type Mode = 'invoiced' | 'cash';

export function TrendChart({ data }: { data: MonthlyTrendPoint[] }) {
  const [mode, setMode] = useState<Mode>('invoiced');
  const [asTable, setAsTable] = useState(false);
  const rows = data.map((d) => ({
    month: formatMonth(d.month),
    AR: mode === 'invoiced' ? d.arInvoiced : d.arCollected,
    AP: mode === 'invoiced' ? d.apInvoiced : d.apPaid,
  }));
  const arLabel = mode === 'invoiced' ? 'AR invoiced' : 'AR collected';
  const apLabel = mode === 'invoiced' ? 'AP billed' : 'AP paid';

  const Segmented = (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex rounded-lg bg-slate-100 p-0.5 text-xs font-medium" role="tablist" aria-label="Trend measure">
        {([['invoiced', 'Invoiced'], ['cash', 'Paid / Collected']] as const).map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={mode === k} onClick={() => setMode(k)}
            className={cx('rounded-md px-2.5 py-1', mode === k ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800')}>
            {label}
          </button>
        ))}
      </div>
      <button type="button" onClick={() => setAsTable((v) => !v)} className="rounded-md px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-800">
        {asTable ? 'Show chart' : 'Show table'}
      </button>
    </div>
  );

  return (
    <Card title="Monthly AP & AR trends · last 12 months" action={Segmented}>
      {asTable ? (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm" data-testid="trend-table">
            <thead><tr className="text-left text-xs uppercase tracking-wide text-slate-500">
              <th className="py-2 pr-4">Month</th><th className="py-2 pr-4 text-right">{arLabel}</th><th className="py-2 text-right">{apLabel}</th>
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr key={r.month}><td className="py-1.5 pr-4 text-slate-600">{r.month}</td>
                  <td className="tabular py-1.5 pr-4 text-right">{formatMYR(r.AR)}</td><td className="tabular py-1.5 text-right">{formatMYR(r.AP)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="h-72" data-testid="trend-chart">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows} barGap={2} barCategoryGap="22%" margin={{ top: 8, right: 4, left: 4, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="#eef0f3" />
              <XAxis dataKey="month" tickLine={false} axisLine={{ stroke: '#d5d9e0' }} tick={{ fontSize: 12, fill: '#64748b' }} interval="preserveStartEnd" />
              <YAxis tickFormatter={formatMYRCompact} tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: '#64748b' }} width={78} />
              <Tooltip content={(props) => <TrendTooltip {...props} arLabel={arLabel} apLabel={apLabel} />} cursor={{ fill: 'rgba(15,31,61,0.05)' }} />
              <Legend verticalAlign="top" align="right" iconType="circle" iconSize={8} height={28}
                formatter={(value) => <span className="text-xs text-slate-600">{value === 'AR' ? arLabel : apLabel}</span>} />
              <Bar dataKey="AR" fill={AR_COLOR} radius={[4, 4, 0, 0]} maxBarSize={22} animationDuration={400} />
              <Bar dataKey="AP" fill={AP_COLOR} radius={[4, 4, 0, 0]} maxBarSize={22} animationDuration={400} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}

/** 提示框只需要這幾個屬性，自訂型別可避免與圖表函式庫的泛型綁死。 */
interface TrendTooltipProps {
  active?: boolean;
  payload?: readonly { dataKey?: unknown; value?: unknown }[];
  label?: unknown;
  arLabel: string;
  apLabel: string;
}

function TrendTooltip({ active, payload, label, arLabel, apLabel }: TrendTooltipProps) {
  if (!active || !payload?.length) return null;
  const ar = Number(payload.find((p) => p.dataKey === 'AR')?.value ?? 0);
  const ap = Number(payload.find((p) => p.dataKey === 'AP')?.value ?? 0);
  return (
    <div className="rounded-lg bg-white px-3 py-2 text-xs shadow-lg ring-1 ring-slate-200">
      <p className="mb-1 font-semibold text-slate-900">{String(label ?? '')}</p>
      <p className="flex items-center justify-between gap-6 text-slate-600"><span><span className="mr-1.5 inline-block size-2 rounded-full" style={{ background: AR_COLOR }} />{arLabel}</span><span className="tabular font-medium text-slate-900">{formatMYR(ar)}</span></p>
      <p className="flex items-center justify-between gap-6 text-slate-600"><span><span className="mr-1.5 inline-block size-2 rounded-full" style={{ background: AP_COLOR }} />{apLabel}</span><span className="tabular font-medium text-slate-900">{formatMYR(ap)}</span></p>
    </div>
  );
}

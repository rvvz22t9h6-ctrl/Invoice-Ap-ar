/**
 * 帳齡分析（Invoice aging）
 *
 * 依「未付餘額」與「逾期天數」將發票分組：
 *   Current  尚未逾期（到期日為今天或之後）
 *   1–30     逾期 1 至 30 天
 *   31–60    逾期 31 至 60 天
 *   61–90    逾期 61 至 90 天
 *   90+      逾期超過 90 天
 *
 * 只計入「未取消」且「未付餘額 > 0」的發票；金額以未付餘額計算（非發票總額）。
 */
import type { Sen } from './money';
import type { ComputedInvoice, InvoiceType } from './types';

export type AgingBucketKey = 'current' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90_plus';

export const AGING_BUCKETS: { key: AgingBucketKey; label: string }[] = [
  { key: 'current', label: 'Current' },
  { key: 'd1_30', label: '1–30 days' },
  { key: 'd31_60', label: '31–60 days' },
  { key: 'd61_90', label: '61–90 days' },
  { key: 'd90_plus', label: '90+ days' },
];

/** 依逾期天數決定帳齡區間。 */
export function agingBucket(daysOverdue: number): AgingBucketKey {
  if (daysOverdue <= 0) return 'current';
  if (daysOverdue <= 30) return 'd1_30';
  if (daysOverdue <= 60) return 'd31_60';
  if (daysOverdue <= 90) return 'd61_90';
  return 'd90_plus';
}

export interface AgingBucketTotal {
  amount: Sen;
  count: number;
}

export interface AgingRow {
  counterpartyId: string;
  counterpartyName: string;
  buckets: Record<AgingBucketKey, Sen>;
  total: Sen;
}

export interface AgingReport {
  type: InvoiceType;
  buckets: Record<AgingBucketKey, AgingBucketTotal>;
  total: AgingBucketTotal;
  /** 依往來對象（供應商／客戶）彙總，按總額由大到小排序。 */
  byCounterparty: AgingRow[];
  /** 納入計算的明細發票，逾期天數由多到少排序。 */
  invoices: ComputedInvoice[];
}

const emptyBuckets = <T>(make: () => T): Record<AgingBucketKey, T> => ({
  current: make(), d1_30: make(), d31_60: make(), d61_90: make(), d90_plus: make(),
});

/** 產生 AP 或 AR 的帳齡報表。 */
export function buildAgingReport(invoices: ComputedInvoice[], type: InvoiceType): AgingReport {
  const buckets = emptyBuckets<AgingBucketTotal>(() => ({ amount: 0, count: 0 }));
  const rows = new Map<string, AgingRow>();
  const included: ComputedInvoice[] = [];

  for (const inv of invoices) {
    if (inv.type !== type || inv.isCancelled || inv.outstandingBalance <= 0) continue;
    const key = agingBucket(inv.daysOverdue);
    buckets[key].amount += inv.outstandingBalance;
    buckets[key].count += 1;
    included.push(inv);

    let row = rows.get(inv.counterpartyId);
    if (!row) {
      row = { counterpartyId: inv.counterpartyId, counterpartyName: inv.counterpartyName, buckets: emptyBuckets(() => 0), total: 0 };
      rows.set(inv.counterpartyId, row);
    }
    row.buckets[key] += inv.outstandingBalance;
    row.total += inv.outstandingBalance;
  }

  const total = Object.values(buckets).reduce((t, b) => ({ amount: t.amount + b.amount, count: t.count + b.count }), { amount: 0, count: 0 });

  return {
    type,
    buckets,
    total,
    byCounterparty: [...rows.values()].sort((a, b) => b.total - a.total || a.counterpartyName.localeCompare(b.counterpartyName)),
    invoices: included.sort((a, b) => b.daysOverdue - a.daysOverdue || b.outstandingBalance - a.outstandingBalance),
  };
}

/**
 * 產生 Supabase 種子檔 supabase/seed.sql
 *
 * 執行：npm run seed:generate
 * 資料來源與示範模式相同（src/data/sampleData.ts），日期以 current_date ± 天數表示，
 * 因此無論何時匯入，都會出現逾期、即將到期、已付清等情境。
 */
import { writeFileSync } from 'node:fs';
import { buildSampleActivity, buildSampleInvoices, SAMPLE_COUNTERPARTIES } from '../src/data/sampleData';
import { formatMYR, senToDecimalString } from '../src/domain/money';

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const d = (offset: number) => `current_date + (${offset})`;

const invoices = buildSampleInvoices();
const lines: string[] = [];
lines.push('-- ============================================================================');
lines.push('-- 範例資料（由 scripts/generate-seed.ts 自動產生，請勿手動修改）');
lines.push('-- 公司名稱皆為虛構。日期相對於匯入當天（current_date）。');
lines.push('-- ============================================================================');
lines.push('begin;', '');

lines.push('insert into public.counterparties (id, kind, name) values');
lines.push(SAMPLE_COUNTERPARTIES.map((c) => `  (${q(c.id)}, ${q(c.kind)}, ${q(c.name)})`).join(',\n') + ';', '');

lines.push('insert into public.invoices (id, invoice_type, invoice_number, counterparty_id, invoice_date, due_date, description, invoice_amount, tax_amount, approval_status, is_cancelled, cancel_reason, created_at) values');
lines.push(invoices.map((i) => `  (${q(i.id)}, ${q(i.type)}, ${q(i.invoiceNumber)}, ${q(i.counterpartyId)}, ${d(i.invoiceDayOffset)}, ${d(i.dueDayOffset)}, ${q(i.description)}, ${senToDecimalString(i.invoiceAmount)}, ${senToDecimalString(i.taxAmount)}, ${i.approvalStatus ? q(i.approvalStatus) : 'null'}, ${i.isCancelled}, ${q(i.cancelReason)}, (${d(i.invoiceDayOffset)})::timestamptz + interval '9 hours')`).join(',\n') + ';', '');

const payments = invoices.flatMap((i) => i.payments.map((p) => ({ ...p, invoiceId: i.id })));
lines.push('insert into public.payments (id, invoice_id, payment_date, amount, method, reference, created_at) values');
lines.push(payments.map((p) => `  (${q(p.id)}, ${q(p.invoiceId)}, ${d(p.dayOffset)}, ${senToDecimalString(p.amount)}, ${q(p.method)}, ${q(p.reference)}, (${d(p.dayOffset)})::timestamptz + interval '11 hours')`).join(',\n') + ';', '');

// 觸發器在匯入時產生的紀錄時間都是「現在」，改以較真實的歷史活動取代
lines.push('-- 以真實時間順序的歷史活動取代匯入時自動產生的紀錄');
lines.push('delete from public.activity_log;');
const activity = buildSampleActivity(invoices, formatMYR);
lines.push('insert into public.activity_log (invoice_id, action, summary, actor_name, created_at) values');
lines.push(activity.map((a) => `  (${q(a.invoiceId)}, ${q(a.action)}, ${q(a.summary)}, ${q(a.actorName)}, (${d(a.dayOffset)})::timestamptz + interval '${a.minuteOfDay} minutes')`).join(',\n') + ';', '');

lines.push('commit;');
writeFileSync(new URL('../supabase/seed.sql', import.meta.url), `${lines.join('\n')}\n`);
console.log(`seed.sql: ${SAMPLE_COUNTERPARTIES.length} counterparties, ${invoices.length} invoices, ${payments.length} payments, ${activity.length} activity rows`);

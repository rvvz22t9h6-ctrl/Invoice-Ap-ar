/**
 * 資料庫整合測試（Database integration tests）
 *
 * 在真實 PostgreSQL 上建立一個全新的測試資料庫，依序執行：
 *   1. 模擬 Supabase auth schema（supabase/tests/supabase_auth_stub.sql）
 *   2. 所有 migrations
 *   3. seed.sql 範例資料
 * 然後以不同角色（admin / finance / viewer / anon）驗證業務規則與 RLS 權限。
 *
 * 執行：DATABASE_URL=postgres://postgres@localhost:55432/postgres npm run test:db
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';

const adminUrl = process.env.DATABASE_URL ?? 'postgres://postgres@localhost:55432/postgres';
const DB = 'invoice_ap_ar_test';
const root = new URL('../supabase/', import.meta.url);
let client;

const USERS = {
  admin: '11111111-1111-4111-8111-111111111111',
  finance: '22222222-2222-4222-8222-222222222222',
  viewer: '33333333-3333-4333-8333-333333333333',
};

/** 以指定使用者身分（模擬 Supabase JWT）執行查詢；每次都在交易中並自動回滾。 */
async function as(who, sql, params = []) {
  await client.query('begin');
  try {
    if (who === 'anon') {
      await client.query('set local role anon');
    } else {
      await client.query('set local role authenticated');
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: USERS[who], role: 'authenticated' })]);
    }
    const res = await client.query(sql, params);
    await client.query('rollback');
    return res;
  } catch (e) {
    await client.query('rollback');
    throw e;
  }
}

/** 同上，但會提交（用於需要累積狀態的測試）。 */
async function asCommit(who, sql, params = []) {
  await client.query('begin');
  try {
    await client.query('set local role authenticated');
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: USERS[who] })]);
    const res = await client.query(sql, params);
    await client.query('commit');
    return res;
  } catch (e) {
    await client.query('rollback');
    throw e;
  }
}

before(async () => {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`drop database if exists ${DB} with (force)`);
  await admin.query(`create database ${DB}`);
  await admin.end();

  const url = new URL(adminUrl);
  url.pathname = `/${DB}`;
  client = new pg.Client({ connectionString: url.toString() });
  await client.connect();

  await client.query(readFileSync(new URL('tests/supabase_auth_stub.sql', root), 'utf8'));
  for (const f of readdirSync(new URL('migrations/', root)).filter((f) => f.endsWith('.sql')).sort()) {
    await client.query(readFileSync(new URL(`migrations/${f}`, root), 'utf8'));
  }
  await client.query(readFileSync(new URL('seed.sql', root), 'utf8'));

  // 建立三個測試使用者（觸發器會自動建立 viewer profile），再設定角色
  for (const [role, id] of Object.entries(USERS)) {
    await client.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`,
      [id, `${role}@example.com`, { full_name: `Test ${role}` }]);
    await client.query(`update public.profiles set role = $2 where id = $1`, [id, role]);
  }
});

after(async () => { await client?.end(); });

const CUSTOMER = '00000000-0000-4000-8002-000000000001';
const SUPPLIER = '00000000-0000-4000-8001-000000000001';
const SUPPLIER2 = '00000000-0000-4000-8001-000000000002';

const insertAR = (num, amount = '1000.00', tax = '80.00') =>
  `insert into public.invoices (invoice_type, invoice_number, counterparty_id, invoice_date, due_date, invoice_amount, tax_amount)
   values ('AR', '${num}', '${CUSTOMER}', current_date - 40, current_date - 10, ${amount}, ${tax}) returning *`;

test('seed data loaded and consistent', async () => {
  const { rows: [r] } = await client.query(`select
    (select count(*) from invoices)::int as invoices, (select count(*) from payments)::int as payments,
    (select count(*) from activity_log)::int as activity,
    (select count(*) from invoice_balances where amount_paid > total_amount)::int as overpaid`);
  assert.ok(r.invoices > 100);
  assert.ok(r.payments > 80);
  assert.equal(r.activity, 40);
  assert.equal(r.overpaid, 0);
});

test('total_amount is generated and balances view calculates outstanding', async () => {
  const { rows: [inv] } = await as('finance', `with i as (${insertAR('T-GEN-1', '1234.50', '98.76')})
    select i.total_amount from i`);
  assert.equal(inv.total_amount, '1333.26');
  const { rows: [b] } = await client.query(`select total_amount, amount_paid, outstanding_balance from invoice_balances
    where id = (select invoice_id from payments group by invoice_id having count(*) = 1 limit 1)`);
  assert.equal(Number(b.outstanding_balance), Math.max(Number(b.total_amount) - Number(b.amount_paid), 0));
});

test('duplicate AR invoice numbers are rejected (case-insensitive, trimmed)', async () => {
  await asCommit('finance', insertAR('DUP-100'));
  await assert.rejects(as('finance', insertAR(' dup-100 ')), /invoices_ar_number_uq/);
});

test('AP invoice numbers are unique per supplier only', async () => {
  const ap = (num, sup) => `insert into public.invoices (invoice_type, invoice_number, counterparty_id, invoice_date, due_date, invoice_amount)
    values ('AP', '${num}', '${sup}', current_date, current_date + 30, 500) returning *`;
  await asCommit('finance', ap('SAME-1', SUPPLIER));
  await asCommit('finance', ap('SAME-1', SUPPLIER2)); // 不同供應商可相同
  await assert.rejects(as('finance', ap('same-1', SUPPLIER)), /invoices_ap_number_uq/);
});

test('AP invoice must link to a supplier, AR to a customer', async () => {
  await assert.rejects(as('finance', `insert into public.invoices (invoice_type, invoice_number, counterparty_id, invoice_date, due_date, invoice_amount)
    values ('AP', 'X-1', '${CUSTOMER}', current_date, current_date, 1)`), /invoices_counterparty_fk/);
});

test('due date before invoice date and non-positive amounts are rejected', async () => {
  await assert.rejects(as('finance', `insert into public.invoices (invoice_type, invoice_number, counterparty_id, invoice_date, due_date, invoice_amount)
    values ('AR', 'X-2', '${CUSTOMER}', current_date, current_date - 1, 100)`), /invoices_due_after_invoice/);
  await assert.rejects(as('finance', insertAR('X-3', '0')), /invoice_amount_check/);
});

test('overpayment is blocked; exact settlement allowed', async () => {
  const { rows: [inv] } = await asCommit('finance', insertAR('PAY-1'));
  await asCommit('finance', `insert into payments (invoice_id, payment_date, amount, method) values ($1, current_date, 500, 'FPX')`, [inv.id]);
  await assert.rejects(
    as('finance', `insert into payments (invoice_id, payment_date, amount, method) values ($1, current_date, 580.01, 'FPX')`, [inv.id]),
    /exceeds the outstanding balance of RM 580.00/);
  await asCommit('finance', `insert into payments (invoice_id, payment_date, amount, method) values ($1, current_date, 580, 'FPX')`, [inv.id]);
  const { rows: [b] } = await client.query(`select outstanding_balance from invoice_balances where id = $1`, [inv.id]);
  assert.equal(b.outstanding_balance, '0.00');
  // 總額不可改到低於已付金額；有付款不可取消
  await assert.rejects(as('finance', `update invoices set invoice_amount = 900 where id = $1`, [inv.id]), /cannot be less than/);
  await assert.rejects(as('finance', `update invoices set is_cancelled = true where id = $1`, [inv.id]), /Reverse the payments/);
  // 付款紀錄不可修改
  await assert.rejects(as('admin', `update payments set amount = 1 where invoice_id = $1`, [inv.id]), /cannot be edited|permission denied/); // 權限與觸發器雙重保護
});

test('AP approval: new bills start pending, only admin approves, payment requires approval', async () => {
  const { rows: [bill] } = await asCommit('finance', `insert into invoices (invoice_type, invoice_number, counterparty_id, invoice_date, due_date, invoice_amount, approval_status)
    values ('AP', 'APR-1', '${SUPPLIER}', current_date, current_date + 30, 1000, 'approved') returning *`);
  assert.equal(bill.approval_status, 'pending'); // 即使送出 approved，也會被改回 pending
  await assert.rejects(as('finance', `insert into payments (invoice_id, payment_date, amount, method) values ($1, current_date, 10, 'FPX')`, [bill.id]), /must be approved/);
  await assert.rejects(as('finance', `update invoices set approval_status = 'approved' where id = $1`, [bill.id]), /Only an admin/);
  const { rows: [ok] } = await asCommit('admin', `update invoices set approval_status = 'approved' where id = $1 returning approved_by`, [bill.id]);
  assert.equal(ok.approved_by, USERS.admin);
  await asCommit('finance', `insert into payments (invoice_id, payment_date, amount, method) values ($1, current_date, 10, 'FPX')`, [bill.id]);
  await assert.rejects(as('admin', `update invoices set approval_status = 'rejected' where id = $1`, [bill.id]), /already has payments/);
});

test('cancelling an unpaid invoice works and is logged', async () => {
  const { rows: [inv] } = await asCommit('finance', insertAR('CAN-1'));
  await asCommit('finance', `update invoices set is_cancelled = true, cancel_reason = 'Wrong customer' where id = $1`, [inv.id]);
  const { rows } = await client.query(`select action, summary, actor_name from activity_log where invoice_id = $1 order by id`, [inv.id]);
  assert.deepEqual(rows.map((r) => r.action), ['invoice.created', 'invoice.cancelled']);
  assert.equal(rows[0].actor_name, 'Test finance');
  assert.match(rows[0].summary, /^Created AR invoice CAN-1 · Gemilang Retail Holdings Bhd · RM 1,080.00$/);
  await assert.rejects(as('finance', `insert into payments (invoice_id, payment_date, amount, method) values ($1, current_date, 1, 'FPX')`, [inv.id]), /cancelled invoice/);
});

test('RLS: viewer can read but not write', async () => {
  const { rows: [c] } = await as('viewer', `select count(*)::int as n from invoices`);
  assert.ok(c.n > 100);
  const ins = await as('viewer', `select 1`).then(() => as('viewer', insertAR('V-1'))).then(() => 'inserted', (e) => e.message);
  assert.match(ins, /row-level security/);
  const upd = await as('viewer', `update invoices set description = 'x' returning id`);
  assert.equal(upd.rowCount, 0); // RLS 讓 viewer 看不到可更新的列
  const del = await as('viewer', `delete from payments returning id`);
  assert.equal(del.rowCount, 0);
});

test('RLS: finance cannot delete or reverse; admin can reverse a payment', async () => {
  assert.equal((await as('finance', `delete from payments returning id`)).rowCount, 0);
  assert.equal((await as('finance', `delete from invoices where is_cancelled returning id`)).rowCount, 0);
  const res = await as('admin', `delete from payments where id = (select id from payments limit 1) returning id`);
  assert.equal(res.rowCount, 1);
});

test('RLS: anonymous users get nothing; viewers cannot promote themselves', async () => {
  await assert.rejects(as('anon', `select * from invoices`), /permission denied/);
  await assert.rejects(as('viewer', `update profiles set role = 'admin' where id = '${USERS.viewer}'`), /Only an admin/);
  const { rows } = await as('viewer', `select id from profiles`);
  assert.equal(rows.length, 1); // 只看得到自己
  assert.equal((await as('admin', `select id from profiles`)).rows.length, 3);
});

test('activity_log cannot be written directly', async () => {
  await assert.rejects(as('admin', `insert into activity_log (action, summary) values ('x', 'fake')`), /permission denied|row-level security/);
});

test('credit notes and write-offs: rules and audit log', async () => {
  const { rows: [bill] } = await asCommit('finance', `insert into invoices (invoice_type, invoice_number, counterparty_id, invoice_date, due_date, invoice_amount)
    values ('AP', 'CN-1', '${SUPPLIER}', current_date, current_date + 30, 1000) returning *`);
  // 折讓單不需要審批；呆帳沖銷只限 AR
  await asCommit('finance', `insert into payments (invoice_id, kind, payment_date, amount, method) values ($1, 'credit_note', current_date, 100, 'Credit note')`, [bill.id]);
  await assert.rejects(as('finance', `insert into payments (invoice_id, kind, payment_date, amount, method) values ($1, 'write_off', current_date, 10, 'Write-off')`, [bill.id]), /Only customer invoices/);
  await assert.rejects(as('finance', `insert into payments (invoice_id, kind, payment_date, amount, method) values ($1, 'payment', current_date, 10, 'FPX')`, [bill.id]), /must be approved/);
  await assert.rejects(as('finance', `insert into payments (invoice_id, kind, payment_date, amount, method) values ($1, 'bogus', current_date, 10, 'FPX')`, [bill.id]), /payments_kind_check/);
  const { rows: [ar] } = await asCommit('finance', insertAR('WO-1'));
  await asCommit('finance', `insert into payments (invoice_id, kind, payment_date, amount, method) values ($1, 'write_off', current_date, 1080, 'Write-off')`, [ar.id]);
  const { rows: [b] } = await client.query(`select outstanding_balance from invoice_balances where id = $1`, [ar.id]);
  assert.equal(b.outstanding_balance, '0.00');
  const { rows: log } = await client.query(`select summary from activity_log where invoice_id = $1 order by id desc limit 1`, [ar.id]);
  assert.match(log[0].summary, /^Wrote off RM 1,080.00 on AR invoice WO-1/);
});

test('company settings: everyone reads, only admin updates', async () => {
  const { rows: [s0] } = await as('viewer', `select company_name, default_terms_ar from app_settings`);
  assert.equal(s0.default_terms_ar, 30);
  assert.equal((await as('finance', `update app_settings set company_name = 'X' returning id`)).rowCount, 0);
  const { rows: [s1] } = await as('admin', `update app_settings set company_name = 'Sample Trading', opening_balance = 50000 returning company_name`);
  assert.equal(s1.company_name, 'Sample Trading');
  await assert.rejects(as('admin', `insert into app_settings (id) values (2)`), /app_settings_id_check|permission denied|row-level/);
});

test('contact details can be updated by finance', async () => {
  const { rows: [c] } = await as('finance', `update counterparties set contact_person = 'Ms Tan', payment_terms_days = 45 where id = '${CUSTOMER}' returning contact_person, payment_terms_days`);
  assert.deepEqual(c, { contact_person: 'Ms Tan', payment_terms_days: 45 });
  await assert.rejects(as('finance', `update counterparties set payment_terms_days = 999 where id = '${CUSTOMER}'`), /payment_terms_days_check/);
});

test('tasks: recurring occurrences cannot be duplicated; completion date uses Malaysia time', async () => {
  const { rows: [rule] } = await asCommit('finance', `insert into task_recurrences (title, category, priority, frequency, day_of_month, start_date)
    values ('Pay EPF', 'Payroll', 'Urgent', 'monthly', 15, current_date) returning id`);
  const ins = (id) => `insert into tasks (id, title, category, priority, due_date, recurrence_id, occurrence_date)
    values ('${id}', 'Pay EPF', 'Payroll', 'Urgent', '2026-12-15', '${rule.id}', '2026-12-15')`;
  await asCommit('finance', ins(`rec-${rule.id}-2026-12-15`));
  // 同一 ID：ON CONFLICT DO NOTHING 略過
  const again = await as('finance', `${ins(`rec-${rule.id}-2026-12-15`)} on conflict (id) do nothing returning id`);
  assert.equal(again.rowCount, 0);
  // 不同 ID、同一規則與日期：唯一索引拒絕
  await assert.rejects(as('finance', ins('some-other-id')), /tasks_recurrence_occurrence_uq/);

  // 完成：馬來西亞時間 2026-11-12 01:30 = UTC 2026-11-11 17:30
  const { rows: [done] } = await as('finance', `update tasks set status = 'done', completed_at = '2026-11-11T17:30:00Z' where id = 'rec-${rule.id}-2026-12-15' returning completed_on::text`);
  assert.equal(done.completed_on, '2026-11-12');
  const { rows: [reopen] } = await as('finance', `update tasks set status = 'todo' where id = 'rec-${rule.id}-2026-12-15' returning completed_at, completed_on`);
  assert.deepEqual(reopen, { completed_at: null, completed_on: null });
});

test('tasks: viewer read-only; invalid values rejected', async () => {
  assert.ok((await as('viewer', `select count(*) from tasks`)).rows.length);
  await assert.rejects(as('viewer', `insert into tasks (id, title, category, priority, due_date) values ('v1', 'x', 'AP', 'Low', current_date)`), /row-level security/);
  await assert.rejects(as('finance', `insert into tasks (id, title, category, priority, due_date) values ('bad', 'x', 'Sales', 'Low', current_date)`), /tasks_category_check/);
  await assert.rejects(as('finance', `insert into tasks (id, title, category, priority, due_date, start_date) values ('bad2', 'x', 'AP', 'Low', current_date, current_date + 1)`), /tasks_start_before_due/);
});

test('checklists: one per kind and month; invoice remarks', async () => {
  await asCommit('finance', `insert into checklists (id, kind, month, due_date) values ('payroll-2026-11', 'payroll', '2026-11', '2026-11-25')`);
  await assert.rejects(as('finance', `insert into checklists (id, kind, month, due_date) values ('payroll-2026-11', 'payroll', '2026-11', '2026-11-25')`), /checklists_pkey/);
  await assert.rejects(as('finance', `insert into checklists (id, kind, month, due_date) values ('x', 'payroll', '2026-12', '2026-12-25')`), /checklists_id_matches/);
  await assert.rejects(as('viewer', `insert into checklists (id, kind, month, due_date) values ('closing-2026-11', 'closing', '2026-11', '2026-12-07')`), /row-level security/);
  const { rows: [inv] } = await asCommit('finance', insertAR('REM-1'));
  const { rows: [r] } = await as('finance', `update invoices set remarks = 'Promised Friday' where id = $1 returning remarks`, [inv.id]);
  assert.equal(r.remarks, 'Promised Friday');
});

test('staff claims: status rules, mileage, unique numbers and row-level security', async () => {
  const ins = (id, no, extra = '') => `insert into staff_claims (id, claim_no, staff_name, expense_date, category, description, amount_sen${extra ? ', ' + extra.split('=')[0] : ''})
    values ('${id}', '${no}', 'Ali', current_date, 'Petrol', 'Fuel', 5000${extra ? ', ' + extra.split('=')[1] : ''})`;
  await asCommit('finance', ins('c1', 'CL-2611-001'));
  await assert.rejects(as('finance', ins('c2', 'CL-2611-001')), /staff_claims_claim_no_key/);
  await assert.rejects(as('finance', ins('c3', 'BAD-1')), /staff_claims_claim_no_check/);
  await assert.rejects(as('finance', `update staff_claims set status = 'paid' where id = 'c1'`), /staff_claims_paid_details/);
  await assert.rejects(as('finance', `update staff_claims set status = 'rejected' where id = 'c1'`), /staff_claims_reject_reason/);
  const { rows: [p] } = await as('finance', `update staff_claims set status = 'paid', paid_date = current_date, pay_method = 'With salary' where id = 'c1' returning status, submitted_on`);
  assert.equal(p.status, 'paid');
  assert.ok(p.submitted_on);
  await assert.rejects(as('finance', `insert into staff_claims (id, claim_no, staff_name, expense_date, category, description, amount_sen) values ('m1', 'CL-2611-002', 'Ali', current_date, 'Mileage', 'Trip', 2400)`), /staff_claims_mileage/);
  await as('finance', `insert into staff_claims (id, claim_no, staff_name, expense_date, category, description, amount_sen, mileage_km, rate_per_km_sen) values ('m2', 'CL-2611-003', 'Ali', current_date, 'Mileage', 'Trip', 2400, 40, 60)`);
  await assert.rejects(as('finance', ins('c4', 'CL-2611-004').replace('5000', '0')), /staff_claims_amount_sen_check/);
  await assert.rejects(as('viewer', ins('c5', 'CL-2611-005')), /row-level security/);
  const { rows } = await as('viewer', `select id from staff_claims`);
  assert.deepEqual(rows.map((r) => r.id), ['c1']);
});

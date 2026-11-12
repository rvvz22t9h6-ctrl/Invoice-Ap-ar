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

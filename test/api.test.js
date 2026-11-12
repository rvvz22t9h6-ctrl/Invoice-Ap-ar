'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp, openDatabase, hashPassword } = require('../server');

async function setup() {
  const db = openDatabase(':memory:');
  db.prepare("INSERT INTO users (username, name, role, password_hash) VALUES ('admin','Admin','admin',?)").run(hashPassword('adminpass1'));
  db.prepare("INSERT INTO users (username, name, role, password_hash) VALUES ('boss','Boss','viewer',?)").run(hashPassword('bosspass12'));
  const server = http.createServer(createApp(db, { today: () => '2026-11-12' }));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async (username, password) => {
    const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    assert.equal(res.status, 200);
    const cookie = res.headers.get('set-cookie').split(';')[0];
    return async (method, path, body) => {
      const r = await fetch(base + path, { method, headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, data: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text() };
    };
  };
  return { server, base, login };
}

test('AR/AP tracking, statuses, summary and viewer permissions', async (t) => {
  const { server, base, login } = await setup();
  t.after(() => server.close());

  const anon = await fetch(`${base}/api/summary`);
  assert.equal(anon.status, 401);

  const admin = await login('admin', 'adminpass1');
  const boss = await login('boss', 'bosspass12');

  const a1 = await admin('POST', '/api/invoices', { type: 'AR', invoice_no: 'INV-1', party: 'Acme', issue_date: '2026-09-01', due_date: '2026-10-01', amount: '1,000.50' });
  assert.equal(a1.status, 200);
  assert.equal(a1.data.status, 'Overdue');
  assert.equal(a1.data.days_overdue, 42);

  const a2 = await admin('POST', '/api/invoices', { type: 'AR', invoice_no: 'INV-2', party: 'Beta', issue_date: '2026-11-01', due_date: '2026-11-15', amount: 200 });
  assert.equal(a2.data.status, 'Open');
  const p1 = await admin('POST', `/api/invoices/${a2.data.id}/payments`, { paid_date: '2026-11-05', amount: 50 });
  assert.equal(p1.data.status, 'Partially paid');
  assert.equal(p1.data.balance, 150);

  const over = await admin('POST', `/api/invoices/${a2.data.id}/payments`, { paid_date: '2026-11-05', amount: 151 });
  assert.equal(over.status, 400);

  const b1 = await admin('POST', '/api/invoices', { type: 'AP', invoice_no: 'B-9', party: 'Supplier X', issue_date: '2026-11-01', due_date: '2026-11-30', amount: 300 });
  const paid = await admin('POST', `/api/invoices/${b1.data.id}/payments`, { paid_date: '2026-11-10', amount: 300 });
  assert.equal(paid.data.status, 'Paid');

  const dup = await admin('POST', '/api/invoices', { type: 'AR', invoice_no: 'INV-1', party: 'Acme', issue_date: '2026-09-01', due_date: '2026-10-01', amount: 1 });
  assert.equal(dup.status, 409);

  const s = await boss('GET', '/api/summary');
  assert.equal(s.status, 200);
  assert.equal(s.data.AR.outstanding, 1150.5);
  assert.equal(s.data.AR.overdue, 1000.5);
  assert.equal(s.data.AR.aging.d31_60, 1000.5);
  assert.equal(s.data.AR.due_7_days, 150);
  assert.equal(s.data.AR.paid_this_month, 50);
  assert.equal(s.data.AP.outstanding, 0);
  assert.equal(s.data.AP.paid_this_month, 300);
  assert.equal(s.data.net_position, 1150.5);
  assert.ok(s.data.recent_activity.length >= 4);

  // Boss is read-only
  assert.equal((await boss('POST', '/api/invoices', { type: 'AR', invoice_no: 'X', party: 'Y', issue_date: '2026-11-01', due_date: '2026-11-02', amount: 1 })).status, 403);
  assert.equal((await boss('PUT', `/api/invoices/${a1.data.id}`, { amount: 1 })).status, 403);
  assert.equal((await boss('GET', '/api/users')).status, 403);
  const csv = await boss('GET', '/api/export.csv?type=AR');
  assert.equal(csv.status, 200);
  assert.match(csv.data, /INV-1,Acme/);

  // Void removes from outstanding
  await admin('PUT', `/api/invoices/${a1.data.id}`, { voided: true });
  const s2 = await boss('GET', '/api/summary');
  assert.equal(s2.data.AR.outstanding, 150);

  // Import
  const imp = await admin('POST', '/api/invoices/import', { invoices: [
    { type: 'AP', invoice_no: 'IMP-1', party: 'Z', issue_date: '2026-10-01', due_date: '2026-10-31', amount: '500', paid: '100', paid_date: '2026-10-20' },
    { type: 'AP', invoice_no: 'IMP-2', party: 'Z', issue_date: 'bad', due_date: '2026-10-31', amount: '5' },
  ] });
  assert.equal(imp.data.created, 1);
  assert.equal(imp.data.errors.length, 1);
  const s3 = await boss('GET', '/api/summary');
  assert.equal(s3.data.AP.overdue, 400);
});

test('rejects non-JSON writes (CSRF) and protects last admin', async (t) => {
  const { server, base, login } = await setup();
  t.after(() => server.close());
  const form = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=admin&password=adminpass1' });
  assert.equal(form.status, 415);
  const admin = await login('admin', 'adminpass1');
  const { data } = await admin('GET', '/api/users');
  const me = data.users.find((u) => u.username === 'admin');
  assert.equal((await admin('PUT', `/api/users/${me.id}`, { role: 'viewer' })).status, 400);
});

/**
 * 雲端模式測試：以記憶體模擬平台 db，驗證寫入、重新載入、分割與權限。
 */
import { describe, expect, it } from 'vitest';
import { invoiceFormSchema, paymentFormSchema } from '@/domain/validation';
import { todayIso } from '@/domain/dates';
import { HostedRepository, shardInvoices, type HostedDb, type HostedUser } from './hostedRepository';
import { buildInitialDemoState } from './demoRepository';
import { newChecklist } from '@/domain/checklists';

/** 模擬 db：文件存在 Map 中，並記錄寫入次數。 */
function fakeDb() {
  const docs = new Map<string, Record<string, unknown>>();
  const stats = { sets: 0, deletes: 0 };
  const snap = (path: string) => ({ id: path.split('/').pop()!, exists: docs.has(path), data: () => (docs.has(path) ? structuredClone(docs.get(path)) : undefined) });
  const db: HostedDb = {
    doc: (path) => ({
      get: async () => snap(path),
      set: async (d) => { stats.sets += 1; docs.set(path, structuredClone(d)); },
      delete: async () => { stats.deletes += 1; docs.delete(path); },
    }),
    collection: (path) => ({
      doc: (id) => db.doc(`${path}/${id}`),
      limit: () => ({ get: async () => ({ docs: [...docs.keys()].filter((k) => k.startsWith(`${path}/`) && k.split('/').length === 2).sort().map(snap) }) }),
    }),
  };
  return { db, docs, stats };
}
const owner: HostedUser = { canEdit: async () => true, me: async () => ({ name: 'Carrie', id: 'u1' }) };
const viewer: HostedUser = { canEdit: async () => false, me: async () => ({ name: '', id: 'u2' }) };
const today = todayIso();
const form = (n: string, amount = '1000') => invoiceFormSchema.parse({ invoiceNumber: n, counterpartyName: 'Cloud Customer Sdn Bhd', invoiceDate: today, dueDate: today, description: '', invoiceAmount: amount, taxAmount: '0' });

describe('HostedRepository', () => {
  it('starts empty, signs the owner in as admin, and persists changes across reloads', async () => {
    const { db, docs } = fakeDb();
    const repo = await HostedRepository.create(db, owner);
    expect(await repo.currentUser()).toMatchObject({ role: 'admin', fullName: 'Carrie' });
    expect(await repo.listInvoices()).toHaveLength(0);
    const inv = await repo.createInvoice('AR', form('C-1'));
    await repo.recordPayment(inv.id, paymentFormSchema(today).parse({ paymentDate: today, amount: '250', method: 'FPX' }));
    await repo.whenSaved();
    expect([...docs.keys()].sort()).toEqual([`invoices/${today.slice(0, 7)}`, 'meta/activity', 'meta/counterparties', 'meta/info']);

    const reopened = await HostedRepository.create(db, owner); // 重新開啟頁面
    const [back] = await reopened.listInvoices();
    expect(back).toMatchObject({ invoiceNumber: 'C-1', counterpartyName: 'Cloud Customer Sdn Bhd' });
    expect(back!.payments[0]!.amount).toBe(25_000);
    expect((await reopened.listActivity()).map((a) => a.action)).toEqual(['payment.recorded', 'invoice.created']);
  });

  it('writes only the documents that changed', async () => {
    const { db, stats } = fakeDb();
    const repo = await HostedRepository.create(db, owner);
    await repo.resetDemoData();
    await repo.whenSaved();
    const afterSeed = stats.sets;
    expect(afterSeed).toBeGreaterThan(5);
    expect(afterSeed).toBeLessThan(30); // 約 12 個發票月份 + 3 個任務月份 + 5 個 meta，而不是上百次
    const unpaid = (await repo.listInvoices()).find((i) => !i.isCancelled && i.payments.length === 0)!;
    await repo.cancelInvoice(unpaid.id, 'Raised in error');
    await repo.whenSaved();
    expect(stats.sets - afterSeed).toBeLessThanOrEqual(3); // 一個月份 + activity + info
  });

  it('clearing data deletes the invoice documents', async () => {
    const { db, docs } = fakeDb();
    const repo = await HostedRepository.create(db, owner);
    await repo.resetDemoData();
    await repo.whenSaved();
    await repo.clearAllData();
    await repo.whenSaved();
    expect([...docs.keys()].filter((k) => k.startsWith('invoices/'))).toHaveLength(0);
    expect((await HostedRepository.create(db, owner)).dataStatus().invoiceCount).toBe(0);
  });

  it('a shared viewer is read-only', async () => {
    const { db } = fakeDb();
    const repo = await HostedRepository.create(db, viewer);
    expect((await repo.currentUser())?.role).toBe('viewer');
    await expect(repo.createInvoice('AR', form('V-1'))).rejects.toThrow(/read-only/);
  });

  it('reports a save error and recovers on retry', async () => {
    const { db } = fakeDb();
    let fail = true;
    const flaky: HostedDb = { ...db, doc: (p) => ({ ...db.doc(p), set: async (d) => { if (fail) throw { code: 'invalid_argument' }; return db.doc(p).set(d); } }) };
    const repo = await HostedRepository.create(flaky, owner);
    const seen: string[] = [];
    repo.onSaveStatus((s) => seen.push(s.state));
    await repo.createInvoice('AR', form('E-1'));
    await repo.whenSaved();
    expect(seen.at(-1)).toBe('error');
    fail = false;
    repo.retrySave();
    await repo.whenSaved();
    expect(seen.at(-1)).toBe('saved');
  });
});

describe('HostedRepository tasks', () => {
  it('stores tasks by due month and recurring rules, and reloads them', async () => {
    const { db, docs } = fakeDb();
    const repo = await HostedRepository.create(db, owner);
    await repo.saveRecurrence({ title: 'Bank rec', description: '', category: 'Banking', priority: 'High', remarks: '', frequency: 'monthly', interval: 1,
      customUnit: 'month', weekdays: [], dayOfMonth: 5, month: 1, weekendAdjust: 'none', leadDays: 0, startDate: today, endDate: null, active: true });
    await repo.saveTask({ title: 'One-off', category: 'GL', priority: 'Low', dueDate: today });
    await repo.whenSaved();
    expect([...docs.keys()].some((k) => k.startsWith('tasks/'))).toBe(true);
    expect(docs.has('meta/recurrences')).toBe(true);
    const again = await HostedRepository.create(db, owner);
    const tasks = await again.listTasks();
    expect(tasks.some((t) => t.title === 'One-off')).toBe(true);
    expect(tasks.filter((t) => t.recurrenceId).length).toBeGreaterThan(0);
    expect(await again.generateTasks()).toBe(0); // 重新開啟不重複產生
  });
});

describe('HostedRepository checklists', () => {
  it('stores checklists per month and reloads them', async () => {
    const { db, docs } = fakeDb();
    const repo = await HostedRepository.create(db, owner);
    await repo.saveChecklist(newChecklist('closing', '2026-10', '2026-11-12T00:00:00Z'));
    await repo.whenSaved();
    expect(docs.has('checklists/2026-10')).toBe(true);
    expect((await (await HostedRepository.create(db, owner)).listChecklists())[0]!.id).toBe('closing-2026-10');
  });
});

describe('shardInvoices', () => {
  it('groups by month and splits large months under the size limit', () => {
    const state = buildInitialDemoState('2026-11-12');
    const shards = shardInvoices(state.invoices);
    expect([...shards.values()].flat()).toHaveLength(state.invoices.length);
    const big = Array.from({ length: 900 }, (_, i) => ({ ...state.invoices[0]!, id: `x${i}`, description: 'x'.repeat(200) }));
    const split = shardInvoices(big);
    expect(split.size).toBeGreaterThan(1);
    for (const items of split.values()) expect(JSON.stringify({ items }).length).toBeLessThan(256 * 1024);
  });
});

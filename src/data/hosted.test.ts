/**
 * 雲端模式測試：以記憶體模擬平台 db，驗證寫入、重新載入、分割與權限。
 */
import { describe, expect, it } from 'vitest';
import { invoiceFormSchema, paymentFormSchema } from '@/domain/validation';
import { todayIso } from '@/domain/dates';
import { BACKUP_KEEP, HostedRepository, shardInvoices, type BackupStore, type HostedDb, type HostedUser } from './hostedRepository';
import { buildInitialDemoState } from './demoRepository';
import { newChecklist } from '@/domain/checklists';
import { newClaim, validateClaim } from '@/domain/claims';

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

describe('HostedRepository staff claims', () => {
  it('stores claims by expense month and reloads them', async () => {
    const { db, docs } = fakeDb();
    const repo = await HostedRepository.create(db, owner);
    const v = validateClaim({ staffName: 'Ali', expenseDate: '2026-10-30', category: 'Mileage', description: 'Site visit', amount: '', mileageKm: '40', ratePerKm: '0.60', hasReceipt: false, remarks: '' }, today);
    if (!v.ok) throw new Error('invalid');
    await repo.saveClaims([newClaim(v.value, [], today, new Date().toISOString(), 'k1')]);
    await repo.whenSaved();
    expect(docs.has('claims/2026-10')).toBe(true);
    const again = await HostedRepository.create(db, owner);
    expect((await again.listClaims())[0]).toMatchObject({ id: 'k1', amount: 2400, mileageKm: 40 });
    await again.deleteClaim('k1');
    await again.whenSaved();
    expect(docs.has('claims/2026-10')).toBe(false); // 月份變空 → 文件刪除
  });

  it('after a reload, deleting the last task of a month removes that month from the cloud', async () => {
    const { db, docs } = fakeDb();
    const repo = await HostedRepository.create(db, owner);
    const t = await repo.saveTask({ title: 'Only task', category: 'GL', priority: 'Low', dueDate: '2027-03-15' });
    await repo.whenSaved();
    expect(docs.has('tasks/2027-03')).toBe(true);
    const again = await HostedRepository.create(db, owner);
    await again.deleteTask(t.id);
    await again.whenSaved();
    expect(docs.has('tasks/2027-03')).toBe(false);
    expect((await (await HostedRepository.create(db, owner)).listTasks()).some((x) => x.id === t.id)).toBe(false);
  });
});

/** 模擬備份檔案的儲存空間。 */
function fakeStore() {
  const files = new Map<string, string>();
  let n = 0;
  const store: BackupStore = {
    upload: async (blob) => { n += 1; const id = `b${n}`; files.set(id, await blob.text()); return { id, sizeBytes: blob.size }; },
    delete: async (id) => { files.delete(id); },
    read: async (id) => { if (!files.has(id)) throw new Error('missing'); return files.get(id)!; },
  };
  return { store, files };
}

describe('HostedRepository automatic backups', () => {
  it('backs up weekly, not more often, and never backs up empty or sample data', async () => {
    const { db } = fakeDb();
    const { store, files } = fakeStore();
    const repo = await HostedRepository.create(db, owner);
    repo.setBackupStore(store);
    expect(await repo.maybeAutoBackup()).toBe(false); // 空的
    await repo.resetDemoData();
    expect(await repo.maybeAutoBackup()).toBe(false); // 範例資料
    await repo.clearAllData();
    await repo.createInvoice('AR', form('B-1'));
    expect(await repo.maybeAutoBackup()).toBe(true);
    expect(files.size).toBe(1);
    expect(await repo.maybeAutoBackup()).toBe(false); // 未滿 7 天
    expect(await repo.maybeAutoBackup(new Date(Date.now() + 8 * 86_400_000))).toBe(true);
    const list = await repo.listBackups();
    expect(list.map((b) => b.reason)).toEqual(['weekly', 'weekly']);
    expect(list[0]).toMatchObject({ invoices: 1 });
    expect(repo.dataStatus().lastBackupAt).toBe(list[0]!.at);
  });

  it('saves a backup before "Delete all data" and restores it, surviving a reload', async () => {
    const { db } = fakeDb();
    const { store } = fakeStore();
    const repo = await HostedRepository.create(db, owner);
    repo.setBackupStore(store);
    await repo.createInvoice('AR', form('KEEP-1'));
    await repo.saveTask({ title: 'Keep me', category: 'GL', priority: 'Low', dueDate: today });
    await repo.clearAllData();
    await repo.whenSaved();
    expect(await repo.listInvoices()).toHaveLength(0);

    const again = await HostedRepository.create(db, owner); // 重新開啟：備份清單仍在
    again.setBackupStore(store);
    const [b] = await again.listBackups();
    expect(b).toMatchObject({ reason: 'before-delete', invoices: 1, tasks: 1 });
    await again.restoreBackup(b!.id);
    await again.whenSaved();
    expect((await again.listInvoices()).map((i) => i.invoiceNumber)).toEqual(['KEEP-1']);
    expect((await again.listTasks()).map((t) => t.title)).toEqual(['Keep me']);
    const third = await HostedRepository.create(db, owner);
    expect(await third.listInvoices()).toHaveLength(1);
  });

  it('keeps only the latest backups and deletes older files; viewers get none', async () => {
    const { db } = fakeDb();
    const { store, files } = fakeStore();
    const repo = await HostedRepository.create(db, owner);
    repo.setBackupStore(store);
    await repo.createInvoice('AR', form('P-1'));
    for (let i = 0; i < BACKUP_KEEP + 3; i += 1) await repo.createBackup('manual');
    expect(await repo.listBackups()).toHaveLength(BACKUP_KEEP);
    expect(files.size).toBe(BACKUP_KEEP);
    const v = await HostedRepository.create(db, viewer);
    v.setBackupStore(store);
    expect(v.backupsAvailable()).toBe(false);
    expect(await v.createBackup('manual')).toBeNull();
  });
});

describe('Clean-up of finished records older than 3 months', () => {
  const old = '2026-01-10';
  const oldForm = (n: string) => invoiceFormSchema.parse({ invoiceNumber: n, counterpartyName: 'Old Customer Sdn Bhd', invoiceDate: old, dueDate: old, description: '', invoiceAmount: '100', taxAmount: '0' });

  it('removes old paid invoices and done tasks with their files, keeps unpaid ones, and backs up first', async () => {
    const { db } = fakeDb();
    const { store, files } = fakeStore();
    const repo = await HostedRepository.create(db, owner);
    repo.setBackupStore(store);
    const paid = await repo.createInvoice('AR', oldForm('OLD-PAID'));
    await repo.recordPayment(paid.id, paymentFormSchema(today).parse({ paymentDate: old, amount: '100', method: 'FPX' }));
    await repo.addAttachment!(paid.id, { id: 'file-1', name: 'a.pdf', contentType: 'application/pdf', sizeBytes: 1, uploadedAt: old });
    files.set('file-1', 'pdf');
    await repo.createInvoice('AR', oldForm('OLD-UNPAID')); // 很舊但還沒收款 → 保留
    const recent = await repo.createInvoice('AR', form('NEW-PAID'));
    await repo.recordPayment(recent.id, paymentFormSchema(today).parse({ paymentDate: today, amount: '1000', method: 'FPX' }));
    const t = await repo.saveTask({ title: 'Old done', category: 'GL', priority: 'Low', dueDate: old });
    await repo.setTaskStatus(t.id, 'done');
    await repo.saveTask({ title: 'Old open', category: 'GL', priority: 'Low', dueDate: old });

    const preview = repo.previewCleanup();
    expect(preview).toMatchObject({ invoiceIds: [paid.id], attachmentIds: ['file-1'] });
    expect(await repo.maybeAutoCleanup()).toBe(0); // 尚未開啟自動清除
    const plan = await repo.cleanupOldData();
    expect(plan.invoiceIds).toEqual([paid.id]);
    expect((await repo.listInvoices()).map((i) => i.invoiceNumber).sort()).toEqual(['NEW-PAID', 'OLD-UNPAID']);
    expect((await repo.listTasks()).map((x) => x.title)).toContain('Old open');
    expect(files.has('file-1')).toBe(false);
    const [b] = await repo.listBackups();
    expect(b).toMatchObject({ reason: 'before-cleanup', invoices: 3 });
    expect(repo.cleanupStatus().lastCount).toBe(plan.total);
    expect((await repo.cleanupOldData()).total).toBe(0);
  });

  it('automatic clean-up runs on open only after it is switched on, and the setting survives a reload', async () => {
    const { db } = fakeDb();
    const { store } = fakeStore();
    const repo = await HostedRepository.create(db, owner);
    repo.setBackupStore(store);
    const paid = await repo.createInvoice('AP', oldForm('AP-OLD'));
    await repo.setApproval(paid.id, 'approved');
    await repo.recordPayment(paid.id, paymentFormSchema(today).parse({ paymentDate: old, amount: '100', method: 'FPX' }));
    await repo.setAutoCleanup(true);
    await repo.whenSaved();
    const again = await HostedRepository.create(db, owner);
    again.setBackupStore(store);
    expect(again.cleanupStatus().auto).toBe(true);
    expect(await again.maybeAutoCleanup()).toBe(1);
    expect(await again.listInvoices()).toHaveLength(0);
    const v = await HostedRepository.create(db, viewer);
    expect(await v.maybeAutoCleanup()).toBe(0);
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

/**
 * 雲端資料來源（Hosted repository）：在 claude.ai Artifact 中執行時使用。
 *
 * - 業務規則與示範模式完全相同（繼承 DemoRepository），差別只在「儲存位置」：
 *   資料存放在 Artifact 的 db 雲端資料庫，不再只存在瀏覽器。
 * - 身分由平台提供：可編輯者（擁有者）為 admin；若日後分享給他人檢視，對方為唯讀 viewer。
 *
 * 儲存結構（每份文件上限 256 KiB）：
 *   invoices/<YYYY-MM>[~n]  依發票月份分組的發票（含付款），過大時自動分割
 *   meta/counterparties     供應商與客戶清單
 *   meta/activity           最近 300 筆活動紀錄
 *   meta/info               是否為範例資料、最後修改時間
 *   meta/settings           公司設定（名稱、期初銀行餘額、預設付款期限）
 *   tasks/<YYYY-MM>[~n]     每日工作任務（依到期月份分組）
 *   meta/recurrences        週期任務規則
 *   checklists/<YYYY-MM>    薪資與月結檢查清單（每月一份文件）
 *   claims/<YYYY-MM>        員工報銷（依支出月份分組）
 *
 * 寫入策略：每次變更後比對各文件內容，只寫入有變動的文件；
 * 同一時間只進行一個寫入（依序排隊），並把狀態回報給畫面（儲存中／已儲存／失敗）。
 */
import { todayIso } from '@/domain/dates';
import type { ActivityEntry, CompanySettings, Counterparty, Invoice, UserProfile } from '@/domain/types';
import { DEFAULT_SETTINGS } from '@/domain/types';
import type { Task } from '@/domain/tasks';
import type { RecurrenceRule } from '@/domain/recurrence';
import type { Checklist } from '@/domain/checklists';
import type { StaffClaim } from '@/domain/claims';
import { DemoRepository, memoryStore, STATE_VERSION, type DemoState } from './demoRepository';

// ---------- 平台 db 介面（僅列出用到的部分）----------
interface DocSnap { id: string; exists: boolean; data(): Record<string, unknown> | undefined }
interface DocRef { get(): Promise<DocSnap>; set(d: Record<string, unknown>): Promise<void>; delete(): Promise<void> }
interface CollRef { doc(id: string): DocRef; limit(n: number): { get(): Promise<{ docs: DocSnap[] }> } }
export interface HostedDb { doc(path: string): DocRef; collection(path: string): CollRef }
export interface HostedUser { canEdit(): Promise<boolean>; me(): Promise<{ name: string; id: string | null }> }

export type SaveStatus = { state: 'saved' | 'saving' | 'error'; message?: string };

const SHARD_MAX_BYTES = 200 * 1024; // 留一些餘裕，低於 256 KiB 上限
const ACTIVITY_KEEP = 300;

type InvoiceRecord = Omit<Invoice, 'counterpartyName'>;

/** 依發票月份分組，並將過大的組別切成多份文件。 */
export function shardInvoices(invoices: InvoiceRecord[]): Map<string, InvoiceRecord[]> {
  return shardByMonth(invoices, (i) => i.invoiceDate);
}

/** 依日期所在月份分組（每份文件低於 256 KiB 上限，過大時自動分割）。 */
export function shardByMonth<T extends { id: string }>(items: T[], dateOf: (item: T) => string): Map<string, T[]> {
  const byMonth = new Map<string, T[]>();
  for (const item of items) {
    const d = dateOf(item);
    const key = /^\d{4}-\d{2}/.test(d) ? d.slice(0, 7) : 'undated';
    (byMonth.get(key) ?? byMonth.set(key, []).get(key)!).push(item);
  }
  const shards = new Map<string, T[]>();
  for (const [month, list] of byMonth) {
    list.sort((a, b) => a.id.localeCompare(b.id));
    let part = 1;
    let current: T[] = [];
    let size = 0;
    for (const inv of list) {
      const bytes = JSON.stringify(inv).length + 1;
      if (current.length && size + bytes > SHARD_MAX_BYTES) {
        shards.set(part === 1 ? month : `${month}~${part}`, current);
        part += 1;
        current = [];
        size = 0;
      }
      current.push(inv);
      size += bytes;
    }
    if (current.length) shards.set(part === 1 ? month : `${month}~${part}`, current);
  }
  return shards;
}

/** 自動備份的一筆紀錄（檔案存在平台 assets，這裡只記錄指標與摘要）。 */
export type BackupReason = 'weekly' | 'manual' | 'before-delete' | 'before-restore' | 'before-sample';
export interface BackupEntry { id: string; at: string; reason: BackupReason; invoices: number; tasks: number; claims: number; sizeBytes: number }
/** 備份檔的儲存空間（平台 assets）。 */
export interface BackupStore {
  upload(blob: Blob): Promise<{ id: string; sizeBytes: number }>;
  delete(id: string): Promise<unknown>;
  read(id: string): Promise<string>;
}
export const BACKUP_KEEP = 12;
export const BACKUP_EVERY_DAYS = 7;

export class HostedRepository extends DemoRepository {
  override readonly mode = 'hosted' as const;
  private ready = false;
  /** 最後一次成功寫入雲端的各文件內容（JSON 文字），用於比對差異。 */
  private written = new Map<string, string>();
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private statusListeners = new Set<(s: SaveStatus) => void>();
  private status: SaveStatus = { state: 'saved' };
  private backupStore: BackupStore | null = null;
  private backups: BackupEntry[] = [];

  private constructor(private readonly db: HostedDb, profile: UserProfile) {
    super(memoryStore(), () => todayIso(), 0);
    this.user = profile;
  }

  /** 由平台提供的 db 與 user 建立，並從雲端載入資料。 */
  static async create(db: HostedDb, user: HostedUser | null): Promise<HostedRepository> {
    const canEdit = user ? await user.canEdit().catch(() => false) : false;
    const me = user ? await user.me().catch(() => ({ name: '', id: null })) : { name: '', id: null };
    const profile: UserProfile = {
      id: me.id ?? 'viewer',
      email: '',
      fullName: me.name || (canEdit ? 'Owner' : 'Viewer'),
      role: canEdit ? 'admin' : 'viewer',
    };
    const repo = new HostedRepository(db, profile);
    await repo.loadFromCloud();
    repo.ready = true;
    // 仍在儲存時離開頁面：請瀏覽器提醒使用者
    window.addEventListener('beforeunload', (e) => {
      if (repo.timer || repo.pending > 0) e.preventDefault();
    });
    return repo;
  }

  // ---------- 載入 ----------

  private async loadFromCloud() {
    const [info, cps, act, shards, settingsDoc, taskShards, recDoc, checklistShards] = await Promise.all([
      this.db.doc('meta/info').get(),
      this.db.doc('meta/counterparties').get(),
      this.db.doc('meta/activity').get(),
      this.db.collection('invoices').limit(1000).get(),
      this.db.doc('meta/settings').get(),
      this.db.collection('tasks').limit(1000).get(),
      this.db.doc('meta/recurrences').get(),
      this.db.collection('checklists').limit(1000).get(),
    ]);
    const claimShards = await this.db.collection('claims').limit(1000).get();
    // 記錄雲端已有的文件（用來比對差異，並刪除變空的月份文件）
    this.written.clear();
    const checklists: Checklist[] = [];
    for (const d of checklistShards.docs) {
      const body = d.data() as { items?: Checklist[] } | undefined;
      if (!body?.items) continue;
      checklists.push(...body.items);
      this.written.set(`checklists/${d.id}`, JSON.stringify({ items: body.items }));
    }
    const claims: StaffClaim[] = [];
    for (const d of claimShards.docs) {
      const body = d.data() as { items?: StaffClaim[] } | undefined;
      if (!body?.items) continue;
      claims.push(...body.items);
      this.written.set(`claims/${d.id}`, JSON.stringify({ items: body.items }));
    }
    const tasks: Task[] = [];
    for (const d of taskShards.docs) {
      const body = d.data() as { items?: Task[] } | undefined;
      if (!body?.items) continue;
      tasks.push(...body.items);
      this.written.set(`tasks/${d.id}`, JSON.stringify({ items: body.items }));
    }
    const recurrences = ((recDoc.data() as { items?: RecurrenceRule[] } | undefined)?.items) ?? [];
    if (recDoc.exists) this.written.set('meta/recurrences', JSON.stringify({ items: recurrences }));
    const settings = settingsDoc.data() as CompanySettings | undefined;
    if (settingsDoc.exists) this.written.set('meta/settings', JSON.stringify(settings));
    const invoices: InvoiceRecord[] = [];
    for (const d of shards.docs) {
      const body = d.data() as { items?: InvoiceRecord[] } | undefined;
      if (!body?.items) continue;
      invoices.push(...body.items);
      this.written.set(`invoices/${d.id}`, JSON.stringify({ items: body.items }));
    }
    const counterparties = ((cps.data() as { items?: Counterparty[] } | undefined)?.items) ?? [];
    const activity = ((act.data() as { items?: ActivityEntry[] } | undefined)?.items) ?? [];
    const meta = info.data() as { isSample?: boolean; modifiedAt?: string | null } | undefined;
    if (cps.exists) this.written.set('meta/counterparties', JSON.stringify({ items: counterparties }));
    if (act.exists) this.written.set('meta/activity', JSON.stringify({ items: activity }));
    if (info.exists) this.written.set('meta/info', JSON.stringify({ isSample: meta?.isSample ?? false, modifiedAt: meta?.modifiedAt ?? null }));
    // 雲端是空的 → 從空白開始（不自動放入範例資料）
    this.state = { version: STATE_VERSION, counterparties, invoices, activity, isSample: meta?.isSample ?? false, modifiedAt: meta?.modifiedAt ?? null, settings: settings ? { ...DEFAULT_SETTINGS, ...settings } : undefined, tasks, recurrences, checklists, claims };
  }

  // ---------- 儲存 ----------

  protected override save(state: DemoState = this.state) {
    if (!this.ready) return; // 建構期間（父類別初始化）不寫入
    this.state = state;
    // 短暫合併連續變更（例如還原備份），再一次寫入
    if (this.timer) clearTimeout(this.timer);
    this.setStatus({ state: 'saving' });
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pending += 1;
      this.queue = this.queue.then(() => this.flush()).finally(() => {
        this.pending -= 1;
      });
    }, 50);
  }

  /** 比對差異並依序寫入；失敗時保留差異，下次變更或按「重試」會再寫一次。 */
  private async flush() {
    const desired = new Map<string, string>();
    for (const [key, items] of shardInvoices(this.state.invoices)) desired.set(`invoices/${key}`, JSON.stringify({ items }));
    desired.set('meta/counterparties', JSON.stringify({ items: this.state.counterparties }));
    desired.set('meta/activity', JSON.stringify({ items: this.state.activity.slice(0, ACTIVITY_KEEP) }));
    if (this.state.settings) desired.set('meta/settings', JSON.stringify(this.state.settings));
    // 任務依到期月份分組；週期規則存在單一文件
    for (const [key, items] of shardByMonth(this.state.tasks ?? [], (t) => t.dueDate)) desired.set(`tasks/${key}`, JSON.stringify({ items }));
    for (const [key, items] of shardByMonth(this.state.checklists ?? [], (c) => `${c.month}-01`)) desired.set(`checklists/${key}`, JSON.stringify({ items }));
    for (const [key, items] of shardByMonth(this.state.claims ?? [], (c) => c.expenseDate)) desired.set(`claims/${key}`, JSON.stringify({ items }));
    if (this.state.recurrences?.length || this.written.has('meta/recurrences')) desired.set('meta/recurrences', JSON.stringify({ items: this.state.recurrences ?? [] }));
    desired.set('meta/info', JSON.stringify({ isSample: this.state.isSample !== false, modifiedAt: this.state.modifiedAt ?? null }));
    try {
      for (const [path, json] of desired) {
        if (this.written.get(path) === json) continue;
        await this.retryOnce(() => this.db.doc(path).set(JSON.parse(json)));
        this.written.set(path, json);
      }
      for (const path of [...this.written.keys()]) {
        if (desired.has(path)) continue;
        await this.retryOnce(() => this.db.doc(path).delete());
        this.written.delete(path);
      }
      if (this.pending <= 1) this.setStatus({ state: 'saved' });
    } catch (e) {
      const code = (e as { code?: string })?.code;
      const message = code === 'quota_exceeded' ? 'Storage is full. Delete old invoices to free space.'
        : code === 'revoked' || code === 'not_granted' ? 'You no longer have permission to save changes here.'
          : 'Changes could not be saved to the cloud. Check your connection and try again.';
      this.setStatus({ state: 'error', message });
    }
  }

  private async retryOnce(fn: () => Promise<void>) {
    try {
      await fn();
    } catch (e) {
      if ((e as { code?: string })?.code !== 'unavailable') throw e;
      await new Promise((r) => setTimeout(r, 500 + Math.random() * 1000));
      await fn();
    }
  }

  // ---------- 自動備份 ----------
  // 每週自動備份一次（開啟頁面時檢查），並在「刪除全部／還原／載入範例」之前自動備份。
  // 備份索引存在 meta/backups（不在一般儲存流程內，因此清空資料不會刪除備份）。

  setBackupStore(store: BackupStore | null) {
    this.backupStore = store;
  }

  backupsAvailable(): boolean {
    return !!this.backupStore && this.user?.role === 'admin';
  }

  async listBackups(): Promise<BackupEntry[]> {
    const doc = await this.db.doc('meta/backups').get();
    this.backups = ((doc.data() as { items?: BackupEntry[] } | undefined)?.items ?? []).slice().sort((a, b) => b.at.localeCompare(a.at));
    return this.backups;
  }

  private hasRealData(): boolean {
    const s = this.state;
    return s.isSample === false && (s.invoices.length > 0 || (s.tasks?.length ?? 0) > 0 || (s.claims?.length ?? 0) > 0 || (s.checklists?.length ?? 0) > 0);
  }

  /** 建立一份備份；沒有資料（或只有範例資料）時不備份，回傳 null。 */
  async createBackup(reason: BackupReason): Promise<BackupEntry | null> {
    if (!this.backupsAvailable() || !this.hasRealData()) return null;
    const text = super.exportBackup();
    const up = await this.backupStore!.upload(new Blob([text], { type: 'application/json' }));
    const entry: BackupEntry = { id: up.id, at: new Date().toISOString(), reason, invoices: this.state.invoices.length, tasks: this.state.tasks?.length ?? 0, claims: this.state.claims?.length ?? 0, sizeBytes: up.sizeBytes };
    const all = [entry, ...(await this.listBackups())];
    const keep = all.slice(0, BACKUP_KEEP);
    await this.db.doc('meta/backups').set({ items: keep });
    this.backups = keep;
    for (const old of all.slice(BACKUP_KEEP)) await this.backupStore!.delete(old.id).catch(() => undefined);
    return entry;
  }

  /** 距離上次備份滿 7 天就自動備份。回傳是否有建立。 */
  async maybeAutoBackup(now: Date = new Date()): Promise<boolean> {
    if (!this.backupsAvailable() || !this.hasRealData()) return false;
    const [latest] = await this.listBackups();
    if (latest && now.getTime() - Date.parse(latest.at) < BACKUP_EVERY_DAYS * 86_400_000) return false;
    return (await this.createBackup('weekly')) !== null;
  }

  /** 還原某一份自動備份（還原前先把目前資料備份起來）。 */
  async restoreBackup(id: string) {
    this.require('admin');
    if (!this.backupStore) throw new Error('Backups are not available here.');
    const text = await this.backupStore.read(id);
    await this.createBackup('before-restore').catch(() => null);
    await super.importBackup(text);
  }

  private async safety(reason: BackupReason) {
    // 安全備份失敗不應阻擋使用者的操作
    await this.createBackup(reason).catch(() => null);
  }

  override async clearAllData() {
    await this.safety('before-delete');
    await super.clearAllData();
  }

  override async resetDemoData() {
    if (this.ready) await this.safety('before-sample');
    await super.resetDemoData();
  }

  override async importBackup(text: string) {
    await this.safety('before-restore');
    await super.importBackup(text);
  }

  override dataStatus() {
    const base = super.dataStatus();
    const latest = this.backups[0]?.at ?? null;
    return { ...base, lastBackupAt: latest && (!base.lastBackupAt || latest > base.lastBackupAt) ? latest : base.lastBackupAt };
  }

  /** 失敗後重試寫入。 */
  retrySave() {
    this.save();
  }

  private setStatus(s: SaveStatus) {
    this.status = s;
    this.statusListeners.forEach((fn) => fn(s));
  }

  onSaveStatus(fn: (s: SaveStatus) => void): () => void {
    this.statusListeners.add(fn);
    fn(this.status);
    return () => this.statusListeners.delete(fn);
  }

  /** 等待所有寫入完成（測試用）。 */
  async whenSaved() {
    while (this.timer || this.pending > 0) await new Promise((r) => setTimeout(r, 50));
    await this.queue;
  }

  // ---------- 身分：由平台決定，無需登入 ----------

  override async currentUser() {
    return this.user;
  }

  override async signIn(): Promise<UserProfile> {
    return this.user!;
  }

  override async signOut() {
    // 雲端模式由 claude.ai 帳號管理身分，無登出動作
  }
}

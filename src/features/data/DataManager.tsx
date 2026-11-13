/**
 * 資料管理（Data management）
 *
 * 兩種儲存位置：
 *   - 本機模式：資料在這台電腦的瀏覽器中 → 強調定期備份
 *   - 雲端模式（claude.ai）：資料在雲端 → 自動儲存，備份為額外保障
 * 功能：下載備份、由備份還原、清空資料、載入範例資料、提醒橫幅、儲存狀態。
 *
 * 注意：claude.ai 內不能使用 confirm() 對話框，因此所有確認步驟都在頁面內完成。
 */
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Modal } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import { repository } from '@/data';
import type { BackupEntry, BackupReason, HostedRepository, SaveStatus } from '@/data/hostedRepository';
import { formatDate, formatDateTime, todayIso } from '@/domain/dates';
import { downloadTextFile, isDeclined } from '@/lib/download';
import { useInvoices } from '@/hooks/useFinanceData';
import { useAuth } from '@/features/auth/AuthContext';

/** 本機或雲端模式才有這些功能（Supabase 模式沒有）。 */
export const isLocalMode = () => !!repository.exportBackup;
export const isHosted = () => repository.mode === 'hosted';

const BACKUP_REMINDER_DAYS = 7;

export function useDataStatus() {
  // 每次資料變更後發票都會重新讀取，藉此觸發重新計算
  const { dataUpdatedAt } = useInvoices();
  void dataUpdatedAt;
  return repository.dataStatus?.() ?? null;
}

/** 雲端儲存狀態（儲存中／已儲存／失敗）。 */
export function useSaveStatus(): SaveStatus | null {
  const [status, setStatus] = useState<SaveStatus | null>(null);
  useEffect(() => {
    if (!isHosted()) return undefined;
    return (repository as HostedRepository).onSaveStatus(setStatus);
  }, []);
  return status;
}

/** 下載備份；使用者取消時不視為錯誤。回傳是否已下載。 */
export async function downloadBackup(): Promise<boolean> {
  const text = repository.exportBackup!();
  try {
    await downloadTextFile(text, `invoice-backup-${todayIso()}.json`, 'application/json');
    return true;
  } catch (e) {
    if (isDeclined(e)) return false;
    throw e;
  }
}

/** 頁面頂端的提醒橫幅。 */
export function DataBanners({ onManage }: { onManage: () => void }) {
  const status = useDataStatus();
  const save = useSaveStatus();
  const toast = useToast();
  const [, force] = useState(0);
  if (!status) return null;
  const neverBackedUp = !status.lastBackupAt;
  const changedSinceBackup = !!status.modifiedAt && (neverBackedUp || status.modifiedAt > status.lastBackupAt!);
  const daysSince = status.lastBackupAt ? Math.floor((Date.now() - Date.parse(status.lastBackupAt)) / 86_400_000) : Infinity;
  // 雲端模式資料已自動儲存，不需要備份提醒
  const needsBackup = !isHosted() && changedSinceBackup && (neverBackedUp || daysSince >= BACKUP_REMINDER_DAYS);

  return (
    <div className="mb-4 space-y-2 empty:hidden">
      {save?.state === 'error' && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-red-50 px-4 py-2.5 text-sm text-red-800 ring-1 ring-red-200" role="alert">
          <span><strong>Not saved.</strong> {save.message}</span>
          <Button size="sm" onClick={() => (repository as HostedRepository).retrySave()}>Try again</Button>
        </div>
      )}
      {status.isSample && status.invoiceCount > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-amber-50 px-4 py-2.5 text-sm text-amber-900 ring-1 ring-amber-200" data-testid="sample-banner">
          <span><strong>You are looking at sample data.</strong> When you are ready to enter your company's real invoices, start fresh.</span>
          <Button size="sm" onClick={onManage}>Start with my own data…</Button>
        </div>
      )}
      {!status.isSample && needsBackup && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-sky-50 px-4 py-2.5 text-sm text-sky-900 ring-1 ring-sky-200" data-testid="backup-banner">
          <span>{neverBackedUp ? 'You have not made a backup yet.' : `Your last backup was ${daysSince} days ago.`} Your data lives only in this browser. Download a backup to keep it safe.</span>
          <Button size="sm" variant="primary" onClick={async () => { if (await downloadBackup()) { toast('Backup downloaded'); force((n) => n + 1); } }}>Download backup</Button>
        </div>
      )}
    </div>
  );
}

type Pending =
  | { kind: 'clear' }
  | { kind: 'sample' }
  | { kind: 'restore'; file: File }
  | { kind: 'auto'; entry: BackupEntry }
  | { kind: 'cleanup' };

/** 「我的資料」對話框。 */
const REASON_LABEL: Record<BackupReason, string> = {
  weekly: 'Weekly automatic backup', manual: 'Backed up by you', 'before-delete': 'Saved before "Delete all data"',
  'before-restore': 'Saved before a restore', 'before-sample': 'Saved before loading sample data', 'before-cleanup': 'Saved before a clean-up',
};

export function DataManagerModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const status = useDataStatus();
  const { user } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [backups, setBackups] = useState<BackupEntry[] | null>(null);
  const hostedRepo = isHosted() ? (repository as HostedRepository) : null;
  const canAuto = !!hostedRepo?.backupsAvailable();
  useEffect(() => {
    if (!open || !canAuto) return undefined;
    let live = true;
    hostedRepo!.listBackups().then((b) => { if (live) setBackups(b); }).catch(() => { if (live) setBackups([]); });
    return () => { live = false; };
  }, [open, canAuto, hostedRepo]);
  if (!open || !status) return null;
  const isAdmin = user?.role === 'admin';
  const hosted = isHosted();
  const close = () => { setPending(null); setError(''); onClose(); };

  const run = async (fn: () => Promise<void>, message: string) => {
    setError('');
    setBusy(true);
    try {
      await fn();
      await qc.invalidateQueries();
      toast(message);
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  const confirmText: Record<Pending['kind'], { title: string; body: string; button: string }> = {
    clear: status.isSample
      ? { title: 'Remove the sample data?', body: 'All sample invoices are removed and the system becomes empty, ready for your real invoices.', button: 'Remove sample data' }
      : { title: 'Delete all data?', body: canAuto ? 'Every invoice, payment, task and claim will be deleted. A backup is saved automatically first, so you can restore it from "Automatic backups" if you change your mind.' : 'Every invoice, payment and history entry will be deleted. Download a backup first if you may need them.', button: 'Delete everything' },
    sample: { title: 'Load sample data?', body: 'Everything currently saved is replaced with sample invoices. Your data is lost unless you have a backup.', button: 'Replace with sample data' },
    cleanup: { title: 'Remove old finished records?', body: 'Paid or cancelled invoices, completed tasks, paid or rejected claims and completed checklists that ended more than 3 months ago are removed, together with their attached files. Unpaid invoices and open tasks are always kept. A backup of the records is saved first; attached files cannot be brought back.', button: 'Remove old records' },
    auto: { title: 'Restore this backup?', body: `Everything currently saved is replaced with the backup from ${pending?.kind === 'auto' ? formatDateTime(pending.entry.at) : ''}. Your current data is backed up first, so you can undo this.`, button: 'Restore backup' },
    restore: { title: 'Restore this backup?', body: `Everything currently saved is replaced with the contents of "${pending?.kind === 'restore' ? pending.file.name : ''}".`, button: 'Restore backup' },
  };

  const confirmPending = () => {
    if (!pending) return;
    if (pending.kind === 'clear') void run(() => repository.clearAllData!(), status.isSample ? 'Sample data removed. The system is now empty.' : 'All data deleted');
    if (pending.kind === 'sample') void run(() => repository.resetDemoData!(), 'Sample data loaded');
    if (pending.kind === 'cleanup') void run(async () => { await repository.cleanupOldData!(); }, 'Old records removed');
    if (pending.kind === 'auto') { const id = pending.entry.id; void run(() => hostedRepo!.restoreBackup(id), 'Backup restored'); }
    if (pending.kind === 'restore') { const f = pending.file; void run(async () => repository.importBackup!(await f.text()), 'Backup restored'); }
  };

  return (
    <Modal open onClose={close} title="My data"
      subtitle={hosted ? 'Saved automatically to your Claude account. Only people you share this page with can see it.' : 'Your invoices are saved in this browser on this computer.'}>
      {pending ? (
        <div className="space-y-4 text-sm" data-testid="confirm-panel">
          <h3 className="text-base font-semibold text-slate-900">{confirmText[pending.kind].title}</h3>
          <p className="text-slate-600">{confirmText[pending.kind].body}</p>
          {error && <Alert>{error}</Alert>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button onClick={() => { setPending(null); setError(''); }} disabled={busy}>Go back</Button>
            <Button variant={pending.kind === 'clear' && status.isSample ? 'primary' : 'danger'} loading={busy} onClick={confirmPending} data-testid="confirm-data-action">
              {confirmText[pending.kind].button}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-5 text-sm">
          <dl className="grid grid-cols-2 gap-3 rounded-lg bg-slate-50 p-4 ring-1 ring-slate-200 sm:grid-cols-3">
            <div><dt className="text-xs text-slate-500">Invoices</dt><dd className="font-semibold" data-testid="data-count">{status.invoiceCount}{status.isSample && status.invoiceCount ? ' (sample)' : ''}</dd></div>
            <div><dt className="text-xs text-slate-500">Last change</dt><dd className="font-semibold">{status.modifiedAt ? formatDateTime(status.modifiedAt) : '—'}</dd></div>
            <div><dt className="text-xs text-slate-500">Last backup</dt><dd className="font-semibold">{status.lastBackupAt ? formatDateTime(status.lastBackupAt) : 'Never'}</dd></div>
          </dl>

          {!hosted && (
            <Alert tone="warning">
              Clearing your browser's history or site data deletes this data, and a different browser or computer will not show it.
              Download a backup regularly (for example every Friday) and keep it somewhere safe, such as Google Drive or OneDrive.
            </Alert>
          )}

          <section>
            <h3 className="font-semibold text-slate-900">Backup</h3>
            <p className="mt-1 text-slate-600">
              {hosted ? 'Your data is saved online automatically. A backup file is an extra copy you keep yourself, for example at month-end.'
                : 'Download one file containing all invoices, payments and history.'} Use <em>Restore</em> to load a backup again.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="primary" data-testid="download-backup" onClick={async () => {
                try { if (await downloadBackup()) { toast('Backup downloaded'); close(); } } catch (e) { setError(e instanceof Error ? e.message : 'Download failed'); }
              }}>Download backup</Button>
              {isAdmin && <Button onClick={() => fileRef.current?.click()} disabled={busy}>Restore from backup…</Button>}
              <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" data-testid="restore-input" id="restore-input"
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) setPending({ kind: 'restore', file: f }); }} />
            </div>
          </section>

          {canAuto && (
            <section data-testid="auto-backups">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-semibold text-slate-900">Automatic backups</h3>
                <Button size="sm" loading={busy} data-testid="backup-now" onClick={async () => {
                  setError(''); setBusy(true);
                  try {
                    const e = await hostedRepo!.createBackup('manual');
                    setBackups(await hostedRepo!.listBackups());
                    toast(e ? 'Backup saved' : 'Nothing to back up yet');
                  } catch { setError('The backup could not be saved. Please try again.'); } finally { setBusy(false); }
                }}>Back up now</Button>
              </div>
              <p className="mt-1 text-slate-600">A backup is saved automatically every week when you open the portal, and before anything is deleted or replaced. The latest 12 are kept.</p>
              {backups === null ? <p className="mt-2 text-xs text-slate-500">Loading…</p> : backups.length === 0 ? <p className="mt-2 text-xs text-slate-500">No backups yet. The first one is saved once you have entered your own data.</p> : (
                <ul className="mt-2 max-h-48 divide-y divide-slate-100 overflow-y-auto rounded-lg ring-1 ring-slate-200" data-testid="backup-list">
                  {backups.map((b) => (
                    <li key={b.id} className="flex items-center gap-3 px-3 py-2">
                      <span className="min-w-0 flex-1"><span className="block font-medium text-slate-800">{formatDateTime(b.at)}</span>
                        <span className="block text-xs text-slate-500">{REASON_LABEL[b.reason] ?? 'Backup'} · {b.invoices} invoices · {b.tasks} tasks · {b.claims} claims</span></span>
                      <Button size="sm" onClick={() => setPending({ kind: 'auto', entry: b })} data-testid="restore-auto">Restore</Button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {isAdmin && !status.isSample && repository.previewCleanup && (() => {
            const plan = repository.previewCleanup!();
            const cs = repository.cleanupStatus!();
            const parts = [[plan.invoiceIds.length, 'invoice'], [plan.taskIds.length, 'task'], [plan.claimIds.length, 'claim'], [plan.checklistIds.length, 'checklist']] as const;
            const text = parts.filter(([n]) => n > 0).map(([n, w]) => `${n} ${w}${n === 1 ? '' : 's'}`).join(', ');
            return (
              <section data-testid="cleanup-section">
                <h3 className="font-semibold text-slate-900">Storage clean-up</h3>
                <p className="mt-1 text-slate-600">Removes finished records older than 3 months to save space: paid or cancelled invoices, completed tasks, paid or rejected claims, and their attached files. <strong className="font-medium text-slate-800">Unpaid invoices and open tasks are always kept.</strong></p>
                <p className="mt-2 text-slate-800" data-testid="cleanup-preview">{plan.total ? <>Ready to remove now: <strong>{text}</strong>{plan.attachmentIds.length ? ` and ${plan.attachmentIds.length} attached file${plan.attachmentIds.length === 1 ? '' : 's'}` : ''} (ended before {formatDate(plan.cutoff)}).</> : 'Nothing is old enough to remove yet.'}</p>
                {cs.lastAt && <p className="mt-1 text-xs text-slate-500">Last clean-up: {formatDateTime(cs.lastAt)} · {cs.lastCount} records removed</p>}
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <Button onClick={() => setPending({ kind: 'cleanup' })} disabled={!plan.total || busy} data-testid="cleanup-now">Clean up now</Button>
                  <label className="flex items-center gap-2 text-slate-700">
                    <input type="checkbox" className="size-4 rounded border-slate-300 accent-navy-700" checked={cs.auto} data-testid="cleanup-auto"
                      onChange={async (e) => { try { await repository.setAutoCleanup!(e.target.checked); toast(e.target.checked ? 'Automatic clean-up is on' : 'Automatic clean-up is off'); await qc.invalidateQueries(); } catch (err) { setError(err instanceof Error ? err.message : 'Could not save'); } }} />
                    Do this automatically when I open the portal
                  </label>
                </div>
              </section>
            );
          })()}

          {isAdmin && (
            <section>
              <h3 className="font-semibold text-slate-900">{status.isSample && status.invoiceCount ? 'Start with your own data' : 'Start over or explore'}</h3>
              <p className="mt-1 text-slate-600">{status.isSample && status.invoiceCount
                ? 'Remove the sample invoices so you can enter your company\'s real invoices.'
                : 'Delete everything and begin again, or load sample invoices to try the features.'}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {status.invoiceCount > 0 && (
                  <Button variant={status.isSample ? 'primary' : 'danger'} onClick={() => setPending({ kind: 'clear' })} data-testid="start-fresh">
                    {status.isSample ? 'Remove sample data' : 'Delete all data'}
                  </Button>
                )}
                {!status.isSample && <Button variant="ghost" onClick={() => setPending({ kind: 'sample' })} data-testid="load-sample">Load sample data</Button>}
              </div>
            </section>
          )}
          {!isAdmin && <p className="text-slate-500">Only the owner can restore a backup or clear data.</p>}
          {error && <Alert>{error}</Alert>}
        </div>
      )}
    </Modal>
  );
}

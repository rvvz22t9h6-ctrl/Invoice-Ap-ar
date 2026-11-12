/**
 * 本機資料管理（Local data management）
 *
 * 資料儲存在這台電腦的瀏覽器中，因此提供：
 *   - 下載備份（JSON 檔）／由備份還原
 *   - 清空資料，從空白開始使用自己的資料
 *   - 載入範例資料（練習用）
 *   - 提醒橫幅：仍在使用範例資料、或有變更尚未備份
 */
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Alert, Button, Modal } from '@/components/ui';
import { useToast } from '@/components/ui/Toast';
import { repository } from '@/data';
import { formatDateTime, todayIso } from '@/domain/dates';
import { downloadTextFile } from '@/lib/download';
import { useInvoices } from '@/hooks/useFinanceData';
import { useAuth } from '@/features/auth/AuthContext';

/** 本機模式才有這些功能。 */
export const isLocalMode = () => !!repository.exportBackup;

const BACKUP_REMINDER_DAYS = 7;

export function useDataStatus() {
  // 透過發票查詢的更新觸發重新計算（每次資料變更後發票都會重新讀取）
  const { dataUpdatedAt } = useInvoices();
  void dataUpdatedAt;
  return repository.dataStatus?.() ?? null;
}

export function downloadBackup() {
  const text = repository.exportBackup!();
  downloadTextFile(text, `invoice-backup-${todayIso()}.json`, 'application/json');
}

/** 頁面頂端的提醒橫幅。 */
export function DataBanners({ onManage }: { onManage: () => void }) {
  const status = useDataStatus();
  const [, force] = useState(0);
  if (!status) return null;
  const neverBackedUp = !status.lastBackupAt;
  const changedSinceBackup = !!status.modifiedAt && (neverBackedUp || status.modifiedAt > status.lastBackupAt!);
  const daysSince = status.lastBackupAt ? Math.floor((Date.now() - Date.parse(status.lastBackupAt)) / 86_400_000) : Infinity;
  const needsBackup = changedSinceBackup && (neverBackedUp || daysSince >= BACKUP_REMINDER_DAYS);

  return (
    <div className="mb-4 space-y-2">
      {status.isSample && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-amber-50 px-4 py-2.5 text-sm text-amber-900 ring-1 ring-amber-200" data-testid="sample-banner">
          <span><strong>You are looking at sample data.</strong> When you are ready to enter your company's real invoices, start fresh.</span>
          <Button size="sm" onClick={onManage}>Start with my own data…</Button>
        </div>
      )}
      {!status.isSample && needsBackup && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-sky-50 px-4 py-2.5 text-sm text-sky-900 ring-1 ring-sky-200" data-testid="backup-banner">
          <span>{neverBackedUp ? 'You have not made a backup yet.' : `Your last backup was ${daysSince} days ago.`} Your data lives only in this browser — download a backup to keep it safe.</span>
          <Button size="sm" variant="primary" onClick={() => { downloadBackup(); force((n) => n + 1); }}>Download backup</Button>
        </div>
      )}
    </div>
  );
}

/** 「我的資料」對話框。 */
export function DataManagerModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const status = useDataStatus();
  const { user } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (!open || !status) return null;
  const isAdmin = user?.role === 'admin';

  const after = async (message: string) => {
    await qc.invalidateQueries();
    toast(message);
    onClose();
  };
  const guarded = async (fn: () => Promise<void>, message: string) => {
    setError('');
    setBusy(true);
    try { await fn(); await after(message); } catch (e) { setError(e instanceof Error ? e.message : 'Something went wrong'); } finally { setBusy(false); }
  };

  const startFresh = () => {
    if (!confirm(status.isSample
      ? 'Remove all sample data and start with an empty system?'
      : 'Delete ALL invoices and payments in this browser? Download a backup first if you may need them.')) return;
    void guarded(() => repository.clearAllData!(), 'Started fresh — the system is now empty');
  };
  const loadSample = () => {
    if (!confirm('Replace everything with sample data? Your current data will be lost unless you have a backup.')) return;
    void guarded(() => repository.resetDemoData!(), 'Sample data loaded');
  };
  const restore = async (file: File) => {
    if (!confirm(`Restore from "${file.name}"? This replaces all data currently in this browser.`)) return;
    await guarded(async () => repository.importBackup!(await file.text()), 'Backup restored');
  };

  return (
    <Modal open onClose={onClose} title="My data" subtitle="Your invoices are saved in this browser on this computer.">
      <div className="space-y-5 text-sm">
        <dl className="grid grid-cols-2 gap-3 rounded-lg bg-slate-50 p-4 ring-1 ring-slate-200 sm:grid-cols-3">
          <div><dt className="text-xs text-slate-500">Invoices</dt><dd className="font-semibold" data-testid="data-count">{status.invoiceCount}{status.isSample ? ' (sample)' : ''}</dd></div>
          <div><dt className="text-xs text-slate-500">Last change</dt><dd className="font-semibold">{status.modifiedAt ? formatDateTime(status.modifiedAt) : '—'}</dd></div>
          <div><dt className="text-xs text-slate-500">Last backup</dt><dd className="font-semibold">{status.lastBackupAt ? formatDateTime(status.lastBackupAt) : 'Never'}</dd></div>
        </dl>

        <Alert tone="warning">
          Clearing your browser's history/site data, or using a different browser or computer, will not show this data.
          Download a backup regularly (for example every Friday) and keep it in a safe place such as Google Drive or OneDrive.
        </Alert>

        <section>
          <h3 className="font-semibold text-slate-900">Backup</h3>
          <p className="mt-1 text-slate-600">Download one file containing all invoices, payments and history. Use <em>Restore</em> to load it again — on this or another computer.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => { downloadBackup(); toast('Backup downloaded'); onClose(); }} data-testid="download-backup">Download backup</Button>
            {isAdmin && <Button onClick={() => fileRef.current?.click()} disabled={busy}>Restore from backup…</Button>}
            <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" data-testid="restore-input"
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void restore(f); }} />
          </div>
        </section>

        {isAdmin && (
          <section>
            <h3 className="font-semibold text-slate-900">{status.isSample ? 'Start with your own data' : 'Start over'}</h3>
            <p className="mt-1 text-slate-600">{status.isSample
              ? 'Remove the sample invoices so you can enter your company\'s real invoices.'
              : 'Delete everything in this browser and begin with an empty system.'}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant={status.isSample ? 'primary' : 'danger'} onClick={startFresh} loading={busy} data-testid="start-fresh">
                {status.isSample ? 'Remove sample data' : 'Delete all data'}
              </Button>
              {!status.isSample && <Button variant="ghost" onClick={loadSample}>Load sample data</Button>}
            </div>
          </section>
        )}
        {!isAdmin && <p className="text-slate-500">Sign in as Admin to restore a backup or clear data.</p>}
        {error && <Alert>{error}</Alert>}
      </div>
    </Modal>
  );
}

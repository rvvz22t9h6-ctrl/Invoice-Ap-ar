/**
 * 資料來源選擇（Data source selection）
 *
 *   1. 在 claude.ai Artifact 中（VITE_HOST=artifact）→ 雲端 db（HostedRepository）
 *   2. 有設定 Supabase 環境變數 → Supabase
 *   3. 其他 → 瀏覽器本機模式（DemoRepository）
 *
 * 雲端模式需要先非同步連線，因此由 main.tsx 在畫面渲染前呼叫 initRepository()。
 */
import { createClient } from '@supabase/supabase-js';
import { setFileSaver } from '@/lib/download';
import { setAttachmentServices } from '@/lib/attachments';
import { DemoRepository } from './demoRepository';
import { HostedRepository, type HostedDb, type HostedUser } from './hostedRepository';
import type { Repository } from './repository';
import { SupabaseRepository } from './supabaseRepository';

interface ClaudeRuntime { use(name: string): Promise<unknown> }
interface DownloadsCap { save(r: { filename: string; data: Blob }): Promise<unknown> }

function createSyncRepository(): Repository {
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (url && key) return new SupabaseRepository(createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true } }));
  return new DemoRepository();
}

/** 目前使用中的資料來源（ES module live binding：initRepository 之後即為最終值）。 */
export let repository: Repository = createSyncRepository();

/** 雲端模式：連線平台的 db / user / downloads。失敗時拋出錯誤由畫面顯示。 */
export async function initRepository(): Promise<void> {
  if (import.meta.env.VITE_HOST !== 'artifact') return;
  const claude = (window as unknown as { claude?: ClaudeRuntime }).claude;
  if (!claude?.use) throw new Error('This page must be opened from claude.ai to load your data.');
  const [db, user, downloads, assets, sample] = await Promise.all([
    claude.use('db') as Promise<HostedDb | null>,
    claude.use('user') as Promise<HostedUser | null>,
    claude.use('downloads') as Promise<DownloadsCap | null>,
    // 附件：檔案儲存（只有擁有者／編輯者會取得）與自動擷取欄位
    claude.use('assets') as Promise<Parameters<typeof setAttachmentServices>[0]>,
    claude.use('sample') as Promise<Parameters<typeof setAttachmentServices>[1]>,
  ]);
  if (!db) throw new Error('Your data could not be reached. Make sure you are signed in to claude.ai, then reload the page.');
  setAttachmentServices(assets, sample);
  if (downloads) setFileSaver(async (filename, data) => { await downloads.save({ filename, data }); });
  const repo = await HostedRepository.create(db, user);
  // 自動備份：檔案存在平台 assets；開啟時與之後每 6 小時檢查一次是否滿 7 天
  const store = assets as unknown as { upload(b: Blob, o?: { type?: string }): Promise<{ id: string; sizeBytes: number }>; delete(id: string): Promise<unknown> } | null;
  repo.setBackupStore(store ? {
    upload: (blob) => store.upload(blob, { type: 'application/json' }),
    delete: (id) => store.delete(id),
    read: async (id) => { const r = await fetch(`/_blob/${id}`); if (!r.ok) throw new Error('This backup could not be read. Please try again.'); return r.text(); },
  } : null);
  const auto = () => { void repo.maybeAutoBackup().catch(() => false); };
  void repo.listBackups().catch(() => []).then(auto);
  // 已開啟「自動清除」：清掉超過 3 個月且已結束的紀錄（先備份）
  await repo.maybeAutoCleanup().catch(() => 0);
  setInterval(auto, 6 * 3_600_000);
  repository = repo;
}

export type { Repository } from './repository';

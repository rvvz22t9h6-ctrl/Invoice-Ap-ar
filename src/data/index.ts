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
  const [db, user, downloads] = await Promise.all([
    claude.use('db') as Promise<HostedDb | null>,
    claude.use('user') as Promise<HostedUser | null>,
    claude.use('downloads') as Promise<DownloadsCap | null>,
  ]);
  if (!db) throw new Error('Your data could not be reached. Make sure you are signed in to claude.ai, then reload the page.');
  if (downloads) setFileSaver(async (filename, data) => { await downloads.save({ filename, data }); });
  repository = await HostedRepository.create(db, user);
}

export type { Repository } from './repository';

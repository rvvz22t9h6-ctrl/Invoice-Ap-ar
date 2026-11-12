/**
 * 資料來源選擇（Data source selection）
 *
 * 若環境變數有設定 VITE_SUPABASE_URL 與 VITE_SUPABASE_ANON_KEY → 使用 Supabase；
 * 否則自動進入示範模式（瀏覽器內範例資料），方便展示與測試。
 */
import { createClient } from '@supabase/supabase-js';
import { DemoRepository } from './demoRepository';
import type { Repository } from './repository';
import { SupabaseRepository } from './supabaseRepository';

function createRepository(): Repository {
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (url && key) {
    return new SupabaseRepository(createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true } }));
  }
  return new DemoRepository();
}

export const repository: Repository = createRepository();
export type { Repository } from './repository';

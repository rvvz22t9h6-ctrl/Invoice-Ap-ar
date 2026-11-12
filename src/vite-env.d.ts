/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_ROUTER?: string;
  /** 'artifact' = 在 claude.ai Artifact 中執行（雲端 db 儲存） */
  readonly VITE_HOST?: string;
}

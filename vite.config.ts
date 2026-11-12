/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { fileURLToPath, URL } from 'node:url';

// Vite 設定：React + Tailwind，並以 "@" 作為 src 目錄別名
// mode = 'file'：打包成單一 HTML 檔（所有程式與樣式內嵌），可直接雙擊開啟
// mode = 'artifact'：同樣打包成單一檔，供發佈為 claude.ai Artifact（雲端儲存）
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), ...(mode === 'file' || mode === 'artifact' ? [viteSingleFile()] : [])],
  base: mode === 'file' || mode === 'artifact' ? './' : '/',
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
  },
}));

/**
 * 端對端測試設定（Playwright）
 * 以示範模式啟動開發伺服器，每個測試使用全新的瀏覽器環境（全新的範例資料）。
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:5174', trace: 'off', locale: 'en-MY', timezoneId: 'Asia/Kuala_Lumpur' },
  webServer: {
    // 清空 Supabase 環境變數，確保使用示範模式
    command: 'VITE_SUPABASE_URL= VITE_SUPABASE_ANON_KEY= npx vite --port 5174 --strictPort',
    url: 'http://localhost:5174',
    reuseExistingServer: true,
    timeout: 60_000,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }, testIgnore: /mobile\.spec\.ts/ },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /mobile\.spec\.ts/ },
  ],
});

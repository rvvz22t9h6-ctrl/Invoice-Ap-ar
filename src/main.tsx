/**
 * 應用程式進入點（Entry point）
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, HashRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/components/ui/Toast';
import { AuthProvider } from '@/features/auth/AuthContext';
import App from './App';
import './index.css';

// 單一 HTML 檔版本（以 file:// 開啟）必須使用 HashRouter（網址為 #/ap 形式）
const Router = import.meta.env.VITE_ROUTER === 'hash' ? HashRouter : BrowserRouter;

const queryClient = new QueryClient({
  defaultOptions: {
    // 每 5 分鐘自動重新讀取，讓長時間開著的頁面（例如老闆查看）保持最新
    queries: { staleTime: 30_000, refetchInterval: 5 * 60_000, refetchOnWindowFocus: true, retry: 1 },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Router>
        <ToastProvider>
          <AuthProvider>
            <App />
          </AuthProvider>
        </ToastProvider>
      </Router>
    </QueryClientProvider>
  </StrictMode>,
);

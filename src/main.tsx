/**
 * 應用程式進入點（Entry point）
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, HashRouter, MemoryRouter } from 'react-router-dom';
import { initRepository } from '@/data';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '@/components/ui/Toast';
import { AuthProvider } from '@/features/auth/AuthContext';
import App from './App';
import './index.css';

// 路由方式：
//   單一 HTML 檔（file://）→ HashRouter（#/ap）
//   claude.ai Artifact     → MemoryRouter（平台不允許 #/path 形式的網址）
//   一般網站               → BrowserRouter
const Router = import.meta.env.VITE_HOST === 'artifact' ? MemoryRouter
  : import.meta.env.VITE_ROUTER === 'hash' ? HashRouter : BrowserRouter;

const queryClient = new QueryClient({
  defaultOptions: {
    // 每 5 分鐘自動重新讀取，讓長時間開著的頁面（例如老闆查看）保持最新
    queries: { staleTime: 30_000, refetchInterval: 5 * 60_000, refetchOnWindowFocus: true, retry: 1 },
  },
});

const root = createRoot(document.getElementById('root')!);

/** 連線失敗時的畫面。 */
function StartupError({ message }: { message: string }) {
  return (
    <div className="grid min-h-screen place-items-center bg-white px-4">
      <div className="max-w-md rounded-xl border border-slate-200 p-6 text-center">
        <p className="text-base font-semibold text-slate-900">Your finance data could not be loaded</p>
        <p className="mt-2 text-sm text-slate-600">{message}</p>
      </div>
    </div>
  );
}

initRepository().then(() => root.render(
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
), (e: unknown) => root.render(<StartupError message={e instanceof Error ? e.message : 'Please reload the page.'} />));

/**
 * 提示訊息（Toast notifications）：操作成功或失敗時在右下角短暫顯示。
 */
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { cx } from './index';

type Tone = 'success' | 'error';
interface ToastItem { id: number; message: string; tone: Tone }
const ToastContext = createContext<(message: string, tone?: Tone) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((message: string, tone: Tone = 'success') => {
    const id = Date.now() + Math.random();
    setItems((list) => [...list, { id, message, tone }]);
    setTimeout(() => setItems((list) => list.filter((t) => t.id !== id)), tone === 'error' ? 6000 : 3000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4 sm:items-end sm:pr-6" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} role="status" className={cx('pointer-events-auto max-w-sm rounded-lg px-4 py-2.5 text-sm font-medium shadow-lg',
            t.tone === 'success' ? 'bg-navy-900 text-white' : 'bg-red-600 text-white')}>
            {t.tone === 'success' ? '✓ ' : '⚠ '}{t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

/**
 * 快速記錄（Quick record）
 *
 * 手機底部的「＋」按鈕：選擇要記錄的項目後，切換到對應頁面並直接開啟新增表單。
 * 做法：先記下「待開啟」的種類，頁面掛載時（或已在該頁面時立即）開啟表單。
 */
import { useEffect, useRef } from 'react';

export type QuickKind = 'claim' | 'task' | 'ap' | 'ar' | 'note';

let pending: QuickKind | null = null;
const listeners = new Set<() => void>();

export function requestNew(kind: QuickKind) {
  pending = kind;
  listeners.forEach((fn) => fn());
}

/** 頁面呼叫：有對應的快速記錄請求時執行 open（只執行一次）。 */
export function useQuickNew(kind: QuickKind, open: () => void) {
  const ref = useRef(open);
  ref.current = open;
  useEffect(() => {
    const check = () => { if (pending === kind) { pending = null; ref.current(); } };
    check();
    listeners.add(check);
    return () => { listeners.delete(check); };
  }, [kind]);
}

// ---------------------------------------------------------------------------
// 從全域搜尋開啟某一筆紀錄：切換到對應頁面後，由該頁面開啟明細
// ---------------------------------------------------------------------------

export type OpenKind = 'ap' | 'ar' | 'claim' | 'task' | 'note' | 'contact';
let pendingOpen: { kind: OpenKind; id: string } | null = null;
const openListeners = new Set<() => void>();

export function requestOpen(kind: OpenKind, id: string) {
  pendingOpen = { kind, id };
  openListeners.forEach((fn) => fn());
}

/** 頁面呼叫：有對應的開啟請求時執行 open(id)（只執行一次）。ready=false 時先等資料載入。 */
export function useOpenRequest(kind: OpenKind, open: (id: string) => void, ready = true) {
  const ref = useRef(open);
  ref.current = open;
  useEffect(() => {
    if (!ready) return undefined;
    const check = () => { if (pendingOpen?.kind === kind) { const { id } = pendingOpen; pendingOpen = null; ref.current(id); } };
    check();
    openListeners.add(check);
    return () => { openListeners.delete(check); };
  }, [kind, ready]);
}

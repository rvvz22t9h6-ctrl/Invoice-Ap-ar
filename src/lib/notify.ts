/**
 * 桌面通知（Desktop notifications）— 只在瀏覽器支援且使用者允許時使用。
 *
 * 系統不依賴通知或瀏覽器彈窗：所有提醒都會顯示在「提醒中心」（鈴鐺）與「我的一天」頁面。
 * 通知只是額外的提醒管道：
 *   - 一般網站或本機檔案：可要求通知權限，到期或逾期時顯示系統通知。
 *   - claude.ai Artifact：頁面在受限框架中，瀏覽器不提供通知權限 → 自動隱藏此選項。
 * 每個任務每天最多通知一次（記錄在此裝置的 localStorage）。
 */
import type { IsoDate } from '@/domain/dates';

export type NotifyState = 'unsupported' | 'default' | 'granted' | 'denied';

const PREF_KEY = 'invoice-ap-ar:notify-enabled';
const SENT_KEY = 'invoice-ap-ar:notified';

function safeGet(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* 無法儲存時略過 */ } }

/** 目前環境是否能顯示桌面通知。 */
export function notifyState(): NotifyState {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') return 'unsupported';
  // 受限框架（例如 claude.ai Artifact）中無法要求權限
  let framed = false;
  try { framed = window.self !== window.top; } catch { framed = true; }
  if (framed && Notification.permission !== 'granted') return 'unsupported';
  if (!window.isSecureContext && location.protocol !== 'file:') return 'unsupported';
  return Notification.permission as NotifyState;
}

export const notificationsEnabled = () => notifyState() === 'granted' && safeGet(PREF_KEY) !== 'off';

export async function enableNotifications(): Promise<NotifyState> {
  if (notifyState() === 'unsupported') return 'unsupported';
  try {
    const result = await Notification.requestPermission();
    if (result === 'granted') safeSet(PREF_KEY, 'on');
    return result as NotifyState;
  } catch {
    return 'unsupported';
  }
}

export function disableNotifications() {
  safeSet(PREF_KEY, 'off');
}

/** 今天已通知過的鍵值集合（每天自動重置）。 */
function sentToday(today: IsoDate): Set<string> {
  try {
    const raw = JSON.parse(safeGet(SENT_KEY) ?? '{}') as { date?: string; keys?: string[] };
    return new Set(raw.date === today ? raw.keys ?? [] : []);
  } catch {
    return new Set();
  }
}

/**
 * 顯示通知（若已允許），同一個 key 每天只顯示一次。
 * @returns 是否真的顯示了通知
 */
export function notifyOnce(today: IsoDate, key: string, title: string, body: string): boolean {
  if (!notificationsEnabled()) return false;
  const sent = sentToday(today);
  if (sent.has(key)) return false;
  try {
    new Notification(title, { body, tag: key });
  } catch {
    return false;
  }
  sent.add(key);
  safeSet(SENT_KEY, JSON.stringify({ date: today, keys: [...sent] }));
  return true;
}

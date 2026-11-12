/**
 * 提醒中心（Reminder Centre）
 *
 * 三種管道，不依賴瀏覽器彈窗：
 *   1. 鈴鐺：頁面右上角，徽章顯示「逾期 + 今天到期」數量，點開看所有提醒。
 *   2. 每日摘要：每天第一次開啟系統時，在頁面頂端顯示今天的任務摘要（可關閉）。
 *   3. 桌面通知：瀏覽器支援且允許時，到期／逾期任務每天通知一次（claude.ai 內不支援，自動隱藏）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, cx } from '@/components/ui';
import { formatDate } from '@/domain/dates';
import { buildReminders, reminderBadgeCount, type Reminder } from '@/domain/taskInsights';
import { isOpen } from '@/domain/tasks';
import { useTasks, useToday } from '@/hooks/useTasks';
import { disableNotifications, enableNotifications, notificationsEnabled, notifyOnce, notifyState, type NotifyState } from '@/lib/notify';

const SEVERITY: Record<Reminder['severity'], string> = {
  critical: 'border-l-red-500 bg-red-50/60', warning: 'border-l-amber-500 bg-amber-50/50', info: 'border-l-navy-500 bg-navy-50/40',
};
const ICON: Record<Reminder['kind'], string> = { summary: '☀', overdue: '!', due_today: '◷', upcoming: '→', payroll: '₨', month_end: '▣' };

export function ReminderList({ reminders, onPick }: { reminders: Reminder[]; onPick?: () => void }) {
  return (
    <ul className="space-y-2" data-testid="reminder-list">
      {reminders.map((r) => (
        <li key={r.id} className={cx('rounded-lg border-l-4 px-3 py-2.5', SEVERITY[r.severity])} data-testid={`reminder-${r.kind}`}>
          <p className="flex items-center gap-2 text-sm font-semibold text-slate-900"><span aria-hidden className="w-4 text-center text-xs text-slate-500">{ICON[r.kind]}</span>{r.title}</p>
          <p className="mt-0.5 pl-6 text-xs text-slate-600">{r.message}</p>
          {r.tasks.length > 0 && r.kind !== 'summary' && <Link to={r.kind === 'overdue' ? '/tasks/all?view=overdue' : '/tasks'} onClick={onPick} className="mt-1 inline-block pl-6 text-xs font-medium text-navy-700 hover:underline">View tasks →</Link>}
        </li>
      ))}
    </ul>
  );
}

/** 桌面通知開關（只在支援時顯示）。 */
export function NotificationToggle() {
  const [state, setState] = useState<NotifyState>(() => notifyState());
  const [on, setOn] = useState(() => notificationsEnabled());
  if (state === 'unsupported') {
    return <p className="text-xs text-slate-500" data-testid="notify-unsupported">Desktop notifications are not available in this view. Reminders appear here and on My Day every time you open the portal.</p>;
  }
  if (state === 'denied') return <p className="text-xs text-slate-500">Desktop notifications are blocked in your browser settings.</p>;
  return on ? (
    <div className="flex items-center justify-between gap-2 text-xs text-slate-600"><span>Desktop notifications are on.</span>
      <button type="button" className="font-medium text-navy-700 hover:underline" onClick={() => { disableNotifications(); setOn(false); }}>Turn off</button></div>
  ) : (
    <Button size="sm" onClick={async () => { const s = await enableNotifications(); setState(s); setOn(s === 'granted'); }} data-testid="enable-notifications">Turn on desktop notifications</Button>
  );
}

/** 鈴鐺按鈕與下拉面板。 */
export function ReminderBell({ dark }: { dark?: boolean }) {
  const { tasks } = useTasks();
  const today = useToday();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const reminders = useMemo(() => buildReminders(tasks, today), [tasks, today]);
  const badge = reminderBadgeCount(tasks, today);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-label={`Reminders${badge ? `, ${badge} need attention` : ''}`} aria-expanded={open} data-testid="reminder-bell"
        className={cx('relative grid size-9 place-items-center rounded-lg', dark ? 'text-white hover:bg-white/10' : 'text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50')}>
        <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" /></svg>
        {badge > 0 && <span className="absolute -top-1 -right-1 grid h-5 min-w-5 place-items-center rounded-full bg-red-600 px-1 text-[11px] font-bold text-white" data-testid="reminder-badge">{badge > 99 ? '99+' : badge}</span>}
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-slate-200 bg-white p-3 text-slate-900 shadow-xl" role="dialog" aria-label="Reminder Centre" data-testid="reminder-panel">
          <div className="mb-2 flex items-center justify-between px-1">
            <p className="font-display text-sm font-semibold">Reminder Centre</p>
            <Link to="/tasks" onClick={() => setOpen(false)} className="text-xs font-medium text-navy-700 hover:underline">Open Dashboard</Link>
          </div>
          <div className="max-h-[60vh] overflow-y-auto"><ReminderList reminders={reminders} onPick={() => setOpen(false)} /></div>
          <div className="mt-3 border-t border-slate-100 px-1 pt-3"><NotificationToggle /></div>
        </div>
      )}
    </div>
  );
}

const SUMMARY_KEY = 'invoice-ap-ar:daily-summary-dismissed';

/** 每天第一次開啟時的摘要橫幅，並負責送出桌面通知。 */
export function DailySummaryBanner() {
  const { tasks, isSuccess } = useTasks();
  const today = useToday();
  const [dismissed, setDismissed] = useState(() => { try { return localStorage.getItem(SUMMARY_KEY) === today; } catch { return false; } });
  const reminders = useMemo(() => buildReminders(tasks, today), [tasks, today]);
  const open = useMemo(() => tasks.filter(isOpen), [tasks]);
  const dueToday = open.filter((t) => t.dueDate === today).length;
  const overdue = open.filter((t) => t.dueDate < today).length;

  // 桌面通知（若已開啟）：每日摘要一次 + 每個逾期／今天到期任務各一次
  useEffect(() => {
    if (!isSuccess) return;
    const send = () => {
      if (dueToday + overdue > 0) notifyOnce(today, `summary-${today}`, 'Your finance tasks today', `${dueToday} due today, ${overdue} overdue`);
      for (const t of open.filter((x) => x.dueDate <= today).slice(0, 10)) {
        notifyOnce(today, t.id, t.dueDate < today ? `Overdue: ${t.title}` : `Due today: ${t.title}`, `${t.category} · ${t.priority} priority${t.dueDate < today ? ` · was due ${formatDate(t.dueDate)}` : ''}`);
      }
    };
    send();
    const timer = setInterval(send, 5 * 60_000);
    return () => clearInterval(timer);
  }, [isSuccess, today, dueToday, overdue, open]);

  if (dismissed || !isSuccess || (dueToday === 0 && overdue === 0)) return null;
  const summary = reminders.find((r) => r.kind === 'summary');
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-navy-900 px-4 py-3 text-sm text-white" role="status" data-testid="daily-summary">
      <p><strong className="font-semibold">Good to know today:</strong> {summary?.message}</p>
      <div className="flex gap-2">
        <Link to="/tasks" className="rounded-md bg-white px-3 py-1.5 text-xs font-semibold text-navy-900 hover:bg-navy-50">Open Dashboard</Link>
        <button type="button" className="rounded-md px-2 py-1.5 text-xs text-navy-200 hover:text-white" onClick={() => { try { localStorage.setItem(SUMMARY_KEY, today); } catch { /* 略過 */ } setDismissed(true); }}>Dismiss for today</button>
      </div>
    </div>
  );
}

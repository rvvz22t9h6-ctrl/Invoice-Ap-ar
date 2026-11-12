/**
 * 主版面（App layout）：左側海軍藍導覽列 + 右側內容區。
 * 手機版：導覽列收合為頂部選單按鈕，點擊後滑出。
 */
import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { DataBanners, DataManagerModal, downloadBackup, isHosted, isLocalMode, useSaveStatus } from '@/features/data/DataManager';
import { ROLE_LABEL } from '@/domain/types';
import logoUrl from '@/assets/logo.svg';
import { useAuth } from '@/features/auth/AuthContext';
import { useToast } from '@/components/ui/Toast';
import { cx } from '@/components/ui';
import { useSettings } from '@/hooks/useFinanceData';
import { useAutoGenerateTasks, useTasks, useToday } from '@/hooks/useTasks';
import { reminderBadgeCount } from '@/domain/taskInsights';
import { DailySummaryBanner, ReminderBell } from '@/features/tasks/ReminderCentre';

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" className="size-5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={d} /></svg>
);

type NavItem = { to: string; label: string; icon: ReactNode; end?: boolean };
/** 導覽分組：總覽、帳冊、報表、設定。 */
const NAV: { group: string; items: NavItem[] }[] = [
  { group: 'My Day', items: [
    { to: '/tasks', label: 'Today', end: true, icon: <Icon d="M9 11l3 3 8-8M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9" /> },
    { to: '/tasks/calendar', label: 'Calendar', icon: <Icon d="M8 2v4m8-4v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" /> },
    { to: '/tasks/all', label: 'All Tasks', icon: <Icon d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /> },
    { to: '/tasks/recurring', label: 'Recurring Tasks', icon: <Icon d="M17 2l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 22l-4-4 4-4m14-1v2a4 4 0 0 1-4 4H3" /> },
    { to: '/tasks/productivity', label: 'Productivity', icon: <Icon d="M12 20V10M18 20V4M6 20v-4" /> },
  ] },
  { group: 'Overview', items: [
    { to: '/', label: 'Dashboard', end: true, icon: <Icon d="M3 13h8V3H3zm10 8h8V11h-8zM3 21h8v-6H3zm10-18v6h8V3z" /> },
    { to: '/cash-flow', label: 'Cash Flow', icon: <Icon d="M3 17l6-6 4 4 8-8m0 0h-5m5 0v5" /> },
  ] },
  { group: 'Ledgers', items: [
    { to: '/ap', label: 'Accounts Payable', icon: <Icon d="M12 19V5m0 14-6-6m6 6 6-6" /> },
    { to: '/ar', label: 'Accounts Receivable', icon: <Icon d="M12 5v14m0-14 6 6m-6-6-6 6" /> },
    { to: '/contacts', label: 'Suppliers & Customers', icon: <Icon d="M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm13 9v-1a4 4 0 0 0-3-3.87M16 4.13a3 3 0 0 1 0 5.74" /> },
  ] },
  { group: 'Reports', items: [
    { to: '/aging', label: 'Aging Report', icon: <Icon d="M12 7v5l3 3M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" /> },
  ] },
  { group: 'Settings', items: [
    { to: '/settings', label: 'Company Settings', icon: <Icon d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /> },
  ] },
];

export function AppLayout() {
  const { user, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const [dataOpen, setDataOpen] = useState(false);
  const hosted = isHosted();
  const save = useSaveStatus();
  const location = useLocation();
  const toast = useToast();
  const { settings } = useSettings();
  useAutoGenerateTasks();
  const { tasks } = useTasks();
  const today = useToday();
  const attention = reminderBadgeCount(tasks, today);
  const company = settings.companyName || 'Finance Portal';

  // 切換頁面時自動關閉手機選單
  useEffect(() => setOpen(false), [location.pathname]);


  const sidebar = (
    <div className="flex h-full flex-col bg-navy-900 text-navy-100">
      <div className="flex items-center gap-3 px-5 pt-6 pb-5">
        <img src={logoUrl} alt="" className="size-10 rounded-xl ring-1 ring-white/10" />
        <div className="min-w-0 leading-tight">
          <p className="font-display truncate text-[15px] font-semibold text-white" title={company} data-testid="company-name">{company}</p>
          <p className="text-xs text-navy-300">{settings.companyName ? 'Finance Portal · AP & AR' : 'AP & AR Management'}</p>
        </div>
      </div>
      <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-2" aria-label="Main">
        {NAV.map((g) => (
          <div key={g.group}>
            <p className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-navy-400">{g.group}</p>
            <div className="space-y-0.5">
              {g.items.map((n) => (
                <NavLink key={n.to} to={n.to} end={n.end}
                  className={({ isActive }) => cx('relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                    isActive ? 'bg-white/[0.09] text-white before:absolute before:inset-y-1.5 before:left-0 before:w-[3px] before:rounded-full before:bg-[#5b9be6]' : 'text-navy-200 hover:bg-white/5 hover:text-white')}>
                  {n.icon}<span className="flex-1">{n.label}</span>
                  {n.to === '/tasks' && attention > 0 && <span className="rounded-full bg-red-500 px-1.5 text-[11px] font-bold text-white" data-testid="nav-task-badge">{attention}</span>}
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>
      <div className="space-y-3 border-t border-white/10 px-5 py-4">
        {isLocalMode() && (
          <div className="rounded-lg bg-white/5 px-3 py-2.5 text-xs text-navy-200">
            {hosted ? (
              <p className="flex items-center gap-1.5 font-semibold text-white" data-testid="save-status" aria-live="polite">
                <span className={cx('size-2 rounded-full', save?.state === 'error' ? 'bg-red-400' : save?.state === 'saving' ? 'bg-amber-300' : 'bg-emerald-400')} aria-hidden />
                {save?.state === 'error' ? 'Not saved' : save?.state === 'saving' ? 'Saving…' : 'All changes saved'}
              </p>
            ) : <p className="font-semibold text-white">Saved in this browser</p>}
            <p className="mt-0.5">{hosted ? 'Stored in your Claude account.' : 'Back up regularly to keep your data safe.'}</p>
            <div className="mt-2 flex gap-3">
              <button type="button" onClick={async () => { if (await downloadBackup().catch(() => false)) toast('Backup downloaded'); }} className="font-medium text-white underline-offset-2 hover:underline">Backup</button>
              <button type="button" onClick={() => setDataOpen(true)} className="font-medium text-white underline-offset-2 hover:underline" data-testid="open-data-manager">My data…</button>
            </div>
          </div>
        )}
        <div className="flex items-center gap-3">
          <div className="grid size-9 place-items-center rounded-full bg-navy-700 text-sm font-semibold text-white" aria-hidden>
            {user?.fullName.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1 leading-tight">
            <p className="truncate text-sm font-medium text-white" title={user?.fullName}>{user?.fullName}</p>
            <p className="text-xs text-navy-300">{user ? ROLE_LABEL[user.role] : ''}{user?.role === 'viewer' ? ' · read-only' : ''}</p>
          </div>
        </div>
        {!hosted && <button type="button" onClick={signOut} className="w-full rounded-lg px-3 py-2 text-left text-sm text-navy-200 ring-1 ring-white/10 hover:bg-white/5 hover:text-white">Sign out</button>}
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-white lg:pl-64">
      {/* 桌面版側邊欄 */}
      <aside className="fixed inset-y-0 left-0 hidden w-64 lg:block">{sidebar}</aside>

      {/* 手機版頂部列 */}
      <header className="sticky top-[env(safe-area-inset-top,0px)] z-30 flex items-center gap-3 bg-navy-900 px-4 py-3 text-white lg:hidden">
        <button type="button" onClick={() => setOpen(true)} aria-label="Open menu" className="-ml-1 rounded-lg p-1.5 hover:bg-white/10">
          <Icon d="M4 6h16M4 12h16M4 18h16" />
        </button>
        <p className="font-display min-w-0 flex-1 truncate text-sm font-semibold">{company}</p>
        <ReminderBell dark />
      </header>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/60" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] shadow-xl">{sidebar}</aside>
        </div>
      )}

      <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <div className="mb-3 hidden items-center justify-between gap-3 lg:flex">
          <p className="text-xs font-medium text-slate-400">{new Date(`${today}T00:00:00Z`).toLocaleDateString('en-MY', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })} · Malaysia time</p>
          <ReminderBell />
        </div>
        <DailySummaryBanner />
        <DataBanners onManage={() => setDataOpen(true)} />
        <Outlet />
        <DataManagerModal open={dataOpen} onClose={() => setDataOpen(false)} />
      </main>
    </div>
  );
}

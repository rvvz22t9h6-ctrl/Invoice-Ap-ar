/**
 * 主版面（App layout）：左側海軍藍導覽列 + 右側內容區。
 * 手機版：導覽列收合為頂部選單按鈕，點擊後滑出。
 */
import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { repository } from '@/data';
import { requestNew, type QuickKind } from '@/lib/quickRecord';
import { GlobalSearch, SearchButton } from '@/features/search/GlobalSearch';
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
/** 主要功能：每天使用的 6 個項目。 */
const MAIN_NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', end: true, icon: <Icon d="M3 13h8V3H3zm10 8h8V11h-8zM3 21h8v-6H3zm10-18v6h8V3z" /> },
  { to: '/ap', label: 'Accounts Payable', icon: <Icon d="M12 19V5m0 14-6-6m6 6 6-6" /> },
  { to: '/ar', label: 'Accounts Receivable', icon: <Icon d="M12 5v14m0-14 6 6m-6-6-6 6" /> },
  { to: '/payroll', label: 'Payroll', icon: <Icon d="M17 9V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2m2 4h10a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2H9a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2zm7-5a2 2 0 1 1-4 0 2 2 0 0 1 4 0z" /> },
  { to: '/claims', label: 'Staff Claims', icon: <Icon d="M9 14h6m-6-4h6M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16l-3.5-2-3.5 2-3.5-2z" /> },
  { to: '/closing', label: 'Monthly Closing', icon: <Icon d="M9 11l3 3 8-8M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9" /> },
  { to: '/notes', label: 'Notes', icon: <Icon d="M5 4h10l4 4v12H5zM14 4v5h5M8.5 13h7m-7 4h5" /> },
  { to: '/tasks/recurring', label: 'Reminders', icon: <Icon d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" /> },
];

/** 其他功能：收在「More」裡，預設收合，保持側邊欄簡潔。 */
const MORE_NAV: NavItem[] = [
  { to: '/finance', label: 'Finance Overview', icon: <Icon d="M3 17l6-6 4 4 8-8m0 0h-5m5 0v5" /> },
  { to: '/cash-flow', label: 'Cash Flow', icon: <Icon d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /> },
  { to: '/contacts', label: 'Suppliers & Customers', icon: <Icon d="M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" /> },
  { to: '/aging', label: 'Aging Report', icon: <Icon d="M12 7v5l3 3M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" /> },
  { to: '/tasks/calendar', label: 'Task Calendar', icon: <Icon d="M8 2v4m8-4v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" /> },
  { to: '/tasks/all', label: 'All Tasks', icon: <Icon d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /> },
  { to: '/tasks/productivity', label: 'Productivity', icon: <Icon d="M12 20V10M18 20V4M6 20v-4" /> },
  { to: '/settings', label: 'Company Settings', icon: <Icon d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" /> },
];
const MORE_KEY = 'invoice-ap-ar:nav-more-open';

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
  // 「More」展開狀態：記在此裝置；目前頁面在 More 內時自動展開
  const inMore = MORE_NAV.some((n) => location.pathname === n.to);
  const [moreSaved, setMoreSaved] = useState(() => { try { return localStorage.getItem(MORE_KEY) === '1'; } catch { return false; } });
  const moreOpen = moreSaved || inMore;
  const toggleMore = () => { const next = !moreOpen; setMoreSaved(next); try { localStorage.setItem(MORE_KEY, next ? '1' : '0'); } catch { /* 略過 */ } };
  const navLink = (n: NavItem) => (
    <NavLink key={n.to} to={n.to} end={n.end}
      className={({ isActive }) => cx('relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
        isActive ? 'bg-white text-navy-900 shadow-[0_6px_16px_-8px_rgba(111,84,176,0.55)] before:absolute before:inset-y-1.5 before:left-0 before:w-[3px] before:rounded-full before:bg-navy-500' : 'text-navy-800 hover:bg-white/60 hover:text-navy-950')}>
      {n.icon}<span className="flex-1">{n.label}</span>
      {n.to === '/' && attention > 0 && <span aria-hidden title={`${attention} tasks need attention`} className="rounded-full bg-red-500 px-1.5 text-[11px] font-bold text-white" data-testid="nav-task-badge">{attention}</span>}
    </NavLink>
  );
  const company = settings.companyName || 'Finance Portal';

  // 全域搜尋：Ctrl/⌘+K 或「/」開啟（正在輸入文字時不攔截「/」）
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
      if ((e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey)) { e.preventDefault(); setSearching(true); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const searchPages = [...MAIN_NAV, ...MORE_NAV].filter((n) => n.to !== '/notes' || repository.notesAvailable()).map((n) => ({ to: n.to, label: n.label }));

  // 切換頁面時自動關閉手機選單
  useEffect(() => setOpen(false), [location.pathname]);


  const sidebar = (
    <div className="pastel-panel flex h-full flex-col text-navy-800">
      <div className="flex items-center gap-3 px-5 pt-6 pb-5">
        <img src={logoUrl} alt="" className="size-10 rounded-xl shadow-[0_6px_14px_-6px_rgba(111,84,176,0.6)] ring-2 ring-white/80" />
        <div className="min-w-0 leading-tight">
          <p className="font-display truncate text-[15px] font-semibold text-navy-950" title={company} data-testid="company-name">{company}</p>
          <p className="text-xs text-navy-600">{settings.companyName ? 'Finance Portal · AP & AR' : 'AP & AR Management'}</p>
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto px-3 py-2" aria-label="Main">
        <div className="space-y-0.5">{MAIN_NAV.filter((n) => n.to !== '/notes' || repository.notesAvailable()).map(navLink)}</div>
        <button type="button" onClick={toggleMore} aria-expanded={moreOpen} data-testid="nav-more"
          className="mt-5 flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-navy-500 hover:text-navy-700">
          More <span aria-hidden className={cx('transition-transform', moreOpen && 'rotate-90')}>›</span>
        </button>
        {moreOpen && <div className="mt-1 space-y-0.5">{MORE_NAV.map(navLink)}</div>}
      </nav>
      <div className="space-y-3 border-t border-navy-200/70 px-5 py-4">
        {isLocalMode() && (
          <div className="rounded-xl bg-white/65 px-3 py-2.5 text-xs text-navy-700 ring-1 ring-white">
            {hosted ? (
              <p className="flex items-center gap-1.5 font-semibold text-navy-950" data-testid="save-status" aria-live="polite">
                <span className={cx('size-2 rounded-full', save?.state === 'error' ? 'bg-red-400' : save?.state === 'saving' ? 'bg-amber-400' : 'bg-emerald-500')} aria-hidden />
                {save?.state === 'error' ? 'Not saved' : save?.state === 'saving' ? 'Saving…' : 'All changes saved'}
              </p>
            ) : <p className="font-semibold text-navy-950">Saved in this browser</p>}
            <p className="mt-0.5">{hosted ? 'Stored in your Claude account.' : 'Back up regularly to keep your data safe.'}</p>
            <div className="mt-2 flex gap-3">
              <button type="button" onClick={async () => { if (await downloadBackup().catch(() => false)) toast('Backup downloaded'); }} className="font-medium text-navy-700 underline-offset-2 hover:underline">Backup</button>
              <button type="button" onClick={() => setDataOpen(true)} className="font-medium text-navy-700 underline-offset-2 hover:underline" data-testid="open-data-manager">My data…</button>
            </div>
          </div>
        )}
        <div className="flex items-center gap-3">
          <div className="grid size-9 place-items-center rounded-full bg-gradient-to-br from-navy-400 to-navy-600 text-sm font-semibold text-white shadow-sm" aria-hidden>
            {user?.fullName.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1 leading-tight">
            <p className="truncate text-sm font-medium text-navy-950" title={user?.fullName}>{user?.fullName}</p>
            <p className="text-xs text-navy-600">{user ? ROLE_LABEL[user.role] : ''}{user?.role === 'viewer' ? ' · read-only' : ''}</p>
          </div>
        </div>
        {!hosted && <button type="button" onClick={signOut} className="w-full rounded-lg px-3 py-2 text-left text-sm text-navy-700 ring-1 ring-navy-200 hover:bg-white/60 hover:text-navy-950">Sign out</button>}
      </div>
    </div>
  );

  return (
    <div className="min-h-screen lg:pl-64">
      {/* 桌面版側邊欄 */}
      <aside className="fixed inset-y-0 left-0 hidden w-64 lg:block">{sidebar}</aside>

      {/* 手機版頂部列 */}
      <header className="sticky top-[env(safe-area-inset-top,0px)] z-30 flex items-center gap-3 deep-panel px-4 py-3 text-white lg:hidden">
        <button type="button" onClick={() => setOpen(true)} aria-label="Open menu" className="-ml-1 rounded-lg p-1.5 hover:bg-white/10">
          <Icon d="M4 6h16M4 12h16M4 18h16" />
        </button>
        <p className="font-display min-w-0 flex-1 truncate text-sm font-semibold">{company}</p>
        <SearchButton compact onClick={() => setSearching(true)} />
        <ReminderBell dark />
      </header>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/60" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] shadow-xl">{sidebar}</aside>
        </div>
      )}

      <main className="mx-auto max-w-[1400px] px-4 pt-6 pb-28 sm:px-6 lg:px-8 lg:py-8">
        <div className="mb-3 hidden items-center justify-between gap-3 lg:flex">
          <p className="text-xs font-medium text-slate-400">{new Date(`${today}T00:00:00Z`).toLocaleDateString('en-MY', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })} · Malaysia time</p>
          <div className="flex flex-1 items-center justify-end gap-3"><SearchButton onClick={() => setSearching(true)} /><ReminderBell /></div>
        </div>
        <DailySummaryBanner />
        <DataBanners onManage={() => setDataOpen(true)} />
        <Outlet />
        <DataManagerModal open={dataOpen} onClose={() => setDataOpen(false)} />
      </main>
      {searching && <GlobalSearch pages={searchPages} onClose={() => setSearching(false)} />}
      <MobileBar canRecord={user?.role !== 'viewer' && !!user} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 手機底部列：常用頁面 + 中央「＋」快速記錄（像 App 一樣，單手可操作）
// ---------------------------------------------------------------------------

const TABS: { to: string; label: string; d: string; end?: boolean }[] = [
  { to: '/', label: 'Home', end: true, d: 'M3 11.5 12 4l9 7.5M5.5 10v9.5h13V10' },
  { to: '/ap', label: 'Payable', d: 'M12 19V5m0 14-6-6m6 6 6-6' },
  { to: '/ar', label: 'Receivable', d: 'M12 5v14m0-14 6 6m-6-6-6 6' },
  { to: '/claims', label: 'Claims', d: 'M9 14h6m-6-4h6M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16l-3.5-2-3.5 2-3.5-2z' },
];

const QUICK: { kind: QuickKind; to: string; title: string; hint: string; emoji: string; tint: string }[] = [
  { kind: 'claim', to: '/claims', title: 'Staff claim', hint: 'Snap the receipt and the details fill in', emoji: '🧾', tint: 'bg-[#fde6ec]' },
  { kind: 'task', to: '/', title: 'Task or reminder', hint: 'Something to do or follow up', emoji: '✅', tint: 'bg-[#e3f5ec]' },
  { kind: 'note', to: '/notes', title: 'Note', hint: 'Anything you need to remember (private)', emoji: '📝', tint: 'bg-[#fff8d6]' },
  { kind: 'ap', to: '/ap', title: 'Supplier bill (AP)', hint: 'A bill your company has to pay', emoji: '📥', tint: 'bg-[#ede5fa]' },
  { kind: 'ar', to: '/ar', title: 'Customer invoice (AR)', hint: 'Money a customer owes you', emoji: '📤', tint: 'bg-[#e4f1fb]' },
];

function MobileBar({ canRecord }: { canRecord: boolean }) {
  const [sheet, setSheet] = useState(false);
  const navigate = useNavigate();
  const pick = (q: (typeof QUICK)[number]) => {
    setSheet(false);
    requestNew(q.kind);
    navigate(q.to);
  };
  const tab = (t: (typeof TABS)[number]) => (
    <NavLink key={t.to} to={t.to} end={t.end} data-testid={`tab-${t.label.toLowerCase()}`}
      className={({ isActive }) => cx('flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-semibold', isActive ? 'text-navy-700' : 'text-slate-500')}>
      {({ isActive }) => (<>
        <span className={cx('grid h-7 w-12 place-items-center rounded-full transition-colors', isActive && 'bg-navy-100')}><Icon d={t.d} /></span>
        {t.label}
      </>)}
    </NavLink>
  );
  return (
    <>
      <nav aria-label="Quick" className="fixed inset-x-0 bottom-0 z-30 border-t border-navy-100 bg-white/90 pb-[env(safe-area-inset-bottom,0px)] shadow-[0_-8px_24px_-12px_rgba(111,84,176,0.35)] backdrop-blur lg:hidden" data-testid="mobile-bar">
        <div className="mx-auto flex max-w-md items-end px-2">
          {TABS.slice(0, 2).map(tab)}
          {canRecord && (
            <div className="flex flex-1 justify-center">
              <button type="button" onClick={() => setSheet(true)} aria-label="Record something new" data-testid="quick-record"
                className="-mt-5 mb-1.5 grid size-14 place-items-center rounded-full bg-gradient-to-br from-navy-400 to-navy-600 text-white shadow-[0_10px_20px_-6px_rgba(111,84,176,0.7)] ring-4 ring-white active:scale-95">
                <svg viewBox="0 0 24 24" className="size-7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden><path d="M12 5v14M5 12h14" /></svg>
              </button>
            </div>
          )}
          {TABS.slice(2).map(tab)}
        </div>
      </nav>
      {sheet && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-label="Record something new" data-testid="quick-sheet">
          <div className="absolute inset-0 bg-slate-900/50" onClick={() => setSheet(false)} />
          <div className="absolute inset-x-0 bottom-0 rounded-t-3xl bg-white px-4 pt-3 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] shadow-2xl">
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-slate-200" aria-hidden />
            <p className="font-display px-1 text-lg font-semibold text-navy-950">What do you want to record?</p>
            <ul className="mt-3 space-y-2">
              {QUICK.map((q) => (
                <li key={q.kind}>
                  <button type="button" onClick={() => pick(q)} data-testid={`quick-${q.kind}`}
                    className="flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left ring-1 ring-slate-200 active:bg-navy-50">
                    <span className={cx('grid size-11 shrink-0 place-items-center rounded-xl text-xl', q.tint)} aria-hidden>{q.emoji}</span>
                    <span className="min-w-0 flex-1"><span className="block text-sm font-semibold text-slate-900">{q.title}</span><span className="block text-xs text-slate-500">{q.hint}</span></span>
                    <span className="text-slate-400" aria-hidden>›</span>
                  </button>
                </li>
              ))}
            </ul>
            <button type="button" onClick={() => setSheet(false)} className="mt-3 w-full rounded-xl py-2.5 text-sm font-medium text-slate-600">Cancel</button>
          </div>
        </div>
      )}
    </>
  );
}

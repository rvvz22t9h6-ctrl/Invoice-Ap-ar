/**
 * 主版面（App layout）：左側海軍藍導覽列 + 右側內容區。
 * 手機版：導覽列收合為頂部選單按鈕，點擊後滑出。
 */
import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { repository } from '@/data';
import { ROLE_LABEL } from '@/domain/types';
import { formatDate } from '@/domain/dates';
import { useAuth } from '@/features/auth/AuthContext';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/components/ui/Toast';
import { cx } from '@/components/ui';

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" className="size-5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={d} /></svg>
);

const NAV: { to: string; label: string; icon: ReactNode; end?: boolean }[] = [
  { to: '/', label: 'Dashboard', end: true, icon: <Icon d="M3 13h8V3H3zm10 8h8V11h-8zM3 21h8v-6H3zm10-18v6h8V3z" /> },
  { to: '/ap', label: 'Accounts Payable', icon: <Icon d="M12 19V5m0 14-6-6m6 6 6-6" /> },
  { to: '/ar', label: 'Accounts Receivable', icon: <Icon d="M12 5v14m0-14 6 6m-6-6-6 6" /> },
  { to: '/aging', label: 'Aging Report', icon: <Icon d="M12 7v5l3 3M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" /> },
];

export function AppLayout() {
  const { user, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const qc = useQueryClient();
  const toast = useToast();

  // 切換頁面時自動關閉手機選單
  useEffect(() => setOpen(false), [location.pathname]);

  const resetDemo = async () => {
    if (!repository.resetDemoData || !confirm('Reset all demo data to the original sample set? Your changes will be lost.')) return;
    await repository.resetDemoData();
    await qc.invalidateQueries();
    toast('Demo data has been reset');
  };

  const sidebar = (
    <div className="flex h-full flex-col bg-navy-900 text-navy-100">
      <div className="flex items-center gap-3 px-5 py-5">
        <img src="/favicon.svg" alt="" className="size-9 rounded-lg ring-1 ring-white/10" />
        <div className="leading-tight">
          <p className="text-sm font-semibold text-white">Finance Portal</p>
          <p className="text-xs text-navy-300">AP &amp; AR Management</p>
        </div>
      </div>
      <nav className="flex-1 space-y-1 px-3 py-2" aria-label="Main">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end}
            className={({ isActive }) => cx('flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
              isActive ? 'bg-white/10 text-white shadow-inner' : 'text-navy-200 hover:bg-white/5 hover:text-white')}>
            {n.icon}{n.label}
          </NavLink>
        ))}
      </nav>
      <div className="space-y-3 border-t border-white/10 px-5 py-4">
        {repository.mode === 'demo' && (
          <div className="rounded-lg bg-white/5 px-3 py-2 text-xs text-navy-200">
            <p className="font-semibold text-amber-300">Demo mode</p>
            <p className="mt-0.5">Sample data stored in this browser.</p>
            <button type="button" onClick={resetDemo} className="mt-1.5 font-medium text-white underline-offset-2 hover:underline">Reset demo data</button>
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
        <button type="button" onClick={signOut} className="w-full rounded-lg px-3 py-2 text-left text-sm text-navy-200 ring-1 ring-white/10 hover:bg-white/5 hover:text-white">Sign out</button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-white lg:pl-64">
      {/* 桌面版側邊欄 */}
      <aside className="fixed inset-y-0 left-0 hidden w-64 lg:block">{sidebar}</aside>

      {/* 手機版頂部列 */}
      <header className="sticky top-0 z-30 flex items-center gap-3 bg-navy-900 px-4 py-3 text-white lg:hidden">
        <button type="button" onClick={() => setOpen(true)} aria-label="Open menu" className="-ml-1 rounded-lg p-1.5 hover:bg-white/10">
          <Icon d="M4 6h16M4 12h16M4 18h16" />
        </button>
        <p className="text-sm font-semibold">Finance Portal</p>
      </header>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/60" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] shadow-xl">{sidebar}</aside>
        </div>
      )}

      <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <p className="mb-1 text-xs font-medium text-slate-400">Today · {formatDate(repository.today())} (MYT)</p>
        <Outlet />
      </main>
    </div>
  );
}

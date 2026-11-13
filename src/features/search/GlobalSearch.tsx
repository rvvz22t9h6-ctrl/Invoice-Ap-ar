/**
 * 全域搜尋視窗：輸入發票號碼、名稱或金額，一次搜尋發票、報銷、任務、筆記、供應商／客戶與頁面。
 * 開啟方式：頂端的搜尋按鈕，或鍵盤 Ctrl/⌘ + K、「/」。方向鍵選擇、Enter 開啟、Esc 關閉。
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { cx } from '@/components/ui';
import { repository } from '@/data';
import { search, type SearchHit, type SearchKind } from '@/domain/search';
import { useClaims } from '@/features/claims/ClaimsPage';
import { useCounterparties, useInvoices } from '@/hooks/useFinanceData';
import { useTasks } from '@/hooks/useTasks';
import { requestOpen } from '@/lib/quickRecord';

const ICON: Record<SearchKind, { emoji: string; tint: string }> = {
  ap: { emoji: '📥', tint: 'bg-[#fdeeea]' }, ar: { emoji: '📤', tint: 'bg-[#e8f3fb]' }, claim: { emoji: '🧾', tint: 'bg-[#fde6ec]' },
  task: { emoji: '✅', tint: 'bg-[#e3f5ec]' }, note: { emoji: '📝', tint: 'bg-[#fff8d6]' }, contact: { emoji: '👤', tint: 'bg-[#ede5fa]' }, page: { emoji: '➜', tint: 'bg-slate-100' },
};

export function SearchButton({ onClick, compact }: { onClick: () => void; compact?: boolean }) {
  if (compact) {
    return (
      <button type="button" onClick={onClick} aria-label="Search" data-testid="search-open-mobile" className="grid size-9 place-items-center rounded-lg text-white hover:bg-white/10">
        <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></svg>
      </button>
    );
  }
  return (
    <button type="button" onClick={onClick} data-testid="search-open"
      className="flex w-full max-w-md items-center gap-2 rounded-xl bg-white px-3.5 py-2 text-left text-sm text-slate-400 shadow-sm ring-1 ring-slate-200 hover:ring-navy-300">
      <svg viewBox="0 0 24 24" className="size-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></svg>
      <span className="flex-1">Search invoices, claims, tasks, notes…</span>
      <kbd className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500">Ctrl K</kbd>
    </button>
  );
}

export function GlobalSearch({ pages, onClose }: { pages: { to: string; label: string }[]; onClose: () => void }) {
  const navigate = useNavigate();
  const { invoices } = useInvoices();
  const { claims } = useClaims();
  const { tasks } = useTasks();
  const parties = useCounterparties();
  const notesOn = repository.notesAvailable();
  const notes = useQuery({ queryKey: ['notes'], queryFn: () => repository.listNotes(), enabled: notesOn });
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { input.current?.focus(); }, []);

  const groups = useMemo(() => search(query, { invoices, claims, tasks, notes: notesOn ? notes.data ?? [] : [], counterparties: parties.data ?? [], pages }),
    [query, invoices, claims, tasks, notes.data, notesOn, parties.data, pages]);
  const flat = useMemo(() => groups.flatMap((g) => g.hits), [groups]);
  useEffect(() => setActive(0), [query]);
  useEffect(() => { list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' }); }, [active]);

  const go = (h: SearchHit) => {
    onClose();
    if (h.kind !== 'page') requestOpen(h.kind, h.id);
    navigate(h.to);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, flat.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter' && flat[active]) { e.preventDefault(); go(flat[active]!); }
  };
  const typed = query.trim().length >= 2;
  let index = -1;
  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center px-3 pt-[8vh] sm:pt-[12vh]" role="dialog" aria-modal="true" aria-label="Search" data-testid="search-dialog" onKeyDown={onKey}>
      <div className="absolute inset-0 bg-slate-900/45 backdrop-blur-[2px]" onClick={onClose} />
      <div className="relative w-full max-w-xl overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-navy-100">
        <div className="flex items-center gap-3 border-b border-slate-100 px-4">
          <svg viewBox="0 0 24 24" className="size-5 shrink-0 text-navy-500" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></svg>
          <input ref={input} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Invoice number, name, amount, or any word" aria-label="Search everything" data-testid="search-input"
            className="w-full border-0 bg-transparent py-4 text-base text-slate-900 placeholder:text-slate-400 focus:ring-0 focus:outline-none" autoComplete="off" />
          <button type="button" onClick={onClose} className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-slate-500 ring-1 ring-slate-200 hover:bg-slate-50">Esc</button>
        </div>
        <div ref={list} className="max-h-[60vh] overflow-y-auto p-2" data-testid="search-results">
          {!typed && <p className="px-3 py-6 text-center text-sm text-slate-500">Type at least 2 characters. Try an invoice number, a supplier or staff name, or an amount like 1250.00.</p>}
          {typed && groups.length === 0 && <p className="px-3 py-6 text-center text-sm text-slate-500" data-testid="search-none">Nothing found for “{query.trim()}”.</p>}
          {groups.map((g) => (
            <section key={g.kind} className="mb-1">
              <h3 className="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400">{g.label}{g.total > g.hits.length ? ` · showing ${g.hits.length} of ${g.total}` : ''}</h3>
              <ul>
                {g.hits.map((h) => {
                  index += 1;
                  const i = index;
                  return (
                    <li key={`${h.kind}-${h.id}`}>
                      <button type="button" onClick={() => go(h)} onMouseEnter={() => setActive(i)} data-active={i === active} data-testid="search-hit"
                        className={cx('flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left', i === active ? 'bg-navy-50' : 'hover:bg-slate-50')}>
                        <span className={cx('grid size-9 shrink-0 place-items-center rounded-lg text-base', ICON[h.kind].tint)} aria-hidden>{ICON[h.kind].emoji}</span>
                        <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-slate-900">{h.title}</span><span className="block truncate text-xs text-slate-500">{h.subtitle}</span></span>
                        {h.meta && <span className="tabular shrink-0 text-xs font-semibold text-slate-600">{h.meta}</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

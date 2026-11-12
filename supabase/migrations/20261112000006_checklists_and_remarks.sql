-- =============================================================================
-- 簡化版功能：發票備註、薪資與月結每月檢查清單
-- =============================================================================

alter table public.invoices
  add column remarks text not null default '' check (char_length(remarks) <= 1000);

-- 每月一份清單：id = <payroll|closing>-<YYYY-MM>，同一月份不會重複
create table public.checklists (
  id          text primary key,
  kind        text not null check (kind in ('payroll', 'closing')),
  month       text not null check (month ~ '^\d{4}-\d{2}$'),
  items       jsonb not null default '[]'::jsonb check (jsonb_typeof(items) = 'array'),
  remarks     text not null default '' check (char_length(remarks) <= 2000),
  due_date    date not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint checklists_id_matches check (id = kind || '-' || month),
  unique (kind, month)
);

alter table public.checklists enable row level security;
create policy "checklists: staff read" on public.checklists for select to authenticated using (public.current_app_role() is not null);
create policy "checklists: finance write" on public.checklists for all to authenticated
  using (public.current_app_role() in ('admin', 'finance')) with check (public.current_app_role() in ('admin', 'finance'));
revoke all on public.checklists from anon;
grant select, insert, update, delete on public.checklists to authenticated;

-- =============================================================================
-- 私人筆記（Notes）：只有建立者本人可以讀寫；檢視者（viewer）不可使用。
-- =============================================================================

create table public.notes (
  id          text primary key check (char_length(id) between 1 and 200),
  title       text not null check (char_length(title) between 1 and 120),
  body        text not null default '' check (char_length(body) <= 5000),
  category    text not null default 'General' check (category in ('General', 'AP', 'AR', 'Payroll', 'Claims', 'Closing', 'Banking')),
  pinned      boolean not null default false,
  created_by  uuid not null references public.profiles (id) on delete cascade default auth.uid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index notes_owner_idx on public.notes (created_by, updated_at desc);

alter table public.notes enable row level security;
create policy "notes: owner only" on public.notes for all to authenticated
  using (created_by = auth.uid() and public.current_app_role() in ('admin', 'finance'))
  with check (created_by = auth.uid() and public.current_app_role() in ('admin', 'finance'));
revoke all on public.notes from anon;
grant select, insert, update, delete on public.notes to authenticated;

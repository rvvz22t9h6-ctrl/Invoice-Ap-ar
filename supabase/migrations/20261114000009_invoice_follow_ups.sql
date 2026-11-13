-- =============================================================================
-- 催款／付款跟進紀錄（Follow-ups）：每張發票可有多筆
-- =============================================================================

create table public.invoice_follow_ups (
  id              text primary key check (char_length(id) between 1 and 200),
  -- 發票刪除時，跟進紀錄一併刪除
  invoice_id      uuid not null references public.invoices (id) on delete cascade,
  follow_up_date  date not null,
  contact         text not null default '' check (char_length(contact) <= 80),
  note            text not null check (char_length(btrim(note)) between 1 and 500),
  promised_date   date,
  next_date       date,
  created_by      uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at      timestamptz not null default now(),
  constraint follow_ups_next_after check (next_date is null or next_date >= follow_up_date)
);
create index invoice_follow_ups_invoice_idx on public.invoice_follow_ups (invoice_id, follow_up_date desc);

alter table public.invoice_follow_ups enable row level security;
create policy "follow_ups: staff read" on public.invoice_follow_ups for select to authenticated using (public.current_app_role() is not null);
create policy "follow_ups: finance write" on public.invoice_follow_ups for all to authenticated
  using (public.current_app_role() in ('admin', 'finance')) with check (public.current_app_role() in ('admin', 'finance'));
revoke all on public.invoice_follow_ups from anon;
grant select, insert, update, delete on public.invoice_follow_ups to authenticated;

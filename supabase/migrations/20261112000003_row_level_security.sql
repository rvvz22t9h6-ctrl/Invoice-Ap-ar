-- =============================================================================
-- 資料列層級安全性（Row Level Security）
--
--   角色        讀取     新增／修改              刪除／沖銷         審批 AP
--   viewer      ✓        ✗                      ✗                  ✗
--   finance     ✓        ✓                      ✗                  ✗
--   admin       ✓        ✓                      ✓                  ✓
--
-- 未登入（anon）無任何權限。沒有 profile 的帳號也無法讀取資料。
-- =============================================================================

alter table public.profiles       enable row level security;
alter table public.counterparties enable row level security;
alter table public.invoices       enable row level security;
alter table public.payments       enable row level security;
alter table public.activity_log   enable row level security;

-- ---------- profiles ----------
create policy "profiles: read own or admin reads all" on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.current_app_role() = 'admin');

create policy "profiles: admin updates" on public.profiles
  for update to authenticated
  using (public.current_app_role() = 'admin')
  with check (public.current_app_role() = 'admin');

-- 使用者可更新自己的姓名（角色變更由 profiles_guard 觸發器阻擋）
create policy "profiles: update own name" on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- ---------- counterparties ----------
create policy "counterparties: staff read" on public.counterparties
  for select to authenticated using (public.current_app_role() is not null);
create policy "counterparties: finance insert" on public.counterparties
  for insert to authenticated with check (public.current_app_role() in ('admin', 'finance'));
create policy "counterparties: finance update" on public.counterparties
  for update to authenticated
  using (public.current_app_role() in ('admin', 'finance'))
  with check (public.current_app_role() in ('admin', 'finance'));
create policy "counterparties: admin delete" on public.counterparties
  for delete to authenticated using (public.current_app_role() = 'admin');

-- ---------- invoices ----------
create policy "invoices: staff read" on public.invoices
  for select to authenticated using (public.current_app_role() is not null);
create policy "invoices: finance insert" on public.invoices
  for insert to authenticated with check (public.current_app_role() in ('admin', 'finance'));
create policy "invoices: finance update" on public.invoices
  for update to authenticated
  using (public.current_app_role() in ('admin', 'finance'))
  with check (public.current_app_role() in ('admin', 'finance'));
create policy "invoices: admin delete" on public.invoices
  for delete to authenticated using (public.current_app_role() = 'admin');

-- ---------- payments（不開放 update：付款紀錄不可修改）----------
create policy "payments: staff read" on public.payments
  for select to authenticated using (public.current_app_role() is not null);
create policy "payments: finance insert" on public.payments
  for insert to authenticated with check (public.current_app_role() in ('admin', 'finance'));
create policy "payments: admin reverse" on public.payments
  for delete to authenticated using (public.current_app_role() = 'admin');

-- ---------- activity_log（只能讀取；寫入僅能經由觸發器）----------
create policy "activity: staff read" on public.activity_log
  for select to authenticated using (public.current_app_role() is not null);

-- ---------- 權限授予 ----------
revoke all on public.profiles, public.counterparties, public.invoices, public.payments, public.activity_log from anon;
revoke all on public.invoice_balances from anon;
grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.counterparties, public.invoices to authenticated;
grant select, insert, delete on public.payments to authenticated;
grant select on public.activity_log, public.invoice_balances to authenticated;
revoke execute on function public.log_activity(uuid, text, text) from public, anon, authenticated;

-- =============================================================================
-- 發票應付／應收管理系統：資料庫結構（Schema）
--
-- 設計原則：
--   1. 「已付金額」「未付餘額」「付款狀態」不儲存，一律由付款紀錄計算，避免資料不一致。
--   2. 總金額 total_amount 為「產生欄位」= invoice_amount + tax_amount，不可能算錯。
--   3. 金額使用 numeric(14,2)，避免浮點誤差。
--   4. 重要業務規則（重複號碼、超額付款、審批）由資料庫強制執行，前端無法繞過。
-- =============================================================================

-- ---------- 列舉型別 ----------
create type public.app_role as enum ('admin', 'finance', 'viewer');          -- 使用者角色
create type public.invoice_type as enum ('AP', 'AR');                         -- 應付／應收
create type public.counterparty_kind as enum ('supplier', 'customer');        -- 供應商／客戶
create type public.approval_status as enum ('pending', 'approved', 'rejected'); -- AP 審批狀態

-- ---------- 使用者資料（對應 Supabase auth.users）----------
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text not null default '',
  full_name   text not null default '',
  role        public.app_role not null default 'viewer',   -- 新使用者預設唯讀，由管理員提升權限
  created_at  timestamptz not null default now()
);

-- ---------- 往來對象：供應商與客戶 ----------
create table public.counterparties (
  id          uuid primary key default gen_random_uuid(),
  kind        public.counterparty_kind not null,
  name        text not null check (char_length(btrim(name)) between 2 and 150),
  email       text,
  phone       text,
  created_at  timestamptz not null default now(),
  unique (id, kind)  -- 供發票的複合外鍵使用，確保 AP 只能連到供應商、AR 只能連到客戶
);
-- 同類別名稱不可重複（忽略大小寫與前後空白）
create unique index counterparties_kind_name_uq on public.counterparties (kind, lower(btrim(name)));

-- ---------- 發票主檔 ----------
create table public.invoices (
  id                 uuid primary key default gen_random_uuid(),
  invoice_type       public.invoice_type not null,
  invoice_number     text not null check (char_length(btrim(invoice_number)) between 1 and 50),
  counterparty_id    uuid not null,
  -- 依發票類別自動推得對象類別：AP → supplier、AR → customer
  counterparty_kind  public.counterparty_kind generated always as (
                       case invoice_type when 'AP' then 'supplier'::public.counterparty_kind
                                         else 'customer'::public.counterparty_kind end) stored,
  invoice_date       date not null,
  due_date           date not null,
  description        text not null default '' check (char_length(description) <= 500),
  invoice_amount     numeric(14,2) not null check (invoice_amount > 0),
  tax_amount         numeric(14,2) not null default 0 check (tax_amount >= 0),
  total_amount       numeric(14,2) generated always as (invoice_amount + tax_amount) stored,
  -- 審批狀態：僅 AP 使用，與付款狀態分開
  approval_status    public.approval_status,
  approved_by        uuid references public.profiles (id) on delete set null,
  approved_at        timestamptz,
  is_cancelled       boolean not null default false,
  cancelled_at       timestamptz,
  cancel_reason      text not null default '',
  created_by         uuid references public.profiles (id) on delete set null,
  updated_by         uuid references public.profiles (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint invoices_counterparty_fk foreign key (counterparty_id, counterparty_kind)
    references public.counterparties (id, kind) on delete restrict,
  constraint invoices_due_after_invoice check (due_date >= invoice_date),
  constraint invoices_approval_only_ap check (
    (invoice_type = 'AP' and approval_status is not null) or (invoice_type = 'AR' and approval_status is null))
);

-- 重複發票號碼檢查：
--   AR（本公司開立）→ 全部 AR 發票號碼唯一
--   AP（供應商開立）→ 同一供應商內唯一（不同供應商可有相同號碼）
create unique index invoices_ar_number_uq on public.invoices (lower(btrim(invoice_number)))
  where invoice_type = 'AR';
create unique index invoices_ap_number_uq on public.invoices (counterparty_id, lower(btrim(invoice_number)))
  where invoice_type = 'AP';
create index invoices_type_due_idx on public.invoices (invoice_type, due_date);
create index invoices_counterparty_idx on public.invoices (counterparty_id);

-- ---------- 付款紀錄（AP 付款／AR 收款）----------
create table public.payments (
  id            uuid primary key default gen_random_uuid(),
  -- on delete restrict：有付款的發票不可刪除，須先沖銷付款
  invoice_id    uuid not null references public.invoices (id) on delete restrict,
  payment_date  date not null,
  amount        numeric(14,2) not null check (amount > 0),
  method        text not null check (char_length(btrim(method)) between 1 and 50),
  reference     text not null default '' check (char_length(reference) <= 100),
  notes         text not null default '' check (char_length(notes) <= 500),
  created_by    uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now()
);
create index payments_invoice_idx on public.payments (invoice_id);
create index payments_date_idx on public.payments (payment_date);

-- ---------- 活動紀錄（由觸發器自動寫入，作為稽核軌跡）----------
create table public.activity_log (
  id          bigint generated always as identity primary key,
  invoice_id  uuid references public.invoices (id) on delete set null,
  action      text not null,
  summary     text not null,
  actor_id    uuid references public.profiles (id) on delete set null,
  actor_name  text,
  created_at  timestamptz not null default now()
);
create index activity_log_created_idx on public.activity_log (created_at desc);

-- ---------- 報表用檢視：每張發票的已付與未付金額 ----------
-- security_invoker = true：查詢者須通過底層資料表的 RLS 權限
create view public.invoice_balances with (security_invoker = true) as
select
  i.*,
  coalesce(p.paid, 0)::numeric(14,2) as amount_paid,
  case when i.is_cancelled then 0 else greatest(i.total_amount - coalesce(p.paid, 0), 0) end::numeric(14,2)
    as outstanding_balance
from public.invoices i
left join (select invoice_id, sum(amount) as paid from public.payments group by invoice_id) p
  on p.invoice_id = i.id;

-- =============================================================================
-- 員工報銷（Staff Claims）
-- 單層流程：submitted（待核准）→ approved（已核准、待付款）→ paid（已付款），或 rejected（退回）
-- 金額為整數仙（Sen）。
-- =============================================================================

create table public.staff_claims (
  id               text primary key check (char_length(id) between 1 and 200),
  claim_no         text not null unique check (claim_no ~ '^CL-\d{4}-\d{3,}$'),
  staff_name       text not null check (char_length(btrim(staff_name)) between 1 and 80),
  expense_date     date not null,
  category         text not null check (category in ('Mileage', 'Petrol', 'Parking & Toll', 'Travel & Accommodation', 'Meals & Entertainment',
                                                     'Medical', 'Phone & Internet', 'Office Supplies', 'Training', 'Others')),
  description      text not null check (char_length(description) between 1 and 200),
  amount_sen       bigint not null check (amount_sen > 0),
  mileage_km       numeric(8, 1) check (mileage_km is null or mileage_km > 0),
  rate_per_km_sen  integer check (rate_per_km_sen is null or rate_per_km_sen > 0),
  has_receipt      boolean not null default false,
  receipt          jsonb,
  status           text not null default 'submitted' check (status in ('submitted', 'approved', 'rejected', 'paid')),
  decided_on       date,
  reject_reason    text not null default '' check (char_length(reject_reason) <= 300),
  paid_date        date,
  pay_method       text check (pay_method is null or pay_method in ('With salary', 'Bank transfer', 'Cash')),
  payment_ref      text not null default '' check (char_length(payment_ref) <= 100),
  remarks          text not null default '' check (char_length(remarks) <= 1000),
  submitted_on     date not null default (now() at time zone 'Asia/Kuala_Lumpur')::date,
  created_by       uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- 已付款必須有付款日與方式；退回必須有原因
  constraint staff_claims_paid_details check (status <> 'paid' or (paid_date is not null and pay_method is not null)),
  constraint staff_claims_reject_reason check (status <> 'rejected' or char_length(btrim(reject_reason)) > 0),
  -- 里程報銷必須有公里數與費率
  constraint staff_claims_mileage check (category <> 'Mileage' or (mileage_km is not null and rate_per_km_sen is not null))
);

create index staff_claims_status_idx on public.staff_claims (status, expense_date);
create index staff_claims_staff_idx on public.staff_claims (lower(staff_name));

alter table public.staff_claims enable row level security;
create policy "staff_claims: staff read" on public.staff_claims for select to authenticated using (public.current_app_role() is not null);
create policy "staff_claims: finance write" on public.staff_claims for all to authenticated
  using (public.current_app_role() in ('admin', 'finance')) with check (public.current_app_role() in ('admin', 'finance'));
revoke all on public.staff_claims from anon;
grant select, insert, update, delete on public.staff_claims to authenticated;

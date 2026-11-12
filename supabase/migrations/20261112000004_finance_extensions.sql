-- =============================================================================
-- 財務功能擴充：聯絡資料、沖帳類型（付款／折讓單／呆帳沖銷）、公司設定
-- =============================================================================

-- ---------- 供應商／客戶聯絡資料 ----------
alter table public.counterparties
  add column contact_person     text not null default '' check (char_length(contact_person) <= 150),
  add column address            text not null default '' check (char_length(address) <= 500),
  add column payment_terms_days integer check (payment_terms_days between 0 and 365),
  add column notes              text not null default '' check (char_length(notes) <= 1000);

-- ---------- 沖帳類型 ----------
-- payment = 實際收付款；credit_note = 折讓單；write_off = 呆帳沖銷（僅 AR）
alter table public.payments
  add column kind text not null default 'payment' check (kind in ('payment', 'credit_note', 'write_off'));

-- 更新付款規則：審批只限制「實際付款」；呆帳沖銷只適用於 AR
create or replace function public.payments_guard()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_invoice public.invoices;
  v_paid    numeric(14,2);
begin
  if tg_op = 'UPDATE' then
    raise exception 'Payments cannot be edited. Reverse the payment and record it again.' using errcode = 'P0001';
  end if;

  select * into v_invoice from public.invoices where id = new.invoice_id for update;
  if not found then
    raise exception 'Invoice not found' using errcode = 'P0002';
  end if;

  if v_invoice.is_cancelled then
    raise exception 'Cannot record a payment on a cancelled invoice' using errcode = 'P0001';
  end if;
  if new.kind = 'write_off' and v_invoice.invoice_type <> 'AR' then
    raise exception 'Only customer invoices can be written off' using errcode = 'P0001';
  end if;
  if new.kind = 'payment' and v_invoice.invoice_type = 'AP' and v_invoice.approval_status <> 'approved' then
    raise exception 'This supplier invoice must be approved before payment' using errcode = 'P0001';
  end if;

  select coalesce(sum(amount), 0) into v_paid from public.payments where invoice_id = new.invoice_id;
  if v_paid + new.amount > v_invoice.total_amount then
    raise exception 'Amount exceeds the outstanding balance of %',
      public.fmt_myr(v_invoice.total_amount - v_paid) using errcode = 'P0001';
  end if;

  new.created_by := coalesce(auth.uid(), new.created_by);
  new.method := btrim(new.method);
  return new;
end;
$$;

-- 活動紀錄文字依沖帳類型區分
create or replace function public.audit_payments()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_inv record;
  v_row public.payments;
  v_verb text;
begin
  v_row := case when tg_op = 'DELETE' then old else new end;
  select i.invoice_type, i.invoice_number, c.name as party into v_inv
  from public.invoices i join public.counterparties c on c.id = i.counterparty_id
  where i.id = v_row.invoice_id;

  if tg_op = 'INSERT' then
    v_verb := case v_row.kind when 'credit_note' then 'Credit note' when 'write_off' then 'Wrote off'
              else case v_inv.invoice_type when 'AR' then 'Collected' else 'Paid' end end;
    perform public.log_activity(v_row.invoice_id,
      case v_row.kind when 'payment' then 'payment.recorded' else v_row.kind || '.recorded' end,
      format('%s %s on %s invoice %s · %s', v_verb, public.fmt_myr(v_row.amount), v_inv.invoice_type, v_inv.invoice_number, v_inv.party));
  else
    perform public.log_activity(v_row.invoice_id, 'payment.reversed', format('Reversed %s %s on %s invoice %s · %s',
      case v_row.kind when 'credit_note' then 'credit note of' when 'write_off' then 'write-off of'
        else case v_inv.invoice_type when 'AR' then 'collection of' else 'payment of' end end,
      public.fmt_myr(v_row.amount), v_inv.invoice_type, v_inv.invoice_number, v_inv.party));
  end if;
  return v_row;
end;
$$;

-- ---------- 公司設定（單列資料表）----------
create table public.app_settings (
  id                    smallint primary key default 1 check (id = 1),
  company_name          text not null default '' check (char_length(company_name) <= 150),
  opening_balance       numeric(14,2) not null default 0,
  opening_balance_date  date,
  default_terms_ar      integer not null default 30 check (default_terms_ar between 0 and 365),
  default_terms_ap      integer not null default 30 check (default_terms_ap between 0 and 365),
  updated_at            timestamptz not null default now()
);
insert into public.app_settings (id) values (1);

alter table public.app_settings enable row level security;
create policy "settings: staff read" on public.app_settings
  for select to authenticated using (public.current_app_role() is not null);
create policy "settings: admin update" on public.app_settings
  for update to authenticated
  using (public.current_app_role() = 'admin')
  with check (public.current_app_role() = 'admin');
revoke all on public.app_settings from anon;
grant select, update on public.app_settings to authenticated;

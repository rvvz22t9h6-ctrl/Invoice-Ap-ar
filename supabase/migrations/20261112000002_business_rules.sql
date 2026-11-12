-- =============================================================================
-- 業務規則與觸發器（Business rules & triggers）
--
-- 這些規則在資料庫層強制執行，即使有人直接呼叫 API 也無法繞過：
--   • 付款不可超過發票總額（以列鎖定防止同時付款造成超額）
--   • 已取消的發票不可付款；AP 必須先審批才能付款
--   • 只有管理員可以變更 AP 審批狀態
--   • 已有付款的發票不可取消，總額不可改到低於已付金額
--   • 所有新增、修改、付款、沖銷都寫入活動紀錄
-- =============================================================================

-- 目前登入者的角色。auth.uid() 為 null 代表伺服器端（service role / SQL 主控台），視為受信任。
create or replace function public.current_app_role()
returns public.app_role
language sql stable security definer set search_path = ''
as $$
  select role from public.profiles where id = auth.uid();
$$;

-- 是否擁有管理員權限（管理員，或伺服器端操作）
create or replace function public.is_privileged()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select auth.uid() is null or public.current_app_role() = 'admin';
$$;

-- 金額顯示格式，例如 1234.5 → "RM 1,234.50"（活動紀錄用）
create or replace function public.fmt_myr(value numeric)
returns text
language sql immutable set search_path = ''
as $$
  select 'RM ' || to_char(value, 'FM999,999,999,990.00');
$$;

-- ---------- 新使用者註冊時自動建立 profile（預設為唯讀 viewer）----------
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name, role)
  values (new.id, coalesce(new.email, ''), coalesce(new.raw_user_meta_data ->> 'full_name', ''), 'viewer')
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- 防止非管理員自行提升權限 ----------
create or replace function public.profiles_guard()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.role is distinct from old.role and not public.is_privileged() then
    raise exception 'Only an admin can change user roles' using errcode = '42501';
  end if;
  if new.role is distinct from old.role and old.role = 'admin'
     and (select count(*) from public.profiles where role = 'admin' and id <> old.id) = 0 then
    raise exception 'There must be at least one admin' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger profiles_guard
  before update on public.profiles
  for each row execute function public.profiles_guard();

-- ---------- 發票規則 ----------
create or replace function public.invoices_guard()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_paid numeric(14,2);
begin
  new.invoice_number := btrim(new.invoice_number);
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  new.updated_at := now();

  if tg_op = 'INSERT' then
    new.created_by := coalesce(auth.uid(), new.created_by);
    -- 新 AP 帳單一律從「待審批」開始（伺服器端匯入資料除外）
    if new.invoice_type = 'AP' and auth.uid() is not null then
      new.approval_status := 'pending';
    end if;
    if new.invoice_type = 'AP' and new.approval_status is null then
      new.approval_status := 'pending';
    end if;
    if new.is_cancelled then
      new.cancelled_at := coalesce(new.cancelled_at, now());
    end if;
    return new;
  end if;

  -- 以下為 UPDATE
  if new.invoice_type <> old.invoice_type then
    raise exception 'Invoice type cannot be changed' using errcode = 'P0001';
  end if;

  select coalesce(sum(amount), 0) into v_paid from public.payments where invoice_id = old.id;

  -- 審批狀態：只有管理員可以變更；已有付款時不可撤銷審批
  if new.approval_status is distinct from old.approval_status then
    if not public.is_privileged() then
      raise exception 'Only an admin can approve or reject supplier invoices' using errcode = '42501';
    end if;
    if old.approval_status = 'approved' and v_paid > 0 then
      raise exception 'Cannot change approval of an invoice that already has payments' using errcode = 'P0001';
    end if;
    if new.approval_status = 'approved' then
      new.approved_by := auth.uid();
      new.approved_at := now();
    else
      new.approved_by := null;
      new.approved_at := null;
    end if;
  end if;

  -- 總額不可低於已付金額
  if (new.invoice_amount + new.tax_amount) < v_paid then
    raise exception 'Total amount (%) cannot be less than the amount already paid (%)',
      public.fmt_myr(new.invoice_amount + new.tax_amount), public.fmt_myr(v_paid) using errcode = 'P0001';
  end if;

  -- 取消：已有付款的發票不可取消
  if new.is_cancelled and not old.is_cancelled then
    if v_paid > 0 then
      raise exception 'This invoice has payments. Reverse the payments before cancelling it.' using errcode = 'P0001';
    end if;
    new.cancelled_at := now();
  elsif not new.is_cancelled then
    new.cancelled_at := null;
    new.cancel_reason := '';
  end if;

  return new;
end;
$$;

create trigger invoices_guard
  before insert or update on public.invoices
  for each row execute function public.invoices_guard();

-- ---------- 付款規則 ----------
create or replace function public.payments_guard()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_invoice public.invoices;
  v_paid    numeric(14,2);
begin
  if tg_op = 'UPDATE' then
    -- 付款紀錄不可修改；如有錯誤，請沖銷（刪除）後重新登錄，保留清楚的稽核軌跡
    raise exception 'Payments cannot be edited. Reverse the payment and record it again.' using errcode = 'P0001';
  end if;

  -- 鎖定發票列，避免兩筆付款同時寫入造成超額付款
  select * into v_invoice from public.invoices where id = new.invoice_id for update;
  if not found then
    raise exception 'Invoice not found' using errcode = 'P0002';
  end if;

  if v_invoice.is_cancelled then
    raise exception 'Cannot record a payment on a cancelled invoice' using errcode = 'P0001';
  end if;
  if v_invoice.invoice_type = 'AP' and v_invoice.approval_status <> 'approved' then
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

create trigger payments_guard
  before insert or update on public.payments
  for each row execute function public.payments_guard();

-- ---------- 活動紀錄 ----------
create or replace function public.log_activity(p_invoice_id uuid, p_action text, p_summary text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.activity_log (invoice_id, action, summary, actor_id, actor_name)
  values (
    p_invoice_id, p_action, p_summary, auth.uid(),
    coalesce((select nullif(full_name, '') from public.profiles where id = auth.uid()),
             (select email from public.profiles where id = auth.uid()), 'System'));
end;
$$;

create or replace function public.audit_invoices()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_party text;
  v_label text;
begin
  if tg_op = 'DELETE' then
    select name into v_party from public.counterparties where id = old.counterparty_id;
    perform public.log_activity(null, 'invoice.deleted',
      format('Deleted %s invoice %s · %s', old.invoice_type, old.invoice_number, v_party));
    return old;
  end if;

  select name into v_party from public.counterparties where id = new.counterparty_id;
  v_label := format('%s invoice %s · %s', new.invoice_type, new.invoice_number, v_party);

  if tg_op = 'INSERT' then
    perform public.log_activity(new.id, 'invoice.created', format('Created %s · %s', v_label, public.fmt_myr(new.total_amount)));
  elsif new.is_cancelled and not old.is_cancelled then
    perform public.log_activity(new.id, 'invoice.cancelled', format('Cancelled %s', v_label));
  elsif not new.is_cancelled and old.is_cancelled then
    perform public.log_activity(new.id, 'invoice.restored', format('Restored %s', v_label));
  elsif new.approval_status is distinct from old.approval_status then
    perform public.log_activity(new.id, 'invoice.' || new.approval_status::text,
      format('%s %s', initcap(new.approval_status::text), v_label));
  else
    perform public.log_activity(new.id, 'invoice.updated', format('Updated %s', v_label));
  end if;
  return new;
end;
$$;

create trigger audit_invoices
  after insert or update or delete on public.invoices
  for each row execute function public.audit_invoices();

create or replace function public.audit_payments()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_inv record;
  v_row public.payments;
begin
  v_row := case when tg_op = 'DELETE' then old else new end;
  select i.invoice_type, i.invoice_number, c.name as party into v_inv
  from public.invoices i join public.counterparties c on c.id = i.counterparty_id
  where i.id = v_row.invoice_id;

  if tg_op = 'INSERT' then
    perform public.log_activity(v_row.invoice_id, 'payment.recorded', format('%s %s on %s invoice %s · %s',
      case v_inv.invoice_type when 'AR' then 'Collected' else 'Paid' end,
      public.fmt_myr(v_row.amount), v_inv.invoice_type, v_inv.invoice_number, v_inv.party));
  else
    perform public.log_activity(v_row.invoice_id, 'payment.reversed', format('Reversed %s %s on %s invoice %s · %s',
      case v_inv.invoice_type when 'AR' then 'collection of' else 'payment of' end,
      public.fmt_myr(v_row.amount), v_inv.invoice_type, v_inv.invoice_number, v_inv.party));
  end if;
  return v_row;
end;
$$;

create trigger audit_payments
  after insert or delete on public.payments
  for each row execute function public.audit_payments();

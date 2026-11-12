-- =============================================================================
-- 每日工作與提醒中心：任務與週期規則
--
-- 去重複：週期任務以 (recurrence_id, occurrence_date) 唯一，且任務 ID 由規則與日期決定，
--         重複產生時以 ON CONFLICT DO NOTHING 略過，不會出現重複任務。
-- 逾期任務不會被自動刪除：系統只會刪除「未來、尚未開始、未修改」的週期任務（規則變更時）。
-- =============================================================================

create table public.task_recurrences (
  id                uuid primary key default gen_random_uuid(),
  title             text not null check (char_length(btrim(title)) between 1 and 150),
  description       text not null default '' check (char_length(description) <= 2000),
  category          text not null check (category in ('AP','AR','GL','Payroll','Banking','Administration','Month-End Closing')),
  priority          text not null check (priority in ('Low','Medium','High','Urgent')),
  remarks           text not null default '' check (char_length(remarks) <= 2000),
  frequency         text not null check (frequency in ('daily','weekly','monthly','quarterly','yearly','custom')),
  interval          integer not null default 1 check (interval between 1 and 366),
  custom_unit       text not null default 'day' check (custom_unit in ('day','week','month')),
  weekdays          smallint[] not null default '{}',
  day_of_month      smallint not null default 0 check (day_of_month = -1 or day_of_month between 0 and 31),
  month             smallint not null default 1 check (month between 1 and 12),
  weekend_adjust    text not null default 'none' check (weekend_adjust in ('none','previous','next')),
  lead_days         integer not null default 0 check (lead_days between 0 and 90),
  start_date        date not null,
  end_date          date check (end_date is null or end_date >= start_date),
  active            boolean not null default true,
  generated_through date,
  skip_dates        date[] not null default '{}',
  created_by        uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table public.tasks (
  id               text primary key check (char_length(id) between 1 and 200),
  title            text not null check (char_length(btrim(title)) between 1 and 150),
  description      text not null default '' check (char_length(description) <= 2000),
  category         text not null check (category in ('AP','AR','GL','Payroll','Banking','Administration','Month-End Closing')),
  priority         text not null check (priority in ('Low','Medium','High','Urgent')),
  start_date       date,
  due_date         date not null,
  status           text not null default 'todo' check (status in ('todo','in_progress','done','cancelled')),
  remarks          text not null default '' check (char_length(remarks) <= 2000),
  completed_at     timestamptz,
  completed_on     date,
  recurrence_id    uuid references public.task_recurrences (id) on delete set null,
  occurrence_date  date,
  created_by       uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint tasks_start_before_due check (start_date is null or start_date <= due_date),
  constraint tasks_done_has_time check ((status = 'done') = (completed_at is not null))
);
-- 同一規則、同一排程日期只能有一筆任務
create unique index tasks_recurrence_occurrence_uq on public.tasks (recurrence_id, occurrence_date)
  where recurrence_id is not null;
create index tasks_due_idx on public.tasks (due_date);
create index tasks_status_idx on public.tasks (status);

-- 完成時自動記錄馬來西亞日期；重新打開時清除
create or replace function public.tasks_guard()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.updated_at := now();
  if new.status = 'done' and (tg_op = 'INSERT' or old.status <> 'done') then
    new.completed_at := coalesce(new.completed_at, now());
    new.completed_on := (new.completed_at at time zone 'Asia/Kuala_Lumpur')::date;
  elsif new.status <> 'done' then
    new.completed_at := null;
    new.completed_on := null;
  end if;
  return new;
end;
$$;
create trigger tasks_guard before insert or update on public.tasks
  for each row execute function public.tasks_guard();

-- ---------- RLS：所有人可讀；admin / finance 可寫 ----------
alter table public.tasks enable row level security;
alter table public.task_recurrences enable row level security;

create policy "tasks: staff read" on public.tasks for select to authenticated using (public.current_app_role() is not null);
create policy "tasks: finance write" on public.tasks for all to authenticated
  using (public.current_app_role() in ('admin', 'finance')) with check (public.current_app_role() in ('admin', 'finance'));
create policy "recurrences: staff read" on public.task_recurrences for select to authenticated using (public.current_app_role() is not null);
create policy "recurrences: finance write" on public.task_recurrences for all to authenticated
  using (public.current_app_role() in ('admin', 'finance')) with check (public.current_app_role() in ('admin', 'finance'));

revoke all on public.tasks, public.task_recurrences from anon;
grant select, insert, update, delete on public.tasks, public.task_recurrences to authenticated;

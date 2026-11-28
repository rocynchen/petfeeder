begin;

create table public.medication_plans (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  pet_id uuid not null references public.pets(id) on delete cascade,
  medication_name text not null check (char_length(btrim(medication_name)) between 1 and 80),
  medication_key text generated always as (lower(btrim(medication_name))) stored,
  scheduled_time time not null,
  starts_on date not null,
  ends_on date check (ends_on >= starts_on),
  active boolean not null default true,
  unique(pet_id, medication_key, scheduled_time)
);

create index medication_plans_household on public.medication_plans(household_id);
alter table public.medication_plans enable row level security;
revoke all on public.medication_plans from anon, authenticated;
grant select on public.medication_plans to authenticated;

create policy medication_plans_read on public.medication_plans
  for select to authenticated using (public.is_household_member(household_id));

create table public.medication_records (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.medication_plans(id) on delete cascade,
  household_id uuid not null references public.households(id) on delete cascade,
  pet_id uuid not null references public.pets(id) on delete cascade,
  recorded_by uuid not null references auth.users(id),
  medication_date date not null,
  given_at timestamptz not null default now(),
  unique(plan_id, medication_date)
);

create index medication_records_household_date on public.medication_records(household_id, medication_date desc);
alter table public.medication_records enable row level security;
revoke all on public.medication_records from anon, authenticated;
grant select on public.medication_records to authenticated;

create policy medication_records_read on public.medication_records
  for select to authenticated using (public.is_household_member(household_id));

create function public.save_medication_plan(
  p_pet_id uuid, p_name text, p_time time, p_starts_on date, p_ends_on date
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  target_household uuid;
  saved_id uuid;
  today date := (now() at time zone 'Asia/Taipei')::date;
begin
  select p.household_id into target_household from public.pets p where p.id=p_pet_id and p.active;
  if target_household is null or not public.is_household_member(target_household) then
    raise insufficient_privilege using message='無法設定這隻寵物的用藥時段。';
  end if;

  insert into public.medication_plans as plan(household_id,pet_id,medication_name,scheduled_time,starts_on,ends_on)
  values(target_household,p_pet_id,btrim(p_name),p_time,p_starts_on,p_ends_on)
  on conflict(pet_id,medication_key,scheduled_time) do update set
    starts_on=excluded.starts_on, ends_on=excluded.ends_on, active=true
  where not plan.active or plan.ends_on<today
  returning plan.id into saved_id;

  if saved_id is null then raise exception '已經有相同藥名與時間的用藥時段。'; end if;
  return saved_id;
end;
$$;

create function public.stop_medication_plan(p_plan_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.medication_plans p set active=false
  where p.id=p_plan_id and public.is_household_member(p.household_id);
  if not found then raise insufficient_privilege using message='無法停用這個用藥時段。'; end if;
end;
$$;

create function public.record_medication(p_plan_id uuid, p_expected_date date)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  plan public.medication_plans;
  today date := (now() at time zone 'Asia/Taipei')::date;
begin
  if p_expected_date is distinct from today then
    raise exception '日期已變更，請重新確認今天的用藥狀態。';
  end if;

  select m.* into plan
  from public.medication_plans m
  join public.pets p on p.id=m.pet_id and p.household_id=m.household_id and p.active
  where m.id=p_plan_id and m.active and m.starts_on<=today
    and (m.ends_on is null or m.ends_on>=today)
    and public.is_household_member(m.household_id)
  for share of m;
  if not found then raise exception '這個用藥時段目前無法登記。'; end if;

  insert into public.medication_records(plan_id,household_id,pet_id,recorded_by,medication_date)
  values(plan.id,plan.household_id,plan.pet_id,auth.uid(),today)
  on conflict(plan_id,medication_date) do nothing;
  return found;
end;
$$;

revoke all on function public.save_medication_plan(uuid,text,time,date,date), public.stop_medication_plan(uuid), public.record_medication(uuid,date) from public, anon;
grant execute on function public.save_medication_plan(uuid,text,time,date,date), public.stop_medication_plan(uuid), public.record_medication(uuid,date) to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname='supabase_realtime' and not puballtables) then
    alter publication supabase_realtime add table public.medication_plans, public.medication_records;
  end if;
end;
$$;

commit;

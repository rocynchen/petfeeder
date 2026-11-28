begin;

create extension if not exists pg_cron;
create extension if not exists pg_net;

alter table public.meal_types
  add column reminder_time time,
  add column reminder_updated_at timestamptz not null default now();

create function public.save_pet_meals(p_pet_id uuid, p_household_id uuid, p_name text, p_kind text, p_meals jsonb)
returns uuid language plpgsql set search_path = '' as $$
declare
  saved_pet_id uuid := p_pet_id;
  meal record;
  saved_meal_id uuid;
  kept_ids uuid[] := '{}';
  seen_ids uuid[] := '{}';
begin
  if not public.is_household_member(p_household_id) then
    raise exception '無法編輯這個家庭的寵物';
  end if;
  if jsonb_typeof(p_meals) is distinct from 'array' or jsonb_array_length(p_meals) = 0 then
    raise exception '請至少設定一個餐次';
  end if;

  if saved_pet_id is null then
    insert into public.pets(household_id, name, kind, created_by)
    values(p_household_id, p_name, p_kind, auth.uid()) returning id into saved_pet_id;
  else
    update public.pets as p set name=p_name, kind=p_kind
    where p.id=saved_pet_id and p.household_id=p_household_id and p.active;
    if not found then raise exception '找不到這隻寵物'; end if;
  end if;

  for meal in
    select * from jsonb_to_recordset(p_meals)
      as m(id uuid, name text, scheduled_time time, reminder_time time, sort_order int)
  loop
    saved_meal_id := null;
    if meal.id is not null then
      if not exists (
        select 1 from public.meal_types as m
        where m.id=meal.id and m.pet_id=saved_pet_id and m.household_id=p_household_id and m.active
      ) or meal.id=any(seen_ids) then
        raise exception '餐次已變更，請重新開啟寵物設定';
      end if;
      seen_ids := array_append(seen_ids, meal.id);

      update public.meal_types as m set
        scheduled_time=meal.scheduled_time,
        reminder_updated_at=case when m.reminder_time is distinct from meal.reminder_time then now() else m.reminder_updated_at end,
        reminder_time=meal.reminder_time,
        sort_order=meal.sort_order
      where m.id=meal.id and m.name=meal.name
      returning m.id into saved_meal_id;
    end if;

    if saved_meal_id is null then
      insert into public.meal_types(household_id, pet_id, name, scheduled_time, reminder_time, sort_order)
      values(p_household_id, saved_pet_id, meal.name, meal.scheduled_time, meal.reminder_time, meal.sort_order)
      returning id into saved_meal_id;
    end if;
    kept_ids := array_append(kept_ids, saved_meal_id);
  end loop;

  update public.meal_types as m set active=false
  where m.pet_id=saved_pet_id and m.household_id=p_household_id and m.active and not (m.id=any(kept_ids));
  return saved_pet_id;
end;
$$;

revoke all on function public.save_pet_meals(uuid,uuid,text,text,jsonb) from public, anon;
grant execute on function public.save_pet_meals(uuid,uuid,text,text,jsonb) to authenticated;

create table public.feeding_reminder_deliveries (
  meal_id uuid not null references public.meal_types(id) on delete cascade,
  feeding_date date not null,
  id uuid not null default gen_random_uuid() unique,
  last_attempt_at timestamptz not null default now(),
  attempts integer not null default 1,
  finished boolean not null default false,
  primary key (meal_id, feeding_date)
);
alter table public.feeding_reminder_deliveries enable row level security;
revoke all on public.feeding_reminder_deliveries from anon, authenticated;
grant select, update(finished) on public.feeding_reminder_deliveries to service_role;

do $$
begin
  if not exists (select 1 from vault.secrets where name='feeding_reminder_worker') then
    perform vault.create_secret(gen_random_uuid()::text || gen_random_uuid()::text, 'feeding_reminder_worker');
  end if;
end;
$$;

create function public.claim_feeding_reminders(p_worker_key text)
returns table(delivery_id uuid, group_id text, pet_name text, meal_name text, reminder_at text)
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from vault.decrypted_secrets
    where name='feeding_reminder_worker' and decrypted_secret=p_worker_key
  ) then
    raise insufficient_privilege using message='Invalid worker key';
  end if;

  return query
  with current_time_local as (
    select now() at time zone 'Asia/Taipei' as local_now
  ),
  due as (
    select m.id as meal_id, t.local_now::date as meal_date, h.line_group_id,
      p.name as pet_name, m.name as meal_name, left(m.reminder_time::text, 5) as reminder_at
    from public.meal_types m
    join public.pets p on p.id=m.pet_id and p.household_id=m.household_id and p.active
    join public.households h on h.id=m.household_id and h.line_group_id is not null
    cross join current_time_local t
    left join public.feeding_reminder_deliveries d on d.meal_id=m.id and d.feeding_date=t.local_now::date
    where m.active and m.reminder_time is not null
      and (t.local_now::date + m.reminder_time) between t.local_now-interval '10 minutes' and t.local_now
      and (t.local_now::date + m.reminder_time) >= (m.reminder_updated_at at time zone 'Asia/Taipei')
      and (d.id is null or (not d.finished and d.attempts<3 and d.last_attempt_at<=now()-interval '45 seconds'))
      and not exists (
        select 1 from public.feedings f where f.pet_id=p.id and f.meal_id=m.id and f.feeding_date=t.local_now::date
      )
    order by m.reminder_time, m.id
    limit 20
  ),
  claimed as (
    insert into public.feeding_reminder_deliveries as d(meal_id, feeding_date)
    select due.meal_id, due.meal_date from due
    on conflict (meal_id,feeding_date) do update
      set last_attempt_at=now(), attempts=d.attempts+1
      where not d.finished and d.attempts<3 and d.last_attempt_at<=now()-interval '45 seconds'
    returning d.id, d.meal_id
  )
  select c.id, d.line_group_id, d.pet_name, d.meal_name, d.reminder_at
  from claimed c join due d on d.meal_id=c.meal_id;
end;
$$;

revoke all on function public.claim_feeding_reminders(text) from public, anon, authenticated;
grant execute on function public.claim_feeding_reminders(text) to service_role;

-- Set feeding_reminder_gateway_anon in Vault to the project's public legacy anon JWT.
-- Schedule this function every minute with the deployed worker URL once the worker is ready.
create function public.dispatch_feeding_reminders(p_url text)
returns void language plpgsql set search_path = '' as $$
begin
  perform net.http_post(
    url := p_url,
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'Authorization','Bearer ' || gateway.decrypted_secret,
      'x-reminder-key',worker.decrypted_secret
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 15000
  )
  from vault.decrypted_secrets worker
  cross join vault.decrypted_secrets gateway
  where worker.name='feeding_reminder_worker' and gateway.name='feeding_reminder_gateway_anon';
end;
$$;
revoke all on function public.dispatch_feeding_reminders(text) from public, anon, authenticated;

commit;

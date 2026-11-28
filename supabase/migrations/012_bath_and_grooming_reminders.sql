begin;

create table public.grooming_records (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  pet_id uuid not null references public.pets(id) on delete cascade,
  recorded_by uuid not null references auth.users(id),
  groomed_on date not null,
  next_due_on date check (next_due_on > groomed_on),
  created_at timestamptz not null default now()
);

create index grooming_records_household_date
  on public.grooming_records (household_id, groomed_on desc);

alter table public.grooming_records enable row level security;
revoke all on public.grooming_records from anon, authenticated;
grant select on public.grooming_records to authenticated;
grant insert (household_id, pet_id, recorded_by, groomed_on, next_due_on)
  on public.grooming_records to authenticated;

create policy grooming_records_household_read on public.grooming_records
  for select to authenticated
  using (public.is_household_member(household_id));

create policy grooming_records_household_insert on public.grooming_records
  for insert to authenticated
  with check (
    recorded_by = auth.uid()
    and groomed_on <= (now() at time zone 'Asia/Taipei')::date
    and public.is_household_member(household_id)
    and exists (
      select 1 from public.pets p
      where p.id = grooming_records.pet_id
        and p.household_id = grooming_records.household_id
        and p.active
    )
  );

alter table public.bath_records add column next_due_on date
  check (next_due_on > (bathed_at at time zone 'Asia/Taipei')::date);
grant insert (next_due_on) on public.bath_records to authenticated;

create index bath_records_latest_pet on public.bath_records(pet_id,bathed_at desc,id desc);
create index grooming_records_latest_pet on public.grooming_records(pet_id,groomed_on desc,created_at desc,id desc);

create table public.hygiene_reminder_deliveries (
  pet_id uuid not null references public.pets(id) on delete cascade,
  care_type text not null check (care_type in ('bath', 'grooming')),
  due_on date not null,
  id uuid not null default gen_random_uuid() unique,
  last_attempt_at timestamptz not null default now(),
  attempts integer not null default 1,
  finished boolean not null default false,
  primary key (pet_id, care_type, due_on)
);
alter table public.hygiene_reminder_deliveries enable row level security;
revoke all on public.hygiene_reminder_deliveries from anon, authenticated;
grant select, update(finished) on public.hygiene_reminder_deliveries to service_role;

create function public.claim_hygiene_reminders(p_worker_key text, p_run_at timestamptz default now())
returns table(delivery_id uuid, group_id text, pet_name text, kind text, reminder_date date)
language plpgsql security definer set search_path = '' as $$
declare
  local_now timestamp := p_run_at at time zone 'Asia/Taipei';
begin
  if not exists (
    select 1 from vault.decrypted_secrets
    where name='feeding_reminder_worker' and decrypted_secret=p_worker_key
  ) then
    raise insufficient_privilege using message='Invalid worker key';
  end if;
  if local_now::time < time '09:00' then return; end if;

  return query
  with latest_bath as (
    select distinct on (r.pet_id) r.pet_id,r.next_due_on,r.household_id
    from public.bath_records r
    order by r.pet_id,r.bathed_at desc,r.id desc
  ),
  latest_grooming as (
    select distinct on (r.pet_id) r.pet_id,r.next_due_on,r.household_id
    from public.grooming_records r
    order by r.pet_id,r.groomed_on desc,r.created_at desc,r.id desc
  ),
  latest as (
    select b.*, 'bath'::text as care_type from latest_bath b
    union all
    select g.*, 'grooming'::text as care_type from latest_grooming g
  ),
  due as (
    select r.pet_id,r.care_type,r.next_due_on,h.line_group_id,p.name
    from latest r
    join public.pets p on p.id=r.pet_id and p.household_id=r.household_id and p.active
    join public.households h on h.id=r.household_id and h.line_group_id is not null
    left join public.hygiene_reminder_deliveries d
      on d.pet_id=r.pet_id and d.care_type=r.care_type and d.due_on=r.next_due_on
    where r.next_due_on=local_now::date
      and (d.id is null or (not d.finished and d.attempts<3 and d.last_attempt_at<=now()-interval '45 seconds'))
    order by r.pet_id,r.care_type
    limit 20
  ),
  claimed as (
    insert into public.hygiene_reminder_deliveries as d(pet_id,care_type,due_on)
    select due.pet_id,due.care_type,due.next_due_on from due
    on conflict (pet_id,care_type,due_on) do update
      set last_attempt_at=now(), attempts=d.attempts+1
      where not d.finished and d.attempts<3 and d.last_attempt_at<=now()-interval '45 seconds'
    returning d.id,d.pet_id,d.care_type,d.due_on
  )
  select c.id,d.line_group_id,d.name,c.care_type,c.due_on
  from claimed c join due d on d.pet_id=c.pet_id and d.care_type=c.care_type and d.next_due_on=c.due_on;
end;
$$;

revoke all on function public.claim_hygiene_reminders(text,timestamptz) from public, anon, authenticated;
grant execute on function public.claim_hygiene_reminders(text,timestamptz) to service_role;

commit;

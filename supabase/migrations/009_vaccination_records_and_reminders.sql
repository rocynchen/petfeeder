begin;

create table public.vaccination_records (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  pet_id uuid not null references public.pets(id) on delete cascade,
  recorded_by uuid not null references auth.users(id),
  vaccine_name text not null check (char_length(btrim(vaccine_name)) between 1 and 80),
  vaccine_key text generated always as (lower(btrim(vaccine_name))) stored,
  vaccinated_on date not null,
  next_due_on date check (next_due_on > vaccinated_on),
  created_at timestamptz not null default now()
);

create index vaccination_records_household_date
  on public.vaccination_records (household_id, vaccinated_on desc);

alter table public.vaccination_records enable row level security;
revoke all on public.vaccination_records from anon, authenticated;
grant select on public.vaccination_records to authenticated;
grant insert (household_id, pet_id, recorded_by, vaccine_name, vaccinated_on, next_due_on)
  on public.vaccination_records to authenticated;

create policy vaccination_records_household_read on public.vaccination_records
  for select to authenticated
  using (public.is_household_member(household_id));

create policy vaccination_records_household_insert on public.vaccination_records
  for insert to authenticated
  with check (
    recorded_by = auth.uid()
    and vaccinated_on <= (now() at time zone 'Asia/Taipei')::date
    and public.is_household_member(household_id)
    and exists (
      select 1 from public.pets p
      where p.id = vaccination_records.pet_id
        and p.household_id = vaccination_records.household_id
        and p.active
    )
  );

create index vaccination_records_latest_treatment
  on public.vaccination_records(pet_id, vaccine_key, vaccinated_on desc, created_at desc, id desc);

create table public.vaccination_reminder_deliveries (
  pet_id uuid not null references public.pets(id) on delete cascade,
  vaccine_key text not null,
  due_on date not null,
  id uuid not null default gen_random_uuid() unique,
  last_attempt_at timestamptz not null default now(),
  attempts integer not null default 1,
  finished boolean not null default false,
  primary key (pet_id, vaccine_key, due_on)
);
alter table public.vaccination_reminder_deliveries enable row level security;
revoke all on public.vaccination_reminder_deliveries from anon, authenticated;
grant select, update(finished) on public.vaccination_reminder_deliveries to service_role;

create function public.claim_vaccination_reminders(p_worker_key text, p_run_at timestamptz default now())
returns table(delivery_id uuid, group_id text, pet_name text, vaccine_name text, reminder_date date)
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
  with latest as (
    select distinct on (r.pet_id,r.vaccine_key)
      r.pet_id,r.vaccine_key,r.next_due_on,r.household_id,r.vaccine_name
    from public.vaccination_records r
    order by r.pet_id,r.vaccine_key,r.vaccinated_on desc,r.created_at desc,r.id desc
  ),
  due as (
    select r.pet_id,r.vaccine_key,r.next_due_on,h.line_group_id,p.name,r.vaccine_name
    from latest r
    join public.pets p on p.id=r.pet_id and p.household_id=r.household_id and p.active
    join public.households h on h.id=r.household_id and h.line_group_id is not null
    left join public.vaccination_reminder_deliveries d
      on d.pet_id=r.pet_id and d.vaccine_key=r.vaccine_key and d.due_on=r.next_due_on
    where r.next_due_on=local_now::date
      and (d.id is null or (not d.finished and d.attempts<3 and d.last_attempt_at<=now()-interval '45 seconds'))
    order by r.pet_id,r.vaccine_key
    limit 20
  ),
  claimed as (
    insert into public.vaccination_reminder_deliveries as d(pet_id,vaccine_key,due_on)
    select due.pet_id,due.vaccine_key,due.next_due_on from due
    on conflict (pet_id,vaccine_key,due_on) do update
      set last_attempt_at=now(), attempts=d.attempts+1
      where not d.finished and d.attempts<3 and d.last_attempt_at<=now()-interval '45 seconds'
    returning d.id,d.pet_id,d.vaccine_key,d.due_on
  )
  select c.id,d.line_group_id,d.name,d.vaccine_name,c.due_on
  from claimed c join due d on d.pet_id=c.pet_id and d.vaccine_key=c.vaccine_key and d.next_due_on=c.due_on;
end;
$$;

revoke all on function public.claim_vaccination_reminders(text,timestamptz) from public, anon, authenticated;
grant execute on function public.claim_vaccination_reminders(text,timestamptz) to service_role;

commit;

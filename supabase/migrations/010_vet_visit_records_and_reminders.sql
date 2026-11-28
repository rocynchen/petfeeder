begin;

create table public.vet_visit_records (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  pet_id uuid not null references public.pets(id) on delete cascade,
  recorded_by uuid not null references auth.users(id),
  visit_reason text not null check (char_length(btrim(visit_reason)) between 1 and 120),
  reason_key text generated always as (lower(btrim(visit_reason))) stored,
  visited_on date not null,
  vet_notes text check (char_length(vet_notes) <= 1000),
  next_due_on date check (next_due_on > visited_on),
  created_at timestamptz not null default now()
);

create index vet_visit_records_household_date
  on public.vet_visit_records (household_id, visited_on desc);

alter table public.vet_visit_records enable row level security;
revoke all on public.vet_visit_records from anon, authenticated;
grant select on public.vet_visit_records to authenticated;
grant insert (household_id, pet_id, recorded_by, visit_reason, visited_on, next_due_on, vet_notes)
  on public.vet_visit_records to authenticated;

create policy vet_visit_records_household_read on public.vet_visit_records
  for select to authenticated
  using (public.is_household_member(household_id));

create policy vet_visit_records_household_insert on public.vet_visit_records
  for insert to authenticated
  with check (
    recorded_by = auth.uid()
    and visited_on <= (now() at time zone 'Asia/Taipei')::date
    and public.is_household_member(household_id)
    and exists (
      select 1 from public.pets p
      where p.id = vet_visit_records.pet_id
        and p.household_id = vet_visit_records.household_id
        and p.active
    )
  );

create index vet_visit_records_latest_treatment
  on public.vet_visit_records(pet_id, reason_key, visited_on desc, created_at desc, id desc);

create table public.vet_visit_reminder_deliveries (
  pet_id uuid not null references public.pets(id) on delete cascade,
  reason_key text not null,
  due_on date not null,
  id uuid not null default gen_random_uuid() unique,
  last_attempt_at timestamptz not null default now(),
  attempts integer not null default 1,
  finished boolean not null default false,
  primary key (pet_id, reason_key, due_on)
);
alter table public.vet_visit_reminder_deliveries enable row level security;
revoke all on public.vet_visit_reminder_deliveries from anon, authenticated;
grant select, update(finished) on public.vet_visit_reminder_deliveries to service_role;

create function public.claim_vet_visit_reminders(p_worker_key text, p_run_at timestamptz default now())
returns table(delivery_id uuid, group_id text, pet_name text, visit_reason text, reminder_date date)
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
    select distinct on (r.pet_id,r.reason_key)
      r.pet_id,r.reason_key,r.next_due_on,r.household_id,r.visit_reason
    from public.vet_visit_records r
    order by r.pet_id,r.reason_key,r.visited_on desc,r.created_at desc,r.id desc
  ),
  due as (
    select r.pet_id,r.reason_key,r.next_due_on,h.line_group_id,p.name,r.visit_reason
    from latest r
    join public.pets p on p.id=r.pet_id and p.household_id=r.household_id and p.active
    join public.households h on h.id=r.household_id and h.line_group_id is not null
    left join public.vet_visit_reminder_deliveries d
      on d.pet_id=r.pet_id and d.reason_key=r.reason_key and d.due_on=r.next_due_on
    where r.next_due_on=local_now::date
      and (d.id is null or (not d.finished and d.attempts<3 and d.last_attempt_at<=now()-interval '45 seconds'))
    order by r.pet_id,r.reason_key
    limit 20
  ),
  claimed as (
    insert into public.vet_visit_reminder_deliveries as d(pet_id,reason_key,due_on)
    select due.pet_id,due.reason_key,due.next_due_on from due
    on conflict (pet_id,reason_key,due_on) do update
      set last_attempt_at=now(), attempts=d.attempts+1
      where not d.finished and d.attempts<3 and d.last_attempt_at<=now()-interval '45 seconds'
    returning d.id,d.pet_id,d.reason_key,d.due_on
  )
  select c.id,d.line_group_id,d.name,d.visit_reason,c.due_on
  from claimed c join due d on d.pet_id=c.pet_id and d.reason_key=c.reason_key and d.next_due_on=c.due_on;
end;
$$;

revoke all on function public.claim_vet_visit_reminders(text,timestamptz) from public, anon, authenticated;
grant execute on function public.claim_vet_visit_reminders(text,timestamptz) to service_role;

commit;

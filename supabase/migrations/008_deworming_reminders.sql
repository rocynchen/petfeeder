begin;

create index deworming_records_latest_treatment
  on public.deworming_records(pet_id, treatment_type, treated_on desc, created_at desc, id desc);

create table public.deworming_reminder_deliveries (
  pet_id uuid not null references public.pets(id) on delete cascade,
  treatment_type text not null check (treatment_type in ('internal', 'external')),
  due_on date not null,
  id uuid not null default gen_random_uuid() unique,
  last_attempt_at timestamptz not null default now(),
  attempts integer not null default 1,
  finished boolean not null default false,
  primary key (pet_id, treatment_type, due_on)
);
alter table public.deworming_reminder_deliveries enable row level security;
revoke all on public.deworming_reminder_deliveries from anon, authenticated;
grant select, update(finished) on public.deworming_reminder_deliveries to service_role;

create function public.claim_deworming_reminders(p_worker_key text, p_run_at timestamptz default now())
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
  with latest as (
    select distinct on (r.pet_id,r.treatment_type)
      r.pet_id,r.treatment_type,r.next_due_on,r.household_id
    from public.deworming_records r
    order by r.pet_id,r.treatment_type,r.treated_on desc,r.created_at desc,r.id desc
  ),
  due as (
    select r.pet_id,r.treatment_type,r.next_due_on,h.line_group_id,p.name
    from latest r
    join public.pets p on p.id=r.pet_id and p.household_id=r.household_id and p.active
    join public.households h on h.id=r.household_id and h.line_group_id is not null
    left join public.deworming_reminder_deliveries d
      on d.pet_id=r.pet_id and d.treatment_type=r.treatment_type and d.due_on=r.next_due_on
    where r.next_due_on=local_now::date
      and (d.id is null or (not d.finished and d.attempts<3 and d.last_attempt_at<=now()-interval '45 seconds'))
    order by r.pet_id,r.treatment_type
    limit 20
  ),
  claimed as (
    insert into public.deworming_reminder_deliveries as d(pet_id,treatment_type,due_on)
    select due.pet_id,due.treatment_type,due.next_due_on from due
    on conflict (pet_id,treatment_type,due_on) do update
      set last_attempt_at=now(), attempts=d.attempts+1
      where not d.finished and d.attempts<3 and d.last_attempt_at<=now()-interval '45 seconds'
    returning d.id,d.pet_id,d.treatment_type,d.due_on
  )
  select c.id,d.line_group_id,d.name,c.treatment_type,c.due_on
  from claimed c join due d on d.pet_id=c.pet_id and d.treatment_type=c.treatment_type and d.next_due_on=c.due_on;
end;
$$;

revoke all on function public.claim_deworming_reminders(text,timestamptz) from public, anon, authenticated;
grant execute on function public.claim_deworming_reminders(text,timestamptz) to service_role;

commit;

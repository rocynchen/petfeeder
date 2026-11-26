begin;

create table public.bath_records (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  pet_id uuid not null references public.pets(id) on delete cascade,
  recorded_by uuid not null references auth.users(id),
  bathed_at timestamptz not null default now()
);

create index bath_records_household_time
  on public.bath_records (household_id, bathed_at desc);

alter table public.bath_records enable row level security;
revoke all on public.bath_records from anon, authenticated;
grant select on public.bath_records to authenticated;
grant insert (household_id, pet_id, recorded_by) on public.bath_records to authenticated;

create policy bath_records_household_read on public.bath_records
  for select to authenticated
  using (public.is_household_member(household_id));

create policy bath_records_household_insert on public.bath_records
  for insert to authenticated
  with check (
    recorded_by = auth.uid()
    and public.is_household_member(household_id)
    and exists (
      select 1 from public.pets p
      where p.id = bath_records.pet_id
        and p.household_id = bath_records.household_id
        and p.active
    )
  );

commit;

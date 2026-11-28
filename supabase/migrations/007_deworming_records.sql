begin;

create table public.deworming_records (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  pet_id uuid not null references public.pets(id) on delete cascade,
  recorded_by uuid not null references auth.users(id),
  treatment_type text not null check (treatment_type in ('internal', 'external')),
  treated_on date not null,
  next_due_on date check (next_due_on > treated_on),
  created_at timestamptz not null default now()
);

create index deworming_records_household_date
  on public.deworming_records (household_id, treated_on desc);

alter table public.deworming_records enable row level security;
revoke all on public.deworming_records from anon, authenticated;
grant select on public.deworming_records to authenticated;
grant insert (household_id, pet_id, recorded_by, treatment_type, treated_on, next_due_on)
  on public.deworming_records to authenticated;

create policy deworming_records_household_read on public.deworming_records
  for select to authenticated
  using (public.is_household_member(household_id));

create policy deworming_records_household_insert on public.deworming_records
  for insert to authenticated
  with check (
    recorded_by = auth.uid()
    and treated_on <= (now() at time zone 'Asia/Taipei')::date
    and public.is_household_member(household_id)
    and exists (
      select 1 from public.pets p
      where p.id = deworming_records.pet_id
        and p.household_id = deworming_records.household_id
        and p.active
    )
  );

commit;

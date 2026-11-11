-- Phase 4: Founder, owner and member roles

-- 1. Allow the new founder role.
alter table public.household_members
drop constraint if exists household_members_role_check;

alter table public.household_members
add constraint household_members_role_check
check (role in ('founder', 'owner', 'member'));

-- 2. Convert existing household owners into founders.
update public.household_members
set role = 'founder'
where role = 'owner';

-- 3. New households are created with founder role.
create or replace function public.create_household(p_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  hid uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if exists (
    select 1 from household_members
    where user_id = auth.uid()
  ) then
    raise exception 'You already belong to a household';
  end if;

  insert into households(name)
  values(trim(p_name))
  returning id into hid;

  insert into household_members(household_id, user_id, role)
  values(hid, auth.uid(), 'founder');

  insert into profiles(id, display_name)
  values(
    auth.uid(),
    coalesce(
      nullif(split_part(
        (select email from auth.users where id = auth.uid()),
        '@', 1
      ), ''),
      '家庭成員'
    )
  )
  on conflict(id) do nothing;

  return hid;
end;
$$;

-- 4. Founder and co-admins can create LINE pairing codes.
create or replace function public.create_line_pairing()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  hid uuid;
  rawcode text;
begin
  select household_id into hid
  from household_members
  where user_id = auth.uid()
    and role in ('founder', 'owner')
  limit 1;

  if hid is null then
    raise exception 'Only household administrators can create a pairing code';
  end if;

  rawcode := upper(substr(encode(gen_random_bytes(6), 'hex'), 1, 10));

  insert into line_pairings(
    household_id, code_hash, expires_at, created_by
  )
  values(
    hid,
    encode(digest(rawcode, 'sha256'), 'hex'),
    now() + interval '10 minutes',
    auth.uid()
  );

  return rawcode;
end;
$$;

-- 5. Allow founders and co-admins to update household information.
drop policy if exists "household owner update" on public.households;

create policy "household owner update"
on public.households
for update
using (
  exists (
    select 1
    from public.household_members
    where household_id = id
      and user_id = auth.uid()
      and role in ('founder', 'owner')
  )
)
with check (
  exists (
    select 1
    from public.household_members
    where household_id = id
      and user_id = auth.uid()
      and role in ('founder', 'owner')
  )
);

-- 6. Allow founders and co-admins to read LINE pairing records.
drop policy if exists "pairing owner read" on public.line_pairings;

create policy "pairing owner read"
on public.line_pairings
for select
using (
  exists (
    select 1
    from public.household_members
    where household_id = line_pairings.household_id
      and user_id = auth.uid()
      and role in ('founder', 'owner')
  )
);

-- 7. Each household can have only one founder.
create unique index if not exists household_members_one_founder
on public.household_members (household_id)
where role = 'founder';

-- 8. Promote a member to co-admin.
create or replace function public.promote_household_member(
  p_household_id uuid,
  p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_role text;
begin
  perform 1 from public.households
  where id = p_household_id
  for update;

  if not found then
    raise exception 'Household not found';
  end if;

  select role into caller_role
  from public.household_members
  where household_id = p_household_id
    and user_id = auth.uid();

  if caller_role is null or caller_role not in ('founder', 'owner') then
    raise exception 'Permission denied';
  end if;

  update public.household_members
  set role = 'owner'
  where household_id = p_household_id
    and user_id = p_user_id
    and role = 'member';

  if not found then
    raise exception 'Target member not found or is not a regular member';
  end if;
end;
$$;

-- 9. Only the founder can demote a co-admin.
create or replace function public.demote_household_member(
  p_household_id uuid,
  p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform 1 from public.households
  where id = p_household_id
  for update;

  if not found then
    raise exception 'Household not found';
  end if;

  if not exists (
    select 1 from public.household_members
    where household_id = p_household_id
      and user_id = auth.uid()
      and role = 'founder'
  ) then
    raise exception 'Only the founder can demote a co-admin';
  end if;

  update public.household_members
  set role = 'member'
  where household_id = p_household_id
    and user_id = p_user_id
    and role = 'owner';

  if not found then
    raise exception 'Target co-admin not found';
  end if;
end;
$$;

-- 10. Remove a household member according to role hierarchy.
create or replace function public.remove_household_member(
  p_household_id uuid,
  p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_role text;
  target_role text;
begin
  perform 1
  from public.households
  where id = p_household_id
  for update;

  if not found then
    raise exception 'Household not found';
  end if;

  select role into caller_role
  from public.household_members
  where household_id = p_household_id
    and user_id = auth.uid();

  if caller_role is null or caller_role not in ('founder', 'owner') then
    raise exception 'Permission denied';
  end if;

  select role into target_role
  from public.household_members
  where household_id = p_household_id
    and user_id = p_user_id
  for update;

  if target_role is null or target_role = 'founder' then
    raise exception 'Target member cannot be removed';
  end if;

  if caller_role = 'owner' and target_role <> 'member' then
    raise exception 'Co-admins can only remove regular members';
  end if;

  delete from public.household_members
  where household_id = p_household_id
    and user_id = p_user_id;
end;
$$;

-- 11. Transfer founder status to another household member.
create or replace function public.transfer_household_founder(
  p_household_id uuid,
  p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform 1
  from public.households
  where id = p_household_id
  for update;

  if not found then
    raise exception 'Household not found';
  end if;

  if not exists (
    select 1 from public.household_members
    where household_id = p_household_id
      and user_id = auth.uid()
      and role = 'founder'
  ) then
    raise exception 'Only the founder can transfer founder status';
  end if;

  if p_user_id = auth.uid() then
    raise exception 'Cannot transfer founder status to yourself';
  end if;

  if not exists (
    select 1 from public.household_members
    where household_id = p_household_id
      and user_id = p_user_id
  ) then
    raise exception 'Target must be a member of this household';
  end if;

  update public.household_members
  set role = 'owner'
  where household_id = p_household_id
    and user_id = auth.uid()
    and role = 'founder';

  update public.household_members
  set role = 'founder'
  where household_id = p_household_id
    and user_id = p_user_id;
end;
$$;

-- 12. Restrict management functions to authenticated users.
revoke all on function public.promote_household_member(uuid, uuid) from public;
revoke all on function public.demote_household_member(uuid, uuid) from public;
revoke all on function public.remove_household_member(uuid, uuid) from public;
revoke all on function public.transfer_household_founder(uuid, uuid) from public;

grant execute on function public.promote_household_member(uuid, uuid) to authenticated;
grant execute on function public.demote_household_member(uuid, uuid) to authenticated;
grant execute on function public.remove_household_member(uuid, uuid) to authenticated;
grant execute on function public.transfer_household_founder(uuid, uuid) to authenticated;

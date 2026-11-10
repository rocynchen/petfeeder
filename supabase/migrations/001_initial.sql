-- PetFeeder multi-tenant schema. Run in Supabase SQL Editor.
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '家庭成員',
  created_at timestamptz not null default now()
);
create table if not exists public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null check(length(name) between 1 and 80),
  invite_code text not null unique default upper(substr(encode(gen_random_bytes(8),'hex'),1,10)),
  line_group_id text unique,
  timezone text not null default 'Asia/Taipei',
  created_at timestamptz not null default now()
);
create table if not exists public.household_members (
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check(role in ('owner','member')),
  joined_at timestamptz not null default now(),
  primary key(household_id,user_id)
);
create table if not exists public.pets (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  name text not null check(length(name) between 1 and 50),
  kind text,
  public_token text not null unique default encode(gen_random_bytes(18),'hex'),
  active boolean not null default true,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create table if not exists public.meal_types (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  pet_id uuid not null references public.pets(id) on delete cascade,
  name text not null check(length(name) between 1 and 40),
  scheduled_time time not null,
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create table if not exists public.feedings (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  pet_id uuid not null references public.pets(id) on delete cascade,
  meal_id uuid not null references public.meal_types(id),
  feeding_date date not null,
  fed_at timestamptz not null default now(),
  fed_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  unique(pet_id,meal_id,feeding_date)
);
create table if not exists public.line_pairings (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  code_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create or replace function public.is_household_member(hid uuid)
returns boolean language sql stable security definer set search_path=public
as $$ select exists(select 1 from household_members where household_id=hid and user_id=auth.uid()) $$;

create or replace function public.create_household(p_name text)
returns uuid language plpgsql security definer set search_path=public
as $$
declare hid uuid;
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 if exists(select 1 from household_members where user_id=auth.uid()) then raise exception 'You already belong to a household'; end if;
 insert into households(name) values(trim(p_name)) returning id into hid;
 insert into household_members(household_id,user_id,role) values(hid,auth.uid(),'owner');
 insert into profiles(id,display_name) values(auth.uid(),coalesce(nullif(split_part((select email from auth.users where id=auth.uid()),'@',1),''),'家庭成員')) on conflict(id) do nothing;
 return hid;
end $$;

create or replace function public.join_household(p_invite_code text)
returns uuid language plpgsql security definer set search_path=public
as $$
declare hid uuid;
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 select id into hid from households where invite_code=upper(trim(p_invite_code));
 if hid is null then raise exception 'Invalid invite code'; end if;
 insert into household_members(household_id,user_id) values(hid,auth.uid()) on conflict do nothing;
 insert into profiles(id) values(auth.uid()) on conflict do nothing;
 return hid;
end $$;

create or replace function public.create_line_pairing()
returns text language plpgsql security definer set search_path=public
as $$
declare hid uuid; rawcode text;
begin
 select household_id into hid from household_members where user_id=auth.uid() and role='owner' limit 1;
 if hid is null then raise exception 'Only household owner can create a pairing code'; end if;
 rawcode:=upper(substr(encode(gen_random_bytes(6),'hex'),1,10));
 insert into line_pairings(household_id,code_hash,expires_at,created_by)
 values(hid,encode(digest(rawcode,'sha256'),'hex'),now()+interval '10 minutes',auth.uid());
 return rawcode;
end $$;

alter table profiles enable row level security;
alter table households enable row level security;
alter table household_members enable row level security;
alter table pets enable row level security;
alter table meal_types enable row level security;
alter table feedings enable row level security;
alter table line_pairings enable row level security;

create policy "profile self or household peers" on profiles for select using (
 id=auth.uid() or exists(select 1 from household_members a join household_members b using(household_id) where a.user_id=auth.uid() and b.user_id=profiles.id)
);
create policy "profile self update" on profiles for update using(id=auth.uid()) with check(id=auth.uid());
create policy "household members read" on households for select using(is_household_member(id));
create policy "household owner update" on households for update using(exists(select 1 from household_members where household_id=id and user_id=auth.uid() and role='owner')) with check(is_household_member(id));
create policy "members read" on household_members for select using(is_household_member(household_id));
create policy "pets household all" on pets for all using(is_household_member(household_id)) with check(is_household_member(household_id));
create policy "meals household all" on meal_types for all using(is_household_member(household_id)) with check(is_household_member(household_id));
create policy "feedings household read" on feedings for select using(is_household_member(household_id));
create policy "feedings household insert" on feedings for insert with check(is_household_member(household_id) and fed_by=auth.uid() and exists(select 1 from pets p join meal_types m on m.pet_id=p.id where p.id=feedings.pet_id and m.id=feedings.meal_id and p.household_id=feedings.household_id and m.household_id=feedings.household_id));
create policy "pairing owner read" on line_pairings for select using(exists(select 1 from household_members where household_id=line_pairings.household_id and user_id=auth.uid() and role='owner'));

grant execute on function public.create_household(text) to authenticated;
grant execute on function public.join_household(text) to authenticated;
grant execute on function public.create_line_pairing() to authenticated;
grant execute on function public.is_household_member(uuid) to authenticated;
grant select,insert,update,delete on public.pets,public.meal_types to authenticated;
grant select,insert on public.feedings to authenticated;
grant select on public.households,public.household_members,public.profiles to authenticated;
grant update on public.profiles to authenticated;
grant select on public.line_pairings to authenticated;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path=public
as $$ begin insert into profiles(id,display_name) values(new.id,coalesce(nullif(split_part(new.email,'@',1),''),'家庭成員')) on conflict(id) do nothing; return new; end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute procedure public.handle_new_user();

-- Enable Realtime for live household updates.
alter publication supabase_realtime add table public.feedings;

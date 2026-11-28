begin;

alter table public.profiles
  add column display_name_prompt_seen boolean not null default false;

update public.profiles p
set display_name_prompt_seen=true
from auth.users u
where u.id=p.id and u.last_sign_in_at is not null;

commit;

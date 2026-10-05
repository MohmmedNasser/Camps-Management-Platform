-- Extend the phone mirror (20261005103323) to full_name: same cause, same fix.
-- Both columns are mirrored in both directions; each function no-ops when the
-- mirrored value is already equal, so the two triggers cannot loop.
--
-- NOTE: applied live by hand in the Supabase SQL Editor, so it has NO row in the
-- live migration history (the version above is local only). Same situation as the
-- directly-applied changes documented in BACKEND.md §39.
create or replace function private.sync_profile_phone_to_family_member()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.family_member_id is not null
     and (new.phone is distinct from old.phone or new.full_name is distinct from old.full_name) then
    update public.family_members
       set phone = new.phone,
           full_name = new.full_name
     where id = new.family_member_id
       and (phone is distinct from new.phone or full_name is distinct from new.full_name);
  end if;
  return new;
end;
$$;

create or replace function private.sync_family_member_phone_to_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.phone is distinct from old.phone or new.full_name is distinct from old.full_name then
    update public.profiles
       set phone = new.phone,
           full_name = new.full_name
     where family_member_id = new.id
       and (phone is distinct from new.phone or full_name is distinct from new.full_name);
  end if;
  return new;
end;
$$;

drop trigger profiles_sync_phone_to_family_member on public.profiles;
create trigger profiles_sync_phone_to_family_member
  after update of phone, full_name on public.profiles
  for each row execute function private.sync_profile_phone_to_family_member();

drop trigger family_members_sync_phone_to_profile on public.family_members;
create trigger family_members_sync_phone_to_profile
  after update of phone, full_name on public.family_members
  for each row execute function private.sync_family_member_phone_to_profile();

-- Keep profiles.phone and family_members.phone in step for a displaced account, in both directions.
-- * Displaced person edits profile.html -> profiles.phone; RLS lets only a Camp Admin update family_members.
-- * Camp Admin edits the person's file  -> family_members.phone; the person's account must follow.
-- Each function no-ops when the value is already equal, so the two triggers cannot loop.
create or replace function private.sync_profile_phone_to_family_member()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.family_member_id is not null and new.phone is distinct from old.phone then
    update public.family_members
       set phone = new.phone
     where id = new.family_member_id
       and phone is distinct from new.phone;
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
  if new.phone is distinct from old.phone then
    update public.profiles
       set phone = new.phone
     where family_member_id = new.id
       and phone is distinct from new.phone;
  end if;
  return new;
end;
$$;

revoke all on function private.sync_profile_phone_to_family_member() from public, anon, authenticated;
revoke all on function private.sync_family_member_phone_to_profile() from public, anon, authenticated;

create trigger profiles_sync_phone_to_family_member
  after update of phone on public.profiles
  for each row execute function private.sync_profile_phone_to_family_member();

create trigger family_members_sync_phone_to_profile
  after update of phone on public.family_members
  for each row execute function private.sync_family_member_phone_to_profile();

-- supabase/migrations/20260817090100_phase2_add_family_member.sql
-- Phase 2 §8: add a member to an EXISTING family (displaced-create.html's
-- use case — create_family_with_members handles the one-form path for a
-- brand-new family). Mirrors the camp-scope check already used by
-- create_family_with_members and create_aid_distribution.

create or replace function public.add_family_member(
  p_family_id uuid,
  p_member jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_camp_id uuid;
  v_actor   uuid := (select auth.uid());
  v_id      uuid;
begin
  select camp_id into v_camp_id from public.families where id = p_family_id;

  if not found then
    raise exception 'الأسرة غير موجودة' using errcode = 'P0002';
  end if;

  if private.is_browser_session()
     and not ((select private.is_camp_admin()) and (select private.current_camp_id()) = v_camp_id) then
    raise exception 'لا تملك صلاحية إضافة فرد لهذه الأسرة' using errcode = '42501';
  end if;

  v_id := private.insert_family_member(p_family_id, v_camp_id, p_member, v_actor);
  return v_id;
end;
$$;

revoke all on function public.add_family_member(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.add_family_member(uuid, jsonb) to authenticated;

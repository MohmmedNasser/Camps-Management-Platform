-- supabase/migrations/20260817090300_phase2_fix_family_statistics_join.sql
-- The prior migration joined family_member_facts on `mf.id`, but the view's
-- member identifier column is `member_id` (it exposes `family_members.id
-- AS member_id`, not `id`) — confirmed against the live view definition.
-- The bug was caught by tests/phase2-business-logic.test.mjs
-- ("column mf.id does not exist", 42703) before this shipped anywhere.

create or replace function public.get_family_statistics(p_camp_id uuid default null)
returns table (
  total_families    bigint,
  total_members     bigint,
  children_under_18 bigint,
  orphans           bigint,
  pregnant           bigint,
  breastfeeding     bigint,
  chronic           bigint,
  disability        bigint
)
language plpgsql
security invoker
stable
set search_path = ''
as $$
begin
  if private.is_displaced() then
    raise exception 'الإحصائيات غير متاحة لهذا الحساب' using errcode = '42501';
  end if;

  if private.is_camp_admin() and p_camp_id is distinct from private.current_camp_id() then
    raise exception 'لا تملك صلاحية الاطلاع على إحصائيات مخيم آخر' using errcode = '42501';
  end if;

  return query
  select
    count(distinct f.id)::bigint,
    count(m.id)::bigint,
    count(m.id) filter (where mf.is_child)::bigint,
    count(m.id) filter (where mf.is_orphan)::bigint,
    count(m.id) filter (where mf.is_pregnant)::bigint,
    count(m.id) filter (where mf.is_breastfeeding)::bigint,
    count(m.id) filter (where mf.has_chronic)::bigint,
    count(m.id) filter (where mf.has_disability)::bigint
  from public.families f
  left join public.family_members m on m.family_id = f.id
  left join public.family_member_facts mf on mf.member_id = m.id
  where p_camp_id is null or f.camp_id = p_camp_id;
end;
$$;

revoke all on function public.get_family_statistics(uuid) from public, anon, authenticated;
grant execute on function public.get_family_statistics(uuid) to authenticated;

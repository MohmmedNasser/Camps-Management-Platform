-- supabase/migrations/20260817090200_phase2_statistics.sql
-- Phase 2 §11/§28: dashboard statistics, scoped by role.
-- SECURITY INVOKER: RLS on the underlying tables/views still applies to the
-- caller, so these functions cannot see more than a plain query already
-- could. The explicit role checks below are a second, independent layer
-- that gives a clear error instead of a silently-empty result, matching the
-- authorization style already used by the Phase 1 workflow functions.

create or replace function public.get_family_statistics(p_camp_id uuid default null)
returns table (
  total_families    bigint,
  total_members     bigint,
  children_under_18 bigint,
  orphans           bigint,
  pregnant          bigint,
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
  left join public.family_member_facts mf on mf.id = m.id
  where p_camp_id is null or f.camp_id = p_camp_id;
end;
$$;

revoke all on function public.get_family_statistics(uuid) from public, anon, authenticated;
grant execute on function public.get_family_statistics(uuid) to authenticated;

create or replace function public.get_dashboard_statistics(p_camp_id uuid default null)
returns jsonb
language plpgsql
security invoker
stable
set search_path = ''
as $$
declare
  v_families         jsonb;
  v_aid_count        bigint;
  v_org_count        bigint;
  v_pending_requests bigint;
begin
  if private.is_displaced() then
    raise exception 'الإحصائيات غير متاحة لهذا الحساب' using errcode = '42501';
  end if;

  if private.is_camp_admin() and p_camp_id is distinct from private.current_camp_id() then
    raise exception 'لا تملك صلاحية الاطلاع على إحصائيات مخيم آخر' using errcode = '42501';
  end if;

  select to_jsonb(s) into v_families from public.get_family_statistics(p_camp_id) s;

  select count(*) into v_aid_count
  from public.aid_distributions d
  where p_camp_id is null or d.camp_id = p_camp_id;

  select count(*) into v_org_count from public.organizations;

  select count(*) into v_pending_requests
  from public.registration_requests r
  where r.status = 'pending' and (p_camp_id is null or r.camp_id = p_camp_id);

  return v_families || jsonb_build_object(
    'aid_distributions', v_aid_count,
    'organizations', v_org_count,
    'pending_requests', v_pending_requests
  );
end;
$$;

revoke all on function public.get_dashboard_statistics(uuid) from public, anon, authenticated;
grant execute on function public.get_dashboard_statistics(uuid) to authenticated;

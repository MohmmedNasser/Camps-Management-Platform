-- Phase 4.24: server-side family filtering + statistics aggregation.
-- Additive only: one view and one function. Both run as the CALLER
-- (security_invoker / SECURITY INVOKER), so RLS remains the only boundary.

-- 1. One row per family with head, camp, stats and aid count — replaces three
--    client round trips (families, family_stats by ids, aid links by ids).
create or replace view public.family_overview
with (security_invoker = true) as
select
  f.id                 as family_id,
  f.reference_code,
  f.camp_id,
  c.name               as camp_name,
  h.full_name          as head_name,
  h.tent_type          as head_tent_type,
  f.notes,
  f.created_at,
  s.members_count,
  s.children_under_18,
  s.children_under_3,
  s.children_under_2,
  s.children_under_1,
  s.orphans,
  s.chronic,
  s.disability,
  s.pregnant,
  s.breastfeeding,
  (select count(*) from public.aid_distribution_families a where a.family_id = f.id) as aid_count
from public.families f
left join public.camps c          on c.id = f.camp_id
left join public.family_members h on h.id = f.head_member_id
left join public.family_stats s   on s.family_id = f.id;

revoke all on public.family_overview from public, anon;
grant select on public.family_overview to authenticated;

-- 2. Every statistic on statistics.html except the per-camp table, as one jsonb.
--    Labels stay in the client (config.js): enum breakdowns are value -> count.
--    p_tz: the caller's IANA zone, so month buckets match the browser's own.
create or replace function public.get_statistics_report(p_tz text default 'UTC')
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_month0 date;
  v_stats  jsonb;
begin
  if private.is_displaced() then
    raise exception 'الإحصائيات غير متاحة لهذا الحساب' using errcode = '42501';
  end if;

  -- Raises 22023 for an unknown zone; nothing is read before this.
  v_month0 := date_trunc('month', now() at time zone p_tz)::date;

  select jsonb_build_object(
    'displaced',  count(*),
    'disability', count(*) filter (where m.disability <> ''),
    'chronic',    count(*) filter (where m.chronic_diseases <> ''),
    'males',      count(*) filter (where m.gender = 'male'),
    'females',    count(*) filter (where m.gender = 'female'),
    'children',   count(*) filter (where public.age_in_years(m.birth_date) < 18),
    'orphans',    count(*) filter (where public.is_orphan(m))
  ) into v_stats
  from public.family_members m;

  return jsonb_build_object(
    'stats', v_stats || jsonb_build_object(
      'families',  (select count(*) from public.families),
      'aid',       (select count(*) from public.aid_distributions),
      'donors',    (select count(distinct organization_id) from public.aid_distributions),
      'documents', (select count(*) from public.documents)
    ),
    'by_month', (
      select coalesce(jsonb_agg(jsonb_build_object('month', to_char(g.m, 'YYYY-MM'), 'value', coalesce(x.n, 0)) order by g.m), '[]'::jsonb)
      from generate_series(v_month0 - interval '7 months', v_month0, interval '1 month') as g(m)
      left join (
        select date_trunc('month', created_at at time zone p_tz)::date as d, count(*) as n
        from public.family_members group by 1
      ) x on x.d = g.m::date
    ),
    'aid_by_month', (
      select coalesce(jsonb_agg(jsonb_build_object('month', to_char(g.m, 'YYYY-MM'), 'value', coalesce(x.n, 0)) order by g.m), '[]'::jsonb)
      from generate_series(v_month0 - interval '7 months', v_month0, interval '1 month') as g(m)
      left join (
        select date_trunc('month', distributed_on)::date as d, count(*) as n
        from public.aid_distributions group by 1
      ) x on x.d = g.m::date
    ),
    'aid_by_type', (
      select coalesce(jsonb_object_agg(code, n), '{}'::jsonb)
      from (
        select t.code, count(*) as n
        from public.aid_distribution_types dt
        join public.aid_types t on t.id = dt.aid_type_id
        group by t.code
      ) s
    ),
    'aid_by_organization', (
      select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'count', n) order by n desc, name), '[]'::jsonb)
      from (
        select o.id, o.name, count(*) as n
        from public.aid_distributions d
        join public.organizations o on o.id = d.organization_id
        group by o.id, o.name
      ) s
    ),
    'family_sizes', (
      select jsonb_build_array(
        count(*) filter (where members_count between 1 and 2),
        count(*) filter (where members_count between 3 and 4),
        count(*) filter (where members_count between 5 and 6),
        count(*) filter (where members_count >= 7)
      )
      from public.family_stats
    ),
    'ages', (
      select jsonb_build_array(
        count(*) filter (where a between 0 and 4),
        count(*) filter (where a between 5 and 17),
        count(*) filter (where a between 18 and 40),
        count(*) filter (where a between 41 and 60),
        count(*) filter (where a between 61 and 200)
      )
      from (select public.age_in_years(birth_date) as a from public.family_members) s
    ),
    'work', (
      select coalesce(jsonb_object_agg(k, n), '{}'::jsonb)
      from (select work_status::text as k, count(*) as n from public.family_members where work_status is not null group by 1) s
    ),
    'tents', (
      select coalesce(jsonb_object_agg(k, n), '{}'::jsonb)
      from (select tent_type::text as k, count(*) as n from public.family_members where tent_type is not null group by 1) s
    ),
    'origins', (
      select coalesce(jsonb_object_agg(k, n), '{}'::jsonb)
      from (select origin_governorate::text as k, count(*) as n from public.family_members where origin_governorate is not null group by 1) s
    ),
    'documents_by_category', (
      select coalesce(jsonb_object_agg(k, n), '{}'::jsonb)
      from (select category::text as k, count(*) as n from public.documents group by 1) s
    ),
    'top_families', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'family_id', reference_code, 'count', n, 'head_name', head_name, 'camp_name', camp_name
             ) order by n desc, reference_code), '[]'::jsonb)
      from (
        select f.reference_code, count(*) as n,
               coalesce(h.full_name, '—') as head_name,
               coalesce(c.name, '—')      as camp_name
        from public.aid_distribution_families l
        join public.families f            on f.id = l.family_id
        left join public.family_members h on h.id = f.head_member_id
        left join public.camps c          on c.id = f.camp_id
        group by f.id, f.reference_code, h.full_name, c.name
        order by n desc, f.reference_code
        limit 5
      ) s
    )
  );
end;
$$;

revoke all on function public.get_statistics_report(text) from public, anon;
grant execute on function public.get_statistics_report(text) to authenticated;

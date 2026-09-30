-- Phase 4.25: server-side displaced-persons and aid lists.
-- Additive: one new overload, one behaviour-preserving redefinition, two functions.
-- Everything runs as the CALLER (SECURITY INVOKER): RLS is the only boundary, and a
-- supplied camp/family/organisation id can only narrow what the caller may already read.

-- 1. The canonical age rule, stated once.
--    age = completed years between the birth date and a reference day (today = current_date).
--    The two-argument form lets tests pin the day (birthday yesterday / today / tomorrow)
--    without touching shared rows; the one-argument form every view/function already uses
--    delegates to it, so the rule cannot drift.
create or replace function public.age_in_years(p_birth_date date, p_on date)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case
    when p_birth_date is null or p_on is null then null
    else extract(year from age(p_on, p_birth_date))::integer
  end;
$$;

revoke all on function public.age_in_years(date, date) from public, anon;
grant execute on function public.age_in_years(date, date) to authenticated, service_role;

create or replace function public.age_in_years(p_birth_date date)
returns integer
language sql
stable
set search_path = ''
as $$
  select public.age_in_years(p_birth_date, current_date);
$$;

-- 2. Displaced persons: filter, count and page in one statement.
--    Returns { total, rows[] }. Each row is to_jsonb(family_members) plus
--    family.reference_code, camp.name and age_years, i.e. the shape the old
--    embed `*, family:families(reference_code), camp:camps(name)` produced.
--    yes/no arguments follow the old JS: '' = all, 'yes' = fact, anything else = not fact.
--    Search is a literal, case-insensitive substring (position()), never a LIKE pattern.
create or replace function public.list_displaced_persons(
  p_query              text    default '',
  p_camp_id            uuid    default null,
  p_gender             text    default '',
  p_status             text    default '',
  p_tent_type          text    default '',
  p_age_under          integer default null,
  p_is_child           text    default '',
  p_is_orphan          text    default '',
  p_has_chronic        text    default '',
  p_is_pregnant        text    default '',
  p_is_breastfeeding   text    default '',
  p_aid_type           text    default '',
  p_organization_id    uuid    default null,
  p_limit              integer default 10,
  p_offset             integer default 0
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_term   text    := lower(btrim(coalesce(p_query, '')));
  v_limit  integer := greatest(0, least(coalesce(p_limit, 10), 1000));
  v_offset integer := greatest(0, coalesce(p_offset, 0));
begin
  if not (private.is_super_admin() or private.is_camp_admin()) then
    raise exception 'قائمة النازحين غير متاحة لهذا الحساب' using errcode = '42501';
  end if;

  return (
    with base as (
      select m.id, m.created_at, to_jsonb(m) as j, f.reference_code, c.name as camp_name, a.age
      from public.family_members m
      left join public.families f on f.id = m.family_id
      left join public.camps c    on c.id = m.camp_id
      cross join lateral (select public.age_in_years(m.birth_date) as age) a
      where (p_camp_id is null or m.camp_id = p_camp_id)
        and (coalesce(p_gender, '')    = '' or m.gender::text     = p_gender)
        and (coalesce(p_status, '')    = '' or m.status::text     = p_status)
        and (coalesce(p_tent_type, '') = '' or m.tent_type::text  = p_tent_type)
        and (p_age_under is null or a.age < p_age_under)
        and (coalesce(p_is_child, '')   = '' or coalesce(a.age < 18, false) = (p_is_child = 'yes'))
        and (coalesce(p_is_orphan, '')  = '' or coalesce(public.is_orphan(m), false) = (p_is_orphan = 'yes'))
        and (coalesce(p_has_chronic, '') = '' or (m.chronic_diseases <> '') = (p_has_chronic = 'yes'))
        -- maternity never applies to a male record (domain rule 16)
        and (coalesce(p_is_pregnant, '') = ''
             or (m.gender = 'female' and coalesce(m.is_pregnant, false) = (p_is_pregnant = 'yes')))
        and (coalesce(p_is_breastfeeding, '') = ''
             or (m.gender = 'female' and coalesce(m.is_breastfeeding, false) = (p_is_breastfeeding = 'yes')))
        -- aid type and donor must both hold for the SAME distribution the family received
        and ((coalesce(p_aid_type, '') = '' and p_organization_id is null)
             or exists (
               select 1
               from public.aid_distribution_families adf
               join public.aid_distributions d on d.id = adf.distribution_id
               where adf.family_id = m.family_id
                 and (p_organization_id is null or d.organization_id = p_organization_id)
                 and (coalesce(p_aid_type, '') = '' or exists (
                       select 1
                       from public.aid_distribution_types dt
                       join public.aid_types t on t.id = dt.aid_type_id
                       where dt.distribution_id = d.id and t.code = p_aid_type))
             ))
        and (v_term = ''
             or position(v_term in lower(m.full_name)) > 0
             or position(v_term in lower(coalesce(m.full_name_en, ''))) > 0
             or position(v_term in coalesce(m.national_id, '')) > 0
             or position(v_term in coalesce(m.phone, '')) > 0
             or position(v_term in lower(coalesce(f.reference_code, ''))) > 0)
    )
    select jsonb_build_object(
      'total', (select count(*) from base),
      'rows', coalesce((
        select jsonb_agg(
                 p.j || jsonb_build_object(
                   'family',    jsonb_build_object('reference_code', p.reference_code),
                   'camp',      jsonb_build_object('name', p.camp_name),
                   'age_years', p.age)
                 order by p.created_at, p.id)
        from (select * from base order by created_at, id limit v_limit offset v_offset) p
      ), '[]'::jsonb)
    )
  );
end;
$$;

revoke all on function public.list_displaced_persons(text, uuid, text, text, text, integer, text, text, text, text, text, text, uuid, integer, integer) from public, anon;
grant execute on function public.list_displaced_persons(text, uuid, text, text, text, integer, text, text, text, text, text, text, uuid, integer, integer) to authenticated;

-- 3. Aid distributions: filter, count, summary and page in one statement.
--    Returns { total, summary{organizations,families,types}, rows[] } where each row has the
--    nested shape the old client embed produced. There is deliberately no camp argument:
--    scope (all / own camp / own family) is RLS alone.
create or replace function public.list_aid_distributions(
  p_query            text    default '',
  p_type             text    default '',
  p_organization_id  uuid    default null,
  p_family_id        uuid    default null,
  p_limit            integer default 10,
  p_offset           integer default 0
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_term   text    := lower(btrim(coalesce(p_query, '')));
  v_limit  integer := greatest(0, least(coalesce(p_limit, 10), 1000));
  v_offset integer := greatest(0, coalesce(p_offset, 0));
begin
  if (select auth.uid()) is null
     or not (private.is_super_admin() or private.is_camp_admin() or private.is_displaced()) then
    raise exception 'قائمة المساعدات غير متاحة لهذا الحساب' using errcode = '42501';
  end if;

  return (
    with base as (
      select d.*, o.name as org_name
      from public.aid_distributions d
      left join public.organizations o on o.id = d.organization_id
      where (p_organization_id is null or d.organization_id = p_organization_id)
        and (coalesce(p_type, '') = '' or exists (
               select 1
               from public.aid_distribution_types dt
               join public.aid_types t on t.id = dt.aid_type_id
               where dt.distribution_id = d.id and t.code = p_type))
        and (p_family_id is null or exists (
               select 1 from public.aid_distribution_families l
               where l.distribution_id = d.id and l.family_id = p_family_id))
        and (v_term = ''
             or position(v_term in lower(coalesce(o.name, '—'))) > 0
             or exists (
               select 1
               from public.aid_distribution_families l
               join public.families f on f.id = l.family_id
               left join public.family_members h on h.id = f.head_member_id
               where l.distribution_id = d.id
                 and (position(v_term in lower(coalesce(f.reference_code, ''))) > 0
                      or position(v_term in lower(coalesce(h.full_name, '—'))) > 0))
             or position(v_term in lower((
               select coalesce(string_agg(t.label_ar, '، ' order by t.sort_order, t.code), '')
               from public.aid_distribution_types dt
               join public.aid_types t on t.id = dt.aid_type_id
               where dt.distribution_id = d.id))) > 0)
    )
    select jsonb_build_object(
      'total', (select count(*) from base),
      'summary', jsonb_build_object(
        'organizations', (select count(distinct organization_id) from base),
        'families', (
          select count(distinct f.reference_code)
          from base b
          join public.aid_distribution_families l on l.distribution_id = b.id
          join public.families f on f.id = l.family_id),
        'types', (
          select count(distinct t.code)
          from base b
          join public.aid_distribution_types dt on dt.distribution_id = b.id
          join public.aid_types t on t.id = dt.aid_type_id)
      ),
      'rows', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', p.id,
            'distributed_on', p.distributed_on,
            'all_families_selected', p.all_families_selected,
            'camp_id', p.camp_id,
            'created_at', p.created_at,
            'camp', jsonb_build_object('name', c.name),
            'organization', jsonb_build_object(
              'id', o.id, 'name', o.name, 'responsible_person', o.responsible_person, 'phone', o.phone),
            'aid_distribution_types', (
              select coalesce(jsonb_agg(jsonb_build_object(
                       'aid_type', jsonb_build_object('code', t.code, 'label_ar', t.label_ar))
                       order by t.sort_order, t.code), '[]'::jsonb)
              from public.aid_distribution_types dt
              join public.aid_types t on t.id = dt.aid_type_id
              where dt.distribution_id = p.id),
            'aid_distribution_families', (
              select coalesce(jsonb_agg(jsonb_build_object(
                       'family', jsonb_build_object(
                         'id', f.id,
                         'reference_code', f.reference_code,
                         'head', jsonb_build_object('full_name', h.full_name)))
                       order by f.reference_code), '[]'::jsonb)
              from public.aid_distribution_families l
              join public.families f on f.id = l.family_id
              left join public.family_members h on h.id = f.head_member_id
              where l.distribution_id = p.id),
            'created_by', jsonb_build_object('full_name', pr.full_name))
          order by p.distributed_on desc, p.id desc)
        from (select * from base order by distributed_on desc, id desc limit v_limit offset v_offset) p
        left join public.camps c          on c.id = p.camp_id
        left join public.organizations o  on o.id = p.organization_id
        left join public.profiles pr      on pr.id = p.created_by
      ), '[]'::jsonb)
    )
  );
end;
$$;

revoke all on function public.list_aid_distributions(text, text, uuid, uuid, integer, integer) from public, anon;
grant execute on function public.list_aid_distributions(text, text, uuid, uuid, integer, integer) to authenticated;

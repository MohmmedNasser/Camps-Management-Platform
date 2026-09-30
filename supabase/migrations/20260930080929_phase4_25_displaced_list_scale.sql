-- Phase 4.25 follow-up, found by the rolled-back scale test (12,039 members):
-- list_displaced_persons spent ~390 ms on an unfiltered page because
--   (a) it built to_jsonb(family_members) for EVERY matching row before LIMIT, and
--   (b) it called age_in_years() — a function carrying `SET search_path`, which blocks
--       inlining and costs a GUC save/restore per call — once per row (twice, through the
--       one-argument -> two-argument delegation).
-- Now: filtering/counting runs over ids and sort keys only; the wide row and its age are
-- built for the requested page alone; age filters compare birth_date with a cutoff computed
-- ONCE per call (and can use the existing birth_date index).
-- Same signature, same behaviour, same grants.

-- The exact inverse of the canonical rule, for filtering:
--   age_in_years(birth_date, on) < p_age   <=>   birth_date > age_cutoff_date(p_age, on)
-- (proved over a full calendar sweep, leap days included, in tests/phase4.25-age-rule.test.mjs).
create or replace function public.age_cutoff_date(p_age integer, p_on date default current_date)
returns date
language sql
immutable
set search_path = ''
as $$
  select (p_on - make_interval(years => p_age))::date;
$$;

revoke all on function public.age_cutoff_date(integer, date) from public, anon;
grant execute on function public.age_cutoff_date(integer, date) to authenticated, service_role;

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
  v_on     date    := current_date;
  v_child  date    := public.age_cutoff_date(18, current_date);
  v_under  date    := case when p_age_under is null then null else public.age_cutoff_date(p_age_under, current_date) end;
begin
  if not (private.is_super_admin() or private.is_camp_admin()) then
    raise exception 'قائمة النازحين غير متاحة لهذا الحساب' using errcode = '42501';
  end if;

  return (
    with base as (
      select m.id, m.created_at, m.family_id, m.camp_id
      from public.family_members m
      where (p_camp_id is null or m.camp_id = p_camp_id)
        and (coalesce(p_gender, '')    = '' or m.gender::text     = p_gender)
        and (coalesce(p_status, '')    = '' or m.status::text     = p_status)
        and (coalesce(p_tent_type, '') = '' or m.tent_type::text  = p_tent_type)
        -- age filters: birth_date against a cutoff computed once; a missing birth date has no age
        and (v_under is null or m.birth_date > v_under)
        and (coalesce(p_is_child, '') = '' or coalesce(m.birth_date > v_child, false) = (p_is_child = 'yes'))
        -- is_orphan() implies a deceased parent, so that cheap test comes first and the
        -- function is only called for rows where it could be true
        and (coalesce(p_is_orphan, '') = ''
             or ((m.father_status = 'deceased' or m.mother_status = 'deceased')
                 and coalesce(public.is_orphan(m), false)) = (p_is_orphan = 'yes'))
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
             or exists (
               select 1 from public.families f
               where f.id = m.family_id
                 and position(v_term in lower(coalesce(f.reference_code, ''))) > 0))
    )
    select jsonb_build_object(
      'total', (select count(*) from base),
      'rows', coalesce((
        select jsonb_agg(
                 to_jsonb(m) || jsonb_build_object(
                   'family',    jsonb_build_object('reference_code', f.reference_code),
                   'camp',      jsonb_build_object('name', c.name),
                   'age_years', public.age_in_years(m.birth_date, v_on))
                 order by p.created_at, p.id)
        from (select * from base order by created_at, id limit v_limit offset v_offset) p
        join public.family_members m on m.id = p.id
        left join public.families f  on f.id = p.family_id
        left join public.camps c     on c.id = p.camp_id
      ), '[]'::jsonb)
    )
  );
end;
$$;

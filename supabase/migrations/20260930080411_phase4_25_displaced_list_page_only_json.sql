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
      select m.id, m.created_at, m.family_id, m.camp_id, a.age
      from public.family_members m
      cross join lateral (select public.age_in_years(m.birth_date) as age) a
      where (p_camp_id is null or m.camp_id = p_camp_id)
        and (coalesce(p_gender, '')    = '' or m.gender::text     = p_gender)
        and (coalesce(p_status, '')    = '' or m.status::text     = p_status)
        and (coalesce(p_tent_type, '') = '' or m.tent_type::text  = p_tent_type)
        and (p_age_under is null or a.age < p_age_under)
        and (coalesce(p_is_child, '')   = '' or coalesce(a.age < 18, false) = (p_is_child = 'yes'))
        and (coalesce(p_is_orphan, '')  = '' or coalesce(public.is_orphan(m), false) = (p_is_orphan = 'yes'))
        and (coalesce(p_has_chronic, '') = '' or (m.chronic_diseases <> '') = (p_has_chronic = 'yes'))
        and (coalesce(p_is_pregnant, '') = ''
             or (m.gender = 'female' and coalesce(m.is_pregnant, false) = (p_is_pregnant = 'yes')))
        and (coalesce(p_is_breastfeeding, '') = ''
             or (m.gender = 'female' and coalesce(m.is_breastfeeding, false) = (p_is_breastfeeding = 'yes')))
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
                   'age_years', p.age)
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
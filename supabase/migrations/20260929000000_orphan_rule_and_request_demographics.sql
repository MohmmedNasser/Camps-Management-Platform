-- Two changes:
--
-- 1. Orphan rule. A person is an orphan only when a parent is deceased AND they
--    are a minor (under 18) AND unmarried. A married adult who lost a parent —
--    e.g. a family head — is not an orphan. Age changes with time, so this can
--    no longer be a GENERATED column; it becomes a computed column (a function
--    over the row), which PostgREST still exposes as `is_orphan` for select/filter.
--
-- 2. Registration captures gender + birth date up front, so the camp admin no
--    longer has to guess them at approval time. Nullable for legacy requests.

alter table public.registration_requests
  add column gender public.gender,
  add column birth_date date;

create or replace function public.is_orphan(m public.family_members)
returns boolean
language sql
stable
set search_path = ''
as $$
  select (m.father_status = 'deceased' or m.mother_status = 'deceased')
     and m.marital_status = 'single'
     and coalesce(public.age_in_years(m.birth_date) < 18, false)
$$;

comment on function public.is_orphan(public.family_members) is
  'Orphan = a parent deceased AND under 18 AND unmarried. The single SQL definition.';

create or replace view public.family_member_facts
with (security_invoker = true) as
select
  m.id                                            as member_id,
  m.family_id,
  m.camp_id,
  m.gender,
  public.age_in_years(m.birth_date)               as age_years,
  public.age_in_years(m.birth_date) < 18          as is_child,
  public.age_in_years(m.birth_date) < 3           as under_3,
  public.age_in_years(m.birth_date) < 2           as under_2,
  public.age_in_years(m.birth_date) < 1           as under_1,
  public.is_orphan(m)                             as is_orphan,
  m.chronic_diseases <> ''                        as has_chronic,
  m.disability <> ''                              as has_disability,
  coalesce(m.is_pregnant, false)                  as is_pregnant,
  coalesce(m.is_breastfeeding, false)             as is_breastfeeding,
  m.gender = 'female'                             as maternity_applies
from public.family_members m;

create or replace view public.family_stats
with (security_invoker = true) as
select
  f.id                                                              as family_id,
  f.reference_code,
  f.camp_id,
  count(m.id)                                                       as members_count,
  count(m.id) filter (where public.age_in_years(m.birth_date) < 18) as children_under_18,
  count(m.id) filter (where public.age_in_years(m.birth_date) < 3)  as children_under_3,
  count(m.id) filter (where public.age_in_years(m.birth_date) < 2)  as children_under_2,
  count(m.id) filter (where public.age_in_years(m.birth_date) < 1)  as children_under_1,
  count(m.id) filter (where public.is_orphan(m))                    as orphans,
  count(m.id) filter (where m.chronic_diseases <> '')               as chronic,
  count(m.id) filter (where m.disability <> '')                     as disability,
  count(m.id) filter (where m.is_pregnant)                          as pregnant,
  count(m.id) filter (where m.is_breastfeeding)                     as breastfeeding
from public.families f
left join public.family_members m on m.family_id = f.id
group by f.id, f.reference_code, f.camp_id;

drop index if exists public.family_members_orphans_idx;
alter table public.family_members drop column is_orphan;

-- Approval prefers what the applicant entered at registration; the RPC's own
-- parameters remain as a fallback for requests filed before those fields existed.
create or replace function public.approve_registration_request(
  p_request_id uuid,
  p_gender     public.gender default 'male',
  p_birth_date date default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request   public.registration_requests%rowtype;
  v_family_id uuid;
  v_member_id uuid;
  v_reviewer  uuid := (select auth.uid());
begin
  select * into v_request
  from public.registration_requests
  where id = p_request_id
  for update;

  if not found then
    raise exception 'طلب التسجيل غير موجود' using errcode = 'P0002';
  end if;

  if v_request.status <> 'pending' then
    raise exception 'تمت مراجعة هذا الطلب مسبقاً' using errcode = '22023';
  end if;

  if private.is_browser_session()
     and not (private.is_camp_admin() and private.current_camp_id() = v_request.camp_id) then
    raise exception 'لا تملك صلاحية مراجعة طلبات هذا المخيم' using errcode = '42501';
  end if;

  insert into public.families (camp_id, notes, created_by)
  values (v_request.camp_id, '', v_reviewer)
  returning id into v_family_id;

  insert into public.family_members (
    family_id, camp_id, full_name, gender, birth_date, national_id,
    phone, email, relationship, status, created_by
  )
  values (
    v_family_id, v_request.camp_id, v_request.full_name,
    coalesce(v_request.gender, p_gender, 'male'),
    coalesce(v_request.birth_date, p_birth_date),
    v_request.national_id, v_request.phone, v_request.email, 'head', 'approved', v_reviewer
  )
  returning id into v_member_id;

  update public.families set head_member_id = v_member_id where id = v_family_id;

  update public.registration_requests
  set status = 'approved',
      reviewed_by = v_reviewer,
      reviewed_at = now(),
      family_member_id = v_member_id
  where id = p_request_id;

  if v_request.user_id is not null then
    update public.profiles
    set status = 'approved',
        camp_id = v_request.camp_id,
        family_member_id = v_member_id
    where id = v_request.user_id;

    insert into public.notifications (recipient_id, type, title, body, href)
    values (
      v_request.user_id,
      'success',
      'تم قبول طلب التسجيل',
      'تم قبول طلبك. يمكنك الآن استكمال بياناتك.',
      'profile.html'
    );
  end if;

  return v_member_id;
end;
$$;

-- Project baseline revokes EXECUTE from public; views and PostgREST need it.
revoke all on function public.is_orphan(public.family_members) from public, anon;
grant execute on function public.is_orphan(public.family_members) to authenticated, service_role;

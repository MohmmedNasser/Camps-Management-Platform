-- =============================================================================
-- 002 · Functions, triggers and derived views
--
-- Everything the frontend derives in assets/js/core/selectors.js moves here, so
-- the dashboard statistic, the filter and the Excel export can never disagree
-- about what "طفل", "يتيم" or "مرضعة" means. Business rules are centralised:
-- there is exactly one definition of orphan status, one of a family's member
-- count, and one of who may act on a row.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Pure helpers
-- -----------------------------------------------------------------------------

-- Age in whole years, or null when there is no usable birth date.
-- Mirrors selectors.ageOf(). STABLE, not IMMUTABLE: it depends on current_date,
-- which is why "child" cannot be a stored generated column.
create or replace function public.age_in_years(p_birth_date date)
returns integer
language sql
stable
set search_path = ''
as $$
  select case
    when p_birth_date is null then null
    else extract(year from age(current_date, p_birth_date))::integer
  end;
$$;

comment on function public.age_in_years(date) is
  'Whole years since a birth date. The single definition of age in the platform.';

-- -----------------------------------------------------------------------------
-- Authorization helpers
--
-- All are SECURITY DEFINER because RLS policies on public.profiles would
-- otherwise recurse: a policy on profiles cannot read profiles. Each function
-- looks up ONLY the calling user's own row via auth.uid(), so running with
-- elevated rights leaks nothing beyond what the caller already knows about
-- themselves. They live in `private`, which is not an exposed Data API schema,
-- so none of them is reachable as an RPC.
-- -----------------------------------------------------------------------------

create or replace function private.current_role()
returns public.app_role
language sql
stable
security definer
set search_path = ''
as $$
  select p.role from public.profiles p where p.id = (select auth.uid());
$$;

create or replace function private.current_status()
returns public.account_status
language sql
stable
security definer
set search_path = ''
as $$
  select p.status from public.profiles p where p.id = (select auth.uid());
$$;

create or replace function private.current_camp_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.camp_id from public.profiles p where p.id = (select auth.uid());
$$;

-- The family a displaced account belongs to, resolved through its person record.
-- Personal data is never duplicated onto the profile; this is the join.
create or replace function private.current_family_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.family_id
  from public.profiles p
  join public.family_members m on m.id = p.family_member_id
  where p.id = (select auth.uid());
$$;

create or replace function private.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid())
      and p.role = 'super_admin'
      and p.status = 'active'
  );
$$;

-- A disabled camp admin passes authentication but must fail authorization.
create or replace function private.is_camp_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid())
      and p.role = 'camp_admin'
      and p.status = 'active'
      and p.camp_id is not null
  );
$$;

-- A displaced account is only authorized once its registration was approved;
-- pending and rejected accounts see their status screen and nothing else.
create or replace function private.is_displaced()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid())
      and p.role = 'displaced'
      and p.status = 'approved'
  );
$$;

-- True for any call arriving over the Data API with a browser-issued key.
-- Trusted server-side contexts (secret / service_role key, psql as postgres,
-- the seed script) fall outside it and may bootstrap privileged rows.
--
-- FAILS CLOSED. The test is anchored on `session_user`, which every Data API
-- request runs as `authenticator` regardless of the JWT, and which a direct
-- database connection never does. The JWT claim is consulted only to carve the
-- secret key back out. So an unreadable, empty or malformed claims GUC leaves
-- the caller classified as a browser session and every guard stays ON, rather
-- than silently switching itself off.
--
-- `session_user` is deliberate, not `current_user`: this is called from
-- SECURITY DEFINER triggers, where `current_user` has already become the
-- function owner and would report `postgres` for every caller. SECURITY DEFINER
-- does not change `session_user`.
--
-- SECURITY INVOKER (the default) is also deliberate: the function reads only
-- session state, so it needs no elevated rights.
create or replace function private.is_browser_session()
returns boolean
language sql
stable
set search_path = ''
as $$
  select session_user = 'authenticator'
     and coalesce(
           nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
           ''
         ) <> 'service_role';
$$;

comment on function private.is_browser_session() is
  'True when the caller reached the database through the Data API with a browser key. Fails closed: an unreadable JWT claim keeps every authorization guard enabled.';

-- -----------------------------------------------------------------------------
-- updated_at
-- -----------------------------------------------------------------------------

create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger camps_set_updated_at
  before update on public.camps
  for each row execute function private.set_updated_at();

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function private.set_updated_at();

create trigger families_set_updated_at
  before update on public.families
  for each row execute function private.set_updated_at();

create trigger family_members_set_updated_at
  before update on public.family_members
  for each row execute function private.set_updated_at();

create trigger organizations_set_updated_at
  before update on public.organizations
  for each row execute function private.set_updated_at();

create trigger aid_types_set_updated_at
  before update on public.aid_types
  for each row execute function private.set_updated_at();

create trigger aid_distributions_set_updated_at
  before update on public.aid_distributions
  for each row execute function private.set_updated_at();

create trigger registration_requests_set_updated_at
  before update on public.registration_requests
  for each row execute function private.set_updated_at();

create trigger documents_set_updated_at
  before update on public.documents
  for each row execute function private.set_updated_at();

create trigger messages_set_updated_at
  before update on public.messages
  for each row execute function private.set_updated_at();

create trigger user_preferences_set_updated_at
  before update on public.user_preferences
  for each row execute function private.set_updated_at();

-- -----------------------------------------------------------------------------
-- Family reference code (FAM-000001)
--
-- Replaces selectors.nextFamilyId(), which read the highest existing id in the
-- browser and could hand two concurrent admins the same code.
-- -----------------------------------------------------------------------------

-- SECURITY DEFINER so the sequence itself never has to be granted to
-- `authenticated`, which would let a client burn reference codes at will.
create or replace function private.set_family_reference_code()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.reference_code is null or btrim(new.reference_code) = '' then
    new.reference_code := 'FAM-' || lpad(nextval('public.family_reference_seq')::text, 6, '0');
  end if;
  return new;
end;
$$;

create trigger families_set_reference_code
  before insert on public.families
  for each row execute function private.set_family_reference_code();

-- Development utility: restarts reference codes at FAM-000001 after a wipe.
-- Granted to service_role ONLY in 003 — it is unreachable from any browser key.
create or replace function public.reset_family_reference_sequence()
returns void
language sql
security definer
set search_path = ''
as $$
  select setval('public.family_reference_seq', 1, false);
$$;

-- -----------------------------------------------------------------------------
-- Maternity flags (domain rule 16)
--
-- Written only on female records. Switching a record to ذكر clears both, so a
-- male file shows "لا ينطبق" and the "غير حامل" filter never returns men.
-- -----------------------------------------------------------------------------

create or replace function private.normalize_maternity_fields()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.gender = 'female' then
    new.is_pregnant := coalesce(new.is_pregnant, false);
    new.is_breastfeeding := coalesce(new.is_breastfeeding, false);
  else
    new.is_pregnant := null;
    new.is_breastfeeding := null;
  end if;
  return new;
end;
$$;

create trigger family_members_normalize_maternity
  before insert or update of gender, is_pregnant, is_breastfeeding
  on public.family_members
  for each row execute function private.normalize_maternity_fields();

-- -----------------------------------------------------------------------------
-- A member always lives in their family's camp
--
-- Derived rather than validated, so a hand-crafted request cannot place a
-- person in one camp and their family in another.
-- -----------------------------------------------------------------------------

create or replace function private.sync_member_camp()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_camp_id uuid;
begin
  select f.camp_id into v_camp_id from public.families f where f.id = new.family_id;
  if v_camp_id is null then
    raise exception 'الأسرة % غير موجودة', new.family_id using errcode = '23503';
  end if;
  new.camp_id := v_camp_id;
  return new;
end;
$$;

create trigger family_members_sync_camp
  before insert or update of family_id, camp_id
  on public.family_members
  for each row execute function private.sync_member_camp();

-- -----------------------------------------------------------------------------
-- A family always has a head, and the head is one of its own members
-- -----------------------------------------------------------------------------

-- SECURITY DEFINER so the integrity check sees every row: an invariant must not
-- pass merely because the caller's RLS hid the counter-example.
create or replace function private.enforce_family_head()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reference text;
  v_head_id   uuid;
  v_family_id uuid;
begin
  -- Read the row as it stands NOW, not the version captured when the event was
  -- queued. A deferred AFTER INSERT trigger fires at COMMIT but still carries
  -- the tuple from insert time, so `new` would show the head as null even
  -- though a later UPDATE in the same transaction assigned one — which is
  -- exactly what create_family_with_members does.
  select f.reference_code, f.head_member_id
    into v_reference, v_head_id
  from public.families f
  where f.id = new.id;

  -- The family was deleted later in the same transaction
  -- (promote_family_head drops a family once its last member leaves).
  if not found then
    return null;
  end if;

  if v_head_id is null then
    raise exception 'الأسرة % بلا رب أسرة', v_reference using errcode = '23514';
  end if;

  select m.family_id into v_family_id
  from public.family_members m
  where m.id = v_head_id;

  if v_family_id is distinct from new.id then
    raise exception 'رب الأسرة % غير مسجل ضمن أفرادها', v_reference
      using errcode = '23514';
  end if;

  return new;
end;
$$;

-- Deferred so a family, its head and its members can be written in one
-- transaction without the head existing before the family it points at.
create constraint trigger families_head_is_a_member
  after insert or update on public.families
  deferrable initially deferred
  for each row execute function private.enforce_family_head();

-- -----------------------------------------------------------------------------
-- Removing a head promotes another member rather than orphaning the family
--
-- Mirrors selectors.removeDisplaced(). SECURITY DEFINER so integrity
-- maintenance is not itself blocked by the caller's RLS policies.
-- -----------------------------------------------------------------------------

create or replace function private.promote_family_head()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_head_id uuid;
  v_next_id uuid;
  v_exists  boolean;
begin
  select true, f.head_member_id into v_exists, v_head_id
  from public.families f
  where f.id = old.family_id;

  -- The family itself is being deleted; nothing to repair.
  if not coalesce(v_exists, false) then
    return old;
  end if;

  -- Someone other than the head was removed. The FK's ON DELETE SET NULL may
  -- have already cleared head_member_id, so a null head also means "repair me".
  if v_head_id is not null and v_head_id <> old.id then
    return old;
  end if;

  select m.id into v_next_id
  from public.family_members m
  where m.family_id = old.family_id
  order by m.birth_date asc nulls last, m.created_at asc
  limit 1;

  if v_next_id is null then
    -- The last member left. A family with no members is not a family.
    delete from public.families where id = old.family_id;
  else
    update public.family_members set relationship = 'head' where id = v_next_id;
    update public.families set head_member_id = v_next_id where id = old.family_id;
  end if;

  return old;
end;
$$;

create trigger family_members_promote_head
  after delete on public.family_members
  for each row execute function private.promote_family_head();

-- -----------------------------------------------------------------------------
-- An aid distribution has at least one type and at least one beneficiary family
--
-- Deferred: the junction rows are inserted after the parent row, in the same
-- transaction.
-- -----------------------------------------------------------------------------

create or replace function private.enforce_aid_distribution_complete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- The distribution may have been deleted later in the same transaction.
  if not exists (select 1 from public.aid_distributions d where d.id = new.id) then
    return null;
  end if;

  if not exists (
    select 1 from public.aid_distribution_types t where t.distribution_id = new.id
  ) then
    raise exception 'المساعدة % لا تحتوي على نوع مساعدة', new.id using errcode = '23514';
  end if;

  if not exists (
    select 1 from public.aid_distribution_families f where f.distribution_id = new.id
  ) then
    raise exception 'المساعدة % لا تحتوي على أسر مستفيدة', new.id using errcode = '23514';
  end if;

  return new;
end;
$$;

create constraint trigger aid_distributions_complete
  after insert or update on public.aid_distributions
  deferrable initially deferred
  for each row execute function private.enforce_aid_distribution_complete();

-- A beneficiary family must belong to the camp the distribution was made in.
create or replace function private.enforce_aid_family_camp()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_family_camp uuid;
  v_dist_camp   uuid;
begin
  select f.camp_id into v_family_camp from public.families f where f.id = new.family_id;
  select d.camp_id into v_dist_camp from public.aid_distributions d where d.id = new.distribution_id;

  if v_family_camp is distinct from v_dist_camp then
    raise exception 'الأسرة المستفيدة في مخيم مختلف عن المساعدة' using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger aid_distribution_families_same_camp
  before insert or update on public.aid_distribution_families
  for each row execute function private.enforce_aid_family_camp();

-- -----------------------------------------------------------------------------
-- Privilege-escalation guard on profiles
--
-- RLS decides which rows a user may update; this decides which COLUMNS. Without
-- it, a displaced user with a legitimate "edit my profile" policy could send
-- role: 'super_admin' in the request body.
-- -----------------------------------------------------------------------------

create or replace function private.guard_profile_privileges()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Trusted server-side contexts (service_role, postgres, the seed script)
  -- bootstrap these columns legitimately.
  if not private.is_browser_session() then
    return new;
  end if;

  if new.id is distinct from old.id then
    raise exception 'لا يمكن تغيير معرّف الحساب' using errcode = '42501';
  end if;

  if new.role is distinct from old.role and not private.is_super_admin() then
    raise exception 'لا تملك صلاحية تغيير دور الحساب' using errcode = '42501';
  end if;

  -- A Camp Admin may attach a newly approved account to their OWN camp (the
  -- approval workflow does exactly this) and nothing else.
  if new.camp_id is distinct from old.camp_id
     and not private.is_super_admin()
     and not (
       old.camp_id is null
       and private.is_camp_admin()
       and new.camp_id = private.current_camp_id()
     ) then
    raise exception 'لا تملك صلاحية تغيير مخيم الحساب' using errcode = '42501';
  end if;

  if new.status is distinct from old.status
     and not (private.is_super_admin() or private.is_camp_admin()) then
    raise exception 'لا تملك صلاحية تغيير حالة الحساب' using errcode = '42501';
  end if;

  if new.family_member_id is distinct from old.family_member_id
     and not (private.is_super_admin() or private.is_camp_admin()) then
    raise exception 'لا تملك صلاحية ربط الحساب بسجل نازح' using errcode = '42501';
  end if;

  return new;
end;
$$;

create trigger profiles_guard_privileges
  before update on public.profiles
  for each row execute function private.guard_profile_privileges();

-- A recipient may mark a notification read; they may not rewrite its content.
create or replace function private.guard_notification_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_browser_session() then
    return new;
  end if;

  if new.recipient_id is distinct from old.recipient_id
     or new.title is distinct from old.title
     or new.body is distinct from old.body
     or new.type is distinct from old.type
     or new.href is distinct from old.href
     or new.created_at is distinct from old.created_at then
    raise exception 'لا يمكن تعديل محتوى الإشعار' using errcode = '42501';
  end if;

  if new.is_read and new.read_at is null then
    new.read_at := now();
  end if;

  return new;
end;
$$;

create trigger notifications_guard_update
  before update on public.notifications
  for each row execute function private.guard_notification_update();

-- -----------------------------------------------------------------------------
-- auth.users -> profiles
--
-- The role is HARD-CODED to 'displaced'. raw_user_meta_data is user-editable,
-- so a sign-up that asked for role: 'super_admin' would otherwise grant it.
-- Elevated roles are assigned only by the Super Admin or the seed script.
-- -----------------------------------------------------------------------------

create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name, phone, role, status)
  values (
    new.id,
    coalesce(nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''), split_part(new.email, '@', 1)),
    nullif(btrim(new.raw_user_meta_data ->> 'phone'), ''),
    'displaced',   -- never read from user metadata
    'pending'
  )
  on conflict (id) do nothing;

  insert into public.user_preferences (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- -----------------------------------------------------------------------------
-- Derived views
--
-- security_invoker = true so the caller's RLS on the base tables applies.
-- Without it a view would hand every row to every reader.
-- -----------------------------------------------------------------------------

-- The boolean facts every filter, statistic and export column asks about one
-- person — the SQL equivalent of selectors.personFacts().
create view public.family_member_facts
with (security_invoker = true) as
select
  m.id                                            as member_id,
  m.family_id,
  m.camp_id,
  m.gender,
  public.age_in_years(m.birth_date)               as age_years,
  -- Age bands are CUMULATIVE, not disjoint: under_2 includes under_1.
  public.age_in_years(m.birth_date) < 18          as is_child,
  public.age_in_years(m.birth_date) < 3           as under_3,
  public.age_in_years(m.birth_date) < 2           as under_2,
  public.age_in_years(m.birth_date) < 1           as under_1,
  m.is_orphan,
  m.chronic_diseases <> ''                        as has_chronic,
  m.disability <> ''                              as has_disability,
  coalesce(m.is_pregnant, false)                  as is_pregnant,
  coalesce(m.is_breastfeeding, false)             as is_breastfeeding,
  m.gender = 'female'                             as maternity_applies
from public.family_members m;

comment on view public.family_member_facts is
  'One row per displaced person with every derived fact. Age bands are cumulative: "أقل من سنتين" includes infants under one.';

-- Aggregate counts per family — the SQL equivalent of selectors.familyFacts().
-- members_count is computed here and never stored (domain rule 12).
create view public.family_stats
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
  count(m.id) filter (where m.is_orphan)                            as orphans,
  count(m.id) filter (where m.chronic_diseases <> '')               as chronic,
  count(m.id) filter (where m.disability <> '')                     as disability,
  count(m.id) filter (where m.is_pregnant)                          as pregnant,
  count(m.id) filter (where m.is_breastfeeding)                     as breastfeeding
from public.families f
left join public.family_members m on m.family_id = f.id
group by f.id, f.reference_code, f.camp_id;

comment on view public.family_stats is
  'Derived family aggregates. members_count is always computed, never stored.';

-- -----------------------------------------------------------------------------
-- Transactional entry points
--
-- Two invariants above are enforced by DEFERRABLE constraint triggers, which
-- fire at COMMIT. The Data API runs every request in its own transaction, so a
-- family cannot be inserted in one call and given a head in the next — the
-- first call would commit headless and be rejected. These functions are the
-- single-call form of those writes.
--
-- This is deliberately NOT general CRUD (that is Phase 2). Only the two writes
-- whose invariants span more than one row are exposed here.
-- -----------------------------------------------------------------------------

-- Inserts one person from a jsonb payload. Columns are listed explicitly rather
-- than splatted, because is_orphan is GENERATED ALWAYS and cannot be written,
-- and because every optional field needs its table default when the payload
-- omits it. This is the single place a person row is built from JSON.
create or replace function private.insert_family_member(
  p_family_id uuid,
  p_camp_id   uuid,
  p_data      jsonb,
  p_actor     uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  insert into public.family_members (
    family_id, camp_id,
    full_name, full_name_en, gender, birth_date, marital_status,
    national_id, passport_number, unrwa_number, nationality,
    phone, alt_phone, email,
    governorate, city, area, tent_type,
    origin_governorate, origin_city, displacement_date,
    chronic_diseases, disability, father_status, mother_status,
    is_pregnant, is_breastfeeding,
    work_status, income_source, monthly_income,
    relationship, status, created_by
  )
  values (
    p_family_id,
    p_camp_id,
    p_data ->> 'full_name',
    nullif(p_data ->> 'full_name_en', ''),
    (p_data ->> 'gender')::public.gender,
    nullif(p_data ->> 'birth_date', '')::date,
    coalesce(nullif(p_data ->> 'marital_status', '')::public.marital_status, 'single'),
    p_data ->> 'national_id',
    nullif(p_data ->> 'passport_number', ''),
    nullif(p_data ->> 'unrwa_number', ''),
    coalesce(nullif(p_data ->> 'nationality', '')::public.nationality, 'palestinian'),
    nullif(p_data ->> 'phone', ''),
    nullif(p_data ->> 'alt_phone', ''),
    nullif(p_data ->> 'email', ''),
    nullif(p_data ->> 'governorate', '')::public.governorate,
    nullif(p_data ->> 'city', ''),
    nullif(p_data ->> 'area', ''),
    coalesce(nullif(p_data ->> 'tent_type', '')::public.tent_type, 'tarp_tent'),
    nullif(p_data ->> 'origin_governorate', '')::public.governorate,
    nullif(p_data ->> 'origin_city', ''),
    nullif(p_data ->> 'displacement_date', '')::date,
    coalesce(p_data ->> 'chronic_diseases', ''),
    coalesce(p_data ->> 'disability', ''),
    coalesce(nullif(p_data ->> 'father_status', '')::public.parent_status, 'alive'),
    coalesce(nullif(p_data ->> 'mother_status', '')::public.parent_status, 'alive'),
    (p_data ->> 'is_pregnant')::boolean,
    (p_data ->> 'is_breastfeeding')::boolean,
    coalesce(nullif(p_data ->> 'work_status', '')::public.work_status, 'unemployed'),
    coalesce(nullif(p_data ->> 'income_source', '')::public.income_source, 'none'),
    coalesce(nullif(p_data ->> 'monthly_income', '')::numeric, 0),
    coalesce(nullif(p_data ->> 'relationship', '')::public.family_relationship, 'head'),
    coalesce(nullif(p_data ->> 'status', '')::public.account_status, 'approved'),
    p_actor
  )
  returning id into v_id;

  return v_id;
end;
$$;

-- Registers a family, its head and every remaining member in one submit —
-- the database form of selectors.createFamilyWithMembers(). Members inherit the
-- household fields from the head, since they live in the same shelter.
create or replace function public.create_family_with_members(
  p_camp_id    uuid,
  p_head       jsonb,
  p_members    jsonb default '[]'::jsonb,
  p_notes      text default '',
  p_created_by uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_family_id uuid;
  v_head_id   uuid;
  v_actor     uuid := coalesce((select auth.uid()), p_created_by);
  v_member    jsonb;
  v_shared    jsonb := '{}'::jsonb;
  v_key       text;
begin
  if private.is_browser_session()
     and not ((select private.is_camp_admin()) and (select private.current_camp_id()) = p_camp_id) then
    raise exception 'لا تملك صلاحية إضافة أسرة في هذا المخيم' using errcode = '42501';
  end if;

  insert into public.families (camp_id, notes, created_by)
  values (p_camp_id, coalesce(p_notes, ''), v_actor)
  returning id into v_family_id;

  v_head_id := private.insert_family_member(
    v_family_id,
    p_camp_id,
    p_head || jsonb_build_object('relationship', 'head'),
    v_actor
  );

  update public.families set head_member_id = v_head_id where id = v_family_id;

  -- The fields a household shares, copied from the head onto every member.
  foreach v_key in array array[
    'tent_type', 'origin_governorate', 'origin_city', 'displacement_date',
    'governorate', 'city', 'area'
  ]
  loop
    if nullif(p_head ->> v_key, '') is not null then
      v_shared := v_shared || jsonb_build_object(v_key, p_head -> v_key);
    end if;
  end loop;

  for v_member in select * from jsonb_array_elements(coalesce(p_members, '[]'::jsonb))
  loop
    perform private.insert_family_member(v_family_id, p_camp_id, v_shared || v_member, v_actor);
  end loop;

  return v_family_id;
end;
$$;

comment on function public.create_family_with_members(uuid, jsonb, jsonb, text, uuid) is
  'Domain rule 13: a family and its members are registered through ONE form, therefore one transaction.';

-- Records a distribution together with its aid types and beneficiary families.
-- Domain rule 9: no value, no price, no individual recipient — only what was
-- distributed, by whom, to which families and when.
create or replace function public.create_aid_distribution(
  p_organization_id       uuid,
  p_camp_id               uuid,
  p_distributed_on        date,
  p_aid_type_codes        text[],
  p_family_ids            uuid[],
  p_all_families_selected boolean default false,
  p_created_by            uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id    uuid;
  v_actor uuid := coalesce((select auth.uid()), p_created_by);
begin
  -- Domain rule 8: aid is created by Camp Admin only, for their own camp.
  if private.is_browser_session()
     and not ((select private.is_camp_admin()) and (select private.current_camp_id()) = p_camp_id) then
    raise exception 'المساعدات يضيفها مسؤول المخيم فقط' using errcode = '42501';
  end if;

  if coalesce(array_length(p_aid_type_codes, 1), 0) = 0 then
    raise exception 'يجب اختيار نوع مساعدة واحد على الأقل' using errcode = '23514';
  end if;

  insert into public.aid_distributions (
    organization_id, camp_id, distributed_on, all_families_selected, created_by
  )
  values (p_organization_id, p_camp_id, p_distributed_on, p_all_families_selected, v_actor)
  returning id into v_id;

  insert into public.aid_distribution_types (distribution_id, aid_type_id)
  select v_id, t.id
  from public.aid_types t
  where t.code = any (p_aid_type_codes)
  on conflict do nothing;

  -- "All eligible families" still materialises one row per family: the
  -- beneficiary list is relational, never a flag the reader has to expand.
  insert into public.aid_distribution_families (distribution_id, family_id)
  select v_id, f.id
  from public.families f
  where f.camp_id = p_camp_id
    and (
      p_all_families_selected
      or f.id = any (coalesce(p_family_ids, array[]::uuid[]))
    )
  on conflict do nothing;

  return v_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Registration workflow
--
-- Approving a request creates several records at once — a person, a family with
-- them as its head, an activated account and a notification. It runs as one
-- transaction in the database so the workflow cannot be half-applied, and it
-- authorises the caller internally rather than trusting the UI.
-- -----------------------------------------------------------------------------

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

  -- Reviewing a request is a Camp Admin action, for their own camp only.
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
    v_family_id, v_request.camp_id, v_request.full_name, p_gender, p_birth_date,
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

create or replace function public.reject_registration_request(
  p_request_id uuid,
  p_note       text default ''
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request  public.registration_requests%rowtype;
  v_reviewer uuid := (select auth.uid());
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

  update public.registration_requests
  set status = 'rejected',
      reviewed_by = v_reviewer,
      reviewed_at = now(),
      note = coalesce(p_note, '')
  where id = p_request_id;

  if v_request.user_id is not null then
    update public.profiles
    set status = 'rejected',
        rejection_reason = nullif(btrim(coalesce(p_note, '')), '')
    where id = v_request.user_id;

    insert into public.notifications (recipient_id, type, title, body, href)
    values (
      v_request.user_id,
      'error',
      'تم رفض طلب التسجيل',
      coalesce(nullif(btrim(p_note), ''), 'يمكنك مراجعة إدارة المخيم لمعرفة التفاصيل.'),
      'rejected.html'
    );
  end if;
end;
$$;

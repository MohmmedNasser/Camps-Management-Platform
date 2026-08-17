-- =============================================================================
-- 001 · Initial schema
-- Displaced Camps Management Platform — Phase 1 backend foundation.
--
-- Source of truth for every shape here is the existing HTML/CSS/JS frontend:
--   assets/js/core/config.js      -> the enum types below
--   assets/js/data/mock-data.js   -> the columns below
--   assets/js/core/selectors.js   -> the derived values (see 002)
--   assets/js/core/auth.js        -> the permission matrix (see 003)
--
-- Domain rules deliberately encoded as ABSENCES. Do not "fix" these:
--   * no tent number, no caravan number, no file number   (shelter TYPE only)
--   * no current-residence field
--   * no document expiry date, no displacement-proof type
--   * no aid value / price / estimated value / individual recipient
--   * no manually editable orphan flag (derived from parent status)
--   * no representative name (the camp admin IS the representative)
--   * no "family needs" in the economic section
--   * organisations carry a name plus an OPTIONAL phone and responsible person
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Schemas
-- -----------------------------------------------------------------------------

-- `private` holds SECURITY DEFINER authorization helpers. It is never added to
-- the Data API's exposed schemas, so nothing in it is reachable as an RPC.
create schema if not exists private;

revoke all on schema private from public;
revoke all on schema private from anon;
revoke all on schema private from authenticated;

comment on schema private is
  'Internal helpers (authorization, triggers). Never exposed to the Data API.';

-- -----------------------------------------------------------------------------
-- Enumerated domains
-- Mirrors the { value, label } lists in assets/js/core/config.js. Arabic labels
-- stay in the frontend; the database stores the stable English value.
-- -----------------------------------------------------------------------------

create type public.app_role as enum ('super_admin', 'camp_admin', 'displaced');

-- One enum covers both account lifecycles the frontend uses: pending/approved/
-- rejected for displaced sign-ups, active/disabled for staff accounts.
create type public.account_status as enum (
  'pending', 'approved', 'rejected', 'active', 'disabled'
);

create type public.camp_status as enum ('active', 'disabled');

create type public.request_status as enum ('pending', 'approved', 'rejected');

create type public.gender as enum ('male', 'female');

create type public.marital_status as enum ('single', 'married', 'divorced', 'widowed');

create type public.parent_status as enum ('alive', 'deceased');

create type public.nationality as enum ('palestinian', 'other');

-- Shelter TYPE, never a tent or caravan number. Exactly two values by domain rule.
create type public.tent_type as enum ('tarp_tent', 'prefab_tent');

create type public.governorate as enum (
  'north_gaza', 'gaza', 'deir_albalah', 'khan_younis', 'rafah'
);

create type public.work_status as enum (
  'employed', 'unemployed', 'irregular', 'student', 'unable'
);

create type public.income_source as enum (
  'salary', 'daily_work', 'aid', 'trade', 'none'
);

create type public.family_relationship as enum (
  'head', 'spouse', 'son', 'daughter', 'father', 'mother', 'brother', 'sister', 'other'
);

create type public.document_category as enum (
  'id_card', 'passport', 'birth_certificate', 'medical_report', 'other'
);

create type public.message_subject as enum (
  'aid_request', 'data_update', 'complaint', 'document', 'other'
);

create type public.message_status as enum ('unread', 'read', 'replied');

create type public.notification_type as enum ('info', 'success', 'warning', 'error');

-- -----------------------------------------------------------------------------
-- camps
-- -----------------------------------------------------------------------------

create table public.camps (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  governorate   public.governorate not null,
  city          text not null default '',
  status        public.camp_status not null default 'active',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint camps_name_not_blank check (length(btrim(name)) > 0)
);

create unique index camps_name_key on public.camps (lower(btrim(name)));
create index camps_status_idx on public.camps (status);

comment on table public.camps is
  'A displacement camp. The camp admin is the camp representative — there is no separate representative-name column.';

-- -----------------------------------------------------------------------------
-- profiles  (auth.users -> application identity)
--
-- Passwords, emails and sessions live in auth.users and are managed by Supabase
-- Auth. This table holds only application-specific attributes. `role` is NEVER
-- written from the browser: see the privilege-escalation trigger in 002 and the
-- RLS policies in 003.
-- -----------------------------------------------------------------------------

create table public.profiles (
  id                      uuid primary key references auth.users (id) on delete cascade,
  full_name               text not null default '',
  phone                   text,
  role                    public.app_role not null default 'displaced',
  camp_id                 uuid references public.camps (id) on delete restrict,
  -- Set when a displaced account is linked to its person record. Declared as a
  -- foreign key at the end of this file, once family_members exists.
  family_member_id        uuid,
  registration_request_id uuid,
  status                  public.account_status not null default 'pending',
  rejection_reason        text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  -- The single Super Admin is system-wide and belongs to no camp; a Camp Admin
  -- must belong to exactly one.
  constraint profiles_camp_scope_valid check (
    (role = 'super_admin' and camp_id is null)
    or (role = 'camp_admin' and camp_id is not null)
    or (role = 'displaced')
  ),
  constraint profiles_phone_format check (phone is null or phone ~ '^[0-9+\-\s]{6,20}$')
);

-- Domain rule 1: exactly ONE Super Admin. Every super_admin row would carry the
-- same value in this partial index, so a second one cannot be inserted.
create unique index profiles_single_super_admin_idx
  on public.profiles (role)
  where role = 'super_admin';

create index profiles_role_idx on public.profiles (role);
create index profiles_camp_id_idx on public.profiles (camp_id);
create index profiles_status_idx on public.profiles (status);
create index profiles_family_member_id_idx on public.profiles (family_member_id);
create index profiles_registration_request_id_idx on public.profiles (registration_request_id);

comment on table public.profiles is
  'Application identity for an auth.users row. Role and camp are assigned server-side only.';
comment on column public.profiles.role is
  'Authoritative role. Never trusted from localStorage, the browser, a URL or a request body.';

-- -----------------------------------------------------------------------------
-- families
--
-- An independent entity with its own generated reference code (FAM-000001),
-- replacing selectors.nextFamilyId() — the sequence removes its race condition.
-- membersCount is NEVER stored: see the family_stats view in 002.
-- -----------------------------------------------------------------------------

create sequence public.family_reference_seq as bigint start 1;

create table public.families (
  id              uuid primary key default gen_random_uuid(),
  reference_code  text not null,
  camp_id         uuid not null references public.camps (id) on delete restrict,
  -- Nullable only while the family and its head are inserted in one transaction;
  -- a deferred constraint trigger (002) rejects a family left headless at commit.
  head_member_id  uuid,
  notes           text not null default '',
  created_by      uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint families_reference_code_format check (reference_code ~ '^FAM-[0-9]{6,}$')
);

create unique index families_reference_code_key on public.families (reference_code);
create index families_camp_id_idx on public.families (camp_id);
create index families_head_member_id_idx on public.families (head_member_id);
create index families_created_by_idx on public.families (created_by);
create index families_created_at_idx on public.families (created_at desc);

comment on table public.families is
  'A household. The beneficiary of aid is always the family, never a nominated individual.';
comment on column public.families.reference_code is
  'Human-readable identifier shown in the UI, e.g. FAM-000001. Generated by trigger.';

-- -----------------------------------------------------------------------------
-- family_members
--
-- This is the "displaced person" record. In the existing frontend every
-- displaced person belongs to exactly one family, so the two are one table.
-- -----------------------------------------------------------------------------

create table public.family_members (
  id                  uuid primary key default gen_random_uuid(),
  family_id           uuid not null references public.families (id) on delete cascade,
  camp_id             uuid not null references public.camps (id) on delete restrict,

  -- Identity
  full_name           text not null,
  full_name_en        text,
  gender              public.gender not null,
  birth_date          date,
  marital_status      public.marital_status not null default 'single',
  national_id         text not null,
  passport_number     text,
  unrwa_number        text,
  nationality         public.nationality not null default 'palestinian',

  -- Contact
  phone               text,
  alt_phone           text,
  email               text,

  -- Current location
  governorate         public.governorate,
  city                text,
  area                text,

  -- Shelter: TYPE only. No tent number, no caravan number, no file number.
  tent_type           public.tent_type not null default 'tarp_tent',

  -- Origin / displacement
  origin_governorate  public.governorate,
  origin_city         text,
  displacement_date   date,

  -- Health: chronic disease and disability ONLY. Do not add other conditions.
  chronic_diseases    text not null default '',
  disability          text not null default '',

  -- Parent status — the only input to orphan status (domain rule 13).
  father_status       public.parent_status not null default 'alive',
  mother_status       public.parent_status not null default 'alive',

  -- Orphan is DERIVED, never a manually editable checkbox.
  is_orphan           boolean generated always as (
                        father_status = 'deceased' or mother_status = 'deceased'
                      ) stored,

  -- Maternity flags exist only on female records. A male file shows
  -- "لا ينطبق", never "حامل: لا". Normalised by trigger in 002.
  is_pregnant         boolean,
  is_breastfeeding    boolean,

  -- Economic section. No "family needs" field by domain rule.
  work_status         public.work_status not null default 'unemployed',
  income_source       public.income_source not null default 'none',
  monthly_income      numeric(12, 2) not null default 0,

  relationship        public.family_relationship not null default 'head',
  status              public.account_status not null default 'approved',
  created_by          uuid references public.profiles (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint family_members_full_name_not_blank check (length(btrim(full_name)) > 0),
  constraint family_members_national_id_format check (national_id ~ '^[0-9]{9}$'),
  constraint family_members_monthly_income_non_negative check (monthly_income >= 0),
  constraint family_members_birth_date_sane check (
    birth_date is null or (birth_date > date '1900-01-01' and birth_date <= current_date)
  ),
  constraint family_members_phone_format check (phone is null or phone ~ '^[0-9+\-\s]{6,20}$'),
  constraint family_members_alt_phone_format check (alt_phone is null or alt_phone ~ '^[0-9+\-\s]{6,20}$'),
  constraint family_members_email_format check (email is null or email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),

  -- Domain rule 16: maternity flags are written only on female records.
  constraint family_members_maternity_female_only check (
    gender = 'female'
    or (is_pregnant is null and is_breastfeeding is null)
  )
);

-- Domain rule 12 / spec §12: national ID is the duplicate-registration guard,
-- enforced by the database and not only by frontend JavaScript. Because it is
-- unique platform-wide, one national ID also cannot exist in two camps.
create unique index family_members_national_id_key on public.family_members (national_id);

create index family_members_family_id_idx on public.family_members (family_id);
create index family_members_camp_id_idx on public.family_members (camp_id);
create index family_members_status_idx on public.family_members (status);
create index family_members_birth_date_idx on public.family_members (birth_date);
create index family_members_created_at_idx on public.family_members (created_at desc);
create index family_members_created_by_idx on public.family_members (created_by);

-- Partial indexes for the filters that actually run on this table. Each covers
-- a small minority of rows, so the index stays far smaller than a full one.
create index family_members_orphans_idx on public.family_members (family_id)
  where is_orphan;
create index family_members_chronic_idx on public.family_members (family_id)
  where chronic_diseases <> '';
create index family_members_disability_idx on public.family_members (family_id)
  where disability <> '';
create index family_members_pregnant_idx on public.family_members (family_id)
  where is_pregnant;
create index family_members_breastfeeding_idx on public.family_members (family_id)
  where is_breastfeeding;

-- Search covers names and identifiers only — never a file number or tent
-- number, neither of which exists (domain rule 7). Prefix search for now;
-- pg_trgm substring search arrives with the Phase 2 search endpoint.
create index family_members_full_name_idx
  on public.family_members (lower(full_name) text_pattern_ops);

comment on table public.family_members is
  'A displaced person. Health data is limited to chronic disease and disability, and is protected by RLS.';
comment on column public.family_members.is_orphan is
  'DERIVED: father or mother deceased. There is no manual orphan checkbox anywhere in the platform.';
comment on column public.family_members.tent_type is
  'Shelter TYPE. The platform stores no tent number, caravan number or file number.';

-- families.head_member_id could not reference family_members before it existed.
alter table public.families
  add constraint families_head_member_id_fkey
  foreign key (head_member_id) references public.family_members (id) on delete set null;

alter table public.profiles
  add constraint profiles_family_member_id_fkey
  foreign key (family_member_id) references public.family_members (id) on delete set null;

-- -----------------------------------------------------------------------------
-- organizations  (aid donors)
--
-- Domain rule 11: a donor may be an organisation, an initiative or a single
-- person. Name is required; phone and responsible person are OPTIONAL. There is
-- deliberately no email, logo, website or address.
-- -----------------------------------------------------------------------------

create table public.organizations (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  responsible_person  text,
  phone               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint organizations_name_not_blank check (length(btrim(name)) > 0),
  constraint organizations_phone_format check (phone is null or phone ~ '^[0-9+\-\s]{6,20}$')
);

create unique index organizations_name_key on public.organizations (lower(btrim(name)));

comment on table public.organizations is
  'Aid donors: associations, institutions, initiatives or individuals. Phone is optional.';

-- -----------------------------------------------------------------------------
-- aid_types  (lookup)
-- -----------------------------------------------------------------------------

create table public.aid_types (
  id          uuid primary key default gen_random_uuid(),
  code        text not null,
  label_ar    text not null,
  sort_order  integer not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint aid_types_code_format check (code ~ '^[a-z][a-z0-9_]*$')
);

create unique index aid_types_code_key on public.aid_types (code);
create index aid_types_active_idx on public.aid_types (sort_order) where is_active;

comment on table public.aid_types is
  'Aid categories (طرد غذائي، أدوات تنظيف …). Seeded as reference data, not development data.';

-- -----------------------------------------------------------------------------
-- aid_distributions
--
-- Domain rule 9: aid is NOT a financial transaction. There is no value, price,
-- estimated value or individual recipient anywhere in this table.
-- -----------------------------------------------------------------------------

create table public.aid_distributions (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references public.organizations (id) on delete restrict,
  camp_id                uuid not null references public.camps (id) on delete restrict,
  distributed_on         date not null,
  -- Records the admin's intent ("all eligible families"); the beneficiaries are
  -- still materialised as rows in aid_distribution_families.
  all_families_selected  boolean not null default false,
  created_by             uuid references public.profiles (id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint aid_distributions_date_sane check (
    distributed_on > date '2000-01-01' and distributed_on <= current_date + 1
  )
);

create index aid_distributions_organization_id_idx on public.aid_distributions (organization_id);
create index aid_distributions_camp_id_idx on public.aid_distributions (camp_id);
create index aid_distributions_distributed_on_idx on public.aid_distributions (distributed_on desc);
create index aid_distributions_camp_date_idx on public.aid_distributions (camp_id, distributed_on desc);
create index aid_distributions_created_by_idx on public.aid_distributions (created_by);

comment on table public.aid_distributions is
  'A distribution event. Carries no monetary value and no individual recipient — the beneficiary is the family.';

-- -----------------------------------------------------------------------------
-- aid_distribution_types  (junction: one distribution -> many aid types)
-- -----------------------------------------------------------------------------

create table public.aid_distribution_types (
  distribution_id  uuid not null references public.aid_distributions (id) on delete cascade,
  aid_type_id      uuid not null references public.aid_types (id) on delete restrict,
  created_at       timestamptz not null default now(),

  primary key (distribution_id, aid_type_id)
);

create index aid_distribution_types_aid_type_id_idx on public.aid_distribution_types (aid_type_id);

-- -----------------------------------------------------------------------------
-- aid_distribution_families  (junction: one distribution -> many families)
-- -----------------------------------------------------------------------------

create table public.aid_distribution_families (
  distribution_id  uuid not null references public.aid_distributions (id) on delete cascade,
  family_id        uuid not null references public.families (id) on delete cascade,
  created_at       timestamptz not null default now(),

  primary key (distribution_id, family_id)
);

create index aid_distribution_families_family_id_idx on public.aid_distribution_families (family_id);

comment on table public.aid_distribution_families is
  'Beneficiary families. Relational, never a comma-separated string or JSON array.';

-- -----------------------------------------------------------------------------
-- registration_requests
-- -----------------------------------------------------------------------------

create table public.registration_requests (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid references auth.users (id) on delete set null,
  full_name         text not null,
  national_id       text not null,
  phone             text,
  email             text not null,
  camp_id           uuid not null references public.camps (id) on delete restrict,
  status            public.request_status not null default 'pending',
  note              text not null default '',
  family_member_id  uuid references public.family_members (id) on delete set null,
  reviewed_by       uuid references public.profiles (id) on delete set null,
  reviewed_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint registration_requests_full_name_not_blank check (length(btrim(full_name)) > 0),
  constraint registration_requests_national_id_format check (national_id ~ '^[0-9]{9}$'),
  constraint registration_requests_email_format check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  -- A decided request always records who decided it and when.
  constraint registration_requests_review_complete check (
    (status = 'pending' and reviewed_at is null and reviewed_by is null)
    or (status <> 'pending' and reviewed_at is not null)
  ),
  -- An approved request always points at the person record it created.
  constraint registration_requests_approved_has_member check (
    status <> 'approved' or family_member_id is not null
  )
);

-- A national ID may be re-submitted only after a rejection: an open or accepted
-- request blocks any further request for the same ID, in any camp.
create unique index registration_requests_open_national_id_key
  on public.registration_requests (national_id)
  where status <> 'rejected';

create index registration_requests_camp_id_idx on public.registration_requests (camp_id);
create index registration_requests_status_idx on public.registration_requests (status);
create index registration_requests_camp_status_idx on public.registration_requests (camp_id, status);
create index registration_requests_user_id_idx on public.registration_requests (user_id);
create index registration_requests_created_at_idx on public.registration_requests (created_at desc);
create index registration_requests_reviewed_by_idx on public.registration_requests (reviewed_by);
create index registration_requests_family_member_id_idx on public.registration_requests (family_member_id);

alter table public.profiles
  add constraint profiles_registration_request_id_fkey
  foreign key (registration_request_id) references public.registration_requests (id) on delete set null;

-- -----------------------------------------------------------------------------
-- documents
--
-- Metadata only. Binary files are NEVER stored in Postgres; the cloudinary_*
-- columns are prepared for Phase 3 and stay null until then.
-- Domain rule 6: documents have NO expiry date, and there is no
-- displacement-proof document type.
-- -----------------------------------------------------------------------------

create table public.documents (
  id                       uuid primary key default gen_random_uuid(),
  name                     text not null,
  category                 public.document_category not null,
  camp_id                  uuid not null references public.camps (id) on delete restrict,

  -- Owner. At least one reference is required; a document normally belongs to a
  -- family member (and therefore to their family) or to a registration request.
  family_id                uuid references public.families (id) on delete cascade,
  family_member_id         uuid references public.family_members (id) on delete cascade,
  registration_request_id  uuid references public.registration_requests (id) on delete cascade,

  original_filename        text,
  mime_type                text,
  file_size                bigint,

  -- File location. Phase 1 stores metadata only.
  storage_provider         text not null default 'pending',
  file_url                 text,
  cloudinary_public_id     text,
  secure_url               text,
  resource_type            text,
  format                   text,

  uploaded_by              uuid references public.profiles (id) on delete set null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  constraint documents_name_not_blank check (length(btrim(name)) > 0),
  constraint documents_file_size_non_negative check (file_size is null or file_size >= 0),
  constraint documents_storage_provider_valid check (
    storage_provider in ('pending', 'cloudinary')
  ),
  constraint documents_has_owner check (
    num_nonnulls(family_id, family_member_id, registration_request_id) >= 1
  ),
  -- Once uploaded to Cloudinary the identifying columns must be present.
  constraint documents_cloudinary_complete check (
    storage_provider <> 'cloudinary'
    or (cloudinary_public_id is not null and secure_url is not null)
  )
);

create index documents_camp_id_idx on public.documents (camp_id);
create index documents_family_id_idx on public.documents (family_id);
create index documents_family_member_id_idx on public.documents (family_member_id);
create index documents_registration_request_id_idx on public.documents (registration_request_id);
create index documents_category_idx on public.documents (category);
create index documents_uploaded_by_idx on public.documents (uploaded_by);
create index documents_created_at_idx on public.documents (created_at desc);

comment on table public.documents is
  'Document metadata only — no binary content in Postgres, and no expiry date by domain rule.';

-- -----------------------------------------------------------------------------
-- messages
--
-- A displaced person writes to the administration of their camp; an admin
-- replies in place. recipient_id is null when the message is addressed to
-- whichever admin of recipient_role serves camp_id.
-- -----------------------------------------------------------------------------

create table public.messages (
  id              uuid primary key default gen_random_uuid(),
  sender_id       uuid not null references public.profiles (id) on delete cascade,
  camp_id         uuid not null references public.camps (id) on delete cascade,
  recipient_role  public.app_role not null default 'camp_admin',
  recipient_id    uuid references public.profiles (id) on delete set null,
  subject         public.message_subject not null,
  body            text not null,
  status          public.message_status not null default 'unread',
  reply           text,
  replied_by      uuid references public.profiles (id) on delete set null,
  replied_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint messages_body_not_blank check (length(btrim(body)) > 0),
  constraint messages_reply_complete check (
    reply is null or (replied_at is not null and replied_by is not null)
  ),
  constraint messages_replied_status check (status <> 'replied' or reply is not null)
);

create index messages_sender_id_idx on public.messages (sender_id);
create index messages_camp_id_idx on public.messages (camp_id);
create index messages_recipient_id_idx on public.messages (recipient_id);
create index messages_status_idx on public.messages (status);
create index messages_camp_status_idx on public.messages (camp_id, status);
create index messages_created_at_idx on public.messages (created_at desc);
create index messages_replied_by_idx on public.messages (replied_by);

-- -----------------------------------------------------------------------------
-- notifications
--
-- Shape kept compatible with Supabase Realtime (a stable recipient column and a
-- monotonic created_at). Realtime itself is Phase 4 and is NOT enabled here.
-- -----------------------------------------------------------------------------

create table public.notifications (
  id            uuid primary key default gen_random_uuid(),
  recipient_id  uuid not null references public.profiles (id) on delete cascade,
  type          public.notification_type not null default 'info',
  title         text not null,
  body          text not null default '',
  href          text,
  is_read       boolean not null default false,
  read_at       timestamptz,
  created_at    timestamptz not null default now(),

  constraint notifications_title_not_blank check (length(btrim(title)) > 0),
  constraint notifications_read_consistent check (is_read or read_at is null)
);

create index notifications_recipient_id_idx on public.notifications (recipient_id, created_at desc);
create index notifications_unread_idx on public.notifications (recipient_id)
  where not is_read;

-- -----------------------------------------------------------------------------
-- user_preferences
--
-- The per-account UI preferences the settings page reads. One row per account,
-- replacing store.preferences.get/set.
-- -----------------------------------------------------------------------------

create table public.user_preferences (
  user_id          uuid primary key references public.profiles (id) on delete cascade,
  notify_aid       boolean not null default true,
  notify_requests  boolean not null default true,
  notify_messages  boolean not null default true,
  dense_tables     boolean not null default false,
  updated_at       timestamptz not null default now()
);

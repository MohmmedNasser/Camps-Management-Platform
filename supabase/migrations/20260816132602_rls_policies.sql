-- =============================================================================
-- 003 · Grants and Row Level Security
--
-- Two independent controls, both required (Supabase guidance):
--   * GRANT decides whether a role can reach an object at all. This project
--     still carries the LEGACY default privileges, which hand anon and
--     authenticated full DML on every new public table — so everything is
--     revoked first and then granted back explicitly, and the DEFAULT
--     privileges are tightened too so Phase 2 tables do not repeat the problem.
--   * RLS decides which ROWS that role sees once it can reach the object.
--
-- The policy matrix is a direct translation of the PERMISSIONS table in
-- assets/js/core/auth.js. Where the frontend gates a control on can('aid:create')
-- the database gates the row on the same rule, so a hand-edited request body,
-- a forged localStorage session or a modified ?campId= cannot widen access.
--
-- Notable domain consequences encoded here:
--   * Aid is created / edited / deleted by CAMP ADMIN ONLY (domain rule 8).
--   * A Camp Admin never reads another camp — including its medical data.
--   * A displaced person reads their own family and nothing else.
--   * The Super Admin reads everything but does not author camp-level records,
--     matching the application's administrative functionality.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- RLS-specific authorization helpers
--
-- These exist to break mutual recursion: a policy on aid_distributions that
-- queried aid_distribution_families would re-enter that table's own policy,
-- which queries aid_distributions. Running the lookup as SECURITY DEFINER
-- evaluates it without RLS and terminates. Each reads only rows the caller is
-- already entitled to reason about.
-- -----------------------------------------------------------------------------

create or replace function private.distribution_camp_id(p_distribution_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select d.camp_id from public.aid_distributions d where d.id = p_distribution_id;
$$;

create or replace function private.family_receives_distribution(p_distribution_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.aid_distribution_families adf
    where adf.distribution_id = p_distribution_id
      and adf.family_id = (
        select m.family_id
        from public.profiles p
        join public.family_members m on m.id = p.family_member_id
        where p.id = (select auth.uid())
      )
  );
$$;

-- -----------------------------------------------------------------------------
-- Grants
-- -----------------------------------------------------------------------------

-- Start from nothing so no default privilege leaks a table into the Data API.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- The two statements above only reach objects that already exist. This project
-- still carries the LEGACY default privileges, which grant anon and
-- authenticated full DML on every table `postgres` creates in `public` — so
-- without the next two statements, the first table Phase 2 adds would be
-- exposed to anonymous callers the moment it was created.
--
-- service_role is deliberately left alone: it is the server-side key and is
-- expected to reach new tables.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

-- This project's legacy default privileges cover a THIRD object type the two
-- statements above do not touch: functions. Every function `postgres` creates
-- in `public` was getting a direct EXECUTE grant to anon and authenticated at
-- creation time. That is on top of a SEPARATE, PostgreSQL-intrinsic default:
-- EXECUTE on a new function is granted to PUBLIC automatically, and anon /
-- authenticated inherit anything granted to PUBLIC. Revoking only the
-- legacy per-role default (first clause) leaves that PUBLIC grant standing,
-- so both must be revoked from every future function's default privileges —
-- confirmed by creating a throwaway function with no explicit grant and
-- checking has_function_privilege() for anon/authenticated before landing
-- this statement. Without it, every SECURITY DEFINER workflow function
-- Phase 2 adds would be anonymously callable the moment it was created, same
-- failure shape as the tables/sequences gap above, one object type later.
alter default privileges in schema public revoke all on functions from public, anon, authenticated;

-- The resulting model, in order of precedence:
--   default privileges  ->  nothing for browser roles
--   explicit grants     ->  only the tables and verbs a role genuinely needs
--   RLS policies        ->  the actual authorization boundary, row by row

-- Postgres grants EXECUTE to PUBLIC on every new function, and anon and
-- authenticated inherit from PUBLIC — so revoking from those two roles alone
-- would leave the SECURITY DEFINER workflow functions callable by anyone.
--
-- Revoking from anon and authenticated explicitly (not just PUBLIC) is
-- required here too: the default-privilege ALTER above only prevents FUTURE
-- functions from leaking. These six already exist and were already granted
-- direct EXECUTE by the same legacy default-privilege entry — revoking from
-- PUBLIC alone would leave every one of them anonymously callable.
revoke all on function public.age_in_years(date) from public, anon, authenticated;
revoke all on function public.approve_registration_request(uuid, public.gender, date) from public, anon, authenticated;
revoke all on function public.reject_registration_request(uuid, text) from public, anon, authenticated;
revoke all on function public.create_family_with_members(uuid, jsonb, jsonb, text, uuid) from public, anon, authenticated;
revoke all on function public.create_aid_distribution(uuid, uuid, date, text[], uuid[], boolean, uuid) from public, anon, authenticated;
revoke all on function public.reset_family_reference_sequence() from public, anon, authenticated;

grant usage on schema public to anon, authenticated;

-- Policy helpers must be executable by the role the policy runs as. `private`
-- is not an exposed Data API schema, so granting EXECUTE here does not make
-- any of them callable as an RPC.
grant usage on schema private to authenticated;
grant execute on all functions in schema private to authenticated;

-- anon reaches exactly one thing: the list of camps the public registration
-- form must render before anyone has an account. Nothing else.
grant select on public.camps to anon;

grant select, insert, update, delete on public.camps                    to authenticated;
grant select, insert, update, delete on public.profiles                 to authenticated;
grant select, insert, update, delete on public.families                 to authenticated;
grant select, insert, update, delete on public.family_members           to authenticated;
grant select, insert, update, delete on public.organizations            to authenticated;
grant select, insert, update, delete on public.aid_types                to authenticated;
grant select, insert, update, delete on public.aid_distributions        to authenticated;
grant select, insert, update, delete on public.aid_distribution_types   to authenticated;
grant select, insert, update, delete on public.aid_distribution_families to authenticated;
grant select, insert, update          on public.registration_requests   to authenticated;
grant select, insert, update, delete on public.documents                to authenticated;
grant select, insert, update          on public.messages                to authenticated;
grant select,         update          on public.notifications           to authenticated;
grant select, insert, update          on public.user_preferences        to authenticated;

grant select on public.family_member_facts to authenticated;
grant select on public.family_stats        to authenticated;

grant execute on function public.age_in_years(date) to anon, authenticated;
grant execute on function public.approve_registration_request(uuid, public.gender, date) to authenticated;
grant execute on function public.reject_registration_request(uuid, text) to authenticated;
grant execute on function public.create_family_with_members(uuid, jsonb, jsonb, text, uuid) to authenticated;
grant execute on function public.create_aid_distribution(uuid, uuid, date, text[], uuid[], boolean, uuid) to authenticated;

grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant all on all functions in schema public to service_role;

-- Reachable with the secret key only — never from a publishable/anon key.
grant execute on function public.reset_family_reference_sequence() to service_role;

-- -----------------------------------------------------------------------------
-- Enable RLS on every application table
-- -----------------------------------------------------------------------------

alter table public.camps                      enable row level security;
alter table public.profiles                   enable row level security;
alter table public.families                   enable row level security;
alter table public.family_members             enable row level security;
alter table public.organizations              enable row level security;
alter table public.aid_types                  enable row level security;
alter table public.aid_distributions          enable row level security;
alter table public.aid_distribution_types     enable row level security;
alter table public.aid_distribution_families  enable row level security;
alter table public.registration_requests      enable row level security;
alter table public.documents                  enable row level security;
alter table public.messages                   enable row level security;
alter table public.notifications              enable row level security;
alter table public.user_preferences           enable row level security;

-- =============================================================================
-- camps
-- =============================================================================

-- Camp names are public information and the sign-up form needs them before an
-- account exists. This is the platform's ONLY anonymous read.
create policy camps_select_anon
  on public.camps for select
  to anon
  using (status = 'active');

create policy camps_select_authenticated
  on public.camps for select
  to authenticated
  using (status = 'active' or (select private.is_super_admin()));

create policy camps_insert_super_admin
  on public.camps for insert
  to authenticated
  with check ((select private.is_super_admin()));

create policy camps_update_super_admin
  on public.camps for update
  to authenticated
  using ((select private.is_super_admin()))
  with check ((select private.is_super_admin()));

create policy camps_delete_super_admin
  on public.camps for delete
  to authenticated
  using ((select private.is_super_admin()));

-- =============================================================================
-- profiles
-- =============================================================================

create policy profiles_select_own_or_admin
  on public.profiles for select
  to authenticated
  using (
    id = (select auth.uid())
    or (select private.is_super_admin())
    or ((select private.is_camp_admin()) and camp_id = (select private.current_camp_id()))
  );

create policy profiles_insert_super_admin
  on public.profiles for insert
  to authenticated
  with check ((select private.is_super_admin()));

-- Which ROWS may be updated. Which COLUMNS may be updated is enforced by the
-- private.guard_profile_privileges() trigger — RLS alone cannot stop a user
-- from sending role: 'super_admin' while editing their own profile.
create policy profiles_update_own_or_admin
  on public.profiles for update
  to authenticated
  using (
    id = (select auth.uid())
    or (select private.is_super_admin())
    or ((select private.is_camp_admin()) and camp_id = (select private.current_camp_id()))
  )
  with check (
    id = (select auth.uid())
    or (select private.is_super_admin())
    or ((select private.is_camp_admin()) and camp_id = (select private.current_camp_id()))
  );

create policy profiles_delete_super_admin
  on public.profiles for delete
  to authenticated
  using ((select private.is_super_admin()));

-- =============================================================================
-- families
-- =============================================================================

create policy families_select_scoped
  on public.families for select
  to authenticated
  using (
    (select private.is_super_admin())
    or ((select private.is_camp_admin()) and camp_id = (select private.current_camp_id()))
    or ((select private.is_displaced()) and id = (select private.current_family_id()))
  );

create policy families_insert_camp_admin
  on public.families for insert
  to authenticated
  with check (
    (select private.is_camp_admin()) and camp_id = (select private.current_camp_id())
  );

create policy families_update_camp_admin
  on public.families for update
  to authenticated
  using ((select private.is_camp_admin()) and camp_id = (select private.current_camp_id()))
  with check ((select private.is_camp_admin()) and camp_id = (select private.current_camp_id()));

create policy families_delete_camp_admin
  on public.families for delete
  to authenticated
  using ((select private.is_camp_admin()) and camp_id = (select private.current_camp_id()));

-- =============================================================================
-- family_members
--
-- Chronic disease and disability live on these rows. Camp isolation here is the
-- control that keeps one camp's medical data out of another camp's hands.
-- =============================================================================

create policy family_members_select_scoped
  on public.family_members for select
  to authenticated
  using (
    (select private.is_super_admin())
    or ((select private.is_camp_admin()) and camp_id = (select private.current_camp_id()))
    or ((select private.is_displaced()) and family_id = (select private.current_family_id()))
  );

create policy family_members_insert_camp_admin
  on public.family_members for insert
  to authenticated
  with check (
    (select private.is_camp_admin()) and camp_id = (select private.current_camp_id())
  );

create policy family_members_update_camp_admin
  on public.family_members for update
  to authenticated
  using ((select private.is_camp_admin()) and camp_id = (select private.current_camp_id()))
  with check ((select private.is_camp_admin()) and camp_id = (select private.current_camp_id()));

create policy family_members_delete_camp_admin
  on public.family_members for delete
  to authenticated
  using ((select private.is_camp_admin()) and camp_id = (select private.current_camp_id()));

-- =============================================================================
-- organizations (donors)
--
-- Readable by any authorized account — a displaced person's aid history names
-- the donor. Writable by administrators only.
-- =============================================================================

create policy organizations_select_authorized
  on public.organizations for select
  to authenticated
  using (
    (select private.is_super_admin())
    or (select private.is_camp_admin())
    or (select private.is_displaced())
  );

create policy organizations_insert_admin
  on public.organizations for insert
  to authenticated
  with check ((select private.is_super_admin()) or (select private.is_camp_admin()));

create policy organizations_update_admin
  on public.organizations for update
  to authenticated
  using ((select private.is_super_admin()) or (select private.is_camp_admin()))
  with check ((select private.is_super_admin()) or (select private.is_camp_admin()));

create policy organizations_delete_admin
  on public.organizations for delete
  to authenticated
  using ((select private.is_super_admin()) or (select private.is_camp_admin()));

-- =============================================================================
-- aid_types (reference data)
-- =============================================================================

create policy aid_types_select_authorized
  on public.aid_types for select
  to authenticated
  using (
    (select private.is_super_admin())
    or (select private.is_camp_admin())
    or (select private.is_displaced())
  );

create policy aid_types_insert_super_admin
  on public.aid_types for insert
  to authenticated
  with check ((select private.is_super_admin()));

create policy aid_types_update_super_admin
  on public.aid_types for update
  to authenticated
  using ((select private.is_super_admin()))
  with check ((select private.is_super_admin()));

create policy aid_types_delete_super_admin
  on public.aid_types for delete
  to authenticated
  using ((select private.is_super_admin()));

-- =============================================================================
-- aid_distributions
--
-- Domain rule 8: created, edited and deleted by CAMP ADMIN only. A displaced
-- person reads their family's history and has no detail screen at all.
-- =============================================================================

create policy aid_distributions_select_scoped
  on public.aid_distributions for select
  to authenticated
  using (
    (select private.is_super_admin())
    or ((select private.is_camp_admin()) and camp_id = (select private.current_camp_id()))
    or ((select private.is_displaced()) and private.family_receives_distribution(id))
  );

create policy aid_distributions_insert_camp_admin
  on public.aid_distributions for insert
  to authenticated
  with check (
    (select private.is_camp_admin()) and camp_id = (select private.current_camp_id())
  );

create policy aid_distributions_update_camp_admin
  on public.aid_distributions for update
  to authenticated
  using ((select private.is_camp_admin()) and camp_id = (select private.current_camp_id()))
  with check ((select private.is_camp_admin()) and camp_id = (select private.current_camp_id()));

create policy aid_distributions_delete_camp_admin
  on public.aid_distributions for delete
  to authenticated
  using ((select private.is_camp_admin()) and camp_id = (select private.current_camp_id()));

-- =============================================================================
-- aid_distribution_types
-- =============================================================================

create policy aid_distribution_types_select_scoped
  on public.aid_distribution_types for select
  to authenticated
  using (
    (select private.is_super_admin())
    or (
      (select private.is_camp_admin())
      and private.distribution_camp_id(distribution_id) = (select private.current_camp_id())
    )
    or ((select private.is_displaced()) and private.family_receives_distribution(distribution_id))
  );

create policy aid_distribution_types_insert_camp_admin
  on public.aid_distribution_types for insert
  to authenticated
  with check (
    (select private.is_camp_admin())
    and private.distribution_camp_id(distribution_id) = (select private.current_camp_id())
  );

create policy aid_distribution_types_update_camp_admin
  on public.aid_distribution_types for update
  to authenticated
  using (
    (select private.is_camp_admin())
    and private.distribution_camp_id(distribution_id) = (select private.current_camp_id())
  )
  with check (
    (select private.is_camp_admin())
    and private.distribution_camp_id(distribution_id) = (select private.current_camp_id())
  );

create policy aid_distribution_types_delete_camp_admin
  on public.aid_distribution_types for delete
  to authenticated
  using (
    (select private.is_camp_admin())
    and private.distribution_camp_id(distribution_id) = (select private.current_camp_id())
  );

-- =============================================================================
-- aid_distribution_families
-- =============================================================================

create policy aid_distribution_families_select_scoped
  on public.aid_distribution_families for select
  to authenticated
  using (
    (select private.is_super_admin())
    or (
      (select private.is_camp_admin())
      and private.distribution_camp_id(distribution_id) = (select private.current_camp_id())
    )
    or ((select private.is_displaced()) and family_id = (select private.current_family_id()))
  );

create policy aid_distribution_families_insert_camp_admin
  on public.aid_distribution_families for insert
  to authenticated
  with check (
    (select private.is_camp_admin())
    and private.distribution_camp_id(distribution_id) = (select private.current_camp_id())
  );

create policy aid_distribution_families_update_camp_admin
  on public.aid_distribution_families for update
  to authenticated
  using (
    (select private.is_camp_admin())
    and private.distribution_camp_id(distribution_id) = (select private.current_camp_id())
  )
  with check (
    (select private.is_camp_admin())
    and private.distribution_camp_id(distribution_id) = (select private.current_camp_id())
  );

create policy aid_distribution_families_delete_camp_admin
  on public.aid_distribution_families for delete
  to authenticated
  using (
    (select private.is_camp_admin())
    and private.distribution_camp_id(distribution_id) = (select private.current_camp_id())
  );

-- =============================================================================
-- registration_requests
--
-- The applicant may create and read their own request. Only the Camp Admin of
-- the requested camp may decide it, and only through the SECURITY DEFINER
-- workflow functions — the UPDATE policy exists for note edits, not approvals.
-- =============================================================================

create policy registration_requests_select_scoped
  on public.registration_requests for select
  to authenticated
  using (
    user_id = (select auth.uid())
    or (select private.is_super_admin())
    or ((select private.is_camp_admin()) and camp_id = (select private.current_camp_id()))
  );

-- A new account may file exactly one request, for itself, always pending and
-- never pre-decided.
create policy registration_requests_insert_self
  on public.registration_requests for insert
  to authenticated
  with check (
    user_id = (select auth.uid())
    and status = 'pending'
    and reviewed_by is null
    and reviewed_at is null
    and family_member_id is null
  );

create policy registration_requests_update_camp_admin
  on public.registration_requests for update
  to authenticated
  using ((select private.is_camp_admin()) and camp_id = (select private.current_camp_id()))
  with check ((select private.is_camp_admin()) and camp_id = (select private.current_camp_id()));

-- =============================================================================
-- documents
--
-- Medical reports live here, so the scoping matches family_members exactly.
-- =============================================================================

create policy documents_select_scoped
  on public.documents for select
  to authenticated
  using (
    (select private.is_super_admin())
    or ((select private.is_camp_admin()) and camp_id = (select private.current_camp_id()))
    or ((select private.is_displaced()) and family_id = (select private.current_family_id()))
  );

create policy documents_insert_scoped
  on public.documents for insert
  to authenticated
  with check (
    (select private.is_super_admin())
    or ((select private.is_camp_admin()) and camp_id = (select private.current_camp_id()))
    or ((select private.is_displaced()) and family_id = (select private.current_family_id()))
  );

create policy documents_update_admin
  on public.documents for update
  to authenticated
  using (
    (select private.is_super_admin())
    or ((select private.is_camp_admin()) and camp_id = (select private.current_camp_id()))
  )
  with check (
    (select private.is_super_admin())
    or ((select private.is_camp_admin()) and camp_id = (select private.current_camp_id()))
  );

create policy documents_delete_admin
  on public.documents for delete
  to authenticated
  using (
    (select private.is_super_admin())
    or ((select private.is_camp_admin()) and camp_id = (select private.current_camp_id()))
  );

-- =============================================================================
-- messages
--
-- 'message:send' is a displaced-person action; 'message:reply' belongs to
-- administrators. A displaced person reads only the threads they started.
-- =============================================================================

create policy messages_select_scoped
  on public.messages for select
  to authenticated
  using (
    sender_id = (select auth.uid())
    or (select private.is_super_admin())
    or ((select private.is_camp_admin()) and camp_id = (select private.current_camp_id()))
  );

create policy messages_insert_displaced
  on public.messages for insert
  to authenticated
  with check (
    (select private.is_displaced())
    and sender_id = (select auth.uid())
    and camp_id = (select private.current_camp_id())
    and status = 'unread'
    and reply is null
  );

create policy messages_update_admin
  on public.messages for update
  to authenticated
  using (
    (select private.is_super_admin())
    or ((select private.is_camp_admin()) and camp_id = (select private.current_camp_id()))
  )
  with check (
    (select private.is_super_admin())
    or ((select private.is_camp_admin()) and camp_id = (select private.current_camp_id()))
  );

-- =============================================================================
-- notifications
--
-- Strictly personal: no administrator reads another account's notifications.
-- Clients may only mark them read; private.guard_notification_update() rejects
-- any attempt to rewrite the content.
-- =============================================================================

create policy notifications_select_own
  on public.notifications for select
  to authenticated
  using (recipient_id = (select auth.uid()));

create policy notifications_update_own
  on public.notifications for update
  to authenticated
  using (recipient_id = (select auth.uid()))
  with check (recipient_id = (select auth.uid()));

-- =============================================================================
-- user_preferences
-- =============================================================================

create policy user_preferences_select_own
  on public.user_preferences for select
  to authenticated
  using (user_id = (select auth.uid()));

create policy user_preferences_insert_own
  on public.user_preferences for insert
  to authenticated
  with check (user_id = (select auth.uid()));

create policy user_preferences_update_own
  on public.user_preferences for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

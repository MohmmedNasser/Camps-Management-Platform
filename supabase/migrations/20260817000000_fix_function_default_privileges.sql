-- =============================================================================
-- 006 · Fix function default privileges (security correction)
--
-- Migration 003 closed the legacy default-privilege leak for TABLES and
-- SEQUENCES but missed a third object type this project's legacy defaults
-- also cover: FUNCTIONS. Every function `postgres` created in `public` was
-- getting a direct EXECUTE grant to anon and authenticated at creation time —
-- independent of, and not removed by, 003's "revoke ... from public"
-- statements (those only strip the separate PUBLIC-inherited privilege).
--
-- Practical effect before this migration: `anon` could call
-- approve_registration_request, reject_registration_request,
-- create_family_with_members, create_aid_distribution, and
-- reset_family_reference_sequence; `authenticated` could additionally call
-- reset_family_reference_sequence, a service_role-only dev utility with no
-- internal authorization check of its own. The four workflow functions were
-- not exploitable in practice — each checks private.is_browser_session() plus
-- an internal authorization condition and raises 42501 for an unauthorized
-- caller — but an anonymously-callable RPC surface is a defect regardless of
-- whether today's function bodies happen to catch every case, and
-- reset_family_reference_sequence had no such guard at all.
--
-- This migration is idempotent and safe to run on any environment:
--   - On a project migrated before this fix, it closes the live gap.
--   - On a fresh project built from the now-corrected migration 003, every
--     statement here is a no-op re-stating what 003 already established.
--
-- Migration 20260816120200_rls_policies.sql (003) carries the same corrective
-- statements for fresh installs; this file exists only to carry the fix to
-- environments where the flawed 003 already ran.
-- =============================================================================

-- Prospective fix: stop future functions in `public` from being auto-granted
-- EXECUTE via this project's legacy default-privilege entry for functions —
-- AND via PostgreSQL's own intrinsic default (EXECUTE on a new function is
-- granted to PUBLIC automatically at creation time, and anon/authenticated
-- inherit anything granted to PUBLIC). Both must be named here: revoking only
-- the legacy per-role entry leaves the PUBLIC grant standing, which was
-- confirmed live by creating a throwaway function with no explicit grant and
-- checking has_function_privilege() for anon/authenticated. service_role is
-- untouched — it is the server-side key and is expected to reach new
-- functions.
alter default privileges in schema public revoke all on functions from public, anon, authenticated;

-- Retroactive fix: the ALTER above only prevents future leaks. These six
-- functions already exist and were already granted direct EXECUTE by the
-- same legacy default-privilege entry, so each needs an explicit revoke.
revoke all on function public.age_in_years(date) from public, anon, authenticated;
revoke all on function public.approve_registration_request(uuid, public.gender, date) from public, anon, authenticated;
revoke all on function public.reject_registration_request(uuid, text) from public, anon, authenticated;
revoke all on function public.create_family_with_members(uuid, jsonb, jsonb, text, uuid) from public, anon, authenticated;
revoke all on function public.create_aid_distribution(uuid, uuid, date, text[], uuid[], boolean, uuid) from public, anon, authenticated;
revoke all on function public.reset_family_reference_sequence() from public, anon, authenticated;

-- Restore the intended grants the blanket revoke above also removed.
-- age_in_years is a pure date calculation with no data access — safe for
-- both browser roles, same as before this migration.
grant execute on function public.age_in_years(date) to anon, authenticated;

-- The four workflow functions: authenticated only. Each is internally
-- authorized (camp admin + camp match), so this grant alone does not widen
-- access — it restores exactly what migration 003 intended, minus the anon
-- leak this migration removes.
grant execute on function public.approve_registration_request(uuid, public.gender, date) to authenticated;
grant execute on function public.reject_registration_request(uuid, text) to authenticated;
grant execute on function public.create_family_with_members(uuid, jsonb, jsonb, text, uuid) to authenticated;
grant execute on function public.create_aid_distribution(uuid, uuid, date, text[], uuid[], boolean, uuid) to authenticated;

-- reset_family_reference_sequence: service_role only. Reachable with the
-- secret key alone — never from a publishable/anon key, and never from an
-- authenticated browser session.
grant execute on function public.reset_family_reference_sequence() to service_role;

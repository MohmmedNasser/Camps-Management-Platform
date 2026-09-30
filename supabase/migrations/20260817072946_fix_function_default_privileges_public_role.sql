-- =============================================================================
-- 007 · Close the PostgreSQL-intrinsic PUBLIC EXECUTE default on functions
--
-- Migration 006 revoked this project's legacy default-privilege entry that
-- granted anon/authenticated EXECUTE directly on every new function. Testing
-- that fix with a throwaway function (create, check has_function_privilege(),
-- drop) showed anon and authenticated could STILL execute it — because
-- PostgreSQL grants EXECUTE on every new function to PUBLIC automatically at
-- creation time, independent of any default-privilege entry naming specific
-- roles, and anon/authenticated inherit anything granted to PUBLIC.
--
-- This migration closes that second, PostgreSQL-intrinsic default. It is a
-- narrow follow-up to 006 rather than an edit to it: 006 already ran against
-- this project and cannot be rewritten in place. The local copy of 006 has
-- been corrected to include this statement, so a fresh project applies the
-- complete fix in one step; this file exists only to carry the same fix to
-- an already-migrated environment.
-- =============================================================================

alter default privileges in schema public revoke all on functions from public;
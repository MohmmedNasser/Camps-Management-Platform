-- =============================================================================
-- 008 · Enforce a no-PUBLIC-EXECUTE baseline on every future public function
--
-- Migrations 006/007 revoked EXECUTE on the six functions that existed at the
-- time, and added `alter default privileges ... revoke ... on functions from
-- public, anon, authenticated` so future functions would not repeat the leak.
-- That default-privilege statement closes HALF the gap: it does stop this
-- project's legacy default-privilege entry from directly granting anon and
-- authenticated EXECUTE on new functions (verified: a freshly created probe
-- function's ACL carries no `anon=` / `authenticated=` entry).
--
-- It does NOT stop the other half. PostgreSQL grants EXECUTE on every new
-- function to PUBLIC as a built-in default — separate from the default-
-- privilege mechanism `ALTER DEFAULT PRIVILEGES` governs — and anon /
-- authenticated inherit anything granted to PUBLIC. This was confirmed
-- empirically, not assumed: `alter default privileges in schema public
-- revoke execute on functions from public` was run immediately before
-- `create function public.__probe4()` in the SAME transaction, and the new
-- function's ACL still carried a `=X/postgres` entry (the empty-grantee
-- syntax for PUBLIC). Tables and sequences do not have this problem — PL/SQL
-- grants no such built-in PUBLIC default for those object types, confirmed
-- with the same probe technique — so this migration is function-only.
--
-- The fix: mirror the pattern this project's own Supabase instance already
-- uses (`ensure_rls` in `pg_event_trigger_ddl_commands`/`ddl_command_end`,
-- see migration 005) with an event trigger that revokes PUBLIC's EXECUTE
-- grant the instant a function is created in `public`. This is verified to
-- work regardless of the unexplained default-privilege gap above, because it
-- acts on the object directly rather than relying on the privilege the
-- object would otherwise be created with.
--
-- Deliberately revokes ONLY from PUBLIC, never directly from anon or
-- authenticated: those are separate ACL entries. A migration that creates a
-- function and then explicitly `grant execute ... to authenticated` in a
-- later statement — the pattern every migration in this project already
-- follows — is completely unaffected by this trigger, including on a later
-- `create or replace function` that redeploys the same function (Postgres
-- reports command_tag 'CREATE FUNCTION' for both a first creation and a
-- replace, so the trigger fires either way; stripping an already-absent
-- PUBLIC grant a second time is a harmless no-op).
-- =============================================================================

create or replace function private.enforce_no_public_execute()
returns event_trigger
language plpgsql
security definer
set search_path to 'pg_catalog'
as $$
declare
  cmd record;
begin
  for cmd in
    select *
    from pg_event_trigger_ddl_commands()
    where command_tag = 'CREATE FUNCTION'
      and object_type = 'function'
  loop
    -- Covers `private` too, defense in depth: that schema is unreachable by
    -- anon regardless (no schema USAGE — see migration 009), but a future
    -- helper function added there shouldn't repeat the PUBLIC-execute gap
    -- just because nothing currently exploits it.
    if cmd.schema_name in ('public', 'private') then
      begin
        execute format('revoke all on function %s from public', cmd.object_identity);
        raise log 'enforce_no_public_execute: revoked PUBLIC EXECUTE on %', cmd.object_identity;
      exception
        when others then
          raise log 'enforce_no_public_execute: failed to revoke PUBLIC EXECUTE on %', cmd.object_identity;
      end;
    end if;
  end loop;
end;
$$;

comment on function private.enforce_no_public_execute() is
  'Event trigger handler. Strips the PUBLIC EXECUTE grant PostgreSQL auto-applies to every new function in public or private — a built-in default that ALTER DEFAULT PRIVILEGES does not reach on this instance. Revokes only from PUBLIC; never touches anon/authenticated directly, so it cannot undo an explicit grant.';

drop event trigger if exists enforce_function_no_public_execute;

create event trigger enforce_function_no_public_execute
  on ddl_command_end
  when tag in ('CREATE FUNCTION')
  execute function private.enforce_no_public_execute();

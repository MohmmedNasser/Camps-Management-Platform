-- =============================================================================
-- 009 · Close the same PUBLIC-EXECUTE leak on the `private` schema
--
-- The Step 3 audit ("verify all SECURITY DEFINER functions") surfaced that
-- every function in `private` — the identity/authorization primitives every
-- RLS policy calls (is_super_admin, is_camp_admin, current_camp_id, …) —
-- still carries the same built-in PUBLIC EXECUTE grant that migration 008
-- fixed for `public`. These functions predate that migration, whose event
-- trigger only fires on creations after it existed, and was scoped to
-- `public` only.
--
-- This is NOT currently exploitable: `anon` has no USAGE on schema `private`
-- (revoked since migration 001, confirmed live via has_schema_privilege), and
-- PostgREST cannot resolve a schema-qualified call without it — attempting
-- one returns "permission denied for schema private", verified live earlier
-- in this session. The correction closes a defense-in-depth gap, not a
-- reachable one: if a future migration ever granted USAGE on `private` to
-- `anon` or `PUBLIC` by mistake, every function in it would otherwise become
-- immediately callable rather than being caught by its own EXECUTE grant.
--
-- Two changes, both restricted to privileges — no function logic touched:
--   1. Retroactively revoke PUBLIC's EXECUTE on every existing function in
--      `private`, then restore the `authenticated` grant migration 003
--      already establishes (re-running it is idempotent).
--   2. Widen migration 008's event trigger to also cover `private`, so a
--      future helper function added there doesn't repeat the gap.
-- =============================================================================

revoke execute on all functions in schema private from public;
grant execute on all functions in schema private to authenticated;

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
  'Event trigger handler. Strips the PUBLIC EXECUTE grant PostgreSQL auto-applies to every new function in public or private — a built-in default that ALTER DEFAULT PRIVILEGES does not reach on this instance. Revokes only from PUBLIC; never touches anon/authenticated directly, so it cannot undo an explicit grant. private is unreachable by anon regardless (no schema USAGE), so this is defense in depth there.';

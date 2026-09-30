-- =============================================================================
-- 005 · Harden pre-existing project objects
--
-- Supabase projects ship an event trigger, `ensure_rls`, backed by
-- public.rls_auto_enable(). It enables Row Level Security automatically on
-- every new table in `public` — a useful safety net that complements, rather
-- than replaces, the explicit `enable row level security` statements in 003.
--
-- The function is SECURITY DEFINER and lives in `public`, and Postgres grants
-- EXECUTE to PUBLIC on every function by default. anon and authenticated
-- inherit from PUBLIC, so it is reachable as /rest/v1/rpc/rls_auto_enable and
-- is flagged by the database linter (lints 0028 and 0029).
--
-- Calling it outside an event-trigger context would fail — pg_event_trigger_
-- ddl_commands() raises there — so the practical risk is low. It is revoked
-- anyway: an exposed SECURITY DEFINER entry point in an API schema is not
-- something to leave lying around, and a clean advisor report is worth having.
--
-- The function is NOT dropped and the event trigger is NOT disabled. Trigger
-- and event-trigger functions are invoked by the system without an EXECUTE
-- privilege check on the calling user — that check happens once, at CREATE
-- time — so revoking EXECUTE removes the RPC surface and leaves the automatic
-- RLS behaviour completely intact.
--
-- Guarded by an existence check so this migration is a no-op on a project that
-- does not ship the function.
-- =============================================================================

do $$
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'rls_auto_enable'
      and p.pronargs = 0
  ) then
    revoke all on function public.rls_auto_enable() from public;
    revoke all on function public.rls_auto_enable() from anon;
    revoke all on function public.rls_auto_enable() from authenticated;

    raise notice 'revoked EXECUTE on public.rls_auto_enable() from PUBLIC, anon and authenticated';
  else
    raise notice 'public.rls_auto_enable() not present — nothing to harden';
  end if;
end $$;

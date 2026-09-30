-- TEMPORARY diagnostic function. Proves that a real Data API request runs as
-- session_user = 'authenticator', which is what private.is_browser_session()
-- anchors on. Dropped immediately after one verification call over HTTP.
create or replace function public.__verify_session_binding()
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'session_user', session_user,
    'current_user', current_user,
    'is_browser_session', private.is_browser_session()
  );
$$;

revoke all on function public.__verify_session_binding() from public;
grant execute on function public.__verify_session_binding() to anon;
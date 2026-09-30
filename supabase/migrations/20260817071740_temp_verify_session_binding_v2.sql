create or replace function public.__verify_session_binding()
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object('session_user', session_user, 'current_user', current_user);
$$;

revoke all on function public.__verify_session_binding() from public;
grant execute on function public.__verify_session_binding() to anon;
create or replace function public.generate_family_activation_token(
  p_family_id     uuid,
  p_ttl_seconds   integer default null
)
returns table (token text, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_camp_id       uuid;
  v_head_id       uuid;
  v_actor         uuid := (select auth.uid());
  v_token         text;
  v_token_hash    text;
  v_ttl_seconds   integer := least(greatest(coalesce(p_ttl_seconds, 604800), 1), 2592000);
  v_expires_at    timestamptz := now() + make_interval(secs => v_ttl_seconds);
begin
  select f.camp_id, f.head_member_id into v_camp_id, v_head_id
  from public.families f
  where f.id = p_family_id;

  if v_camp_id is null then
    raise exception 'الأسرة غير موجودة' using errcode = 'P0002';
  end if;

  if private.is_browser_session()
     and not ((select private.is_camp_admin()) and (select private.current_camp_id()) = v_camp_id) then
    raise exception 'لا تملك صلاحية إنشاء رابط تفعيل لهذه الأسرة' using errcode = '42501';
  end if;

  if v_head_id is null then
    raise exception 'الأسرة بلا رب أسرة، لا يمكن إنشاء رابط تفعيل' using errcode = '22023';
  end if;

  update private.family_activation_tokens
  set revoked_at = now()
  where family_id = p_family_id
    and used_at is null
    and revoked_at is null;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  v_token_hash := encode(extensions.digest(v_token, 'sha256'), 'hex');

  insert into private.family_activation_tokens (
    family_id, head_member_id, token_hash, expires_at, created_by
  )
  values (p_family_id, v_head_id, v_token_hash, v_expires_at, v_actor);

  return query select v_token, v_expires_at;
end;
$$;

comment on function public.generate_family_activation_token(uuid, integer) is
  'Camp Admin only, own camp only. p_ttl_seconds (clamped [1, 2592000] seconds, default 7 days) exists for test determinism — the frontend never passes it.';

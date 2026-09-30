-- =============================================================================
-- Phase 4.17 · Displaced family account activation
--
-- A Camp Admin registers a family through create_family_with_members() —
-- that creates families/family_members rows only, no auth.users/profiles row.
-- This migration adds the missing link: a Camp Admin generates a one-time
-- activation token for an existing family; the head of family later proves
-- their identity against it and chooses a password; a real Supabase Auth
-- account is created and linked via profiles.family_member_id, exactly the
-- identity chain Phase 4.12/4.13 already rely on.
--
-- Design doc: docs/superpowers/specs/2026-09-27-phase-4.17-family-account-
-- activation-design.md — read it before changing anything here, especially
-- the SQL-function/Edge-Function split in §6 and the grant boundaries in §6/§7.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- private.family_activation_tokens
--
-- Lives in `private`, never `public`: this schema is not in
-- supabase/config.toml's api.schemas, so it is structurally unreachable via
-- PostgREST regardless of any future GRANT — stronger than "public table +
-- RLS with no policies". Every access path is one of the four SECURITY
-- DEFINER functions below.
--
-- State is derived from the three timestamp columns + now(), the same
-- convention registration_requests/messages already use — no redundant
-- status enum to fall out of sync with them.
-- -----------------------------------------------------------------------------

create table private.family_activation_tokens (
  id               uuid primary key default gen_random_uuid(),
  family_id        uuid not null references public.families (id) on delete cascade,
  head_member_id   uuid not null references public.family_members (id) on delete cascade,
  token_hash       text not null,
  expires_at       timestamptz not null,
  used_at          timestamptz,
  revoked_at       timestamptz,
  failed_attempts  integer not null default 0,
  created_by       uuid references public.profiles (id) on delete set null,
  created_at       timestamptz not null default now(),

  constraint family_activation_tokens_failed_attempts_non_negative check (failed_attempts >= 0),
  constraint family_activation_tokens_expires_after_created check (expires_at > created_at)
);

create unique index family_activation_tokens_token_hash_key
  on private.family_activation_tokens (token_hash);

-- One active (not used, not revoked) token per family — the invariant a new
-- generation call also enforces procedurally (see generate_family_activation_
-- token below), this index is the backstop.
create unique index family_activation_tokens_one_active_idx
  on private.family_activation_tokens (family_id)
  where used_at is null and revoked_at is null;

create index family_activation_tokens_family_id_idx
  on private.family_activation_tokens (family_id);

comment on table private.family_activation_tokens is
  'Single-use activation tokens linking an existing family to a future Supabase Auth account. Never exposed to PostgREST — reachable only through the SECURITY DEFINER functions in this migration.';
comment on column private.family_activation_tokens.token_hash is
  'sha256(raw token), hex-encoded. The raw token is returned to the caller exactly once at generation and never stored.';

-- private is already fully revoked from anon/authenticated (001); this table
-- inherits that. service_role needs it for consume_family_activation's own
-- internal work even though that function is SECURITY DEFINER (the function
-- owner already has full rights as table owner, but grant explicitly for
-- clarity and so a future `alter default privileges` change can't surprise it).
grant select, insert, update on private.family_activation_tokens to service_role;

-- -----------------------------------------------------------------------------
-- generate_family_activation_token
--
-- Camp-Admin-only, own camp only — the same authorization predicate
-- create_family_with_members()/create_aid_distribution() already use,
-- re-derived from the database on every call. No Edge Function needed: this
-- never touches auth.admin.*, so a plain SECURITY DEFINER RPC is sufficient
-- and matches every other privileged-but-still-RLS-governable workflow
-- function in this project.
-- -----------------------------------------------------------------------------

create or replace function public.generate_family_activation_token(
  p_family_id uuid
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
  v_expires_at    timestamptz := now() + interval '7 days';
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

  -- Domain invariant (enforced by families_head_is_a_member): a family
  -- always has a head. Defended anyway rather than trusted blindly.
  if v_head_id is null then
    raise exception 'الأسرة بلا رب أسرة، لا يمكن إنشاء رابط تفعيل' using errcode = '22023';
  end if;

  -- Revoke any still-active token for this family before creating the new
  -- one — "one active token per family", procedurally enforced (the partial
  -- unique index is the backstop, not the only thing doing this).
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

comment on function public.generate_family_activation_token(uuid) is
  'Camp Admin only, own camp only. Returns the raw token exactly once — only its hash is ever stored.';

revoke all on function public.generate_family_activation_token(uuid) from public, anon, authenticated;
grant execute on function public.generate_family_activation_token(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- get_family_activation_status
--
-- Read-only counterpart for the Camp Admin UI: current token state + whether
-- the head already has a linked account. Never returns the token or its hash.
-- -----------------------------------------------------------------------------

create or replace function public.get_family_activation_status(
  p_family_id uuid
)
returns table (state text, expires_at timestamptz, created_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_camp_id  uuid;
  v_head_id  uuid;
  v_row      private.family_activation_tokens%rowtype;
  v_linked   boolean;
begin
  select f.camp_id, f.head_member_id into v_camp_id, v_head_id
  from public.families f
  where f.id = p_family_id;

  if v_camp_id is null then
    raise exception 'الأسرة غير موجودة' using errcode = 'P0002';
  end if;

  if private.is_browser_session()
     and not ((select private.is_camp_admin()) and (select private.current_camp_id()) = v_camp_id) then
    raise exception 'لا تملك صلاحية عرض حالة تفعيل هذه الأسرة' using errcode = '42501';
  end if;

  select exists (
    select 1 from public.profiles p where p.family_member_id = v_head_id
  ) into v_linked;

  if v_linked then
    return query select 'activated'::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  select * into v_row
  from private.family_activation_tokens t
  where t.family_id = p_family_id
  order by t.created_at desc
  limit 1;

  if not found then
    return query select 'none'::text, null::timestamptz, null::timestamptz;
  elsif v_row.used_at is not null then
    return query select 'used'::text, v_row.expires_at, v_row.created_at;
  elsif v_row.revoked_at is not null then
    return query select 'revoked'::text, v_row.expires_at, v_row.created_at;
  elsif v_row.expires_at <= now() then
    return query select 'expired'::text, v_row.expires_at, v_row.created_at;
  else
    return query select 'active'::text, v_row.expires_at, v_row.created_at;
  end if;
end;
$$;

comment on function public.get_family_activation_status(uuid) is
  'Camp Admin only, own camp only. Never returns a token or its hash — state only.';

revoke all on function public.get_family_activation_status(uuid) from public, anon, authenticated;
grant execute on function public.get_family_activation_status(uuid) to authenticated;

-- -----------------------------------------------------------------------------
-- verify_family_activation
--
-- Callable by anon: the caller has no session at this point in the flow —
-- the same trust model as any password-reset-confirm link (a possession
-- secret, the token, plus a knowledge factor, the identity fields). Does NOT
-- mark the token used — an identity typo or a "this email is taken, let me
-- pick another" retry must never burn the Camp Admin's link. Every failure
-- (not found / expired / revoked / used / identity mismatch) raises the SAME
-- generic message so a caller cannot learn which check failed.
-- -----------------------------------------------------------------------------

create or replace function public.verify_family_activation(
  p_token         text,
  p_reference_code text,
  p_national_id   text,
  p_birth_date    date
)
returns table (
  family_id         uuid,
  head_member_id    uuid,
  camp_id           uuid,
  full_name         text,
  already_activated boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token_hash text := encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex');
  v_row        private.family_activation_tokens%rowtype;
  v_family     public.families%rowtype;
  v_head       public.family_members%rowtype;
  v_linked     boolean;
  v_generic    constant text := 'بيانات التفعيل غير صحيحة';
begin
  if coalesce(btrim(p_token), '') = '' then
    raise exception '%', v_generic using errcode = '22023';
  end if;

  select * into v_row
  from private.family_activation_tokens t
  where t.token_hash = v_token_hash;

  if not found
     or v_row.revoked_at is not null
     or v_row.used_at is not null
     or v_row.expires_at <= now() then
    raise exception '%', v_generic using errcode = '22023';
  end if;

  select * into v_family from public.families f where f.id = v_row.family_id;
  select * into v_head from public.family_members m where m.id = v_row.head_member_id;

  if v_family.reference_code is distinct from upper(btrim(coalesce(p_reference_code, '')))
     or v_head.national_id is distinct from btrim(coalesce(p_national_id, ''))
     or v_head.birth_date is distinct from p_birth_date then
    update private.family_activation_tokens
    set failed_attempts = failed_attempts + 1,
        revoked_at = case when failed_attempts + 1 >= 10 then now() else revoked_at end
    where id = v_row.id;
    raise exception '%', v_generic using errcode = '22023';
  end if;

  select exists (
    select 1 from public.profiles p where p.family_member_id = v_row.head_member_id
  ) into v_linked;

  return query select v_family.id, v_head.id, v_family.camp_id, v_head.full_name, v_linked;
end;
$$;

comment on function public.verify_family_activation(text, text, text, date) is
  'Anonymous-callable by design (pre-login). Every rejection reason collapses to one generic Arabic message — see design doc §4.';

revoke all on function public.verify_family_activation(text, text, text, date) from public;
grant execute on function public.verify_family_activation(text, text, text, date) to anon, authenticated;

-- -----------------------------------------------------------------------------
-- consume_family_activation
--
-- service_role ONLY. Unlike verify_family_activation, this one must never be
-- reachable by a browser key: it re-points profiles.family_member_id for an
-- arbitrary p_new_user_id, trusting the caller entirely. FOR UPDATE closes
-- the race between two concurrent activations of the same family — only one
-- concurrent caller's transaction wins this lock and marks the token used.
-- -----------------------------------------------------------------------------

create or replace function public.consume_family_activation(
  p_token       text,
  p_new_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token_hash text := encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex');
  v_row        private.family_activation_tokens%rowtype;
  v_family     public.families%rowtype;
  v_head       public.family_members%rowtype;
begin
  select * into v_row
  from private.family_activation_tokens t
  where t.token_hash = v_token_hash
  for update;

  if not found
     or v_row.revoked_at is not null
     or v_row.used_at is not null
     or v_row.expires_at <= now() then
    raise exception 'رابط التفعيل لم يعد صالحاً' using errcode = '22023';
  end if;

  select * into v_family from public.families f where f.id = v_row.family_id;
  select * into v_head from public.family_members m where m.id = v_row.head_member_id;

  update private.family_activation_tokens
  set used_at = now()
  where id = v_row.id;

  update public.profiles
  set status = 'approved',
      camp_id = v_family.camp_id,
      family_member_id = v_head.id,
      full_name = coalesce(nullif(btrim(full_name), ''), v_head.full_name)
  where id = p_new_user_id;
end;
$$;

comment on function public.consume_family_activation(text, uuid) is
  'service_role only — never grant to anon/authenticated. Trusts p_new_user_id entirely, so it must only ever be called after the Edge Function has itself created that exact auth.users row.';

revoke all on function public.consume_family_activation(text, uuid) from public, anon, authenticated;
grant execute on function public.consume_family_activation(text, uuid) to service_role;

-- =============================================================================
-- Phase 3 — Cloudinary document storage: column-level privilege guard
--
-- documents_has_owner and documents_cloudinary_complete (both Phase 1) already
-- guarantee a document is never orphaned and never claims to be uploaded
-- without its Cloudinary identifiers — verified still in place before writing
-- this migration, so neither is repeated here.
--
-- What Phase 1 left open is a column-level gap RLS cannot close on its own
-- (see functions_and_triggers.sql §"Beyond RLS"): documents_update_admin
-- authorizes an UPDATE by ROW (super admin, or camp admin within their own
-- camp) but says nothing about which COLUMNS may change within that row.
-- Phase 3 spec §20 requires that a document's ownership (which family /
-- member / registration request / camp it belongs to) and its Cloudinary
-- identity be immutable once set through the plain PostgREST UPDATE path —
-- an admin editing a document's name or category must not also be able to
-- reassign it to another family/camp or rewrite which Cloudinary asset it
-- points at. Same pattern as guard_profile_privileges()/guard_notification_
-- update(): a BEFORE UPDATE trigger closes the column gap; RLS still decides
-- the row.
-- =============================================================================

create or replace function private.guard_document_privileges()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Trusted server-side contexts (service_role, the seed script) bootstrap
  -- these columns legitimately. The Cloudinary Edge Functions write through
  -- the caller's own browser-key session but only ever INSERT or DELETE
  -- documents rows, never UPDATE the locked columns below, so this guard
  -- never blocks a legitimate upload or delete.
  if not private.is_browser_session() then
    return new;
  end if;

  if new.family_id is distinct from old.family_id
     or new.family_member_id is distinct from old.family_member_id
     or new.registration_request_id is distinct from old.registration_request_id
     or new.camp_id is distinct from old.camp_id then
    raise exception 'لا يمكن نقل المستند إلى أسرة أو مخيم آخر' using errcode = '42501';
  end if;

  if new.cloudinary_public_id is distinct from old.cloudinary_public_id
     or new.secure_url is distinct from old.secure_url
     or new.resource_type is distinct from old.resource_type
     or new.format is distinct from old.format
     or new.storage_provider is distinct from old.storage_provider
     or new.file_url is distinct from old.file_url
     or new.original_filename is distinct from old.original_filename
     or new.mime_type is distinct from old.mime_type
     or new.file_size is distinct from old.file_size
     or new.uploaded_by is distinct from old.uploaded_by then
    raise exception 'لا يمكن تعديل بيانات الملف المرفوع مباشرة' using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function private.guard_document_privileges() is
  'Phase 3 spec §20: ownership and Cloudinary identity are immutable via plain UPDATE. Only name/category may change that way.';

create trigger documents_guard_privileges
  before update on public.documents
  for each row execute function private.guard_document_privileges();

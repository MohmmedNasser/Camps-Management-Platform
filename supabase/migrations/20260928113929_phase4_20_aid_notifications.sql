-- Phase 4.20: aid-distribution notifications.
--
-- Real aid creation (Phase 4.6) deliberately shipped without a notification
-- ("notifications stay out of scope") — that gap is now visible to real
-- beneficiaries, so it is closed the same way Phase 4.19 closed the message
-- one: notifications has no INSERT policy for any role (confirmed live,
-- unchanged since Phase 4.13/4.15), so the write has to happen server-side,
-- SECURITY DEFINER, same pattern as approve_registration_request()'s own
-- notification insert.
--
-- Triggered on aid_distribution_families rather than embedded inside
-- create_aid_distribution() so ONE trigger covers both real write paths:
-- the create RPC's own insert (including the "all families" case, which
-- still materialises one row per family) and updateAidDistribution()'s
-- plain client insert when a Camp Admin adds a beneficiary family to an
-- existing distribution during an edit.

create or replace function private.notify_aid_beneficiary_family()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_name       text;
  v_distributed_on date;
  v_type_labels    text;
begin
  select o.name, d.distributed_on
  into v_org_name, v_distributed_on
  from public.aid_distributions d
  join public.organizations o on o.id = d.organization_id
  where d.id = new.distribution_id;

  select string_agg(t.label_ar, '، ')
  into v_type_labels
  from public.aid_distribution_types adt
  join public.aid_types t on t.id = adt.aid_type_id
  where adt.distribution_id = new.distribution_id;

  insert into public.notifications (recipient_id, type, title, body, href)
  select
    p.id,
    'success',
    'تمت إضافة مساعدة جديدة إلى ملفك',
    coalesce(v_type_labels, 'مساعدة') || ' من ' || coalesce(v_org_name, 'جهة مانحة')
      || ' بتاريخ ' || to_char(v_distributed_on, 'DD/MM/YYYY') || '.',
    'aid.html'
  from public.family_members fm
  join public.profiles p on p.family_member_id = fm.id
  left join public.user_preferences up on up.user_id = p.id
  where fm.family_id = new.family_id
    and coalesce(up.notify_aid, true);

  return new;
end;
$$;

create trigger aid_distribution_families_notify_beneficiary
  after insert on public.aid_distribution_families
  for each row execute function private.notify_aid_beneficiary_family();

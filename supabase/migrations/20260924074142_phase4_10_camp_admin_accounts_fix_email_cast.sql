-- supabase/migrations/20260819000000_phase4_10_camp_admin_accounts.sql
-- Phase 4.10: exposes camp-admin accounts with their auth email to
-- super_admin only. profiles has no email column (auth.users is not
-- reachable via the publishable key), so this is the one safe,
-- SECURITY DEFINER read needed to list camp admins for real.

create or replace function public.get_camp_admin_accounts()
returns table (
  id uuid,
  full_name text,
  email text,
  phone text,
  camp_id uuid,
  camp_name text,
  status public.account_status,
  created_at timestamptz
)
language plpgsql
security definer
set search_path to ''
as $$
begin
  if not private.is_super_admin() then
    raise exception 'لا تملك صلاحية عرض حسابات مسؤولي المخيمات' using errcode = '42501';
  end if;

  return query
  select p.id, p.full_name, u.email::text, p.phone, p.camp_id, c.name, p.status, p.created_at
  from public.profiles p
  join auth.users u on u.id = p.id
  left join public.camps c on c.id = p.camp_id
  where p.role = 'camp_admin'
  order by p.created_at;
end;
$$;

revoke all on function public.get_camp_admin_accounts() from public;
grant execute on function public.get_camp_admin_accounts() to authenticated;

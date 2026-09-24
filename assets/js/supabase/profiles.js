// assets/js/supabase/profiles.js
import { requireClient, currentUserId } from '../core/supabase-client.js';
import { run, mapError, DataAccessError, ErrorType } from './errors.js';
import { paginate, sort } from './query.js';

const SORT_COLUMNS = ['created_at', 'full_name', 'status'];

/** Null when signed out OR when the row is missing — never throws for "no profile". */
export async function getOwnProfile() {
  const client = requireClient();
  const userId = await currentUserId();
  if (!userId) return null;
  return run(client.from('profiles').select('*').eq('id', userId).maybeSingle());
}

/** Only `full_name`/`phone` — role, camp and status are server-authorized only (spec §4). */
export async function updateOwnProfile(patch) {
  const client = requireClient();
  const userId = await currentUserId();
  const allowed = ['full_name', 'phone'];
  const body = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)));
  return run(client.from('profiles').update(body).eq('id', userId).select().single());
}

export async function listProfiles({ role, campId, status, page, pageSize, sortBy, sortDir } = {}) {
  const client = requireClient();
  let query = client.from('profiles').select('*', { count: 'exact' });
  if (role) query = query.eq('role', role);
  if (campId) query = query.eq('camp_id', campId);
  if (status) query = query.eq('status', status);
  query = sort(query, { sortBy, sortDir }, SORT_COLUMNS, 'created_at');
  query = paginate(query, { page, pageSize });
  const { data, error, count } = await query;
  if (error) throw mapError(error);
  return { rows: data, total: count };
}

/** Super Admin only, per RLS + `guard_profile_privileges`: sets role AND camp together. */
export async function assignCampAdmin(profileId, campId) {
  const client = requireClient();
  return run(
    client.from('profiles').update({ camp_id: campId, role: 'camp_admin' }).eq('id', profileId).select().single()
  );
}

export async function setProfileStatus(profileId, status) {
  const client = requireClient();
  return run(client.from('profiles').update({ status }).eq('id', profileId).select().single());
}

/** Super Admin only (RLS-checked inside the function, Phase 4.10): camp
 *  admins with their auth email, which `profiles` itself does not carry. */
export async function listCampAdminAccounts() {
  const client = requireClient();
  const rows = await run(client.rpc('get_camp_admin_accounts'));
  return rows.map((row) => ({
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    phone: row.phone || '',
    campId: row.camp_id,
    campName: row.camp_name || '—',
    status: row.status,
    createdAt: row.created_at,
  }));
}

const CAMP_ADMIN_EDGE_ERROR_TYPES = {
  unauthorized: ErrorType.UNAUTHORIZED,
  forbidden: ErrorType.FORBIDDEN,
  validation: ErrorType.VALIDATION,
  duplicate: ErrorType.DUPLICATE,
  database: ErrorType.DATABASE,
};

/** Edge Function errors arrive as `{ error: { code, message } }` on the
 *  failed response — same convention cloudinary.js's mapFunctionError()
 *  uses, duplicated locally rather than shared since the two modules'
 *  error-code sets differ. */
async function mapCampAdminFunctionError(error) {
  const context = error?.context;
  if (context && typeof context.json === 'function') {
    try {
      const body = await context.json();
      if (body?.error?.message) {
        return new DataAccessError(
          CAMP_ADMIN_EDGE_ERROR_TYPES[body.error.code] || ErrorType.DATABASE,
          body.error.message,
          error
        );
      }
    } catch {
      // fall through to the generic message below
    }
  }
  return new DataAccessError(ErrorType.DATABASE, 'حدث خطأ غير متوقع، حاول مرة أخرى', error);
}

/** Super Admin only: creates a real Auth user + promotes its trigger-created
 *  profile to role='camp_admin' in one privileged operation the publishable
 *  key cannot perform (Phase 4.10 §1.3/§4). Never constructs a service-role
 *  client here — that only exists inside the Edge Function itself. */
export async function createCampAdmin({ fullName, email, phone, password, campId, status }) {
  const client = requireClient();
  const { data, error } = await client.functions.invoke('admin-create-camp-admin', {
    body: { fullName, email, phone, password, campId, status },
  });
  if (error) throw await mapCampAdminFunctionError(error);
  return data.admin;
}

/** Super Admin editing ANOTHER profile's name/phone (updateOwnProfile()
 *  only ever targets currentUserId()). RLS: profiles_update_own_or_admin. */
export async function updateProfile(id, { fullName, phone }) {
  const client = requireClient();
  return run(
    client.from('profiles').update({ full_name: fullName, phone: phone || null }).eq('id', id).select().single()
  );
}

/** RLS: profiles_delete_super_admin. FK-safe by design — every FK
 *  referencing profiles(id) is ON DELETE SET NULL/CASCADE, never
 *  RESTRICT (verified live against the project's constraint list). */
export async function deleteProfile(id) {
  const client = requireClient();
  await run(client.from('profiles').delete().eq('id', id).select().maybeSingle());
}

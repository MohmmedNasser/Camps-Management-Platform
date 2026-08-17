// assets/js/supabase/profiles.js
import { requireClient, currentUserId } from '../core/supabase-client.js';
import { run, mapError } from './errors.js';
import { paginate, sort } from './query.js';

const SORT_COLUMNS = ['created_at', 'full_name', 'status'];

export async function getOwnProfile() {
  const client = requireClient();
  const userId = await currentUserId();
  if (!userId) return null;
  return run(client.from('profiles').select('*').eq('id', userId).single());
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

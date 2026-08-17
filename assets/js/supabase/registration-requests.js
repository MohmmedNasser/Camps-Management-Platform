// assets/js/supabase/registration-requests.js
import { requireClient, currentUserId } from '../core/supabase-client.js';
import { run, mapError } from './errors.js';
import { paginate, sort } from './query.js';

const SORT_COLUMNS = ['created_at', 'status'];

export async function listRegistrationRequests({ status, campId, page, pageSize, sortBy, sortDir } = {}) {
  const client = requireClient();
  let query = client.from('registration_requests').select('*', { count: 'exact' });
  if (status) query = query.eq('status', status);
  if (campId) query = query.eq('camp_id', campId);
  query = sort(query, { sortBy, sortDir }, SORT_COLUMNS, 'created_at');
  query = paginate(query, { page, pageSize });
  const { data, error, count } = await query;
  if (error) throw mapError(error);
  return { rows: data, total: count };
}

export async function getRegistrationRequest(id) {
  const client = requireClient();
  return run(client.from('registration_requests').select('*').eq('id', id).single());
}

export async function createRegistrationRequest({ fullName, nationalId, phone, email, campId, note = '' }) {
  const client = requireClient();
  const userId = await currentUserId();
  return run(
    client
      .from('registration_requests')
      .insert({
        user_id: userId,
        full_name: fullName,
        national_id: nationalId,
        phone,
        email,
        camp_id: campId,
        note,
      })
      .select()
      .single()
  );
}

/** Creates the person + family + activates the account (spec §16, existing RPC). */
export async function approveRegistrationRequest(id, { gender, birthDate }) {
  const client = requireClient();
  return run(client.rpc('approve_registration_request', { p_request_id: id, p_gender: gender, p_birth_date: birthDate }));
}

export async function rejectRegistrationRequest(id, note = '') {
  const client = requireClient();
  return run(client.rpc('reject_registration_request', { p_request_id: id, p_note: note }));
}

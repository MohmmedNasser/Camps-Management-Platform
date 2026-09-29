// assets/js/supabase/registration-requests.js
import { requireClient, currentUserId } from '../core/supabase-client.js';
import { run, mapError } from './errors.js';
import { paginate, sort } from './query.js';

const SORT_COLUMNS = ['created_at', 'status'];

const REQUEST_SELECT =
  'id, user_id, full_name, national_id, phone, email, camp_id, status, note, ' +
  'gender, birth_date, family_member_id, reviewed_by, reviewed_at, created_at, ' +
  'reviewer:profiles!registration_requests_reviewed_by_fkey(full_name)';

/** DB row (snake_case, with the reviewer embed) -> the shape every page reads. */
function mapRequestRow(row, campName = '') {
  return {
    id: row.id,
    userId: row.user_id,
    fullName: row.full_name,
    nationalId: row.national_id,
    phone: row.phone,
    email: row.email,
    campId: row.camp_id,
    campName,
    gender: row.gender || null,
    birthDate: row.birth_date || null,
    status: row.status,
    note: row.note || '',
    displacedId: row.family_member_id,
    reviewedAt: row.reviewed_at,
    reviewerName: row.reviewer?.full_name || '',
    createdAt: row.created_at,
  };
}

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

/**
 * Every registration request in one camp, unpaginated — the single query
 * behind the real Camp Admin list and its status-chip counts (Phase 4.7
 * spec §3/§4), same convention as `getCampFamilies()`/
 * `getCampDisplacedPersons()`/`getCampAidDistributions()`. RLS
 * (`registration_requests_select_scoped`) independently scopes every row
 * to the caller's own camp regardless of the `campId` argument.
 */
export async function getCampRegistrationRequests(campId) {
  const client = requireClient();
  const rows = await run(
    client.from('registration_requests').select(REQUEST_SELECT).eq('camp_id', campId)
  );
  return rows.map((row) => mapRequestRow(row));
}

/**
 * One registration request by id. `.maybeSingle()` (not `.single()`, the
 * repo-wide convention `getFamilyByReferenceCode()`/`getDisplacedPerson()`/
 * `getAidDistribution()` all use) so a nonexistent id or one RLS hides
 * (another camp) both resolve to a clean `null` the detail page can render
 * as its existing `emptyState()`, rather than a thrown NOT_FOUND that would
 * fall into `errorState()` instead (Phase 4.7 spec §5).
 */
export async function getRegistrationRequest(id, campName = '') {
  const client = requireClient();
  const row = await run(
    client.from('registration_requests').select(REQUEST_SELECT).eq('id', id).maybeSingle()
  );
  return row ? mapRequestRow(row, campName) : null;
}

/**
 * A `family_members` row sharing this national ID, within RLS's own-camp
 * scope only — the real-data equivalent of the mock's cross-camp
 * `store.displaced.find()` duplicate check, necessarily narrower (Phase
 * 4.7 spec §2: a Camp Admin cannot read another camp's `family_members`
 * regardless of this query). The authoritative, cross-camp guard stays the
 * database's global unique index, enforced when `approve_registration_
 * request` inserts the new member (surfaces as a `DUPLICATE` DataAccessError).
 * `campId` is redundant with RLS (`family_members_select_scoped`) but kept
 * explicit, matching `getCampFamilies()`/`getCampDisplacedPersons()`'s own
 * "matches the convention rather than being the actual boundary" comment.
 */
export async function findOwnCampDuplicate(nationalId, campId) {
  const client = requireClient();
  return run(
    client
      .from('family_members')
      .select('id, full_name')
      .eq('national_id', nationalId)
      .eq('camp_id', campId)
      .maybeSingle()
  );
}

/**
 * The current user's own registration request — what pending.html shows
 * while a self-registered account waits for a Camp Admin's decision. RLS
 * (`registration_requests_select_scoped`) already restricts this to the
 * caller's own row (`user_id = auth.uid()`), so no id/scoping argument is
 * needed; ordered by `created_at desc` in case more than one ever exists,
 * though the applicant can only ever create one for itself.
 */
export async function getOwnRegistrationRequest() {
  const client = requireClient();
  const userId = await currentUserId();
  if (!userId) return null;
  const rows = await run(
    client
      .from('registration_requests')
      .select(REQUEST_SELECT)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
  );
  return rows.length ? mapRequestRow(rows[0]) : null;
}

/** The sidebar's "طلبات التسجيل" badge — Camp Admin only (the only role with
 *  that nav item). RLS (registration_requests_select_scoped) is the actual
 *  scoping boundary; campId matches the getCampX() convention elsewhere. */
export async function getPendingRequestCount(campId) {
  const client = requireClient();
  const { count, error } = await client
    .from('registration_requests')
    .select('id', { count: 'exact' })
    .eq('camp_id', campId)
    .eq('status', 'pending');
  if (error) throw mapError(error);
  return count || 0;
}

export async function createRegistrationRequest({ fullName, nationalId, phone, email, campId, gender, birthDate, note = '' }) {
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
        gender: gender || null,
        birth_date: birthDate || null,
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

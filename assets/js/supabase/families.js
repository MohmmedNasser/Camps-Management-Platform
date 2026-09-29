// assets/js/supabase/families.js
import { requireClient } from '../core/supabase-client.js';
import { run, mapError } from './errors.js';
import { paginate, sort, fetchAll, fetchAllIn } from './query.js';
import { getDisplacedPerson } from './family-members.js';
import { applyFamilyFilters, refineFamilyRows, mapFamilyOverviewRow, FAMILY_OVERVIEW_COLUMNS } from './family-filters.js';

const SORT_COLUMNS = ['created_at', 'reference_code', 'updated_at'];

/**
 * `family_stats` is a GROUP BY view, so PostgREST cannot auto-detect a
 * foreign-key relationship to embed it under `families` the way a real
 * child table would (`PGRST200`, confirmed against the live schema cache).
 * Query it separately, keyed by `family_id`, and merge here instead.
 */
async function attachFamilyStats(client, families) {
  const ids = families.map((f) => f.id);
  if (!ids.length) return families;
  const stats = await fetchAllIn(() => client.from('family_stats').select('*'), 'family_id', ids, { order: ['family_id'] });
  const byFamily = new Map(stats.map((s) => [s.family_id, s]));
  return families.map((f) => ({ ...f, family_stats: byFamily.get(f.id) ?? null }));
}

/**
 * Every family matching `filters` (the families-page filter shape), read from
 * the `family_overview` view in ONE query — head, camp, member/child/orphan
 * counts and aid count are already joined, and every filter that has an exact
 * SQL equivalent runs in the database (family-filters.js). Terms the server
 * cannot match identically are refined client-side by the legacy predicate,
 * so the result equals `matchesFamilyFilters` over the whole set. Returned
 * rows keep the field names resultsView() and familyExportRow() read.
 * The view is `security_invoker`: RLS scopes every row to the caller
 * regardless of any camp filter (Phase 4.24 spec §6).
 */
async function fetchFamilyOverview(filters, extra = (q) => q) {
  const client = requireClient();
  const rows = await fetchAll(
    () => applyFamilyFilters(extra(client.from('family_overview').select(FAMILY_OVERVIEW_COLUMNS)), filters),
    { order: ['reference_code'] }
  );
  return refineFamilyRows(rows.map(mapFamilyOverviewRow), filters);
}

/** Camp Admin list: `campId` is a convenience narrowing — RLS is the boundary. */
export function getCampFamilies(campId, filters = {}) {
  return fetchFamilyOverview(filters, (q) => q.eq('camp_id', campId));
}

/** Super Admin list: every family platform-wide (RLS `is_super_admin()`), optionally filtered. */
export function getAllFamilies(filters = {}) {
  return fetchFamilyOverview(filters);
}

/**
 * `filters.search` matches `reference_code` by prefix (`FAM-000001` shape),
 * matching the pattern_ops index rather than a full scan.
 */
export async function listFamilies(filters = {}, { page, pageSize, sortBy, sortDir } = {}) {
  const client = requireClient();
  let query = client
    .from('families')
    .select('id, reference_code, camp_id, head_member_id, notes, created_at', { count: 'exact' });

  if (filters.campId) query = query.eq('camp_id', filters.campId);
  if (filters.search) query = query.ilike('reference_code', `${filters.search}%`);

  query = sort(query, { sortBy, sortDir }, SORT_COLUMNS, 'created_at');
  query = paginate(query, { page, pageSize });

  const { data, error, count } = await query;
  if (error) throw mapError(error);
  return { rows: await attachFamilyStats(client, data), total: count };
}

export async function getFamily(id) {
  const client = requireClient();
  const family = await run(client.from('families').select('*, family_members(*)').eq('id', id).single());
  const stats = await run(client.from('family_stats').select('*').eq('family_id', id).maybeSingle());
  return { ...family, family_stats: stats };
}

function mapMemberRow(row) {
  return {
    id: row.id,
    fullName: row.full_name,
    relationship: row.relationship,
    gender: row.gender,
    birthDate: row.birth_date,
    nationalId: row.national_id,
    chronicDiseases: row.chronic_diseases,
    disability: row.disability,
    fatherStatus: row.father_status,
    motherStatus: row.mother_status,
    tentType: row.tent_type,
  };
}

/**
 * One family by its human-readable reference_code (the id every real page
 * routes and links on — Phase 4.4 spec §1). getFamily() (above) is keyed
 * by the UUID primary key instead and is not used by this phase's pages.
 * Returns null for a non-existent or another-camp reference code (RLS on
 * `families` already hides the latter; maybeSingle() makes both cases the
 * same clean null rather than a thrown "not found" error).
 */
export async function getFamilyByReferenceCode(referenceCode) {
  const client = requireClient();
  const family = await run(
    client
      .from('families')
      .select(
        'id, reference_code, camp_id, notes, created_at, ' +
          'camp:camps!families_camp_id_fkey(name), ' +
          'head:family_members!families_head_member_id_fkey(full_name, tent_type), ' +
          'family_members!family_members_family_id_fkey(*)'
      )
      .eq('reference_code', referenceCode)
      .maybeSingle()
  );
  if (!family) return null;

  const stats = await run(
    client.from('family_stats').select('*').eq('family_id', family.id).maybeSingle()
  );

  const members = (family.family_members || [])
    .map(mapMemberRow)
    .sort((a, b) => (a.relationship === 'head' ? -1 : b.relationship === 'head' ? 1 : 0));

  return {
    id: family.reference_code,
    _dbId: family.id,
    campId: family.camp_id,
    campName: family.camp?.name || '—',
    notes: family.notes || '',
    createdAt: family.created_at,
    headName: family.head?.full_name || '—',
    head: members.find((m) => m.relationship === 'head') || null,
    membersCount: Number(stats?.members_count) || 0,
    childrenCount: Number(stats?.children_under_18) || 0,
    orphansCount: Number(stats?.orphans) || 0,
    members,
  };
}

/**
 * The signed-in displaced account's own family, resolved through the
 * Phase 4.12 identity chain (profiles.family_member_id -> family_members ->
 * families) — never a URL or localStorage value. Null when the account has
 * no family_member_id yet, or the linked family_member row has no family
 * (both states getDisplacedDashboard() already handles identically).
 */
export async function getOwnFamily(session) {
  if (!session?.familyMemberId) return null;
  const person = await getDisplacedPerson(session.familyMemberId);
  if (!person || !person.familyId) return null;
  return getFamilyByReferenceCode(person.familyId);
}

/**
 * Deletes a family by its reference_code. RLS (families_delete_camp_admin:
 * is_camp_admin() AND camp_id = current_camp_id()) is the entire
 * authorization boundary — no campId argument or check here (Phase 4.4
 * spec §2). Cascades to the family's members and aid links at the
 * database level (BACKEND.md §4: "Families cascade to their members").
 * Returns false if nothing matched — either the code doesn't exist, or
 * RLS silently excluded it (another camp's family) — both look identical
 * from here and are handled identically by the caller.
 */
export async function deleteFamily(referenceCode) {
  const client = requireClient();
  const deleted = await run(
    client.from('families').delete().eq('reference_code', referenceCode).select().maybeSingle()
  );
  return Boolean(deleted);
}

/**
 * The one-form family+members create (spec §7 / domain rule 13). The RPC
 * itself returns only the new family's raw UUID; this function reads the
 * reference_code back in the same call so callers can route on it
 * (Phase 4.4 spec §5.3) — never called from any page before Phase 4.4, so
 * this return-shape change has no other caller to preserve.
 */
export async function createFamilyWithMembers({ campId, head, members = [], notes = '' }) {
  const client = requireClient();
  const id = await run(
    client.rpc('create_family_with_members', {
      p_camp_id: campId,
      p_head: head,
      p_members: members,
      p_notes: notes,
    })
  );
  const { reference_code: referenceCode } = await run(
    client.from('families').select('reference_code').eq('id', id).single()
  );
  return { id, referenceCode };
}

/**
 * `{value, label, referenceCode}` options for the real Camp Admin aid
 * beneficiary multi-select (Phase 4.6). `value` is the family's UUID, not
 * its `reference_code`: `create_aid_distribution`/`updateAidDistribution()`'s
 * `p_family_ids`/`familyIds` are `uuid[]`, and `getCampFamilies()` above
 * discards the UUID entirely (it keys its own rows on `reference_code`
 * instead) — this is a separate, narrower query rather than a reshape of
 * that one, same convention as `family-members.js`'s `getDisplacedPerson()`
 * being separate from `listFamilyMembers()`. `referenceCode` is kept
 * alongside `value` because every existing caller that deep-links here
 * (`families.js`, `family-details.js`, `displaced-details.js`) hands over a
 * family's human-readable id (`row.id`/`family.id`/`person.familyId`, all
 * `reference_code` under real data), never its UUID.
 */
export async function getCampFamilyOptions(campId) {
  const client = requireClient();
  const rows = await run(
    client
      .from('families')
      .select('id, reference_code, head:family_members!families_head_member_id_fkey(full_name)')
      .eq('camp_id', campId)
  );
  return rows
    .map((family) => ({
      value: family.id,
      referenceCode: family.reference_code,
      label: `${family.reference_code} — ${family.head?.full_name || 'بدون رب أسرة'}`,
    }))
    .sort((a, b) => a.label.localeCompare(b.label, 'ar'));
}

/**
 * `{value, label, referenceCode}` options platform-wide — the Super Admin
 * equivalent of `getCampFamilyOptions()`, same shape, no camp filter. RLS
 * (`is_super_admin()`) is what removes the camp boundary.
 */
export async function getAllFamilyOptions() {
  const client = requireClient();
  const rows = await run(
    client
      .from('families')
      .select('id, reference_code, head:family_members!families_head_member_id_fkey(full_name)')
  );
  return rows
    .map((family) => ({
      value: family.id,
      referenceCode: family.reference_code,
      label: `${family.reference_code} — ${family.head?.full_name || 'بدون رب أسرة'}`,
    }))
    .sort((a, b) => a.label.localeCompare(b.label, 'ar'));
}

export async function updateFamily(id, patch) {
  const client = requireClient();
  const allowed = ['notes', 'head_member_id'];
  const body = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)));
  return run(client.from('families').update(body).eq('id', id).select().single());
}

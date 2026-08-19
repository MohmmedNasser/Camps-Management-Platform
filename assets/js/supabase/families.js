// assets/js/supabase/families.js
import { requireClient } from '../core/supabase-client.js';
import { run, mapError } from './errors.js';
import { paginate, sort } from './query.js';

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
  const stats = await run(client.from('family_stats').select('*').in('family_id', ids));
  const byFamily = new Map(stats.map((s) => [s.family_id, s]));
  return families.map((f) => ({ ...f, family_stats: byFamily.get(f.id) ?? null }));
}

/**
 * All families in one camp, with head name/tent type embedded (via the
 * families_head_member_id_fkey relationship) and family_stats attached —
 * shaped to exactly the field names resultsView() and familyExportRow()
 * already read. RLS (family_stats/family_member_facts are
 * security_invoker views over family_members' own RLS) independently
 * scopes every row to the caller's camp regardless of the campId argument
 * (Phase 4.4 spec §1/§2).
 */
export async function getCampFamilies(campId) {
  const client = requireClient();
  const families = await run(
    client
      .from('families')
      .select(
        'id, reference_code, camp_id, notes, created_at, ' +
          'head:family_members!families_head_member_id_fkey(full_name, tent_type)'
      )
      .eq('camp_id', campId)
  );
  if (!families.length) return [];

  const ids = families.map((f) => f.id);
  const [stats, aidLinks] = await Promise.all([
    run(client.from('family_stats').select('*').in('family_id', ids)),
    run(client.from('aid_distribution_families').select('family_id').in('family_id', ids)),
  ]);

  const statsByFamily = new Map(stats.map((s) => [s.family_id, s]));
  const aidCountByFamily = new Map();
  aidLinks.forEach((row) =>
    aidCountByFamily.set(row.family_id, (aidCountByFamily.get(row.family_id) || 0) + 1)
  );

  return families.map((family) => {
    const s = statsByFamily.get(family.id) || {};
    return {
      id: family.reference_code,
      headName: family.head?.full_name || '—',
      headTentType: family.head?.tent_type || '',
      notes: family.notes || '',
      membersCount: Number(s.members_count) || 0,
      childrenUnder18: Number(s.children_under_18) || 0,
      childrenUnder3: Number(s.children_under_3) || 0,
      childrenUnder2: Number(s.children_under_2) || 0,
      childrenUnder1: Number(s.children_under_1) || 0,
      orphans: Number(s.orphans) || 0,
      chronic: Number(s.chronic) || 0,
      disability: Number(s.disability) || 0,
      pregnant: Number(s.pregnant) || 0,
      breastfeeding: Number(s.breastfeeding) || 0,
      aidCount: aidCountByFamily.get(family.id) || 0,
      createdAt: family.created_at,
    };
  });
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
          'head:family_members!families_head_member_id_fkey(full_name, tent_type), ' +
          'family_members(*)'
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

export async function updateFamily(id, patch) {
  const client = requireClient();
  const allowed = ['notes', 'head_member_id'];
  const body = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)));
  return run(client.from('families').update(body).eq('id', id).select().single());
}

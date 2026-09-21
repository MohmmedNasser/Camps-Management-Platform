// assets/js/supabase/aids.js
import { requireClient } from '../core/supabase-client.js';
import { run, mapError } from './errors.js';
import { paginate, sort } from './query.js';

const SORT_COLUMNS = ['distributed_on', 'created_at'];

export async function listAidTypes({ activeOnly = true } = {}) {
  const client = requireClient();
  let query = client.from('aid_types').select('*').order('sort_order', { ascending: true });
  if (activeOnly) query = query.eq('is_active', true);
  return run(query);
}

/**
 * `filters.aidTypeCode` / `filters.familyId` use `!inner` so the filter
 * narrows the TOP-LEVEL distributions returned (and therefore pagination),
 * not just the nested arrays — a bare embedded filter without `!inner`
 * would leave the parent row in the page even when no nested row matches.
 */
export async function listAidDistributions(filters = {}, { page, pageSize, sortBy, sortDir } = {}) {
  const client = requireClient();
  const typesRel = filters.aidTypeCode
    ? 'aid_distribution_types!inner(aid_type:aid_types!inner(code, label_ar))'
    : 'aid_distribution_types(aid_type:aid_types(code, label_ar))';
  const familiesRel = filters.familyId
    ? 'aid_distribution_families!inner(family:families!inner(id, reference_code))'
    : 'aid_distribution_families(family:families(id, reference_code))';

  let query = client
    .from('aid_distributions')
    .select(
      `id, distributed_on, all_families_selected, organization:organizations(id, name), ${typesRel}, ${familiesRel}`,
      { count: 'exact' }
    );

  if (filters.campId) query = query.eq('camp_id', filters.campId);
  if (filters.organizationId) query = query.eq('organization_id', filters.organizationId);
  if (filters.dateFrom) query = query.gte('distributed_on', filters.dateFrom);
  if (filters.dateTo) query = query.lte('distributed_on', filters.dateTo);
  if (filters.aidTypeCode) query = query.eq('aid_distribution_types.aid_type.code', filters.aidTypeCode);
  if (filters.familyId) query = query.eq('aid_distribution_families.family.id', filters.familyId);

  query = sort(query, { sortBy, sortDir }, SORT_COLUMNS, 'distributed_on');
  query = paginate(query, { page, pageSize });

  const { data, error, count } = await query;
  if (error) throw mapError(error);
  return { rows: data, total: count };
}

/** No value/price/estimated_value/individual recipient — domain rule 9/23. */
export async function getFamilyAidHistory(familyId) {
  const client = requireClient();
  return run(
    client
      .from('aid_distribution_families')
      .select(
        'distribution:aid_distributions(id, distributed_on, organization:organizations(name), aid_distribution_types(aid_type:aid_types(label_ar)))'
      )
      .eq('family_id', familyId)
      .order('distribution(distributed_on)', { ascending: false })
  );
}

/**
 * Family reference codes with at least one distribution matching the
 * active aid-type/donor filter, for the real Camp Admin displaced-list
 * page (Phase 4.5 spec §4 item 4/§5.1). `listAidDistributions()` above
 * cannot be reused directly — it paginates at `DEFAULT_PAGE_SIZE` (20),
 * which would silently truncate the filter's family set. Rooted at
 * `aid_distributions` and using the same nested-embed filter shape
 * `listAidDistributions()` already relies on
 * (`aid_distribution_types.aid_type.code`) rather than a deeper,
 * unproven nesting through the junction table.
 */
export async function getFamilyIdsForAidFilter(campId, { aidTypeCode = '', organizationId = '' } = {}) {
  const client = requireClient();
  const typesRel = aidTypeCode
    ? 'aid_distribution_types!inner(aid_type:aid_types!inner(code))'
    : 'aid_distribution_types(aid_type:aid_types(code))';
  let query = client
    .from('aid_distributions')
    .select(`camp_id, ${typesRel}, aid_distribution_families(family:families(reference_code))`)
    .eq('camp_id', campId);
  if (organizationId) query = query.eq('organization_id', organizationId);
  if (aidTypeCode) query = query.eq('aid_distribution_types.aid_type.code', aidTypeCode);

  const rows = await run(query);
  const ids = new Set();
  rows.forEach((row) =>
    (row.aid_distribution_families || []).forEach((link) => {
      const code = link.family?.reference_code;
      if (code) ids.add(code);
    })
  );
  return ids;
}

/**
 * One shared embed shape for the real Camp Admin aid pages (Phase 4.6):
 * the parent row, its aid types, its beneficiary families (with head name),
 * the donor's optional contact fields, and who registered it. Mirrors the
 * `families.js`/`family-members.js` convention of one `SELECT` string reused
 * by every function that needs the full row.
 */
const DISTRIBUTION_SELECT =
  'id, distributed_on, all_families_selected, camp_id, created_at, ' +
  'organization:organizations(id, name, responsible_person, phone), ' +
  'aid_distribution_types(aid_type:aid_types(code, label_ar)), ' +
  'aid_distribution_families(family:families(id, reference_code, ' +
  'head:family_members!families_head_member_id_fkey(full_name))), ' +
  'created_by:profiles!aid_distributions_created_by_fkey(full_name)';

/**
 * DB row -> the shape `select.aidRow()` already produces for the mock path,
 * so `aids.js`'s table/summary/export code needs no change to read either
 * one. Two beneficiary id spaces are kept side by side on purpose:
 * `familyIds` (reference codes, e.g. `FAM-000001`) is what the UI displays,
 * links to `family-details.html` with, and searches by; `familyDbIds`
 * (UUIDs) is what `create_aid_distribution`/`updateAidDistribution()` and
 * the real family multi-select's option `value`s actually are.
 */
function mapAidDistributionRow(row) {
  const types = (row.aid_distribution_types || []).map((t) => t.aid_type?.code).filter(Boolean);
  const typeLabels = (row.aid_distribution_types || [])
    .map((t) => t.aid_type?.label_ar)
    .filter(Boolean)
    .join('، ');
  const beneficiaries = (row.aid_distribution_families || []).map((link) => ({
    familyId: link.family?.reference_code || '',
    familyDbId: link.family?.id || '',
    headName: link.family?.head?.full_name || '—',
  }));

  return {
    id: row.id,
    types,
    typeLabels,
    organizationId: row.organization?.id || '',
    organizationName: row.organization?.name || '—',
    familyIds: beneficiaries.map((b) => b.familyId),
    familyDbIds: beneficiaries.map((b) => b.familyDbId),
    beneficiaryCount: beneficiaries.length,
    beneficiaries,
    date: row.distributed_on,
    campId: row.camp_id,
    allFamiliesSelected: row.all_families_selected,
    createdAt: row.created_at,
    createdByName: row.created_by?.full_name || '—',
    donor: {
      responsiblePerson: row.organization?.responsible_person || '',
      phone: row.organization?.phone || '',
    },
  };
}

/**
 * Every aid distribution in one camp, unpaginated — the single query behind
 * the real Camp Admin list, its result count and its Excel export (Phase
 * 4.6 spec, matching `getCampFamilies()`/`getCampDisplacedPersons()`).
 * `listAidDistributions()` above cannot be reused directly: it paginates at
 * `DEFAULT_PAGE_SIZE` (20), which would silently truncate the page's own
 * client-side filtering and the export, the same trap Phase 4.5 avoided for
 * `getFamilyIdsForAidFilter()`. RLS (`aid_distributions_select_scoped`)
 * independently scopes every row to the caller's own camp regardless of the
 * `campId` argument.
 */
export async function getCampAidDistributions(campId) {
  const client = requireClient();
  const rows = await run(
    client
      .from('aid_distributions')
      .select(DISTRIBUTION_SELECT)
      .eq('camp_id', campId)
      .order('distributed_on', { ascending: false })
  );
  return rows.map(mapAidDistributionRow);
}

/**
 * One aid distribution by id. Returns null for a nonexistent id or one RLS
 * hides (another camp) — both look identical from here, same convention as
 * `families.js`'s `getFamilyByReferenceCode()`.
 */
export async function getAidDistribution(id) {
  const client = requireClient();
  const row = await run(client.from('aid_distributions').select(DISTRIBUTION_SELECT).eq('id', id).maybeSingle());
  return row ? mapAidDistributionRow(row) : null;
}

/**
 * Other distributions sharing at least one beneficiary family with this one
 * — the aid-details "مساعدات أخرى لهذه الأسر" panel, real-data equivalent of
 * the mock's `dedupeById((raw.familyIds||[]).flatMap(id => searchAid({familyId: id})))`.
 */
export async function getSiblingDistributions(familyDbIds, excludeId, { limit = 5 } = {}) {
  if (!familyDbIds?.length) return [];
  const client = requireClient();
  const links = await run(
    client.from('aid_distribution_families').select('distribution_id').in('family_id', familyDbIds)
  );
  const ids = [...new Set(links.map((link) => link.distribution_id))]
    .filter((distributionId) => distributionId !== excludeId)
    .slice(0, limit);
  if (!ids.length) return [];

  const rows = await run(client.from('aid_distributions').select(DISTRIBUTION_SELECT).in('id', ids));
  return rows.map(mapAidDistributionRow).sort((a, b) => new Date(b.date) - new Date(a.date));
}

/**
 * Edits a distribution's donor/date and its type/beneficiary junction rows.
 * No RPC covers this (`create_aid_distribution` is create-only) and none is
 * needed: RLS already grants Camp Admin full CRUD, own-camp-scoped, on
 * `aid_distributions` and both junction tables (confirmed live). The
 * deferred `aid_distributions_complete` constraint trigger only fires on
 * the parent row's own insert/update, never on a junction table by itself,
 * but additions are still applied before removals here so the distribution
 * is never left transiently without a type or a beneficiary between the
 * separate PostgREST requests (each is its own transaction — BACKEND.md
 * §8/§12 "the Data API runs every request in its own transaction").
 */
export async function updateAidDistribution(
  id,
  { organizationId, distributedOn, aidTypeCodes = [], familyIds = [], allFamiliesSelected = false }
) {
  const client = requireClient();

  await run(
    client
      .from('aid_distributions')
      .update({
        organization_id: organizationId,
        distributed_on: distributedOn,
        all_families_selected: allFamiliesSelected,
      })
      .eq('id', id)
      .select()
      .single()
  );

  const [types, currentTypeLinks, currentFamilyLinks] = await Promise.all([
    run(client.from('aid_types').select('id, code').in('code', aidTypeCodes)),
    run(client.from('aid_distribution_types').select('aid_type_id').eq('distribution_id', id)),
    run(client.from('aid_distribution_families').select('family_id').eq('distribution_id', id)),
  ]);

  const nextTypeIds = new Set(types.map((t) => t.id));
  const currentTypeIds = new Set(currentTypeLinks.map((t) => t.aid_type_id));
  const typesToAdd = [...nextTypeIds].filter((typeId) => !currentTypeIds.has(typeId));
  const typesToRemove = [...currentTypeIds].filter((typeId) => !nextTypeIds.has(typeId));

  const nextFamilyIds = new Set(familyIds);
  const currentFamilyIds = new Set(currentFamilyLinks.map((f) => f.family_id));
  const familiesToAdd = [...nextFamilyIds].filter((familyId) => !currentFamilyIds.has(familyId));
  const familiesToRemove = [...currentFamilyIds].filter((familyId) => !nextFamilyIds.has(familyId));

  if (typesToAdd.length) {
    await run(
      client
        .from('aid_distribution_types')
        .insert(typesToAdd.map((aid_type_id) => ({ distribution_id: id, aid_type_id })))
    );
  }
  if (familiesToAdd.length) {
    await run(
      client
        .from('aid_distribution_families')
        .insert(familiesToAdd.map((family_id) => ({ distribution_id: id, family_id })))
    );
  }
  if (typesToRemove.length) {
    await run(
      client.from('aid_distribution_types').delete().eq('distribution_id', id).in('aid_type_id', typesToRemove)
    );
  }
  if (familiesToRemove.length) {
    await run(
      client
        .from('aid_distribution_families')
        .delete()
        .eq('distribution_id', id)
        .in('family_id', familiesToRemove)
    );
  }
}

/**
 * Deletes a distribution. RLS (`aid_distributions_delete_camp_admin`:
 * `is_camp_admin() AND camp_id = current_camp_id()`) is the entire
 * authorization boundary, same convention as `families.js`'s
 * `deleteFamily()`. Both junction tables cascade at the database level
 * (`on delete cascade`), so no separate cleanup call is needed. Returns
 * false if nothing matched — nonexistent id or RLS silently excluded it
 * (another camp) — both look identical from here.
 */
export async function deleteAidDistribution(id) {
  const client = requireClient();
  const deleted = await run(client.from('aid_distributions').delete().eq('id', id).select().maybeSingle());
  return Boolean(deleted);
}

export async function createAidDistribution({
  organizationId,
  campId,
  distributedOn,
  aidTypeCodes,
  familyIds = [],
  allFamiliesSelected = false,
}) {
  const client = requireClient();
  return run(
    client.rpc('create_aid_distribution', {
      p_organization_id: organizationId,
      p_camp_id: campId,
      p_distributed_on: distributedOn,
      p_aid_type_codes: aidTypeCodes,
      p_family_ids: familyIds,
      p_all_families_selected: allFamiliesSelected,
    })
  );
}

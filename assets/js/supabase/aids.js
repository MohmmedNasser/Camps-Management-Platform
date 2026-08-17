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

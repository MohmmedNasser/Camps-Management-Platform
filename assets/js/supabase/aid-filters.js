// assets/js/supabase/aid-filters.js
// Pure request/response shaping for the `list_aid_distributions` RPC (Phase 4.25).
// No client import: callers pass their own Supabase client (same split as
// family-filters.js / displaced-filters.js), so this runs in Node against real sessions.
import { PAGE_SIZE } from '../core/config.js';
import { mapError } from './errors.js';
import { isUuid, RPC_MAX_LIMIT } from './displaced-filters.js';

/**
 * DB row -> the shape the aid list/detail/export code reads. Two beneficiary
 * id spaces are kept side by side on purpose: `familyIds` (reference codes,
 * e.g. `FAM-000001`) is what the UI displays, links to `family-details.html`
 * with, and searches by; `familyDbIds` (UUIDs) is what
 * `create_aid_distribution`/`updateAidDistribution()` and the real family
 * multi-select's option `value`s actually are.
 *
 * Both the embed `aids.js` reads (`DISTRIBUTION_SELECT`) and the rows the list
 * RPC builds have exactly this input shape.
 */
export function mapAidDistributionRow(row) {
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
    campName: row.camp?.name || '—',
    allFamiliesSelected: row.all_families_selected,
    createdAt: row.created_at,
    createdByName: row.created_by?.full_name || '—',
    donor: {
      responsiblePerson: row.organization?.responsible_person || '',
      phone: row.organization?.phone || '',
    },
  };
}

/** Page filters -> RPC arguments, or `null` for a filter that can match nothing (malformed id). */
export function aidRpcParams(filters = {}, { page = 1, pageSize = PAGE_SIZE, limit, offset } = {}) {
  if (filters.organizationId && !isUuid(filters.organizationId)) return null;
  if (filters.familyId && !isUuid(filters.familyId)) return null;
  const size = limit ?? pageSize;
  return {
    p_query: (filters.query || '').trim(),
    p_type: filters.type || '',
    p_organization_id: filters.organizationId || null,
    p_family_id: filters.familyId || null,
    p_limit: size,
    p_offset: offset ?? (Math.max(1, Number(page) || 1) - 1) * size,
  };
}

const EMPTY_SUMMARY = Object.freeze({ organizations: 0, families: 0, types: 0 });

function mapAidPage(data) {
  return {
    rows: (data.rows || []).map(mapAidDistributionRow),
    total: Number(data.total) || 0,
    summary: { ...EMPTY_SUMMARY, ...(data.summary || {}) },
  };
}

/** One page (or, with `pageSize: 0`, just count + summary) of the filtered list. */
export async function fetchAidPage(client, filters, pagination) {
  const params = aidRpcParams(filters, pagination);
  if (!params) return { rows: [], total: 0, summary: { ...EMPTY_SUMMARY } };
  const { data, error } = await client.rpc('list_aid_distributions', params);
  if (error) throw mapError(error);
  return mapAidPage(data);
}

/** Every row of the filtered set in fixed-order batches — the Excel-export path only. */
export async function fetchAllAid(client, filters, { batchSize = RPC_MAX_LIMIT } = {}) {
  const rows = [];
  for (let offset = 0; ; offset += batchSize) {
    const params = aidRpcParams(filters, { limit: batchSize, offset });
    if (!params) return [];
    const { data, error } = await client.rpc('list_aid_distributions', params);
    if (error) throw mapError(error);
    const page = mapAidPage(data);
    rows.push(...page.rows);
    if (rows.length >= page.total || !page.rows.length) return rows;
  }
}

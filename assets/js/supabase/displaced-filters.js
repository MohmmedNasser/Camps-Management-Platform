// assets/js/supabase/displaced-filters.js
// Pure request/response shaping for the `list_displaced_persons` RPC (Phase 4.25).
// No client import: callers pass their own Supabase client, so this can be
// exercised in Node against a real session (same split as family-filters.js).
import { AGE_BANDS, PAGE_SIZE } from '../core/config.js';
import { mapError } from './errors.js';

/** Server-side clamp of `p_limit`; export batches use it. */
export const RPC_MAX_LIMIT = 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value) => typeof value === 'string' && UUID.test(value);

/**
 * Page filters -> RPC arguments, or `null` when a filter can match nothing
 * (a malformed id, which the old JS predicate treated as "no rows"; a typed
 * uuid parameter would 400 instead). Unknown age bands are ignored, exactly as
 * the old `AGE_BANDS.find()` did. Pagination is `page`/`pageSize`, or an explicit
 * `limit`/`offset` (export batches).
 */
export function displacedRpcParams(filters = {}, { page = 1, pageSize = PAGE_SIZE, limit, offset } = {}) {
  if (filters.campId && !isUuid(filters.campId)) return null;
  if (filters.organizationId && !isUuid(filters.organizationId)) return null;

  const band = AGE_BANDS.find((entry) => entry.value === filters.ageBand);
  const size = limit ?? pageSize;
  return {
    p_query: (filters.query || '').trim(),
    p_camp_id: filters.campId || null,
    p_gender: filters.gender || '',
    p_status: filters.status || '',
    p_tent_type: filters.tentType || '',
    p_age_under: band ? band.max : null,
    p_is_child: filters.isChild || '',
    p_is_orphan: filters.isOrphan || '',
    p_has_chronic: filters.hasChronic || '',
    p_is_pregnant: filters.isPregnant || '',
    p_is_breastfeeding: filters.isBreastfeeding || '',
    p_aid_type: filters.aidType || '',
    p_organization_id: filters.organizationId || null,
    p_limit: size,
    p_offset: offset ?? (Math.max(1, Number(page) || 1) - 1) * size,
  };
}

/**
 * A displaced person's full record, mapped snake_case DB -> camelCase UI —
 * the shape `displacedFields()`, `personFacts()`, the detail-tab renderers
 * and `displacedExportRow()` already read. `family_members` IS the
 * displaced-person table (BACKEND.md §2); `family.reference_code` becomes
 * `familyId`/`familyLabel`, matching the mock's convention of storing the
 * family's human-readable id directly on the person row (Phase 4.5 spec §5.1).
 *
 * `ageYears` is present only on rows the list RPC returned: the database's
 * own completed-years age (Phase 4.25), which `selectors.ageOf()` prefers.
 */
export function mapDisplacedRow(row) {
  const mapped = {
    id: row.id,
    campId: row.camp_id,
    campName: row.camp?.name || '—',
    familyId: row.family?.reference_code || '',
    familyLabel: row.family?.reference_code || '—',
    fullName: row.full_name,
    fullNameEn: row.full_name_en || '',
    nationalId: row.national_id,
    gender: row.gender,
    birthDate: row.birth_date,
    maritalStatus: row.marital_status,
    nationality: row.nationality,
    passportNumber: row.passport_number || '',
    unrwaNumber: row.unrwa_number || '',
    phone: row.phone || '',
    altPhone: row.alt_phone || '',
    email: row.email || '',
    governorate: row.governorate,
    city: row.city || '',
    area: row.area || '',
    tentType: row.tent_type,
    originGovernorate: row.origin_governorate,
    originCity: row.origin_city || '',
    displacementDate: row.displacement_date,
    chronicDiseases: row.chronic_diseases || '',
    disability: row.disability || '',
    fatherStatus: row.father_status,
    motherStatus: row.mother_status,
    isPregnant: row.is_pregnant,
    isBreastfeeding: row.is_breastfeeding,
    workStatus: row.work_status,
    incomeSource: row.income_source,
    monthlyIncome: Number(row.monthly_income) || 0,
    relationship: row.relationship,
    status: row.status,
    createdAt: row.created_at,
  };
  if ('age_years' in row) mapped.ageYears = row.age_years;
  return mapped;
}

/** One page (or, with `pageSize: 0`, just the count) of the filtered list. */
export async function fetchDisplacedPage(client, filters, pagination) {
  const params = displacedRpcParams(filters, pagination);
  if (!params) return { rows: [], total: 0 };
  const { data, error } = await client.rpc('list_displaced_persons', params);
  if (error) throw mapError(error);
  return { rows: (data.rows || []).map(mapDisplacedRow), total: Number(data.total) || 0 };
}

/**
 * Every row of the filtered set, in `batchSize` requests over the RPC's fixed
 * total order (so batches never overlap or skip). This is the Excel-export
 * path: it never runs for the on-screen page.
 */
export async function fetchAllDisplaced(client, filters, { batchSize = RPC_MAX_LIMIT } = {}) {
  const rows = [];
  for (let offset = 0; ; offset += batchSize) {
    const params = displacedRpcParams(filters, { limit: batchSize, offset });
    if (!params) return [];
    const { data, error } = await client.rpc('list_displaced_persons', params);
    if (error) throw mapError(error);
    rows.push(...(data.rows || []).map(mapDisplacedRow));
    if (rows.length >= Number(data.total) || !data.rows?.length) return rows;
  }
}

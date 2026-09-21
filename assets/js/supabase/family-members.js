// assets/js/supabase/family-members.js
import { requireClient } from '../core/supabase-client.js';
import { run, mapError, DataAccessError, ErrorType } from './errors.js';
import { paginate, sort } from './query.js';

const SORT_COLUMNS = ['created_at', 'full_name', 'birth_date'];

/**
 * `family_member_facts` has no real foreign key back to `family_members`
 * from PostgREST's point of view (`PGRST200`, confirmed against the live
 * schema cache), so it can't be embedded with `family_members(...)` syntax.
 * Query it separately, keyed by `member_id`, and merge here instead.
 */
async function attachFacts(client, members) {
  const ids = members.map((m) => m.id);
  if (!ids.length) return members;
  const facts = await run(client.from('family_member_facts').select('*').in('member_id', ids));
  const byMember = new Map(facts.map((f) => [f.member_id, f]));
  return members.map((m) => ({ ...m, family_member_facts: byMember.get(m.id) ?? null }));
}

export async function listFamilyMembers(familyId, { page, pageSize, sortBy, sortDir } = {}) {
  const client = requireClient();
  let query = client.from('family_members').select('*', { count: 'exact' }).eq('family_id', familyId);
  query = sort(query, { sortBy, sortDir }, SORT_COLUMNS, 'created_at');
  query = paginate(query, { page, pageSize });
  const { data, error, count } = await query;
  if (error) throw mapError(error);
  return { rows: await attachFacts(client, data), total: count };
}

export async function getFamilyMember(id) {
  const client = requireClient();
  const member = await run(client.from('family_members').select('*').eq('id', id).single());
  const facts = await run(client.from('family_member_facts').select('*').eq('member_id', id).maybeSingle());
  return { ...member, family_member_facts: facts };
}

/** Adds a person to an EXISTING family (spec §8) — see the add_family_member RPC. */
export async function addFamilyMember(familyId, member) {
  const client = requireClient();
  return run(client.rpc('add_family_member', { p_family_id: familyId, p_member: member }));
}

export async function updateFamilyMember(id, patch) {
  const client = requireClient();
  return run(client.from('family_members').update(patch).eq('id', id).select().single());
}

export async function removeFamilyMember(id) {
  const client = requireClient();
  await run(client.from('family_members').delete().eq('id', id).select().maybeSingle());
}

/** Spec §9: detect the 23505 unique-violation on `national_id` cleanly. */
export function isDuplicateNationalId(error) {
  return error instanceof DataAccessError && error.type === ErrorType.DUPLICATE;
}

/**
 * A displaced person's full record, mapped snake_case DB -> camelCase UI —
 * the shape `displacedFields()`, `personFacts()`, the detail-tab renderers
 * and `displacedExportRow()` already read. `family_members` IS the
 * displaced-person table (BACKEND.md §2); `family.reference_code` becomes
 * `familyId`/`familyLabel`, matching the mock's convention of storing the
 * family's human-readable id directly on the person row (Phase 4.5 spec §5.1).
 */
function mapDisplacedRow(row) {
  return {
    id: row.id,
    campId: row.camp_id,
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
}

const DISPLACED_SELECT = '*, family:families!family_members_family_id_fkey(reference_code)';

/**
 * Every displaced person in one camp. RLS (`family_members_select_scoped`:
 * `is_camp_admin() AND camp_id = current_camp_id()`) independently scopes
 * every row regardless of the campId argument (Phase 4.5 spec §1/§2) — the
 * explicit `.eq('camp_id', campId)` matches the Phase 4.4 `getCampFamilies`
 * convention rather than being the actual security boundary.
 */
export async function getCampDisplacedPersons(campId) {
  const client = requireClient();
  const rows = await run(client.from('family_members').select(DISPLACED_SELECT).eq('camp_id', campId));
  return rows.map(mapDisplacedRow);
}

/**
 * One displaced person by id. Returns null for a nonexistent id or one RLS
 * hides (another camp) — both look identical from here, same convention as
 * `families.js`'s `getFamilyByReferenceCode()`.
 */
export async function getDisplacedPerson(id) {
  const client = requireClient();
  const row = await run(client.from('family_members').select(DISPLACED_SELECT).eq('id', id).maybeSingle());
  return row ? mapDisplacedRow(row) : null;
}

/**
 * camelCase form values -> the snake_case jsonb/column keys
 * `insert_family_member`/a plain `family_members` UPDATE read (Phase 4.5
 * spec §4 item 5). Extracted from family-create.js's local `toMemberPayload`
 * (Phase 4.4 predicted this extraction) and reused by both
 * `addFamilyMember()` (create) and `updateFamilyMember()` (edit) callers.
 *
 * Fixes one real bug found during the extraction: the original mapper
 * hardcoded `relationship: 'member'` for every non-head member, but
 * `'member'` is not a value of the `family_relationship` enum (confirmed
 * live) — it silently discarded the admin's actual chosen relationship.
 * This never surfaced because no existing test ever submitted a family with
 * an additional member block. Fixed to read `values.relationship` (falling
 * back to `'other'`, matching `readMember()`'s own fallback) instead.
 *
 * `relationship` is included only when `values.relationship` is present.
 * `displaced-edit.js`'s real path renders `displacedFields()` with
 * `showFamily: false` (Phase 4.5 spec §5.4 — family reassignment is not
 * exposed there), so its `values` never carries a `relationship` key; if
 * this mapper defaulted it to `'other'` unconditionally, every edit save
 * would silently overwrite the person's real relationship. Omitting the
 * key entirely leaves the column untouched by `updateFamilyMember()`'s
 * plain `.update()` — a key not present in the payload is a key
 * `.update()` never sends.
 */
/**
 * `insert_family_member`'s SQL wraps nearly every optional field in
 * `nullif(p_data ->> 'x', '')` before casting, so an empty form field
 * becomes SQL `NULL`, never the literal empty string — which matters
 * because several of these columns are nullable `CHECK`-constrained
 * (`email`, `alt_phone`: regex) or enum-typed (`governorate`,
 * `origin_governorate`), and empty-string is invalid for both. `addFamilyMember()`
 * (the create path, via the RPC) gets this for free; `updateFamilyMember()`
 * (a plain `.update()`, no RPC) does not — an empty string sent there hits
 * the CHECK/enum-cast directly and 400s. Mirrored here client-side so both
 * callers produce a payload the DB accepts either way.
 */
function nullIfEmpty(value) {
  const trimmed = (value ?? '').toString().trim();
  return trimmed === '' ? null : trimmed;
}

export function toFamilyMemberPayload(values, overrides = {}) {
  const payload = {
    full_name: values.fullName.trim(),
    full_name_en: nullIfEmpty(values.fullNameEn),
    national_id: values.nationalId.trim(),
    gender: values.gender,
    birth_date: nullIfEmpty(values.birthDate),
    marital_status: values.maritalStatus,
    nationality: values.nationality || 'palestinian',
    passport_number: nullIfEmpty(values.passportNumber),
    unrwa_number: nullIfEmpty(values.unrwaNumber),
    phone: nullIfEmpty(values.phone),
    alt_phone: nullIfEmpty(values.altPhone),
    email: nullIfEmpty(values.email),
    governorate: nullIfEmpty(values.governorate),
    city: nullIfEmpty(values.city),
    area: nullIfEmpty(values.area),
    tent_type: values.tentType,
    origin_governorate: nullIfEmpty(values.originGovernorate),
    origin_city: nullIfEmpty(values.originCity),
    displacement_date: nullIfEmpty(values.displacementDate),
    // NOT NULL with a default of '' — unlike the fields above, these must
    // stay an empty string, never null (matches insert_family_member's own
    // `coalesce(p_data ->> 'x', '')`, not a `nullif`).
    chronic_diseases: (values.chronicDiseases || '').trim(),
    disability: (values.disability || '').trim(),
    father_status: values.fatherStatus || 'alive',
    mother_status: values.motherStatus || 'alive',
    is_pregnant: values.isPregnant ?? null,
    is_breastfeeding: values.isBreastfeeding ?? null,
    work_status: values.workStatus,
    income_source: values.incomeSource,
    monthly_income: Number(values.monthlyIncome || 0),
  };
  if (values.relationship !== undefined) payload.relationship = values.relationship || 'other';
  return { ...payload, ...overrides };
}

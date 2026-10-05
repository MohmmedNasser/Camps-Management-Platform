// assets/js/supabase/family-members.js
import { requireClient } from '../core/supabase-client.js';
import { run, mapError, DataAccessError, ErrorType } from './errors.js';
import { paginate, sort, fetchAll, fetchAllIn } from './query.js';
import { mapDisplacedRow, fetchDisplacedPage, fetchAllDisplaced } from './displaced-filters.js';

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
  const facts = await fetchAllIn(() => client.from('family_member_facts').select('*'), 'member_id', ids, {
    order: ['member_id'],
  });
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

const DISPLACED_SELECT =
  '*, family:families!family_members_family_id_fkey(reference_code), ' +
  'camp:camps!family_members_camp_id_fkey(name)';

/**
 * Every displaced person platform-wide — the real Super Admin list (Phase
 * 4.19 follow-up). RLS (`family_members_select_scoped`: `is_super_admin()`)
 * is what actually removes the camp boundary; no argument is needed.
 */
export async function getAllDisplacedPersons() {
  const client = requireClient();
  const rows = await fetchAll(() => client.from('family_members').select(DISPLACED_SELECT), {
    order: ['created_at', 'id'],
  });
  return rows.map(mapDisplacedRow);
}

/**
 * Every displaced person in one camp. RLS (`family_members_select_scoped`:
 * `is_camp_admin() AND camp_id = current_camp_id()`) independently scopes
 * every row regardless of the campId argument (Phase 4.5 spec §1/§2) — the
 * explicit `.eq('camp_id', campId)` matches the Phase 4.4 `getCampFamilies`
 * convention rather than being the actual security boundary.
 */
export async function getCampDisplacedPersons(campId) {
  const client = requireClient();
  const rows = await fetchAll(() => client.from('family_members').select(DISPLACED_SELECT).eq('camp_id', campId), {
    order: ['created_at', 'id'],
  });
  return rows.map(mapDisplacedRow);
}

/**
 * One page of the filtered displaced-persons list, filtered, counted and paged
 * by the database (Phase 4.25, `list_displaced_persons`). `{ rows, total }`;
 * `pageSize: 0` returns just the count. RLS scopes the rows to the caller's
 * camp (Camp Admin) or the whole platform (Super Admin) — `filters.campId` can
 * only narrow.
 */
export function listDisplacedPage(filters, pagination) {
  return fetchDisplacedPage(requireClient(), filters, pagination);
}

export async function countDisplaced(filters) {
  return (await fetchDisplacedPage(requireClient(), filters, { pageSize: 0 })).total;
}

/** The complete filtered set, batched — the Excel export path only. */
export function listAllDisplaced(filters) {
  return fetchAllDisplaced(requireClient(), filters);
}

/**
 * Whether a login account is linked to this person (`profiles.family_member_id`).
 * Their email is then the account's login email, which only the account owner's
 * auth flow can change — so the file's email field is locked for them. RLS lets
 * a Camp Admin read their own camp's profiles.
 */
export async function hasLinkedAccount(memberId) {
  const client = requireClient();
  const row = await run(client.from('profiles').select('id').eq('family_member_id', memberId).limit(1).maybeSingle());
  return Boolean(row);
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

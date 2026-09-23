// assets/js/supabase/organizations.js
import { requireClient } from '../core/supabase-client.js';
import { run, mapError, DataAccessError, ErrorType } from './errors.js';
import { paginate, sort } from './query.js';

const SORT_COLUMNS = ['name', 'created_at'];

export async function listOrganizations({ search, page, pageSize, sortBy, sortDir } = {}) {
  const client = requireClient();
  let query = client.from('organizations').select('*', { count: 'exact' });
  if (search) query = query.ilike('name', `%${search}%`);
  query = sort(query, { sortBy, sortDir }, SORT_COLUMNS, 'name');
  query = paginate(query, { page, pageSize });
  const { data, error, count } = await query;
  if (error) throw mapError(error);
  return { rows: data, total: count };
}

/**
 * `{value, label}` options for the real Camp Admin aid donor dropdown
 * (Phase 4.6). Unpaginated — organisations are a small, platform-wide list
 * (not camp-scoped), and `listOrganizations()`'s default page size would
 * silently truncate it. `value` is the organisation's UUID; the mock
 * `select.organizationOptions()` this replaces uses ids like `'org-1'` that
 * never match a real row.
 */
export async function listOrganizationOptions() {
  const client = requireClient();
  const rows = await run(client.from('organizations').select('id, name').order('name', { ascending: true }));
  return rows.map((org) => ({ value: org.id, label: org.name }));
}

export async function getOrganization(id) {
  const client = requireClient();
  return run(client.from('organizations').select('*').eq('id', id).single());
}

/** Phone stays optional (domain rule 11) — never marked required here or in a schema. */
export async function createOrganization({ name, responsiblePerson, phone }) {
  const client = requireClient();
  return run(
    client.from('organizations').insert({ name, responsible_person: responsiblePerson, phone }).select().single()
  );
}

export async function updateOrganization(id, patch) {
  const client = requireClient();
  const allowed = ['name', 'responsible_person', 'phone'];
  const body = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)));
  return run(client.from('organizations').update(body).eq('id', id).select().single());
}

export async function deleteOrganization(id) {
  const client = requireClient();
  await run(client.from('organizations').delete().eq('id', id).select().maybeSingle());
}

const ORG_SELECT = '*, aid_distributions(id, aid_distribution_families(family_id))';

/**
 * DB row (with the aid_distributions/aid_distribution_families embed —
 * both real FKs, so PostgREST embeds them directly, same reason aids.js's
 * embeds already work without the family_stats-style separate-query
 * workaround) -> the exact shape resultsView()/summaryView() in
 * organizations.js already read.
 *
 * aidCount/familiesCount are RLS-scoped through the embed, not
 * platform-wide: a camp_admin's aid_distributions child rows are already
 * own-camp-scoped by that table's own RLS, so a donor used in more than
 * one camp shows a smaller count to a Camp Admin than to a Super Admin.
 * This is the correct, intended behavior (Phase 4.9 spec §4), not a bug.
 */
function mapOrganizationRow(row) {
  const distributions = row.aid_distributions || [];
  const familyIds = new Set();
  distributions.forEach((d) => (d.aid_distribution_families || []).forEach((f) => familyIds.add(f.family_id)));
  return {
    id: row.id,
    name: row.name,
    phone: row.phone || '',
    responsiblePerson: row.responsible_person || '',
    createdAt: row.created_at,
    aidCount: distributions.length,
    familiesCount: familyIds.size,
  };
}

/**
 * Every donor, unpaginated — donors are a small, platform-wide list, same
 * "fetch all" convention listOrganizationOptions() already established.
 */
export async function listOrganizationsWithUsage() {
  const client = requireClient();
  const rows = await run(
    client.from('organizations').select(ORG_SELECT).order('name', { ascending: true })
  );
  return rows.map(mapOrganizationRow);
}

/** Same pattern as family-members.js's isDuplicateNationalId(). */
export function isDuplicateOrganizationName(error) {
  return error instanceof DataAccessError && error.type === ErrorType.DUPLICATE;
}

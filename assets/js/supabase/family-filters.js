// assets/js/supabase/family-filters.js
// Pure query-building for the `family_overview` view (Phase 4.24). No client
// import, so it can be exercised in Node against a real PostgREST builder.
import { FAMILY_SIZES } from '../core/config.js';
import { matchesFamilyFilters } from '../core/selectors.js';

export const FAMILY_OVERVIEW_COLUMNS =
  'family_id, reference_code, camp_id, camp_name, head_name, head_tent_type, notes, created_at, ' +
  'members_count, children_under_18, children_under_3, children_under_2, children_under_1, ' +
  'orphans, chronic, disability, pregnant, breastfeeding, aid_count';

/** filter key -> `family_overview` count column; each means "at least one member". */
const FLAG_COLUMNS = {
  hasChildren: 'children_under_18',
  hasUnder3: 'children_under_3',
  hasUnder2: 'children_under_2',
  hasUnder1: 'children_under_1',
  hasOrphan: 'orphans',
  hasChronic: 'chronic',
  hasBreastfeeding: 'breastfeeding',
  hasPregnant: 'pregnant',
};

/**
 * Characters whose meaning differs between the legacy JS substring test and a
 * PostgREST `ilike` (LIKE wildcards/escape, PostgREST's `*` alias, the `or()`
 * quote, and the "—" placeholder shown for a family with no head). A term
 * containing any of them is not sent to the server; `refineFamilyRows` applies
 * the legacy predicate instead, so results stay exactly equivalent.
 */
const CLIENT_SEARCH_ONLY = /[%_\\*"—]/;

const clientSearchTerm = (filters) => {
  const term = (filters.query || '').trim();
  return term && CLIENT_SEARCH_ONLY.test(term) ? term : '';
};

/**
 * Adds every migrated family filter to a `family_overview` query builder.
 * Filtering here only narrows; RLS is what scopes the rows.
 */
export function applyFamilyFilters(query, filters = {}) {
  let q = query;
  if (filters.campId) q = q.eq('camp_id', filters.campId);

  const bucket = FAMILY_SIZES.find((entry) => entry.value === filters.size);
  if (bucket) {
    q = q.gte('members_count', bucket.min);
    if (bucket.max !== null) q = q.lte('members_count', bucket.max);
  }

  for (const [key, column] of Object.entries(FLAG_COLUMNS)) {
    const value = filters[key];
    if (!value) continue;
    q = value === 'yes' ? q.gt(column, 0) : q.eq(column, 0);
  }

  const term = (filters.query || '').trim();
  if (term && !clientSearchTerm(filters)) {
    const quoted = `"%${term}%"`;
    q = q.or(`reference_code.ilike.${quoted},head_name.ilike.${quoted},notes.ilike.${quoted}`);
  }
  return q;
}

/** Only terms `applyFamilyFilters` could not express are re-checked, with the legacy predicate. */
export function refineFamilyRows(rows, filters = {}) {
  const term = clientSearchTerm(filters);
  return term ? rows.filter((row) => matchesFamilyFilters(row, { query: term })) : rows;
}

/** `family_overview` row -> the shape `resultsView()` / `familyExportRow()` already read. */
export function mapFamilyOverviewRow(row) {
  return {
    id: row.reference_code,
    campId: row.camp_id,
    campName: row.camp_name || '—',
    headName: row.head_name || '—',
    headTentType: row.head_tent_type || '',
    notes: row.notes || '',
    membersCount: Number(row.members_count) || 0,
    childrenUnder18: Number(row.children_under_18) || 0,
    childrenUnder3: Number(row.children_under_3) || 0,
    childrenUnder2: Number(row.children_under_2) || 0,
    childrenUnder1: Number(row.children_under_1) || 0,
    orphans: Number(row.orphans) || 0,
    chronic: Number(row.chronic) || 0,
    disability: Number(row.disability) || 0,
    pregnant: Number(row.pregnant) || 0,
    breastfeeding: Number(row.breastfeeding) || 0,
    aidCount: Number(row.aid_count) || 0,
    createdAt: row.created_at,
  };
}

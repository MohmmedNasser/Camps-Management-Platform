// assets/js/supabase/family-members.js
import { requireClient } from '../core/supabase-client.js';
import { run, mapError, DataAccessError, ErrorType } from './errors.js';
import { paginate, sort } from './query.js';

const SORT_COLUMNS = ['created_at', 'full_name', 'birth_date'];

export async function listFamilyMembers(familyId, { page, pageSize, sortBy, sortDir } = {}) {
  const client = requireClient();
  let query = client
    .from('family_members')
    .select(
      '*, family_member_facts(age_years, is_child, under_1, under_2, under_3, is_orphan, has_chronic, has_disability, is_pregnant, is_breastfeeding, maternity_applies)',
      { count: 'exact' }
    )
    .eq('family_id', familyId);
  query = sort(query, { sortBy, sortDir }, SORT_COLUMNS, 'created_at');
  query = paginate(query, { page, pageSize });
  const { data, error, count } = await query;
  if (error) throw mapError(error);
  return { rows: data, total: count };
}

export async function getFamilyMember(id) {
  const client = requireClient();
  return run(client.from('family_members').select('*, family_member_facts(*)').eq('id', id).single());
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

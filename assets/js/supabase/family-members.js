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

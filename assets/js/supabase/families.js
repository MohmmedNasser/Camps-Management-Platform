// assets/js/supabase/families.js
import { requireClient } from '../core/supabase-client.js';
import { run, mapError } from './errors.js';
import { paginate, sort } from './query.js';

const SORT_COLUMNS = ['created_at', 'reference_code', 'updated_at'];

/**
 * `family_stats` is a GROUP BY view, so PostgREST cannot auto-detect a
 * foreign-key relationship to embed it under `families` the way a real
 * child table would (`PGRST200`, confirmed against the live schema cache).
 * Query it separately, keyed by `family_id`, and merge here instead.
 */
async function attachFamilyStats(client, families) {
  const ids = families.map((f) => f.id);
  if (!ids.length) return families;
  const stats = await run(client.from('family_stats').select('*').in('family_id', ids));
  const byFamily = new Map(stats.map((s) => [s.family_id, s]));
  return families.map((f) => ({ ...f, family_stats: byFamily.get(f.id) ?? null }));
}

/**
 * `filters.search` matches `reference_code` by prefix (`FAM-000001` shape),
 * matching the pattern_ops index rather than a full scan.
 */
export async function listFamilies(filters = {}, { page, pageSize, sortBy, sortDir } = {}) {
  const client = requireClient();
  let query = client
    .from('families')
    .select('id, reference_code, camp_id, head_member_id, notes, created_at', { count: 'exact' });

  if (filters.campId) query = query.eq('camp_id', filters.campId);
  if (filters.search) query = query.ilike('reference_code', `${filters.search}%`);

  query = sort(query, { sortBy, sortDir }, SORT_COLUMNS, 'created_at');
  query = paginate(query, { page, pageSize });

  const { data, error, count } = await query;
  if (error) throw mapError(error);
  return { rows: await attachFamilyStats(client, data), total: count };
}

export async function getFamily(id) {
  const client = requireClient();
  const family = await run(client.from('families').select('*, family_members(*)').eq('id', id).single());
  const stats = await run(client.from('family_stats').select('*').eq('family_id', id).maybeSingle());
  return { ...family, family_stats: stats };
}

/** The one-form family+members create (spec §7 / domain rule 13). */
export async function createFamilyWithMembers({ campId, head, members = [], notes = '' }) {
  const client = requireClient();
  return run(
    client.rpc('create_family_with_members', {
      p_camp_id: campId,
      p_head: head,
      p_members: members,
      p_notes: notes,
    })
  );
}

export async function updateFamily(id, patch) {
  const client = requireClient();
  const allowed = ['notes', 'head_member_id'];
  const body = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)));
  return run(client.from('families').update(body).eq('id', id).select().single());
}

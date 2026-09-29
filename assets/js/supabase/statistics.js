// assets/js/supabase/statistics.js
import { requireClient } from '../core/supabase-client.js';
import { run, mapError } from './errors.js';

export async function getFamilyStatistics(campId = null) {
  const client = requireClient();
  const rows = await run(client.rpc('get_family_statistics', { p_camp_id: campId }));
  return rows?.[0] ?? null;
}

export async function getDashboardStatistics(campId = null) {
  const client = requireClient();
  return run(client.rpc('get_dashboard_statistics', { p_camp_id: campId }));
}

/** Real equivalent of the mock's `store.documents.list(inScope).length` —
 *  get_dashboard_statistics() has no documents figure, so this is a plain
 *  count query; RLS (documents_select_scoped) is the actual scoping
 *  boundary regardless of campId. */
export async function getDocumentCount(campId = null) {
  const client = requireClient();
  let query = client.from('documents').select('id', { count: 'exact' });
  if (campId) query = query.eq('camp_id', campId);
  const { count, error } = await query;
  if (error) throw mapError(error);
  return count || 0;
}

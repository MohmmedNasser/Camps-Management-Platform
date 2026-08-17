// assets/js/supabase/statistics.js
import { requireClient } from '../core/supabase-client.js';
import { run } from './errors.js';

export async function getFamilyStatistics(campId = null) {
  const client = requireClient();
  const rows = await run(client.rpc('get_family_statistics', { p_camp_id: campId }));
  return rows?.[0] ?? null;
}

export async function getDashboardStatistics(campId = null) {
  const client = requireClient();
  return run(client.rpc('get_dashboard_statistics', { p_camp_id: campId }));
}

// assets/js/supabase/statistics.js
import { requireClient } from '../core/supabase-client.js';
import { run, mapError } from './errors.js';
import { shapeStatisticsReport } from './statistics-report.js';

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

/**
 * Every statistics.html figure except the per-camp table, aggregated in the
 * database (`get_statistics_report`, SECURITY INVOKER — RLS scopes the data).
 * The browser's IANA zone is passed so month buckets match its own calendar;
 * an unrecognised zone falls back to UTC rather than failing the page.
 */
export async function getStatisticsReport() {
  const client = requireClient();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  let { data, error } = await client.rpc('get_statistics_report', { p_tz: zone });
  if (error && zone !== 'UTC') ({ data, error } = await client.rpc('get_statistics_report', { p_tz: 'UTC' }));
  if (error) throw mapError(error);
  return shapeStatisticsReport(data);
}

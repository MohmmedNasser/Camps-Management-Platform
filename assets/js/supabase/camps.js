// assets/js/supabase/camps.js
import { requireClient } from '../core/supabase-client.js';
import { run, DataAccessError, ErrorType } from './errors.js';
import { sort } from './query.js';
import { getDashboardStatistics } from './statistics.js';
import { listProfiles } from './profiles.js';

const SORT_COLUMNS = ['name', 'created_at'];

export async function listCamps({ status, sortBy, sortDir } = {}) {
  const client = requireClient();
  let query = client.from('camps').select('*');
  if (status) query = query.eq('status', status);
  query = sort(query, { sortBy, sortDir }, SORT_COLUMNS, 'name');
  return run(query);
}

export async function getCamp(id) {
  const client = requireClient();
  return run(client.from('camps').select('*').eq('id', id).single());
}

export async function createCamp({ name, governorate, city }) {
  const client = requireClient();
  return run(client.from('camps').insert({ name, governorate, city }).select().single());
}

export async function updateCamp(id, patch) {
  const client = requireClient();
  const allowed = ['name', 'governorate', 'city'];
  const body = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)));
  return run(client.from('camps').update(body).eq('id', id).select().single());
}

export async function setCampStatus(id, status) {
  const client = requireClient();
  return run(client.from('camps').update({ status }).eq('id', id).select().single());
}

export async function deleteCamp(id) {
  const client = requireClient();
  await run(client.from('camps').delete().eq('id', id).select().maybeSingle());
}

/** camps_name_key is a unique functional index on lower(btrim(name)); a
 *  duplicate insert/update surfaces as 23505, mapped to ErrorType.DUPLICATE
 *  by errors.js. Same pattern as organizations.js's isDuplicateOrganizationName(). */
export function isDuplicateCampName(error) {
  return error instanceof DataAccessError && error.type === ErrorType.DUPLICATE;
}

/** {value,label} options for selects — same label shape the mock
 *  select.campOptions() used (`${name} — ${city}`). */
export async function listCampOptions() {
  const rows = await listCamps({});
  return rows.map((camp) => ({ value: camp.id, label: `${camp.name} — ${camp.city}` }));
}

/**
 * Per-camp breakdown for camps.html and camp-admins.html's summary —
 * moved here from dashboard.js's private buildCampBreakdown() (Phase 4.2)
 * so both pages share one implementation instead of two. One
 * get_dashboard_statistics(camp.id) + one admins-count call per camp, all
 * camps run concurrently.
 */
export async function listCampsWithStats({ status } = {}) {
  const camps = await listCamps({ status });
  return Promise.all(
    camps.map(async (camp) => {
      const [stats, admins] = await Promise.all([
        getDashboardStatistics(camp.id),
        listProfiles({ role: 'camp_admin', campId: camp.id, pageSize: 1 }),
      ]);
      return {
        id: camp.id,
        name: camp.name,
        city: camp.city,
        governorate: camp.governorate,
        status: camp.status,
        createdAt: camp.created_at,
        displacedCount: Number(stats?.total_members) || 0,
        familiesCount: Number(stats?.total_families) || 0,
        aidCount: Number(stats?.aid_distributions) || 0,
        adminsCount: admins.total,
        disabilityCount: Number(stats?.disability) || 0,
        childrenCount: Number(stats?.children_under_18) || 0,
        orphansCount: Number(stats?.orphans) || 0,
      };
    })
  );
}

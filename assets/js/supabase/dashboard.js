// assets/js/supabase/dashboard.js
/**
 * Super Admin dashboard composition (Phase 4.2). Reuses
 * get_dashboard_statistics(), family_stats, listCamps() and
 * listProfiles() — these functions cover only what those genuinely don't
 * answer: gender split, distinct donor-organization count, monthly
 * registration buckets and family-size buckets.
 */

import { requireClient } from '../core/supabase-client.js';
import { run } from './errors.js';
import { getDashboardStatistics } from './statistics.js';
import { listCamps } from './camps.js';
import { listProfiles } from './profiles.js';

function familySizeBuckets() {
  return [
    { label: '1–2 أفراد', min: 1, max: 2, count: 0 },
    { label: '3–4 أفراد', min: 3, max: 4, count: 0 },
    { label: '5–6 أفراد', min: 5, max: 6, count: 0 },
    { label: '7 فأكثر', min: 7, max: Infinity, count: 0 },
  ];
}

/** Gender split over family_members, optionally scoped to one camp. */
export async function getGenderBreakdown(campId = null) {
  const client = requireClient();
  let query = client.from('family_members').select('gender');
  if (campId) query = query.eq('camp_id', campId);
  const rows = await run(query);
  return rows.reduce(
    (acc, row) => {
      if (row.gender === 'male') acc.males += 1;
      else if (row.gender === 'female') acc.females += 1;
      return acc;
    },
    { males: 0, females: 0 }
  );
}

/**
 * Distinct organizations that actually appear in aid_distributions —
 * never all registered organizations. PostgREST has no COUNT(DISTINCT …)
 * shorthand, so this dedupes client-side over the one relevant column.
 */
export async function getDonorOrganizationsCount(campId = null) {
  const client = requireClient();
  let query = client.from('aid_distributions').select('organization_id');
  if (campId) query = query.eq('camp_id', campId);
  const rows = await run(query);
  return new Set(rows.map((row) => row.organization_id)).size;
}

/**
 * Registrations per month for the last `months` months, bucketed by
 * family_members.created_at — when a displaced person's record was
 * created, the same registration semantics the mock dashboard used. Same
 * bucket shape: { date, key, value }.
 */
export async function getMonthlyRegistrations(campId = null, months = 8) {
  const client = requireClient();
  const now = new Date();
  const buckets = [];
  for (let i = months - 1; i >= 0; i -= 1) {
    const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
    buckets.push({ date, key: `${date.getFullYear()}-${date.getMonth()}`, value: 0 });
  }
  const index = new Map(buckets.map((bucket) => [bucket.key, bucket]));

  const rangeStart = buckets[0].date.toISOString();
  let query = client.from('family_members').select('created_at').gte('created_at', rangeStart);
  if (campId) query = query.eq('camp_id', campId);
  const rows = await run(query);

  rows.forEach((row) => {
    const created = new Date(row.created_at);
    if (Number.isNaN(created.getTime())) return;
    const bucket = index.get(`${created.getFullYear()}-${created.getMonth()}`);
    if (bucket) bucket.value += 1;
  });
  return buckets;
}

/** Family-size distribution via family_stats.members_count. */
export async function getFamilySizeDistribution(campId = null) {
  const client = requireClient();
  let query = client.from('family_stats').select('members_count');
  if (campId) query = query.eq('camp_id', campId);
  const rows = await run(query);

  const buckets = familySizeBuckets();
  rows.forEach((row) => {
    const size = row.members_count;
    const bucket = buckets.find((entry) => size >= entry.min && size <= entry.max);
    if (bucket) bucket.count += 1;
  });
  return buckets;
}

/**
 * Per-camp breakdown for the "المخيمات" list and campComparisonBar() —
 * one get_dashboard_statistics(camp.id) call and one admins-count call
 * per camp, all camps run concurrently.
 */
async function buildCampBreakdown(camps) {
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

/**
 * The full Super Admin dashboard composition: { stats, byMonth,
 * familySizes, camps } — the exact shape assets/js/pages/dashboard.js's
 * collect() already builds for every other role, now from real data
 * instead of core/store.js.
 */
export async function getSuperAdminDashboard() {
  const camps = await listCamps({});

  const [globalStats, campAdmins, gender, donors, byMonth, familySizes, campRows] =
    await Promise.all([
      getDashboardStatistics(null),
      listProfiles({ role: 'camp_admin', pageSize: 1 }),
      getGenderBreakdown(null),
      getDonorOrganizationsCount(null),
      getMonthlyRegistrations(null, 8),
      getFamilySizeDistribution(null),
      buildCampBreakdown(camps),
    ]);

  return {
    stats: {
      camps: camps.length,
      campAdmins: campAdmins.total,
      displaced: Number(globalStats?.total_members) || 0,
      families: Number(globalStats?.total_families) || 0,
      children: Number(globalStats?.children_under_18) || 0,
      orphans: Number(globalStats?.orphans) || 0,
      aid: Number(globalStats?.aid_distributions) || 0,
      donors,
      disability: Number(globalStats?.disability) || 0,
      chronic: Number(globalStats?.chronic) || 0,
      males: gender.males,
      females: gender.females,
      requests: Number(globalStats?.pending_requests) || 0,
    },
    byMonth,
    familySizes,
    camps: campRows,
  };
}

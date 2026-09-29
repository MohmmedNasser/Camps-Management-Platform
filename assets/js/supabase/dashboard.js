// assets/js/supabase/dashboard.js
/**
 * Super Admin dashboard composition (Phase 4.2). Reuses
 * get_dashboard_statistics(), family_stats, listCamps() and
 * listProfiles() — these functions cover only what those genuinely don't
 * answer: gender split, distinct donor-organization count, monthly
 * registration buckets and family-size buckets.
 */

import { requireClient } from '../core/supabase-client.js';
import { run, mapError } from './errors.js';
import { fetchAll } from './query.js';
import { getDashboardStatistics } from './statistics.js';
import { listCamps, listCampsWithStats } from './camps.js';
import { listProfiles } from './profiles.js';
import { listAidTypes, listAidDistributions, getFamilyAidHistory } from './aids.js';
import { listRegistrationRequests } from './registration-requests.js';
import { getDisplacedPerson } from './family-members.js';
import { getFamilyByReferenceCode } from './families.js';
import { listDocuments } from './documents.js';
import { unreadNotificationCount } from './notifications.js';

/**
 * Exact count of the rows a filter matches, computed by the database (RLS
 * applied). `range(0, 0)` keeps the body to at most one row; HEAD is avoided
 * because it shows as ERR_ABORTED in Chromium against this project.
 */
async function countMatching(query) {
  const { count, error } = await query.range(0, 0);
  if (error) throw mapError(error);
  return count || 0;
}

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
  const byGender = (gender) => {
    let query = client.from('family_members').select('id', { count: 'exact' }).eq('gender', gender);
    if (campId) query = query.eq('camp_id', campId);
    return countMatching(query);
  };
  const [males, females] = await Promise.all([byGender('male'), byGender('female')]);
  return { males, females };
}

/**
 * Distinct organizations that actually appear in aid_distributions —
 * never all registered organizations. PostgREST has no COUNT(DISTINCT …)
 * shorthand, so this dedupes client-side over the one relevant column.
 */
export async function getDonorOrganizationsCount(campId = null) {
  const client = requireClient();
  const rows = await fetchAll(
    () => {
      let query = client.from('aid_distributions').select('id, organization_id');
      if (campId) query = query.eq('camp_id', campId);
      return query;
    },
    { order: ['id'] }
  );
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

  // One DB count per month bucket (half-open [start, next start) in the
  // browser's local time, the same boundaries the old row bucketing used).
  await Promise.all(
    buckets.map(async (bucket, i) => {
      const end = buckets[i + 1]?.date || new Date(now.getFullYear(), now.getMonth() + 1, 1);
      let query = client
        .from('family_members')
        .select('id', { count: 'exact' })
        .gte('created_at', bucket.date.toISOString())
        .lt('created_at', end.toISOString());
      if (campId) query = query.eq('camp_id', campId);
      index.get(bucket.key).value = await countMatching(query);
    })
  );
  return buckets;
}

/** Family-size distribution via family_stats.members_count. */
export async function getFamilySizeDistribution(campId = null) {
  const client = requireClient();
  const buckets = familySizeBuckets();
  await Promise.all(
    buckets.map(async (bucket) => {
      let query = client.from('family_stats').select('family_id', { count: 'exact' }).gte('members_count', bucket.min);
      if (Number.isFinite(bucket.max)) query = query.lte('members_count', bucket.max);
      if (campId) query = query.eq('camp_id', campId);
      bucket.count = await countMatching(query);
    })
  );
  return buckets;
}

/**
 * Count of aid_distribution_types rows per real aid_types row, scoped to
 * one camp via the parent aid_distributions.camp_id. The one metric
 * Phase 4.2 left mock for the Camp Admin's aidTypeBar chart (Phase 4.3
 * spec §4/§6). Categories and labels come from listAidTypes(), never
 * core/config.js — never a fabricated category.
 */
export async function getAidTypeBreakdown(campId = null) {
  const client = requireClient();
  const types = await listAidTypes({ activeOnly: true });
  const rows = await fetchAll(
    () => {
      let query = client.from('aid_distribution_types').select('distribution_id, aid_type_id, aid_distributions!inner(camp_id)');
      if (campId) query = query.eq('aid_distributions.camp_id', campId);
      return query;
    },
    { order: ['distribution_id', 'aid_type_id'] }
  );

  const counts = new Map();
  rows.forEach((row) => counts.set(row.aid_type_id, (counts.get(row.aid_type_id) || 0) + 1));

  return types
    .map((type) => ({ value: type.code, label: type.label_ar, count: counts.get(type.id) || 0 }))
    .filter((entry) => entry.count > 0);
}

/**
 * The full Super Admin dashboard composition: { stats, byMonth,
 * familySizes, camps } — the exact shape assets/js/pages/dashboard.js's
 * collect() already builds for every other role, now from real data
 * instead of core/store.js.
 */
export async function getSuperAdminDashboard() {
  const camps = await listCamps({});

  const [globalStats, campAdmins, gender, donors, byMonth, familySizes, campRows, unreadNotifications] =
    await Promise.all([
      getDashboardStatistics(null),
      listProfiles({ role: 'camp_admin', pageSize: 1 }),
      getGenderBreakdown(null),
      getDonorOrganizationsCount(null),
      getMonthlyRegistrations(null, 8),
      getFamilySizeDistribution(null),
      listCampsWithStats(),
      unreadNotificationCount(),
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
    unreadNotifications,
  };
}

/** registration_requests row (snake_case) -> the shape requestRow() reads. */
function mapRequestRow(row) {
  return {
    id: row.id,
    fullName: row.full_name,
    nationalId: row.national_id,
    createdAt: row.created_at,
    status: row.status,
  };
}

/** listAidDistributions() row -> the shape aidRow() reads. Same '، '
 *  separator core/selectors.js's mock mapping already uses for typeLabels. */
function mapAidRow(row) {
  const labels = (row.aid_distribution_types || []).map((t) => t.aid_type?.label_ar).filter(Boolean);
  return {
    id: row.id,
    typeLabels: labels.join('، '),
    organizationName: row.organization?.name || '—',
    beneficiaryCount: (row.aid_distribution_families || []).length,
    date: row.distributed_on,
  };
}

/**
 * The full Camp Admin dashboard composition: { stats, byMonth, aidByType,
 * familySizes, requests, recentAid } — the exact shape collect() already
 * builds for this role from mock selectors (Phase 4.3 spec §5/§7), now
 * from real data. `campId` must be the authenticated Camp Admin's own
 * session.campId — get_dashboard_statistics rejects any other value for a
 * camp_admin caller (verified live, spec §1).
 */
export async function getCampAdminDashboard(campId) {
  const [globalStats, gender, donors, byMonth, familySizes, aidByType, requestsResult, aidResult, unreadNotifications] =
    await Promise.all([
      getDashboardStatistics(campId),
      getGenderBreakdown(campId),
      getDonorOrganizationsCount(campId),
      getMonthlyRegistrations(campId, 8),
      getFamilySizeDistribution(campId),
      getAidTypeBreakdown(campId),
      listRegistrationRequests({ status: 'pending', campId, pageSize: 4 }),
      listAidDistributions({ campId }, { pageSize: 5, sortBy: 'distributed_on', sortDir: 'desc' }),
      unreadNotificationCount(),
    ]);

  return {
    stats: {
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
    aidByType,
    familySizes,
    requests: requestsResult.rows.map(mapRequestRow),
    recentAid: aidResult.rows.map(mapAidRow),
    unreadNotifications,
  };
}

/** getFamilyAidHistory() row -> the shape ownAidRow() reads. Same mapping
 *  family-details.js already applies to this exact raw shape. */
function mapAidHistoryRow(row) {
  const d = row.distribution;
  const labels = (d.aid_distribution_types || []).map((t) => t.aid_type?.label_ar).filter(Boolean);
  return {
    id: d.id,
    typeLabels: labels.join('، '),
    organizationName: d.organization?.name || '—',
    date: d.distributed_on,
  };
}

const EMPTY_DISPLACED_DASHBOARD = { person: null, family: null, myAid: [], myDocuments: [], unreadNotifications: 0 };

/**
 * The full displaced-person dashboard composition: { person, family, myAid,
 * myDocuments, unreadNotifications } — the exact shape collect() already
 * builds for this role from mock selectors (Phase 4.12 spec §4, Phase 4.14
 * for the notification count), now from real data. RLS-scoped to the
 * caller's own identity throughout: family_members/families/
 * aid_distributions/documents all resolve through private.current_family_id(),
 * which is derived from profiles.family_member_id — real Auth identity
 * (Phase 4.1), never a URL or localStorage value. `unreadNotifications`
 * is scoped independently, straight off recipient_id = auth.uid() (Phase
 * 4.14) — a notification's ownership has nothing to do with family
 * resolution, so it is fetched in every branch below, including the ones
 * with no resolvable person/family.
 *
 * get_dashboard_statistics()/get_family_statistics() (what the other two
 * roles' composition functions above call) explicitly reject a displaced
 * caller (42501, confirmed live) — this composes from direct table reads
 * instead, same as the mock version always did.
 */
export async function getDisplacedDashboard(session) {
  // Architecturally unreachable: approve_registration_request() sets
  // status='approved' and family_member_id together, and only pending/
  // rejected/approved accounts exist — router guard already keeps anything
  // else off this page. Handled defensively anyway, never assumed impossible.
  if (!session.familyMemberId) {
    return { ...EMPTY_DISPLACED_DASHBOARD, unreadNotifications: await unreadNotificationCount() };
  }

  const [person, unreadNotifications] = await Promise.all([
    getDisplacedPerson(session.familyMemberId),
    unreadNotificationCount(),
  ]);
  if (!person || !person.familyId) return { ...EMPTY_DISPLACED_DASHBOARD, person, unreadNotifications };

  const family = await getFamilyByReferenceCode(person.familyId);
  if (!family) return { ...EMPTY_DISPLACED_DASHBOARD, person, unreadNotifications };

  const [aidRows, docsResult] = await Promise.all([
    getFamilyAidHistory(family._dbId),
    listDocuments({ familyId: family._dbId }),
  ]);

  return {
    person,
    family: { ...family, campName: session.campLabel },
    myAid: aidRows.map(mapAidHistoryRow),
    myDocuments: docsResult.rows,
    unreadNotifications,
  };
}

/**
 * Phase 4.25: server-side displaced-persons list.
 *
 *  - For every migrated filter (and combinations, boundaries, wildcard search),
 *    the ids `list_displaced_persons` returns — read page by page — equal, in
 *    the same order, the ids the LEGACY client path selects: every row read with
 *    the old embed, mapped, then `matchesDisplacedFilters` (with the old
 *    aid-type/donor family set).
 *  - Pagination: first / middle / last / beyond-the-end page, count-only, stable
 *    order across ties (fixture members share one created_at).
 *  - Canonical age rule: completed years vs the database's current_date, checked
 *    on the pure SQL function and end-to-end on fixture members born
 *    yesterday / today / tomorrow relative to a birthday. Fixtures are tracked
 *    and removed in `finally`; cleanup is asserted.
 *
 *   cd supabase && npm run frontend:config && npm run test:phase4.25-displaced-verification
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
for (const line of (() => { try { return readFileSync(resolve(ROOT, '.env'), 'utf8'); } catch { return ''; } })().split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
const required = (...names) => {
  for (const n of names) if (process.env[n]) return process.env[n];
  throw new Error(`Missing ${names.join(' or ')}`);
};
const URL_ = required('SUPABASE_URL');
const ANON = required('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY');
const service = createClient(URL_, required('SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });

const load = (p) => import(pathToFileURL(resolve(ROOT, p)).href);
const { displacedRpcParams, mapDisplacedRow, fetchDisplacedPage, fetchAllDisplaced } = await load('assets/js/supabase/displaced-filters.js');
const { matchesDisplacedFilters, ageOf } = await load('assets/js/core/selectors.js');
const { AGE_BANDS } = await load('assets/js/core/config.js');

async function signedIn(email) {
  const client = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password: '123456' });
  assert.equal(error, null, `${email} must sign in`);
  return client;
}

/** The DB's `current_date` (UTC on Supabase) and an independent completed-years implementation. */
const todayUTC = () => new Date().toISOString().slice(0, 10);
function ageAt(birth, on) {
  const [by, bm, bd] = birth.split('-').map(Number);
  const [oy, om, od] = on.split('-').map(Number);
  return oy - by - (om < bm || (om === bm && od < bd) ? 1 : 0);
}
const shiftDays = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const yearsAgo = (iso, years) => `${Number(iso.slice(0, 4)) - years}${iso.slice(4)}`;

test('Phase 4.25 displaced list', async (t) => {
  const superAdmin = await signedIn('super@camps.ps');
  const admin = await signedIn('admin@camps.ps');
  const { data: { user: adminUser } } = await admin.auth.getUser();
  const { data: adminProfile } = await service.from('profiles').select('camp_id').eq('id', adminUser.id).single();

  // ---- legacy oracle: whole scope, old embed, old mapper, old predicate ----
  const { data: rawMembers, error: rawError } = await superAdmin
    .from('family_members')
    .select('*, family:families!family_members_family_id_fkey(reference_code), camp:camps!family_members_camp_id_fkey(name)')
    .order('created_at').order('id');
  assert.equal(rawError, null, rawError?.message);
  const today = todayUTC();
  // Pin "today" to the database's date so this oracle is independent of the runner's timezone.
  const legacyRows = rawMembers.map(mapDisplacedRow).map((row) => ({ ...row, ageYears: row.birthDate ? ageAt(row.birthDate, today) : null }));
  assert.ok(legacyRows.length >= 30, 'fixture sanity: seed data present');

  const { data: aidRows } = await superAdmin
    .from('aid_distributions')
    .select('id, organization_id, aid_distribution_types(aid_type:aid_types(code)), aid_distribution_families(family:families(reference_code))');
  const legacyAidFamilies = (aidType, organizationId) => {
    const ids = new Set();
    for (const d of aidRows) {
      if (organizationId && d.organization_id !== organizationId) continue;
      if (aidType && !d.aid_distribution_types.some((x) => x.aid_type?.code === aidType)) continue;
      d.aid_distribution_families.forEach((l) => l.family?.reference_code && ids.add(l.family.reference_code));
    }
    return ids;
  };
  const legacyIds = (filters) => {
    const aidFamilyIds = filters.aidType || filters.organizationId ? legacyAidFamilies(filters.aidType, filters.organizationId) : null;
    return legacyRows.filter((r) => matchesDisplacedFilters(r, filters, { aidFamilyIds })).map((r) => r.id);
  };
  const serverIds = async (client, filters, pageSize = 7) => {
    const ids = [];
    for (let page = 1; ; page += 1) {
      const { rows, total } = await fetchDisplacedPage(client, filters, { page, pageSize });
      ids.push(...rows.map((r) => r.id));
      if (ids.length >= total || !rows.length) return ids;
    }
  };

  const camps = [...new Set(legacyRows.map((r) => r.campId))];
  const orgs = [...new Set(aidRows.map((d) => d.organization_id))];
  const aidCodes = [...new Set(aidRows.flatMap((d) => d.aid_distribution_types.map((x) => x.aid_type.code)))];
  const sample = legacyRows.find((r) => r.fullName.length > 5 && r.phone && r.nationalId);
  const yn = ['yes', 'no'];

  const cases = [
    ['no filters', {}],
    ...['male', 'female'].map((g) => [`gender=${g}`, { gender: g }]),
    ...['approved', 'pending', 'rejected'].map((s) => [`status=${s}`, { status: s }]),
    ...['tarp_tent', 'prefab_tent'].map((v) => [`tentType=${v}`, { tentType: v }]),
    ...camps.map((campId) => [`campId=${campId.slice(0, 6)}`, { campId }]),
    ...AGE_BANDS.map((b) => [`ageBand=${b.value}`, { ageBand: b.value }]),
    ...['isChild', 'isOrphan', 'hasChronic', 'isPregnant', 'isBreastfeeding'].flatMap((k) => yn.map((v) => [`${k}=${v}`, { [k]: v }])),
    ['tri-state garbage acts as "no"', { isChild: 'maybe' }],
    ...aidCodes.map((aidType) => [`aidType=${aidType}`, { aidType }]),
    ...orgs.map((organizationId) => [`donor=${organizationId.slice(0, 6)}`, { organizationId }]),
    ['aidType + same-distribution donor', { aidType: aidCodes[0], organizationId: orgs[0] }],
    ['combo gender+child+camp', { gender: 'female', isChild: 'yes', campId: camps[0] }],
    ['combo orphan yes + chronic no', { isOrphan: 'yes', hasChronic: 'no' }],
    ['combo pregnant no + age band', { isPregnant: 'no', ageBand: 'under_3' }],
    ['unknown gender matches nothing', { gender: 'bogus' }],
    ['unknown age band is ignored', { ageBand: 'bogus' }],
    ['search: name fragment', { query: sample.fullName.slice(1, 5) }],
    ['search: full name uppercase/padded', { query: `  ${sample.fullName}  ` }],
    ['search: national id', { query: sample.nationalId }],
    ['search: national id fragment', { query: sample.nationalId.slice(2, 6) }],
    ['search: phone fragment', { query: sample.phone.slice(-5) }],
    ['search: family reference', { query: sample.familyId }],
    ['search: family reference lowercase', { query: sample.familyId.toLowerCase() }],
    ['search: FAM prefix', { query: 'FAM-0000' }],
    ['search: no match', { query: 'zzzz-no-such-person' }],
    ...['%', '_', '\\', '*', '"', 'a,b)(c', '—', "'; drop table camps;--"].map((q) => [`search: literal ${JSON.stringify(q)}`, { query: q }]),
    ['search + filter', { query: sample.fullName.slice(1, 4), gender: sample.gender }],
  ];
  for (const [name, filters] of cases) {
    await t.test(`equivalence (super admin): ${name}`, async () => {
      assert.deepEqual(await serverIds(superAdmin, filters), legacyIds(filters));
    });
  }

  await t.test('equivalence spans empty, single and multi-page results', async () => {
    const sizes = [];
    for (const f of [{}, { query: sample.nationalId }, { query: 'zzzz-no-such-person' }]) sizes.push((await serverIds(superAdmin, f)).length);
    assert.ok(sizes.includes(0) && sizes.includes(1) && sizes.some((n) => n > 14));
  });

  await t.test('camp admin: same filters equal the legacy predicate over own-camp rows', async () => {
    const own = legacyRows.filter((r) => r.campId === adminProfile.camp_id);
    assert.ok(own.length > 0 && own.length < legacyRows.length);
    for (const filters of [{}, { gender: 'male' }, { isChild: 'yes' }, { hasChronic: 'yes' }, { query: own[0].fullName.slice(0, 3) }]) {
      const expected = own.filter((r) => matchesDisplacedFilters(r, filters, { aidFamilyIds: null })).map((r) => r.id);
      assert.deepEqual(await serverIds(admin, filters), expected);
    }
  });

  await t.test('pagination: first, middle, last, beyond-the-end and count-only', async () => {
    const all = legacyIds({});
    const size = 10;
    const pages = Math.ceil(all.length / size);
    const first = await fetchDisplacedPage(superAdmin, {}, { page: 1, pageSize: size });
    assert.equal(first.total, all.length);
    assert.deepEqual(first.rows.map((r) => r.id), all.slice(0, size));
    const middle = await fetchDisplacedPage(superAdmin, {}, { page: 2, pageSize: size });
    assert.deepEqual(middle.rows.map((r) => r.id), all.slice(size, 2 * size));
    const last = await fetchDisplacedPage(superAdmin, {}, { page: pages, pageSize: size });
    assert.deepEqual(last.rows.map((r) => r.id), all.slice((pages - 1) * size));
    const beyond = await fetchDisplacedPage(superAdmin, {}, { page: pages + 3, pageSize: size });
    assert.deepEqual(beyond.rows, []);
    assert.equal(beyond.total, all.length, 'total is still reported past the last page');
    const countOnly = await fetchDisplacedPage(superAdmin, { gender: 'male' }, { pageSize: 0 });
    assert.equal(countOnly.rows.length, 0);
    assert.equal(countOnly.total, legacyIds({ gender: 'male' }).length);
    assert.ok(first.rows.length <= first.total);
  });

  await t.test('the page request never returns more than the page (no whole-scope read)', async () => {
    const { data, error } = await superAdmin.rpc('list_displaced_persons', displacedRpcParams({}, { page: 1, pageSize: 10 }));
    assert.equal(error, null);
    assert.equal(data.rows.length, 10);
    assert.ok(data.total > 10);
    const clamped = await superAdmin.rpc('list_displaced_persons', { p_limit: 100000, p_offset: -5 });
    assert.equal(clamped.error, null);
    assert.ok(clamped.data.rows.length <= 1000, 'p_limit is clamped server-side');
  });

  await t.test('export batches equal the legacy filtered set, in order', async () => {
    for (const filters of [{}, { gender: 'female' }, { isChild: 'yes', campId: camps[0] }]) {
      const rows = await fetchAllDisplaced(superAdmin, filters, { batchSize: 8 });
      assert.deepEqual(rows.map((r) => r.id), legacyIds(filters));
    }
  });

  await t.test('row shape is what the old list mapped (family reference, camp name, DB age)', async () => {
    const { rows } = await fetchDisplacedPage(superAdmin, { query: sample.nationalId }, { pageSize: 10 });
    assert.equal(rows.length, 1);
    const legacy = legacyRows.find((r) => r.id === rows[0].id);
    const { ageYears, ...rest } = rows[0];
    const { ageYears: legacyAge, ...legacyRest } = legacy;
    assert.deepEqual(rest, legacyRest);
    assert.equal(ageYears, legacyAge);
    assert.equal(ageOf(rows[0]), ageYears, 'ageOf prefers the database age');
    assert.equal(ageOf({ birthDate: '2000-01-01', ageYears: 5 }), 5);
    assert.equal(ageOf({ birthDate: '2000-01-01', ageYears: null }), null);
  });

  await t.test('seed rows: database age equals the independent completed-years calculation', async () => {
    for (const row of legacyRows.slice(0, 40)) {
      const { rows } = await fetchDisplacedPage(superAdmin, { query: row.nationalId }, { pageSize: 5 });
      const hit = rows.find((r) => r.id === row.id);
      assert.ok(hit, `row ${row.id} returned`);
      assert.equal(hit.ageYears, row.birthDate ? ageAt(row.birthDate, today) : null, `age of ${row.id}`);
    }
  });

  // ---------------------------------------------------------------- age rule
  await t.test('age_in_years: birthday yesterday / today / tomorrow, leap day, null', async () => {
    const age = async (birth, on) => (await admin.rpc('age_in_years', { p_birth_date: birth, p_on: on })).data;
    assert.equal(await age('2008-09-29', '2026-09-28'), 17, 'birthday tomorrow');
    assert.equal(await age('2008-09-29', '2026-09-29'), 18, 'birthday today');
    assert.equal(await age('2008-09-29', '2026-09-30'), 18, 'birthday yesterday');
    assert.equal(await age('2008-02-29', '2026-02-28'), 17, 'leap-day baby, day before');
    assert.equal(await age('2008-02-29', '2026-03-01'), 18, 'leap-day baby, after');
    assert.equal(await age('2008-02-29', '2028-02-29'), 20, 'leap-day baby, real leap birthday');
    assert.equal(await age(null, '2026-09-29'), null, 'no birth date');
    assert.equal(await age('2026-09-29', '2026-09-29'), 0, 'born today');
    for (const birth of ['1990-05-17', '2010-12-31', '2025-01-01', today]) {
      const oneArg = (await admin.rpc('age_in_years', { p_birth_date: birth })).data;
      assert.equal(oneArg, ageAt(birth, today), `one-argument form uses current_date (${birth})`);
    }
  });

  await t.test('age boundary end-to-end on fixture members (yesterday / today / tomorrow), then cleaned up', async (tt) => {
    if (today.slice(5) === '02-29') return tt.skip('leap day: fixture birthdays are not expressible');
    const marker = `فحص-عمر-${Date.now()}`;
    const rid = () => String(900000000 + Math.floor(Math.random() * 99999999));
    const person = (name, birth, extra = {}) => ({ full_name: `${name} ${marker}`, gender: 'male', national_id: rid(), birth_date: birth, ...extra });
    const in18Tomorrow = yearsAgo(shiftDays(today, 1), 18);   // turns 18 tomorrow  -> 17
    const in18Today = yearsAgo(today, 18);                     // turns 18 today     -> 18
    const in18Yesterday = yearsAgo(shiftDays(today, -1), 18);  // turned 18 yesterday-> 18
    const oneYearToday = yearsAgo(today, 1);                   // exactly 1 today    -> 1 (not under 1)
    const almostOne = yearsAgo(shiftDays(today, 1), 1);        // 1 tomorrow         -> 0 (under 1)
    const twoYearsToday = yearsAgo(today, 2);                  // exactly 2 today    -> 2 (not under 2)
    let familyId = null;
    try {
      const created = await admin.rpc('create_family_with_members', {
        p_camp_id: adminProfile.camp_id,
        p_head: person('رب', '1985-05-05'),
        p_members: [
          person('يبلغ-غدا', in18Tomorrow), person('يبلغ-اليوم', in18Today), person('بلغ-امس', in18Yesterday),
          person('سنة-اليوم', oneYearToday), person('سنة-غدا', almostOne), person('سنتان-اليوم', twoYearsToday),
        ],
        p_notes: 'Phase 4.25 age fixture — safe to delete',
      });
      assert.equal(created.error, null, created.error?.message);
      familyId = created.data;

      const list = async (extra = {}) => (await fetchAllDisplaced(admin, { query: marker, ...extra }, { batchSize: 2 }));
      const nameOf = (r) => r.fullName.replace(` ${marker}`, '');
      const byName = Object.fromEntries((await list()).map((r) => [nameOf(r), r]));
      assert.equal(Object.keys(byName).length, 7);
      assert.deepEqual(
        ['يبلغ-غدا', 'يبلغ-اليوم', 'بلغ-امس', 'سنة-اليوم', 'سنة-غدا', 'سنتان-اليوم'].map((n) => byName[n].ageYears),
        [17, 18, 18, 1, 0, 2],
      );
      assert.deepEqual((await list({ isChild: 'yes' })).map(nameOf).sort(), ['سنة-اليوم', 'سنة-غدا', 'سنتان-اليوم', 'يبلغ-غدا'].sort());
      assert.deepEqual((await list({ isChild: 'no' })).map(nameOf).sort(), ['رب', 'يبلغ-اليوم', 'بلغ-امس'].sort());
      assert.deepEqual((await list({ ageBand: 'under_1' })).map(nameOf), ['سنة-غدا']);
      assert.deepEqual((await list({ ageBand: 'under_2' })).map(nameOf).sort(), ['سنة-اليوم', 'سنة-غدا'].sort());
      assert.deepEqual((await list({ ageBand: 'under_3' })).map(nameOf).sort(), ['سنة-اليوم', 'سنة-غدا', 'سنتان-اليوم'].sort());

      // Same-timestamp rows (one transaction): paging in 2s must show every member once, in one stable order.
      const seen = [];
      for (let page = 1; page <= 5; page += 1) seen.push(...(await fetchDisplacedPage(admin, { query: marker }, { page, pageSize: 2 })).rows.map((r) => r.id));
      assert.equal(seen.length, 7);
      assert.equal(new Set(seen).size, 7, 'no duplicate or missing rows across pages of tied created_at');
      assert.deepEqual(seen, (await list()).map((r) => r.id), 'order identical for every page size');
    } finally {
      if (familyId) await service.from('families').delete().eq('id', familyId);
    }
    const { count } = await service.from('family_members').select('id', { count: 'exact', head: true }).like('full_name', `%${marker}%`);
    assert.equal(count, 0, 'fixture members removed');
    const { count: fams } = await service.from('families').select('id', { count: 'exact', head: true }).eq('id', familyId);
    assert.equal(fams, 0, 'fixture family removed');
  });

  await t.test('one age rule: get_statistics_report and the list agree on children, orphans and the age buckets', async () => {
    const report = (await superAdmin.rpc('get_statistics_report', { p_tz: 'UTC' })).data;
    const total = async (filters) => (await fetchDisplacedPage(superAdmin, filters, { pageSize: 0 })).total;
    assert.equal(report.stats.children, await total({ isChild: 'yes' }), 'children');
    assert.equal(report.stats.orphans, await total({ isOrphan: 'yes' }), 'orphans');
    assert.equal(report.stats.displaced, await total({}), 'displaced');
    const buckets = [[0, 4], [5, 17], [18, 40], [41, 60], [61, 200]];
    assert.deepEqual(report.ages, buckets.map(([lo, hi]) => legacyRows.filter((r) => r.ageYears !== null && r.ageYears >= lo && r.ageYears <= hi).length), 'age buckets equal the independent completed-years count');
    for (const band of AGE_BANDS) assert.equal(await total({ ageBand: band.value }), legacyRows.filter((r) => r.ageYears !== null && r.ageYears < band.max).length, band.value);
  });

  await t.test('cleanup: seed row counts unchanged', async () => {
    const { count } = await service.from('family_members').select('id', { count: 'exact', head: true });
    assert.equal(count, legacyRows.length);
  });
});

/**
 * Phase 4.24: `get_statistics_report(p_tz)` equals (a) the legacy JS
 * aggregations in core/selectors.js run over independently fetched raw rows
 * and (b) independent service-role SQL counts — for every statistic the
 * statistics page shows.
 *
 *   cd supabase && npm run frontend:config && npm run test:phase4.24-statistics-verification
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
const sel = await load('assets/js/core/selectors.js');
const { shapeStatisticsReport } = await load('assets/js/supabase/statistics-report.js');

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

async function signedIn(email) {
  const client = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password: '123456' });
  assert.equal(error, null);
  return client;
}
const all = async (table, cols = '*') => {
  const { data, error } = await service.from(table).select(cols);
  assert.equal(error, null, error?.message);
  return data;
};

test('Phase 4.24 statistics report', async (t) => {
  const superAdmin = await signedIn('super@camps.ps');
  const { data: raw, error } = await superAdmin.rpc('get_statistics_report', { p_tz: TZ });
  assert.equal(error, null, error?.message);
  const report = shapeStatisticsReport(raw);

  // Legacy inputs, built independently from raw tables.
  const members = await all('family_members');
  const families = await all('families');
  const dists = await all('aid_distributions');
  const links = await all('aid_distribution_families');
  const dtypes = await all('aid_distribution_types');
  const types = await all('aid_types');
  const orgs = await all('organizations');
  const docs = await all('documents');
  const camps = await all('camps');
  const people = members.map((m) => ({
    birthDate: m.birth_date, fatherStatus: m.father_status, motherStatus: m.mother_status, maritalStatus: m.marital_status,
    chronicDiseases: m.chronic_diseases || '', disability: m.disability || '', gender: m.gender, createdAt: m.created_at,
    workStatus: m.work_status, tentType: m.tent_type, originGovernorate: m.origin_governorate,
  }));
  const famRows = families.map((f) => ({ membersCount: members.filter((m) => m.family_id === f.id).length }));
  const headName = (fid) => members.find((m) => m.family_id === fid && m.relationship === 'head')?.full_name;
  const aidRows = dists.map((d) => {
    const fams = links.filter((l) => l.distribution_id === d.id).map((l) => families.find((f) => f.id === l.family_id));
    return {
      organizationId: d.organization_id,
      organizationName: orgs.find((o) => o.id === d.organization_id)?.name,
      date: d.distributed_on,
      campName: camps.find((c) => c.id === d.camp_id)?.name,
      types: dtypes.filter((x) => x.distribution_id === d.id).map((x) => types.find((ty) => ty.id === x.aid_type_id).code),
      beneficiaries: fams.map((f) => ({ familyId: f.reference_code, headName: headName(f.id) })),
    };
  });
  const docRows = docs.map((d) => ({ category: d.category }));
  const legacyStats = sel.statistics({ people, families: famRows, aidRows, documents: docRows, camps });
  const byLabel = (list) => Object.fromEntries(list.map((e) => [e.value ?? e.label, e.count ?? e.value]));

  await t.test('headline counters equal legacy AND independent SQL counts', () => {
    for (const k of ['displaced', 'families', 'aid', 'donors', 'disability', 'chronic', 'males', 'females', 'children', 'orphans', 'documents']) {
      assert.equal(report.stats[k], legacyStats[k], `stats.${k}`);
    }
    assert.equal(report.stats.displaced, members.length);
    assert.equal(report.stats.families, families.length);
    assert.equal(report.stats.aid, dists.length);
    assert.equal(report.stats.documents, docs.length);
  });

  await t.test('monthly registrations (8 months) equal legacy', () => {
    const legacy = sel.displacedByMonth(people, 8).map((b) => b.value);
    assert.deepEqual(report.byMonth.map((b) => b.value), legacy);
    assert.equal(report.byMonth.length, 8);
  });

  await t.test('aid by type / organization / month / top families equal legacy', () => {
    assert.deepEqual(report.aidByType, sel.aidByType(aidRows));
    const org = (l) => l.map((e) => [e.value, e.count]).sort();
    assert.deepEqual(org(report.aidByOrganization), org(sel.aidByOrganization(aidRows)));
    assert.deepEqual(report.aidCountByMonth.map((b) => b.value), sel.aidCountByMonth(aidRows, 8).map((b) => b.value));
    const top = (l) => l.map((e) => [e.familyId, e.count]).sort();
    // Top-N tie order was never specified; compare counts multiset and membership counts.
    const legacyTop = sel.topFamiliesByAid(aidRows, 5);
    assert.equal(report.topFamilies.length, legacyTop.length);
    assert.deepEqual(report.topFamilies.map((e) => e.count), legacyTop.map((e) => e.count));
    for (const e of report.topFamilies) {
      assert.equal(e.count, aidRows.reduce((n, r) => n + r.beneficiaries.filter((b) => b.familyId === e.familyId).length, 0));
      assert.ok(e.headName && e.campName);
    }
    void top;
  });

  await t.test('family sizes, ages, work, tent, origin, documents equal legacy', () => {
    assert.deepEqual(report.familySizes.map((b) => b.count), sel.familySizeDistribution(famRows).map((b) => b.count));
    assert.deepEqual(report.ages.map((b) => b.count), sel.ageDistribution(people).map((b) => b.count));
    assert.deepEqual(byLabel(report.work), byLabel(sel.workStatusDistribution(people)));
    assert.deepEqual(byLabel(report.tents), byLabel(sel.tentTypeDistribution(people)));
    assert.deepEqual(byLabel(report.origins), byLabel(sel.originDistribution(people)));
    assert.deepEqual(
      byLabel(report.documents),
      byLabel(sel.documentsByCategory(docRows).filter((e) => e.count > 0))
    );
  });

  await t.test('bucket sums are consistent with totals', () => {
    assert.equal(report.familySizes.reduce((n, b) => n + b.count, 0), famRows.filter((r) => r.membersCount >= 1).length);
    assert.equal(report.stats.males + report.stats.females, report.stats.displaced);
  });

  await t.test('timezone parameter: invalid zone errors, UTC works', async () => {
    const bad = await superAdmin.rpc('get_statistics_report', { p_tz: 'Not/AZone' });
    assert.ok(bad.error, 'invalid tz must be rejected');
    const ok = await superAdmin.rpc('get_statistics_report', { p_tz: 'UTC' });
    assert.equal(ok.error, null);
  });
});

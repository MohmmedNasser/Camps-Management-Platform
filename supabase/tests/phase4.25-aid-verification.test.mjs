/**
 * Phase 4.25: server-side aid list.
 *
 *  - For every migrated filter (and combinations, search incl. wildcard chars),
 *    the ids `list_aid_distributions` returns — read page by page — equal, in the
 *    same order, the ids the LEGACY client path selects: the whole RLS scope read
 *    with the old nested embed, mapped, then `matchesAidFilters`. Checked for
 *    Super Admin, Camp Admin and a displaced account.
 *  - The four summary cards' figures (`summary`) equal the legacy Set sizes over
 *    the filtered rows.
 *  - Pagination: first / middle / last / beyond-the-end / count-only / page sizes
 *    on and around the total.
 *
 * No aid rows are created (creating aid fires the Phase 4.20 notification
 * trigger), so this suite leaves no data behind.
 *
 *   cd supabase && npm run frontend:config && npm run test:phase4.25-aid-verification
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

const load = (p) => import(pathToFileURL(resolve(ROOT, p)).href);
const { aidRpcParams, mapAidDistributionRow, fetchAidPage, fetchAllAid } = await load('assets/js/supabase/aid-filters.js');
const { matchesAidFilters } = await load('assets/js/core/selectors.js');

async function signedIn(email) {
  const client = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password: '123456' });
  assert.equal(error, null, `${email} must sign in`);
  return client;
}

/** The old embed (`aids.js` DISTRIBUTION_SELECT), verbatim. */
const LEGACY_SELECT =
  'id, distributed_on, all_families_selected, camp_id, created_at, ' +
  'camp:camps!aid_distributions_camp_id_fkey(name), ' +
  'organization:organizations(id, name, responsible_person, phone), ' +
  'aid_distribution_types(aid_type:aid_types(code, label_ar)), ' +
  'aid_distribution_families(family:families(id, reference_code, ' +
  'head:family_members!families_head_member_id_fkey(full_name))), ' +
  'created_by:profiles!aid_distributions_created_by_fkey(full_name)';

/** Whole RLS scope, old path, ordered like the old list: date desc, id desc. */
async function legacyRows(client) {
  const { data, error } = await client.from('aid_distributions').select(LEGACY_SELECT).order('distributed_on', { ascending: false }).order('id', { ascending: false });
  assert.equal(error, null, error?.message);
  return data.map(mapAidDistributionRow);
}
const legacySummary = (rows) => ({
  organizations: new Set(rows.map((r) => r.organizationId)).size,
  families: new Set(rows.flatMap((r) => r.familyIds)).size,
  types: new Set(rows.flatMap((r) => r.types)).size,
});

test('Phase 4.25 aid list', async (t) => {
  const superAdmin = await signedIn('super@camps.ps');
  const admin = await signedIn('admin@camps.ps');
  const displaced = await signedIn('ahmad@camps.ps');

  const everything = await legacyRows(superAdmin);
  assert.ok(everything.length >= 10, 'fixture sanity: seed aid present');

  const serverPage = async (client, filters, pageSize = 4) => {
    const ids = [];
    let last;
    for (let page = 1; ; page += 1) {
      last = await fetchAidPage(client, filters, { page, pageSize });
      ids.push(...last.rows.map((r) => r.id));
      if (ids.length >= last.total || !last.rows.length) return { ids, total: last.total, summary: last.summary, rows: last.rows };
    }
  };

  const orgs = [...new Set(everything.map((r) => r.organizationId))];
  const types = [...new Set(everything.flatMap((r) => r.types))];
  const familyDbIds = [...new Set(everything.flatMap((r) => r.familyDbIds))];
  const richest = everything.reduce((a, b) => (b.beneficiaryCount > a.beneficiaryCount ? b : a));
  const someHead = everything.flatMap((r) => r.beneficiaries).find((b) => b.headName.length > 4);
  const someOrg = everything.find((r) => r.organizationName.length > 3);
  const someLabel = everything.find((r) => r.typeLabels.length > 2);

  const cases = [
    ['no filters', {}],
    ...types.map((type) => [`type=${type}`, { type }]),
    ...orgs.map((organizationId) => [`donor=${organizationId.slice(0, 6)}`, { organizationId }]),
    ...familyDbIds.slice(0, 6).map((familyId) => [`family=${familyId.slice(0, 6)}`, { familyId }]),
    ['type + donor', { type: types[0], organizationId: orgs[0] }],
    ['type + family', { type: types[0], familyId: richest.familyDbIds[0] }],
    ['type + donor + family + search', { type: types[0], organizationId: richest.organizationId, familyId: richest.familyDbIds[0], query: richest.familyIds[0] }],
    ['unknown type matches nothing', { type: 'bogus' }],
    ['search: family reference', { query: richest.familyIds[0] }],
    ['search: family reference lowercase/padded', { query: `  ${richest.familyIds[0].toLowerCase()}  ` }],
    ['search: FAM prefix', { query: 'FAM-0000' }],
    ['search: head name fragment', { query: someHead.headName.slice(1, 5) }],
    ['search: donor name fragment', { query: someOrg.organizationName.slice(0, 3) }],
    ['search: type label fragment', { query: someLabel.typeLabels.slice(0, 3) }],
    ['search: no match', { query: 'zzzz-no-such-aid' }],
    ...['%', '_', '\\', '*', '"', 'a,b)(c', '—', "'; drop table camps;--"].map((q) => [`search: literal ${JSON.stringify(q)}`, { query: q }]),
    ['search + type', { query: someOrg.organizationName.slice(0, 3), type: someOrg.types[0] }],
  ];
  for (const [name, filters] of cases) {
    await t.test(`equivalence (super admin): ${name}`, async () => {
      const expected = everything.filter((r) => matchesAidFilters(r, filters));
      const actual = await serverPage(superAdmin, filters);
      assert.deepEqual(actual.ids, expected.map((r) => r.id));
      assert.equal(actual.total, expected.length);
      assert.deepEqual(actual.summary, legacySummary(expected), 'summary cards');
    });
  }

  await t.test('equivalence spans empty, single and multi-page results', async () => {
    const sizes = [];
    for (const f of [{}, { familyId: familyDbIds[0], type: types[0] }, { query: 'zzzz-no-such-aid' }]) sizes.push((await serverPage(superAdmin, f)).ids.length);
    assert.ok(sizes.includes(0) && sizes.some((n) => n > 4));
  });

  await t.test('row shape equals what the old embed mapped (every field)', async () => {
    const { rows } = await fetchAidPage(superAdmin, {}, { page: 1, pageSize: 100 });
    assert.equal(rows.length, everything.length);
    const norm = (r) => ({ ...r, beneficiaries: [...r.beneficiaries].sort((a, b) => a.familyId.localeCompare(b.familyId)), familyIds: [...r.familyIds].sort(), familyDbIds: [...r.familyDbIds].sort(), types: [...r.types].sort() });
    for (const legacy of everything) {
      const got = rows.find((r) => r.id === legacy.id);
      assert.ok(got, `row ${legacy.id}`);
      const { typeLabels: gl, ...g } = norm(got);
      const { typeLabels: ll, ...l } = norm(legacy);
      assert.deepEqual(g, l);
      assert.deepEqual([...gl.split('، ')].sort(), [...ll.split('، ')].sort(), 'same type labels (order is now deterministic)');
    }
  });

  await t.test('camp admin: equals the legacy predicate over own-camp rows', async () => {
    const own = await legacyRows(admin);
    assert.ok(own.length > 0 && own.length < everything.length);
    const ownCamp = own[0].campId;
    assert.ok(own.every((r) => r.campId === ownCamp));
    for (const filters of [{}, { type: own[0].types[0] }, { organizationId: own[0].organizationId }, { familyId: own[0].familyDbIds[0] }, { query: own[0].familyIds[0] }]) {
      const expected = own.filter((r) => matchesAidFilters(r, filters));
      const actual = await serverPage(admin, filters);
      assert.deepEqual(actual.ids, expected.map((r) => r.id));
      assert.deepEqual(actual.summary, legacySummary(expected));
    }
  });

  await t.test('displaced: equals the legacy own-family list (other beneficiaries stay hidden)', async () => {
    const { data: fams } = await displaced.from('families').select('id');
    assert.equal(fams.length, 1);
    const ownFamilyId = fams[0].id;
    const own = (await legacyRows(displaced)).filter((r) => r.familyDbIds.includes(ownFamilyId));
    for (const filters of [{}, { type: own[0]?.types[0] }, { organizationId: own[0]?.organizationId }, { query: 'zzzz' }].filter((f) => own.length || !Object.values(f).some(Boolean))) {
      const expected = own.filter((r) => matchesAidFilters(r, filters));
      const actual = await serverPage(displaced, filters);
      assert.deepEqual(actual.ids, expected.map((r) => r.id));
      assert.equal(actual.rows.every((r) => r.familyDbIds.every((id) => id === ownFamilyId)), true, 'no other family leaks through beneficiaries');
    }
  });

  await t.test('pagination: first, middle, last, beyond-the-end, count-only and page sizes around the total', async () => {
    const all = everything.map((r) => r.id);
    const size = 5;
    const pages = Math.ceil(all.length / size);
    const first = await fetchAidPage(superAdmin, {}, { page: 1, pageSize: size });
    assert.equal(first.total, all.length);
    assert.deepEqual(first.rows.map((r) => r.id), all.slice(0, size));
    assert.deepEqual((await fetchAidPage(superAdmin, {}, { page: 2, pageSize: size })).rows.map((r) => r.id), all.slice(size, 2 * size));
    assert.deepEqual((await fetchAidPage(superAdmin, {}, { page: pages, pageSize: size })).rows.map((r) => r.id), all.slice((pages - 1) * size));
    const beyond = await fetchAidPage(superAdmin, {}, { page: pages + 2, pageSize: size });
    assert.deepEqual(beyond.rows, []);
    assert.equal(beyond.total, all.length);
    assert.deepEqual(beyond.summary, legacySummary(everything), 'summary is present past the last page');
    const countOnly = await fetchAidPage(superAdmin, { type: types[0] }, { pageSize: 0 });
    assert.equal(countOnly.rows.length, 0);
    assert.equal(countOnly.total, everything.filter((r) => r.types.includes(types[0])).length);
    for (const pageSize of [1, all.length - 1, all.length, all.length + 1]) {
      const got = [];
      for (let page = 1; page <= all.length + 1; page += 1) got.push(...(await fetchAidPage(superAdmin, {}, { page, pageSize })).rows.map((r) => r.id));
      assert.deepEqual(got, all, `pageSize ${pageSize}: every row once, fixed order`);
    }
  });

  await t.test('date order is newest first and stable; export batches equal the filtered set', async () => {
    const dates = everything.map((r) => r.date);
    assert.deepEqual(dates, [...dates].sort().reverse());
    for (const filters of [{}, { type: types[0] }, { organizationId: orgs[0] }]) {
      const rows = await fetchAllAid(superAdmin, filters, { batchSize: 3 });
      assert.deepEqual(rows.map((r) => r.id), everything.filter((r) => matchesAidFilters(r, filters)).map((r) => r.id));
    }
  });

  await t.test('the page request returns one page, not the whole scope; limit is clamped', async () => {
    const { data, error } = await superAdmin.rpc('list_aid_distributions', aidRpcParams({}, { page: 1, pageSize: 5 }));
    assert.equal(error, null);
    assert.equal(data.rows.length, 5);
    assert.ok(data.total > 5);
    const clamped = await superAdmin.rpc('list_aid_distributions', { p_limit: 100000, p_offset: -3 });
    assert.equal(clamped.error, null);
    assert.ok(clamped.data.rows.length <= 1000);
  });
});

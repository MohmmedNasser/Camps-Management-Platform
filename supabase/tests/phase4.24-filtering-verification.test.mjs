/**
 * Phase 4.24: server-side family filtering.
 *
 *  - `family_overview` counts equal counts computed independently in JS from raw
 *    family_members rows (selectors.personFacts) — not from the view itself.
 *  - For every migrated filter (and combinations, boundaries, wildcard search),
 *    the ids returned by `applyFamilyFilters` on the view equal the ids the
 *    legacy JS predicate `matchesFamilyFilters` selects from the unfiltered set.
 *
 *   cd supabase && npm run frontend:config && npm run test:phase4.24-filtering-verification
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
const { applyFamilyFilters, refineFamilyRows, mapFamilyOverviewRow, FAMILY_OVERVIEW_COLUMNS } = await load('assets/js/supabase/family-filters.js');
const { matchesFamilyFilters, personFacts } = await load('assets/js/core/selectors.js');

async function signedIn(email) {
  const client = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password: '123456' });
  assert.equal(error, null);
  return client;
}
const serverIds = async (client, filters) => {
  const { data, error } = await applyFamilyFilters(client.from('family_overview').select(FAMILY_OVERVIEW_COLUMNS), filters).order('reference_code');
  assert.equal(error, null, error?.message);
  return refineFamilyRows(data.map(mapFamilyOverviewRow), filters).map((r) => r.id);
};

test('Phase 4.24 family_overview + filters', async (t) => {
  const superAdmin = await signedIn('super@camps.ps');
  const { data: all, error } = await superAdmin.from('family_overview').select(FAMILY_OVERVIEW_COLUMNS).order('reference_code');
  assert.equal(error, null, error?.message);
  const legacy = all.map(mapFamilyOverviewRow); // legacy shape: id/headName/membersCount/...

  await t.test('view counts equal independent JS counts from raw members', async () => {
    const { data: members } = await service.from('family_members').select('*');
    const { data: fams } = await service.from('families').select('id, reference_code, camp_id');
    const { data: links } = await service.from('aid_distribution_families').select('family_id');
    assert.equal(all.length, fams.length);
    for (const f of fams) {
      const ms = members.filter((m) => m.family_id === f.id).map((m) => ({
        birthDate: m.birth_date, fatherStatus: m.father_status, motherStatus: m.mother_status, maritalStatus: m.marital_status,
        chronicDiseases: m.chronic_diseases, disability: m.disability, isPregnant: m.is_pregnant, isBreastfeeding: m.is_breastfeeding, gender: m.gender,
      }));
      const facts = ms.map(personFacts);
      const row = legacy.find((r) => r.id === f.reference_code);
      assert.ok(row, `row for ${f.reference_code}`);
      assert.equal(row.campId, f.camp_id);
      assert.equal(row.membersCount, ms.length, `${f.reference_code} size`);
      assert.equal(row.childrenUnder18, facts.filter((x) => x.isChild).length);
      assert.equal(row.childrenUnder3, facts.filter((x) => x.under3).length);
      assert.equal(row.childrenUnder2, facts.filter((x) => x.under2).length);
      assert.equal(row.childrenUnder1, facts.filter((x) => x.under1).length);
      assert.equal(row.orphans, facts.filter((x) => x.isOrphan).length);
      assert.equal(row.chronic, facts.filter((x) => x.hasChronic).length);
      assert.equal(row.disability, facts.filter((x) => x.hasDisability).length);
      assert.equal(row.pregnant, facts.filter((x) => x.isPregnant).length);
      assert.equal(row.breastfeeding, facts.filter((x) => x.isBreastfeeding).length);
      assert.equal(row.aidCount, links.filter((l) => l.family_id === f.id).length);
    }
  });

  const yn = ['yes', 'no'];
  const cases = [
    ['no filters', {}],
    ...['size_1', 'size_2_3', 'size_4_5', 'size_6_plus'].map((size) => [`size ${size}`, { size }]),
    ...['hasChildren', 'hasUnder3', 'hasUnder2', 'hasUnder1', 'hasOrphan', 'hasChronic', 'hasBreastfeeding', 'hasPregnant'].flatMap((k) =>
      yn.map((v) => [`${k}=${v}`, { [k]: v }])),
    ['combo children+chronic', { hasChildren: 'yes', hasChronic: 'yes' }],
    ['combo no orphan + size_2_3', { hasOrphan: 'no', size: 'size_2_3' }],
    ['combo pregnant yes + children no (likely empty)', { hasPregnant: 'yes', hasChildren: 'no' }],
    ['unknown size bucket ignored', { size: 'bogus' }],
    ['search: reference code', { query: 'FAM-0000' }],
    ['search: reference code exact single', { query: legacy[0].id }],
    ['search: head name fragment', { query: legacy.find((r) => r.headName.length > 3).headName.slice(1, 4) }],
    ['search: uppercase/padded', { query: `  ${legacy[0].id.toLowerCase()}  ` }],
    ['search: no match', { query: 'zzzz-no-such-family' }],
    ['search: literal percent', { query: '%' }],
    ['search: literal underscore', { query: '_' }],
    ['search: backslash', { query: '\\' }],
    ['search: comma/paren (postgrest or() syntax chars)', { query: 'a,b)(c' }],
  ];
  for (const [name, filters] of cases) {
    await t.test(`equivalence: ${name}`, async () => {
      const expected = legacy.filter((f) => matchesFamilyFilters(f, filters)).map((f) => f.id).sort();
      const actual = (await serverIds(superAdmin, filters)).sort();
      assert.deepEqual(actual, expected);
    });
  }

  await t.test('search exercises multi-row, one-row and empty results', async () => {
    const sizes = new Set();
    for (const f of [{}, { query: legacy[0].id }, { query: 'zzzz-no-such-family' }]) sizes.add((await serverIds(superAdmin, f)).length);
    assert.ok(sizes.has(0) && sizes.has(1) && [...sizes].some((n) => n > 1));
  });

  await t.test('camp filter equals legacy campId predicate for every camp', async () => {
    const camps = [...new Set(legacy.map((f) => f.campId))];
    assert.ok(camps.length >= 2);
    for (const campId of camps) {
      const expected = legacy.filter((f) => matchesFamilyFilters(f, { campId })).map((f) => f.id).sort();
      assert.deepEqual((await serverIds(superAdmin, { campId })).sort(), expected);
    }
  });

  await t.test('note search matches notes text, as the legacy predicate does', async () => {
    const withNotes = legacy.find((f) => f.notes && f.notes.length > 2);
    if (!withNotes) return; // nothing to assert on this dataset
    const q = withNotes.notes.slice(0, 2);
    const expected = legacy.filter((f) => matchesFamilyFilters(f, { query: q })).map((f) => f.id).sort();
    assert.deepEqual((await serverIds(superAdmin, { query: q })).sort(), expected);
  });
});

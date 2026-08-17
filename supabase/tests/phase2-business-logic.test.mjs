/**
 * Phase 2 business-logic test suite.
 *
 * Same approach as tests/rls.test.mjs: real signed-in sessions over real
 * HTTP against the live, seeded project — not a mocked role. Covers the
 * three Phase 2 migrations (search indexes, add_family_member,
 * get_family_statistics/get_dashboard_statistics) that Tasks 1-3 added on
 * top of the already-verified Phase 1 schema.
 *
 *   cd supabase && npm install
 *   npm run seed:reset
 *   npm run test:phase2
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');

loadDotEnv(resolve(ROOT, '.env'));

const URL = required('SUPABASE_URL');
const PUBLISHABLE = required('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY');

const PASSWORD = '123456';

/** Seeded personas, from assets/js/data/mock-data.js (matches tests/rls.test.mjs). */
const ACCOUNTS = {
  superAdmin: 'super@camps.ps',
  campAdminA: 'admin@camps.ps', // مخيم النور
  campAdminB: 'nour@camps.ps', // مخيم الرحمة
  displaced: 'ahmad@camps.ps', // FAM-000001, مخيم النور
};

const clients = {};

async function as(persona) {
  if (clients[persona]) return clients[persona];
  const client = createClient(URL, PUBLISHABLE, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({
    email: ACCOUNTS[persona],
    password: PASSWORD,
  });
  assert.equal(error, null, `sign-in failed for ${persona}: ${error?.message}`);
  clients[persona] = client;
  return client;
}

/**
 * `profiles` RLS also lets a Camp Admin read every OTHER profile in their
 * own camp (not just their own row), so a bare `.select().single()` with no
 * `.eq('id', ...)` fails with "multiple rows returned" once the seed has
 * more than one account per camp. Always filter by the caller's own id.
 */
async function ownProfile(client) {
  const {
    data: { user },
  } = await client.auth.getUser();
  const { data, error } = await client.from('profiles').select('camp_id').eq('id', user.id).single();
  assert.equal(error, null, error?.message);
  return data;
}

test('add_family_member: camp admin adds a member to their own camp family', async () => {
  const c = await as('campAdminA');
  const { data: families, error: familiesError } = await c.from('families').select('id, camp_id').limit(1);
  assert.equal(familiesError, null, familiesError?.message);
  assert.ok(families.length > 0, 'seed must contain at least one family in camp A');

  const { data: memberId, error } = await c.rpc('add_family_member', {
    p_family_id: families[0].id,
    p_member: { full_name: 'فرد اختبار', gender: 'male', national_id: '999888777', relationship: 'son' },
  });
  assert.equal(error, null, error?.message);
  assert.ok(memberId);

  await c.from('family_members').delete().eq('id', memberId); // cleanup
});

test('add_family_member: rejects a duplicate national_id with 23505', async () => {
  const c = await as('campAdminA');
  const { data: members, error: membersError } = await c.from('family_members').select('national_id, family_id').limit(1);
  assert.equal(membersError, null, membersError?.message);

  const { error } = await c.rpc('add_family_member', {
    p_family_id: members[0].family_id,
    p_member: { full_name: 'تكرار', gender: 'male', national_id: members[0].national_id, relationship: 'son' },
  });
  assert.equal(error.code, '23505');
});

test("add_family_member: camp admin cannot add to another camp's family", async () => {
  const adminA = await as('campAdminA');
  const adminB = await as('campAdminB');
  const myProfile = await ownProfile(adminA);
  const { data: otherFamilies } = await adminB.from('families').select('id, camp_id').limit(1);
  assert.ok(otherFamilies.length > 0, 'seed must contain at least one family in camp B');
  assert.notEqual(otherFamilies[0].camp_id, myProfile.camp_id);

  const { error } = await adminA.rpc('add_family_member', {
    p_family_id: otherFamilies[0].id,
    p_member: { full_name: 'دخيل', gender: 'male', national_id: '111222333', relationship: 'son' },
  });
  assert.equal(error.code, '42501');
});

test('add_family_member: nonexistent family returns P0002', async () => {
  const c = await as('campAdminA');
  const { error } = await c.rpc('add_family_member', {
    p_family_id: '00000000-0000-0000-0000-000000000000',
    p_member: { full_name: 'لا يوجد', gender: 'male', national_id: '555666777', relationship: 'son' },
  });
  assert.equal(error.code, 'P0002');
});

test('get_family_statistics: camp admin sees only their own camp, matching a manual count', async () => {
  const c = await as('campAdminA');
  const profile = await ownProfile(c);
  const { data: stats, error } = await c.rpc('get_family_statistics', { p_camp_id: profile.camp_id });
  assert.equal(error, null, error?.message);

  const { count: manualCount } = await c
    .from('family_members')
    .select('*', { count: 'exact', head: true })
    .eq('camp_id', profile.camp_id);
  assert.equal(stats[0].total_members, manualCount);
});

test('get_family_statistics: camp admin cannot query another camp', async () => {
  const adminA = await as('campAdminA');
  const { data: camps } = await adminA.from('camps').select('id');
  const myProfile = await ownProfile(adminA);
  const otherCamp = camps.find((camp) => camp.id !== myProfile.camp_id);
  assert.ok(otherCamp, 'seed must contain more than one camp');

  const { error } = await adminA.rpc('get_family_statistics', { p_camp_id: otherCamp.id });
  assert.equal(error.code, '42501');
});

test('get_family_statistics: displaced person is denied outright', async () => {
  const c = await as('displaced');
  const { error } = await c.rpc('get_family_statistics', {});
  assert.equal(error.code, '42501');
});

test('get_dashboard_statistics: super admin system-wide total is >= a single camp total', async () => {
  const superC = await as('superAdmin');
  const adminC = await as('campAdminA');
  const adminProfile = await ownProfile(adminC);

  const { data: system, error: systemError } = await superC.rpc('get_dashboard_statistics', {});
  assert.equal(systemError, null, systemError?.message);
  const { data: campOnly, error: campError } = await superC.rpc('get_dashboard_statistics', {
    p_camp_id: adminProfile.camp_id,
  });
  assert.equal(campError, null, campError?.message);

  assert.ok(system.total_families >= campOnly.total_families);
});

test('get_dashboard_statistics: displaced person is denied outright', async () => {
  const c = await as('displaced');
  const { error } = await c.rpc('get_dashboard_statistics', {});
  assert.equal(error.code, '42501');
});

test('search indexes: substring search on organization name succeeds', async () => {
  const c = await as('superAdmin');
  const { data, error } = await c.from('organizations').select('id, name').ilike('name', '%جمعية%');
  assert.equal(error, null, error?.message);
  assert.ok(Array.isArray(data));
});

test('families.js: family_stats can be queried by family_id and joined client-side', async () => {
  const c = await as('campAdminA');
  const { data: families, error: familiesError } = await c.from('families').select('id').limit(1);
  assert.equal(familiesError, null, familiesError?.message);
  const { data: stats, error } = await c
    .from('family_stats')
    .select('members_count, orphans, chronic, pregnant, breastfeeding')
    .eq('family_id', families[0].id)
    .maybeSingle();
  assert.equal(error, null, error?.message);
  assert.equal(typeof stats.members_count, 'number');
});

test('family-members.js: family_member_facts can be queried by member_id and joined client-side', async () => {
  const c = await as('campAdminA');
  const { data: members, error: membersError } = await c.from('family_members').select('id').limit(1);
  assert.equal(membersError, null, membersError?.message);
  const { data: facts, error } = await c
    .from('family_member_facts')
    .select('age_years, is_child, is_orphan')
    .eq('member_id', members[0].id)
    .maybeSingle();
  assert.equal(error, null, error?.message);
  assert.equal(typeof facts.age_years, 'number');
});

test('search indexes: prefix search on family reference_code succeeds', async () => {
  const c = await as('superAdmin');
  const { data, error } = await c.from('families').select('id, reference_code').ilike('reference_code', 'FAM-%');
  assert.equal(error, null, error?.message);
  assert.ok(Array.isArray(data));
});

test('aids.js: nested !inner filter on aid_type and family narrows top-level distributions', async () => {
  const c = await as('superAdmin');
  const { data: aidTypes, error: aidTypesError } = await c.from('aid_types').select('code').limit(1);
  assert.equal(aidTypesError, null, aidTypesError?.message);
  const code = aidTypes[0].code;

  const { data, error } = await c
    .from('aid_distributions')
    .select(
      'id, distributed_on, organization:organizations(id, name), aid_distribution_types!inner(aid_type:aid_types!inner(code, label_ar)), aid_distribution_families(family:families(id, reference_code))'
    )
    .eq('aid_distribution_types.aid_type.code', code);
  assert.equal(error, null, error?.message);
  assert.ok(Array.isArray(data));
  for (const row of data) {
    assert.ok(row.aid_distribution_types.some((t) => t.aid_type.code === code));
  }
});

test('documents.js / messages.js / notifications.js: basic queries execute against real columns', async () => {
  const c = await as('campAdminA');
  const { error: docsError } = await c.from('documents').select('*').limit(1);
  assert.equal(docsError, null, docsError?.message);
  const { error: msgError } = await c.from('messages').select('*').eq('status', 'unread').limit(1);
  assert.equal(msgError, null, msgError?.message);
  const { error: notifError } = await c.from('notifications').select('*').eq('is_read', false).limit(1);
  assert.equal(notifError, null, notifError?.message);
});

function required(...names) {
  for (const name of names) {
    if (process.env[name]) return process.env[name];
  }
  throw new Error(`Missing ${names.join(' or ')}. Copy .env.example to .env and fill it in.`);
}

function loadDotEnv(path) {
  let contents;
  try {
    contents = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const line of contents.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[2].trim().replace(/^["']|["']$/g, '');
    if (!(match[1] in process.env)) process.env[match[1]] = value;
  }
}

/**
 * RLS security test suite.
 *
 * Runs against a seeded database and proves the isolation rules from the
 * outside, the way an attacker would meet them: with a real signed-in session
 * and a real API key, not with a mocked role. Everything here would pass just
 * as easily if the frontend were removed entirely — which is the point. The
 * prototype's frontend checks are convenience; these are the control.
 *
 *   cd supabase && npm install
 *   npm run seed:reset
 *   npm run test:rls
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
const SECRET = required('SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY');

const PASSWORD = '123456';

/** Seeded personas, from assets/js/data/mock-data.js. */
const ACCOUNTS = {
  superAdmin: 'super@camps.ps',
  campAdminA: 'admin@camps.ps', // مخيم النور
  campAdminB: 'nour@camps.ps', // مخيم الرحمة
  disabledAdmin: 'raed@camps.ps', // مخيم الأمل, status disabled
  displacedA: 'ahmad@camps.ps', // FAM-000001, مخيم النور
  displacedB: 'ibrahim@camps.ps', // FAM-000004, مخيم الرحمة
};

const admin = createClient(URL, SECRET, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const anon = createClient(URL, PUBLISHABLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const clients = {};
const world = {};

/** Sign in as a seeded persona and cache the authenticated client. */
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

test('setup: resolve the seeded world', async () => {
  const { data: camps } = await admin.from('camps').select('id, name').order('created_at');
  assert.ok(camps.length >= 2, 'seed must contain at least two camps');
  world.campA = camps[0];
  world.campB = camps[1];

  const { data: families } = await admin
    .from('families')
    .select('id, reference_code, camp_id')
    .order('reference_code');
  world.familyInA = families.find((f) => f.camp_id === world.campA.id);
  world.familyInB = families.find((f) => f.camp_id === world.campB.id);
  assert.ok(world.familyInA && world.familyInB, 'seed must contain families in both camps');

  const { data: orgs } = await admin.from('organizations').select('id').limit(1);
  world.organization = orgs[0];
});

/* =============================================================================
   1 · Anonymous
   ========================================================================== */

test('anonymous: cannot read any protected table', async () => {
  const protectedTables = [
    'profiles',
    'families',
    'family_members',
    'organizations',
    'aid_distributions',
    'aid_distribution_families',
    'registration_requests',
    'documents',
    'messages',
    'notifications',
    'user_preferences',
    'family_member_facts',
    'family_stats',
  ];

  for (const table of protectedTables) {
    const { data, error } = await anon.from(table).select('*').limit(1);
    // Either the grant is missing (error) or RLS returns nothing. Both are a
    // pass; leaking a single row is not.
    assert.ok(
      error !== null || (data ?? []).length === 0,
      `anonymous read of ${table} returned ${data?.length} rows`
    );
  }
});

test('anonymous: reads active camps only — the one deliberate public read', async () => {
  const { data, error } = await anon.from('camps').select('id, name, status');
  assert.equal(error, null);
  assert.ok(data.length > 0, 'the public registration form needs the camp list');
  assert.ok(
    data.every((camp) => camp.status === 'active'),
    'disabled camps must not be visible anonymously'
  );
});

test('anonymous: cannot write', async () => {
  const { error } = await anon.from('camps').insert({ name: 'مخيم مزيف', governorate: 'gaza' });
  assert.notEqual(error, null, 'anonymous insert into camps must be rejected');
});

/* =============================================================================
   2 · Super Admin
   ========================================================================== */

test('super admin: reads every camp, family and person', async () => {
  const client = await as('superAdmin');

  const { data: camps, error: campsError } = await client.from('camps').select('id');
  assert.equal(campsError, null);
  assert.ok(camps.length >= 2);

  const { data: families } = await client.from('families').select('id, camp_id');
  const campIds = new Set(families.map((f) => f.camp_id));
  assert.ok(campIds.size >= 2, 'super admin must see families across camps');

  const { data: members } = await client.from('family_members').select('id, camp_id');
  assert.ok(new Set(members.map((m) => m.camp_id)).size >= 2);

  const { data: aid } = await client.from('aid_distributions').select('id, camp_id');
  assert.ok(new Set(aid.map((a) => a.camp_id)).size >= 2);
});

test('super admin: may manage camps', async () => {
  const client = await as('superAdmin');
  const { data, error } = await client
    .from('camps')
    .insert({ name: 'مخيم اختبار الصلاحيات', governorate: 'gaza', city: 'غزة' })
    .select()
    .single();
  assert.equal(error, null, `super admin camp insert failed: ${error?.message}`);

  const { error: deleteError } = await client.from('camps').delete().eq('id', data.id);
  assert.equal(deleteError, null);
});

/* =============================================================================
   3 · Camp Admin — access to their own camp
   ========================================================================== */

test('camp admin A: reads their own camp', async () => {
  const client = await as('campAdminA');

  const { data: families, error } = await client.from('families').select('id, camp_id');
  assert.equal(error, null);
  assert.ok(families.length > 0, 'camp admin must see their own families');
  assert.ok(
    families.every((f) => f.camp_id === world.campA.id),
    'camp admin saw a family outside their camp'
  );

  const { data: members } = await client.from('family_members').select('id, camp_id');
  assert.ok(members.length > 0);
  assert.ok(members.every((m) => m.camp_id === world.campA.id));
});

test('camp admin A: may create and delete records in their own camp', async () => {
  const client = await as('campAdminA');

  const { data: familyId, error } = await client.rpc('create_family_with_members', {
    p_camp_id: world.campA.id,
    p_head: {
      full_name: 'اختبار الصلاحيات',
      gender: 'male',
      national_id: '999000111',
      birth_date: '1990-01-01',
    },
    p_members: [],
    p_notes: 'سجل اختبار',
  });
  assert.equal(error, null, `camp admin family creation failed: ${error?.message}`);

  const { error: deleteError } = await client.from('families').delete().eq('id', familyId);
  assert.equal(deleteError, null);
});

/* =============================================================================
   4 · Camp Admin — isolation from every other camp
   ========================================================================== */

test('camp admin A: cannot read camp B', async () => {
  const client = await as('campAdminA');

  for (const table of ['families', 'family_members', 'aid_distributions', 'documents']) {
    const { data, error } = await client.from(table).select('id').eq('camp_id', world.campB.id);
    assert.equal(error, null);
    assert.equal(data.length, 0, `camp admin A read ${data.length} rows of ${table} from camp B`);
  }
});

test('camp admin A: cannot read camp B medical data even by direct id', async () => {
  const client = await as('campAdminA');

  const { data: target } = await admin
    .from('family_members')
    .select('id')
    .eq('camp_id', world.campB.id)
    .not('chronic_diseases', 'eq', '')
    .limit(1)
    .single();

  const { data } = await client
    .from('family_members')
    .select('id, chronic_diseases, disability')
    .eq('id', target.id);
  assert.equal(data.length, 0, 'camp admin A reached another camp’s health record by id');
});

test('camp admin A: cannot write into camp B', async () => {
  const client = await as('campAdminA');

  const { error: familyError } = await client.rpc('create_family_with_members', {
    p_camp_id: world.campB.id,
    p_head: { full_name: 'اختراق', gender: 'male', national_id: '999000222' },
  });
  assert.notEqual(familyError, null, 'camp admin A created a family in camp B');

  const { error: aidError } = await client.rpc('create_aid_distribution', {
    p_organization_id: world.organization.id,
    p_camp_id: world.campB.id,
    p_distributed_on: '2026-08-01',
    p_aid_type_codes: ['food'],
    p_family_ids: [world.familyInB.id],
  });
  assert.notEqual(aidError, null, 'camp admin A recorded aid in camp B');
});

test('camp admin A: cannot update or delete a camp B row', async () => {
  const client = await as('campAdminA');

  const { data: updated } = await client
    .from('families')
    .update({ notes: 'تم الاختراق' })
    .eq('id', world.familyInB.id)
    .select();
  assert.equal((updated ?? []).length, 0, 'camp admin A updated a camp B family');

  const { data: deleted } = await client
    .from('families')
    .delete()
    .eq('id', world.familyInB.id)
    .select();
  assert.equal((deleted ?? []).length, 0, 'camp admin A deleted a camp B family');
});

test('camp admin A: cannot review camp B registration requests', async () => {
  const client = await as('campAdminA');

  const { data: request } = await admin
    .from('registration_requests')
    .select('id')
    .eq('camp_id', world.campB.id)
    .eq('status', 'pending')
    .limit(1)
    .maybeSingle();

  if (!request) return; // seed has no pending request in camp B

  const { error } = await client.rpc('approve_registration_request', {
    p_request_id: request.id,
  });
  assert.notEqual(error, null, 'camp admin A approved a request in camp B');
});

test('disabled camp admin: authenticates but is authorized for nothing', async () => {
  const client = await as('disabledAdmin');

  const { data } = await client.from('families').select('id');
  assert.equal((data ?? []).length, 0, 'a disabled admin still read families');
});

/* =============================================================================
   5 · Displaced person — own data only
   ========================================================================== */

test('displaced A: reads their own family and its members', async () => {
  const client = await as('displacedA');

  const { data: families, error } = await client.from('families').select('id, reference_code');
  assert.equal(error, null);
  assert.equal(families.length, 1, 'a displaced person must see exactly one family');

  const { data: members } = await client.from('family_members').select('id, family_id');
  assert.ok(members.length > 0);
  assert.ok(
    members.every((m) => m.family_id === families[0].id),
    'displaced A saw a person outside their own family'
  );
});

test('displaced A: reads their own aid history', async () => {
  const client = await as('displacedA');

  const { data: aid, error } = await client
    .from('aid_distributions')
    .select('id, aid_distribution_families(family_id)');
  assert.equal(error, null);

  const { data: families } = await client.from('families').select('id');
  const own = families[0].id;
  for (const record of aid) {
    assert.ok(
      record.aid_distribution_families.some((f) => f.family_id === own),
      'displaced A saw a distribution their family did not receive'
    );
  }
});

test('displaced A: cannot read displaced B', async () => {
  const client = await as('displacedA');

  const { data: target } = await admin
    .from('family_members')
    .select('id, family_id')
    .eq('family_id', world.familyInB.id)
    .limit(1)
    .single();

  const { data: person } = await client.from('family_members').select('id').eq('id', target.id);
  assert.equal(person.length, 0, 'displaced A read another family’s person record');

  const { data: family } = await client.from('families').select('id').eq('id', world.familyInB.id);
  assert.equal(family.length, 0, 'displaced A read another family');
});

test('displaced A: cannot read administrative aggregates', async () => {
  const client = await as('displacedA');

  const { data: stats } = await client.from('family_stats').select('family_id');
  assert.equal(stats.length, 1, 'family_stats leaked other families to a displaced person');

  const { data: profiles } = await client.from('profiles').select('id');
  assert.equal(profiles.length, 1, 'a displaced person read someone else’s profile');

  const { data: requests } = await client.from('registration_requests').select('id');
  assert.equal(requests.length, 0, 'a displaced person read the review queue');
});

test('displaced A: cannot read another account’s notifications or messages', async () => {
  const client = await as('displacedA');

  const { data: notifications } = await client.from('notifications').select('recipient_id');
  const { data: me } = await client.auth.getUser();
  assert.ok(
    notifications.every((n) => n.recipient_id === me.user.id),
    'notifications leaked across accounts'
  );

  const { data: messages } = await client.from('messages').select('sender_id');
  assert.ok(
    messages.every((m) => m.sender_id === me.user.id),
    'a displaced person read another person’s messages'
  );
});

test('displaced A: cannot create, edit or delete aid (domain rule 8)', async () => {
  const client = await as('displacedA');

  const { error } = await client.rpc('create_aid_distribution', {
    p_organization_id: world.organization.id,
    p_camp_id: world.campA.id,
    p_distributed_on: '2026-08-01',
    p_aid_type_codes: ['food'],
    p_family_ids: [world.familyInA.id],
  });
  assert.notEqual(error, null, 'a displaced person recorded an aid distribution');

  const { data: existing } = await client.from('aid_distributions').select('id').limit(1);
  if (existing.length) {
    const { data: deleted } = await client
      .from('aid_distributions')
      .delete()
      .eq('id', existing[0].id)
      .select();
    assert.equal((deleted ?? []).length, 0, 'a displaced person deleted an aid record');
  }
});

test('displaced A: cannot edit their own person record', async () => {
  const client = await as('displacedA');

  const { data: members } = await client.from('family_members').select('id').limit(1);
  const { data: updated } = await client
    .from('family_members')
    .update({ chronic_diseases: 'تم التعديل ذاتياً' })
    .eq('id', members[0].id)
    .select();
  assert.equal((updated ?? []).length, 0, 'a displaced person edited their own record directly');
});

/* =============================================================================
   6 · Privilege escalation
   ========================================================================== */

test('displaced A: cannot promote themselves to super admin', async () => {
  const client = await as('displacedA');
  const { data: me } = await client.auth.getUser();

  const { error } = await client
    .from('profiles')
    .update({ role: 'super_admin' })
    .eq('id', me.user.id)
    .select();
  assert.notEqual(error, null, 'a displaced user rewrote their own role');

  const { data: check } = await admin
    .from('profiles')
    .select('role')
    .eq('id', me.user.id)
    .single();
  assert.equal(check.role, 'displaced');
});

test('camp admin A: cannot move themselves to camp B', async () => {
  const client = await as('campAdminA');
  const { data: me } = await client.auth.getUser();

  const { error } = await client
    .from('profiles')
    .update({ camp_id: world.campB.id })
    .eq('id', me.user.id)
    .select();
  assert.notEqual(error, null, 'a camp admin reassigned their own camp');
});

test('sign-up cannot claim a privileged role through user metadata', async () => {
  const email = `escalation-${Date.now()}@example.test`;
  const { data, error } = await anon.auth.signUp({
    email,
    password: 'test-password-123',
    options: { data: { full_name: 'محاولة تصعيد', role: 'super_admin' } },
  });
  assert.equal(error, null, `sign-up failed: ${error?.message}`);

  const { data: profile } = await admin
    .from('profiles')
    .select('role, status')
    .eq('id', data.user.id)
    .single();
  assert.equal(profile.role, 'displaced', 'user_metadata was trusted for the role');
  assert.equal(profile.status, 'pending');

  await admin.auth.admin.deleteUser(data.user.id);
});

test('a second super admin cannot be created', async () => {
  const { data, error: createError } = await admin.auth.admin.createUser({
    email: `second-super-${Date.now()}@example.test`,
    password: 'test-password-123',
    email_confirm: true,
  });
  assert.equal(createError, null);

  const { error } = await admin
    .from('profiles')
    .update({ role: 'super_admin', camp_id: null })
    .eq('id', data.user.id);
  assert.notEqual(error, null, 'the platform accepted a second super admin');

  await admin.auth.admin.deleteUser(data.user.id);
});

/* =============================================================================
   7 · Database-level domain rules
   ========================================================================== */

test('national ID is unique platform-wide, so it cannot exist in two camps', async () => {
  const { data: existing } = await admin
    .from('family_members')
    .select('national_id, camp_id')
    .limit(1)
    .single();

  const { error } = await admin.rpc('create_family_with_members', {
    p_camp_id: world.campB.id,
    p_head: {
      full_name: 'تكرار رقم الهوية',
      gender: 'male',
      national_id: existing.national_id,
    },
  });
  assert.notEqual(error, null, 'the same national ID was registered twice');
  assert.match(error.message, /duplicate key|unique/i);
});

test('orphan status is derived and cannot be written', async () => {
  const { data: member } = await admin.from('family_members').select('id').limit(1).single();
  const { error } = await admin
    .from('family_members')
    .update({ is_orphan: true })
    .eq('id', member.id);
  assert.notEqual(error, null, 'is_orphan accepted a hand-written value');
});

test('orphan status follows the parents’ status', async () => {
  const { data: before } = await admin
    .from('family_members')
    .select('id, is_orphan, father_status, mother_status')
    .eq('is_orphan', false)
    .limit(1)
    .single();

  await admin.from('family_members').update({ father_status: 'deceased' }).eq('id', before.id);
  const { data: after } = await admin
    .from('family_members')
    .select('is_orphan')
    .eq('id', before.id)
    .single();
  assert.equal(after.is_orphan, true);

  await admin
    .from('family_members')
    .update({ father_status: before.father_status })
    .eq('id', before.id);
});

test('maternity flags never land on a male record', async () => {
  const { data: male } = await admin
    .from('family_members')
    .select('id')
    .eq('gender', 'male')
    .limit(1)
    .single();

  await admin.from('family_members').update({ is_pregnant: true }).eq('id', male.id);
  const { data: after } = await admin
    .from('family_members')
    .select('is_pregnant, is_breastfeeding')
    .eq('id', male.id)
    .single();
  assert.equal(after.is_pregnant, null, 'a male record carries a pregnancy flag');
  assert.equal(after.is_breastfeeding, null);
});

test('switching a record to male clears both maternity flags', async () => {
  const { data: female } = await admin
    .from('family_members')
    .select('id, gender, is_pregnant, is_breastfeeding')
    .eq('gender', 'female')
    .limit(1)
    .single();

  await admin.from('family_members').update({ gender: 'male' }).eq('id', female.id);
  const { data: after } = await admin
    .from('family_members')
    .select('is_pregnant, is_breastfeeding')
    .eq('id', female.id)
    .single();
  assert.equal(after.is_pregnant, null);
  assert.equal(after.is_breastfeeding, null);

  await admin
    .from('family_members')
    .update({
      gender: 'female',
      is_pregnant: female.is_pregnant,
      is_breastfeeding: female.is_breastfeeding,
    })
    .eq('id', female.id);
});

test('shelter type accepts only the two approved values', async () => {
  const { data: member } = await admin.from('family_members').select('id').limit(1).single();
  const { error } = await admin
    .from('family_members')
    .update({ tent_type: 'caravan' })
    .eq('id', member.id);
  assert.notEqual(error, null, 'an unapproved shelter type was accepted');
});

test('age bands are cumulative — under_2 includes infants under one', async () => {
  const { data: facts } = await admin
    .from('family_member_facts')
    .select('under_1, under_2, under_3, is_child')
    .not('age_years', 'is', null);

  for (const row of facts) {
    if (row.under_1) assert.ok(row.under_2 && row.under_3 && row.is_child);
    if (row.under_2) assert.ok(row.under_3 && row.is_child);
  }
});

test('a family cannot be left without a head', async () => {
  const { error } = await admin
    .from('families')
    .update({ head_member_id: null })
    .eq('id', world.familyInA.id);
  assert.notEqual(error, null, 'a family was left headless');
});

test('removing the head promotes another member instead of orphaning the family', async () => {
  const { data: familyId } = await admin.rpc('create_family_with_members', {
    p_camp_id: world.campA.id,
    p_head: { full_name: 'رب أسرة مؤقت', gender: 'male', national_id: '999111000', birth_date: '1980-01-01' },
    p_members: [
      { full_name: 'فرد ثانٍ', gender: 'female', national_id: '999111001', birth_date: '1985-01-01' },
    ],
  });

  const { data: family } = await admin
    .from('families')
    .select('head_member_id')
    .eq('id', familyId)
    .single();

  await admin.from('family_members').delete().eq('id', family.head_member_id);

  const { data: after } = await admin
    .from('families')
    .select('head_member_id')
    .eq('id', familyId)
    .single();
  assert.ok(after.head_member_id, 'the family was left headless after removing its head');
  assert.notEqual(after.head_member_id, family.head_member_id);

  await admin.from('families').delete().eq('id', familyId);
});

test('aid carries no monetary value and no individual recipient', async () => {
  const { data: distribution } = await admin
    .from('aid_distributions')
    .select('*')
    .limit(1)
    .single();

  for (const forbidden of ['value', 'price', 'estimated_value', 'displaced_id', 'recipient_id']) {
    assert.ok(!(forbidden in distribution), `aid_distributions still carries "${forbidden}"`);
  }
});

test('documents carry no expiry date', async () => {
  const { data: document } = await admin.from('documents').select('*').limit(1).single();
  for (const forbidden of ['expiry_date', 'expires_at']) {
    assert.ok(!(forbidden in document), `documents still carries "${forbidden}"`);
  }
});

test('no tent, caravan or file number exists anywhere on a person', async () => {
  const { data: member } = await admin.from('family_members').select('*').limit(1).single();
  for (const forbidden of ['tent_number', 'caravan_number', 'file_number', 'current_residence']) {
    assert.ok(!(forbidden in member), `family_members still carries "${forbidden}"`);
  }
});

/* ---- helpers ------------------------------------------------------------- */

function required(...names) {
  for (const name of names) {
    if (process.env[name]) return process.env[name];
  }
  throw new Error(
    `Missing ${names.join(' or ')}. Copy .env.example to .env and fill it in.`
  );
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

// supabase/tests/phase4.17-family-activation-isolation.test.mjs
/**
 * Phase 4.17 security suite: activation-link generation is Camp-Admin-only
 * for the family's own camp (enforced in the database, not merely by
 * `core/auth.js`'s UX-only `can()`); the activation token is unpredictable,
 * single-use, and every rejection reason collapses into the same generic
 * message; the identity check rejects a wrong field or a cross-family
 * combination; a concurrent double-activation of the same token cannot
 * create two accounts; no service-role secret reaches `assets/`.
 *
 *   cd supabase && npm run test:phase4.17-family-activation-isolation
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');

loadDotEnv(resolve(ROOT, '.env'));

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

function required(...names) {
  for (const name of names) {
    if (process.env[name]) return process.env[name];
  }
  throw new Error(`Missing ${names.join(' or ')}. Copy .env.example to .env and fill it in.`);
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const SUPABASE_URL = required('SUPABASE_URL');
const SUPABASE_PUBLISHABLE_KEY = required('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY');
const SUPABASE_SECRET_KEY = required('SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY');

const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/activate-family-account`;
const NOOR_CAMP_ID = '5853adc9-9d23-4d4d-bc32-6fff17bdc3b0'; // مخيم النور — admin@camps.ps
const AMAL_CAMP_ID = '5050e7a6-8f75-4a8a-83cd-ea8566ceaed1'; // مخيم الأمل — raed@camps.ps — a different camp

const service = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

function anonClient() {
  return createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
}

async function clientAs(email, password) {
  const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password });
  assert.equal(error, null, `sign-in for ${email} must succeed: ${error?.message}`);
  return client;
}

function randomNationalId() {
  return String(900000000 + Math.floor(Math.random() * 99999999));
}

/** Disposable family via the real workflow function — never a hand-written insert. */
async function createDisposableFamily(client, campId, { fullName = 'رب أسرة اختبار التفعيل', birthDate = '1985-05-05' } = {}) {
  const nationalId = randomNationalId();
  const { data: familyDbId, error } = await client.rpc('create_family_with_members', {
    p_camp_id: campId,
    p_head: { full_name: fullName, gender: 'male', national_id: nationalId, birth_date: birthDate },
    p_members: [],
    p_notes: 'Phase 4.17 test fixture — safe to delete',
  });
  assert.equal(error, null, `family creation must succeed: ${error?.message}`);

  const { data: family, error: readError } = await service
    .from('families')
    .select('id, reference_code, head_member_id, camp_id')
    .eq('id', familyDbId)
    .single();
  assert.equal(readError, null);

  return { ...family, nationalId, birthDate };
}

async function deleteFamily(familyId) {
  await service.from('families').delete().eq('id', familyId);
}

async function deleteAuthUserByEmail(email) {
  let page = 1;
  for (;;) {
    const { data: list, error } = await service.auth.admin.listUsers({ page, perPage: 200 });
    if (error) return;
    const found = list.users.find((u) => u.email === email);
    if (found) {
      await service.auth.admin.deleteUser(found.id);
      return;
    }
    if (list.users.length < 200) return;
    page += 1;
  }
}

async function assertNoUserFor(email) {
  let page = 1;
  for (;;) {
    const { data: list, error } = await service.auth.admin.listUsers({ page, perPage: 200 });
    assert.equal(error, null);
    assert.equal(
      list.users.find((u) => u.email === email),
      undefined,
      `no auth.users row must exist for ${email}`
    );
    if (list.users.length < 200) return;
    page += 1;
  }
}

function activationEmail() {
  return `phase417-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

async function activate(body) {
  const res = await fetch(FUNCTION_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_PUBLISHABLE_KEY },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

test('Phase 4.17 generate_family_activation_token: authorization boundary', async (t) => {
  const admin = await clientAs('admin@camps.ps', '123456');
  const family = await createDisposableFamily(admin, NOOR_CAMP_ID);

  try {
    await t.test('anonymous cannot generate a link', async () => {
      const { error } = await anonClient().rpc('generate_family_activation_token', { p_family_id: family.id });
      assert.ok(error, 'expected an error for an anonymous caller');
    });

    await t.test('displaced role cannot generate a link (server-side, independent of core/auth.js can())', async () => {
      const ahmad = await clientAs('ahmad@camps.ps', '123456');
      const { error } = await ahmad.rpc('generate_family_activation_token', { p_family_id: family.id });
      assert.equal(error?.code, '42501', `expected insufficient_privilege, got ${JSON.stringify(error)}`);
    });

    await t.test('a camp_admin from a DIFFERENT camp cannot generate a link for this family', async () => {
      const raed = await clientAs('raed@camps.ps', '123456');
      const { error } = await raed.rpc('generate_family_activation_token', { p_family_id: family.id });
      assert.equal(error?.code, '42501', `expected insufficient_privilege, got ${JSON.stringify(error)}`);
    });

    await t.test('the correct camp_admin (own camp) succeeds and returns an unpredictable, hex-encoded token', async () => {
      const { data, error } = await admin.rpc('generate_family_activation_token', { p_family_id: family.id });
      assert.equal(error, null, `expected success: ${error?.message}`);
      const row = data[0];
      assert.match(row.token, /^[0-9a-f]{64}$/, 'token must be 64 hex chars (32 random bytes)');
      const expiresIn = new Date(row.expires_at).getTime() - Date.now();
      assert.ok(expiresIn > 6.9 * 86400 * 1000 && expiresIn < 7.1 * 86400 * 1000, 'default TTL must be ~7 days');
    });

    await t.test('generating a second link revokes the first — the old token is rejected', async () => {
      const { data: first } = await admin.rpc('generate_family_activation_token', { p_family_id: family.id });
      const oldToken = first[0].token;

      const { data: second, error } = await admin.rpc('generate_family_activation_token', { p_family_id: family.id });
      assert.equal(error, null);
      assert.notEqual(second[0].token, oldToken);

      const { error: verifyError } = await admin.rpc('verify_family_activation', {
        p_token: oldToken,
        p_reference_code: family.reference_code,
        p_national_id: family.nationalId,
        p_birth_date: family.birthDate,
      });
      assert.equal(verifyError?.code, '22023', 'a revoked (superseded) token must be rejected');
    });
  } finally {
    await deleteFamily(family.id);
  }
});

test('Phase 4.17 verify_family_activation: identity verification', async (t) => {
  const admin = await clientAs('admin@camps.ps', '123456');
  const anon = anonClient();
  const familyA = await createDisposableFamily(admin, NOOR_CAMP_ID, { fullName: 'رب أسرة أ' });
  const familyB = await createDisposableFamily(admin, NOOR_CAMP_ID, { fullName: 'رب أسرة ب', birthDate: '1990-01-01' });

  try {
    const { data: tokenRow } = await admin.rpc('generate_family_activation_token', { p_family_id: familyA.id });
    const token = tokenRow[0].token;

    await t.test('correct identity succeeds (does not consume the token)', async () => {
      const { data, error } = await anon.rpc('verify_family_activation', {
        p_token: token,
        p_reference_code: familyA.reference_code,
        p_national_id: familyA.nationalId,
        p_birth_date: familyA.birthDate,
      });
      assert.equal(error, null, `expected success: ${error?.message}`);
      assert.equal(data[0].already_activated, false);
    });

    await t.test('wrong national ID fails with the generic message', async () => {
      const { error } = await anon.rpc('verify_family_activation', {
        p_token: token,
        p_reference_code: familyA.reference_code,
        p_national_id: randomNationalId(),
        p_birth_date: familyA.birthDate,
      });
      assert.equal(error?.code, '22023');
      assert.equal(error.message, 'بيانات التفعيل غير صحيحة');
    });

    await t.test('wrong family reference code fails with the SAME generic message', async () => {
      const { error } = await anon.rpc('verify_family_activation', {
        p_token: token,
        p_reference_code: 'FAM-999999',
        p_national_id: familyA.nationalId,
        p_birth_date: familyA.birthDate,
      });
      assert.equal(error?.code, '22023');
      assert.equal(error.message, 'بيانات التفعيل غير صحيحة');
    });

    await t.test('wrong birth date fails', async () => {
      const { error } = await anon.rpc('verify_family_activation', {
        p_token: token,
        p_reference_code: familyA.reference_code,
        p_national_id: familyA.nationalId,
        p_birth_date: '2000-01-01',
      });
      assert.equal(error?.code, '22023');
    });

    await t.test('a valid cross-family combination (family B\'s real data against family A\'s token) fails', async () => {
      const { error } = await anon.rpc('verify_family_activation', {
        p_token: token,
        p_reference_code: familyB.reference_code,
        p_national_id: familyB.nationalId,
        p_birth_date: familyB.birthDate,
      });
      assert.equal(error?.code, '22023', 'family B\'s own correct data must not activate family A\'s token');
    });

    await t.test('invalid/garbage token fails', async () => {
      const { error } = await anon.rpc('verify_family_activation', {
        p_token: 'not-a-real-token',
        p_reference_code: familyA.reference_code,
        p_national_id: familyA.nationalId,
        p_birth_date: familyA.birthDate,
      });
      assert.equal(error?.code, '22023');
    });

    await t.test('empty token fails', async () => {
      const { error } = await anon.rpc('verify_family_activation', {
        p_token: '',
        p_reference_code: familyA.reference_code,
        p_national_id: familyA.nationalId,
        p_birth_date: familyA.birthDate,
      });
      assert.equal(error?.code, '22023');
    });
  } finally {
    await deleteFamily(familyA.id);
    await deleteFamily(familyB.id);
  }
});

test('Phase 4.17 activate-family-account: token lifecycle end-to-end', async (t) => {
  const admin = await clientAs('admin@camps.ps', '123456');
  const family = await createDisposableFamily(admin, NOOR_CAMP_ID);
  let createdEmail = null;
  let usedToken = null;

  try {
    await t.test('expired token is rejected', async () => {
      const { data } = await admin.rpc('generate_family_activation_token', {
        p_family_id: family.id,
        p_ttl_seconds: 1,
      });
      const token = data[0].token;
      await new Promise((r) => setTimeout(r, 1500));
      const email = activationEmail();
      const { status, json } = await activate({
        token,
        referenceCode: family.reference_code,
        nationalId: family.nationalId,
        birthDate: family.birthDate,
        email,
        password: 'Fixture123!',
      });
      assert.equal(status, 400, JSON.stringify(json));
      assert.equal(json.error.message, 'بيانات التفعيل غير صحيحة');
      await assertNoUserFor(email);
    });

    await t.test('revoked token is rejected', async () => {
      const { data } = await admin.rpc('generate_family_activation_token', { p_family_id: family.id });
      const token = data[0].token;
      // Generating again revokes this one.
      await admin.rpc('generate_family_activation_token', { p_family_id: family.id });
      const email = activationEmail();
      const { status } = await activate({
        token,
        referenceCode: family.reference_code,
        nationalId: family.nationalId,
        birthDate: family.birthDate,
        email,
        password: 'Fixture123!',
      });
      assert.equal(status, 400);
      await assertNoUserFor(email);
    });

    await t.test('missing/weak fields are rejected without touching the database', async () => {
      const { data } = await admin.rpc('generate_family_activation_token', { p_family_id: family.id });
      const token = data[0].token;
      const email = activationEmail();

      const weakPassword = await activate({
        token,
        referenceCode: family.reference_code,
        nationalId: family.nationalId,
        birthDate: family.birthDate,
        email,
        password: '123',
      });
      assert.equal(weakPassword.status, 400);

      const badEmail = await activate({
        token,
        referenceCode: family.reference_code,
        nationalId: family.nationalId,
        birthDate: family.birthDate,
        email: 'not-an-email',
        password: 'Fixture123!',
      });
      assert.equal(badEmail.status, 400);
      await assertNoUserFor(email);
    });

    await t.test('a valid token + correct identity creates exactly one linked, approved, displaced account', async () => {
      const { data } = await admin.rpc('generate_family_activation_token', { p_family_id: family.id });
      const token = data[0].token;
      usedToken = token;
      const email = activationEmail();
      createdEmail = email;

      const { status, json } = await activate({
        token,
        referenceCode: family.reference_code,
        nationalId: family.nationalId,
        birthDate: family.birthDate,
        email,
        password: 'Fixture123!',
      });
      assert.equal(status, 201, JSON.stringify(json));

      const { data: authUsers } = await service.auth.admin.listUsers({ page: 1, perPage: 200 });
      const authUser = authUsers.users.find((u) => u.email === email);
      assert.ok(authUser, 'the Auth account must exist');

      const { data: profile, error } = await service
        .from('profiles')
        .select('role, status, camp_id, family_member_id')
        .eq('id', authUser.id)
        .single();
      assert.equal(error, null);
      assert.equal(profile.role, 'displaced');
      assert.equal(profile.status, 'approved');
      assert.equal(profile.camp_id, NOOR_CAMP_ID);
      assert.equal(profile.family_member_id, family.head_member_id);
    });

    await t.test('the SAME (now-used) token is rejected on reuse, with the generic message, no new account', async () => {
      const { data } = await admin.rpc('get_family_activation_status', { p_family_id: family.id });
      assert.equal(data[0].state, 'activated');

      const reuseEmail = activationEmail();
      const { status, json } = await activate({
        token: usedToken,
        referenceCode: family.reference_code,
        nationalId: family.nationalId,
        birthDate: family.birthDate,
        email: reuseEmail,
        password: 'Fixture123!',
      });
      // Rejected by verify_family_activation's used_at check, which fires
      // BEFORE the already_activated check — so this is the generic
      // message, not 409 already_activated (design doc §4/§6).
      assert.equal(status, 400, JSON.stringify(json));
      assert.equal(json.error.message, 'بيانات التفعيل غير صحيحة');
      await assertNoUserFor(reuseEmail);
    });

    await t.test('consume_family_activation itself rejects an unrelated/bogus token — service_role-only path is not a bypass', async () => {
      const { error } = await service.rpc('consume_family_activation', {
        p_token: 'irrelevant-since-hash-wont-match',
        p_new_user_id: '00000000-0000-0000-0000-000000000000',
      });
      assert.ok(error, 'a bogus token must never be accepted by consume_family_activation');
    });

    await t.test('a second activation attempt on the now-activated family is rejected as already_activated', async () => {
      const { data } = await admin.rpc('generate_family_activation_token', { p_family_id: family.id });
      const token = data[0].token;
      const secondEmail = activationEmail();

      const { status, json } = await activate({
        token,
        referenceCode: family.reference_code,
        nationalId: family.nationalId,
        birthDate: family.birthDate,
        email: secondEmail,
        password: 'Fixture123!',
      });
      assert.equal(status, 409, JSON.stringify(json));
      assert.equal(json.error.code, 'already_activated');
      await assertNoUserFor(secondEmail);
    });
  } finally {
    if (createdEmail) await deleteAuthUserByEmail(createdEmail);
    await deleteFamily(family.id);
  }
});

test('Phase 4.17 concurrency: two simultaneous activations of the same token create only one account', async (t) => {
  const admin = await clientAs('admin@camps.ps', '123456');
  const family = await createDisposableFamily(admin, NOOR_CAMP_ID, { fullName: 'رب أسرة اختبار السباق' });
  const emailA = activationEmail();
  const emailB = activationEmail();

  try {
    const { data } = await admin.rpc('generate_family_activation_token', { p_family_id: family.id });
    const token = data[0].token;

    const [resultA, resultB] = await Promise.all([
      activate({
        token,
        referenceCode: family.reference_code,
        nationalId: family.nationalId,
        birthDate: family.birthDate,
        email: emailA,
        password: 'Fixture123!',
      }),
      activate({
        token,
        referenceCode: family.reference_code,
        nationalId: family.nationalId,
        birthDate: family.birthDate,
        email: emailB,
        password: 'Fixture123!',
      }),
    ]);

    const statuses = [resultA.status, resultB.status].sort();
    assert.ok(
      statuses[0] === 201 || statuses[0] === 400 || statuses[0] === 409,
      `unexpected status pair: ${JSON.stringify(statuses)}`
    );
    const successCount = [resultA, resultB].filter((r) => r.status === 201).length;
    assert.equal(successCount, 1, `exactly one concurrent activation must win, got ${successCount}: ${JSON.stringify([resultA, resultB])}`);

    const { data: profiles } = await service
      .from('profiles')
      .select('id')
      .eq('family_member_id', family.head_member_id);
    assert.equal(profiles.length, 1, 'exactly one profile must be linked to this head, never two');
  } finally {
    await deleteAuthUserByEmail(emailA);
    await deleteAuthUserByEmail(emailB);
    await deleteFamily(family.id);
  }
});

test('Phase 4.17: no service-role secret in any browser-reachable file', async () => {
  const assetsDir = resolve(ROOT, 'assets');
  const files = walk(assetsDir).filter((f) => ['.js', '.html', '.css'].includes(extname(f)));
  const secretFragment = SUPABASE_SECRET_KEY.slice(0, 20);
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    assert.ok(!content.includes(secretFragment), `${file} must not contain the service-role key`);
    assert.ok(!/SUPABASE_SERVICE_ROLE_KEY/.test(content), `${file} must not reference SUPABASE_SERVICE_ROLE_KEY`);
  }
});

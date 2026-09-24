// supabase/tests/phase4.11-camp-admin-creation-security.test.mjs
/**
 * Phase 4.11 security suite: proves the admin-create-camp-admin Edge
 * Function enforces its own authorization independently of any frontend
 * code — super_admin only, every other caller rejected with zero rows
 * created — plus role-tampering, invalid-camp, and secret-leakage checks.
 *
 *   cd supabase && npm run test:phase4.11-camp-admin-creation-security
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

const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/admin-create-camp-admin`;
const NOOR_CAMP_ID = '5853adc9-9d23-4d4d-bc32-6fff17bdc3b0'; // مخيم النور

async function signInToken(email, password) {
  const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  assert.equal(error, null, `sign-in for ${email} must succeed: ${error?.message}`);
  return data.session.access_token;
}

async function invoke(token, body) {
  const res = await fetch(FUNCTION_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_PUBLISHABLE_KEY,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

function validBody(overrides = {}) {
  return {
    fullName: 'مسؤول اختبار الأمان',
    email: `phase411-sec-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
    phone: '0599999999',
    password: 'Fixture123!',
    campId: NOOR_CAMP_ID,
    status: 'active',
    ...overrides,
  };
}

async function findAuthUserByEmail(serviceClient, email) {
  let page = 1;
  for (;;) {
    const { data: list, error } = await serviceClient.auth.admin.listUsers({ page, perPage: 200 });
    assert.equal(error, null, `listUsers must succeed: ${error?.message}`);
    const found = list.users.find((u) => u.email === email);
    if (found) return found;
    if (list.users.length < 200) return null;
    page += 1;
  }
}

async function assertNoUserFor(serviceClient, email) {
  const found = await findAuthUserByEmail(serviceClient, email);
  assert.equal(found, null, `no auth.users row must exist for ${email}`);
}

async function cleanup(serviceClient, id) {
  if (!id) return;
  await serviceClient.from('profiles').delete().eq('id', id);
  await serviceClient.auth.admin.deleteUser(id).catch(() => {});
}

test('Phase 4.11 admin-create-camp-admin: authorization boundary', async (t) => {
  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

  await t.test('anonymous (no token) is rejected, no user created', async () => {
    const body = validBody();
    const { status } = await invoke(null, body);
    assert.ok(status === 401 || status === 403, `expected 401/403, got ${status}`);
    await assertNoUserFor(serviceClient, body.email);
  });

  await t.test('malformed bearer token is rejected, no user created', async () => {
    const body = validBody();
    const res = await fetch(FUNCTION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: 'Bearer not-a-real-token' },
      body: JSON.stringify(body),
    });
    assert.ok(res.status === 401 || res.status === 403, `expected 401/403, got ${res.status}`);
    await assertNoUserFor(serviceClient, body.email);
  });

  await t.test('camp_admin caller is rejected, no user created', async () => {
    const token = await signInToken('admin@camps.ps', '123456');
    const body = validBody();
    const { status, json } = await invoke(token, body);
    assert.equal(status, 403, `expected 403, got ${status}: ${JSON.stringify(json)}`);
    await assertNoUserFor(serviceClient, body.email);
  });

  await t.test('displaced caller is rejected, no user created', async () => {
    const token = await signInToken('ahmad@camps.ps', '123456');
    const body = validBody();
    const { status, json } = await invoke(token, body);
    assert.equal(status, 403, `expected 403, got ${status}: ${JSON.stringify(json)}`);
    await assertNoUserFor(serviceClient, body.email);
  });

  await t.test('super_admin caller succeeds and creates exactly the requested camp_admin', async () => {
    const token = await signInToken('super@camps.ps', '123456');
    const body = validBody();
    const { status, json } = await invoke(token, body);
    assert.equal(status, 201, `expected 201, got ${status}: ${JSON.stringify(json)}`);
    assert.equal(json.admin.email, body.email);

    const { data: profile, error } = await serviceClient
      .from('profiles')
      .select('role, status, camp_id')
      .eq('id', json.admin.id)
      .single();
    assert.equal(error, null);
    assert.equal(profile.role, 'camp_admin');
    assert.equal(profile.camp_id, NOOR_CAMP_ID);

    await cleanup(serviceClient, json.admin.id);
  });

  await t.test('role tampering in the request body is ignored — created role is always camp_admin', async () => {
    const token = await signInToken('super@camps.ps', '123456');
    const body = validBody({ role: 'super_admin', app_role: 'super_admin' });
    const { status, json } = await invoke(token, body);
    assert.equal(status, 201, `expected 201, got ${status}: ${JSON.stringify(json)}`);

    const { data: profile } = await serviceClient.from('profiles').select('role').eq('id', json.admin.id).single();
    assert.equal(profile.role, 'camp_admin', 'role tampering must never produce anything but camp_admin');

    await cleanup(serviceClient, json.admin.id);
  });

  await t.test('invalid campId (malformed UUID) is rejected, no user created', async () => {
    const token = await signInToken('super@camps.ps', '123456');
    const body = validBody({ campId: 'not-a-uuid' });
    const { status, json } = await invoke(token, body);
    assert.equal(status, 400, `expected 400, got ${status}: ${JSON.stringify(json)}`);
    assert.equal(json.error.code, 'validation');
    await assertNoUserFor(serviceClient, body.email);
  });

  await t.test('nonexistent campId (well-formed UUID) is rejected, no user created', async () => {
    const token = await signInToken('super@camps.ps', '123456');
    const body = validBody({ campId: '00000000-0000-0000-0000-000000000000' });
    const { status, json } = await invoke(token, body);
    assert.equal(status, 400, `expected 400, got ${status}: ${JSON.stringify(json)}`);
    await assertNoUserFor(serviceClient, body.email);
  });

  await t.test('missing required fields are rejected one at a time', async () => {
    const token = await signInToken('super@camps.ps', '123456');
    for (const field of ['fullName', 'email', 'phone', 'password', 'campId', 'status']) {
      const body = validBody();
      delete body[field];
      const { status, json } = await invoke(token, body);
      assert.equal(status, 400, `missing ${field} must be rejected, got ${status}: ${JSON.stringify(json)}`);
    }
  });

  await t.test('malformed JSON body is rejected', async () => {
    const token = await signInToken('super@camps.ps', '123456');
    const res = await fetch(FUNCTION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}` },
      body: '{not json',
    });
    assert.equal(res.status, 400);
  });

  await t.test('a valid-JSON but non-object body (null) is rejected with a clean validation error, not a 500', async () => {
    const token = await signInToken('super@camps.ps', '123456');
    for (const payload of ['null', '42', '"a string"', '[]']) {
      const res = await fetch(FUNCTION_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}` },
        body: payload,
      });
      const json = await res.json().catch(() => null);
      assert.equal(res.status, 400, `payload ${payload} must be rejected with 400, got ${res.status}: ${JSON.stringify(json)}`);
      assert.equal(json?.error?.code, 'validation', `payload ${payload} must map to a validation error, got: ${JSON.stringify(json)}`);
    }
  });

  await t.test('OPTIONS preflight succeeds without authentication', async () => {
    const res = await fetch(FUNCTION_URL, { method: 'OPTIONS' });
    assert.ok(res.status < 300, `OPTIONS must succeed, got ${res.status}`);
  });

  await t.test('duplicate email is rejected with code=duplicate, no second auth.users row', async () => {
    const token = await signInToken('super@camps.ps', '123456');
    const body = validBody();
    const first = await invoke(token, body);
    assert.equal(first.status, 201, `first create must succeed: ${JSON.stringify(first.json)}`);

    const second = await invoke(token, body);
    assert.equal(second.status, 409, `duplicate create must be rejected, got ${second.status}: ${JSON.stringify(second.json)}`);
    assert.equal(second.json.error.code, 'duplicate');

    const authUser = await findAuthUserByEmail(serviceClient, body.email);
    assert.ok(authUser, 'the original account must still exist');

    await cleanup(serviceClient, first.json.admin.id);
  });
});

test('Phase 4.11: no service-role secret in any browser-reachable file', async () => {
  const assetsDir = resolve(ROOT, 'assets');
  const files = walk(assetsDir).filter((f) => ['.js', '.html', '.css'].includes(extname(f)));
  const secretFragment = SUPABASE_SECRET_KEY.slice(0, 20); // enough to prove presence without logging the whole key
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    assert.ok(!content.includes(secretFragment), `${file} must not contain the service-role key`);
    assert.ok(!/SUPABASE_SERVICE_ROLE_KEY/.test(content), `${file} must not reference SUPABASE_SERVICE_ROLE_KEY`);
  }
});

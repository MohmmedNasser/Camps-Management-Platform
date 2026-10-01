/**
 * Phase 4.29: password-policy floor, explicit global sign-out, and one age rule across browser and database.
 *
 *  A. Password policy — the two account-creating Edge Functions (live) and the browser validator all
 *     refuse a password shorter than 8; an 8-character one gets past that check; existing short-password
 *     accounts still sign in (the policy applies only to NEW passwords).
 *  B. Sign-out — `assets/js/supabase/auth.js` signs out with scope 'global', and that really does revoke
 *     the account's other sessions, while scope 'local' (the contrast case) leaves them alone.
 *  C. Age — `ageFrom` (the browser fallback) is "completed years as of the UTC calendar day", equal to the
 *     database's `age_in_years(dob, on)` across birthday boundaries, independent of the browser timezone
 *     (proven in child processes started with extreme TZ values), and the live statistics report's child
 *     count equals an independent calculation from the raw rows.
 *
 *   cd supabase && npm run frontend:config && npm run test:phase4.29-hardening
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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
const anonClient = () => createClient(URL_, ANON, { auth: { persistSession: false } });

async function signedIn(email, password = '123456') {
  const client = anonClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  assert.equal(error, null, `${email}: ${error?.message}`);
  return { client, session: data.session };
}

const FN = (slug) => `${URL_}/functions/v1/${slug}`;
async function callFunction(slug, body, token = ANON) {
  const res = await fetch(FN(slug), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON, Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, message: json?.error?.message ?? '' };
}

/* ---- A. Password policy ---------------------------------------------------- */

test('A. password policy: browser validator, live Edge Functions, existing accounts', async (t) => {
  const { rules, PASSWORD_MIN_LENGTH } = await load('assets/js/utils/validators.js');

  await t.test('PASSWORD_MIN_LENGTH is 8 and rules.password() enforces it by default', () => {
    assert.equal(PASSWORD_MIN_LENGTH, 8);
    assert.notEqual(rules.password()('1234567'), '');
    assert.match(rules.password()('1234567'), /8/);
    assert.equal(rules.password()('12345678'), '');
    assert.equal(rules.password()(''), '', 'empty is left to the required rule');
  });

  await t.test('no page still hard-codes the old minimum of 6', () => {
    for (const file of ['pages/activate-family.js', 'pages/profile.js', 'pages/register.js', 'pages/reset-password.js', 'ui/record-forms.js']) {
      const src = readFileSync(resolve(ROOT, 'assets/js', file), 'utf8');
      assert.ok(!/rules\.password\(\s*6\s*\)/.test(src), `${file} still passes 6`);
      assert.ok(!src.includes("'6 أحرف"), `${file} still tells the user 6 characters`);
    }
  });

  await t.test('activate-family-account (anonymous, live): 7 chars refused on length, 8 passes the length check', async () => {
    const base = { token: 'x'.repeat(24), referenceCode: 'FAM-000001', nationalId: '123456789', birthDate: '1990-01-01', email: 'phase429@example.com' };
    const short = await callFunction('activate-family-account', { ...base, password: '1234567' });
    assert.equal(short.status, 400);
    assert.match(short.message, /8/, 'the rejection names the 8-character minimum');
    const ok = await callFunction('activate-family-account', { ...base, password: '12345678' });
    assert.equal(ok.status, 400, 'the fabricated token is still rejected');
    assert.doesNotMatch(ok.message, /أحرف/, 'but no longer because of the password length');
  });

  await t.test('admin-create-camp-admin (super admin, live): 7 chars refused; 8 passes the length check without creating anything', async () => {
    const { session } = await signedIn('super@camps.ps');
    const body = { fullName: 'اختبار كلمة المرور', email: 'phase429-never@example.com', phone: '0599000000', campId: 'not-a-uuid', status: 'active' };
    const short = await callFunction('admin-create-camp-admin', { ...body, password: '1234567' }, session.access_token);
    assert.equal(short.status, 400);
    assert.match(short.message, /8/);
    const ok = await callFunction('admin-create-camp-admin', { ...body, password: '12345678' }, session.access_token);
    assert.equal(ok.status, 400);
    assert.doesNotMatch(ok.message, /أحرف على الأقل/, 'got past the password check, stopped at the (deliberately invalid) camp id');
    const { data } = await service.auth.admin.listUsers({ page: 1, perPage: 200 });
    assert.ok(!data.users.some((u) => u.email === 'phase429-never@example.com'), 'no account was created');
  });

  await t.test('existing accounts with short passwords still sign in (policy is for new passwords only)', async () => {
    for (const email of ['admin@camps.ps', 'super@camps.ps', 'ahmad@camps.ps']) await signedIn(email, '123456');
  });
});

/* ---- B. Sign-out scope ------------------------------------------------------ */

test('B. sign-out is global and says so', async (t) => {
  await t.test('auth.js passes scope: global explicitly', () => {
    const src = readFileSync(resolve(ROOT, 'assets/js/supabase/auth.js'), 'utf8');
    assert.match(src, /signOut\(\{ scope: 'global' \}\)/);
  });

  await t.test('global sign-out on one device revokes the same account\'s other session', async () => {
    const a = await signedIn('ahmad@camps.ps');
    const b = await signedIn('ahmad@camps.ps');
    assert.equal((await b.client.auth.refreshSession()).error, null, 'device B is healthy before');
    const { error } = await a.client.auth.signOut({ scope: 'global' });
    assert.equal(error, null);
    const refreshed = await b.client.auth.refreshSession();
    assert.notEqual(refreshed.error, null, 'device B was revoked');
  });

  await t.test('contrast: local sign-out leaves the other session alone', async () => {
    const a = await signedIn('ahmad@camps.ps');
    const b = await signedIn('ahmad@camps.ps');
    await a.client.auth.signOut({ scope: 'local' });
    const refreshed = await b.client.auth.refreshSession();
    assert.equal(refreshed.error, null, 'device B survives a local sign-out');
    await b.client.auth.signOut({ scope: 'global' });
  });
});

/* ---- C. One age rule -------------------------------------------------------- */

const utcDay = (instant) => instant.toISOString().slice(0, 10);
const BIRTHS = ['2008-09-28', '2008-09-29', '2008-09-30', '2008-10-01', '2025-09-29', '2026-09-29', '2008-02-29', '1979-09-28', '2000-12-31', '2000-01-01'];
const INSTANTS = ['2026-09-29T00:00:00Z', '2026-09-29T23:59:59Z', '2026-09-30T00:00:00Z', '2026-09-29T23:30:00Z', '2028-02-29T12:00:00Z', '2026-03-01T00:30:00Z', '2026-02-28T23:30:00Z', '2026-12-31T23:59:59Z', '2027-01-01T00:00:00Z'];

async function dbAge(birth, on) {
  const { data, error } = await service.rpc('age_in_years', { p_birth_date: birth, p_on: on });
  assert.equal(error, null, error?.message);
  return data;
}

test('C. browser age == database age on the UTC calendar day', async (t) => {
  const { ageFrom } = await load('assets/js/utils/format.js');

  await t.test('birthday today / tomorrow / yesterday, leap day, midnight edges: ageFrom equals age_in_years', async () => {
    for (const instant of INSTANTS) {
      const now = new Date(instant);
      // A birth date after "today" is invalid input (validators reject it), and Postgres truncates its
      // negative age toward zero where ageFrom floors — so the comparison covers real birth dates only.
      for (const birth of BIRTHS.filter((b) => b <= utcDay(now))) {
        assert.equal(ageFrom(birth, now), await dbAge(birth, utcDay(now)), `${birth} on ${instant}`);
      }
    }
  });

  await t.test('named boundaries', () => {
    assert.equal(ageFrom('2008-09-29', new Date('2026-09-28T23:59:59Z')), 17, 'birthday tomorrow');
    assert.equal(ageFrom('2008-09-29', new Date('2026-09-29T00:00:00Z')), 18, 'birthday today');
    assert.equal(ageFrom('2008-09-29', new Date('2026-09-30T12:00:00Z')), 18, 'birthday yesterday');
    assert.equal(ageFrom('2008-02-29', new Date('2026-02-28T12:00:00Z')), 17, 'leap-day baby, day before');
    assert.equal(ageFrom('2008-02-29', new Date('2026-03-01T00:00:00Z')), 18, 'leap-day baby, day after');
    assert.equal(ageFrom('2008-02-29', new Date('2028-02-29T00:00:00Z')), 20, 'leap-day baby on a leap birthday');
    assert.equal(ageFrom(null), null);
  });

  await t.test('the answer does not depend on the browser timezone (extreme zones, child processes)', async () => {
    const formatUrl = pathToFileURL(resolve(ROOT, 'assets/js/utils/format.js')).href;
    const script = `
      const { ageFrom, formatAge } = await import(${JSON.stringify(formatUrl)});
      const out = {};
      for (const i of ${JSON.stringify(INSTANTS)}) for (const b of ${JSON.stringify(BIRTHS)}) out[b + '@' + i] = ageFrom(b, new Date(i));
      console.log(JSON.stringify(out));`;
    const reference = {};
    for (const i of INSTANTS) for (const b of BIRTHS) reference[`${b}@${i}`] = ageFrom(b, new Date(i));
    for (const tz of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Asia/Gaza', 'America/Los_Angeles', 'UTC']) {
      const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
      assert.deepEqual(JSON.parse(stdout), reference, `TZ=${tz}`);
    }
  });

  await t.test('formatAge reads the same rule (no second, local-time copy of it)', async () => {
    const { formatAge } = await load('assets/js/utils/format.js');
    const dob = new Date(Date.now() - 20.5 * 365.25 * 864e5).toISOString().slice(0, 10);
    assert.equal(formatAge(dob), `${ageFrom(dob)} سنة`);
    assert.equal(formatAge(null), '—');
  });

  await t.test('live statistics report: children count equals an independent calculation from the raw rows', async () => {
    const { client } = await signedIn('super@camps.ps');
    const { data: report, error } = await client.rpc('get_statistics_report', { p_tz: 'UTC' });
    assert.equal(error, null, error?.message);
    const { data: members, error: mErr } = await service.from('family_members').select('birth_date');
    assert.equal(mErr, null);
    const now = new Date();
    const expected = members.filter((m) => m.birth_date && ageFrom(m.birth_date, now) < 18).length;
    const reported = report.stats.children;
    assert.equal(Number(reported), expected, `report children=${reported}, independent=${expected}`);
  });
});

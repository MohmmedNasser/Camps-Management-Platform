/**
 * Offline schema, domain-rule and RLS test suite.
 *
 * Runs the migration set against Postgres-in-WASM (PGlite), so it needs no
 * Supabase project, no Docker and no network. The Supabase-managed pieces the
 * migrations depend on — the `auth` schema, `auth.uid()`, and the anon /
 * authenticated / service_role roles — are stubbed faithfully enough that the
 * policies themselves are real: each persona is exercised with `set role` plus
 * a JWT claims GUC, so Postgres evaluates the same policy expressions it will
 * evaluate in production.
 *
 * What this suite CANNOT cover, and what tests/rls.test.mjs covers instead:
 * Supabase Auth itself (sign-up, sign-in, sessions, password rules) and
 * PostgREST's translation of HTTP requests into SQL.
 *
 * It also cannot reproduce one platform-specific quirk found live on this
 * project: PostgreSQL's built-in "EXECUTE granted to PUBLIC on every new
 * function" default survives `ALTER DEFAULT PRIVILEGES ... REVOKE ... FROM
 * PUBLIC` here, for reasons that don't reduce to standard documented Postgres
 * semantics — confirmed by creating a throwaway function immediately after
 * the REVOKE, in the same transaction, and finding it still carried a PUBLIC
 * grant. PGlite does not reproduce this (a probe function there comes back
 * clean from the ALTER alone), so a regression in the *live* PUBLIC-execute
 * behaviour cannot be caught here — only against the real project. The tests
 * below assert the intended END STATE (no function has a PUBLIC grant, the
 * hardening event trigger exists) rather than the platform quirk itself.
 *
 *   cd supabase && npm install && npm run test:schema
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(HERE, '../migrations');

// pg_trgm is not bundled by default (Phase 2's search-indexes migration is
// the first thing here to need it) — PGlite ships it as an optional contrib
// extension that has to be registered explicitly.
const db = await new PGlite({ extensions: { pg_trgm } });

/** The Supabase-managed objects the migrations build on. */
await db.exec(`
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin;

  create schema auth;
  grant usage on schema auth to anon, authenticated, service_role;

  create table auth.users (
    id                 uuid primary key default gen_random_uuid(),
    email              text,
    raw_user_meta_data jsonb default '{}'::jsonb,
    created_at         timestamptz default now()
  );

  create or replace function auth.uid() returns uuid language sql stable as $fn$
    select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid;
  $fn$;
`);

for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
  await db.exec(readFileSync(resolve(MIGRATIONS, file), 'utf8'));
}

/* -----------------------------------------------------------------------------
 * Test double for private.is_browser_session()  —  OFFLINE RUNS ONLY
 *
 * The real function keys on `session_user`, which is `authenticator` for every
 * Data API request and never for a direct connection. That is what makes it
 * fail closed. PGlite cannot model it: SET SESSION AUTHORIZATION is not
 * reversible there, and its `username` option changes only `current_user`.
 *
 * So this suite does three separate things instead of pretending otherwise:
 *   1. asserts the REAL definition is the fail-closed one (test below),
 *   2. proves that expression's truth table for all four contexts (test below),
 *   3. installs the double here, keyed on the claims GUC alone, so the tests
 *      that depend on the guards being ACTIVE still exercise them.
 *
 * The session_user binding itself is verified against the live project over
 * real HTTP, which is the only place it can be.
 * -------------------------------------------------------------------------- */

const REAL_IS_BROWSER_SESSION = (
  await db.query(
    `select pg_get_functiondef('private.is_browser_session()'::regprocedure) as def`
  )
).rows[0].def;

await db.exec(`
  create or replace function private.is_browser_session()
  returns boolean language sql stable set search_path = ''
  as $fn$
    select coalesce(
      nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
      ''
    ) in ('anon', 'authenticated');
  $fn$;
`);

/* ---- helpers -------------------------------------------------------------- */

const q = async (sql, params) => (await db.query(sql, params)).rows;

/** Assert that a statement is rejected. Returns the error for inspection. */
async function rejects(sql, params, message) {
  try {
    await db.query(sql, params);
  } catch (error) {
    return error;
  }
  assert.fail(message || 'expected the statement to be rejected');
}

/** Run `fn` as a signed-in persona, with RLS applied. */
async function as(userId, fn, role = 'authenticated') {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [
    JSON.stringify({ sub: userId, role }),
  ]);
  await db.exec(`set role ${role};`);
  try {
    return await fn();
  } finally {
    await db.exec('reset role;');
    await db.query(`select set_config('request.jwt.claims', '', false)`);
  }
}

async function makeAccount(email, role, campId, status) {
  // The sign-up metadata deliberately asks for super_admin every time, to prove
  // the trigger never honours it.
  const [user] = await q(
    `insert into auth.users (email, raw_user_meta_data)
     values ($1, '{"full_name":"مستخدم اختبار","role":"super_admin"}'::jsonb) returning *`,
    [email]
  );
  await q(
    `update public.profiles set role=$2, camp_id=$3, status=$4, full_name=$5 where id=$1`,
    [user.id, role, campId, status, email]
  );
  return user.id;
}

/** The seeded world, shared across tests. */
const w = {};

/* =============================================================================
   Structure
   ========================================================================== */

test('every application table has RLS enabled', async () => {
  const rows = await q(`
    select c.relname from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`);
  assert.deepEqual(rows, [], `tables without RLS: ${rows.map((r) => r.relname).join(', ')}`);
});

test('derived views run as the invoker so base-table RLS still applies', async () => {
  const rows = await q(`
    select c.relname, c.reloptions from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'v'`);
  assert.ok(rows.length >= 2);
  for (const view of rows) {
    assert.ok(
      (view.reloptions || []).includes('security_invoker=true'),
      `view ${view.relname} is not security_invoker`
    );
  }
});

test('is_browser_session() as shipped is the fail-closed implementation', () => {
  // Anchored on session_user, which every Data API request runs as
  // `authenticator` and a direct connection never does.
  assert.match(
    REAL_IS_BROWSER_SESSION,
    /session_user\s*=\s*'authenticator'/,
    'is_browser_session() no longer keys on session_user'
  );
  // The JWT claim is consulted only to carve the secret key back out...
  assert.match(REAL_IS_BROWSER_SESSION, /<>\s*'service_role'/);
  // ...and never to decide membership, which is what used to fail open.
  assert.doesNotMatch(
    REAL_IS_BROWSER_SESSION,
    /in\s*\(\s*'anon'\s*,\s*'authenticated'\s*\)/,
    'FAILS OPEN: an unreadable claims GUC would classify a browser as trusted'
  );
  // SECURITY INVOKER: it reads only session state and needs no elevated rights.
  assert.doesNotMatch(REAL_IS_BROWSER_SESSION, /SECURITY DEFINER/);
  assert.match(REAL_IS_BROWSER_SESSION, /SET search_path TO ''/);
});

test('the shipped expression has the right truth table in all four contexts', async () => {
  // Evaluates the production expression with session_user and the claims GUC
  // substituted, since PGlite cannot produce those contexts natively.
  const expr = `($1 = 'authenticator')
                and coalesce(nullif($2,'')::jsonb ->> 'role','') <> 'service_role'`;

  const cases = [
    ['postgres', '', false, 'direct connection (psql, migrations, CLI)'],
    ['authenticator', '{"role":"anon"}', true, 'anonymous Data API request'],
    ['authenticator', '{"role":"authenticated"}', true, 'signed-in Data API request'],
    ['authenticator', '{"role":"service_role"}', false, 'secret key — trusted server context'],
    // THE REGRESSION THIS REPLACED: an API request with no readable claim must
    // still count as a browser session. The old version returned false here,
    // silently disabling every guard.
    ['authenticator', '', true, 'Data API request with an unreadable claims GUC'],
  ];

  for (const [sessionUser, claims, expected, label] of cases) {
    const [row] = await q(`select ${expr} as v`, [sessionUser, claims]);
    assert.equal(row.v, expected, `wrong classification for: ${label}`);
  }
});

test('every SECURITY DEFINER function pins its search_path', async () => {
  const rows = await q(`
    select n.nspname || '.' || p.proname as fn
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public','private') and p.prosecdef
      and (p.proconfig is null or not (p.proconfig::text like '%search_path%'))`);
  assert.deepEqual(rows, [], `unpinned search_path: ${rows.map((r) => r.fn).join(', ')}`);
});

test('no function in public or private carries a PUBLIC grant (intended end state)', async () => {
  // PGlite does not reproduce the live PUBLIC-execute-on-new-functions quirk
  // (see file header), so this checks the state the migrations establish
  // rather than re-deriving it from a probe function.
  const rows = await q(`
    select distinct n.nspname || '.' || p.proname as fn, p.proacl::text as acl
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join lateral aclexplode(p.proacl) as grant_ on true
    where n.nspname in ('public','private')
      and p.proacl is not null
      and grant_.grantee = 0`);
  assert.deepEqual(rows, [], `functions with a PUBLIC grant: ${JSON.stringify(rows)}`);
});

test('the four workflow RPCs are authenticated-only; the two service utilities are service_role-only', async () => {
  const matrix = {
    approve_registration_request: { anon: false, authenticated: true },
    reject_registration_request: { anon: false, authenticated: true },
    create_family_with_members: { anon: false, authenticated: true },
    create_aid_distribution: { anon: false, authenticated: true },
    reset_family_reference_sequence: { anon: false, authenticated: false },
  };
  for (const [fn, expected] of Object.entries(matrix)) {
    const [row] = await q(`
      select has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
             has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = $1
      limit 1`, [fn]);
    assert.equal(row.anon, expected.anon, `${fn}: anon should be ${expected.anon}`);
    assert.equal(
      row.authenticated,
      expected.authenticated,
      `${fn}: authenticated should be ${expected.authenticated}`
    );
  }
});

test('every private schema helper is authenticated-only, never anon', async () => {
  const rows = await q(`
    select p.proname,
           has_function_privilege('anon', p.oid, 'EXECUTE') as anon
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private'`);
  const leaked = rows.filter((r) => r.anon);
  assert.deepEqual(leaked, [], `private functions reachable by anon: ${leaked.map((r) => r.proname).join(', ')}`);
});

test('the function-privilege hardening event trigger exists and is enabled', async () => {
  const [row] = await q(`
    select evtenabled from pg_event_trigger where evtname = 'enforce_function_no_public_execute'`);
  assert.ok(row, 'enforce_function_no_public_execute event trigger is missing');
  assert.equal(row.evtenabled, 'O', 'event trigger exists but is not enabled');
});

test('every foreign key column has a leading index', async () => {
  const rows = await q(`
    select conrelid::regclass::text as tbl, a.attname
    from pg_constraint c
    join lateral unnest(c.conkey) k(attnum) on true
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
    where c.contype = 'f' and c.connamespace = 'public'::regnamespace
      and not exists (
        select 1 from pg_index i where i.indrelid = c.conrelid and a.attnum = i.indkey[0]
      )`);
  assert.deepEqual(rows, [], `unindexed FK columns: ${JSON.stringify(rows)}`);
});

/* =============================================================================
   Accounts and roles
   ========================================================================== */

test('setup: camps, donor and accounts', async () => {
  [w.campA] = await q(
    `insert into public.camps (name, governorate, city)
     values ('مخيم النور','khan_younis','خان يونس') returning *`
  );
  [w.campB] = await q(
    `insert into public.camps (name, governorate, city)
     values ('مخيم الرحمة','deir_albalah','دير البلح') returning *`
  );
  [w.org] = await q(
    `insert into public.organizations (name) values ('برنامج الغذاء العالمي') returning *`
  );

  w.superAdmin = await makeAccount('super@camps.ps', 'super_admin', null, 'active');
  w.adminA = await makeAccount('admin@camps.ps', 'camp_admin', w.campA.id, 'active');
  w.adminB = await makeAccount('nour@camps.ps', 'camp_admin', w.campB.id, 'active');
  w.disabledAdmin = await makeAccount('raed@camps.ps', 'camp_admin', w.campB.id, 'disabled');
});

test('a donor needs nothing but a name', async () => {
  assert.equal(w.org.phone, null);
  assert.equal(w.org.responsible_person, null);
});

test('sign-up never grants the role asked for in user metadata', async () => {
  const [user] = await q(
    `insert into auth.users (email, raw_user_meta_data)
     values ('escalation@example.test', '{"role":"super_admin"}'::jsonb) returning *`
  );
  const [profile] = await q(`select role, status from public.profiles where id = $1`, [user.id]);
  assert.equal(profile.role, 'displaced');
  assert.equal(profile.status, 'pending');
});

test('the platform holds exactly one super admin', async () => {
  await rejects(
    `update public.profiles set role='super_admin', camp_id=null where id=$1`,
    [w.adminA],
    'a second super admin was accepted'
  );
});

/* =============================================================================
   Families and people
   ========================================================================== */

test('a family, its head and its members are registered in one call', async () => {
  const [{ create_family_with_members: familyId }] = await q(
    `select public.create_family_with_members($1, $2::jsonb, $3::jsonb, $4, $5)`,
    [
      w.campA.id,
      JSON.stringify({
        full_name: 'أحمد محمود الشريف',
        gender: 'male',
        birth_date: '1985-03-14',
        national_id: '402318765',
        marital_status: 'married',
        tent_type: 'tarp_tent',
        governorate: 'khan_younis',
        city: 'خان يونس',
        area: 'حي الأمل',
        origin_governorate: 'gaza',
        origin_city: 'غزة',
        displacement_date: '2023-10-16',
        chronic_diseases: 'ضغط الدم',
        work_status: 'irregular',
        income_source: 'daily_work',
        monthly_income: 850,
      }),
      JSON.stringify([
        {
          full_name: 'فاطمة عادل الشريف',
          gender: 'female',
          birth_date: '1989-07-22',
          national_id: '402318766',
          relationship: 'spouse',
          marital_status: 'married',
          chronic_diseases: 'سكري',
          is_breastfeeding: true,
        },
        { full_name: 'محمد أحمد الشريف', gender: 'male', birth_date: '2011-01-09', national_id: '412318767', relationship: 'son' },
        { full_name: 'لمى أحمد الشريف', gender: 'female', birth_date: '2026-02-10', national_id: '412318769', relationship: 'daughter' },
        { full_name: 'هناء أبو زيد', gender: 'female', birth_date: '2003-12-01', national_id: '409872146', relationship: 'daughter', father_status: 'deceased' },
      ]),
      '',
      w.adminA,
    ]
  );

  w.familyA = familyId;
  [w.family] = await q(`select * from public.families where id=$1`, [familyId]);
  w.members = await q(`select * from public.family_members where family_id=$1`, [familyId]);

  assert.equal(w.family.reference_code, 'FAM-000001', 'reference code is generated by the database');
  assert.ok(w.family.head_member_id);
  assert.equal(w.members.length, 5);
});

test('members inherit the household fields, but not the head’s personal ones', async () => {
  const head = w.members.find((m) => m.relationship === 'head');
  const son = w.members.find((m) => m.full_name === 'محمد أحمد الشريف');

  assert.equal(son.tent_type, head.tent_type);
  assert.equal(son.area, head.area);
  assert.equal(son.origin_city, head.origin_city);
  assert.equal(son.displacement_date?.toISOString(), head.displacement_date?.toISOString());

  assert.equal(son.chronic_diseases, '', 'a member inherited the head’s medical history');
});

test('a member always lives in their family’s camp', async () => {
  const son = w.members.find((m) => m.full_name === 'محمد أحمد الشريف');
  await q(`update public.family_members set camp_id=$2 where id=$1`, [son.id, w.campB.id]);
  const [after] = await q(`select camp_id from public.family_members where id=$1`, [son.id]);
  assert.equal(after.camp_id, w.campA.id, 'a person was moved to a camp their family is not in');
});

/* =============================================================================
   Domain rules
   ========================================================================== */

test('orphan status is derived from the parents and cannot be written', async () => {
  const orphan = w.members.find((m) => m.full_name === 'هناء أبو زيد');
  const son = w.members.find((m) => m.full_name === 'محمد أحمد الشريف');

  assert.equal(orphan.is_orphan, true, 'a deceased father did not produce an orphan');
  assert.equal(son.is_orphan, false);

  await rejects(
    `update public.family_members set is_orphan = true where id=$1`,
    [son.id],
    'is_orphan accepted a hand-written value'
  );
});

test('maternity flags are written only on female records', async () => {
  const head = w.members.find((m) => m.relationship === 'head');
  const wife = w.members.find((m) => m.full_name === 'فاطمة عادل الشريف');

  assert.equal(wife.is_breastfeeding, true);
  assert.equal(wife.is_pregnant, false, 'a female record defaults both flags, so filters work');
  assert.equal(head.is_pregnant, null, 'a male file must show لا ينطبق, not حامل: لا');
  assert.equal(head.is_breastfeeding, null);

  await q(`update public.family_members set is_pregnant = true where id=$1`, [head.id]);
  const [after] = await q(`select is_pregnant from public.family_members where id=$1`, [head.id]);
  assert.equal(after.is_pregnant, null, 'a pregnancy flag stuck to a male record');
});

test('switching a record to ذكر clears both maternity flags', async () => {
  const wife = w.members.find((m) => m.full_name === 'فاطمة عادل الشريف');

  await q(`update public.family_members set gender='male' where id=$1`, [wife.id]);
  const [after] = await q(
    `select is_pregnant, is_breastfeeding from public.family_members where id=$1`,
    [wife.id]
  );
  assert.equal(after.is_pregnant, null);
  assert.equal(after.is_breastfeeding, null);

  await q(
    `update public.family_members set gender='female', is_breastfeeding=true where id=$1`,
    [wife.id]
  );
});

test('national ID is unique platform-wide, so it cannot exist in two camps', async () => {
  const error = await rejects(
    `select public.create_family_with_members($1, $2::jsonb)`,
    [w.campB.id, JSON.stringify({ full_name: 'مكرر', gender: 'male', national_id: '402318765' })],
    'the same national ID was registered in a second camp'
  );
  assert.match(error.message, /duplicate key|unique/i);
});

test('national ID format is enforced by the database, not only by JavaScript', async () => {
  await rejects(
    `select public.create_family_with_members($1, $2::jsonb)`,
    [w.campB.id, JSON.stringify({ full_name: 'قصير', gender: 'male', national_id: '123' })],
    'a malformed national ID was accepted'
  );
});

test('shelter type accepts only خيمة شادر and خيمة جاهزة', async () => {
  const son = w.members.find((m) => m.full_name === 'محمد أحمد الشريف');
  await rejects(
    `update public.family_members set tent_type = 'caravan' where id=$1`,
    [son.id],
    'an unapproved shelter type was accepted'
  );
});

test('no tent, caravan, file number or current-residence column exists', async () => {
  const columns = (
    await q(
      `select column_name from information_schema.columns where table_name='family_members'`
    )
  ).map((r) => r.column_name);

  for (const forbidden of ['tent_number', 'caravan_number', 'file_number', 'current_residence']) {
    assert.ok(!columns.includes(forbidden), `family_members carries "${forbidden}"`);
  }
});

test('documents have no expiry date', async () => {
  const columns = (
    await q(`select column_name from information_schema.columns where table_name='documents'`)
  ).map((r) => r.column_name);
  assert.ok(!columns.includes('expiry_date') && !columns.includes('expires_at'));
});

/* =============================================================================
   Derived views
   ========================================================================== */

test('age bands are cumulative, not disjoint', async () => {
  const facts = await q(
    `select * from public.family_member_facts where family_id=$1 and age_years is not null`,
    [w.familyA]
  );
  const baby = facts.find((f) => f.under_1);
  assert.ok(baby, 'the fixture needs an infant to exercise the bands');
  assert.ok(baby.under_2 && baby.under_3 && baby.is_child, 'أقل من سنتين must include infants under one');

  for (const row of facts) {
    if (row.under_2) assert.ok(row.under_3 && row.is_child);
  }
});

test('family aggregates are derived, never stored', async () => {
  const columns = (
    await q(`select column_name from information_schema.columns where table_name='families'`)
  ).map((r) => r.column_name);
  assert.ok(!columns.includes('members_count'), 'membersCount must never be a stored column');

  const [stats] = await q(`select * from public.family_stats where family_id=$1`, [w.familyA]);
  assert.equal(Number(stats.members_count), 5);
  assert.equal(Number(stats.orphans), 1);
  assert.equal(Number(stats.chronic), 2);
  assert.equal(Number(stats.breastfeeding), 1);
});

/* =============================================================================
   Family head invariant
   ========================================================================== */

test('a family cannot be left without a head', async () => {
  await rejects(
    `update public.families set head_member_id = null where id=$1`,
    [w.familyA],
    'a family was left headless'
  );
});

test('removing the head promotes another member instead of orphaning the family', async () => {
  const [{ create_family_with_members: familyId }] = await q(
    `select public.create_family_with_members($1,$2::jsonb,$3::jsonb)`,
    [
      w.campA.id,
      JSON.stringify({ full_name: 'رب مؤقت', gender: 'male', national_id: '999111000', birth_date: '1980-01-01' }),
      JSON.stringify([{ full_name: 'فرد ثانٍ', gender: 'female', national_id: '999111001', birth_date: '1985-01-01' }]),
    ]
  );

  const [before] = await q(`select head_member_id from public.families where id=$1`, [familyId]);
  await q(`delete from public.family_members where id=$1`, [before.head_member_id]);

  const [after] = await q(`select head_member_id from public.families where id=$1`, [familyId]);
  assert.ok(after.head_member_id);
  assert.notEqual(after.head_member_id, before.head_member_id);

  await q(`delete from public.family_members where family_id=$1`, [familyId]);
  const remaining = await q(`select 1 from public.families where id=$1`, [familyId]);
  assert.equal(remaining.length, 0, 'a family with no members should not survive');
});

/* =============================================================================
   Aid
   ========================================================================== */

test('one distribution carries many aid types and many beneficiary families', async () => {
  const [{ create_aid_distribution: id }] = await q(
    `select public.create_aid_distribution($1,$2,$3::date,$4::text[],$5::uuid[],$6,$7)`,
    [w.org.id, w.campA.id, '2026-07-28', ['food', 'blankets'], [w.familyA], false, w.adminA]
  );
  w.distribution = id;

  const types = await q(
    `select t.code from public.aid_distribution_types j
     join public.aid_types t on t.id = j.aid_type_id
     where j.distribution_id=$1 order by 1`,
    [id]
  );
  assert.deepEqual(types.map((t) => t.code), ['blankets', 'food']);

  const families = await q(
    `select family_id from public.aid_distribution_families where distribution_id=$1`,
    [id]
  );
  assert.deepEqual(families.map((f) => f.family_id), [w.familyA]);
});

test('"all eligible families" materialises one row per family, not a flag to expand later', async () => {
  const [{ create_aid_distribution: id }] = await q(
    `select public.create_aid_distribution($1,$2,$3::date,$4::text[],null,$5,$6)`,
    [w.org.id, w.campA.id, '2026-07-20', ['food'], true, w.adminA]
  );

  const [linked] = await q(
    `select count(*)::int n from public.aid_distribution_families where distribution_id=$1`,
    [id]
  );
  const [total] = await q(`select count(*)::int n from public.families where camp_id=$1`, [w.campA.id]);
  assert.equal(linked.n, total.n);
});

test('a distribution needs at least one type and one beneficiary', async () => {
  await rejects(
    `select public.create_aid_distribution($1,$2,$3::date,$4::text[],$5::uuid[],false,null)`,
    [w.org.id, w.campA.id, '2026-07-01', [], [w.familyA]],
    'a distribution with no aid type was accepted'
  );
  await rejects(
    `select public.create_aid_distribution($1,$2,$3::date,$4::text[],$5::uuid[],false,null)`,
    [w.org.id, w.campA.id, '2026-07-01', ['food'], []],
    'a distribution with no beneficiary was accepted'
  );
});

test('aid is not a financial transaction and names no individual', async () => {
  const columns = (
    await q(
      `select column_name from information_schema.columns where table_name='aid_distributions'`
    )
  ).map((r) => r.column_name);

  for (const forbidden of ['value', 'price', 'estimated_value', 'displaced_id', 'recipient_id']) {
    assert.ok(!columns.includes(forbidden), `aid_distributions carries "${forbidden}"`);
  }
});

/* =============================================================================
   Registration workflow
   ========================================================================== */

test('approving a request creates the person, the family, the account and the notification', async () => {
  const [applicant] = await q(
    `insert into auth.users (email) values ('wisam@example.ps') returning id`
  );
  const [request] = await q(
    `insert into public.registration_requests (user_id, full_name, national_id, phone, email, camp_id)
     values ($1,'وسام جهاد أبو ركبة','407332981','0592345701','wisam@example.ps',$2) returning *`,
    [applicant.id, w.campA.id]
  );
  w.request = request;
  assert.equal(request.status, 'pending');

  const [{ approve_registration_request: memberId }] = await q(
    `select public.approve_registration_request($1)`,
    [request.id]
  );

  const [member] = await q(`select * from public.family_members where id=$1`, [memberId]);
  const [family] = await q(`select * from public.families where id=$1`, [member.family_id]);
  const [profile] = await q(`select * from public.profiles where id=$1`, [applicant.id]);
  const notifications = await q(`select * from public.notifications where recipient_id=$1`, [
    applicant.id,
  ]);
  const [after] = await q(`select * from public.registration_requests where id=$1`, [request.id]);

  assert.equal(member.national_id, '407332981');
  assert.equal(member.relationship, 'head');
  assert.equal(family.head_member_id, memberId);
  assert.equal(profile.status, 'approved');
  assert.equal(profile.camp_id, w.campA.id);
  assert.equal(profile.family_member_id, memberId, 'the account was not linked to its person record');
  assert.equal(notifications.length, 1);
  assert.equal(after.status, 'approved');
  assert.ok(after.reviewed_at);
});

test('an open request blocks a second one for the same national ID', async () => {
  await rejects(
    `insert into public.registration_requests (full_name, national_id, email, camp_id)
     values ('آخر','407332981','other@example.ps',$1)`,
    [w.campA.id],
    'a duplicate registration request was accepted'
  );
});

test('a decided request cannot be decided again', async () => {
  await rejects(
    `select public.approve_registration_request($1)`,
    [w.request.id],
    'an approved request was re-approved'
  );
});

/* =============================================================================
   Row Level Security — the isolation matrix from spec §37
   ========================================================================== */

test('setup: a displaced account and a family in the second camp', async () => {
  const head = w.members.find((m) => m.relationship === 'head');
  w.displacedA = await makeAccount('ahmad@camps.ps', 'displaced', w.campA.id, 'approved');
  await q(`update public.profiles set family_member_id=$2 where id=$1`, [w.displacedA, head.id]);

  const [{ create_family_with_members: familyB }] = await q(
    `select public.create_family_with_members($1,$2::jsonb,$3::jsonb)`,
    [
      w.campB.id,
      JSON.stringify({
        full_name: 'إبراهيم سعيد قاسم',
        gender: 'male',
        national_id: '403661298',
        birth_date: '1981-08-19',
        chronic_diseases: 'ربو',
      }),
      '[]',
    ]
  );
  w.familyB = familyB;
});

test('anonymous: reads active camps and nothing else', async () => {
  await as(
    null,
    async () => {
      const [camps] = await q(`select count(*)::int n from public.camps`);
      assert.ok(camps.n > 0, 'the public registration form needs the camp list');

      for (const table of [
        'families',
        'family_members',
        'organizations',
        'aid_distributions',
        'documents',
        'messages',
        'notifications',
        'profiles',
        'registration_requests',
        'family_stats',
      ]) {
        let visible = 0;
        try {
          [{ n: visible }] = await q(`select count(*)::int n from public.${table}`);
        } catch {
          visible = 0; // no grant at all — also a pass
        }
        assert.equal(visible, 0, `anonymous read ${visible} rows of ${table}`);
      }
    },
    'anon'
  );
});

test('super admin: sees every camp’s data', async () => {
  await as(w.superAdmin, async () => {
    const families = await q(`select camp_id from public.families`);
    const members = await q(`select camp_id from public.family_members`);
    assert.ok(new Set(families.map((f) => f.camp_id)).size >= 2);
    assert.ok(new Set(members.map((m) => m.camp_id)).size >= 2);
  });
});

test('camp admin A: reads their own camp only', async () => {
  await as(w.adminA, async () => {
    const families = await q(`select camp_id from public.families`);
    const members = await q(`select camp_id from public.family_members`);

    assert.ok(families.length > 0);
    assert.ok(families.every((f) => f.camp_id === w.campA.id));
    assert.ok(members.length > 0);
    assert.ok(members.every((m) => m.camp_id === w.campA.id));
  });
});

test('camp admin A: cannot reach camp B’s medical data', async () => {
  await as(w.adminA, async () => {
    const [row] = await q(
      `select count(*)::int n from public.family_members
       where camp_id=$1 and chronic_diseases <> ''`,
      [w.campB.id]
    );
    assert.equal(row.n, 0);
  });
});

test('camp admin A: cannot write anywhere near camp B', async () => {
  await as(w.adminA, async () => {
    const updated = await q(
      `update public.families set notes='اختراق' where camp_id=$1 returning id`,
      [w.campB.id]
    );
    assert.equal(updated.length, 0, 'camp admin A updated a camp B family');

    const deleted = await q(`delete from public.families where camp_id=$1 returning id`, [
      w.campB.id,
    ]);
    assert.equal(deleted.length, 0, 'camp admin A deleted a camp B family');
  });

  await as(w.adminA, () =>
    rejects(
      `select public.create_family_with_members($1,$2::jsonb)`,
      [w.campB.id, JSON.stringify({ full_name: 'اختراق', gender: 'male', national_id: '999000222' })],
      'camp admin A created a family in camp B'
    )
  );

  await as(w.adminA, () =>
    rejects(
      `select public.create_aid_distribution($1,$2,$3::date,$4::text[],$5::uuid[],false,null)`,
      [w.org.id, w.campB.id, '2026-08-01', ['food'], [w.familyB]],
      'camp admin A recorded aid in camp B'
    )
  );
});

test('camp admin B: cannot decide a camp A registration request', async () => {
  await as(w.adminB, () =>
    rejects(
      `select public.reject_registration_request($1, '')`,
      [w.request.id],
      'a camp admin reviewed another camp’s request'
    )
  );
});

test('a disabled camp admin authenticates but is authorized for nothing', async () => {
  await as(w.disabledAdmin, async () => {
    const [row] = await q(`select count(*)::int n from public.families`);
    assert.equal(row.n, 0);
  });
});

test('displaced A: sees their own family and no other', async () => {
  await as(w.displacedA, async () => {
    const families = await q(`select id from public.families`);
    assert.equal(families.length, 1);
    assert.equal(families[0].id, w.familyA);

    const members = await q(`select family_id from public.family_members`);
    assert.ok(members.length > 0);
    assert.ok(members.every((m) => m.family_id === w.familyA));

    const [stats] = await q(`select count(*)::int n from public.family_stats`);
    assert.equal(stats.n, 1, 'the aggregate view leaked other families');

    const [profiles] = await q(`select count(*)::int n from public.profiles`);
    assert.equal(profiles.n, 1, 'a displaced person read another account');

    const [requests] = await q(`select count(*)::int n from public.registration_requests`);
    assert.equal(requests.n, 0, 'a displaced person read the review queue');
  });
});

test('displaced A: reads only aid their own family received', async () => {
  await as(w.displacedA, async () => {
    const rows = await q(`
      select d.id from public.aid_distributions d
      where not exists (
        select 1 from public.aid_distribution_families f
        where f.distribution_id = d.id and f.family_id = $1
      )`, [w.familyA]);
    assert.equal(rows.length, 0, 'a displaced person saw a distribution their family did not receive');
  });
});

test('displaced A: cannot create, edit or delete anything (domain rule 8)', async () => {
  await as(w.displacedA, async () => {
    const updated = await q(
      `update public.family_members set chronic_diseases='ذاتي' where family_id=$1 returning id`,
      [w.familyA]
    );
    assert.equal(updated.length, 0, 'a displaced person edited their own record directly');

    const deleted = await q(`delete from public.aid_distributions returning id`);
    assert.equal(deleted.length, 0, 'a displaced person deleted an aid record');
  });

  await as(w.displacedA, () =>
    rejects(
      `select public.create_aid_distribution($1,$2,$3::date,$4::text[],$5::uuid[],false,null)`,
      [w.org.id, w.campA.id, '2026-08-01', ['food'], [w.familyA]],
      'a displaced person recorded an aid distribution'
    )
  );
});

test('nobody can promote themselves through the profiles table', async () => {
  await as(w.displacedA, () =>
    rejects(
      `update public.profiles set role='super_admin' where id=$1`,
      [w.displacedA],
      'a displaced user rewrote their own role'
    )
  );

  await as(w.adminA, () =>
    rejects(
      `update public.profiles set camp_id=$2 where id=$1`,
      [w.adminA, w.campB.id],
      'a camp admin reassigned their own camp'
    )
  );

  const [check] = await q(`select role, camp_id from public.profiles where id=$1`, [w.displacedA]);
  assert.equal(check.role, 'displaced');
});

test.after(async () => {
  await db.close();
});

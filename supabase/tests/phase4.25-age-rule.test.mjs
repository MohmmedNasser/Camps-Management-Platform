/**
 * Phase 4.25: the canonical age rule, proven offline (Postgres-in-WASM, no network).
 *
 *   age = completed years between the birth date and a reference day (today = current_date)
 *
 *  - the documented boundaries (birthday tomorrow / today / yesterday, leap-day babies, born today, no birth date);
 *  - the one-argument form every view/function uses equals the two-argument form at current_date;
 *  - `age_cutoff_date` — what the list filters actually compare against — is the exact inverse of the rule:
 *        age_in_years(dob, on) < n  <=>  dob > age_cutoff_date(n, on)
 *    over a full calendar sweep (every day of 26 years of birth dates, for reference days on and around
 *    ordinary and leap-year February/March, century non-leap 2100, and a year end), for n in {1,2,3,18};
 *  - a negative control: a deliberately wrong cutoff FAILS the same sweep, so the sweep can detect drift;
 *  - grants: neither helper is executable by anon.
 *
 *   cd supabase && npm run test:phase4.25-age-rule
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations');
const db = await new PGlite({ extensions: { pg_trgm } });
await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin;
  create schema auth; grant usage on schema auth to anon, authenticated, service_role;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb default '{}'::jsonb, created_at timestamptz default now());
  create or replace function auth.uid() returns uuid language sql stable as $fn$
    select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid; $fn$;
`);
for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) await db.exec(readFileSync(resolve(MIGRATIONS, file), 'utf8'));

const one = async (sql, params) => (await db.query(sql, params)).rows[0];
const age = async (birth, on) => (await one('select public.age_in_years($1::date, $2::date) as v', [birth, on])).v;

test('age_in_years: documented boundaries', async () => {
  assert.equal(await age('2008-09-29', '2026-09-28'), 17, 'birthday tomorrow');
  assert.equal(await age('2008-09-29', '2026-09-29'), 18, 'birthday today');
  assert.equal(await age('2008-09-29', '2026-09-30'), 18, 'birthday yesterday');
  assert.equal(await age('2008-02-29', '2026-02-28'), 17, 'leap-day baby, day before their non-leap "birthday"');
  assert.equal(await age('2008-02-29', '2026-03-01'), 18, 'leap-day baby, day after');
  assert.equal(await age('2008-02-29', '2028-02-29'), 20, 'leap-day baby on a real leap birthday');
  assert.equal(await age('2026-09-29', '2026-09-29'), 0, 'born today');
  assert.equal(await age('2025-09-29', '2026-09-28'), 0, 'first birthday tomorrow');
  assert.equal(await age('2025-09-29', '2026-09-29'), 1, 'first birthday today');
  assert.equal(await age(null, '2026-09-29'), null, 'no birth date');
});

test('the one-argument form equals the two-argument form at current_date', async () => {
  const r = await one(`
    select count(*) as n, count(*) filter (where public.age_in_years(d::date) is distinct from public.age_in_years(d::date, current_date)) as bad
    from generate_series(current_date - interval '40 years', current_date, interval '1 day') d`);
  assert.ok(Number(r.n) > 14000);
  assert.equal(Number(r.bad), 0);
  assert.equal((await one('select public.age_in_years(null::date) as v')).v, null);
});

const REFERENCE_DAYS = [
  '2024-02-27', '2024-02-28', '2024-02-29', '2024-03-01', '2024-03-02', // leap year
  '2026-02-27', '2026-02-28', '2026-03-01', '2026-09-28', '2026-09-29', '2026-09-30', // ordinary + the phase's own dates
  '2028-02-28', '2028-02-29', '2028-03-01',
  '2100-02-28', '2100-03-01', // 2100 is NOT a leap year
  '2026-12-31', '2027-01-01',
];
const sweep = (cutoffExpr) => `
  select count(*) as n,
         count(*) filter (where (public.age_in_years(d::date, o) < n) is distinct from (d::date > ${cutoffExpr})) as bad
  from unnest($1::date[]) o
  cross join unnest(array[1, 2, 3, 18]) n
  cross join lateral generate_series(o - interval '26 years', o, interval '1 day') d`;

test('age_cutoff_date is the exact inverse of the rule (full calendar sweep)', async () => {
  const r = await one(sweep('public.age_cutoff_date(n, o)'), [REFERENCE_DAYS]);
  assert.ok(Number(r.n) > 600000, `sweep size ${r.n}`);
  assert.equal(Number(r.bad), 0, 'every (birth date, reference day, age) agrees');
});

test('negative control: a wrong cutoff is detected by the same sweep', async () => {
  const off = await one(sweep(`((o - make_interval(years => n))::date + 1)`), [REFERENCE_DAYS]);
  assert.ok(Number(off.bad) > 0, 'cutoff shifted by one day must disagree');
  const naive = await one(sweep(`(o - (n * 365))`), [REFERENCE_DAYS]);
  assert.ok(Number(naive.bad) > 0, 'a days/365 cutoff must disagree (leap days)');
});

test('grants: anon cannot execute the helpers; authenticated and service_role can', async () => {
  for (const sig of ['public.age_in_years(date, date)', 'public.age_cutoff_date(integer, date)']) {
    const r = await one(`select has_function_privilege('anon', '${sig}', 'execute') as anon,
                                has_function_privilege('authenticated', '${sig}', 'execute') as auth,
                                has_function_privilege('service_role', '${sig}', 'execute') as svc`);
    assert.deepEqual(r, { anon: false, auth: true, svc: true }, sig);
  }
});

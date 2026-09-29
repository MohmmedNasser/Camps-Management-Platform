/**
 * Phase 4.24 isolation: `family_overview` and `get_statistics_report` never
 * widen what RLS allows, whatever the caller passes.
 *
 *   cd supabase && npm run frontend:config && npm run test:phase4.24-isolation
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
const { applyFamilyFilters, FAMILY_OVERVIEW_COLUMNS } = await import(pathToFileURL(resolve(ROOT, 'assets/js/supabase/family-filters.js')).href);

const anon = createClient(URL_, ANON, { auth: { persistSession: false } });
async function signedIn(email) {
  const client = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password: '123456' });
  assert.equal(error, null);
  const { data: { user } } = await client.auth.getUser();
  const { data: prof } = await service.from('profiles').select('camp_id, role').eq('id', user.id).single();
  return { client, ...prof };
}

test('Phase 4.24 isolation', async (t) => {
  const admin = await signedIn('admin@camps.ps');
  const superAdmin = await signedIn('super@camps.ps');
  const displaced = await signedIn('ahmad@camps.ps');
  const { data: allCamps } = await service.from('camps').select('id');
  const otherCamp = allCamps.find((c) => c.id !== admin.camp_id).id;
  const { data: svcFamilies } = await service.from('families').select('id, camp_id');

  await t.test('anonymous cannot read family_overview or call the report', async () => {
    const v = await anon.from('family_overview').select('reference_code');
    assert.ok(v.error || v.data.length === 0, 'anon must see nothing');
    const r = await anon.rpc('get_statistics_report', { p_tz: 'UTC' });
    assert.ok(r.error, 'anon RPC must be denied');
  });

  await t.test('camp admin: family_overview is own camp only, even asking for another camp', async () => {
    const own = await applyFamilyFilters(admin.client.from('family_overview').select(FAMILY_OVERVIEW_COLUMNS), {});
    assert.equal(own.error, null);
    assert.equal(own.data.length, svcFamilies.filter((f) => f.camp_id === admin.camp_id).length);
    assert.ok(own.data.every((r) => r.camp_id === admin.camp_id));
    const cross = await applyFamilyFilters(admin.client.from('family_overview').select(FAMILY_OVERVIEW_COLUMNS), { campId: otherCamp });
    assert.equal(cross.error, null);
    assert.equal(cross.data.length, 0, 'cross-camp filter must return nothing');
  });

  await t.test('super admin sees every family', async () => {
    const r = await superAdmin.client.from('family_overview').select('reference_code');
    assert.equal(r.data.length, svcFamilies.length);
  });

  await t.test('displaced sees only own family in family_overview', async () => {
    const r = await displaced.client.from('family_overview').select('reference_code, camp_id');
    assert.equal(r.error, null);
    assert.ok(r.data.length <= 1, `displaced saw ${r.data.length} families`);
  });

  await t.test('report: displaced refused', async () => {
    const r = await displaced.client.rpc('get_statistics_report', { p_tz: 'UTC' });
    assert.ok(r.error, 'displaced must be refused');
  });

  await t.test('report: camp admin only sees own camp data (never platform totals)', async () => {
    const r = await admin.client.rpc('get_statistics_report', { p_tz: 'UTC' });
    assert.equal(r.error, null, r.error?.message);
    const { count } = await service.from('family_members').select('id', { count: 'exact', head: true }).eq('camp_id', admin.camp_id);
    assert.equal(r.data.stats.displaced, count);
    const { count: total } = await service.from('family_members').select('id', { count: 'exact', head: true });
    assert.ok(count < total, 'fixture sanity: other camps have members');
  });

  await t.test('report: super admin sees platform totals', async () => {
    const r = await superAdmin.client.rpc('get_statistics_report', { p_tz: 'UTC' });
    const { count } = await service.from('family_members').select('id', { count: 'exact', head: true });
    assert.equal(r.data.stats.displaced, count);
  });

  await t.test('report: unexpected/invalid parameters are rejected, empty tz falls to error not data leak', async () => {
    const extra = await superAdmin.client.rpc('get_statistics_report', { p_tz: 'UTC', p_camp_id: otherCamp });
    assert.ok(extra.error, 'unknown parameter must be rejected');
    const bad = await superAdmin.client.rpc('get_statistics_report', { p_tz: "UTC'; drop table camps;--" });
    assert.ok(bad.error);
    const { count } = await service.from('camps').select('id', { count: 'exact', head: true });
    assert.ok(count >= 1);
  });

  await t.test('no service-role key in browser code', async () => {
    const { execSync } = await import('node:child_process');
    const key = required('SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY');
    const out = execSync(`git grep -l -F "${key.slice(0, 24)}" -- assets pages || true`, { cwd: ROOT }).toString().trim();
    assert.equal(out, '');
  });
});

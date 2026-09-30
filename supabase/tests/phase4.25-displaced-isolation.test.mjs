/**
 * Phase 4.25 isolation: `list_displaced_persons` never widens what RLS allows,
 * whatever the caller passes. Direct RPC calls with real sessions — not rendered HTML.
 *
 *  - anonymous: denied.  displaced: refused (42501), even when searching for a known name.
 *  - camp admin: exactly own camp; a foreign p_camp_id, a foreign member's national id /
 *    name / phone / family reference as the search term, and every other filter combined
 *    with them return nothing from another camp.
 *  - super admin: every camp.
 *  - auth.uid() is unchanged by successful and failed calls.
 *  - the service-role key is nowhere in browser-reachable code.
 *
 *   cd supabase && npm run frontend:config && npm run test:phase4.25-displaced-isolation
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
const { displacedRpcParams, fetchDisplacedPage, fetchAllDisplaced } = await import(pathToFileURL(resolve(ROOT, 'assets/js/supabase/displaced-filters.js')).href);

const anon = createClient(URL_, ANON, { auth: { persistSession: false } });
async function signedIn(email) {
  const client = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password: '123456' });
  assert.equal(error, null, `${email} must sign in`);
  const { data: { user } } = await client.auth.getUser();
  const { data: prof } = await service.from('profiles').select('camp_id, role').eq('id', user.id).single();
  return { client, userId: user.id, ...prof };
}

test('Phase 4.25 displaced-list isolation', async (t) => {
  const admin = await signedIn('admin@camps.ps');       // مخيم النور
  const otherAdmin = await signedIn('nour@camps.ps');   // مخيم الرحمة
  const superAdmin = await signedIn('super@camps.ps');
  const displaced = await signedIn('ahmad@camps.ps');
  assert.notEqual(admin.camp_id, otherAdmin.camp_id);

  const { data: everyone } = await service.from('family_members').select('id, camp_id, family_id, full_name, national_id, phone, gender');
  const ownRows = everyone.filter((m) => m.camp_id === admin.camp_id);
  const foreignRows = everyone.filter((m) => m.camp_id !== admin.camp_id);
  assert.ok(ownRows.length > 0 && foreignRows.length > 0);
  const { data: fams } = await service.from('families').select('id, reference_code, camp_id');
  const refOf = new Map(fams.map((f) => [f.id, f.reference_code]));

  await t.test('a disabled camp admin (raed@camps.ps) and a pending applicant are refused', async () => {
    const disabled = await signedIn('raed@camps.ps');
    assert.equal(disabled.role, 'camp_admin');
    const r = await disabled.client.rpc('list_displaced_persons', {});
    assert.ok(r.error, 'disabled account must be refused');
    assert.equal(r.error.code, '42501');
    const pending = createClient(URL_, ANON, { auth: { persistSession: false } });
    const { error } = await pending.auth.signInWithPassword({ email: 'yasser22@gmail.com', password: '123456' });
    if (!error) {
      const p = await pending.rpc('list_displaced_persons', {});
      assert.ok(p.error, 'pending applicant must be refused');
    }
  });

  await t.test('anonymous cannot call the RPC', async () => {
    const r = await anon.rpc('list_displaced_persons', {});
    assert.ok(r.error, 'anon must be denied');
    assert.equal(r.data, null);
  });

  await t.test('displaced is refused (42501), also when searching for a real name', async () => {
    for (const args of [{}, { p_query: foreignRows[0].full_name }, { p_camp_id: displaced.camp_id }]) {
      const r = await displaced.client.rpc('list_displaced_persons', args);
      assert.ok(r.error, 'displaced must be refused');
      assert.equal(r.error.code, '42501');
      assert.equal(r.data, null);
    }
  });

  await t.test('camp admin: unfiltered result is exactly the own camp', async () => {
    const all = await fetchAllDisplaced(admin.client, {}, { batchSize: 5 });
    assert.deepEqual(all.map((r) => r.id).sort(), ownRows.map((r) => r.id).sort());
    assert.ok(all.every((r) => r.campId === admin.camp_id));
    const { total } = await fetchDisplacedPage(admin.client, {}, { pageSize: 0 });
    assert.equal(total, ownRows.length);
  });

  await t.test('camp admin: asking for another camp returns nothing (parameter spoof)', async () => {
    const r = await fetchDisplacedPage(admin.client, { campId: otherAdmin.camp_id }, { pageSize: 50 });
    assert.equal(r.total, 0);
    assert.deepEqual(r.rows, []);
    const raw = await admin.client.rpc('list_displaced_persons', { p_camp_id: otherAdmin.camp_id, p_limit: 1000 });
    assert.equal(raw.error, null);
    assert.equal(raw.data.total, 0);
  });

  await t.test('camp admin: cannot find a foreign member by national id, name, phone or family reference', async () => {
    const victims = foreignRows.slice(0, 6);
    for (const v of victims) {
      const terms = [v.national_id, v.full_name, v.phone, refOf.get(v.family_id)].filter(Boolean);
      for (const q of terms) {
        const r = await fetchDisplacedPage(admin.client, { query: q }, { pageSize: 50 });
        assert.ok(r.rows.every((x) => x.campId === admin.camp_id), `foreign row leaked for query ${q}`);
        assert.ok(!r.rows.some((x) => x.id === v.id), `foreign member ${v.id} found by ${q}`);
      }
    }
  });

  await t.test('camp admin: every filter combination stays inside the camp', async () => {
    const combos = [
      { gender: 'male' }, { gender: 'female' }, { isChild: 'yes' }, { isChild: 'no' }, { isOrphan: 'yes' }, { hasChronic: 'yes' },
      { aidType: 'food' }, { ageBand: 'under_3' }, { isPregnant: 'no' }, { query: 'a' },
    ];
    for (const filters of combos) {
      const { rows } = await fetchDisplacedPage(admin.client, filters, { pageSize: 100 });
      assert.ok(rows.every((r) => r.campId === admin.camp_id), `leak with ${JSON.stringify(filters)}`);
    }
    // The aid-type/donor family set is itself RLS-scoped: the other camp's aid families never widen the result.
    const { data: orgs } = await service.from('organizations').select('id');
    for (const o of orgs) {
      const { rows } = await fetchDisplacedPage(admin.client, { organizationId: o.id }, { pageSize: 100 });
      assert.ok(rows.every((r) => r.campId === admin.camp_id));
    }
  });

  await t.test('the two camp admins see disjoint sets that together are their two camps', async () => {
    const a = await fetchAllDisplaced(admin.client, {}, { batchSize: 7 });
    const b = await fetchAllDisplaced(otherAdmin.client, {}, { batchSize: 7 });
    assert.ok(a.length && b.length);
    assert.equal(a.filter((x) => b.some((y) => y.id === x.id)).length, 0);
    assert.equal(b.length, everyone.filter((m) => m.camp_id === otherAdmin.camp_id).length);
  });

  await t.test('super admin sees every camp and can narrow to one', async () => {
    const all = await fetchAllDisplaced(superAdmin.client, {}, { batchSize: 9 });
    assert.equal(all.length, everyone.length);
    assert.deepEqual([...new Set(all.map((r) => r.campId))].sort(), [...new Set(everyone.map((m) => m.camp_id))].sort());
    const one = await fetchDisplacedPage(superAdmin.client, { campId: otherAdmin.camp_id }, { pageSize: 100 });
    assert.equal(one.total, everyone.filter((m) => m.camp_id === otherAdmin.camp_id).length);
  });

  await t.test('malformed ids never reach the database and match nothing (as the old predicate did)', async () => {
    assert.equal(displacedRpcParams({ campId: 'not-a-uuid' }), null);
    assert.equal(displacedRpcParams({ organizationId: "x'; drop table camps;--" }), null);
    const r = await fetchDisplacedPage(admin.client, { campId: 'not-a-uuid' }, {});
    assert.deepEqual(r, { rows: [], total: 0 });
    // A hostile value sent straight to the typed parameter is rejected by Postgres, not interpreted.
    const raw = await admin.client.rpc('list_displaced_persons', { p_camp_id: "x'; drop table camps;--" });
    assert.ok(raw.error);
    const { count } = await service.from('camps').select('id', { count: 'exact', head: true });
    assert.ok(count >= 4);
  });

  await t.test('p_limit / p_offset are clamped server-side', async () => {
    const r = await superAdmin.client.rpc('list_displaced_persons', { p_limit: 2147483647, p_offset: -50 });
    assert.equal(r.error, null);
    assert.ok(r.data.rows.length <= 1000);
    const neg = await superAdmin.client.rpc('list_displaced_persons', { p_limit: -5 });
    assert.equal(neg.data.rows.length, 0);
    assert.equal(neg.data.total, everyone.length);
  });

  await t.test('auth.uid() is unchanged by successful and failed calls', async () => {
    for (const who of [admin, superAdmin, displaced]) {
      await who.client.rpc('list_displaced_persons', { p_limit: 1 });
      await who.client.rpc('list_displaced_persons', { p_camp_id: 'bad' });
      const { data: { user } } = await who.client.auth.getUser();
      assert.equal(user.id, who.userId);
    }
  });

  await t.test('no service-role key in browser code', async () => {
    const { execSync } = await import('node:child_process');
    const key = required('SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY');
    const out = execSync(`git grep -l -F "${key.slice(0, 24)}" -- assets pages || true`, { cwd: ROOT }).toString().trim();
    assert.equal(out, '');
  });
});

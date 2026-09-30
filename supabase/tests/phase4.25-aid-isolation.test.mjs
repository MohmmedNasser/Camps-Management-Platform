/**
 * Phase 4.25 isolation: `list_aid_distributions` never widens what RLS allows,
 * whatever the caller passes. Direct RPC calls with real sessions.
 *
 *  - anonymous: denied.
 *  - camp admin: exactly own-camp distributions; foreign family / donor / search terms
 *    cannot surface another camp's rows.
 *  - displaced: exactly the distributions their own family received; other beneficiary
 *    families of a shared distribution never appear in rows, search or summary.
 *  - super admin: everything.
 *  - auth.uid() unchanged; no service-role key in browser code.
 *
 *   cd supabase && npm run frontend:config && npm run test:phase4.25-aid-isolation
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
const { aidRpcParams, fetchAidPage, fetchAllAid } = await import(pathToFileURL(resolve(ROOT, 'assets/js/supabase/aid-filters.js')).href);

const anon = createClient(URL_, ANON, { auth: { persistSession: false } });
async function signedIn(email) {
  const client = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password: '123456' });
  assert.equal(error, null, `${email} must sign in`);
  const { data: { user } } = await client.auth.getUser();
  const { data: prof } = await service.from('profiles').select('camp_id, role, family_member_id').eq('id', user.id).single();
  let familyId = null;
  if (prof.family_member_id) {
    ({ data: { family_id: familyId } } = await service.from('family_members').select('family_id').eq('id', prof.family_member_id).single());
  }
  return { client, userId: user.id, familyId, ...prof };
}

test('Phase 4.25 aid-list isolation', async (t) => {
  const admin = await signedIn('admin@camps.ps');
  const otherAdmin = await signedIn('nour@camps.ps'); // مخيم الرحمة
  const superAdmin = await signedIn('super@camps.ps');
  const displacedAccounts = [];
  for (const email of ['ahmad@camps.ps', 'yousef@camps.ps', 'ibrahim@camps.ps', 'omar@camps.ps']) displacedAccounts.push(await signedIn(email));

  const { data: dists } = await service.from('aid_distributions').select('id, camp_id, organization_id');
  const { data: links } = await service.from('aid_distribution_families').select('distribution_id, family_id');
  const { data: fams } = await service.from('families').select('id, reference_code, camp_id');
  const refOf = new Map(fams.map((f) => [f.id, f.reference_code]));
  const ownIds = dists.filter((d) => d.camp_id === admin.camp_id).map((d) => d.id);
  const foreign = dists.filter((d) => d.camp_id !== admin.camp_id);
  assert.ok(ownIds.length > 0 && foreign.length > 0);

  await t.test('a disabled camp admin (raed@camps.ps) and a pending applicant are refused', async () => {
    const disabled = await signedIn('raed@camps.ps');
    assert.equal(disabled.role, 'camp_admin');
    const r = await disabled.client.rpc('list_aid_distributions', {});
    assert.ok(r.error, 'disabled account must be refused');
    assert.equal(r.error.code, '42501');
    const pending = createClient(URL_, ANON, { auth: { persistSession: false } });
    const { error } = await pending.auth.signInWithPassword({ email: 'yasser22@gmail.com', password: '123456' });
    if (!error) {
      const p = await pending.rpc('list_aid_distributions', {});
      assert.ok(p.error, 'pending applicant must be refused');
    }
  });

  await t.test('anonymous cannot call the RPC', async () => {
    const r = await anon.rpc('list_aid_distributions', {});
    assert.ok(r.error);
    assert.equal(r.data, null);
  });

  await t.test('camp admin: exactly the own camp, by id set, count and summary', async () => {
    const rows = await fetchAllAid(admin.client, {}, { batchSize: 4 });
    assert.deepEqual(rows.map((r) => r.id).sort(), ownIds.slice().sort());
    assert.ok(rows.every((r) => r.campId === admin.camp_id));
    const page = await fetchAidPage(admin.client, {}, { pageSize: 0 });
    assert.equal(page.total, ownIds.length);
    const ownFamilies = new Set(links.filter((l) => ownIds.includes(l.distribution_id)).map((l) => refOf.get(l.family_id)));
    assert.equal(page.summary.families, ownFamilies.size, 'summary counts only visible beneficiaries');
  });

  await t.test('camp admin: foreign family / donor / search spoofing returns nothing from another camp', async () => {
    const foreignDist = foreign[0];
    const foreignFamily = links.find((l) => l.distribution_id === foreignDist.id).family_id;
    const byFamily = await fetchAidPage(admin.client, { familyId: foreignFamily }, { pageSize: 50 });
    assert.equal(byFamily.total, 0, 'foreign family id');
    const byRef = await fetchAidPage(admin.client, { query: refOf.get(foreignFamily) }, { pageSize: 50 });
    assert.ok(byRef.rows.every((r) => r.campId === admin.camp_id) && !byRef.rows.some((r) => r.id === foreignDist.id), 'foreign family reference');
    for (const o of [...new Set(dists.map((d) => d.organization_id))]) {
      const r = await fetchAidPage(admin.client, { organizationId: o }, { pageSize: 100 });
      assert.ok(r.rows.every((x) => x.campId === admin.camp_id), 'donor filter never crosses camps');
    }
    const raw = await admin.client.rpc('list_aid_distributions', { p_family_id: foreignFamily, p_limit: 1000 });
    assert.equal(raw.error, null);
    assert.equal(raw.data.total, 0);
  });

  await t.test('two camp admins see disjoint sets; super admin sees the union', async () => {
    const a = (await fetchAllAid(admin.client, {})).map((r) => r.id);
    const b = (await fetchAllAid(otherAdmin.client, {})).map((r) => r.id);
    assert.equal(a.filter((x) => b.includes(x)).length, 0);
    const s = (await fetchAllAid(superAdmin.client, {})).map((r) => r.id);
    assert.equal(s.length, dists.length);
    assert.ok([...a, ...b].every((id) => s.includes(id)));
  });

  await t.test('displaced: each account sees exactly the distributions its own family received, and nothing else about others', async () => {
    for (const who of displacedAccounts) {
      const expected = links.filter((l) => l.family_id === who.familyId).map((l) => l.distribution_id).sort();
      const page = await fetchAidPage(who.client, {}, { pageSize: 100 });
      assert.deepEqual(page.rows.map((r) => r.id).sort(), expected, `${who.userId}: own distributions only`);
      assert.equal(page.total, expected.length);
      const ownRef = refOf.get(who.familyId);
      for (const row of page.rows) {
        assert.deepEqual(row.familyDbIds, [who.familyId], 'other beneficiary families are hidden');
        assert.deepEqual(row.familyIds, [ownRef]);
      }
      assert.ok(page.summary.families <= 1, 'summary never counts other families');

      // Seeded distributions shared with another family (if any) must hide that family too; the fixture below guarantees one exists.
      const shared = links.filter((l) => l.family_id === who.familyId).map((l) => l.distribution_id)
        .find((id) => links.filter((l) => l.distribution_id === id).length > 1);
      if (shared) {
        const other = links.find((l) => l.distribution_id === shared && l.family_id !== who.familyId).family_id;
        const bySearch = await fetchAidPage(who.client, { query: refOf.get(other) }, { pageSize: 50 });
        assert.equal(bySearch.total, 0, 'other beneficiary family not searchable');
        const byFamily = await fetchAidPage(who.client, { familyId: other }, { pageSize: 50 });
        assert.equal(byFamily.total, 0, 'other beneficiary family not filterable');
      }
      // Any foreign family id gives nothing.
      const stranger = fams.find((f) => f.id !== who.familyId).id;
      assert.equal((await fetchAidPage(who.client, { familyId: stranger }, { pageSize: 50 })).total, 0);
    }
  });

  await t.test('fixture: a distribution shared by two families hides the other family from a displaced viewer (created via the RPC, removed in finally)', async () => {
    const viewer = displacedAccounts.find((a) => a.camp_id === admin.camp_id);
    assert.ok(viewer?.familyId, 'a displaced account in the admin camp');
    const otherFamily = fams.find((f) => f.camp_id === admin.camp_id && f.id !== viewer.familyId);
    assert.ok(otherFamily, 'a second family in the same camp');
    const { data: org } = await service.from('organizations').select('id').limit(1).single();
    const { data: before } = await service.from('notifications').select('id, is_read');
    const knownNotifications = new Set(before.map((n) => n.id));
    let distributionId = null;
    try {
      const created = await admin.client.rpc('create_aid_distribution', {
        p_organization_id: org.id,
        p_camp_id: admin.camp_id,
        p_distributed_on: '2026-01-15',
        p_aid_type_codes: ['food'],
        p_family_ids: [viewer.familyId, otherFamily.id],
        p_all_families_selected: false,
      });
      assert.equal(created.error, null, created.error?.message);
      distributionId = created.data;

      // The camp admin sees both beneficiary families …
      const adminView = (await fetchAidPage(admin.client, { familyId: otherFamily.id }, { pageSize: 50 })).rows.find((r) => r.id === distributionId);
      assert.ok(adminView);
      assert.deepEqual([...adminView.familyDbIds].sort(), [viewer.familyId, otherFamily.id].sort());

      // … the displaced viewer sees the distribution but only its own family on it.
      const own = await fetchAidPage(viewer.client, {}, { pageSize: 100 });
      const row = own.rows.find((r) => r.id === distributionId);
      assert.ok(row, 'viewer sees the shared distribution');
      assert.deepEqual(row.familyDbIds, [viewer.familyId]);
      assert.deepEqual(row.familyIds, [refOf.get(viewer.familyId)]);
      assert.equal(row.beneficiaryCount, 1);
      assert.ok(own.summary.families <= 1);

      // … and cannot reach the other family by searching, filtering, or by its head's name.
      const { data: head } = await service.from('families').select('head:family_members!families_head_member_id_fkey(full_name)').eq('id', otherFamily.id).single();
      for (const filters of [{ query: refOf.get(otherFamily.id) }, { query: head.head.full_name }, { familyId: otherFamily.id }]) {
        assert.equal((await fetchAidPage(viewer.client, filters, { pageSize: 50 })).total, 0, `leak via ${JSON.stringify(filters)}`);
      }
    } finally {
      if (distributionId) await service.from('aid_distributions').delete().eq('id', distributionId);
      // create_aid_distribution fires the Phase 4.20 notification trigger; remove exactly what it added.
      const { data: after } = await service.from('notifications').select('id');
      const added = after.filter((n) => !knownNotifications.has(n.id)).map((n) => n.id);
      if (added.length) await service.from('notifications').delete().in('id', added);
    }
    const { count: leftover } = await service.from('aid_distributions').select('id', { count: 'exact', head: true }).eq('id', distributionId ?? '00000000-0000-0000-0000-000000000000');
    assert.equal(leftover, 0, 'fixture distribution removed');
    const { data: restored } = await service.from('notifications').select('id, is_read');
    assert.deepEqual(restored.map((n) => `${n.id}:${n.is_read}`).sort(), before.map((n) => `${n.id}:${n.is_read}`).sort(), 'notification set restored exactly');
    const { count: junction } = await service.from('aid_distribution_families').select('distribution_id', { count: 'exact', head: true });
    assert.equal(junction, links.length, 'no orphan junction rows');
  });

  await t.test('malformed ids never reach the database and match nothing', async () => {
    assert.equal(aidRpcParams({ organizationId: 'nope' }), null);
    assert.equal(aidRpcParams({ familyId: "1'; drop table camps;--" }), null);
    assert.deepEqual(await fetchAidPage(admin.client, { familyId: 'nope' }, {}), { rows: [], total: 0, summary: { organizations: 0, families: 0, types: 0 } });
    const raw = await admin.client.rpc('list_aid_distributions', { p_family_id: 'nope' });
    assert.ok(raw.error);
  });

  await t.test('auth.uid() is unchanged by successful and failed calls', async () => {
    for (const who of [admin, superAdmin, displacedAccounts[0]]) {
      await who.client.rpc('list_aid_distributions', { p_limit: 1 });
      await who.client.rpc('list_aid_distributions', { p_family_id: 'bad' });
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

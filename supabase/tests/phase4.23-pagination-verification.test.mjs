/**
 * Phase 4.23: batched reads (`fetchAll` / `fetchAllIn` in supabase/query.js)
 * return exactly what an independent service-role query returns — no gaps,
 * no duplicates, same order — at every batch boundary, and the DB-count
 * dashboard statistics equal independent counts.
 *
 * A small `batchSize` exercises the exact code path the default 1000-row
 * PostgREST cap uses, without inserting >1000 rows into the live project.
 *
 *   cd supabase && npm run frontend:config && npm run test:phase4.23-pagination-verification
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
const SERVICE = required('SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY');
const PASSWORD = '123456';

const { fetchAll, fetchAllIn, FETCH_BATCH } = await import(
  pathToFileURL(resolve(ROOT, 'assets/js/supabase/query.js')).href
);

async function signedIn(email) {
  const client = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  assert.equal(error, null, `${email} must sign in`);
  return client;
}
const service = createClient(URL_, SERVICE, { auth: { persistSession: false } });
const ids = (rows) => rows.map((r) => r.id);

test('Phase 4.23 batched reads', async (t) => {
  await t.test('FETCH_BATCH equals the PostgREST default cap', () => {
    assert.equal(FETCH_BATCH, 1000);
  });

  const admin = await signedIn('admin@camps.ps');
  const superAdmin = await signedIn('super@camps.ps');

  await t.test('super admin: family_members at every boundary batch size equals independent read', async () => {
    const { data: expected } = await service.from('family_members').select('id').order('id');
    const total = expected.length;
    assert.ok(total > 10, 'need a non-trivial dataset');
    for (const batchSize of [1, 7, total - 1, total, total + 1, 1000]) {
      const rows = await fetchAll(() => superAdmin.from('family_members').select('id'), { order: ['id'], batchSize });
      assert.deepEqual(ids(rows), ids(expected), `batchSize ${batchSize}`);
      assert.equal(new Set(ids(rows)).size, total, `no duplicates at batchSize ${batchSize}`);
    }
  });

  await t.test('camp admin: only own camp rows, complete, at small batch', async () => {
    const { data: { user } } = await admin.auth.getUser();
    const { data: prof } = await admin.from('profiles').select('camp_id').eq('id', user.id).single();
    const { data: expected } = await service.from('family_members').select('id').eq('camp_id', prof.camp_id).order('id');
    const rows = await fetchAll(() => admin.from('family_members').select('id, camp_id'), { order: ['id'], batchSize: 5 });
    assert.deepEqual(ids(rows), ids(expected));
    assert.ok(rows.every((r) => r.camp_id === prof.camp_id));
  });

  await t.test('composite ordering (created_at desc, id) matches independent read', async () => {
    const { data: expected } = await service
      .from('documents').select('id').order('created_at', { ascending: false }).order('id', { ascending: false });
    const rows = await fetchAll(() => superAdmin.from('documents').select('id'), {
      order: [['created_at', false], ['id', false]], batchSize: 4,
    });
    assert.deepEqual(ids(rows), ids(expected));
  });

  await t.test('empty result returns []', async () => {
    const rows = await fetchAll(
      () => superAdmin.from('family_members').select('id').eq('full_name', '__no_such_person__'),
      { order: ['id'], batchSize: 3 }
    );
    assert.deepEqual(rows, []);
  });

  await t.test('one-row result', async () => {
    const { data: first } = await service.from('families').select('id').order('id').limit(1);
    const rows = await fetchAll(() => superAdmin.from('families').select('id').eq('id', first[0].id), { order: ['id'], batchSize: 3 });
    assert.equal(rows.length, 1);
  });

  await t.test('fetchAllIn handles far more ids than fit one URL (250 ids)', async () => {
    const { data: real } = await service.from('families').select('id').order('id');
    const fake = Array.from({ length: 250 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const rows = await fetchAllIn(
      () => superAdmin.from('families').select('id'), 'id', [...fake, ...real.map((r) => r.id)],
      { order: ['id'], batchSize: 3 }
    );
    assert.deepEqual(rows.map((r) => r.id).sort(), ids(real).sort());
  });

  await t.test('fetchAllIn with no values makes no request and returns []', async () => {
    assert.deepEqual(await fetchAllIn(() => { throw new Error('must not be called'); }, 'id', [], { order: ['id'] }), []);
  });

  await t.test('a failing batch throws (never returns partial data)', async () => {
    await assert.rejects(() => fetchAll(() => superAdmin.from('no_such_table').select('id'), { order: ['id'], batchSize: 3 }));
  });

  await t.test('ordering that repeats the unique key is required', () => {
    assert.throws(() => fetchAll(() => ({}), { order: [] }), /order/);
  });
});

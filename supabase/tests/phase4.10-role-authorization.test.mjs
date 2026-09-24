// supabase/tests/phase4.10-role-authorization.test.mjs
/**
 * Phase 4.10 role-authorization: camps.html/camp-admins.html are both
 * Super-Admin-only in PAGE_ACCESS. This suite proves the *role* boundary
 * directly against RLS and the new get_camp_admin_accounts() RPC:
 * super_admin gets full camps CRUD and the RPC succeeds; camp_admin and
 * displaced are rejected on every write and on the RPC (42501, raised
 * from inside the function, not a silently-empty RLS result); anonymous
 * gets the public-only camps view and nothing else; the route guard
 * independently blocks camp_admin/displaced from both pages.
 *
 *   cd supabase && npm run frontend:config && npm run test:phase4.10-role-authorization
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile as readFileAsync } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };

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

function startServer() {
  return new Promise((resolvePromise) => {
    const server = createServer(async (req, res) => {
      const safePath = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
      const candidates = extname(safePath) ? [safePath] : [safePath, `${safePath}.html`];
      for (const candidate of candidates) {
        try {
          const filePath = join(ROOT, candidate);
          const body = await readFileAsync(filePath);
          res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
          res.end(body);
          return;
        } catch {
          // try the next candidate
        }
      }
      res.writeHead(404);
      res.end('not found');
    });
    server.listen(0, '127.0.0.1', () => resolvePromise(server));
  });
}

async function login(page, base, email, password) {
  await page.goto(`${base}/pages/login.html`, { waitUntil: 'load' });
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/dashboard/, { timeout: 15000 });
}

const PASSWORD = '123456';

test('Phase 4.10 camps/camp-admins role authorization', async (t) => {
  const SUPABASE_URL = required('SUPABASE_URL');
  const SUPABASE_PUBLISHABLE_KEY = required('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY');
  const SUPABASE_SECRET_KEY = required('SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY');
  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

  const server = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();

  try {
    await t.test('super_admin: full camps CRUD via RLS, get_camp_admin_accounts() succeeds', async () => {
      const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
      await client.auth.signInWithPassword({ email: 'super@camps.ps', password: PASSWORD });

      const { data: rows, error: selectError } = await client.from('camps').select('id, name');
      assert.equal(selectError, null, `super_admin select must succeed: ${selectError?.message}`);
      assert.ok(rows.length >= 3, 'super_admin must see all camps');

      const { data: created, error: insertError } = await client
        .from('camps')
        .insert({ name: `فحص الصلاحيات ${Date.now()}`, governorate: 'gaza', city: 'اختبار' })
        .select('id')
        .single();
      assert.equal(insertError, null, `super_admin insert must succeed: ${insertError?.message}`);

      const { error: updateError } = await client.from('camps').update({ city: 'محدَّث' }).eq('id', created.id);
      assert.equal(updateError, null, `super_admin update must succeed: ${updateError?.message}`);

      const { error: deleteError } = await client.from('camps').delete().eq('id', created.id);
      assert.equal(deleteError, null, `super_admin delete must succeed: ${deleteError?.message}`);

      const { data: admins, error: rpcError } = await client.rpc('get_camp_admin_accounts');
      assert.equal(rpcError, null, `get_camp_admin_accounts must succeed for super_admin: ${rpcError?.message}`);
      assert.ok(admins.length >= 3, 'must return at least the 3 seeded camp admins');
      assert.ok(admins.every((row) => row.email), 'every row must carry a non-null email');

      await client.auth.signOut();
    });

    await t.test('camp_admin: camps read-only, writes rejected 42501, RPC rejected from inside the function', async () => {
      const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
      await client.auth.signInWithPassword({ email: 'admin@camps.ps', password: PASSWORD });

      const { data: rows, error: selectError } = await client.from('camps').select('id, name');
      assert.equal(selectError, null, 'camp_admin select must be allowed (active camps + is_super_admin() OR clause)');
      assert.ok(rows.length >= 3, 'camp_admin must see the active camps');

      const { error: insertError } = await client
        .from('camps')
        .insert({ name: `يجب أن يُرفض ${Date.now()}`, governorate: 'gaza', city: 'x' });
      assert.ok(insertError, 'camp_admin insert must be rejected');
      assert.equal(insertError.code, '42501', `expected 42501, got ${insertError.code}: ${insertError.message}`);

      const { data: anyCamp } = await serviceClient.from('camps').select('id').limit(1).single();
      const { data: updated, error: updateError } = await client
        .from('camps')
        .update({ city: 'محاولة تعديل' })
        .eq('id', anyCamp.id)
        .select();
      assert.equal(updateError, null, 'RLS-blocked update must not error, only match zero rows');
      assert.equal(updated.length, 0, 'camp_admin update must affect zero rows');

      const { data: deleted, error: deleteError } = await client.from('camps').delete().eq('id', anyCamp.id).select();
      assert.equal(deleteError, null, 'RLS-blocked delete must not error, only match zero rows');
      assert.equal(deleted.length, 0, 'camp_admin delete must affect zero rows');

      const { data: rpcData, error: rpcError } = await client.rpc('get_camp_admin_accounts');
      assert.ok(rpcError, 'get_camp_admin_accounts must be rejected for camp_admin');
      assert.equal(rpcError.code, '42501', `expected 42501, got ${rpcError.code}: ${rpcError.message}`);
      assert.equal(rpcData, null, 'no rows leak to a rejected caller');

      // A profile within the camp_admin's OWN camp passes profiles_update_own_or_admin's
      // USING clause, so the row reaches private.guard_profile_privileges, which raises
      // 42501 explicitly on a role change by a non-super_admin (stricter than a plain
      // RLS filter, which would just match zero rows for an out-of-scope row instead).
      const { data: ownCampProfile } = await serviceClient
        .from('profiles')
        .select('id')
        .eq('role', 'displaced')
        .eq('camp_id', '5853adc9-9d23-4d4d-bc32-6fff17bdc3b0') // مخيم النور — admin@camps.ps's own camp
        .limit(1)
        .single();
      const { error: roleError } = await client
        .from('profiles')
        .update({ role: 'camp_admin' })
        .eq('id', ownCampProfile.id)
        .select();
      assert.ok(roleError, 'camp_admin must not be able to promote a profile in their own camp to camp_admin');
      assert.equal(roleError.code, '42501', `expected 42501, got ${roleError.code}: ${roleError.message}`);

      // A profile OUTSIDE the camp_admin's camp never passes RLS's USING clause at all,
      // so the row is invisible to the update and it silently matches zero rows.
      const { data: otherCampProfile } = await serviceClient
        .from('profiles')
        .select('id')
        .eq('role', 'displaced')
        .neq('camp_id', '5853adc9-9d23-4d4d-bc32-6fff17bdc3b0')
        .limit(1)
        .single();
      const { data: outOfScope, error: outOfScopeError } = await client
        .from('profiles')
        .update({ full_name: 'محاولة تعديل' })
        .eq('id', otherCampProfile.id)
        .select();
      assert.equal(outOfScopeError, null, 'RLS-blocked update on another camp\'s profile must not error, only match zero rows');
      assert.equal(outOfScope.length, 0, 'camp_admin must not affect a profile outside their own camp');

      await client.auth.signOut();
    });

    await t.test('displaced: same rejections as camp_admin', async () => {
      const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
      await client.auth.signInWithPassword({ email: 'ahmad@camps.ps', password: PASSWORD });

      const { error: insertError } = await client
        .from('camps')
        .insert({ name: `يجب أن يُرفض ${Date.now()}`, governorate: 'gaza', city: 'x' });
      assert.ok(insertError, 'displaced insert must be rejected');
      assert.equal(insertError.code, '42501', `expected 42501, got ${insertError.code}: ${insertError.message}`);

      const { data: rpcData, error: rpcError } = await client.rpc('get_camp_admin_accounts');
      assert.ok(rpcError, 'get_camp_admin_accounts must be rejected for displaced');
      assert.equal(rpcError.code, '42501', `expected 42501, got ${rpcError.code}: ${rpcError.message}`);
      assert.equal(rpcData, null, 'no rows leak to a rejected caller');

      await client.auth.signOut();
    });

    await t.test('anonymous: only active camps visible via select, every write and the RPC rejected', async () => {
      const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

      const { data: rows, error: selectError } = await client.from('camps').select('id, status');
      assert.equal(selectError, null, 'anonymous select of active camps is allowed by camps_select_anon');
      assert.ok(rows.every((row) => row.status === 'active'), 'anonymous must only ever see active camps');

      const { error: insertError } = await client
        .from('camps')
        .insert({ name: 'anon', governorate: 'gaza', city: 'x' });
      assert.ok(insertError, 'anonymous insert must be rejected');

      const { error: rpcError } = await client.rpc('get_camp_admin_accounts');
      assert.ok(rpcError, 'anonymous must not be able to call get_camp_admin_accounts');
    });

    await t.test('route guard: camp_admin and displaced sessions never render camps.html or camp-admins.html', async () => {
      for (const [email, label] of [['admin@camps.ps', 'camp_admin'], ['ahmad@camps.ps', 'displaced']]) {
        for (const pageName of ['camps.html', 'camp-admins.html']) {
          const page = await browser.newPage();
          await login(page, base, email, PASSWORD);
          await page.goto(`${base}/pages/${pageName}`, { waitUntil: 'load' });
          await page.waitForLoadState('networkidle');
          const url = page.url();
          assert.ok(url.includes('404'), `${label} on ${pageName}: expected redirect to 404, got ${url}`);
          await page.close();
        }
      }
    });

    await t.test('no service_role key or secret reaches the browser', async () => {
      const page = await browser.newPage();
      await login(page, base, 'super@camps.ps', PASSWORD);
      for (const pageName of ['camps.html', 'camp-admins.html']) {
        await page.goto(`${base}/pages/${pageName}`, { waitUntil: 'load' });
        const html = await page.content();
        assert.ok(!html.includes(SUPABASE_SECRET_KEY), `service role key must never appear in ${pageName}`);
      }
      await page.close();
    });
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
});

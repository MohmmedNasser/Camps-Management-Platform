// supabase/tests/phase4.9-role-authorization.test.mjs
/**
 * Phase 4.9 role-authorization: organizations has no camp_id and no
 * camp-scoped RLS predicate (spec §2/§6), so there is no camp boundary to
 * test. This suite instead proves the *role* boundary directly against
 * RLS: super_admin and camp_admin get full CRUD; displaced can SELECT
 * (intentional, spec §6) but never write; anonymous gets nothing; and the
 * page's own route guard independently blocks a displaced session from
 * ever rendering organizations.html.
 *
 *   cd supabase && npm run frontend:config && npm run test:phase4.9-role-authorization
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

test('Phase 4.9 organizations role authorization', async (t) => {
  const SUPABASE_URL = required('SUPABASE_URL');
  const SUPABASE_PUBLISHABLE_KEY = required('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY');
  const SUPABASE_SECRET_KEY = required('SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY');
  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

  const server = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();

  try {
    await t.test('super_admin and camp_admin: full select/insert/update/delete via RLS', async () => {
      for (const email of ['super@camps.ps', 'admin@camps.ps']) {
        const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
        await client.auth.signInWithPassword({ email, password: PASSWORD });

        const { data: rows, error: selectError } = await client.from('organizations').select('id, name');
        assert.equal(selectError, null, `${email} select must succeed: ${selectError?.message}`);
        assert.ok(rows.length > 0, `${email} must see organizations`);

        const { data: created, error: insertError } = await client
          .from('organizations')
          .insert({ name: `فحص الصلاحيات ${email} ${Date.now()}`, phone: null, responsible_person: null })
          .select('id')
          .single();
        assert.equal(insertError, null, `${email} insert must succeed: ${insertError?.message}`);

        const { error: updateError } = await client
          .from('organizations')
          .update({ responsible_person: 'محدَّث' })
          .eq('id', created.id);
        assert.equal(updateError, null, `${email} update must succeed: ${updateError?.message}`);

        const { error: deleteError } = await client.from('organizations').delete().eq('id', created.id);
        assert.equal(deleteError, null, `${email} delete must succeed: ${deleteError?.message}`);

        await client.auth.signOut();
      }
    });

    await t.test('displaced: select allowed, but insert/update/delete rejected with 42501', async () => {
      const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
      await client.auth.signInWithPassword({ email: 'ahmad@camps.ps', password: PASSWORD });

      const { data: rows, error: selectError } = await client.from('organizations').select('id, name').limit(1);
      assert.equal(selectError, null, 'displaced select must be allowed by RLS (spec §6)');
      assert.ok(rows.length > 0, 'displaced must see at least one organization');

      const { error: insertError } = await client
        .from('organizations')
        .insert({ name: `يجب أن يُرفض ${Date.now()}` });
      assert.ok(insertError, 'displaced insert must be rejected');
      assert.equal(insertError.code, '42501', `expected 42501, got ${insertError.code}: ${insertError.message}`);

      const { data: anyOrg } = await serviceClient.from('organizations').select('id').limit(1).single();

      const { data: updated, error: updateError } = await client
        .from('organizations')
        .update({ responsible_person: 'محاولة تعديل' })
        .eq('id', anyOrg.id)
        .select();
      assert.equal(updateError, null, 'RLS-blocked update must not error, only match zero rows');
      assert.equal(updated.length, 0, 'displaced update must affect zero rows');

      const { data: deleted, error: deleteError } = await client
        .from('organizations')
        .delete()
        .eq('id', anyOrg.id)
        .select();
      assert.equal(deleteError, null, 'RLS-blocked delete must not error, only match zero rows');
      assert.equal(deleted.length, 0, 'displaced delete must affect zero rows');

      await client.auth.signOut();
    });

    await t.test('anonymous: every operation rejected', async () => {
      const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
      const { error: selectError } = await client.from('organizations').select('id').limit(1);
      assert.ok(selectError, 'anonymous select must be rejected');

      const { error: insertError } = await client.from('organizations').insert({ name: 'anon' });
      assert.ok(insertError, 'anonymous insert must be rejected');
    });

    await t.test('route guard: displaced session never renders organizations.html', async () => {
      const page = await browser.newPage();
      await login(page, base, 'ahmad@camps.ps', PASSWORD);
      await page.goto(`${base}/pages/organizations.html`, { waitUntil: 'load' });
      await page.waitForLoadState('networkidle');
      const url = page.url();
      assert.ok(url.includes('404'), `expected redirect to 404, got ${url}`);
      await page.close();
    });

    await t.test('no service_role key or secret reaches the browser', async () => {
      const page = await browser.newPage();
      await login(page, base, 'admin@camps.ps', PASSWORD);
      await page.goto(`${base}/pages/organizations.html`, { waitUntil: 'load' });
      const html = await page.content();
      assert.ok(!html.includes(SUPABASE_SECRET_KEY), 'service role key must never appear in page HTML');
      await page.close();
    });
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
});

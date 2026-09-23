// supabase/tests/phase4.7-camp-isolation.test.mjs
/**
 * Phase 4.7 cross-camp isolation: proves a Camp Admin cannot read, approve,
 * reject, or directly update another camp's registration requests — through
 * RLS and the approve/reject RPCs directly, not merely "the UI doesn't show
 * it." Camp النور has 5 seeded requests; camp الرحمة has none, so this
 * suite inserts one throwaway pending request into camp الرحمة (via a
 * service-role client — registration_requests has no client-reachable
 * DELETE policy, so cleanup must also use service-role) to exercise the
 * cross-camp approve/reject rejection.
 *
 *   cd supabase && npm run frontend:config && npm run test:phase4.7-camp-isolation
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

const CAMPS = {
  'admin@camps.ps': '5853adc9-9d23-4d4d-bc32-6fff17bdc3b0',
  'nour@camps.ps': '05a29dd9-ae3f-4f4d-bcc3-05f0cd8b4405',
};
const PASSWORD = '123456';

test('Phase 4.7 cross-camp isolation', async (t) => {
  const SUPABASE_URL = required('SUPABASE_URL');
  const SUPABASE_PUBLISHABLE_KEY = required('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY');
  const SUPABASE_SECRET_KEY = required('SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY');

  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);
  const server = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();

  // Fixture: a pending request in camp الرحمة, so cross-camp approve/reject
  // against admin@camps.ps (camp النور) has something to be rejected on.
  const { data: fixture, error: fixtureError } = await serviceClient
    .from('registration_requests')
    .insert({
      full_name: 'اختبار عزل المخيمات',
      national_id: '999000111',
      email: 'phase47-isolation-fixture@example.test',
      camp_id: CAMPS['nour@camps.ps'],
      status: 'pending',
      user_id: null,
    })
    .select('id')
    .single();
  assert.equal(fixtureError, null, `fixture insert must succeed: ${fixtureError?.message}`);
  const fixtureId = fixture.id;

  try {
    await t.test("admin@camps.ps: RLS returns only own-camp registration_requests, zero of the other camp's", async () => {
      const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
      await client.auth.signInWithPassword({ email: 'admin@camps.ps', password: PASSWORD });
      const { data: allVisible } = await client.from('registration_requests').select('id, camp_id');
      assert.ok(allVisible.length > 0, 'must see at least one own-camp request');
      assert.ok(
        allVisible.every((r) => r.camp_id === CAMPS['admin@camps.ps']),
        "must see zero of camp الرحمة's requests, including the fixture"
      );
      await client.auth.signOut();
    });

    await t.test("registration-request-details for camp الرحمة's fixture id renders not-found for admin@camps.ps", async () => {
      const page = await browser.newPage();
      await login(page, base, 'admin@camps.ps', PASSWORD);
      await page.goto(`${base}/pages/registration-request-details.html?id=${fixtureId}`, { waitUntil: 'load' });
      await page.waitForSelector('.empty, h3', { timeout: 15000 });
      const bodyText = await page.locator('body').innerText();
      assert.ok(bodyText.includes('غير موجود'), `expected not-found state, got: ${bodyText.slice(0, 200)}`);
      await page.close();
    });

    await t.test("approve_registration_request on camp الرحمة's fixture is rejected with 42501 for admin@camps.ps", async () => {
      const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
      await client.auth.signInWithPassword({ email: 'admin@camps.ps', password: PASSWORD });
      const { error } = await client.rpc('approve_registration_request', {
        p_request_id: fixtureId,
        p_gender: 'male',
        p_birth_date: '1990-01-01',
      });
      assert.ok(error, 'cross-camp approve must be rejected');
      assert.equal(error.code, '42501', `expected 42501, got ${error.code}: ${error.message}`);
      await client.auth.signOut();
    });

    await t.test("reject_registration_request on camp الرحمة's fixture is rejected with 42501 for admin@camps.ps", async () => {
      const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
      await client.auth.signInWithPassword({ email: 'admin@camps.ps', password: PASSWORD });
      const { error } = await client.rpc('reject_registration_request', { p_request_id: fixtureId, p_note: 'محاولة عبر مخيم آخر' });
      assert.ok(error, 'cross-camp reject must be rejected');
      assert.equal(error.code, '42501', `expected 42501, got ${error.code}: ${error.message}`);
      await client.auth.signOut();
    });

    await t.test("a raw update on camp الرحمة's fixture — admin@camps.ps — affects zero rows", async () => {
      const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
      await client.auth.signInWithPassword({ email: 'admin@camps.ps', password: PASSWORD });
      const { data: updated, error } = await client
        .from('registration_requests')
        .update({ note: 'محاولة تعديل مباشر' })
        .eq('id', fixtureId)
        .select();
      assert.equal(error, null, 'RLS-blocked update must not error, only match zero rows');
      assert.equal(updated.length, 0, "must not be able to update another camp's request directly");
      await client.auth.signOut();
    });

    await t.test("rendered list for admin@camps.ps never contains camp الرحمة's fixture applicant name", async () => {
      const page = await browser.newPage();
      await login(page, base, 'admin@camps.ps', PASSWORD);
      await page.goto(`${base}/pages/registration-requests.html?status=`, { waitUntil: 'load' });
      await page.waitForSelector('table, .empty-state', { timeout: 15000 });
      const bodyText = await page.locator('body').innerText();
      assert.ok(!bodyText.includes('اختبار عزل المخيمات'), "must never render another camp's applicant name");
      await page.close();
    });
  } finally {
    await serviceClient.from('registration_requests').delete().eq('id', fixtureId);
    await browser.close();
    await new Promise((r) => server.close(r));
  }
});

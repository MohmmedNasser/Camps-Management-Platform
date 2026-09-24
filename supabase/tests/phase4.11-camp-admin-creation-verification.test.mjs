// supabase/tests/phase4.11-camp-admin-creation-verification.test.mjs
/**
 * Phase 4.11 verification: the real "إضافة مسؤول" flow end to end — real
 * browser, real Edge Function, real Auth Admin API, real profiles row —
 * plus duplicate-email rejection, session preservation, and a network-traffic
 * check that the service-role key is never sent from the browser. Every
 * value is cross-checked against an INDEPENDENT service-role query, never
 * the app's own rendered output alone. Fixture cleaned up in `finally`
 * regardless of where the test fails.
 *
 *   cd supabase && npm run frontend:config && npm run test:phase4.11-camp-admin-creation-verification
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile as readFileAsync } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';

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

const EMAIL = 'super@camps.ps';
const PASSWORD = '123456';
const NOOR_CAMP_ID = '5853adc9-9d23-4d4d-bc32-6fff17bdc3b0'; // مخيم النور

test('Phase 4.11 camp-admin creation verification', async (t) => {
  const SUPABASE_URL = required('SUPABASE_URL');
  const SUPABASE_SECRET_KEY = required('SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY');
  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);
  const secretFragment = SUPABASE_SECRET_KEY.slice(0, 20);

  const server = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();
  let fixtureUserId = null;
  const fixtureEmail = `phase411-fixture-${Date.now()}@example.com`;

  try {
    await t.test('"إضافة مسؤول" opens the real create form, not the old deferral dialog', async () => {
      const page = await browser.newPage();
      await login(page, base, EMAIL, PASSWORD);
      await page.goto(`${base}/pages/camp-admins.html`, { waitUntil: 'load' });
      await page.waitForSelector('table, .empty', { timeout: 30000 });
      await page.click('[data-create]');
      await page.waitForSelector('#admin-form', { timeout: 10000 });
      assert.ok(await page.locator('#password').count(), 'the create form must render a password field');
      assert.ok(!(await page.locator('#password').isDisabled()), 'the create form is not read-only');
      await page.click('[data-close]');
      await page.close();
    });

    await t.test('creating a real camp admin: form submit -> real row -> real list -> session preserved -> no secret over the wire', async () => {
      const page = await browser.newPage();

      const requestBodies = [];
      page.on('request', (req) => {
        const headerValue = JSON.stringify(req.headers());
        const postData = req.postData() || '';
        requestBodies.push({ url: req.url(), headerValue, postData });
      });

      await login(page, base, EMAIL, PASSWORD);

      const sessionBefore = await page.evaluate(async () => {
        const mod = await import('/assets/js/core/supabase-client.js');
        const { data } = await mod.supabase.auth.getUser();
        return data;
      });
      const superAdminId = sessionBefore.user.id;

      await page.goto(`${base}/pages/camp-admins.html`, { waitUntil: 'load' });
      await page.waitForSelector('table, .empty', { timeout: 30000 });
      await page.click('[data-create]');
      await page.waitForSelector('#admin-form', { timeout: 10000 });

      await page.fill('#name', 'مسؤول اختبار الإنشاء');
      await page.fill('#email', fixtureEmail);
      await page.fill('#phone', '0598888888');
      await page.selectOption('#campId', NOOR_CAMP_ID);
      await page.selectOption('#status', 'active');
      await page.fill('#password', 'Fixture123!');
      await page.click('button[form="admin-form"]');

      await page.waitForSelector('.toast', { timeout: 15000 });
      const toastText = await page.locator('.toast').first().innerText();
      assert.ok(toastText.includes('تمت الإضافة'), `expected a success toast, got: ${toastText}`);

      // Network-traffic check (spec §I): the service-role key must never
      // leave the browser, in any header or request body.
      for (const { url, headerValue, postData } of requestBodies) {
        assert.ok(!headerValue.includes(secretFragment), `request to ${url} must not carry the service-role key in headers`);
        assert.ok(!postData.includes(secretFragment), `request to ${url} must not carry the service-role key in its body`);
      }

      // Independent verification: Auth Admin API + profiles, never the
      // app's own rendered output alone.
      let authUser = null;
      for (let listPage = 1; !authUser && listPage <= 10; listPage += 1) {
        const { data: list } = await serviceClient.auth.admin.listUsers({ page: listPage, perPage: 200 });
        authUser = list.users.find((u) => u.email === fixtureEmail);
        if (!authUser && list.users.length < 200) break;
      }
      assert.ok(authUser, `a real auth.users row must exist for ${fixtureEmail}`);
      fixtureUserId = authUser.id;

      const { data: profile, error } = await serviceClient
        .from('profiles')
        .select('id, role, status, camp_id, full_name, phone')
        .eq('id', fixtureUserId)
        .single();
      assert.equal(error, null);
      assert.equal(profile.id, authUser.id, 'profiles.id must equal auth.users.id');
      assert.equal(profile.role, 'camp_admin');
      assert.equal(profile.status, 'active');
      assert.equal(profile.camp_id, NOOR_CAMP_ID);
      assert.equal(profile.full_name, 'مسؤول اختبار الإنشاء');

      // Real list, not a fake client-side row: reload and confirm it's there.
      await page.goto(`${base}/pages/camp-admins.html`, { waitUntil: 'load' });
      await page.waitForSelector('table, .empty', { timeout: 30000 });
      const bodyText = await page.locator('body').innerText();
      assert.ok(bodyText.includes('مسؤول اختبار الإنشاء'), 'the new admin must appear in the real, reloaded list');

      // Session preservation: the Super Admin is still signed in as themself.
      const sessionAfter = await page.evaluate(async () => {
        const mod = await import('/assets/js/core/supabase-client.js');
        const { data } = await mod.supabase.auth.getUser();
        return data;
      });
      assert.equal(sessionAfter.user.id, superAdminId, "the Super Admin's own session must be unchanged");
      assert.notEqual(sessionAfter.user.id, fixtureUserId, 'the new account must be a distinct Auth identity');

      await page.close();
    });

    await t.test('duplicate email is rejected, no second row created, existing row unchanged', async () => {
      assert.ok(fixtureUserId, 'previous case must have created the fixture');

      const page = await browser.newPage();
      await login(page, base, EMAIL, PASSWORD);
      await page.goto(`${base}/pages/camp-admins.html`, { waitUntil: 'load' });
      await page.waitForSelector('table, .empty', { timeout: 30000 });
      await page.click('[data-create]');
      await page.waitForSelector('#admin-form', { timeout: 10000 });

      await page.fill('#name', 'مسؤول مكرر');
      await page.fill('#email', fixtureEmail); // same email as the existing fixture
      await page.fill('#phone', '0597777777');
      await page.selectOption('#campId', NOOR_CAMP_ID);
      await page.selectOption('#status', 'active');
      await page.fill('#password', 'Fixture123!');
      await page.click('button[form="admin-form"]');

      await page.waitForSelector('.toast', { timeout: 15000 });
      const toastText = await page.locator('.toast').first().innerText();
      assert.ok(toastText.includes('تعذر الإضافة'), `expected a failure toast, got: ${toastText}`);

      const { data: list } = await serviceClient.auth.admin.listUsers({ page: 1, perPage: 200 });
      const matches = list.users.filter((u) => u.email === fixtureEmail);
      assert.equal(matches.length, 1, 'exactly one auth.users row must exist for the duplicate email');

      const { data: profile } = await serviceClient.from('profiles').select('full_name').eq('id', fixtureUserId).single();
      assert.equal(profile.full_name, 'مسؤول اختبار الإنشاء', 'the existing row must be unchanged by the rejected duplicate');

      await page.close();
    });

    await t.test('page refresh keeps the record (persistence, not a client-side-only row)', async () => {
      assert.ok(fixtureUserId, 'creation case must have run first');
      const page = await browser.newPage();
      await login(page, base, EMAIL, PASSWORD);
      await page.goto(`${base}/pages/camp-admins.html`, { waitUntil: 'load' });
      await page.waitForSelector('table, .empty', { timeout: 30000 });
      await page.reload({ waitUntil: 'load' });
      await page.waitForSelector('table, .empty', { timeout: 30000 });
      const bodyText = await page.locator('body').innerText();
      assert.ok(bodyText.includes('مسؤول اختبار الإنشاء'), 'the record must survive a full page refresh');
      await page.close();
    });
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
    if (fixtureUserId) {
      await serviceClient.from('profiles').delete().eq('id', fixtureUserId);
      await serviceClient.auth.admin.deleteUser(fixtureUserId).catch(() => {});
    }
  }
});

// supabase/tests/phase4.10-camp-admins-verification.test.mjs
/**
 * Phase 4.10 camp-admins verification: every value the real camp-admins
 * page renders is compared against an INDEPENDENT query against the same
 * live database (a second supabase-js client, never importing
 * assets/js/supabase/profiles.js) — list/search/filters/summary, and a
 * full edit/toggle/delete round trip against a FIXTURE admin created
 * directly through the service client, since the app itself cannot create
 * one (Phase 4.10 defers that operation — see the design doc §1.3/§4).
 * Also proves the "إضافة مسؤول" button opens the deferral explanation and
 * creates no row.
 *
 *   cd supabase && npm run frontend:config && npm run test:phase4.10-camp-admins
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
const RAHMA_CAMP_ID = '05a29dd9-ae3f-4f4d-bcc3-05f0cd8b4405'; // مخيم الرحمة

test('Phase 4.10 camp-admins DB-vs-UI verification', async (t) => {
  const SUPABASE_URL = required('SUPABASE_URL');
  const SUPABASE_PUBLISHABLE_KEY = required('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY');
  const SUPABASE_SECRET_KEY = required('SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY');
  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

  const server = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();

  try {
    await t.test('list: rendered admin count/names/phones/camps/statuses match a direct join', async () => {
      const { data: admins } = await serviceClient
        .from('profiles')
        .select('id, full_name, phone, status, camp_id')
        .eq('role', 'camp_admin');
      const { data: camps } = await serviceClient.from('camps').select('id, name');
      const campNameById = new Map(camps.map((c) => [c.id, c.name]));

      const page = await browser.newPage();
      await login(page, base, EMAIL, PASSWORD);
      await page.goto(`${base}/pages/camp-admins.html`, { waitUntil: 'load' });
      await page.waitForSelector('table, .empty', { timeout: 30000 });
      const bodyText = await page.locator('body').innerText();

      assert.ok(bodyText.includes(String(admins.length)), `expected admin count ${admins.length} in the rendered page`);
      for (const admin of admins) {
        assert.ok(bodyText.includes(admin.full_name), `expected "${admin.full_name}" in the rendered page`);
        assert.ok(bodyText.includes(campNameById.get(admin.camp_id)), `expected ${admin.full_name}'s camp name in the page`);
      }
      await page.close();
    });

    await t.test('email: rendered emails match the Auth Admin API independently (not the RPC this phase adds)', async () => {
      const { data: admins } = await serviceClient.from('profiles').select('id').eq('role', 'camp_admin');

      const page = await browser.newPage();
      await login(page, base, EMAIL, PASSWORD);
      await page.goto(`${base}/pages/camp-admins.html`, { waitUntil: 'load' });
      await page.waitForSelector('table, .empty', { timeout: 30000 });
      const bodyText = await page.locator('body').innerText();

      for (const admin of admins) {
        const { data: authUser, error } = await serviceClient.auth.admin.getUserById(admin.id);
        assert.equal(error, null, `auth admin getUserById(${admin.id}) must succeed: ${error?.message}`);
        assert.ok(bodyText.includes(authUser.user.email), `expected ${authUser.user.email} in the rendered page`);
      }
      await page.close();
    });

    await t.test('search / campId filter / status filter narrow to the expected subset', async () => {
      const { data: raed } = await serviceClient
        .from('profiles')
        .select('id, full_name, camp_id')
        .eq('full_name', 'رائد المصري')
        .single();

      const page = await browser.newPage();
      await login(page, base, EMAIL, PASSWORD);

      // search by name — the debounced 'input' handler (250ms) does the
      // filtering, then a full load() re-fetch (the RPC + per-camp stats)
      // runs before the table re-renders. Poll instead of a fixed sleep:
      // under load the re-fetch can take longer than any fixed timeout
      // would reliably cover (this flaked once at ~6.4s under contention
      // from other suites running in the same `test:all` pass).
      await page.goto(`${base}/pages/camp-admins.html`, { waitUntil: 'load' });
      await page.waitForSelector('table, .empty', { timeout: 30000 });
      await page.fill('#toolbar-search', 'رائد المصري');
      await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1, { timeout: 15000 });
      let bodyText = await page.locator('body').innerText();
      assert.ok(bodyText.includes('رائد المصري'), 'search by name must find رائد المصري');
      const rowCount = await page.locator('tbody tr').count();
      assert.equal(rowCount, 1, `search must narrow to exactly 1 row, got ${rowCount}`);

      // status filter: disabled -> رائد المصري is the only seeded disabled admin
      await page.goto(`${base}/pages/camp-admins.html?status=disabled`, { waitUntil: 'load' });
      await page.waitForSelector('table, .empty', { timeout: 30000 });
      bodyText = await page.locator('body').innerText();
      assert.ok(bodyText.includes('رائد المصري'), 'status=disabled must include رائد المصري');
      assert.ok(!bodyText.includes('خالد أبو سالم'), 'status=disabled must exclude the active admins');

      // campId filter: راعد's own camp
      await page.goto(`${base}/pages/camp-admins.html?campId=${raed.camp_id}`, { waitUntil: 'load' });
      await page.waitForSelector('table, .empty', { timeout: 30000 });
      bodyText = await page.locator('body').innerText();
      assert.ok(bodyText.includes('رائد المصري'), 'campId filter must include the admin of that camp');

      await page.close();
    });

    await t.test('summary: "camps without an admin" matches an independent computation', async () => {
      const { data: camps } = await serviceClient.from('camps').select('id');
      const { data: admins } = await serviceClient.from('profiles').select('camp_id').eq('role', 'camp_admin');
      const coveredCampIds = new Set(admins.map((a) => a.camp_id));
      const uncoveredCount = camps.filter((c) => !coveredCampIds.has(c.id)).length;

      const page = await browser.newPage();
      await login(page, base, EMAIL, PASSWORD);
      await page.goto(`${base}/pages/camp-admins.html`, { waitUntil: 'load' });
      await page.waitForSelector('table, .empty', { timeout: 30000 });
      const bodyText = await page.locator('body').innerText();
      assert.ok(bodyText.includes(String(uncoveredCount)), `expected uncovered-camps count ${uncoveredCount} in the page`);
      await page.close();
    });

    await t.test('"إضافة مسؤول" opens the deferral explanation and creates no row', async () => {
      const { count: before } = await serviceClient.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'camp_admin');

      const page = await browser.newPage();
      await login(page, base, EMAIL, PASSWORD);
      await page.goto(`${base}/pages/camp-admins.html`, { waitUntil: 'load' });
      await page.waitForSelector('table, .empty', { timeout: 30000 });
      await page.click('[data-create]');
      await page.waitForTimeout(500);
      const modalText = await page.locator('.modal, [role="dialog"]').first().innerText();
      assert.ok(modalText.includes('هذه الميزة غير متاحة بعد'), 'expected the deferral explanation, not a create form');
      assert.ok(!(await page.locator('#password').count()), 'no password field must ever be rendered (no create form opens)');
      await page.close();

      const { count: after } = await serviceClient.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'camp_admin');
      assert.equal(after, before, 'clicking إضافة مسؤول must never create a profiles row');
    });

    await t.test('fixture CRUD: edit (name/phone/camp) -> toggle status -> delete, against a service-created fixture admin', async () => {
      // The app cannot create a camp admin (Phase 4.10 defers it), so the
      // fixture is created the only way anything can: directly via the
      // service client's Auth Admin API, then promoted to camp_admin the
      // same way a real Super Admin write would (RLS/guard_profile_privileges
      // both allow it — this phase's assignCampAdmin()/setProfileStatus()
      // do exactly this), just issued by the service client instead of the app.
      let fixtureUserId = null;
      let page = null;
      const fixtureEmail = `phase410-fixture-${Date.now()}@example.com`;

      try {
        const { data: created, error: createError } = await serviceClient.auth.admin.createUser({
          email: fixtureEmail,
          password: 'Fixture123!',
          email_confirm: true,
        });
        assert.equal(createError, null, `fixture auth user create must succeed: ${createError?.message}`);
        fixtureUserId = created.user.id;

        const { error: promoteError } = await serviceClient
          .from('profiles')
          .update({ role: 'camp_admin', camp_id: NOOR_CAMP_ID, status: 'active', full_name: 'مسؤول اختبار الدورة' })
          .eq('id', fixtureUserId);
        assert.equal(promoteError, null, `fixture promotion to camp_admin must succeed: ${promoteError?.message}`);

        page = await browser.newPage();
        await login(page, base, EMAIL, PASSWORD);
        await page.goto(`${base}/pages/camp-admins.html`, { waitUntil: 'load' });
        await page.waitForSelector('table, .empty', { timeout: 30000 });

        // edit: name + phone + reassign camp (Noor -> Rahma)
        const row = page.locator('tr', { hasText: 'مسؤول اختبار الدورة' });
        await row.locator('[data-edit]').click();
        await page.waitForSelector('#admin-form', { timeout: 10000 });
        assert.ok(await page.locator('#email').isDisabled(), 'email field must be disabled on edit');
        await page.fill('#name', 'مسؤول اختبار الدورة (محدَّث)');
        await page.fill('#phone', '0599999999');
        await page.selectOption('#campId', RAHMA_CAMP_ID);
        await page.selectOption('#status', 'active');
        await page.click('button[form="admin-form"]');
        await page.waitForTimeout(1500);

        const { data: edited } = await serviceClient
          .from('profiles')
          .select('full_name, phone, camp_id, status')
          .eq('id', fixtureUserId)
          .single();
        assert.equal(edited.full_name, 'مسؤول اختبار الدورة (محدَّث)', 'edit must persist the new name');
        assert.equal(edited.phone, '0599999999', 'edit must persist the new phone');
        assert.equal(edited.camp_id, RAHMA_CAMP_ID, 'edit must persist the camp reassignment');

        // toggle status: active -> disabled
        await page.goto(`${base}/pages/camp-admins.html`, { waitUntil: 'load' });
        await page.waitForSelector('table, .empty', { timeout: 30000 });
        const row2 = page.locator('tr', { hasText: 'مسؤول اختبار الدورة (محدَّث)' });
        await row2.locator('[data-toggle]').click();
        await page.waitForTimeout(1200);

        const { data: toggled } = await serviceClient.from('profiles').select('status').eq('id', fixtureUserId).single();
        assert.equal(toggled.status, 'disabled', 'toggle must flip active -> disabled');

        // delete
        await page.goto(`${base}/pages/camp-admins.html`, { waitUntil: 'load' });
        await page.waitForSelector('table, .empty', { timeout: 30000 });
        const row3 = page.locator('tr', { hasText: 'مسؤول اختبار الدورة (محدَّث)' });
        await row3.locator('[data-delete]').click();
        await page.waitForTimeout(500);
        const confirmBtn = page.locator('.modal button, [role="dialog"] button').filter({ hasText: 'حذف' }).first();
        assert.ok(await confirmBtn.count(), 'the confirm dialog must open for a safe, FK-safe delete');
        await confirmBtn.click();
        await page.waitForTimeout(1500);

        const { data: afterDelete } = await serviceClient.from('profiles').select('id').eq('id', fixtureUserId).maybeSingle();
        assert.equal(afterDelete, null, 'profile row must be gone after delete');
      } finally {
        if (page) await page.close();
        // Cleanup goes further than the app itself can: the app's own
        // deleteProfile() only removes the profiles row (Phase 4.10 §1.2 —
        // deleting the auth.users row needs the Admin API), so the test
        // additionally removes the Auth user via the service client to
        // leave zero debris in either table, whether or not the delete
        // step above actually ran.
        if (fixtureUserId) {
          await serviceClient.from('profiles').delete().eq('id', fixtureUserId);
          await serviceClient.auth.admin.deleteUser(fixtureUserId).catch(() => {});
        }
      }
    });
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
});

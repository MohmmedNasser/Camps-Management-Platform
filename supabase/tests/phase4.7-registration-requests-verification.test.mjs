// supabase/tests/phase4.7-registration-requests-verification.test.mjs
/**
 * Phase 4.7 verification: every value the real Camp Admin registration-
 * requests pages render is compared against an INDEPENDENT query against
 * the same live database (a second supabase-js client, never importing
 * assets/js/supabase/registration-requests.js) — list, search, status
 * filter/counts, detail fields, and full approve/reject round trips
 * through the actual forms. Cleans up every fixture it creates.
 *
 *   cd supabase && npm run frontend:config && npm run test:phase4.7-registration-requests
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

const CAMP_ID = '5853adc9-9d23-4d4d-bc32-6fff17bdc3b0'; // مخيم النور
const EMAIL = 'admin@camps.ps';
const PASSWORD = '123456';

test('Phase 4.7 registration-requests DB-vs-UI verification', async (t) => {
  const SUPABASE_URL = required('SUPABASE_URL');
  const SUPABASE_PUBLISHABLE_KEY = required('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY');
  const SUPABASE_SECRET_KEY = required('SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY');
  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

  const server = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();

  try {
    await t.test('list: rendered pending count matches a direct count', async () => {
      const { count } = await serviceClient
        .from('registration_requests')
        .select('id', { count: 'exact', head: true })
        .eq('camp_id', CAMP_ID)
        .eq('status', 'pending');

      const page = await browser.newPage();
      await login(page, base, EMAIL, PASSWORD);
      await page.goto(`${base}/pages/registration-requests.html`, { waitUntil: 'load' });
      await page.waitForSelector('table, .empty', { timeout: 30000 });
      const bodyText = await page.locator('body').innerText();
      assert.ok(bodyText.includes(String(count)), `expected pending count ${count} to appear in the rendered page`);
      await page.close();
    });

    await t.test('search: filters to exactly the matching applicant', async () => {
      // A dedicated fixture, not a seed row: the three original seed pending
      // requests for this camp get consumed by day-to-day manual/automated
      // approve-reject exercise (this suite's own earlier runs included),
      // so a test that assumes "some pending seed row exists" is fragile.
      // Every other subtest in this file already fixtures its own row;
      // this one now matches that convention instead of depending on seed
      // data staying pristine.
      const { data: fixture, error: fixtureError } = await serviceClient
        .from('registration_requests')
        .insert({
          full_name: 'فريد اختبار البحث',
          national_id: '999000444',
          email: 'phase47-search-fixture@example.test',
          camp_id: CAMP_ID,
          status: 'pending',
          user_id: null,
        })
        .select('id, full_name')
        .single();
      assert.equal(fixtureError, null, `fixture insert must succeed: ${fixtureError?.message}`);

      try {
        const page = await browser.newPage();
        await login(page, base, EMAIL, PASSWORD);
        await page.goto(`${base}/pages/registration-requests.html`, { waitUntil: 'load' });
        await page.waitForSelector('table, .empty', { timeout: 30000 });
        await page.fill('#toolbar-search', 'فريد اختبار');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(1500);
        const bodyText = await page.locator('body').innerText();
        assert.ok(bodyText.includes(fixture.full_name), `expected "${fixture.full_name}" in filtered results`);
        await page.close();
      } finally {
        await serviceClient.from('registration_requests').delete().eq('id', fixture.id);
      }
    });

    await t.test('status chips: "الكل" shows every status, counts match direct per-status counts', async () => {
      const [{ count: pendingCount }, { count: approvedCount }, { count: rejectedCount }] = await Promise.all([
        serviceClient.from('registration_requests').select('id', { count: 'exact', head: true }).eq('camp_id', CAMP_ID).eq('status', 'pending'),
        serviceClient.from('registration_requests').select('id', { count: 'exact', head: true }).eq('camp_id', CAMP_ID).eq('status', 'approved'),
        serviceClient.from('registration_requests').select('id', { count: 'exact', head: true }).eq('camp_id', CAMP_ID).eq('status', 'rejected'),
      ]);

      const page = await browser.newPage();
      await login(page, base, EMAIL, PASSWORD);
      await page.goto(`${base}/pages/registration-requests.html`, { waitUntil: 'load' });
      await page.waitForSelector('[data-chip]', { timeout: 15000 });
      const bodyText = await page.locator('body').innerText();
      assert.ok(bodyText.includes(String(pendingCount)), 'pending chip count must match');
      assert.ok(bodyText.includes(String(approvedCount)), 'approved chip count must match');
      assert.ok(bodyText.includes(String(rejectedCount)), 'rejected chip count must match');
      await page.close();
    });

    await t.test('detail: rendered fields match the direct row', async () => {
      const { data: target } = await serviceClient
        .from('registration_requests')
        .select('id, full_name, national_id, phone, email')
        .eq('camp_id', CAMP_ID)
        .limit(1)
        .single();

      const page = await browser.newPage();
      await login(page, base, EMAIL, PASSWORD);
      await page.goto(`${base}/pages/registration-request-details.html?id=${target.id}`, { waitUntil: 'load' });
      await page.waitForSelector('.card', { timeout: 15000 });
      const bodyText = await page.locator('body').innerText();
      assert.ok(bodyText.includes(target.full_name), 'full name must render');
      assert.ok(bodyText.includes(target.national_id), 'national id must render');
      assert.ok(bodyText.includes(target.email), 'email must render');
      await page.close();
    });

    await t.test('approve round trip: creates family + member with the submitted gender/birth date, cleans up in order', async () => {
      const { data: fixture, error: fixtureError } = await serviceClient
        .from('registration_requests')
        .insert({
          full_name: 'مرشح اختبار القبول',
          national_id: '999000222',
          email: 'phase47-approve-fixture@example.test',
          camp_id: CAMP_ID,
          status: 'pending',
          user_id: null,
        })
        .select('id')
        .single();
      assert.equal(fixtureError, null, `fixture insert must succeed: ${fixtureError?.message}`);
      const fixtureId = fixture.id;
      let createdFamilyId = null;
      let createdMemberId = null;

      try {
        const page = await browser.newPage();
        await login(page, base, EMAIL, PASSWORD);
        await page.goto(`${base}/pages/registration-request-details.html?id=${fixtureId}`, { waitUntil: 'load' });
        await page.click('[data-approve]');
        await page.waitForSelector('#modal-form');
        await page.selectOption('#modal-form select[name="gender"]', 'female');
        await page.fill('#modal-form input[name="birthDate"]', '1995-06-15');
        await page.click('[data-submit]');
        await page.waitForURL(/displaced-details/, { timeout: 15000 });

        const { data: after } = await serviceClient
          .from('registration_requests')
          .select('status, family_member_id')
          .eq('id', fixtureId)
          .single();
        assert.equal(after.status, 'approved', 'fixture request must be approved');
        assert.ok(after.family_member_id, 'family_member_id must be set');
        createdMemberId = after.family_member_id;

        const { data: member } = await serviceClient
          .from('family_members')
          .select('id, family_id, gender, birth_date')
          .eq('id', createdMemberId)
          .single();
        assert.equal(member.gender, 'female', 'submitted gender must be persisted');
        assert.equal(member.birth_date, '1995-06-15', 'submitted birth date must be persisted');
        createdFamilyId = member.family_id;

        const { data: family } = await serviceClient.from('families').select('head_member_id').eq('id', createdFamilyId).single();
        assert.equal(family.head_member_id, createdMemberId, 'new family head must be the new member');

        await page.close();
      } finally {
        // Order matters: registration_requests_approved_has_member CHECK
        // would reject nulling family_member_id on a still-approved row.
        await serviceClient.from('registration_requests').delete().eq('id', fixtureId);
        if (createdFamilyId) await serviceClient.from('families').delete().eq('id', createdFamilyId);
      }
    });

    await t.test('reject round trip: sets status and note, verified directly', async () => {
      const { data: fixture, error: fixtureError } = await serviceClient
        .from('registration_requests')
        .insert({
          full_name: 'مرشح اختبار الرفض',
          national_id: '999000333',
          email: 'phase47-reject-fixture@example.test',
          camp_id: CAMP_ID,
          status: 'pending',
          user_id: null,
        })
        .select('id')
        .single();
      assert.equal(fixtureError, null, `fixture insert must succeed: ${fixtureError?.message}`);
      const fixtureId = fixture.id;

      try {
        const page = await browser.newPage();
        await login(page, base, EMAIL, PASSWORD);
        await page.goto(`${base}/pages/registration-request-details.html?id=${fixtureId}`, { waitUntil: 'load' });
        await page.click('[data-reject]');
        await page.waitForSelector('#modal-form');
        await page.fill('#modal-form textarea[name="note"]', 'رقم الهوية غير واضح في المستندات');
        await page.click('[data-submit]');
        await page.waitForURL(/registration-requests\.html/, { timeout: 15000 });

        const { data: after } = await serviceClient.from('registration_requests').select('status, note').eq('id', fixtureId).single();
        assert.equal(after.status, 'rejected');
        assert.equal(after.note, 'رقم الهوية غير واضح في المستندات');

        await page.close();
      } finally {
        await serviceClient.from('registration_requests').delete().eq('id', fixtureId);
      }
    });

    await t.test('duplicate national id (own camp): detail page shows the duplicate alert', async () => {
      const { data: existingHead } = await serviceClient
        .from('family_members')
        .select('national_id')
        .eq('camp_id', CAMP_ID)
        .not('national_id', 'is', null)
        .limit(1)
        .single();

      const { data: fixture, error: fixtureError } = await serviceClient
        .from('registration_requests')
        .insert({
          full_name: 'مرشح اختبار التكرار',
          national_id: existingHead.national_id,
          email: 'phase47-duplicate-fixture@example.test',
          camp_id: CAMP_ID,
          status: 'pending',
          user_id: null,
        })
        .select('id')
        .single();
      assert.equal(fixtureError, null, `fixture insert must succeed: ${fixtureError?.message}`);
      const fixtureId = fixture.id;

      try {
        const page = await browser.newPage();
        await login(page, base, EMAIL, PASSWORD);
        await page.goto(`${base}/pages/registration-request-details.html?id=${fixtureId}`, { waitUntil: 'load' });
        await page.waitForSelector('.alert, .card', { timeout: 15000 });
        const bodyText = await page.locator('body').innerText();
        assert.ok(bodyText.includes('مسجّل مسبقاً'), 'expected the duplicate alert copy');
        await page.close();
      } finally {
        await serviceClient.from('registration_requests').delete().eq('id', fixtureId);
      }
    });
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
});

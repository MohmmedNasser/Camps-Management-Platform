// supabase/tests/phase4.10-camps-verification.test.mjs
/**
 * Phase 4.10 camps verification: every value the real camps page renders
 * is compared against an INDEPENDENT query against the same live database
 * (a second supabase-js client, never importing assets/js/supabase/camps.js)
 * — list/stat counts, search, create -> edit -> toggle -> delete round trip,
 * duplicate-name rejection, and the delete-blocked-while-in-use case.
 * Cleans up every fixture it creates.
 *
 *   cd supabase && npm run frontend:config && npm run test:phase4.10-camps
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

test('Phase 4.10 camps DB-vs-UI verification', async (t) => {
  const SUPABASE_URL = required('SUPABASE_URL');
  const SUPABASE_PUBLISHABLE_KEY = required('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY');
  const SUPABASE_SECRET_KEY = required('SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY');
  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

  const server = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();

  try {
    await t.test('list: rendered camp count and per-camp stats match direct counts', async () => {
      const { data: camps } = await serviceClient.from('camps').select('id, name, city, status');
      const { data: members } = await serviceClient.from('family_members').select('id, camp_id');
      const { data: families } = await serviceClient.from('families').select('id, camp_id');

      const page = await browser.newPage();
      await login(page, base, EMAIL, PASSWORD);
      await page.goto(`${base}/pages/camps.html`, { waitUntil: 'load' });
      await page.waitForSelector('table, .empty', { timeout: 30000 });
      const bodyText = await page.locator('body').innerText();

      assert.ok(bodyText.includes(String(camps.length)), `expected camp count ${camps.length} in the rendered page`);
      const totalMembers = members.length;
      const totalFamilies = families.length;
      assert.ok(bodyText.includes(String(totalMembers)), `expected total displaced ${totalMembers} in the rendered page`);
      assert.ok(bodyText.includes(String(totalFamilies)), `expected total families ${totalFamilies} in the rendered page`);

      for (const camp of camps) {
        const campMembers = members.filter((m) => m.camp_id === camp.id).length;
        const row = page.locator('tr', { hasText: camp.name });
        const rowText = await row.first().innerText();
        assert.ok(rowText.includes(String(campMembers)), `${camp.name}: expected ${campMembers} displaced in its row`);
      }
      await page.close();
    });

    await t.test('search: filters to exactly the matching camp', async () => {
      const { data: fixture, error: fixtureError } = await serviceClient
        .from('camps')
        .insert({ name: 'مخيم اختبار البحث الفريد', governorate: 'gaza', city: 'مدينة البحث' })
        .select('id, name')
        .single();
      assert.equal(fixtureError, null, `fixture insert must succeed: ${fixtureError?.message}`);

      try {
        const page = await browser.newPage();
        await login(page, base, EMAIL, PASSWORD);
        await page.goto(`${base}/pages/camps.html`, { waitUntil: 'load' });
        await page.waitForSelector('table, .empty', { timeout: 30000 });
        await page.fill('#toolbar-search', 'اختبار البحث الفريد');
        await page.keyboard.press('Enter');
        // load() re-fetches listCampsWithStats() (a full camps+per-camp-stats
        // round trip) on every search change — poll for the result count
        // to settle to 1 rather than a fixed sleep, which flaked under
        // contention in the sibling camp-admins suite for the same reason.
        await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1, { timeout: 15000 });
        const bodyText = await page.locator('body').innerText();
        assert.ok(bodyText.includes(fixture.name), `expected "${fixture.name}" in filtered results`);
        await page.close();
      } finally {
        await serviceClient.from('camps').delete().eq('id', fixture.id);
      }
    });

    await t.test('duplicate-name rejection: no new row, friendly message', async () => {
      const { count: before } = await serviceClient.from('camps').select('id', { count: 'exact', head: true });

      const page = await browser.newPage();
      await login(page, base, EMAIL, PASSWORD);
      await page.goto(`${base}/pages/camps.html`, { waitUntil: 'load' });
      await page.waitForSelector('table, .empty', { timeout: 30000 });
      await page.click('[data-create]');
      await page.waitForSelector('#camp-form', { timeout: 10000 });
      await page.fill('#name', 'مخيم النور'); // existing seeded camp
      await page.selectOption('#governorate', 'gaza');
      await page.fill('#city', 'مدينة');
      await page.selectOption('#status', 'active');
      await page.click('button[form="camp-form"]');
      await page.waitForTimeout(1500);

      const bodyText = await page.locator('body').innerText();
      assert.ok(bodyText.includes('يوجد مخيم مسجل بنفس الاسم'), 'expected the friendly duplicate-name message');

      const { count: after } = await serviceClient.from('camps').select('id', { count: 'exact', head: true });
      assert.equal(after, before, 'no new camp row must be created on a duplicate-name submit');
      await page.close();
    });

    await t.test('create -> edit -> toggle -> delete round trip', async () => {
      const page = await browser.newPage();
      await login(page, base, EMAIL, PASSWORD);
      await page.goto(`${base}/pages/camps.html`, { waitUntil: 'load' });
      await page.waitForSelector('table, .empty', { timeout: 30000 });

      const uniqueName = `مخيم دورة الاختبار ${Date.now()}`;
      let fixtureId = null;

      try {
        // create
        await page.click('[data-create]');
        await page.waitForSelector('#camp-form', { timeout: 10000 });
        await page.fill('#name', uniqueName);
        await page.selectOption('#governorate', 'gaza');
        await page.fill('#city', 'مدينة الاختبار');
        await page.selectOption('#status', 'active');
        await page.click('button[form="camp-form"]');
        await page.waitForTimeout(1500);

        const { data: created } = await serviceClient.from('camps').select('id, city, status').eq('name', uniqueName).single();
        assert.ok(created, 'camp must exist in the database after create');
        fixtureId = created.id;
        assert.equal(created.city, 'مدينة الاختبار');
        assert.equal(created.status, 'active');

        // edit (city + status via the form)
        await page.goto(`${base}/pages/camps.html`, { waitUntil: 'load' });
        await page.waitForSelector('table, .empty', { timeout: 30000 });
        const row = page.locator('tr', { hasText: uniqueName });
        await row.locator('[data-edit]').click();
        await page.waitForSelector('#camp-form', { timeout: 10000 });
        await page.fill('#city', 'مدينة محدَّثة');
        await page.selectOption('#status', 'disabled');
        await page.click('button[form="camp-form"]');
        await page.waitForTimeout(1500);

        const { data: edited } = await serviceClient.from('camps').select('city, status').eq('id', fixtureId).single();
        assert.equal(edited.city, 'مدينة محدَّثة', 'edit must persist the new city');
        assert.equal(edited.status, 'disabled', 'edit must persist the new status');

        // toggle back to active
        await page.goto(`${base}/pages/camps.html`, { waitUntil: 'load' });
        await page.waitForSelector('table, .empty', { timeout: 30000 });
        const row2 = page.locator('tr', { hasText: uniqueName });
        await row2.locator('[data-toggle]').click();
        await page.waitForTimeout(1200);

        const { data: toggled } = await serviceClient.from('camps').select('status').eq('id', fixtureId).single();
        assert.equal(toggled.status, 'active', 'toggle must flip disabled -> active');

        // delete (confirmDialog() is a custom in-page modal, not a native browser dialog)
        await page.goto(`${base}/pages/camps.html`, { waitUntil: 'load' });
        await page.waitForSelector('table, .empty', { timeout: 30000 });
        const row3 = page.locator('tr', { hasText: uniqueName });
        await row3.locator('[data-delete]').click();
        await page.waitForSelector('.modal, [role="dialog"]', { timeout: 10000 }).catch(() => {});
        const confirmBtn = page.locator('.modal button, [role="dialog"] button').filter({ hasText: 'حذف' }).first();
        if (await confirmBtn.count()) await confirmBtn.click();
        await page.waitForTimeout(1500);

        const { data: afterDelete } = await serviceClient.from('camps').select('id').eq('id', fixtureId).maybeSingle();
        assert.equal(afterDelete, null, 'camp row must be gone after delete');
        fixtureId = null;
      } finally {
        if (fixtureId) await serviceClient.from('camps').delete().eq('id', fixtureId);
        await page.close();
      }
    });

    // A camp with zero families/displaced/admins doesn't trip camps.js's fast
    // client-side pre-check (displacedCount/familiesCount/adminsCount === 0),
    // so this exercises the real backstop: the DB's ON DELETE RESTRICT on
    // registration_requests.camp_id, caught and mapped to the same friendly
    // "تعذر الحذف" message the fast pre-check shows.
    await t.test('delete-blocked-while-in-use (DB RESTRICT backstop): friendly rejection, camp row survives', async () => {
      // Both fixture inserts happen inside the try, and cleanup below checks
      // each id independently — a failure partway through (e.g. the second
      // insert failing after the first succeeded) must not orphan a row, the
      // exact bug an earlier version of this test hit (camp fixture left
      // behind when the second insert's assertion threw before any cleanup
      // ran; fixed here and the orphaned row removed from the live project).
      let fixtureCampId = null;
      let fixtureRequestId = null;
      let page = null;

      try {
        const { data: fixtureCamp, error: campError } = await serviceClient
          .from('camps')
          .insert({ name: `مخيم مستخدم ${Date.now()}`, governorate: 'gaza', city: 'مدينة' })
          .select('id, name')
          .single();
        assert.equal(campError, null, `fixture camp insert must succeed: ${campError?.message}`);
        fixtureCampId = fixtureCamp.id;

        const { data: fixtureRequest, error: requestError } = await serviceClient
          .from('registration_requests')
          .insert({
            full_name: 'طلب اختبار حذف المخيم',
            national_id: String(900000000 + (Date.now() % 100000000)),
            email: `phase410-${Date.now()}@example.com`,
            camp_id: fixtureCamp.id,
          })
          .select('id')
          .single();
        assert.equal(requestError, null, `fixture registration_request insert must succeed: ${requestError?.message}`);
        fixtureRequestId = fixtureRequest.id;

        page = await browser.newPage();
        await login(page, base, EMAIL, PASSWORD);
        await page.goto(`${base}/pages/camps.html`, { waitUntil: 'load' });
        await page.waitForSelector('table, .empty', { timeout: 30000 });

        const row = page.locator('tr', { hasText: fixtureCamp.name });
        await row.locator('[data-delete]').click();
        await page.waitForTimeout(1000);
        const confirmBtn = page.locator('.modal button, [role="dialog"] button').filter({ hasText: 'حذف' }).first();
        assert.ok(await confirmBtn.count(), 'the fast pre-check must NOT fire for a camp with zero counted records — the confirm dialog must open');
        await confirmBtn.click();
        await page.waitForTimeout(1500);

        const bodyText = await page.locator('body').innerText();
        assert.ok(bodyText.includes('تعذر الحذف'), 'expected the friendly "cannot delete" message from the RESTRICT catch path');

        const { data: stillThere } = await serviceClient.from('camps').select('id').eq('id', fixtureCamp.id).maybeSingle();
        assert.ok(stillThere, 'camp row must survive a blocked delete attempt');
      } finally {
        if (page) await page.close();
        // cleanup order matters: the registration request before the camp,
        // or the camp delete would itself be blocked by the same RESTRICT.
        if (fixtureRequestId) await serviceClient.from('registration_requests').delete().eq('id', fixtureRequestId);
        if (fixtureCampId) await serviceClient.from('camps').delete().eq('id', fixtureCampId);
      }
    });
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
});

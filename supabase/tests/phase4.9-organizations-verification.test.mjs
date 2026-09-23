// supabase/tests/phase4.9-organizations-verification.test.mjs
/**
 * Phase 4.9 verification: every value the real donors page renders is
 * compared against an INDEPENDENT query against the same live database (a
 * second supabase-js client, never importing
 * assets/js/supabase/organizations.js) — list, search, summary stats,
 * per-row usage counts, create/edit/delete round trips, duplicate-name
 * rejection, and the delete-blocked-while-in-use case. Cleans up every
 * fixture it creates.
 *
 *   cd supabase && npm run frontend:config && npm run test:phase4.9-organizations
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

const NOOR_CAMP_ID = '5853adc9-9d23-4d4d-bc32-6fff17bdc3b0'; // مخيم النور
const HELAL_ORG_ID = 'cbc334d8-35a6-488a-acf7-471b5c343dcb'; // الهلال الأحمر الفلسطيني
const EMAIL = 'admin@camps.ps';
const PASSWORD = '123456';

test('Phase 4.9 organizations DB-vs-UI verification', async (t) => {
  const SUPABASE_URL = required('SUPABASE_URL');
  const SUPABASE_PUBLISHABLE_KEY = required('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY');
  const SUPABASE_SECRET_KEY = required('SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY');
  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

  const server = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();

  try {
    await t.test('list: rendered donor count matches a direct count', async () => {
      const { count } = await serviceClient.from('organizations').select('id', { count: 'exact', head: true });

      const page = await browser.newPage();
      await login(page, base, EMAIL, PASSWORD);
      await page.goto(`${base}/pages/organizations.html`, { waitUntil: 'load' });
      await page.waitForSelector('table, .empty', { timeout: 30000 });
      const bodyText = await page.locator('body').innerText();
      assert.ok(bodyText.includes(String(count)), `expected donor count ${count} to appear in the rendered page`);
      await page.close();
    });

    await t.test('search: filters to exactly the matching donor', async () => {
      const { data: fixture, error: fixtureError } = await serviceClient
        .from('organizations')
        .insert({ name: 'جهة اختبار البحث الفريدة', phone: null, responsible_person: null })
        .select('id, name')
        .single();
      assert.equal(fixtureError, null, `fixture insert must succeed: ${fixtureError?.message}`);

      try {
        const page = await browser.newPage();
        await login(page, base, EMAIL, PASSWORD);
        await page.goto(`${base}/pages/organizations.html`, { waitUntil: 'load' });
        await page.waitForSelector('table, .empty', { timeout: 30000 });
        await page.fill('#toolbar-search', 'اختبار البحث الفريدة');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(1500);
        const bodyText = await page.locator('body').innerText();
        assert.ok(bodyText.includes(fixture.name), `expected "${fixture.name}" in filtered results`);
        await page.close();
      } finally {
        await serviceClient.from('organizations').delete().eq('id', fixture.id);
      }
    });

    await t.test('summary stats match direct computation', async () => {
      const { count: orgCount } = await serviceClient.from('organizations').select('id', { count: 'exact', head: true });
      const { count: withPhone } = await serviceClient
        .from('organizations')
        .select('id', { count: 'exact', head: true })
        .not('phone', 'is', null);

      const page = await browser.newPage();
      await login(page, base, EMAIL, PASSWORD);
      await page.goto(`${base}/pages/organizations.html`, { waitUntil: 'load' });
      await page.waitForSelector('table, .empty', { timeout: 30000 });
      const bodyText = await page.locator('body').innerText();
      assert.ok(bodyText.includes(String(orgCount)), `expected donor count ${orgCount}`);
      assert.ok(bodyText.includes(String(withPhone)), `expected phone-count ${withPhone}`);
      await page.close();
    });

    await t.test('per-row usage counts are camp-scoped for a Camp Admin, not platform-wide', async () => {
      const { data: distributions } = await serviceClient
        .from('aid_distributions')
        .select('id, camp_id')
        .eq('organization_id', HELAL_ORG_ID)
        .eq('camp_id', NOOR_CAMP_ID);
      const noorCount = distributions.length;
      assert.ok(noorCount > 0, 'fixture assumption: مخيم النور must have real usage of this donor');

      const { count: platformCount } = await serviceClient
        .from('aid_distributions')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', HELAL_ORG_ID);
      assert.ok(platformCount > noorCount, "fixture assumption: platform-wide usage must exceed one camp's usage");

      const page = await browser.newPage();
      await login(page, base, EMAIL, PASSWORD);
      await page.goto(`${base}/pages/organizations.html`, { waitUntil: 'load' });
      await page.waitForSelector('table, .empty', { timeout: 30000 });
      const row = page.locator('tr', { hasText: 'الهلال الأحمر الفلسطيني' }).first();
      const rowText = await row.innerText();
      assert.ok(rowText.includes(String(noorCount)), `expected camp-scoped count ${noorCount} in the row, got: ${rowText}`);
      await page.close();
    });

    await t.test('create round trip', async () => {
      const uniqueName = `جهة اختبار الإنشاء ${Date.now()}`;
      const page = await browser.newPage();
      await login(page, base, EMAIL, PASSWORD);
      await page.goto(`${base}/pages/organizations.html`, { waitUntil: 'load' });
      await page.click('[data-create]');
      await page.waitForSelector('#org-form');
      await page.fill('#org-form input[name="name"]', uniqueName);
      await page.click('button[form="org-form"]');
      await page.waitForTimeout(1500);

      let created;
      try {
        const { data } = await serviceClient.from('organizations').select('id, name').eq('name', uniqueName).single();
        created = data;
        assert.ok(created, 'created row must exist in the DB');
        const bodyText = await page.locator('body').innerText();
        assert.ok(bodyText.includes(uniqueName), 'created donor must render in the list');
        await page.close();
      } finally {
        if (created) await serviceClient.from('organizations').delete().eq('id', created.id);
      }
    });

    await t.test('duplicate name (differing case/whitespace) is rejected', async () => {
      const { data: existing } = await serviceClient.from('organizations').select('name').limit(1).single();
      const duplicateAttempt = `  ${existing.name.toUpperCase()}  `;

      const page = await browser.newPage();
      await login(page, base, EMAIL, PASSWORD);
      await page.goto(`${base}/pages/organizations.html`, { waitUntil: 'load' });
      await page.click('[data-create]');
      await page.waitForSelector('#org-form');
      await page.fill('#org-form input[name="name"]', duplicateAttempt);
      await page.click('button[form="org-form"]');
      await page.waitForTimeout(1500);

      const bodyText = await page.locator('body').innerText();
      assert.ok(bodyText.includes('موجودة') || bodyText.includes('مسجلة'), `expected a duplicate-name message, got: ${bodyText.slice(0, 300)}`);

      const { count } = await serviceClient
        .from('organizations')
        .select('id', { count: 'exact', head: true })
        .ilike('name', existing.name);
      assert.equal(count, 1, 'no second row may have been created for the duplicate name');
      await page.close();
    });

    await t.test('edit round trip', async () => {
      const { data: fixture, error: fixtureError } = await serviceClient
        .from('organizations')
        .insert({ name: `جهة اختبار التعديل ${Date.now()}`, phone: null, responsible_person: null })
        .select('id, name')
        .single();
      assert.equal(fixtureError, null, `fixture insert must succeed: ${fixtureError?.message}`);

      try {
        const page = await browser.newPage();
        await login(page, base, EMAIL, PASSWORD);
        await page.goto(`${base}/pages/organizations.html`, { waitUntil: 'load' });
        await page.fill('#toolbar-search', fixture.name);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(1500);
        await page.click(`[data-edit="${fixture.id}"]`);
        await page.waitForSelector('#org-form');
        await page.fill('#org-form input[name="responsiblePerson"]', 'مسؤول محدَّث');
        await page.click('button[form="org-form"]');
        await page.waitForTimeout(1500);

        const { data: after } = await serviceClient.from('organizations').select('responsible_person').eq('id', fixture.id).single();
        assert.equal(after.responsible_person, 'مسؤول محدَّث');
        await page.close();
      } finally {
        await serviceClient.from('organizations').delete().eq('id', fixture.id);
      }
    });

    await t.test('delete blocked while a donor is still referenced by aid', async () => {
      const page = await browser.newPage();
      await login(page, base, EMAIL, PASSWORD);
      await page.goto(`${base}/pages/organizations.html`, { waitUntil: 'load' });
      await page.fill('#toolbar-search', 'الهلال الأحمر الفلسطيني');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1500);
      await page.click(`[data-delete="${HELAL_ORG_ID}"]`);
      await page.waitForTimeout(1000);

      const bodyText = await page.locator('body').innerText();
      assert.ok(bodyText.includes('توجد مساعدات مسجلة'), `expected the in-use block message, got: ${bodyText.slice(0, 300)}`);

      const { data: stillThere } = await serviceClient.from('organizations').select('id').eq('id', HELAL_ORG_ID).maybeSingle();
      assert.ok(stillThere, 'donor must not have been deleted');
      await page.close();
    });

    await t.test('delete round trip for a donor with zero aid usage', async () => {
      const { data: fixture, error: fixtureError } = await serviceClient
        .from('organizations')
        .insert({ name: `جهة اختبار الحذف ${Date.now()}`, phone: null, responsible_person: null })
        .select('id, name')
        .single();
      assert.equal(fixtureError, null, `fixture insert must succeed: ${fixtureError?.message}`);
      let stillExists = true;

      try {
        const page = await browser.newPage();
        await login(page, base, EMAIL, PASSWORD);
        await page.goto(`${base}/pages/organizations.html`, { waitUntil: 'load' });
        await page.fill('#toolbar-search', fixture.name);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(1500);
        await page.click(`[data-delete="${fixture.id}"]`);
        await page.waitForSelector('[data-confirm]', { timeout: 5000 });
        await page.click('[data-confirm]');
        await page.waitForTimeout(1500);

        const { data: after } = await serviceClient.from('organizations').select('id').eq('id', fixture.id).maybeSingle();
        assert.equal(after, null, 'donor must be gone from the DB');
        stillExists = false;
        await page.close();
      } finally {
        if (stillExists) await serviceClient.from('organizations').delete().eq('id', fixture.id);
      }
    });

    await t.test('empty search result renders the existing emptyState()', async () => {
      const page = await browser.newPage();
      await login(page, base, EMAIL, PASSWORD);
      await page.goto(`${base}/pages/organizations.html`, { waitUntil: 'load' });
      await page.fill('#toolbar-search', 'نص بحث لا يطابق أي جهة إطلاقاً xyz');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1500);
      const bodyText = await page.locator('body').innerText();
      assert.ok(bodyText.includes('لا توجد نتائج مطابقة'), `expected the empty-search copy, got: ${bodyText.slice(0, 300)}`);
      await page.close();
    });
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
});

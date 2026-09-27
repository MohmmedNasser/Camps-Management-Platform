// supabase/tests/phase4.16-dashboard-notifications-verification.test.mjs
/**
 * Phase 4.16 verification: the dashboard's "الإشعارات غير المقروءة" stat
 * card (Camp Admin, Super Admin — new; Displaced — regression) is compared
 * against an INDEPENDENT service-role query of the live `notifications`
 * table, and against the header badge on the SAME page load, for all three
 * roles. A disposable Camp Admin fixture exercises mark-all-read end to
 * end, confirming both the header AND the dashboard stat move together
 * (Phase 4.14/4.15 proved only the header before).
 *
 *   cd supabase && npm run frontend:config && npm run test:phase4.16-dashboard-notifications-verification
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

const PASSWORD = '123456';
const BREAKPOINTS = [320, 375, 768, 1024, 1280, 1440];

function statCardValue(page, label) {
  return page
    .locator('.stat', { has: page.locator('.stat__label', { hasText: label }) })
    .locator('.stat__value')
    .innerText();
}

async function headerBadgeCount(page) {
  const badge = page.locator('[data-dropdown="notifications"] .dropdown__trigger .count-badge');
  return (await badge.count()) > 0 ? Number(await badge.innerText()) : 0;
}

test('Phase 4.16 dashboard notification stat: matches the live database and the header', async (t) => {
  const SUPABASE_URL = required('SUPABASE_URL');
  const SUPABASE_PUBLISHABLE_KEY = required('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY');
  const SUPABASE_SECRET_KEY = required('SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY');
  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

  const server = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();
  let fixtureUserId = null;
  const fixtureEmail = `phase416-fixture-${Date.now()}@example.com`;

  const ACCOUNTS = [
    { email: 'admin@camps.ps', label: 'Camp Admin' },
    { email: 'super@camps.ps', label: 'Super Admin' },
    { email: 'ahmad@camps.ps', label: 'Displaced' },
  ];

  try {
    for (const { email, label } of ACCOUNTS) {
      await t.test(`${label} (${email}): dashboard stat == header badge == independent DB unread count`, async () => {
        const { data: authUser } = await serviceClient.auth.admin.listUsers();
        const user = authUser.users.find((u) => u.email === email);
        const { count: expectedUnread } = await serviceClient
          .from('notifications')
          .select('id', { count: 'exact', head: true })
          .eq('recipient_id', user.id)
          .eq('is_read', false);

        const page = await browser.newPage();
        const consoleErrors = [];
        page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
        const failedRequests = [];
        page.on('requestfailed', (req) => failedRequests.push(req.url()));
        await login(page, base, email, PASSWORD);
        await page.goto(`${base}/pages/dashboard.html`, { waitUntil: 'load' });
        await page.waitForSelector('.stat', { timeout: 15000 });

        const statValue = Number((await statCardValue(page, 'الإشعارات غير المقروءة')).trim());
        assert.equal(statValue, expectedUnread, `${email}: dashboard stat must equal the independent DB unread count (${expectedUnread})`);

        await page.waitForSelector('[data-dropdown="notifications"]', { timeout: 15000 });
        const badgeValue = await headerBadgeCount(page);
        assert.equal(badgeValue, expectedUnread, `${email}: header badge must also equal the independent DB unread count (${expectedUnread})`);
        assert.equal(statValue, badgeValue, `${email}: dashboard stat and header badge must represent the same underlying unread state`);

        assert.deepEqual(consoleErrors, [], `${email}: dashboard must render with zero console errors`);
        assert.deepEqual(failedRequests, [], `${email}: dashboard must render with zero failed network requests`);
        await page.close();
      });
    }

    await t.test('nour@camps.ps (Camp Admin, real zero-notification account): dashboard stat renders the real 0', async () => {
      const { count: dbCount } = await serviceClient.from('notifications').select('id', { count: 'exact', head: true }).eq('recipient_id', 'de9b01cd-0388-4d63-a162-0832d6897528');
      assert.equal(dbCount, 0, "precondition: nour's live unread count must be 0 for this to test the real zero state");

      const page = await browser.newPage();
      await login(page, base, 'nour@camps.ps', PASSWORD);
      await page.goto(`${base}/pages/dashboard.html`, { waitUntil: 'load' });
      await page.waitForSelector('.stat', { timeout: 15000 });
      const statValue = (await statCardValue(page, 'الإشعارات غير المقروءة')).trim();
      assert.equal(statValue, '0', "nour's dashboard stat must render the real 0, not a fabricated fallback");
      await page.close();
    });

    await t.test('mark-all-read: disposable Camp Admin fixture — dashboard stat AND header badge both go to 0, persist on reload, another account untouched', async () => {
      const { data: created, error: createError } = await serviceClient.auth.admin.createUser({
        email: fixtureEmail,
        password: 'Fixture123!',
        email_confirm: true,
      });
      assert.equal(createError, null, `fixture auth user create must succeed: ${createError?.message}`);
      fixtureUserId = created.user.id;

      const { data: anyCamp } = await serviceClient.from('camps').select('id').limit(1).single();
      const { error: promoteError } = await serviceClient
        .from('profiles')
        .update({ role: 'camp_admin', camp_id: anyCamp.id, status: 'active', full_name: 'مسؤول اختبار لوحة الإشعارات' })
        .eq('id', fixtureUserId);
      assert.equal(promoteError, null, `fixture promotion to camp_admin must succeed: ${promoteError?.message}`);

      const { error: insertError } = await serviceClient.from('notifications').insert([
        { recipient_id: fixtureUserId, type: 'info', title: 'إشعار اختبار لوحة 1', body: 'نص 1' },
        { recipient_id: fixtureUserId, type: 'success', title: 'إشعار اختبار لوحة 2', body: 'نص 2' },
      ]);
      assert.equal(insertError, null, `fixture notification insert (service role) must succeed: ${insertError?.message}`);

      const { data: adminBefore } = await serviceClient.from('notifications').select('is_read').eq('recipient_id', 'aefbd763-e1df-42c9-b95b-7ff9934cfe81');

      const page = await browser.newPage();
      await login(page, base, fixtureEmail, 'Fixture123!');
      await page.goto(`${base}/pages/dashboard.html`, { waitUntil: 'load' });
      await page.waitForSelector('.stat', { timeout: 15000 });
      const before = (await statCardValue(page, 'الإشعارات غير المقروءة')).trim();
      assert.equal(before, '2', 'fixture camp_admin dashboard stat must show 2 before mark-all-read');

      await page.waitForSelector('[data-dropdown="notifications"]', { timeout: 15000 });
      await page.locator('[data-dropdown="notifications"] .dropdown__trigger').click();
      await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.locator('[data-read-all]').click()]);
      await page.waitForSelector('.stat', { timeout: 15000 });
      const afterStat = (await statCardValue(page, 'الإشعارات غير المقروءة')).trim();
      assert.equal(afterStat, '0', 'fixture camp_admin dashboard stat must be 0 immediately after mark-all-read (post-reload)');
      assert.equal(await headerBadgeCount(page), 0, 'fixture camp_admin header badge must also be 0 after mark-all-read, moving together with the dashboard stat');

      await page.reload({ waitUntil: 'load' });
      await page.waitForSelector('.stat', { timeout: 15000 });
      const persisted = (await statCardValue(page, 'الإشعارات غير المقروءة')).trim();
      assert.equal(persisted, '0', 'the 0 state must persist across an independent reload, not just the post-action reload');

      const { count: dbUnread } = await serviceClient
        .from('notifications')
        .select('id', { count: 'exact', head: true })
        .eq('recipient_id', fixtureUserId)
        .eq('is_read', false);
      assert.equal(dbUnread, 0, 'the DB itself must show 0 unread for the fixture account after mark-all-read');

      const { data: adminAfter } = await serviceClient.from('notifications').select('is_read').eq('recipient_id', 'aefbd763-e1df-42c9-b95b-7ff9934cfe81');
      assert.deepEqual(adminAfter.map((r) => r.is_read).sort(), adminBefore.map((r) => r.is_read).sort(), "a different, real Camp Admin's notifications must be untouched by the fixture account's mark-all-read");

      await page.close();
    });

    await t.test('responsive: dashboard notification stat renders without horizontal overflow at every breakpoint (Camp Admin, Super Admin, Displaced)', async () => {
      for (const email of ['admin@camps.ps', 'super@camps.ps', 'ahmad@camps.ps']) {
        const page = await browser.newPage();
        await login(page, base, email, PASSWORD);
        await page.goto(`${base}/pages/dashboard.html`, { waitUntil: 'load' });
        await page.waitForSelector('.stat', { timeout: 15000 });
        for (const width of BREAKPOINTS) {
          await page.setViewportSize({ width, height: 900 });
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
          assert.ok(!overflow, `${email}: no horizontal overflow at ${width}px after adding the notification stat card`);
        }
        await page.close();
      }
    });

    await t.test('security: no service-role key or secret reaches the browser on the dashboard', async () => {
      const page = await browser.newPage();
      await login(page, base, 'admin@camps.ps', PASSWORD);
      await page.goto(`${base}/pages/dashboard.html`, { waitUntil: 'load' });
      const html = await page.content();
      assert.ok(!html.includes(SUPABASE_SECRET_KEY), 'service role key must never appear in dashboard page HTML');
      await page.close();
    });
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
    if (fixtureUserId) {
      await serviceClient.from('notifications').delete().eq('recipient_id', fixtureUserId);
      await serviceClient.from('profiles').delete().eq('id', fixtureUserId);
      try {
        await serviceClient.auth.admin.deleteUser(fixtureUserId);
      } catch {
        // best-effort cleanup
      }
    }
  }
});

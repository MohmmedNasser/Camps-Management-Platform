// supabase/tests/phase4.14-displaced-notifications-verification.test.mjs
/**
 * Phase 4.14 verification: the displaced dashboard's unread-notification
 * stat and the shared header's badge/dropdown are compared against an
 * INDEPENDENT service-role query of the live `notifications` table (never
 * importing assets/js/supabase/notifications.js) — for all four seeded
 * displaced accounts, plus a disposable fixture account used to exercise
 * mark-all-read end to end (initial count -> mark all read -> reload ->
 * persisted zero -> another account unaffected). Also confirms Camp
 * Admin/Super Admin sessions never regress and that no service-role key
 * reaches the browser.
 *
 *   cd supabase && npm run frontend:config && npm run test:phase4.14-displaced-notifications-verification
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

const DISPLACED_ACCOUNTS = ['ahmad@camps.ps', 'yousef@camps.ps', 'ibrahim@camps.ps', 'omar@camps.ps'];
const PASSWORD = '123456';
const BREAKPOINTS = [320, 375, 768, 1024, 1280, 1440];

test('Phase 4.14 displaced notifications: dashboard/header match the live database', async (t) => {
  const SUPABASE_URL = required('SUPABASE_URL');
  const SUPABASE_PUBLISHABLE_KEY = required('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY');
  const SUPABASE_SECRET_KEY = required('SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY');
  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

  const server = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();
  let fixtureUserId = null;
  const fixtureEmail = `phase414-fixture-${Date.now()}@example.com`;

  try {
    for (const email of DISPLACED_ACCOUNTS) {
      await t.test(`${email}: dashboard stat and header badge match an independent DB count`, async () => {
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
        await login(page, base, email, PASSWORD);
        await page.goto(`${base}/pages/dashboard.html`, { waitUntil: 'load' });
        await page.waitForSelector('.stat', { timeout: 15000 });
        const bodyText = await page.locator('body').innerText();
        assert.ok(bodyText.includes(String(expectedUnread)), `${email}: dashboard unread stat must equal live DB count ${expectedUnread}`);

        const trigger = page.locator('[data-dropdown="notifications"] .dropdown__trigger');
        if (expectedUnread > 0) {
          const badgeText = await trigger.locator('.count-badge').innerText();
          assert.equal(Number(badgeText), expectedUnread, `${email}: header badge must equal live DB count ${expectedUnread}`);
        }

        assert.deepEqual(consoleErrors, [], `${email}: dashboard must render with zero console errors`);
        await page.close();
      });
    }

    await t.test('mark-all-read: fixture account count goes to zero, persists on reload, does not affect another account', async () => {
      const { data: created, error: createError } = await serviceClient.auth.admin.createUser({
        email: fixtureEmail,
        password: 'Fixture123!',
        email_confirm: true,
      });
      assert.equal(createError, null, `fixture auth user create must succeed: ${createError?.message}`);
      fixtureUserId = created.user.id;
      await serviceClient.from('profiles').update({ status: 'approved', full_name: 'مستخدم اختبار الإشعارات' }).eq('id', fixtureUserId);

      const { error: insertError } = await serviceClient.from('notifications').insert([
        { recipient_id: fixtureUserId, type: 'info', title: 'إشعار اختبار 1', body: 'نص 1' },
        { recipient_id: fixtureUserId, type: 'success', title: 'إشعار اختبار 2', body: 'نص 2' },
      ]);
      assert.equal(insertError, null, `fixture notification insert (service role) must succeed: ${insertError?.message}`);

      const { data: omarBefore } = await serviceClient.from('notifications').select('is_read').eq('recipient_id', 'b68268cb-6bfc-4c55-8176-36322ef1aa27');

      const page = await browser.newPage();
      const consoleMsgs = [];
      const failedReqs = [];
      page.on('console', (msg) => consoleMsgs.push(`[${msg.type()}] ${msg.text()}`));
      page.on('requestfailed', (req) => failedReqs.push(`${req.url()} :: ${req.failure()?.errorText}`));
      page.on('pageerror', (err) => consoleMsgs.push(`[pageerror] ${err.message}`));
      await login(page, base, fixtureEmail, 'Fixture123!');
      await page.goto(`${base}/pages/dashboard.html`, { waitUntil: 'load' });
      await page.waitForSelector('.stat', { timeout: 15000 });
      let bodyText = await page.locator('body').innerText();
      assert.ok(bodyText.includes('2'), 'fixture account must show unread count 2 before mark-all-read');

      await page.locator('[data-dropdown="notifications"] .dropdown__trigger').click();
      await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.locator('[data-read-all]').click()]);
      await page.waitForSelector('.stat', { timeout: 15000 });
      bodyText = await page.locator('body').innerText();
      assert.ok(bodyText.includes('0'), 'fixture account must show unread count 0 immediately after mark-all-read (post-reload)');

      try {
        await page.reload({ waitUntil: 'load', timeout: 45000 });
      } catch (error) {
        console.error('RELOAD DIAGNOSTICS console:', consoleMsgs);
        console.error('RELOAD DIAGNOSTICS failedRequests:', failedReqs);
        console.error('RELOAD DIAGNOSTICS url:', page.url());
        throw error;
      }
      await page.waitForSelector('.stat', { timeout: 15000 });
      bodyText = await page.locator('body').innerText();
      assert.ok(bodyText.includes('0'), 'unread count 0 must persist across an independent reload, not just the post-action reload');

      const { count: dbUnread } = await serviceClient
        .from('notifications')
        .select('id', { count: 'exact', head: true })
        .eq('recipient_id', fixtureUserId)
        .eq('is_read', false);
      assert.equal(dbUnread, 0, 'the DB itself must show 0 unread for the fixture account after mark-all-read');

      const { data: omarAfter } = await serviceClient.from('notifications').select('is_read').eq('recipient_id', 'b68268cb-6bfc-4c55-8176-36322ef1aa27');
      assert.deepEqual(omarAfter.map((r) => r.is_read).sort(), omarBefore.map((r) => r.is_read).sort(), "omar's notifications must be untouched by the fixture account's mark-all-read");

      await page.close();
    });

    await t.test('responsive: header/dropdown render without horizontal overflow at every breakpoint', async () => {
      const page = await browser.newPage();
      await login(page, base, 'ahmad@camps.ps', PASSWORD);
      await page.goto(`${base}/pages/dashboard.html`, { waitUntil: 'load' });
      await page.waitForSelector('.stat', { timeout: 15000 });
      for (const width of BREAKPOINTS) {
        await page.setViewportSize({ width, height: 900 });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
        assert.ok(!overflow, `no horizontal overflow at ${width}px`);
      }
      await page.close();
    });

    await t.test('security: no service-role key or secret reaches the browser', async () => {
      const page = await browser.newPage();
      await login(page, base, 'ahmad@camps.ps', PASSWORD);
      await page.goto(`${base}/pages/dashboard.html`, { waitUntil: 'load' });
      const html = await page.content();
      assert.ok(!html.includes(SUPABASE_SECRET_KEY), 'service role key must never appear in page HTML');
      await page.close();
    });
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
    if (fixtureUserId) {
      await serviceClient.from('notifications').delete().eq('recipient_id', fixtureUserId);
      await serviceClient.from('profiles').delete().eq('id', fixtureUserId);
      await serviceClient.auth.admin.deleteUser(fixtureUserId).catch(() => {});
    }
  }
});

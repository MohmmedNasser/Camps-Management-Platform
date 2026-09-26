// supabase/tests/phase4.15-notifications-verification.test.mjs
/**
 * Phase 4.15 verification: the shared header's badge/dropdown for Camp
 * Admin and Super Admin are compared against an INDEPENDENT service-role
 * query of the live `notifications` table (never importing
 * assets/js/supabase/notifications.js) — on the dashboard AND one other
 * representative page per role, proving the header is correct everywhere
 * it mounts. A disposable CAMP_ADMIN fixture (never super_admin — a unique
 * partial index on profiles(role) forbids a second super_admin, see the
 * design doc §3.5) exercises the full mark-all-read cycle end to end.
 *
 *   cd supabase && npm run frontend:config && npm run test:phase4.15-notifications-verification
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

test('Phase 4.15 Camp Admin/Super Admin notifications: header matches the live database', async (t) => {
  const SUPABASE_URL = required('SUPABASE_URL');
  const SUPABASE_PUBLISHABLE_KEY = required('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY');
  const SUPABASE_SECRET_KEY = required('SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY');
  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

  const server = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();
  let fixtureUserId = null;
  const fixtureEmail = `phase415-fixture-${Date.now()}@example.com`;

  const ACCOUNTS = [
    { email: 'admin@camps.ps', label: 'Camp Admin', otherPage: 'families.html' },
    { email: 'super@camps.ps', label: 'Super Admin', otherPage: 'camps.html' },
  ];

  try {
    for (const { email, label, otherPage } of ACCOUNTS) {
      await t.test(`${label} (${email}): header badge/dropdown match an independent DB query on dashboard + ${otherPage}`, async () => {
        const { data: authUser } = await serviceClient.auth.admin.listUsers();
        const user = authUser.users.find((u) => u.email === email);
        const { count: expectedUnread } = await serviceClient
          .from('notifications')
          .select('id', { count: 'exact', head: true })
          .eq('recipient_id', user.id)
          .eq('is_read', false);
        const { data: expectedRecent } = await serviceClient
          .from('notifications')
          .select('id, title, is_read')
          .eq('recipient_id', user.id)
          .order('created_at', { ascending: false })
          .limit(5);

        for (const path of ['dashboard.html', otherPage]) {
          const page = await browser.newPage();
          const consoleErrors = [];
          page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
          await login(page, base, email, PASSWORD);
          await page.goto(`${base}/pages/${path}`, { waitUntil: 'load' });
          await page.waitForSelector('[data-dropdown="notifications"]', { timeout: 15000 });

          const trigger = page.locator('[data-dropdown="notifications"] .dropdown__trigger');
          const badgeCount = await trigger.locator('.count-badge').count();
          if (expectedUnread > 0) {
            assert.equal(badgeCount, 1, `${email} on ${path}: header badge must be present when unread > 0`);
            const badgeText = await trigger.locator('.count-badge').innerText();
            assert.equal(Number(badgeText), expectedUnread, `${email} on ${path}: header badge must equal live DB unread count ${expectedUnread}`);
          } else {
            assert.equal(badgeCount, 0, `${email} on ${path}: header badge must be absent when unread is 0`);
          }

          await trigger.click();
          const dropdownText = await page.locator('[data-dropdown="notifications"] .dropdown__panel').innerText();
          for (const row of expectedRecent) {
            assert.ok(dropdownText.includes(row.title), `${email} on ${path}: dropdown must include real DB title "${row.title}"`);
          }

          assert.deepEqual(consoleErrors, [], `${email} on ${path}: page must render with zero console errors`);
          await page.close();
        }
      });
    }

    await t.test('nour@camps.ps (Camp Admin, real zero-notification account): header renders the real empty state', async () => {
      const { count: dbCount } = await serviceClient.from('notifications').select('id', { count: 'exact', head: true }).eq('recipient_id', 'de9b01cd-0388-4d63-a162-0832d6897528');
      assert.equal(dbCount, 0, 'precondition: nour must have zero notifications in the live DB for this to test the real empty state');

      const page = await browser.newPage();
      await login(page, base, 'nour@camps.ps', PASSWORD);
      await page.goto(`${base}/pages/dashboard.html`, { waitUntil: 'load' });
      await page.waitForSelector('[data-dropdown="notifications"]', { timeout: 15000 });
      const trigger = page.locator('[data-dropdown="notifications"] .dropdown__trigger');
      assert.equal(await trigger.locator('.count-badge').count(), 0, "nour's header badge must be absent (zero unread)");
      await trigger.click();
      const dropdownText = await page.locator('[data-dropdown="notifications"] .dropdown__panel').innerText();
      assert.ok(dropdownText.includes('لا توجد إشعارات'), "nour's dropdown must show the real empty-state copy, not a fabricated fallback");
      await page.close();
    });

    await t.test('mark-all-read: disposable Camp Admin fixture — count goes to zero, persists on reload, does not affect another account', async () => {
      const { data: created, error: createError } = await serviceClient.auth.admin.createUser({
        email: fixtureEmail,
        password: 'Fixture123!',
        email_confirm: true,
      });
      assert.equal(createError, null, `fixture auth user create must succeed: ${createError?.message}`);
      fixtureUserId = created.user.id;

      // handle_new_user() always inserts role='displaced', status='pending' — promote via
      // service_role UPDATE (bypasses guard_profile_privileges: is_browser_session() is
      // false for service_role), exactly as the seed script itself does.
      const { data: anyCamp } = await serviceClient.from('camps').select('id').limit(1).single();
      const { error: promoteError } = await serviceClient
        .from('profiles')
        .update({ role: 'camp_admin', camp_id: anyCamp.id, status: 'active', full_name: 'مسؤول اختبار الإشعارات' })
        .eq('id', fixtureUserId);
      assert.equal(promoteError, null, `fixture promotion to camp_admin must succeed: ${promoteError?.message}`);

      const { error: insertError } = await serviceClient.from('notifications').insert([
        { recipient_id: fixtureUserId, type: 'info', title: 'إشعار اختبار 1', body: 'نص 1' },
        { recipient_id: fixtureUserId, type: 'success', title: 'إشعار اختبار 2', body: 'نص 2' },
      ]);
      assert.equal(insertError, null, `fixture notification insert (service role) must succeed: ${insertError?.message}`);

      const { data: adminBefore } = await serviceClient.from('notifications').select('is_read').eq('recipient_id', 'aefbd763-e1df-42c9-b95b-7ff9934cfe81');

      const page = await browser.newPage();
      await login(page, base, fixtureEmail, 'Fixture123!');
      await page.goto(`${base}/pages/dashboard.html`, { waitUntil: 'load' });
      await page.waitForSelector('[data-dropdown="notifications"]', { timeout: 15000 });
      const trigger = page.locator('[data-dropdown="notifications"] .dropdown__trigger');
      const badgeText = await trigger.locator('.count-badge').innerText();
      assert.equal(badgeText, '2', 'fixture camp_admin must show unread badge 2 before mark-all-read');

      await trigger.click();
      await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.locator('[data-read-all]').click()]);
      await page.waitForSelector('[data-dropdown="notifications"]', { timeout: 15000 });
      assert.equal(await page.locator('[data-dropdown="notifications"] .dropdown__trigger .count-badge').count(), 0, 'fixture camp_admin badge must be gone immediately after mark-all-read (post-reload)');

      await page.reload({ waitUntil: 'load' });
      await page.waitForSelector('[data-dropdown="notifications"]', { timeout: 15000 });
      assert.equal(await page.locator('[data-dropdown="notifications"] .dropdown__trigger .count-badge').count(), 0, 'unread badge absence must persist across an independent reload, not just the post-action reload');

      const { count: dbUnread } = await serviceClient
        .from('notifications')
        .select('id', { count: 'exact', head: true })
        .eq('recipient_id', fixtureUserId)
        .eq('is_read', false);
      assert.equal(dbUnread, 0, 'the DB itself must show 0 unread for the fixture account after mark-all-read');

      const { data: adminAfter } = await serviceClient.from('notifications').select('is_read').eq('recipient_id', 'aefbd763-e1df-42c9-b95b-7ff9934cfe81');
      assert.deepEqual(adminAfter.map((r) => r.is_read).sort(), adminBefore.map((r) => r.is_read).sort(), "admin's (a different, real Camp Admin) notifications must be untouched by the fixture account's mark-all-read");

      await page.close();
    });

    await t.test('responsive: header/dropdown render without horizontal overflow at every breakpoint (Camp Admin, Super Admin)', async () => {
      for (const email of ['admin@camps.ps', 'super@camps.ps']) {
        const page = await browser.newPage();
        await login(page, base, email, PASSWORD);
        await page.goto(`${base}/pages/dashboard.html`, { waitUntil: 'load' });
        await page.waitForSelector('[data-dropdown="notifications"]', { timeout: 15000 });
        for (const width of BREAKPOINTS) {
          await page.setViewportSize({ width, height: 900 });
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
          assert.ok(!overflow, `${email}: no horizontal overflow at ${width}px`);
        }
        await page.close();
      }
    });

    await t.test('security: no service-role key or secret reaches the browser', async () => {
      const page = await browser.newPage();
      await login(page, base, 'admin@camps.ps', PASSWORD);
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

// supabase/tests/phase4.15-notifications-isolation.test.mjs
/**
 * Phase 4.15 cross-user isolation: proves the header notification
 * bell/dropdown, now wired to real Supabase data for Camp Admin and Super
 * Admin (in addition to Phase 4.14's Displaced), can read/update only the
 * signed-in account's OWN notifications — through RLS directly, not merely
 * "the UI doesn't show it."
 *
 * Every mark-all-read subtest that acts on a REAL seeded account captures
 * that account's own before-state and restores it in a `finally`,
 * regardless of outcome — Phase 4.14 discovered the hard way (via a bug in
 * its own first test draft) that skipping this permanently mutates seed
 * data. This phase gets it right from the first draft.
 *
 *   cd supabase && npm run frontend:config && npm run test:phase4.15-notifications-isolation
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

test('Phase 4.15 Camp Admin/Super Admin notifications: cross-user isolation', async (t) => {
  const SUPABASE_URL = required('SUPABASE_URL');
  const SUPABASE_PUBLISHABLE_KEY = required('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY');
  const SUPABASE_SECRET_KEY = required('SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY');
  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

  const server = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();

  try {
    await t.test('admin@camps.ps (Camp Admin): RLS returns/counts only own notifications', async () => {
      const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
      await client.auth.signInWithPassword({ email: 'admin@camps.ps', password: PASSWORD });
      const { data: { user } } = await client.auth.getUser();
      const { data: own } = await client.from('notifications').select('id, recipient_id');
      assert.ok(own.length > 0, 'admin@camps.ps must have seeded notifications for this probe to be meaningful');
      assert.ok(own.every((row) => row.recipient_id === user.id), 'admin@camps.ps must see zero notifications with a different recipient_id');
      await client.auth.signOut();
    });

    await t.test('super@camps.ps (Super Admin): RLS returns/counts only own notifications', async () => {
      const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
      await client.auth.signInWithPassword({ email: 'super@camps.ps', password: PASSWORD });
      const { data: { user } } = await client.auth.getUser();
      const { data: own } = await client.from('notifications').select('id, recipient_id');
      assert.ok(own.length > 0, 'super@camps.ps must have seeded notifications for this probe to be meaningful');
      assert.ok(own.every((row) => row.recipient_id === user.id), 'super@camps.ps must see zero notifications with a different recipient_id');
      await client.auth.signOut();
    });

    await t.test("Camp Admin B (nour) cannot read or update Camp Admin A's (admin) notification by id", async () => {
      const adminClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
      await adminClient.auth.signInWithPassword({ email: 'admin@camps.ps', password: PASSWORD });
      const { data: adminRows } = await adminClient.from('notifications').select('id, is_read');
      await adminClient.auth.signOut();
      assert.ok(adminRows.length > 0, 'admin@camps.ps must have at least one seeded notification for this probe to be meaningful');
      const targetId = adminRows[0].id;

      const nourClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
      await nourClient.auth.signInWithPassword({ email: 'nour@camps.ps', password: PASSWORD });

      const { data: probe } = await nourClient.from('notifications').select('id').eq('id', targetId).maybeSingle();
      assert.equal(probe, null, "nour (Camp Admin B) must not be able to read admin's (Camp Admin A) notification row by direct id");

      const { data: updateAttempt, error: updateError } = await nourClient
        .from('notifications')
        .update({ is_read: true })
        .eq('id', targetId)
        .select();
      assert.ok(updateError || (updateAttempt && updateAttempt.length === 0), "nour's UPDATE against admin's notification id must affect zero rows (RLS), not silently succeed");
      await nourClient.auth.signOut();

      const { data: afterCheck } = await serviceClient.from('notifications').select('is_read').eq('id', targetId).single();
      assert.equal(afterCheck.is_read, adminRows[0].is_read, "admin's notification read-state must be unchanged after nour's blocked update attempt");
    });

    await t.test('Super Admin cannot impersonate another recipient by changing client-side values', async () => {
      const adminClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
      await adminClient.auth.signInWithPassword({ email: 'admin@camps.ps', password: PASSWORD });
      const { data: adminRows } = await adminClient.from('notifications').select('id, is_read');
      await adminClient.auth.signOut();
      assert.ok(adminRows.length > 0, 'admin@camps.ps must have at least one seeded notification for this probe to be meaningful');
      const targetId = adminRows[0].id;

      const superClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
      await superClient.auth.signInWithPassword({ email: 'super@camps.ps', password: PASSWORD });

      const { data: probe } = await superClient.from('notifications').select('id').eq('id', targetId).maybeSingle();
      assert.equal(probe, null, "super_admin must not be able to read a camp_admin's notification row merely by knowing its id");

      const { error: updateError, data: updateData } = await superClient
        .from('notifications')
        .update({ is_read: true })
        .eq('id', targetId)
        .select();
      assert.ok(updateError || (updateData && updateData.length === 0), "super_admin's UPDATE against another account's notification id must affect zero rows");
      await superClient.auth.signOut();
    });

    await t.test('anonymous: notifications is unreachable without a session', async () => {
      const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
      const { data, error } = await client.from('notifications').select('id').limit(1);
      assert.ok(error || (data && data.length === 0), 'anonymous notifications read must be rejected or return nothing');
    });

    await t.test('no notification-related URL parameter exists to spoof (Camp Admin, dashboard + families)', async () => {
      for (const path of ['dashboard.html', 'families.html']) {
        const page = await browser.newPage();
        await login(page, base, 'admin@camps.ps', PASSWORD);
        await page.goto(`${base}/pages/${path}?notificationUserId=${encodeURIComponent('de97698b-bf25-4aa0-a181-039aaa55f16a')}`, { waitUntil: 'load' });
        await page.waitForSelector('[data-dropdown="notifications"]', { timeout: 15000 });
        const badge = page.locator('[data-dropdown="notifications"] .dropdown__trigger .count-badge');
        const badgeText = (await badge.count()) > 0 ? await badge.innerText() : '0';
        assert.equal(badgeText, '2', `${path}: a fabricated notificationUserId query param must not change whose badge count renders (admin's own count of 2 still shows)`);
        await page.close();
      }
    });

    await t.test('mark-all-read as Camp Admin (admin) never touches another Camp Admin (nour, control) or Super Admin (super, control)', async () => {
      const [{ data: adminBefore }, { data: nourBefore }, { data: superBefore }] = await Promise.all([
        serviceClient.from('notifications').select('id, is_read, read_at').eq('recipient_id', 'aefbd763-e1df-42c9-b95b-7ff9934cfe81'),
        serviceClient.from('notifications').select('id, is_read').eq('recipient_id', 'de9b01cd-0388-4d63-a162-0832d6897528'),
        serviceClient.from('notifications').select('id, is_read').eq('recipient_id', 'de97698b-bf25-4aa0-a181-039aaa55f16a'),
      ]);

      try {
        const page = await browser.newPage();
        await login(page, base, 'admin@camps.ps', PASSWORD);
        await page.goto(`${base}/pages/dashboard.html`, { waitUntil: 'load' });
        await page.waitForSelector('[data-dropdown="notifications"]', { timeout: 15000 });
        await page.locator('[data-dropdown="notifications"] .dropdown__trigger').click();
        const readAllBtn = page.locator('[data-read-all]');
        if (await readAllBtn.count()) {
          await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), readAllBtn.click()]);
        }
        await page.close();

        const [{ data: nourAfter }, { data: superAfter }] = await Promise.all([
          serviceClient.from('notifications').select('is_read').eq('recipient_id', 'de9b01cd-0388-4d63-a162-0832d6897528'),
          serviceClient.from('notifications').select('is_read').eq('recipient_id', 'de97698b-bf25-4aa0-a181-039aaa55f16a'),
        ]);
        assert.deepEqual(nourAfter.map((r) => r.is_read), nourBefore.map((r) => r.is_read), "nour's (a different Camp Admin) notification read-state must be unchanged by admin's mark-all-read");
        assert.deepEqual(superAfter.map((r) => r.is_read).sort(), superBefore.map((r) => r.is_read).sort(), "super's (Super Admin) notification read-state must be unchanged by admin's mark-all-read");
      } finally {
        for (const row of adminBefore) {
          await serviceClient.from('notifications').update({ is_read: row.is_read, read_at: row.read_at }).eq('id', row.id);
        }
      }
    });

    await t.test('mark-all-read as Super Admin (super) never touches Camp Admin (admin, control)', async () => {
      const [{ data: superBefore }, { data: adminBefore }] = await Promise.all([
        serviceClient.from('notifications').select('id, is_read, read_at').eq('recipient_id', 'de97698b-bf25-4aa0-a181-039aaa55f16a'),
        serviceClient.from('notifications').select('id, is_read').eq('recipient_id', 'aefbd763-e1df-42c9-b95b-7ff9934cfe81'),
      ]);

      try {
        const page = await browser.newPage();
        await login(page, base, 'super@camps.ps', PASSWORD);
        await page.goto(`${base}/pages/dashboard.html`, { waitUntil: 'load' });
        await page.waitForSelector('[data-dropdown="notifications"]', { timeout: 15000 });
        await page.locator('[data-dropdown="notifications"] .dropdown__trigger').click();
        const readAllBtn = page.locator('[data-read-all]');
        if (await readAllBtn.count()) {
          await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), readAllBtn.click()]);
        }
        await page.close();

        const { data: adminAfter } = await serviceClient.from('notifications').select('is_read').eq('recipient_id', 'aefbd763-e1df-42c9-b95b-7ff9934cfe81');
        assert.deepEqual(adminAfter.map((r) => r.is_read).sort(), adminBefore.map((r) => r.is_read).sort(), "admin's (Camp Admin) notification read-state must be unchanged by super's mark-all-read");
      } finally {
        for (const row of superBefore) {
          await serviceClient.from('notifications').update({ is_read: row.is_read, read_at: row.read_at }).eq('id', row.id);
        }
      }
    });

    await t.test('Displaced (ahmad) regression: Phase 4.14 header/dashboard behavior is unaffected', async () => {
      const page = await browser.newPage();
      const consoleErrors = [];
      page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
      await login(page, base, 'ahmad@camps.ps', PASSWORD);
      await page.goto(`${base}/pages/dashboard.html`, { waitUntil: 'load' });
      await page.waitForSelector('.stat', { timeout: 15000 });
      const badge = await page.locator('[data-dropdown="notifications"] .dropdown__trigger .count-badge').innerText();
      assert.equal(badge, '2', "ahmad's header badge must still show 2 (Phase 4.14 baseline, unaffected by this phase)");
      assert.deepEqual(consoleErrors, [], 'ahmad: dashboard must render with zero console errors');
      await page.close();
    });

    await t.test('session preservation: opening the header dropdown never changes auth.uid() (Camp Admin, Super Admin)', async () => {
      for (const email of ['admin@camps.ps', 'super@camps.ps']) {
        const page = await browser.newPage();
        await login(page, base, email, PASSWORD);
        const before = await page.evaluate(async () => {
          const mod = await import('/assets/js/core/supabase-client.js');
          const { data } = await mod.supabase.auth.getUser();
          return data.user.id;
        });
        await page.goto(`${base}/pages/dashboard.html`, { waitUntil: 'load' });
        await page.waitForSelector('[data-dropdown="notifications"]', { timeout: 15000 });
        await page.locator('[data-dropdown="notifications"] .dropdown__trigger').click();
        const after = await page.evaluate(async () => {
          const mod = await import('/assets/js/core/supabase-client.js');
          const { data } = await mod.supabase.auth.getUser();
          return data.user.id;
        });
        assert.equal(after, before, `${email}: opening the notification dropdown must not change auth.uid()`);
        await page.close();
      }
    });
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
});

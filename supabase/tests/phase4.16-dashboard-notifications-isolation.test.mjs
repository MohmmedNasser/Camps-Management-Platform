// supabase/tests/phase4.16-dashboard-notifications-isolation.test.mjs
/**
 * Phase 4.16 cross-user isolation: the dashboard's own
 * "الإشعارات غير المقروءة" stat card (Camp Admin, Super Admin — new this
 * phase; Displaced already covered by Phase 4.12/4.14) reads only the
 * signed-in account's own unread count. Reuses the same RLS
 * (`recipient_id = auth.uid()`) Phase 4.14/4.15 already proved for the
 * header; this suite proves the DASHBOARD's independent fetch is equally
 * safe, not merely "the header was already checked."
 *
 *   cd supabase && npm run frontend:config && npm run test:phase4.16-dashboard-notifications-isolation
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

function statCardValue(page, label) {
  return page
    .locator('.stat', { has: page.locator('.stat__label', { hasText: label }) })
    .locator('.stat__value')
    .innerText();
}

test('Phase 4.16 dashboard notification stat: cross-user isolation', async (t) => {
  const SUPABASE_URL = required('SUPABASE_URL');
  const SUPABASE_PUBLISHABLE_KEY = required('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY');
  const SUPABASE_SECRET_KEY = required('SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY');
  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

  const server = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();

  try {
    await t.test('Camp Admin (admin@camps.ps): dashboard stat reflects only own unread count, not affected by a spoofed query param', async () => {
      const page = await browser.newPage();
      const consoleErrors = [];
      page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
      await login(page, base, 'admin@camps.ps', PASSWORD);
      await page.goto(`${base}/pages/dashboard.html?notificationUserId=${encodeURIComponent('de97698b-bf25-4aa0-a181-039aaa55f16a')}`, { waitUntil: 'load' });
      await page.waitForSelector('.stat', { timeout: 15000 });
      const value = await statCardValue(page, 'الإشعارات غير المقروءة');
      assert.equal(value.trim(), '2', "admin's dashboard stat must show admin's own unread count (2), unaffected by a fabricated notificationUserId query param");
      assert.deepEqual(consoleErrors, [], 'Camp Admin dashboard must render with zero console errors');
      await page.close();
    });

    await t.test('Super Admin (super@camps.ps): dashboard stat reflects only own unread count', async () => {
      const page = await browser.newPage();
      await login(page, base, 'super@camps.ps', PASSWORD);
      await page.goto(`${base}/pages/dashboard.html`, { waitUntil: 'load' });
      await page.waitForSelector('.stat', { timeout: 15000 });
      const value = await statCardValue(page, 'الإشعارات غير المقروءة');
      assert.equal(value.trim(), '1', "super's dashboard stat must show super's own unread count (1)");
      await page.close();
    });

    await t.test('Camp Admin B (nour@camps.ps, real zero-notification account): dashboard stat renders 0, not blank/undefined', async () => {
      const page = await browser.newPage();
      await login(page, base, 'nour@camps.ps', PASSWORD);
      await page.goto(`${base}/pages/dashboard.html`, { waitUntil: 'load' });
      await page.waitForSelector('.stat', { timeout: 15000 });
      const value = await statCardValue(page, 'الإشعارات غير المقروءة');
      assert.equal(value.trim(), '0', "nour's dashboard stat must render the real 0, not blank or undefined");
      await page.close();
    });

    await t.test("localStorage tampering cannot change whose count the dashboard shows (Camp Admin)", async () => {
      const page = await browser.newPage();
      await login(page, base, 'admin@camps.ps', PASSWORD);
      await page.evaluate(() => {
        try { localStorage.setItem('dcmp:notificationUserId', 'de97698b-bf25-4aa0-a181-039aaa55f16a'); } catch {}
      });
      await page.goto(`${base}/pages/dashboard.html`, { waitUntil: 'load' });
      await page.waitForSelector('.stat', { timeout: 15000 });
      const value = await statCardValue(page, 'الإشعارات غير المقروءة');
      assert.equal(value.trim(), '2', 'a fabricated localStorage value must not change whose unread count the dashboard renders');
      await page.close();
    });

    await t.test('anonymous: notifications table is unreachable without a session (re-verified live)', async () => {
      const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
      const { data, error } = await client.from('notifications').select('id').limit(1);
      assert.ok(error || (data && data.length === 0), 'anonymous notifications read must be rejected or return nothing');
    });

    await t.test('session preservation: dashboard notification-count fetch never changes auth.uid() (Camp Admin, Super Admin)', async () => {
      for (const email of ['admin@camps.ps', 'super@camps.ps']) {
        const page = await browser.newPage();
        await login(page, base, email, PASSWORD);
        const before = await page.evaluate(async () => {
          const mod = await import('/assets/js/core/supabase-client.js');
          const { data } = await mod.supabase.auth.getUser();
          return data.user.id;
        });
        await page.goto(`${base}/pages/dashboard.html`, { waitUntil: 'load' });
        await page.waitForSelector('.stat', { timeout: 15000 });
        const after = await page.evaluate(async () => {
          const mod = await import('/assets/js/core/supabase-client.js');
          const { data } = await mod.supabase.auth.getUser();
          return data.user.id;
        });
        assert.equal(after, before, `${email}: loading the dashboard notification stat must not change auth.uid()`);
        await page.close();
      }
    });

    await t.test('Displaced (ahmad) regression: existing dashboard notification stat is unaffected by this phase', async () => {
      const page = await browser.newPage();
      const consoleErrors = [];
      page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
      await login(page, base, 'ahmad@camps.ps', PASSWORD);
      await page.goto(`${base}/pages/dashboard.html`, { waitUntil: 'load' });
      await page.waitForSelector('.stat', { timeout: 15000 });
      const value = await statCardValue(page, 'الإشعارات غير المقروءة');
      assert.equal(value.trim(), '2', "ahmad's dashboard stat must still show 2 (Phase 4.12/4.14 baseline, unaffected by this phase)");
      assert.deepEqual(consoleErrors, [], 'Displaced dashboard must render with zero console errors');
      await page.close();
    });
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
});

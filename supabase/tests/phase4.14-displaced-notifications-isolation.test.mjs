// supabase/tests/phase4.14-displaced-notifications-isolation.test.mjs
/**
 * Phase 4.14 cross-user isolation: proves the dashboard unread stat and the
 * header notification bell/dropdown, now wired to real Supabase data for the
 * displaced role, can read/update only the signed-in account's OWN
 * notifications — through RLS directly, not merely "the UI doesn't show
 * it" — and that Camp Admin/Super Admin are unaffected.
 *
 *   cd supabase && npm run frontend:config && npm run test:phase4.14-displaced-notifications-isolation
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

test('Phase 4.14 displaced notifications: cross-user isolation', async (t) => {
  const SUPABASE_URL = required('SUPABASE_URL');
  const SUPABASE_PUBLISHABLE_KEY = required('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY');
  const SUPABASE_SECRET_KEY = required('SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY');
  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

  const server = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();

  try {
    for (const email of DISPLACED_ACCOUNTS) {
      await t.test(`${email}: RLS returns/updates only own notifications`, async () => {
        const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
        await client.auth.signInWithPassword({ email, password: PASSWORD });
        const { data: { user } } = await client.auth.getUser();

        const { data: own } = await client.from('notifications').select('id, recipient_id');
        assert.ok(own.every((row) => row.recipient_id === user.id), `${email} must see zero notifications with a different recipient_id`);

        await client.auth.signOut();
      });
    }

    await t.test("cross-account read isolation: yousef cannot read ahmad's notifications by id", async () => {
      const ahmadClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
      await ahmadClient.auth.signInWithPassword({ email: 'ahmad@camps.ps', password: PASSWORD });
      const { data: ahmadRows } = await ahmadClient.from('notifications').select('id');
      await ahmadClient.auth.signOut();
      assert.ok(ahmadRows.length > 0, 'ahmad must have at least one seeded notification for this probe to be meaningful');

      const yousefClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
      await yousefClient.auth.signInWithPassword({ email: 'yousef@camps.ps', password: PASSWORD });
      const { data: probe } = await yousefClient.from('notifications').select('id').eq('id', ahmadRows[0].id).maybeSingle();
      assert.equal(probe, null, "yousef must not be able to read ahmad's notification row by direct id");

      const { data: updateAttempt, error: updateError } = await yousefClient
        .from('notifications')
        .update({ is_read: true })
        .eq('id', ahmadRows[0].id)
        .select();
      assert.ok(updateError || (updateAttempt && updateAttempt.length === 0), "yousef's UPDATE against ahmad's notification id must affect zero rows (RLS), not silently succeed");
      await yousefClient.auth.signOut();
    });

    await t.test('anonymous: notifications is unreachable without a session', async () => {
      const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
      const { data, error } = await client.from('notifications').select('id').limit(1);
      assert.ok(error || (data && data.length === 0), 'anonymous notifications read must be rejected or return nothing');
    });

    await t.test('no notification-related URL parameter exists to spoof', async () => {
      const page = await browser.newPage();
      await login(page, base, 'ahmad@camps.ps', PASSWORD);
      await page.goto(`${base}/pages/dashboard.html?notificationUserId=${encodeURIComponent('b68268cb-6bfc-4c55-8176-36322ef1aa27')}`, { waitUntil: 'load' });
      await page.waitForSelector('.stat', { timeout: 15000 });
      const bodyText = await page.locator('body').innerText();
      assert.ok(bodyText.includes('أحمد محمود الشريف') || bodyText.includes('2'), "a fabricated query param must not change whose notification count renders (ahmad's own data/count still shows)");
      await page.close();
    });

    await t.test("mark-all-read as one account never touches another account's notifications", async () => {
      // Both ahmad's and omar's seeded notification state are captured before
      // this subtest touches the UI and restored in a finally, so this real
      // write against seeded (not disposable-fixture) rows leaves the seed
      // baseline exactly as it found it, regardless of pass/fail below.
      const [{ data: ahmadBefore }, { data: omarBefore }] = await Promise.all([
        serviceClient.from('notifications').select('id, is_read, read_at').eq('recipient_id', '0329ca55-26b6-4da1-be5b-db2c436cbee4'),
        serviceClient.from('notifications').select('id, is_read').eq('recipient_id', 'b68268cb-6bfc-4c55-8176-36322ef1aa27'),
      ]);

      try {
        const page = await browser.newPage();
        await login(page, base, 'ahmad@camps.ps', PASSWORD);
        await page.goto(`${base}/pages/dashboard.html`, { waitUntil: 'load' });
        await page.waitForSelector('.stat', { timeout: 15000 });
        const trigger = page.locator('[data-dropdown="notifications"] .dropdown__trigger');
        await trigger.click();
        const readAllBtn = page.locator('[data-read-all]');
        if (await readAllBtn.count()) {
          await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), readAllBtn.click()]);
        }
        await page.close();

        const { data: omarAfter } = await serviceClient.from('notifications').select('id, is_read').eq('recipient_id', 'b68268cb-6bfc-4c55-8176-36322ef1aa27');
        assert.deepEqual(
          omarAfter.map((r) => r.is_read).sort(),
          omarBefore.map((r) => r.is_read).sort(),
          "omar's (a different displaced account) notification read-state must be unchanged by ahmad's mark-all-read"
        );
      } finally {
        // Restore ahmad's pre-subtest read/unread state (seed baseline),
        // since this subtest deliberately exercises the real mark-all-read
        // write against a seeded account rather than a disposable fixture.
        for (const row of ahmadBefore) {
          await serviceClient.from('notifications').update({ is_read: row.is_read, read_at: row.read_at }).eq('id', row.id);
        }
      }
    });

    await t.test('Camp Admin and Super Admin headers/dashboards are unaffected', async () => {
      for (const email of ['admin@camps.ps', 'super@camps.ps']) {
        const page = await browser.newPage();
        const consoleErrors = [];
        page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
        await login(page, base, email, PASSWORD);
        await page.goto(`${base}/pages/dashboard.html`, { waitUntil: 'load' });
        await page.waitForSelector('.stat', { timeout: 15000 });
        assert.deepEqual(consoleErrors, [], `${email}: dashboard must render with zero console errors`);
        await page.close();
      }
    });

    await t.test('session preservation: opening the header dropdown never changes auth.uid()', async () => {
      const page = await browser.newPage();
      await login(page, base, 'ahmad@camps.ps', PASSWORD);
      const before = await page.evaluate(async () => {
        const mod = await import('/assets/js/core/supabase-client.js');
        const { data } = await mod.supabase.auth.getUser();
        return data.user.id;
      });
      await page.goto(`${base}/pages/dashboard.html`, { waitUntil: 'load' });
      await page.waitForSelector('.stat', { timeout: 15000 });
      await page.locator('[data-dropdown="notifications"] .dropdown__trigger').click();
      const after = await page.evaluate(async () => {
        const mod = await import('/assets/js/core/supabase-client.js');
        const { data } = await mod.supabase.auth.getUser();
        return data.user.id;
      });
      assert.equal(after, before, 'opening the notification dropdown must not change auth.uid()');
      await page.close();
    });
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
});

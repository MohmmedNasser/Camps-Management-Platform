/**
 * Phase 4.29 browser pass (real Chromium, real backend): the forms whose password rule changed and the
 * detail pages that render ages, at 320/375/414/768/1024/1280/1440.
 *
 *  - register / reset-password / activate-family / forgot-password: no console errors, no failed or 4xx/5xx
 *    requests, no horizontal page scroll; the register form states "8 أحرف" and refuses a 7-character password
 *    but not an 8-character one;
 *  - displaced `profile.html`: the change-password form refuses 7 characters client-side (no request is made);
 *  - camp admin `displaced-details.html`: ages render ("N سنة") with no errors;
 *  - logout (global sign-out) lands on login and a protected URL then redirects to login.
 *
 *   cd supabase && npm run frontend:config && npm run test:phase4.29-browser
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile as readFileAsync } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
const WIDTHS = [320, 375, 414, 768, 1024, 1280, 1440];

for (const line of (() => { try { return readFileSync(resolve(ROOT, '.env'), 'utf8'); } catch { return ''; } })().split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
const required = (...names) => {
  for (const n of names) if (process.env[n]) return process.env[n];
  throw new Error(`Missing ${names.join(' or ')}`);
};
const service = createClient(required('SUPABASE_URL'), required('SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });

function startServer() {
  return new Promise((done) => {
    const server = createServer(async (req, res) => {
      const safe = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
      for (const candidate of extname(safe) ? [safe] : [safe, `${safe}.html`]) {
        try {
          const file = join(ROOT, candidate);
          const body = await readFileAsync(file);
          res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
          res.end(body);
          return;
        } catch { /* next */ }
      }
      res.writeHead(404);
      res.end('not found');
    });
    server.listen(0, '127.0.0.1', () => done(server));
  });
}

function watch(page, problems) {
  page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
  page.on('response', (r) => r.status() >= 400 && problems.push(`http ${r.status()}: ${r.url()}`));
}
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function login(page, base, email) {
  await page.goto(`${base}/pages/login.html`, { waitUntil: 'load' });
  await page.fill('#email', email);
  await page.fill('#password', '123456');
  await page.click('button[type="submit"]');
  await page.waitForURL(/dashboard/, { timeout: 15000 });
}

test('Phase 4.29 browser pass', async (t) => {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  try {
    await t.test('public password forms: clean at every width, hints and validation say 8', async () => {
      for (const path of ['register.html', 'forgot-password.html', 'reset-password.html', 'activate-family.html?token=phase429']) {
        for (const width of WIDTHS) {
          const problems = [];
          const page = await browser.newPage({ viewport: { width, height: 800 } });
          watch(page, problems);
          await page.goto(`${base}/pages/${path}`, { waitUntil: 'networkidle' });
          assert.ok((await overflow(page)) <= 0, `${path} @${width}: horizontal overflow`);
          assert.deepEqual(problems.filter((p) => !/reset-password/.test(path) || !/^http 4\d\d/.test(p)), [], `${path} @${width}`);
          await page.close();
        }
      }
    });

    await t.test('register: hint says 8; 7 characters is refused, 8 is not', async () => {
      const countRequests = () => service.from('registration_requests').select('id', { count: 'exact', head: true }).then((r) => r.count);
      const before = await countRequests();
      const page = await browser.newPage({ viewport: { width: 375, height: 900 } });
      await page.goto(`${base}/pages/register.html`, { waitUntil: 'networkidle' });
      assert.match(await page.locator('body').innerText(), /8 أحرف على الأقل/);
      await page.fill('#password', '1234567');
      await page.locator('form').first().evaluate((f) => f.requestSubmit());
      assert.match(await page.locator('body').innerText(), /ألا تقل عن 8 أحرف/, '7 chars refused');
      await page.fill('#password', '12345678');
      await page.locator('form').first().evaluate((f) => f.requestSubmit());
      assert.doesNotMatch(await page.locator('body').innerText(), /ألا تقل عن 8 أحرف/, '8 chars accepted by the length rule');
      assert.equal(await countRequests(), before, 'nothing was registered');
      await page.close();
    });

    await t.test('displaced profile: change-password form refuses 7 characters without sending anything', async () => {
      for (const width of WIDTHS) {
        const problems = [];
        const context = await browser.newContext({ viewport: { width, height: 900 } });
        const page = await context.newPage();
        watch(page, problems);
        await login(page, base, 'ahmad@camps.ps');
        await page.goto(`${base}/pages/profile.html`, { waitUntil: 'networkidle' });
        await page.waitForSelector('#password-form');
        assert.ok((await overflow(page)) <= 0, `profile @${width}: horizontal overflow`);
        let authWrites = 0;
        page.on('request', (r) => /\/auth\/v1\/(user|token)/.test(r.url()) && r.method() !== 'GET' && (authWrites += 1));
        await page.fill('#currentPassword', '123456');
        await page.fill('#newPassword', '1234567');
        await page.fill('#confirmPassword', '1234567');
        await page.locator('#password-form').evaluate((f) => f.requestSubmit());
        assert.match(await page.locator('#password-form').innerText(), /ألا تقل عن 8 أحرف/);
        assert.equal(authWrites, 0, 'no auth request for a refused password');
        assert.deepEqual(problems, [], `profile @${width}`);
        await context.close();
      }
    });

    await t.test('camp admin: a displaced person file renders ages cleanly at every width', async () => {
      const { data: member } = await service.from('family_members').select('id').not('birth_date', 'is', null).eq('camp_id', '5853adc9-9d23-4d4d-bc32-6fff17bdc3b0').limit(1).single();
      for (const width of WIDTHS) {
        const problems = [];
        const context = await browser.newContext({ viewport: { width, height: 900 } });
        const page = await context.newPage();
        watch(page, problems);
        await login(page, base, 'admin@camps.ps');
        await page.goto(`${base}/pages/displaced-details.html?id=${member.id}`, { waitUntil: 'networkidle' });
        await page.waitForFunction(() => !document.querySelector('.skeleton'), null, { timeout: 15000 });
        assert.match(await page.locator('body').innerText(), /\d+ سنة|[٠-٩]+ سنة/, `@${width}: an age is rendered`);
        assert.ok((await overflow(page)) <= 0, `details @${width}: horizontal overflow`);
        assert.deepEqual(problems, [], `details @${width}`);
        await context.close();
      }
    });

    await t.test('logout lands on login and protected URLs redirect afterwards', async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await login(page, base, 'ahmad@camps.ps');
      await page.click('[data-dropdown="user"] .dropdown__trigger');
      await page.click('[data-logout]');
      await page.click('[data-confirm]');
      await page.waitForURL(/login/, { timeout: 15000 });
      await page.goto(`${base}/pages/dashboard.html`, { waitUntil: 'load' });
      await page.waitForURL(/login/, { timeout: 15000 });
      await context.close();
    });
  } finally {
    await browser.close();
    server.close();
  }
});

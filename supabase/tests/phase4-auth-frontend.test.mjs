// supabase/tests/phase4-auth-frontend.test.mjs
/**
 * Phase 4.1 real-auth verification: drives the actual login form and real
 * pages, against the live seeded project, in a real browser — the frontend
 * imports the CDN-hosted supabase-js, which Node cannot resolve directly
 * (same constraint as browser-smoke.test.mjs).
 *
 *   cd supabase && npm run frontend:config && npm run test:phase4-auth-frontend
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, normalize, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };

/**
 * Serves the repo AND replicates the clean-URL rewrite that `npx serve`,
 * Vercel, Netlify and GitHub Pages perform (extensionless request ->
 * matching `.html` file) — router.js's cleanUrls()/currentPage() behavior
 * depends on it, and CLAUDE.md is explicit that this needs a real server,
 * not just a real browser.
 */
function startServer() {
  return new Promise((resolvePromise) => {
    const server = createServer(async (req, res) => {
      const safePath = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
      const candidates = extname(safePath) ? [safePath] : [safePath, `${safePath}.html`];
      for (const candidate of candidates) {
        try {
          const filePath = join(ROOT, candidate);
          const body = await readFile(filePath);
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

test('Phase 4.1 real-auth verification', async (t) => {
  const server = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();

  try {
    await t.test('#1-2 login: correct credentials reach the dashboard, wrong password shows a friendly error', async () => {
      const page = await browser.newPage();
      await page.goto(`${base}/pages/login.html`, { waitUntil: 'load' });
      await page.fill('#email', 'admin@camps.ps');
      await page.fill('#password', 'wrong-password');
      await page.click('button[type="submit"]');
      await page.waitForSelector('#login-error:not(.u-hidden)', { timeout: 10000 });
      const errorText = await page.locator('#login-error').innerText();
      assert.match(errorText, /[؀-ۿ]/, 'error must be Arabic text');
      assert.doesNotMatch(errorText, /postgres|sql|jwt|stack/i, 'must never leak raw backend error text');

      await login(page, base, 'admin@camps.ps', '123456');
      assert.match(page.url(), /dashboard/);
      await page.close();
    });

    await t.test('#4 session persists across a page refresh', async () => {
      const page = await browser.newPage();
      await login(page, base, 'super@camps.ps', '123456');
      await page.reload({ waitUntil: 'load' });
      await page.waitForURL(/dashboard/, { timeout: 15000 });
      assert.match(page.url(), /dashboard/);
      await page.close();
    });

    await t.test('#5 unauthenticated direct access to a protected page redirects to login', async () => {
      const page = await browser.newPage();
      await page.goto(`${base}/pages/displaced.html`, { waitUntil: 'load' });
      await page.waitForURL(/login/, { timeout: 15000 });
      assert.match(page.url(), /login/);
      await page.close();
    });

    await t.test('#6 displaced role denied a camp_admin/super_admin-only page', async () => {
      const page = await browser.newPage();
      await login(page, base, 'ahmad@camps.ps', '123456');
      await page.goto(`${base}/pages/camps.html`, { waitUntil: 'load' });
      await page.waitForURL(/404/, { timeout: 15000 });
      assert.match(page.url(), /404/);
      await page.close();
    });

    await t.test('#7 camp_admin denied a super_admin-only page', async () => {
      const page = await browser.newPage();
      await login(page, base, 'admin@camps.ps', '123456');
      await page.goto(`${base}/pages/camps.html`, { waitUntil: 'load' });
      await page.waitForURL(/404/, { timeout: 15000 });
      assert.match(page.url(), /404/);
      await page.close();
    });

    await t.test('#8 logout, then direct protected-URL access redirects to login', async () => {
      const page = await browser.newPage();
      await login(page, base, 'ahmad@camps.ps', '123456');
      await page.click('[data-dropdown="user"] .dropdown__trigger');
      await page.click('[data-logout]');
      await page.click('[data-confirm]');
      await page.waitForURL(/login/, { timeout: 15000 });

      await page.goto(`${base}/pages/dashboard.html`, { waitUntil: 'load' });
      await page.waitForURL(/login/, { timeout: 15000 });
      assert.match(page.url(), /login/);
      await page.close();
    });

    await t.test('#9 both URL styles redirect an unauthenticated visitor the same way', async () => {
      const page = await browser.newPage();
      await page.goto(`${base}/pages/dashboard`, { waitUntil: 'load' });
      await page.waitForURL(/login/, { timeout: 15000 });
      assert.match(page.url(), /login/);
      await page.close();
    });

    await t.test('#10 no service_role or Cloudinary secret is ever transmitted', async () => {
      const page = await browser.newPage();
      const seenSecrets = [];
      page.on('request', (req) => {
        const url = req.url();
        const body = req.postData() || '';
        if (/sb_secret_|service_role|CLOUDINARY_API_SECRET/i.test(url + body)) seenSecrets.push(url);
      });
      await login(page, base, 'super@camps.ps', '123456');
      assert.deepEqual(seenSecrets, [], `secret material seen in requests: ${seenSecrets.join(', ')}`);
      await page.close();
    });

    await t.test('#12 role-switcher UI is gone from the user menu', async () => {
      const page = await browser.newPage();
      await login(page, base, 'super@camps.ps', '123456');
      await page.click('[data-dropdown="user"] .dropdown__trigger');
      const roleSwitchCount = await page.locator('[data-role]').count();
      assert.equal(roleSwitchCount, 0, 'role switcher must not be present anywhere in the DOM');
      await page.close();
    });
  } finally {
    await browser.close();
    server.close();
  }
});

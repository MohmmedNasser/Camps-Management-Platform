/**
 * Phase 4.23 browser pass: every page whose data access was batched loads for
 * each role with no console/page errors, no failed requests, no stuck
 * skeleton, and no horizontal overflow at the six established widths.
 * Also proves the Camp Admin families export contains every family (the full
 * filtered set, not a page).
 *
 *   cd supabase && npm run frontend:config && npm run test:phase4.23-browser
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

for (const line of (() => { try { return readFileSync(resolve(ROOT, '.env'), 'utf8'); } catch { return ''; } })().split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
const required = (...names) => {
  for (const n of names) if (process.env[n]) return process.env[n];
  throw new Error(`Missing ${names.join(' or ')}`);
};
const service = createClient(required('SUPABASE_URL'), required('SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false },
});
const PASSWORD = '123456';
const WIDTHS = [320, 375, 768, 1024, 1280, 1440];

const PAGES = {
  'admin@camps.ps': ['dashboard', 'families', 'displaced', 'aid', 'documents', 'messages', 'notifications', 'registration-requests'],
  'super@camps.ps': ['dashboard', 'families', 'displaced', 'aid', 'documents', 'messages', 'statistics'],
  'ahmad@camps.ps': ['dashboard', 'family-details', 'aid', 'documents', 'notifications', 'messages'],
};

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

test('Phase 4.23 browser verification', async (t) => {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  try {
    for (const [email, pages] of Object.entries(PAGES)) {
      const context = await browser.newContext({ acceptDownloads: true });
      const page = await context.newPage();
      const problems = [];
      page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
      page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
      page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
      page.on('response', (r) => r.status() >= 400 && problems.push(`http ${r.status()}: ${r.url()}`));

      await page.goto(`${base}/pages/login.html`, { waitUntil: 'load' });
      await page.fill('#email', email);
      await page.fill('#password', PASSWORD);
      await page.click('button[type="submit"]');
      await page.waitForURL(/dashboard/, { timeout: 15000 });

      for (const name of pages) {
        await t.test(`${email}: ${name} loads clean at all widths`, async () => {
          for (const width of WIDTHS) {
            problems.length = 0;
            await page.setViewportSize({ width, height: 900 });
            await page.goto(`${base}/pages/${name}.html`, { waitUntil: 'load' });
            await page.waitForFunction(() => document.querySelector('#content, main, .page') && !document.querySelector('.skeleton'), null, { timeout: 15000 });
            const overflow = await page.evaluate(() => document.body.scrollWidth > window.innerWidth + 1);
            assert.equal(overflow, false, `${name} overflows horizontally at ${width}px`);
            assert.deepEqual(problems, [], `${name} @${width}: ${problems.join(' | ')}`);
          }
        });
      }

      if (email === 'admin@camps.ps') {
        await t.test('camp admin families export holds every family in the camp', async () => {
          await page.setViewportSize({ width: 1440, height: 900 });
          await page.goto(`${base}/pages/families.html`, { waitUntil: 'load' });
          await page.waitForFunction(() => !document.querySelector('.skeleton'), null, { timeout: 15000 });
          const { data: { user } } = await createClient(process.env.SUPABASE_URL, required('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY'), { auth: { persistSession: false } })
            .auth.signInWithPassword({ email, password: PASSWORD }).then((r) => ({ data: { user: r.data.user } }));
          const { data: profile } = await service.from('profiles').select('camp_id').eq('id', user.id).single();
          const { count } = await service.from('families').select('id', { count: 'exact', head: true }).eq('camp_id', profile.camp_id);
          const [download] = await Promise.all([
            page.waitForEvent('download', { timeout: 15000 }),
            page.locator('[data-action="export"], button:has-text("تصدير")').first().click(),
          ]);
          const path = await download.path();
          const { execFileSync } = await import('node:child_process');
          const xml = execFileSync('python', ['-c', `import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);print(z.read('xl/worksheets/sheet1.xml').decode('utf8').count('<row '))`, path]).toString().trim();
          assert.equal(Number(xml) - 1, count, 'export rows (minus header) equal families in the camp');
        });
      }
      await context.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
});

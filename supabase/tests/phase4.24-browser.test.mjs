/**
 * Phase 4.24 browser pass: families (server-filtered) and statistics (DB
 * aggregated) load clean at the six widths for their roles, statistics cards
 * equal independent SQL counts, family search/export agree with the database.
 *
 *   cd supabase && npm run frontend:config && npm run test:phase4.24-browser
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

const digits = (s) => Number(String(s).replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 0x0660).replace(/[^0-9]/g, ''));
const PAGES = { 'admin@camps.ps': ['families'], 'super@camps.ps': ['families', 'statistics'] };

const expectCount = (page, n) =>
  page.waitForFunction((want) => {
    if (document.querySelector('.skeleton')) return false;
    const strongs = document.querySelectorAll('.result-bar__count strong');
    const toNum = (t) => Number(t.replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 0x0660));
    return strongs.length < 2 ? want === 0 && !!document.querySelector('#results')?.textContent.trim() : toNum(strongs[1].textContent.trim()) === want;
  }, n, { timeout: 15000 });

async function login(browser, base, email, problems) {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
  page.on('response', (r) => r.status() >= 400 && problems.push(`http ${r.status()}: ${r.url()}`));
  await page.goto(`${base}/pages/login.html`, { waitUntil: 'load' });
  await page.fill('#email', email);
  await page.fill('#password', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/dashboard/, { timeout: 15000 });
  return { context, page };
}
const settled = (page) => page.waitForFunction(() => !document.querySelector('.skeleton') && document.querySelector('.page, main'), null, { timeout: 15000 });
const shownCount = async (page) => ((await page.locator('.result-bar__count strong').count()) < 2 ? 0 : digits(await page.locator('.result-bar__count strong').nth(1).innerText()));

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

test('Phase 4.24 browser verification', async (t) => {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  try {
    for (const [email, pages] of Object.entries(PAGES)) {
      const problems = [];
      const { context, page } = await login(browser, base, email, problems);
      for (const name of pages) {
        await t.test(`${email}: ${name} clean at all widths`, async () => {
          for (const width of WIDTHS) {
            problems.length = 0;
            await page.setViewportSize({ width, height: 900 });
            await page.goto(`${base}/pages/${name}.html`, { waitUntil: 'load' });
            await settled(page);
            assert.equal(await page.evaluate(() => document.body.scrollWidth > window.innerWidth + 1), false, `${name} overflows at ${width}px`);
            assert.deepEqual(problems, [], `${name} @${width}: ${problems.join(' | ')}`);
          }
        });
      }

      await t.test(`${email}: families count, search, special-char search and export agree with the database`, async () => {
        problems.length = 0;
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(`${base}/pages/families.html`, { waitUntil: 'load' });
        await settled(page);
        const { data: { user } } = await createClient(process.env.SUPABASE_URL, required('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY'), { auth: { persistSession: false } })
          .auth.signInWithPassword({ email, password: PASSWORD });
        const { data: profile } = await service.from('profiles').select('camp_id, role').eq('id', user.id).single();
        let fam = service.from('families').select('reference_code');
        if (profile.role === 'camp_admin') fam = fam.eq('camp_id', profile.camp_id);
        const { data: families } = await fam;
        await page.waitForSelector('.result-bar__count', { timeout: 15000 });
        assert.equal(await shownCount(page), families.length, 'unfiltered count');

        const search = page.locator('#toolbar-search');
        await search.fill(families[0].reference_code);
        await page.waitForFunction((n) => document.querySelectorAll('.result-bar__count strong')[1]?.textContent.trim() === n, '1', { timeout: 10000 }).catch(() => {});
        assert.equal(await shownCount(page), 1, 'search by reference code');

        await search.fill('%');
        await expectCount(page, 0);
        assert.equal(await shownCount(page), 0, 'literal % matches nothing (no wildcard leak)');

        await search.fill('FAM');
        await expectCount(page, families.length);
        const filtered = await shownCount(page);
        assert.equal(filtered, families.length);
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 15000 }),
          page.locator('[data-export]').first().click(),
        ]);
        const { execFileSync } = await import('node:child_process');
        const rows = execFileSync('python', ['-c', "import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);print(z.read('xl/worksheets/sheet1.xml').decode('utf8').count('<row '))", await download.path()]).toString().trim();
        assert.equal(Number(rows) - 1, filtered, 'export rows equal filtered count');
        assert.deepEqual(problems, [], problems.join(' | '));
      });

      if (email === 'super@camps.ps') {
        await t.test('statistics cards equal independent SQL counts', async () => {
          await page.setViewportSize({ width: 1440, height: 900 });
          await page.goto(`${base}/pages/statistics.html`, { waitUntil: 'load' });
          await settled(page);
          const cards = await page.$$eval('.stat', (els) => els.map((e) => [e.querySelector('.stat__label')?.textContent.trim(), e.querySelector('.stat__value')?.textContent.trim()]));
          const shown = Object.fromEntries(cards);
          const count = async (table, f = (q) => q) => (await f(service.from(table).select('id', { count: 'exact', head: true }))).count;
          assert.equal(digits(shown['إجمالي النازحين']), await count('family_members'));
          assert.equal(digits(shown['إجمالي الأسر']), await count('families'));
          assert.equal(digits(shown['المساعدات الموزَّعة']), await count('aid_distributions'));
          assert.equal(digits(shown['ذوو الإعاقة']), await count('family_members', (q) => q.neq('disability', '')));
          assert.equal(digits(shown['الأمراض المزمنة']), await count('family_members', (q) => q.neq('chronic_diseases', '')));
          assert.equal(digits(shown['المخيمات']), await count('camps'));
        });
      }
      await context.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
});

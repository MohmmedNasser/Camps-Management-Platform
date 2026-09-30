/**
 * Phase 4.25 browser pass: displaced.html and aid.html (server-side lists).
 *
 *  - clean load (no console errors, failed requests, stuck skeleton) and no real
 *    body overflow at 320/375/768/1024/1280/1440 for every role that can open each page;
 *  - page 1 asks the database for ONE page (p_limit/p_offset in the request, page-sized
 *    response, no whole-table read of family_members / aid_distributions);
 *  - the count on screen equals independent service-role counts, filters and search change
 *    rows and total together, page 2 / last page / a page beyond the end behave, changing a
 *    filter on a later page returns to page 1, a slow stale response never overwrites a newer one;
 *  - Excel export is the COMPLETE filtered set (more rows than one page), not the visible page;
 *  - the filter sheet's live preview is the database total;
 *  - an RPC failure renders the error state and Retry recovers;
 *  - a displaced account cannot open displaced.html and sees only its own family's aid.
 *
 *   cd supabase && npm run frontend:config && npm run test:phase4.25-browser
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
const service = createClient(required('SUPABASE_URL'), required('SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
const PASSWORD = '123456';
const WIDTHS = [320, 375, 768, 1024, 1280, 1440];
const PAGE_SIZE = 10;

const digits = (s) => Number(String(s).replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 0x0660).replace(/[^0-9]/g, ''));
const todayUTC = new Date().toISOString().slice(0, 10);
const ageAt = (birth, on = todayUTC) => {
  const [by, bm, bd] = birth.split('-').map(Number);
  const [oy, om, od] = on.split('-').map(Number);
  return oy - by - (om < bm || (om === bm && od < bd) ? 1 : 0);
};

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
const settled = (page) => page.waitForFunction(() => !document.querySelector('.skeleton') && document.querySelector('#results')?.textContent.trim(), null, { timeout: 15000 });
/** Total shown by the result bar (0 when the empty state is shown). */
const shownTotal = async (page) => ((await page.locator('.result-bar__count strong').count()) < 2 ? 0 : digits(await page.locator('.result-bar__count strong').nth(1).innerText()));
const shownRows = (page) => page.locator('#results tbody tr, #results ul.stack > li').count();
const waitForTotal = (page, n) =>
  page.waitForFunction((want) => {
    if (document.querySelector('.skeleton')) return false;
    const strongs = document.querySelectorAll('.result-bar__count strong');
    const toNum = (t) => Number(t.replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 0x0660));
    return strongs.length < 2 ? want === 0 && !!document.querySelector('#results')?.textContent.trim() : toNum(strongs[1].textContent.trim()) === want;
  }, n, { timeout: 15000 });
const currentPageNumber = async (page) => {
  const el = page.locator('.pagination__btn[aria-current="page"]');
  return (await el.count()) ? digits(await el.first().innerText()) : 1;
};
const xlsxRows = async (path) => {
  const { execFileSync } = await import('node:child_process');
  return Number(execFileSync('python', ['-c', "import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);print(z.read('xl/worksheets/sheet1.xml').decode('utf8').count('<row '))", path]).toString().trim()) - 1;
};
const exportRows = async (page) => {
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.locator('[data-export]').first().click()]);
  return xlsxRows(await download.path());
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

/** Records every list RPC + whole-table REST request the page makes. */
function watchRequests(page) {
  const log = { rpc: [], wholeTable: [], bytes: 0 };
  page.on('request', (r) => {
    const url = r.url();
    const m = /\/rest\/v1\/rpc\/(list_displaced_persons|list_aid_distributions)/.exec(url);
    if (m) log.rpc.push({ name: m[1], body: JSON.parse(r.postData() || '{}') });
    else if (/\/rest\/v1\/(family_members|aid_distributions)\b/.test(url)) log.wholeTable.push(url);
  });
  page.on('response', async (r) => {
    if (/\/rest\/v1\/rpc\/list_/.test(r.url())) log.bytes += (await r.body().catch(() => Buffer.alloc(0))).length;
  });
  return log;
}

const ACCOUNTS = [
  { email: 'admin@camps.ps', pages: ['displaced', 'aid'] },
  { email: 'super@camps.ps', pages: ['displaced', 'aid'] },
  { email: 'ahmad@camps.ps', pages: ['aid'] },
];

test('Phase 4.25 browser verification', async (t) => {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();

  const { data: members } = await service.from('family_members').select('id, camp_id, gender, birth_date, national_id, full_name, family_id');
  const { data: dists } = await service.from('aid_distributions').select('id, camp_id, organization_id');
  const { data: types } = await service.from('aid_distribution_types').select('distribution_id, aid_type:aid_types(code)');
  const { data: links } = await service.from('aid_distribution_families').select('distribution_id, family_id');
  const profileOf = async (email) => {
    const c = createClient(process.env.SUPABASE_URL, required('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY'), { auth: { persistSession: false } });
    const { data: { user } } = await c.auth.signInWithPassword({ email, password: PASSWORD }).then((r) => ({ data: r.data }));
    const { data } = await service.from('profiles').select('camp_id, role, family_member_id').eq('id', user.id).single();
    return data;
  };

  try {
    for (const { email, pages } of ACCOUNTS) {
      const problems = [];
      const { context, page } = await login(browser, base, email, problems);
      const profile = await profileOf(email);
      const scopeMembers = profile.role === 'super_admin' ? members : members.filter((m) => m.camp_id === profile.camp_id);
      const ownFamily = profile.family_member_id ? members.find((m) => m.id === profile.family_member_id).family_id : null;
      const scopeDists = profile.role === 'super_admin' ? dists
        : profile.role === 'camp_admin' ? dists.filter((d) => d.camp_id === profile.camp_id)
          : dists.filter((d) => links.some((l) => l.distribution_id === d.id && l.family_id === ownFamily));

      for (const name of pages) {
        await t.test(`${email}: ${name} is clean at all widths`, async () => {
          for (const width of WIDTHS) {
            problems.length = 0;
            await page.setViewportSize({ width, height: 900 });
            await page.goto(`${base}/pages/${name}.html`, { waitUntil: 'load' });
            await settled(page);
            assert.equal(await page.evaluate(() => document.body.scrollWidth > window.innerWidth + 1), false, `${name} overflows at ${width}px`);
            assert.equal(await page.locator('.skeleton').count(), 0, 'no stuck skeleton');
            assert.deepEqual(problems, [], `${name} @${width}: ${problems.join(' | ')}`);
          }
        });
      }

      if (pages.includes('displaced')) {
        await t.test(`${email}: displaced page 1 fetches one page and the count equals the database`, async () => {
          problems.length = 0;
          await page.setViewportSize({ width: 1440, height: 900 });
          const log = watchRequests(page);
          await page.goto(`${base}/pages/displaced.html`, { waitUntil: 'load' });
          await settled(page);
          assert.equal(await shownTotal(page), scopeMembers.length, 'total = database count');
          assert.equal(await shownRows(page), Math.min(PAGE_SIZE, scopeMembers.length), 'rows = one page');
          const lists = log.rpc.filter((r) => r.name === 'list_displaced_persons');
          assert.equal(lists.length, 1, 'one list request for page 1');
          assert.equal(lists[0].body.p_limit, PAGE_SIZE);
          assert.equal(lists[0].body.p_offset, 0);
          assert.deepEqual(log.wholeTable, [], 'no whole-table read of family_members');
          t.diagnostic(`${email} displaced page 1: ${log.rpc.length} list request(s), ${log.bytes} response bytes for ${scopeMembers.length} rows in scope`);
          assert.deepEqual(problems, [], problems.join(' | '));
        });

        await t.test(`${email}: pagination — page 2, last page, page beyond the end`, async () => {
          const total = scopeMembers.length;
          const pagesCount = Math.ceil(total / PAGE_SIZE);
          assert.ok(pagesCount >= 2, 'fixture sanity: more than one page in scope');
          await page.goto(`${base}/pages/displaced.html`, { waitUntil: 'load' });
          await settled(page);
          const firstNames = await page.locator('#results tbody tr').allInnerTexts();
          await page.locator('.pagination__btn[data-page="2"]').first().click();
          await waitForTotal(page, total);
          await page.waitForFunction(() => !document.querySelector('.skeleton'));
          assert.equal(await currentPageNumber(page), 2);
          assert.notDeepEqual(await page.locator('#results tbody tr').allInnerTexts(), firstNames, 'page 2 shows different rows');

          await page.goto(`${base}/pages/displaced.html?page=${pagesCount}`, { waitUntil: 'load' });
          await settled(page);
          assert.equal(await shownRows(page), total - (pagesCount - 1) * PAGE_SIZE, 'last page holds the remainder');

          await page.goto(`${base}/pages/displaced.html?page=999`, { waitUntil: 'load' });
          await settled(page);
          assert.equal(await currentPageNumber(page), pagesCount, 'a page beyond the end shows the last page');
          assert.equal(await shownRows(page), total - (pagesCount - 1) * PAGE_SIZE);
          assert.equal(await shownTotal(page), total);
        });

        await t.test(`${email}: filters and search change rows and total together; a filter on a later page returns to page 1`, async () => {
          const male = scopeMembers.filter((m) => m.gender === 'male').length;
          await page.goto(`${base}/pages/displaced.html?gender=male`, { waitUntil: 'load' });
          await settled(page);
          assert.equal(await shownTotal(page), male, 'gender filter');

          const child = scopeMembers.filter((m) => m.birth_date && ageAt(m.birth_date) < 18).length;
          await page.goto(`${base}/pages/displaced.html?isChild=yes`, { waitUntil: 'load' });
          await settled(page);
          assert.equal(await shownTotal(page), child, 'under-18 filter uses the database age');

          const sample = scopeMembers[0];
          await page.goto(`${base}/pages/displaced.html?page=2`, { waitUntil: 'load' });
          await settled(page);
          assert.equal(await currentPageNumber(page), 2);
          const search = page.locator('#toolbar-search');
          await search.fill(sample.national_id);
          await waitForTotal(page, scopeMembers.filter((m) => m.national_id.includes(sample.national_id)).length);
          assert.ok(!page.url().includes('page='), 'search on page 2 resets to page 1');
          assert.equal(await shownRows(page), 1);

          await search.fill('%');
          await waitForTotal(page, 0);
          assert.match(await page.locator('#results').innerText(), /لا توجد نتائج مطابقة/, 'literal % is not a wildcard; empty state rendered');
          await search.fill('');
          await waitForTotal(page, scopeMembers.length);

          if (profile.role === 'camp_admin') {
            const foreign = members.find((m) => m.camp_id !== profile.camp_id);
            await page.goto(`${base}/pages/displaced.html?q=${encodeURIComponent(foreign.national_id)}&campId=${foreign.camp_id}`, { waitUntil: 'load' });
            await settled(page);
            assert.equal(await shownTotal(page), 0, 'a hand-edited foreign campId/search cannot widen the list');
          }
        });

        await t.test(`${email}: the filter sheet's live preview is the database total`, async () => {
          await page.goto(`${base}/pages/displaced.html`, { waitUntil: 'load' });
          await settled(page);
          await page.locator('[data-open-filters]').first().click();
          await page.selectOption('.filter-sheet select[name="gender"]', 'female');
          const want = scopeMembers.filter((m) => m.gender === 'female').length;
          await page.waitForFunction((n) => document.querySelector('[data-preview]')?.textContent.includes(`ستظهر ${n} نتيجة`), want, { timeout: 10000 });
          await page.locator('[data-apply-filters]').click();
          await waitForTotal(page, want);
        });

        await t.test(`${email}: Excel export is the complete filtered set, not the visible page`, async () => {
          problems.length = 0;
          await page.goto(`${base}/pages/displaced.html`, { waitUntil: 'load' });
          await settled(page);
          assert.ok(scopeMembers.length > PAGE_SIZE);
          assert.equal(await exportRows(page), scopeMembers.length, 'unfiltered export = every row in scope');
          const male = scopeMembers.filter((m) => m.gender === 'male').length;
          await page.goto(`${base}/pages/displaced.html?gender=male`, { waitUntil: 'load' });
          await settled(page);
          assert.equal(await exportRows(page), male, 'filtered export = filtered total');
          await page.goto(`${base}/pages/displaced.html?q=zzzz-no-such-person`, { waitUntil: 'load' });
          await settled(page);
          assert.equal(await shownTotal(page), 0);
          assert.deepEqual(problems, [], problems.join(' | '));
        });

        await t.test(`${email}: an RPC failure shows the error state and Retry recovers; a slow stale response never wins`, async () => {
          let fail = true;
          await page.route('**/rest/v1/rpc/list_displaced_persons', (route) => (fail ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"boom"}' }) : route.continue()));
          const before = problems.length;
          await page.goto(`${base}/pages/displaced.html`, { waitUntil: 'load' });
          await page.waitForSelector('[data-retry]', { timeout: 15000 });
          fail = false;
          await page.locator('[data-retry]').click();
          await waitForTotal(page, scopeMembers.length);
          problems.splice(before); // the injected 500 / console error is the point of this test
          await page.unroute('**/rest/v1/rpc/list_displaced_persons');

          // Stale-response race: the search request for "zzzz-slow" is held back 1.5s while the cleared search returns at once.
          await page.route('**/rest/v1/rpc/list_displaced_persons', async (route) => {
            const body = JSON.parse(route.request().postData() || '{}');
            if (body.p_query === 'zzzz-slow') await new Promise((r) => setTimeout(r, 1500));
            await route.continue();
          });
          const search = page.locator('#toolbar-search');
          await search.fill('zzzz-slow');
          await page.waitForTimeout(400);
          await search.fill('');
          await waitForTotal(page, scopeMembers.length);
          await page.waitForTimeout(2000);
          assert.equal(await shownTotal(page), scopeMembers.length, 'the older, slower response did not overwrite the newer one');
          await page.unroute('**/rest/v1/rpc/list_displaced_persons');
        });
      }

      if (pages.includes('aid')) {
        await t.test(`${email}: aid page 1 fetches one page; count and summary cards equal the database`, async () => {
          problems.length = 0;
          await page.setViewportSize({ width: 1440, height: 900 });
          const log = watchRequests(page);
          await page.goto(`${base}/pages/aid.html`, { waitUntil: 'load' });
          await settled(page);
          assert.equal(await shownTotal(page), scopeDists.length, 'total = database count');
          const lists = log.rpc.filter((r) => r.name === 'list_aid_distributions');
          assert.equal(lists.length, 1, 'one list request for page 1');
          assert.equal(lists[0].body.p_limit, PAGE_SIZE);
          assert.deepEqual(log.wholeTable, [], 'no whole-table read of aid_distributions');
          const cards = await page.$$eval('.stat', (els) => els.map((e) => e.querySelector('.stat__label')?.textContent.trim() + '=' + e.querySelector('.stat__value')?.textContent.trim()));
          const shown = Object.fromEntries(cards.map((c) => c.split('=')));
          const ids = new Set(scopeDists.map((d) => d.id));
          const visibleLinks = links.filter((l) => ids.has(l.distribution_id) && (profile.role !== 'displaced' || l.family_id === ownFamily));
          assert.equal(digits(shown['عدد المساعدات']), scopeDists.length);
          assert.equal(digits(shown['الجهات المانحة']), new Set(scopeDists.map((d) => d.organization_id)).size);
          assert.equal(digits(shown['الأسر المستفيدة']), new Set(visibleLinks.map((l) => l.family_id)).size);
          assert.equal(digits(shown['أنواع المساعدات']), new Set(types.filter((x) => ids.has(x.distribution_id)).map((x) => x.aid_type.code)).size);
          t.diagnostic(`${email} aid page 1: ${log.rpc.length} list request(s), ${log.bytes} response bytes for ${scopeDists.length} rows in scope`);
          assert.deepEqual(problems, [], problems.join(' | '));
        });

        await t.test(`${email}: aid filters, search, pagination and export agree with the database`, async () => {
          problems.length = 0;
          const code = types.find((x) => scopeDists.some((d) => d.id === x.distribution_id)).aid_type.code;
          const ofType = scopeDists.filter((d) => types.some((x) => x.distribution_id === d.id && x.aid_type.code === code));
          await page.goto(`${base}/pages/aid.html?type=${code}`, { waitUntil: 'load' });
          await settled(page);
          assert.equal(await shownTotal(page), ofType.length, 'type filter');

          const org = scopeDists[0].organization_id;
          await page.goto(`${base}/pages/aid.html?organizationId=${org}`, { waitUntil: 'load' });
          await settled(page);
          assert.equal(await shownTotal(page), scopeDists.filter((d) => d.organization_id === org).length, 'donor filter');

          await page.goto(`${base}/pages/aid.html`, { waitUntil: 'load' });
          await settled(page);
          const search = page.locator('#toolbar-search');
          await search.fill('%');
          await waitForTotal(page, 0);
          await search.fill('');
          await waitForTotal(page, scopeDists.length);

          if (scopeDists.length > PAGE_SIZE) {
            await page.locator('.pagination__btn[data-page="2"]').first().click();
            await page.waitForFunction(() => !document.querySelector('.skeleton'));
            assert.equal(await currentPageNumber(page), 2);
            await page.goto(`${base}/pages/aid.html?page=999`, { waitUntil: 'load' });
            await settled(page);
            assert.equal(await currentPageNumber(page), Math.ceil(scopeDists.length / PAGE_SIZE), 'beyond the end shows the last page');
          }
          if (profile.role !== 'displaced') {
            await page.goto(`${base}/pages/aid.html`, { waitUntil: 'load' });
            await settled(page);
            assert.equal(await exportRows(page), scopeDists.length, 'export = complete unfiltered set');
            await page.goto(`${base}/pages/aid.html?type=${code}`, { waitUntil: 'load' });
            await settled(page);
            assert.equal(await exportRows(page), ofType.length, 'export = complete filtered set');
          } else {
            assert.equal(await page.locator('[data-export]').count(), 0, 'no export control for a displaced account');
          }
          assert.deepEqual(problems, [], problems.join(' | '));
        });
      }

      if (profile.role === 'displaced') {
        await t.test(`${email}: displaced.html is not reachable for a displaced account`, async () => {
          await page.goto(`${base}/pages/displaced.html`, { waitUntil: 'load' });
          await page.waitForTimeout(1500);
          assert.equal(await page.locator('#results .result-bar').count(), 0, 'no list rendered');
          assert.equal(await page.locator('.result-bar__count').count(), 0);
        });
      }
      await context.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
});

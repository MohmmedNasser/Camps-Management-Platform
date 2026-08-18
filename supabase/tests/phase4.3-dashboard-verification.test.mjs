// supabase/tests/phase4.3-dashboard-verification.test.mjs
/**
 * Phase 4.3 verification: every Camp Admin dashboard figure rendered in a
 * real browser is compared against an INDEPENDENT query against the same
 * live database (a second supabase-js client, never importing
 * assets/js/supabase/dashboard.js) — proves the UI shows real, camp-scoped
 * data. Runs against both active seeded Camp Admin accounts so the
 * comparison is meaningful for two different camps, not just one.
 * chart-aid is a Chart.js canvas, not text DOM — window.Chart.getChart()
 * reads its real underlying data without any markup change.
 *
 *   cd supabase && npm run frontend:config && npm run test:phase4.3-dashboard
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

async function waitForDashboardData(page) {
  await page.waitForSelector('.stat__label', { timeout: 15000 });
}

const ageInYears = (birthDate) => {
  if (!birthDate) return null;
  const dob = new Date(birthDate);
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const monthDiff = now.getMonth() - dob.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < dob.getDate())) age -= 1;
  return age;
};

async function directCampStats(client, campId) {
  const [{ data: families }, { data: members }, { data: aid }] = await Promise.all([
    client.from('families').select('id').eq('camp_id', campId),
    client.from('family_members').select('gender, chronic_diseases, disability, is_orphan, birth_date').eq('camp_id', campId),
    client.from('aid_distributions').select('organization_id').eq('camp_id', campId),
  ]);
  const { count: pendingRequests } = await client
    .from('registration_requests')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending')
    .eq('camp_id', campId);

  return {
    'إجمالي النازحين': members.length,
    'إجمالي الأسر': families.length,
    'الأطفال أقل من 18 عامًا': members.filter((m) => ageInYears(m.birth_date) !== null && ageInYears(m.birth_date) < 18).length,
    'الأيتام': members.filter((m) => m.is_orphan).length,
    'المساعدات الموزَّعة': aid.length,
    'ذوو الإعاقة': members.filter((m) => m.disability && m.disability.length > 0).length,
    'الأمراض المزمنة': members.filter((m) => m.chronic_diseases && m.chronic_diseases.length > 0).length,
    'طلبات التسجيل': pendingRequests ?? 0,
    donors: new Set(aid.map((row) => row.organization_id)).size,
    males: members.filter((m) => m.gender === 'male').length,
    females: members.filter((m) => m.gender === 'female').length,
  };
}

/** Independent aid-type breakdown: filters distributions by camp FIRST,
 *  then joins types — a different query shape than getAidTypeBreakdown()'s
 *  embed-filter approach, so this does not just re-run the code under test. */
async function directAidTypeBreakdown(client, campId) {
  const { data: types } = await client.from('aid_types').select('id, label_ar').eq('is_active', true);
  const { data: distributions } = await client.from('aid_distributions').select('id').eq('camp_id', campId);
  const distributionIds = distributions.map((d) => d.id);
  const counts = new Map();
  if (distributionIds.length > 0) {
    const { data: rows } = await client
      .from('aid_distribution_types')
      .select('aid_type_id')
      .in('distribution_id', distributionIds);
    rows.forEach((row) => counts.set(row.aid_type_id, (counts.get(row.aid_type_id) || 0) + 1));
  }
  const result = {};
  types.forEach((type) => {
    const count = counts.get(type.id) || 0;
    if (count > 0) result[type.label_ar] = count;
  });
  return result;
}

const digits = (text) => Number(String(text).replace(/[^\d.-]/g, ''));

async function readStatCards(page) {
  const cards = page.locator('.stat');
  const count = await cards.count();
  const result = {};
  for (let i = 0; i < count; i += 1) {
    const label = (await cards.nth(i).locator('.stat__label').innerText()).trim();
    const valueText = await cards.nth(i).locator('.stat__value').innerText();
    const metaEl = cards.nth(i).locator('.stat__meta');
    result[label] = { value: digits(valueText), meta: (await metaEl.count()) ? await metaEl.innerText() : '' };
  }
  return result;
}

async function readGenderLegend(page) {
  const items = page.locator('.chart-legend__item');
  const count = await items.count();
  const result = {};
  for (let i = 0; i < count; i += 1) {
    const text = await items.nth(i).innerText();
    const label = text.includes('ذكور') ? 'ذكور' : text.includes('إناث') ? 'إناث' : null;
    if (label) result[label] = digits(await items.nth(i).locator('.chart-legend__value').innerText());
  }
  return result;
}

/** Reads the live Chart.js instance's data — chart-aid is a canvas, not
 *  text DOM, so this is the only way to verify its real content without
 *  adding new markup. */
async function readAidTypeChart(page) {
  return page.evaluate(() => {
    const chart = window.Chart.getChart('chart-aid');
    if (!chart) return {};
    const result = {};
    chart.data.labels.forEach((label, i) => {
      result[label] = chart.data.datasets[0].data[i];
    });
    return result;
  });
}

const CAMP_ADMINS = ['admin@camps.ps', 'nour@camps.ps'];
const PASSWORD = '123456';

test('Phase 4.3 Camp Admin dashboard: rendered stats match the live database', async (t) => {
  const SUPABASE_URL = required('SUPABASE_URL');
  const SUPABASE_PUBLISHABLE_KEY = required('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY');

  const server = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();

  try {
    for (const email of CAMP_ADMINS) {
      const dbClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
      const { error: signInError } = await dbClient.auth.signInWithPassword({ email, password: PASSWORD });
      assert.equal(signInError, null, `${email} must be able to sign in`);
      const {
        data: { user },
      } = await dbClient.auth.getUser();
      const { data: ownProfile } = await dbClient.from('profiles').select('camp_id').eq('id', user.id).single();
      const campId = ownProfile.camp_id;

      await t.test(`${email}: stat cards, donor count and gender legend match direct DB counts`, async () => {
        const expected = await directCampStats(dbClient, campId);
        const page = await browser.newPage();
        await login(page, base, email, PASSWORD);
        await waitForDashboardData(page);

        const rendered = await readStatCards(page);
        for (const label of Object.keys(expected).filter((k) => !['donors', 'males', 'females'].includes(k))) {
          assert.ok(label in rendered, `stat card "${label}" must be rendered`);
          assert.equal(rendered[label].value, expected[label], `${email}: stat card "${label}" must equal the direct DB count`);
        }

        assert.equal(
          digits(rendered['المساعدات الموزَّعة'].meta),
          expected.donors,
          `${email}: donor count in aid card meta must equal distinct aid_distributions.organization_id for this camp`
        );

        const legend = await readGenderLegend(page);
        assert.equal(legend['ذكور'], expected.males, `${email}: gender legend male count must match`);
        assert.equal(legend['إناث'], expected.females, `${email}: gender legend female count must match`);

        await page.close();
      });

      await t.test(`${email}: aid-type chart matches direct DB counts`, async () => {
        const expected = await directAidTypeBreakdown(dbClient, campId);
        const page = await browser.newPage();
        await login(page, base, email, PASSWORD);
        await waitForDashboardData(page);
        await page.waitForFunction(() => window.Chart && window.Chart.getChart('chart-aid'), { timeout: 15000 });

        const rendered = await readAidTypeChart(page);
        assert.deepEqual(
          rendered,
          expected,
          `${email}: aid-type chart must match direct DB counts exactly, including which types appear`
        );

        await page.close();
      });

      await t.test(`${email}: dashboard has no horizontal overflow at 320/375/768/1024/1280/1440px`, async () => {
        const page = await browser.newPage();
        await login(page, base, email, PASSWORD);
        await waitForDashboardData(page);

        for (const width of [320, 375, 768, 1024, 1280, 1440]) {
          await page.setViewportSize({ width, height: 900 });
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth > document.documentElement.clientWidth
          );
          assert.equal(overflow, false, `${email}: no horizontal overflow at ${width}px`);
        }
        await page.close();
      });

      await dbClient.auth.signOut();
    }

    await t.test('no service_role or Cloudinary secret is ever transmitted', async () => {
      const page = await browser.newPage();
      const requestBodies = [];
      page.on('request', (req) => {
        requestBodies.push(req.url());
        const data = req.postData();
        if (data) requestBodies.push(data);
      });
      await login(page, base, 'admin@camps.ps', PASSWORD);
      await page.waitForTimeout(1000);

      const haystack = requestBodies.join('\n');
      assert.doesNotMatch(haystack, /service_role/i);
      if (process.env.CLOUDINARY_API_SECRET) {
        assert.doesNotMatch(haystack, new RegExp(process.env.CLOUDINARY_API_SECRET.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      }
      if (process.env.SUPABASE_SECRET_KEY) {
        assert.doesNotMatch(haystack, new RegExp(process.env.SUPABASE_SECRET_KEY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      }
      await page.close();
    });

    await t.test('console has no errors and no requests fail on the Camp Admin dashboard', async () => {
      const page = await browser.newPage();
      const consoleErrors = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });
      const failedRequests = [];
      page.on('requestfailed', (req) => failedRequests.push(req.url()));

      await login(page, base, 'nour@camps.ps', PASSWORD);
      await waitForDashboardData(page);

      assert.deepEqual(consoleErrors, [], 'no console errors on the Camp Admin dashboard');
      assert.deepEqual(failedRequests, [], 'no failed network requests on the Camp Admin dashboard');
      await page.close();
    });
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
});

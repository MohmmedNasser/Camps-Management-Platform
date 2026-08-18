// supabase/tests/phase4.2-dashboard-verification.test.mjs
/**
 * Phase 4.2 verification: every Super Admin dashboard figure rendered in
 * a real browser is compared against an INDEPENDENT query against the
 * same live database (a second supabase-js client, not
 * assets/js/supabase/dashboard.js) — this proves the UI shows real data,
 * not just that the new data-access module returns something. Reads by
 * text content (stat-card labels, legend labels, camp names) rather than
 * new markup hooks, so no rendering code changes were needed for this
 * test to exist.
 *
 *   cd supabase && npm run frontend:config && npm run test:phase4.2-dashboard
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

/**
 * Serves the repo AND replicates the clean-URL rewrite that `npx serve`,
 * Vercel, Netlify and GitHub Pages perform — same pattern as
 * phase4-auth-frontend.test.mjs.
 */
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

/**
 * The dashboard shows a skeleton first, then resolves the async Super
 * Admin composition (several sequential/parallel Supabase calls) before
 * the real stat cards replace it. `.count()`-based reads don't auto-wait
 * the way single-element Playwright locator methods do, so wait for a
 * real card explicitly rather than racing the fetch.
 */
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

/** Independent re-derivation of every stat — deliberately NOT importing
 *  assets/js/supabase/dashboard.js, so this proves the UI against the
 *  database rather than re-running the code under test. */
async function directDbStats(client) {
  const [{ data: camps }, { data: campAdmins }, { data: families }, { data: members }, { data: aid }] =
    await Promise.all([
      client.from('camps').select('id'),
      client.from('profiles').select('id').eq('role', 'camp_admin'),
      client.from('families').select('id'),
      client.from('family_members').select('gender, chronic_diseases, disability, is_orphan, birth_date'),
      client.from('aid_distributions').select('organization_id'),
    ]);

  const { count: pendingRequests } = await client
    .from('registration_requests')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending');

  return {
    'المخيمات': camps.length,
    'مسؤولو المخيمات': campAdmins.length,
    'إجمالي النازحين': members.length,
    'إجمالي الأسر': families.length,
    'الأطفال أقل من 18 عامًا': members.filter(
      (m) => ageInYears(m.birth_date) !== null && ageInYears(m.birth_date) < 18
    ).length,
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

const digits = (text) => Number(String(text).replace(/[^\d.-]/g, ''));

/** Reads every .stat card as { label -> { value, meta } }, keyed by the
 *  exact Arabic label text superAdminView() already renders. */
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

/** Reads the gender doughnut's legend as { 'ذكور'|'إناث' -> value }. */
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

test('Phase 4.2 Super Admin dashboard: rendered stats match the live database', async (t) => {
  const SUPABASE_URL = required('SUPABASE_URL');
  const SUPABASE_PUBLISHABLE_KEY = required('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY');

  const server = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();

  const dbClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
  const { error: signInError } = await dbClient.auth.signInWithPassword({
    email: 'super@camps.ps',
    password: '123456',
  });
  assert.equal(signInError, null, 'independent verification client must be able to sign in');

  try {
    const expected = await directDbStats(dbClient);

    await t.test('dashboard stat cards, donor count and gender legend match direct DB counts', async () => {
      const page = await browser.newPage();
      await login(page, base, 'super@camps.ps', '123456');
      await waitForDashboardData(page);

      const rendered = await readStatCards(page);
      for (const label of [
        'المخيمات',
        'مسؤولو المخيمات',
        'إجمالي النازحين',
        'إجمالي الأسر',
        'الأطفال أقل من 18 عامًا',
        'الأيتام',
        'المساعدات الموزَّعة',
        'ذوو الإعاقة',
        'الأمراض المزمنة',
        'طلبات التسجيل',
      ]) {
        assert.ok(label in rendered, `stat card "${label}" must be rendered`);
        assert.equal(rendered[label].value, expected[label], `stat card "${label}" must equal the direct DB count`);
      }

      // Donor count lives in the aid card's meta text ("N جهة مانحة"), not
      // its own card — matches the existing mock UI's placement.
      assert.equal(
        digits(rendered['المساعدات الموزَّعة'].meta),
        expected.donors,
        'donor count in aid card meta must equal distinct aid_distributions.organization_id'
      );

      const legend = await readGenderLegend(page);
      assert.equal(legend['ذكور'], expected.males, 'gender legend male count must match');
      assert.equal(legend['إناث'], expected.females, 'gender legend female count must match');

      await page.close();
    });

    await t.test('camps list row counts match per-camp direct DB counts', async () => {
      const page = await browser.newPage();
      await login(page, base, 'super@camps.ps', '123456');
      await waitForDashboardData(page);

      const { data: camps } = await dbClient.from('camps').select('id, name');
      assert.ok(camps.length > 0, 'seeded project must have at least one camp for this assertion to be meaningful');

      for (const camp of camps) {
        const { count: displacedCount } = await dbClient
          .from('family_members')
          .select('id', { count: 'exact', head: true })
          .eq('camp_id', camp.id);
        const { count: familiesCount } = await dbClient
          .from('families')
          .select('id', { count: 'exact', head: true })
          .eq('camp_id', camp.id);

        const row = page.locator('.list__row', { hasText: camp.name });
        const rowText = await row.innerText();
        assert.match(rowText, new RegExp(String(displacedCount)), `${camp.name}: displaced count must match`);
        assert.match(rowText, new RegExp(String(familiesCount)), `${camp.name}: families count must match`);
      }

      await page.close();
    });

    await t.test('no service_role or Cloudinary secret is ever transmitted', async () => {
      const page = await browser.newPage();
      const requestBodies = [];
      page.on('request', (req) => {
        requestBodies.push(req.url());
        const data = req.postData();
        if (data) requestBodies.push(data);
      });
      await login(page, base, 'super@camps.ps', '123456');
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
  } finally {
    await dbClient.auth.signOut();
    await browser.close();
    await new Promise((r) => server.close(r));
  }
});

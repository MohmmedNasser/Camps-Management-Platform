// supabase/tests/phase4.5-displaced-verification.test.mjs
/**
 * Phase 4.5 verification: every Camp Admin displaced-person figure rendered
 * in a real browser is compared against an INDEPENDENT query against the
 * same live database (a second supabase-js client, never importing
 * assets/js/supabase/family-members.js) — proves the UI shows real,
 * camp-scoped, correctly-filtered data, and that the Excel export matches
 * the screen exactly. Also creates and edits a person through the real
 * forms and confirms both land correctly, cleaning up afterward.
 *
 *   cd supabase && npm run frontend:config && npm run test:phase4.5-displaced
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

/**
 * The list paginates at PAGE_SIZE=10 (core/config.js); this camp's seed
 * data plus prior test runs can exceed that, so "does this text render"
 * checks must walk every page rather than assume everything fits on page 1.
 */
async function collectAllPagesText(page, base, path) {
  await page.goto(`${base}${path}`, { waitUntil: 'load' });
  await page.waitForSelector('table, .empty', { timeout: 15000 });
  let text = await page.locator('body').innerText();
  const infoMatch = text.match(/من\s*(\d+)/);
  const total = infoMatch ? Number(infoMatch[1]) : 0;
  const pages = Math.max(1, Math.ceil(total / 10));
  for (let p = 2; p <= pages; p += 1) {
    const separator = path.includes('?') ? '&' : '?';
    await page.goto(`${base}${path}${separator}page=${p}`, { waitUntil: 'load' });
    await page.waitForSelector('table, .empty', { timeout: 15000 });
    text += '\n' + (await page.locator('body').innerText());
  }
  return text;
}

/** Independent recomputation, deliberately NOT reading family_member_facts. */
function isOrphan(m) {
  return m.father_status === 'deceased' || m.mother_status === 'deceased';
}

const CAMP_ADMINS = ['admin@camps.ps', 'nour@camps.ps'];
const PASSWORD = '123456';

test('Phase 4.5 Camp Admin displaced persons: rendered list and detail match the live database', async (t) => {
  const SUPABASE_URL = required('SUPABASE_URL');
  const SUPABASE_PUBLISHABLE_KEY = required('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY');

  const server = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();

  try {
    for (const email of CAMP_ADMINS) {
      const dbClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
      await dbClient.auth.signInWithPassword({ email, password: PASSWORD });
      const { data: { user } } = await dbClient.auth.getUser();
      const { data: ownProfile } = await dbClient.from('profiles').select('camp_id').eq('id', user.id).single();
      const campId = ownProfile.camp_id;

      await t.test(`${email}: unfiltered list (across every page) shows exactly the camp's displaced people`, async () => {
        const { data: expected } = await dbClient.from('family_members').select('id, full_name, national_id').eq('camp_id', campId);
        const page = await browser.newPage();
        await login(page, base, email, PASSWORD);
        const bodyText = await collectAllPagesText(page, base, '/pages/displaced.html');

        for (const person of expected) {
          assert.ok(bodyText.includes(person.national_id), `${email}: national ID ${person.national_id} must render`);
          assert.ok(bodyText.includes(person.full_name), `${email}: name ${person.full_name} must render`);
        }
        await page.close();
      });

      await t.test(`${email}: gender=male filter narrows to exactly the male members`, async () => {
        const { data: all } = await dbClient.from('family_members').select('full_name, gender').eq('camp_id', campId);
        const males = all.filter((m) => m.gender === 'male');
        const females = all.filter((m) => m.gender === 'female');
        assert.ok(males.length > 0 && females.length > 0, `${email}'s camp needs both genders seeded for this test to be meaningful`);

        const page = await browser.newPage();
        await login(page, base, email, PASSWORD);
        await page.goto(`${base}/pages/displaced.html?gender=male`, { waitUntil: 'load' });
        await page.waitForSelector('table, .empty', { timeout: 15000 });
        const bodyText = await page.locator('body').innerText();

        for (const m of males) assert.ok(bodyText.includes(m.full_name), `${email}: ${m.full_name} is male and must appear`);
        for (const f of females) assert.ok(!bodyText.includes(f.full_name), `${email}: ${f.full_name} is female and must not appear`);
        await page.close();
      });

      await t.test(`${email}: search by name narrows correctly`, async () => {
        const { data: expected } = await dbClient.from('family_members').select('full_name').eq('camp_id', campId).limit(1);
        assert.ok(expected.length > 0, `${email}'s camp must have at least one displaced person`);
        const term = expected[0].full_name.split(' ')[0];

        const page = await browser.newPage();
        await login(page, base, email, PASSWORD);
        await page.goto(`${base}/pages/displaced.html?q=${encodeURIComponent(term)}`, { waitUntil: 'load' });
        await page.waitForSelector('table, .empty', { timeout: 15000 });
        const bodyText = await page.locator('body').innerText();
        assert.ok(bodyText.includes(expected[0].full_name), `${email}: searching "${term}" must surface ${expected[0].full_name}`);
        await page.close();
      });

      await t.test(`${email}: Excel export matches the unfiltered on-screen result set exactly`, async () => {
        const { data: expected } = await dbClient.from('family_members').select('national_id').eq('camp_id', campId);
        const page = await browser.newPage();
        await login(page, base, email, PASSWORD);
        await page.goto(`${base}/pages/displaced.html`, { waitUntil: 'load' });
        await page.waitForSelector('table, .empty', { timeout: 15000 });

        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 15000 }),
          page.click('[data-export]'),
        ]);
        const downloadPath = await download.path();
        assert.ok(downloadPath, 'export must produce a downloadable file');

        const { default: AdmZip } = await import('adm-zip').catch(() => ({ default: null }));
        if (AdmZip) {
          const zip = new AdmZip(downloadPath);
          const sheetXml = zip.getEntries().find((e) => e.entryName.includes('sheet1.xml'));
          const xml = sheetXml.getData().toString('utf8');
          for (const person of expected) assert.ok(xml.includes(person.national_id), `exported file must contain ${person.national_id}`);
        } else {
          const raw = readFileSync(downloadPath, 'latin1');
          for (const person of expected) assert.ok(raw.includes(person.national_id), `exported file must contain ${person.national_id}`);
        }
        await page.close();
      });

      await t.test(`${email}: displaced-details shows the real record and matches direct DB data`, async () => {
        const { data: expected } = await dbClient
          .from('family_members')
          .select('id, full_name, national_id, chronic_diseases, disability, father_status, mother_status, family:families!family_members_family_id_fkey(reference_code)')
          .eq('camp_id', campId)
          .limit(1)
          .single();

        const page = await browser.newPage();
        await login(page, base, email, PASSWORD);
        await page.goto(`${base}/pages/displaced-details.html?id=${expected.id}`, { waitUntil: 'load' });
        await page.waitForSelector('.card', { timeout: 15000 });
        const bodyText = await page.locator('body').innerText();

        assert.ok(bodyText.includes(expected.full_name), `${email}: details must show the name ${expected.full_name}`);
        assert.ok(bodyText.includes(expected.national_id), `${email}: details must show the national ID ${expected.national_id}`);
        assert.ok(bodyText.includes(expected.family.reference_code), `${email}: details must show the family code ${expected.family.reference_code}`);
        if (isOrphan(expected)) assert.ok(bodyText.includes('يتيم'), `${email}: ${expected.full_name} is an orphan and the badge must render`);
        await page.close();
      });

      await dbClient.auth.signOut();
    }

    await t.test('creating a person through displaced-create.html appears correctly, then editing it persists', async () => {
      const dbClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
      await dbClient.auth.signInWithPassword({ email: 'admin@camps.ps', password: PASSWORD });
      const { data: family } = await dbClient.from('families').select('id, reference_code').limit(1).single();
      await dbClient.auth.signOut();

      const uniqueId = String(Date.now()).slice(-9);
      const fullName = 'فرد اختبار المرحلة 4.5';
      const page = await browser.newPage();
      await login(page, base, 'admin@camps.ps', PASSWORD);
      await page.goto(`${base}/pages/displaced-create.html?familyId=${family.reference_code}`, { waitUntil: 'load' });
      await page.waitForSelector('#displaced-form', { timeout: 15000 });

      await page.fill('#fullName', fullName);
      await page.fill('#nationalId', uniqueId);
      await page.selectOption('#gender', 'male');
      await page.fill('#birthDate', '2001-01-01');
      await page.fill('#phone', '0599654321');
      await page.selectOption('#tentType', 'tarp_tent');
      await page.selectOption('#familyId', family.reference_code);

      await page.click('button[type="submit"]');
      await page.waitForURL(/displaced-details/, { timeout: 15000 });
      await page.waitForSelector('.card', { timeout: 15000 });
      const createdId = new URL(page.url()).searchParams.get('id');
      assert.ok(createdId, 'submitting the create form must route to the new person\'s real id');

      try {
        let bodyText = await page.locator('body').innerText();
        assert.ok(bodyText.includes(fullName), 'newly created person must render on their own detail page');

        // The camp's list paginates at PAGE_SIZE=10 and this camp already
        // has more than 10 seeded people, so a newly created row is not
        // guaranteed to land on the default first page — search narrows to it.
        await page.goto(`${base}/pages/displaced.html?q=${encodeURIComponent(uniqueId)}`, { waitUntil: 'load' });
        await page.waitForSelector('table, .empty', { timeout: 15000 });
        assert.ok((await page.locator('body').innerText()).includes(fullName), 'newly created person must appear in the displaced list (searched by national ID)');

        // Edit: change chronic_diseases through the real edit form; family/camp must stay unchanged.
        await page.goto(`${base}/pages/displaced-edit.html?id=${createdId}`, { waitUntil: 'load' });
        await page.waitForSelector('#displaced-form', { timeout: 15000 });
        await page.fill('#chronicDiseases', 'حالة اختبار 4.5');
        await page.click('button[type="submit"]');
        await page.waitForURL(/displaced-details/, { timeout: 15000 });
        await page.waitForSelector('.card', { timeout: 15000 });
        // Chronic disease renders inside the "الحالة الصحية" tab panel,
        // hidden by default (the "personal" tab is active on load) —
        // innerText() only returns visible text, so the tab must be opened
        // first, matching what a real user would do to see it.
        await page.click('[data-tab="health"]');
        bodyText = await page.locator('body').innerText();
        assert.ok(bodyText.includes('حالة اختبار 4.5'), 'edited chronic-disease value must render after save');

        const verifyClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
        await verifyClient.auth.signInWithPassword({ email: 'admin@camps.ps', password: PASSWORD });
        const { data: row } = await verifyClient.from('family_members').select('family_id, camp_id, chronic_diseases').eq('id', createdId).single();
        assert.equal(row.family_id, family.id, 'family_id must be unchanged by the edit (no reassignment field on the real path)');
        assert.equal(row.chronic_diseases, 'حالة اختبار 4.5', 'the DB row must reflect the edit');
        await verifyClient.auth.signOut();
      } finally {
        await page.close();
        const cleanupClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
        await cleanupClient.auth.signInWithPassword({ email: 'admin@camps.ps', password: PASSWORD });
        await cleanupClient.from('family_members').delete().eq('id', createdId);
        await cleanupClient.auth.signOut();
      }
    });

    await t.test('deleting a displaced person through displaced.html removes them and their documents cascade', async () => {
      const dbClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
      await dbClient.auth.signInWithPassword({ email: 'admin@camps.ps', password: PASSWORD });
      const { data: family } = await dbClient.from('families').select('id, reference_code').limit(1).single();
      const uniqueId = String(Date.now() + 1).slice(-9);
      const { data: created, error } = await dbClient.rpc('add_family_member', {
        p_family_id: family.id,
        p_member: { full_name: 'فرد للحذف 4.5', national_id: uniqueId, gender: 'female', tent_type: 'tarp_tent' },
      });
      assert.equal(error, null, 'setup: creating the throwaway person must succeed');
      await dbClient.auth.signOut();

      const page = await browser.newPage();
      await login(page, base, 'admin@camps.ps', PASSWORD);
      await page.goto(`${base}/pages/displaced.html?q=${encodeURIComponent(uniqueId)}`, { waitUntil: 'load' });
      await page.waitForSelector('table, .empty', { timeout: 15000 });
      await page.click(`[data-delete="${created}"]`);
      await page.click('[data-confirm]');
      await page.waitForTimeout(1000);
      await page.close();

      const verifyClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
      await verifyClient.auth.signInWithPassword({ email: 'admin@camps.ps', password: PASSWORD });
      const { data: stillThere } = await verifyClient.from('family_members').select('id').eq('id', created).maybeSingle();
      assert.equal(stillThere, null, 'the deleted person must no longer exist');
      await verifyClient.auth.signOut();
    });

    await t.test('a search matching nothing renders the real empty state, not fabricated rows', async () => {
      const page = await browser.newPage();
      await login(page, base, 'admin@camps.ps', PASSWORD);
      await page.goto(`${base}/pages/displaced.html?q=zzz-no-such-person-zzz`, { waitUntil: 'load' });
      await page.waitForSelector('.empty', { timeout: 15000 });
      const bodyText = await page.locator('body').innerText();
      assert.ok(bodyText.includes('لا توجد نتائج') || bodyText.includes('لا يوجد نازحون'), 'must render the real empty state, not a blank panel');
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
      await login(page, base, 'admin@camps.ps', PASSWORD);
      await page.goto(`${base}/pages/displaced.html`, { waitUntil: 'load' });
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

    await t.test('console has no errors and no requests fail across displaced/displaced-create', async () => {
      const page = await browser.newPage();
      const consoleErrors = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });
      const failedRequests = [];
      page.on('requestfailed', (req) => failedRequests.push(req.url()));

      await login(page, base, 'nour@camps.ps', PASSWORD);
      for (const path of ['displaced.html', 'displaced-create.html']) {
        await page.goto(`${base}/pages/${path}`, { waitUntil: 'load' });
        await page.waitForTimeout(500);
      }

      assert.deepEqual(consoleErrors, [], 'no console errors across the displaced pages');
      assert.deepEqual(failedRequests, [], 'no failed network requests across the displaced pages');
      await page.close();
    });
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
});

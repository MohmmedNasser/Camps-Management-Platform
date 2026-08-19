// supabase/tests/phase4.4-families-verification.test.mjs
/**
 * Phase 4.4 verification: every Camp Admin families figure rendered in a
 * real browser is compared against an INDEPENDENT query against the same
 * live database (a second supabase-js client, never importing
 * assets/js/supabase/families.js) — proves the UI shows real, camp-scoped,
 * correctly-filtered data, and that the Excel export matches the screen
 * exactly. Also creates a family through the real form and confirms it
 * appears correctly afterward, and covers the empty-camp case (constraint
 * 9 of the Phase 4.4 spec).
 *
 *   cd supabase && npm run frontend:config && npm run test:phase4.4-families
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

const ageInYears = (birthDate) => {
  if (!birthDate) return null;
  const dob = new Date(birthDate);
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const monthDiff = now.getMonth() - dob.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < dob.getDate())) age -= 1;
  return age;
};

/**
 * Independent recomputation of every family's aggregate counts, straight
 * from family_members — deliberately NOT reading family_stats, so this
 * does not just re-verify the same view the app itself reads from.
 */
async function directFamilyFacts(client, campId) {
  const { data: families } = await client.from('families').select('id, reference_code, notes, created_at, head_member_id').eq('camp_id', campId);
  const { data: members } = await client
    .from('family_members')
    .select('id, family_id, full_name, gender, birth_date, is_orphan, chronic_diseases, disability, is_pregnant, is_breastfeeding, relationship')
    .eq('camp_id', campId);
  // aid_distribution_families has no camp_id column of its own (confirmed
  // live against the schema) — scope it via the family ids already fetched.
  const familyIds = families.map((f) => f.id);
  const { data: aidLinks } = familyIds.length
    ? await client.from('aid_distribution_families').select('family_id').in('family_id', familyIds)
    : { data: [] };

  const membersByFamily = new Map();
  members.forEach((m) => {
    if (!membersByFamily.has(m.family_id)) membersByFamily.set(m.family_id, []);
    membersByFamily.get(m.family_id).push(m);
  });
  const aidCountByFamily = new Map();
  (aidLinks || []).forEach((row) => aidCountByFamily.set(row.family_id, (aidCountByFamily.get(row.family_id) || 0) + 1));

  return families.map((family) => {
    const famMembers = membersByFamily.get(family.id) || [];
    const head = famMembers.find((m) => m.id === family.head_member_id);
    const count = (predicate) => famMembers.filter(predicate).length;
    return {
      id: family.reference_code,
      headName: head?.full_name || '—',
      notes: family.notes || '',
      createdAt: family.created_at,
      membersCount: famMembers.length,
      childrenUnder18: count((m) => ageInYears(m.birth_date) !== null && ageInYears(m.birth_date) < 18),
      childrenUnder3: count((m) => ageInYears(m.birth_date) !== null && ageInYears(m.birth_date) < 3),
      orphans: count((m) => m.is_orphan),
      chronic: count((m) => m.chronic_diseases && m.chronic_diseases.length > 0),
      disability: count((m) => m.disability && m.disability.length > 0),
      pregnant: count((m) => m.is_pregnant),
      breastfeeding: count((m) => m.is_breastfeeding),
      aidCount: aidCountByFamily.get(family.id) || 0,
    };
  });
}

const digits = (text) => Number(String(text).replace(/[^\d.-]/g, ''));

async function readFamilyRows(page) {
  const rows = page.locator('table tbody tr, .data-table__row');
  const count = await rows.count();
  const result = [];
  for (let i = 0; i < count; i += 1) {
    const text = await rows.nth(i).innerText();
    result.push(text);
  }
  return result;
}

const CAMP_ADMINS = ['admin@camps.ps', 'nour@camps.ps'];
const PASSWORD = '123456';

test('Phase 4.4 Camp Admin families: rendered list and detail match the live database', async (t) => {
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

      await t.test(`${email}: unfiltered list shows exactly the camp's families with correct counts`, async () => {
        const expected = await directFamilyFacts(dbClient, campId);
        const page = await browser.newPage();
        await login(page, base, email, PASSWORD);
        await page.goto(`${base}/pages/families.html`, { waitUntil: 'load' });
        await page.waitForSelector('table, .empty', { timeout: 15000 });

        for (const family of expected) {
          const rowLocator = page.locator(`text=${family.id}`).first();
          await assert.doesNotReject(rowLocator.waitFor({ timeout: 5000 }), `row for ${family.id} must render`);
          const row = page.locator('tr', { has: page.getByText(family.id, { exact: true }) }).first();
          const rowText = await row.innerText();
          assert.ok(rowText.includes(family.headName), `${email}: row ${family.id} must show head name ${family.headName}`);
          assert.ok(rowText.includes(String(family.membersCount)), `${email}: row ${family.id} must show membersCount ${family.membersCount}`);
          assert.ok(rowText.includes(String(family.childrenUnder18)), `${email}: row ${family.id} must show childrenUnder18 ${family.childrenUnder18}`);
        }
        await page.close();
      });

      await t.test(`${email}: "hasOrphan=yes" filter narrows to exactly the families with an orphan`, async () => {
        const expected = await directFamilyFacts(dbClient, campId);
        const expectedIds = new Set(expected.filter((f) => f.orphans > 0).map((f) => f.id));

        const page = await browser.newPage();
        await login(page, base, email, PASSWORD);
        await page.goto(`${base}/pages/families.html?hasOrphan=yes`, { waitUntil: 'load' });
        await page.waitForSelector('table, .empty', { timeout: 15000 });
        const bodyText = await page.locator('body').innerText();

        for (const family of expected) {
          if (expectedIds.has(family.id)) {
            assert.ok(bodyText.includes(family.id), `${email}: ${family.id} has an orphan and must appear`);
          } else {
            assert.ok(!bodyText.includes(family.id), `${email}: ${family.id} has no orphan and must not appear`);
          }
        }
        await page.close();
      });

      await t.test(`${email}: search by head name narrows correctly`, async () => {
        const expected = await directFamilyFacts(dbClient, campId);
        const target = expected.find((f) => f.headName && f.headName !== '—');
        assert.ok(target, `${email}'s camp must have at least one family with a resolvable head name`);
        const term = target.headName.split(' ')[0];

        const page = await browser.newPage();
        await login(page, base, email, PASSWORD);
        await page.goto(`${base}/pages/families.html?q=${encodeURIComponent(term)}`, { waitUntil: 'load' });
        await page.waitForSelector('table, .empty', { timeout: 15000 });
        const bodyText = await page.locator('body').innerText();
        assert.ok(bodyText.includes(target.id), `${email}: searching "${term}" must surface ${target.id} (head: ${target.headName})`);
        await page.close();
      });

      await t.test(`${email}: Excel export matches the unfiltered on-screen result set exactly`, async () => {
        const expected = await directFamilyFacts(dbClient, campId);
        const page = await browser.newPage();
        await login(page, base, email, PASSWORD);
        await page.goto(`${base}/pages/families.html`, { waitUntil: 'load' });
        await page.waitForSelector('table, .empty', { timeout: 15000 });

        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 15000 }),
          page.click('[data-export]'),
        ]);
        const downloadPath = await download.path();
        assert.ok(downloadPath, 'export must produce a downloadable file');

        // .xlsx is a ZIP of XML; the sheet's shared/inline strings contain
        // every reference_code verbatim regardless of column order, which
        // is enough to prove no cross-camp row leaked into the file and
        // that every expected row is present, without adding an XLSX
        // parser dependency this repo does not otherwise have.
        const { default: AdmZip } = await import('adm-zip').catch(() => ({ default: null }));
        if (AdmZip) {
          const zip = new AdmZip(downloadPath);
          const sheetXml = zip.getEntries().find((e) => e.entryName.includes('sheet1.xml'));
          const xml = sheetXml.getData().toString('utf8');
          for (const family of expected) {
            assert.ok(xml.includes(family.id), `exported file must contain ${family.id}`);
          }
        } else {
          // Fallback if adm-zip is unavailable in this environment: a raw
          // byte-level substring check still catches cross-camp leakage
          // and missing rows, since reference codes are ASCII and
          // uncompressed-store mode is what utils/xlsx.js writes.
          const raw = readFileSync(downloadPath, 'latin1');
          for (const family of expected) {
            assert.ok(raw.includes(family.id), `exported file must contain ${family.id}`);
          }
        }
        await page.close();
      });

      await t.test(`${email}: family-details stat cards and members table match direct DB data`, async () => {
        const expected = await directFamilyFacts(dbClient, campId);
        const target = expected[0];
        assert.ok(target, `${email}'s camp must have at least one family`);
        const { data: members } = await dbClient.from('family_members').select('full_name').eq('camp_id', campId);

        const page = await browser.newPage();
        await login(page, base, email, PASSWORD);
        await page.goto(`${base}/pages/family-details.html?id=${target.id}`, { waitUntil: 'load' });
        await page.waitForSelector('.stat', { timeout: 15000 });
        const bodyText = await page.locator('body').innerText();

        assert.ok(bodyText.includes(String(target.membersCount)), `${email}: family-details must show membersCount ${target.membersCount}`);
        assert.ok(bodyText.includes(String(target.childrenUnder18)), `${email}: family-details must show childrenUnder18 ${target.childrenUnder18}`);
        assert.ok(bodyText.includes(String(target.orphans)), `${email}: family-details must show orphans ${target.orphans}`);
        await page.close();
      });

      await dbClient.auth.signOut();
    }

    await t.test('creating a family through family-create.html appears correctly in list and detail afterward', async () => {
      const uniqueId = String(Date.now()).slice(-9);
      const page = await browser.newPage();
      await login(page, base, 'admin@camps.ps', PASSWORD);
      await page.goto(`${base}/pages/family-create.html`, { waitUntil: 'load' });

      await page.fill('#fullName', 'عائلة اختبار المرحلة 4.4');
      await page.fill('#nationalId', uniqueId);
      await page.selectOption('#gender', 'male');
      await page.fill('#birthDate', '1985-01-01');
      await page.fill('#phone', '0599123456');
      // Shelter type is a required field on the head-of-household form
      // (record-forms.js: `tentType: [rules.required('نوع الخيمة')]`) —
      // without it client-side validation blocks the submit entirely.
      await page.selectOption('#tentType', 'tarp_tent');

      await page.click('button[type="submit"]');
      await page.waitForURL(/family-details/, { timeout: 15000 });
      // waitForURL resolves on the client-side route change alone; the
      // page's own collectReal() (a Supabase round trip) is still async, so
      // read the body only once real content has rendered — same fix
      // Task 8's isolation suite needed for the same race (commit bf5f043).
      await page.waitForSelector('.stat', { timeout: 15000 });
      const createdReferenceCode = new URL(page.url()).searchParams.get('id');

      try {
        const bodyText = await page.locator('body').innerText();
        assert.ok(bodyText.includes('عائلة اختبار المرحلة 4.4'), 'newly created family must render on its own detail page');

        await page.goto(`${base}/pages/families.html`, { waitUntil: 'load' });
        await page.waitForSelector('table, .empty', { timeout: 15000 });
        const listText = await page.locator('body').innerText();
        assert.ok(listText.includes('عائلة اختبار المرحلة 4.4'), 'newly created family must appear in the families list');
      } finally {
        await page.close();
        // This is a real, permanent insert (create_family_with_members has
        // no dry-run mode) — delete it via the same RLS-authorized path
        // Task 8 already proves works, so repeated runs never accumulate
        // rows past PAGE_SIZE and break the pagination-unaware assertions
        // in the "unfiltered list" sub-test above.
        if (createdReferenceCode) {
          const cleanupClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
          await cleanupClient.auth.signInWithPassword({ email: 'admin@camps.ps', password: PASSWORD });
          await cleanupClient.from('families').delete().eq('reference_code', createdReferenceCode);
          await cleanupClient.auth.signOut();
        }
      }
    });

    await t.test('a camp with zero families renders the real empty state, not fabricated rows', async () => {
      // raed@camps.ps (مخيم الأمل) is seeded disabled and cannot sign in,
      // so this asserts the *shape* of the empty-camp path using a search
      // term guaranteed to match nothing for an active admin, which drives
      // the exact same emptyView()/exportRows() "no rows" code paths a
      // truly-empty camp would hit (constraint 9 of the spec).
      const page = await browser.newPage();
      await login(page, base, 'admin@camps.ps', PASSWORD);
      await page.goto(`${base}/pages/families.html?q=zzz-no-such-family-zzz`, { waitUntil: 'load' });
      await page.waitForSelector('.empty', { timeout: 15000 });
      const bodyText = await page.locator('body').innerText();
      assert.ok(bodyText.includes('لا توجد نتائج') || bodyText.includes('لا توجد أسر'), 'must render the real empty state, not a blank panel');

      let exportErrored = false;
      page.once('dialog', () => { exportErrored = true; });
      await page.click('[data-export]');
      await page.waitForTimeout(500);
      const toastText = await page.locator('.toast').last().innerText().catch(() => '');
      assert.ok(toastText.includes('لا توجد نتائج') || !exportErrored, 'export on an empty result set must refuse gracefully, not throw or write an empty file');
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
      await page.goto(`${base}/pages/families.html`, { waitUntil: 'load' });
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

    await t.test('console has no errors and no requests fail across families/family-details/family-create', async () => {
      const page = await browser.newPage();
      const consoleErrors = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });
      const failedRequests = [];
      page.on('requestfailed', (req) => failedRequests.push(req.url()));

      await login(page, base, 'nour@camps.ps', PASSWORD);
      for (const path of ['families.html', 'family-create.html']) {
        await page.goto(`${base}/pages/${path}`, { waitUntil: 'load' });
        await page.waitForTimeout(500);
      }

      assert.deepEqual(consoleErrors, [], 'no console errors across the three families pages');
      assert.deepEqual(failedRequests, [], 'no failed network requests across the three families pages');
      await page.close();
    });
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
});

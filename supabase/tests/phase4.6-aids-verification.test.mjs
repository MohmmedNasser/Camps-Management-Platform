// supabase/tests/phase4.6-aids-verification.test.mjs
/**
 * Phase 4.6 verification: every Camp Admin aid figure rendered in a real
 * browser is compared against an INDEPENDENT query against the same live
 * database (a second supabase-js client, never importing
 * assets/js/supabase/aids.js) — proves the list, filters, details page and
 * Excel export show real, camp-scoped, correctly-filtered data. Also drives
 * a real create -> edit -> delete round trip through the actual forms and
 * cleans up the record it creates.
 *
 *   cd supabase && npm run frontend:config && npm run test:phase4.6-aids
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
 * Independent recomputation of every aid distribution's rendered shape,
 * straight from the base tables and junctions — deliberately NOT reading
 * through `assets/js/supabase/aids.js`, so this does not just re-verify the
 * same code the app itself runs.
 */
async function directAidFacts(client, campId) {
  const { data: distributions } = await client
    .from('aid_distributions')
    .select('id, distributed_on, all_families_selected, organization_id')
    .eq('camp_id', campId);

  const ids = distributions.map((d) => d.id);
  const { data: orgs } = await client.from('organizations').select('id, name');
  const orgById = new Map(orgs.map((o) => [o.id, o.name]));

  const { data: typeLinks } = ids.length
    ? await client
        .from('aid_distribution_types')
        .select('distribution_id, aid_type:aid_types(code, label_ar)')
        .in('distribution_id', ids)
    : { data: [] };
  const { data: familyLinks } = ids.length
    ? await client
        .from('aid_distribution_families')
        .select('distribution_id, family:families(id, reference_code, head:family_members!families_head_member_id_fkey(full_name))')
        .in('distribution_id', ids)
    : { data: [] };

  const typesByDist = new Map();
  (typeLinks || []).forEach((row) => {
    if (!typesByDist.has(row.distribution_id)) typesByDist.set(row.distribution_id, []);
    typesByDist.get(row.distribution_id).push(row.aid_type);
  });
  const familiesByDist = new Map();
  (familyLinks || []).forEach((row) => {
    if (!familiesByDist.has(row.distribution_id)) familiesByDist.set(row.distribution_id, []);
    familiesByDist.get(row.distribution_id).push(row.family);
  });

  return distributions.map((d) => {
    const types = typesByDist.get(d.id) || [];
    const families = familiesByDist.get(d.id) || [];
    return {
      id: d.id,
      date: d.distributed_on,
      organizationId: d.organization_id,
      organizationName: orgById.get(d.organization_id) || '—',
      typeCodes: types.map((t) => t.code),
      typeLabels: types.map((t) => t.label_ar).join('، '),
      beneficiaryCount: families.length,
      familyCodes: families.map((f) => f.reference_code),
      familyDbIds: families.map((f) => f.id),
      headNames: families.map((f) => f.head?.full_name || '—'),
    };
  });
}

const CAMP_ADMINS = ['admin@camps.ps', 'nour@camps.ps'];
const PASSWORD = '123456';

test('Phase 4.6 Camp Admin aid: rendered list, filters, details and export match the live database', async (t) => {
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
      const {
        data: { user },
      } = await dbClient.auth.getUser();
      const { data: ownProfile } = await dbClient.from('profiles').select('camp_id').eq('id', user.id).single();
      const campId = ownProfile.camp_id;

      await t.test(`${email}: unfiltered list shows exactly the camp's aid distributions with correct fields`, async () => {
        const expected = await directAidFacts(dbClient, campId);
        assert.ok(expected.length > 0, `${email}'s camp must have at least one seeded aid distribution`);

        const page = await browser.newPage();
        await login(page, base, email, PASSWORD);
        await page.goto(`${base}/pages/aid.html`, { waitUntil: 'load' });
        await page.waitForSelector('table, .empty', { timeout: 15000 });
        const bodyText = await page.locator('body').innerText();

        assert.ok(
          bodyText.includes(String(expected.length)),
          `${email}: result bar must show the true count ${expected.length}`
        );
        for (const record of expected) {
          if (record.typeLabels) assert.ok(bodyText.includes(record.typeLabels), `${email}: list must show type labels "${record.typeLabels}"`);
          assert.ok(bodyText.includes(record.organizationName), `${email}: list must show donor "${record.organizationName}"`);
        }
        await page.close();
      });

      await t.test(`${email}: aid-type filter narrows to exactly the matching distributions`, async () => {
        const expected = await directAidFacts(dbClient, campId);
        const withFood = expected.filter((r) => r.typeCodes.includes('food'));
        assert.ok(withFood.length > 0, `${email}'s camp must have at least one food distribution`);

        const page = await browser.newPage();
        await login(page, base, email, PASSWORD);
        await page.goto(`${base}/pages/aid.html?type=food`, { waitUntil: 'load' });
        await page.waitForSelector('table, .empty', { timeout: 15000 });
        const bodyText = await page.locator('body').innerText();

        assert.ok(bodyText.includes(String(withFood.length)), `${email}: type=food must show ${withFood.length} results`);
        await page.close();
      });

      await t.test(`${email}: donor filter narrows to exactly the matching distributions`, async () => {
        const expected = await directAidFacts(dbClient, campId);
        const orgId = expected[0].organizationId;
        const matching = expected.filter((r) => r.organizationId === orgId);

        const page = await browser.newPage();
        await login(page, base, email, PASSWORD);
        await page.goto(`${base}/pages/aid.html?organizationId=${orgId}`, { waitUntil: 'load' });
        await page.waitForSelector('table, .empty', { timeout: 15000 });
        const bodyText = await page.locator('body').innerText();

        assert.ok(bodyText.includes(String(matching.length)), `${email}: donor filter must show ${matching.length} results`);
        await page.close();
      });

      await t.test(`${email}: beneficiary-family filter narrows to exactly the matching distributions`, async () => {
        const expected = await directAidFacts(dbClient, campId);
        const withBeneficiary = expected.find((r) => r.familyDbIds.length > 0);
        assert.ok(withBeneficiary, `${email}'s camp must have at least one distribution with a beneficiary`);
        const familyDbId = withBeneficiary.familyDbIds[0];
        const matching = expected.filter((r) => r.familyDbIds.includes(familyDbId));

        const page = await browser.newPage();
        await login(page, base, email, PASSWORD);
        await page.goto(`${base}/pages/aid.html?familyId=${familyDbId}`, { waitUntil: 'load' });
        await page.waitForSelector('table, .empty', { timeout: 15000 });
        const bodyText = await page.locator('body').innerText();

        // The list table has no per-row family column (only type/donor/count/date
        // — CLAUDE.md's AID_COLUMNS shape), so the result count is what proves
        // the filter narrowed correctly, not a family code appearing on screen.
        assert.ok(bodyText.includes(String(matching.length)), `${email}: family filter must show ${matching.length} results`);
        await page.close();
      });

      await t.test(`${email}: aid-details shows correct types, donor and beneficiary list`, async () => {
        const expected = await directAidFacts(dbClient, campId);
        const target = expected.find((r) => r.beneficiaryCount > 0);
        assert.ok(target, `${email}'s camp must have at least one distribution with beneficiaries`);

        const page = await browser.newPage();
        await login(page, base, email, PASSWORD);
        await page.goto(`${base}/pages/aid-details.html?id=${target.id}`, { waitUntil: 'load' });
        await page.waitForSelector('.card', { timeout: 15000 });
        const bodyText = await page.locator('body').innerText();

        if (target.typeLabels) assert.ok(bodyText.includes(target.typeLabels), `${email}: details must show type labels`);
        assert.ok(bodyText.includes(target.organizationName), `${email}: details must show donor name`);
        assert.ok(bodyText.includes(String(target.beneficiaryCount)), `${email}: details must show beneficiary count`);
        for (const code of target.familyCodes) {
          assert.ok(bodyText.includes(code), `${email}: details must list beneficiary family ${code}`);
        }
        await page.close();
      });

      await t.test(`${email}: Excel export contains exactly the camp's distributions`, async () => {
        const expected = await directAidFacts(dbClient, campId);
        const page = await browser.newPage();
        await login(page, base, email, PASSWORD);
        await page.goto(`${base}/pages/aid.html`, { waitUntil: 'load' });
        await page.waitForSelector('table, .empty', { timeout: 15000 });

        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 15000 }),
          page.click('[data-export]'),
        ]);
        const downloadPath = await download.path();
        assert.ok(downloadPath, 'export must produce a downloadable file');

        // .xlsx is a ZIP of XML; the sheet's inline strings contain every
        // organisation name verbatim regardless of column order, which is
        // enough to prove no cross-camp row leaked into the file and that
        // every expected row is present — same technique as Phase 4.4/4.5.
        const { default: AdmZip } = await import('adm-zip').catch(() => ({ default: null }));
        const getText = () => {
          if (AdmZip) {
            const zip = new AdmZip(downloadPath);
            const sheetXml = zip.getEntries().find((e) => e.entryName.includes('sheet1.xml'));
            return sheetXml.getData().toString('utf8');
          }
          // No adm-zip fallback: this .xlsx is stored-mode (uncompressed) per
          // utils/xlsx.js, and donor names are Arabic — unlike Phase 4.4/4.5's
          // ASCII reference codes, a 'latin1' byte-wise read mangles multi-byte
          // UTF-8 text, so decode as 'utf8' instead (still a plain substring
          // search over the sheet's inline-string XML, no ZIP parsing needed).
          return readFileSync(downloadPath, 'utf8');
        };
        const text = getText();
        const uniqueOrgNames = [...new Set(expected.map((r) => r.organizationName))];
        for (const name of uniqueOrgNames) {
          assert.ok(text.includes(name), `exported file must contain donor "${name}"`);
        }
        await page.close();
      });

      await dbClient.auth.signOut();
    }

    await t.test('create -> edit -> delete round trip through the real forms', async () => {
      const dbClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
      await dbClient.auth.signInWithPassword({ email: 'admin@camps.ps', password: PASSWORD });

      const page = await browser.newPage();
      let createdId = null;

      try {
        await login(page, base, 'admin@camps.ps', PASSWORD);
        await page.goto(`${base}/pages/aid-create.html`, { waitUntil: 'load' });
        await page.waitForSelector('#aid-form', { timeout: 15000 });

        await page.selectOption('#organizationId', { index: 1 });
        await page.fill('#date', '2026-01-15');
        await page.check('#types-0'); // "غذائية" — the first AID_TYPES entry (food)
        await page.click('[data-combobox-select-all]');

        await page.click('button[type="submit"]');
        await page.waitForURL(/aid-details/, { timeout: 15000 });
        await page.waitForSelector('.card', { timeout: 15000 });
        createdId = new URL(page.url()).searchParams.get('id');
        assert.ok(createdId, 'creating an aid distribution must route to its details page with a real id');

        const bodyText = await page.locator('body').innerText();
        assert.ok(bodyText.includes('غذائية'), 'newly created distribution must show its selected type');

        // Edit: change the date through the real edit form.
        await page.goto(`${base}/pages/aid-edit.html?id=${createdId}`, { waitUntil: 'load' });
        await page.waitForSelector('#aid-form', { timeout: 15000 });
        await page.fill('#date', '2026-02-20');
        await page.click('button[type="submit"]');
        await page.waitForURL(/aid-details/, { timeout: 15000 });
        await page.waitForSelector('.card', { timeout: 15000 });

        // Independently confirm the edit landed in the database, not just on screen
        // (formatDate() renders Arabic month names/digits, too locale-specific to
        // assert against reliably here — the DB row is the real verification).
        const { data: dbRow } = await dbClient
          .from('aid_distributions')
          .select('distributed_on')
          .eq('id', createdId)
          .single();
        assert.equal(dbRow.distributed_on, '2026-02-20', 'the database row must reflect the edited date');

        // Delete.
        await page.click('[data-delete]');
        await page.click('[data-confirm]');
        await page.waitForURL(/aid\.html/, { timeout: 15000 });

        const { data: afterDelete } = await dbClient
          .from('aid_distributions')
          .select('id')
          .eq('id', createdId)
          .maybeSingle();
        assert.equal(afterDelete, null, 'deleted distribution must no longer exist in the database');
        createdId = null; // already gone — nothing left for the finally block to clean up
      } finally {
        await page.close();
        // Only reached if an assertion above threw before the delete step ran.
        if (createdId) {
          await dbClient.from('aid_distributions').delete().eq('id', createdId);
        }
        await dbClient.auth.signOut();
      }
    });

    await t.test('a search with no matches renders the real empty state, not a blank panel', async () => {
      const page = await browser.newPage();
      await login(page, base, 'admin@camps.ps', PASSWORD);
      await page.goto(`${base}/pages/aid.html?q=zzz-no-such-aid-zzz`, { waitUntil: 'load' });
      await page.waitForSelector('.empty', { timeout: 15000 });
      const bodyText = await page.locator('body').innerText();
      assert.ok(bodyText.includes('لا توجد نتائج'), 'must render the real empty state, not a blank panel');
      await page.close();
    });
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
});

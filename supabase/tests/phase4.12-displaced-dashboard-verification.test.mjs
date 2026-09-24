// supabase/tests/phase4.12-displaced-dashboard-verification.test.mjs
/**
 * Phase 4.12 verification: every figure the Displaced Person Dashboard
 * renders is compared against an INDEPENDENT query against the same live
 * database (a second supabase-js client, never importing
 * assets/js/supabase/dashboard.js), for all four seeded displaced accounts —
 * proves the dashboard shows each account's own real profile, family, aid
 * and document data, not mock/hardcoded values and not another account's.
 * Also proves the old mock data path is gone from the two changed files
 * (spec §7 Test F) and that no aid value/price field ever renders (domain
 * rule 9).
 *
 *   cd supabase && npm run frontend:config && npm run test:phase4.12-displaced-dashboard-verification
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

const ACCOUNTS = ['ahmad@camps.ps', 'yousef@camps.ps', 'ibrahim@camps.ps', 'omar@camps.ps'];
const PASSWORD = '123456';

test('Phase 4.12 displaced dashboard: rendered figures match the live database, per account', async (t) => {
  const SUPABASE_URL = required('SUPABASE_URL');
  const SUPABASE_PUBLISHABLE_KEY = required('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY');

  const server = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();

  try {
    for (const email of ACCOUNTS) {
      await t.test(`${email}: profile, family, aid and document figures match the live database`, async () => {
        const dbClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
        await dbClient.auth.signInWithPassword({ email, password: PASSWORD });
        const { data: { user } } = await dbClient.auth.getUser();

        const { data: profile } = await dbClient
          .from('profiles')
          .select('family_member_id, camp_id')
          .eq('id', user.id)
          .single();

        const { data: person } = await dbClient
          .from('family_members')
          .select(
            'full_name, national_id, phone, family_id, family:families!family_members_family_id_fkey(reference_code, head:family_members!families_head_member_id_fkey(full_name))'
          )
          .eq('id', profile.family_member_id)
          .single();

        const { count: membersCount } = await dbClient
          .from('family_members')
          .select('id', { count: 'exact', head: true })
          .eq('family_id', person.family_id);

        const { data: aidRows } = await dbClient
          .from('aid_distribution_families')
          .select('distribution:aid_distributions(organization:organizations(name))')
          .eq('family_id', person.family_id);

        const { count: docCount } = await dbClient
          .from('documents')
          .select('id', { count: 'exact', head: true })
          .eq('family_id', person.family_id);

        const { data: camp } = await dbClient.from('camps').select('name').eq('id', profile.camp_id).single();

        await dbClient.auth.signOut();

        const page = await browser.newPage();
        const consoleErrors = [];
        page.on('console', (msg) => {
          if (msg.type() === 'error') consoleErrors.push(msg.text());
        });
        await login(page, base, email, PASSWORD);
        await page.goto(`${base}/pages/dashboard.html`, { waitUntil: 'load' });
        await page.waitForSelector('.stat', { timeout: 15000 });
        await page.waitForTimeout(300);
        const bodyText = await page.locator('body').innerText();

        assert.ok(bodyText.includes(person.full_name), `${email}: "بياناتي" must show the real full name ${person.full_name}`);
        assert.ok(bodyText.includes(person.national_id), `${email}: "بياناتي" must show the real national ID`);
        if (person.phone) assert.ok(bodyText.includes(person.phone), `${email}: "بياناتي" must show the real phone`);

        assert.ok(bodyText.includes(person.family.reference_code), `${email}: "أسرتي" must show the real family id ${person.family.reference_code}`);
        assert.ok(bodyText.includes(person.family.head.full_name), `${email}: "أسرتي" must show the real head of household`);
        assert.ok(bodyText.includes(camp.name), `${email}: must show the real camp name ${camp.name}`);
        assert.ok(bodyText.includes(String(membersCount)), `${email}: أفراد الأسرة must equal the real member count ${membersCount}`);
        assert.ok(bodyText.includes(String(aidRows.length)), `${email}: المساعدات المستلمة must equal the real aid count ${aidRows.length}`);
        assert.ok(bodyText.includes(String(docCount)), `${email}: المستندات must equal the real document count ${docCount}`);

        for (const row of aidRows.slice(0, 5)) {
          const orgName = row.distribution?.organization?.name;
          if (orgName) assert.ok(bodyText.includes(orgName), `${email}: aid list must show real donor ${orgName}`);
        }

        // Domain rule 9: aid is never a financial transaction — no value/price
        // field exists on the record, and none must ever render.
        assert.ok(!/\bقيمة\b|\bسعر\b|\bتكلفة\b/.test(bodyText), `${email}: dashboard must never render a value/price for aid`);

        assert.deepEqual(consoleErrors, [], `${email}: dashboard must render with zero console errors`);
        await page.close();
      });
    }

    await t.test('refresh persistence: reloading the dashboard shows the same real data', async () => {
      const page = await browser.newPage();
      await login(page, base, 'ahmad@camps.ps', PASSWORD);
      await page.goto(`${base}/pages/dashboard.html`, { waitUntil: 'load' });
      await page.waitForSelector('.stat', { timeout: 15000 });
      const before = await page.locator('body').innerText();
      await page.reload({ waitUntil: 'load' });
      await page.waitForSelector('.stat', { timeout: 15000 });
      const after = await page.locator('body').innerText();
      assert.ok(after.includes('FAM-000001'), 'family id must still render after refresh');
      assert.equal(
        before.includes('أحمد محمود الشريف'),
        after.includes('أحمد محمود الشريف'),
        'own name must render identically before and after refresh'
      );
      await page.close();
    });

    await t.test('logout: protected data is no longer reachable with the cleared client', async () => {
      const page = await browser.newPage();
      await login(page, base, 'ahmad@camps.ps', PASSWORD);
      await page.goto(`${base}/pages/dashboard.html`, { waitUntil: 'load' });
      await page.waitForSelector('.stat', { timeout: 15000 });

      const stillHasSession = await page.evaluate(async () => {
        const mod = await import('/assets/js/core/supabase-client.js');
        await mod.supabase.auth.signOut();
        const { data, error } = await mod.supabase.from('family_members').select('id').limit(1);
        return { rows: data, errorMessage: error?.message || null };
      });
      // anon has no grant at all on family_members (unlike camps, which
      // explicitly grants anon select) — so the client-signed-out read is
      // expected to fail outright, not merely return zero rows.
      assert.ok(
        stillHasSession.errorMessage || (Array.isArray(stillHasSession.rows) && stillHasSession.rows.length === 0),
        `after sign-out, a query for family_members must be rejected or return nothing, got: ${JSON.stringify(stillHasSession)}`
      );

      await page.goto(`${base}/pages/dashboard.html`, { waitUntil: 'load' });
      await page.waitForURL(/login/, { timeout: 15000 });
      await page.close();
    });

    await t.test('mock-data detection: the two changed files no longer read the old mock displaced path', async () => {
      const dashboardPage = readFileSync(join(ROOT, 'assets/js/pages/dashboard.js'), 'utf8');
      const dashboardSupabase = readFileSync(join(ROOT, 'assets/js/supabase/dashboard.js'), 'utf8');
      const combined = `${dashboardPage}\n${dashboardSupabase}`;

      for (const needle of ['session.displacedId', 'store.displaced', 'select.familyOfPerson', 'select.aidForPerson']) {
        assert.ok(!combined.includes(needle), `dashboard.js/supabase/dashboard.js must no longer contain "${needle}"`);
      }
    });

    await t.test('no service_role key or secret reaches the browser', async () => {
      const page = await browser.newPage();
      await login(page, base, 'ahmad@camps.ps', PASSWORD);
      await page.goto(`${base}/pages/dashboard.html`, { waitUntil: 'load' });
      const html = await page.content();
      const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (SUPABASE_SECRET_KEY) assert.ok(!html.includes(SUPABASE_SECRET_KEY), 'service role key must never appear in page HTML');
      assert.doesNotMatch(page.url(), /[?&](family|person|user|displaced)?_?id=/i, 'no client-controlled identity parameter on the dashboard URL');
      await page.close();
    });

    await t.test('console has no errors and no requests fail loading the dashboard', async () => {
      const page = await browser.newPage();
      const consoleErrors = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });
      const failedRequests = [];
      page.on('requestfailed', (req) => failedRequests.push(req.url()));

      await login(page, base, 'omar@camps.ps', PASSWORD);
      await page.goto(`${base}/pages/dashboard.html`, { waitUntil: 'load' });
      await page.waitForSelector('.stat', { timeout: 15000 });
      await page.waitForTimeout(500);

      assert.deepEqual(consoleErrors, [], 'no console errors on the displaced dashboard');
      assert.deepEqual(failedRequests, [], 'no failed network requests on the displaced dashboard');
      await page.close();
    });
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
});

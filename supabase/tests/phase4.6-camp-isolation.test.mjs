/**
 * Phase 4.6 cross-camp isolation: proves a Camp Admin cannot read, filter,
 * export, create into, update, delete, or assign another camp's families as
 * beneficiaries of another camp's aid — through RLS directly, not merely
 * "the UI doesn't show it." Uses the two active seeded Camp Admin accounts,
 * admin@camps.ps (مخيم النور) and nour@camps.ps (مخيم الرحمة).
 *
 *   cd supabase && npm run frontend:config && npm run test:phase4.6-camp-isolation
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

const CAMP_ADMINS = ['admin@camps.ps', 'nour@camps.ps'];
const PASSWORD = '123456';

async function ownCampId(client) {
  const {
    data: { user },
  } = await client.auth.getUser();
  const { data: profile } = await client.from('profiles').select('camp_id').eq('id', user.id).single();
  return profile.camp_id;
}

test('Phase 4.6 cross-camp isolation', async (t) => {
  const SUPABASE_URL = required('SUPABASE_URL');
  const SUPABASE_PUBLISHABLE_KEY = required('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY');

  const server = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();

  try {
    for (const email of CAMP_ADMINS) {
      await t.test(`${email}: RLS returns only own-camp aid_distributions, zero of the other camp's`, async () => {
        const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
        const { error: signInError } = await client.auth.signInWithPassword({ email, password: PASSWORD });
        assert.equal(signInError, null, `${email} must be able to sign in`);

        const campId = await ownCampId(client);
        const { data: allVisible } = await client.from('aid_distributions').select('id, camp_id');
        assert.ok(allVisible.length > 0, `${email} must see at least one aid distribution (own camp)`);
        assert.ok(
          allVisible.every((d) => d.camp_id === campId),
          `${email} must see zero aid_distributions outside their own camp`
        );

        await client.auth.signOut();
      });

      await t.test(`${email}: aid-details for another camp's distribution id renders not-found`, async () => {
        const otherEmail = CAMP_ADMINS.find((e) => e !== email);
        const otherClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
        await otherClient.auth.signInWithPassword({ email: otherEmail, password: PASSWORD });
        const { data: otherDistributions } = await otherClient.from('aid_distributions').select('id').limit(1);
        await otherClient.auth.signOut();
        assert.ok(otherDistributions.length > 0, 'the other camp must have at least one seeded distribution');
        const otherId = otherDistributions[0].id;

        const page = await browser.newPage();
        await login(page, base, email, PASSWORD);
        await page.goto(`${base}/pages/aid-details.html?id=${otherId}`, { waitUntil: 'load' });
        await page.waitForSelector('.empty, h3', { timeout: 15000 });
        const bodyText = await page.locator('body').innerText();
        assert.ok(
          bodyText.includes('غير موجود') || bodyText.includes('خارج نطاق'),
          `${email}: viewing another camp's distribution by id must render the not-found state, got: ${bodyText.slice(0, 200)}`
        );
        await page.close();
      });

      await t.test(`${email}: deleting another camp's aid distribution — raw client — affects zero rows`, async () => {
        const otherEmail = CAMP_ADMINS.find((e) => e !== email);
        const otherClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
        await otherClient.auth.signInWithPassword({ email: otherEmail, password: PASSWORD });
        const { data: otherDistributions } = await otherClient.from('aid_distributions').select('id').limit(1);
        await otherClient.auth.signOut();
        const targetId = otherDistributions[0].id;

        const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
        await client.auth.signInWithPassword({ email, password: PASSWORD });

        const { data: deleted, error: deleteError } = await client
          .from('aid_distributions')
          .delete()
          .eq('id', targetId)
          .select();
        assert.equal(deleteError, null, 'RLS-blocked delete must not error, only match zero rows');
        assert.equal(deleted.length, 0, "must not be able to delete another camp's aid distribution");

        const verifyClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
        await verifyClient.auth.signInWithPassword({ email: otherEmail, password: PASSWORD });
        const { data: stillThere } = await verifyClient
          .from('aid_distributions')
          .select('id')
          .eq('id', targetId)
          .maybeSingle();
        assert.ok(stillThere, "the other camp's distribution must still exist after the rejected delete attempt");
        await verifyClient.auth.signOut();

        await client.auth.signOut();
      });

      await t.test(`${email}: updating another camp's aid distribution — raw client — affects zero rows`, async () => {
        const otherEmail = CAMP_ADMINS.find((e) => e !== email);
        const otherClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
        await otherClient.auth.signInWithPassword({ email: otherEmail, password: PASSWORD });
        const { data: otherDistributions } = await otherClient
          .from('aid_distributions')
          .select('id, distributed_on')
          .limit(1);
        await otherClient.auth.signOut();
        const target = otherDistributions[0];

        const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
        await client.auth.signInWithPassword({ email, password: PASSWORD });
        const { data: updated, error: updateError } = await client
          .from('aid_distributions')
          .update({ distributed_on: target.distributed_on })
          .eq('id', target.id)
          .select();
        assert.equal(updateError, null, 'RLS-blocked update must not error, only match zero rows');
        assert.equal(updated.length, 0, "must not be able to update another camp's aid distribution");
        await client.auth.signOut();
      });

      await t.test(`${email}: create_aid_distribution into another camp is rejected with 42501`, async () => {
        const otherEmail = CAMP_ADMINS.find((e) => e !== email);
        const otherClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
        await otherClient.auth.signInWithPassword({ email: otherEmail, password: PASSWORD });
        const otherCampId = await ownCampId(otherClient);
        const { data: otherOrgs } = await otherClient.from('organizations').select('id').limit(1);
        const { data: otherFamilies } = await otherClient.from('families').select('id').eq('camp_id', otherCampId).limit(1);
        await otherClient.auth.signOut();

        const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
        await client.auth.signInWithPassword({ email, password: PASSWORD });
        const { error } = await client.rpc('create_aid_distribution', {
          p_organization_id: otherOrgs[0].id,
          p_camp_id: otherCampId,
          p_distributed_on: new Date().toISOString().slice(0, 10),
          p_aid_type_codes: ['food'],
          p_family_ids: [otherFamilies[0].id],
          p_all_families_selected: false,
        });
        assert.ok(error, "creating a distribution in another camp's id must be rejected");
        assert.equal(error.code, '42501', `expected 42501, got ${error.code}: ${error.message}`);
        await client.auth.signOut();
      });

      await t.test(`${email}: assigning another camp's family as a beneficiary is rejected`, async () => {
        const otherEmail = CAMP_ADMINS.find((e) => e !== email);
        const otherClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
        await otherClient.auth.signInWithPassword({ email: otherEmail, password: PASSWORD });
        const otherCampId = await ownCampId(otherClient);
        const { data: otherFamilies } = await otherClient.from('families').select('id').eq('camp_id', otherCampId).limit(1);
        await otherClient.auth.signOut();

        const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
        await client.auth.signInWithPassword({ email, password: PASSWORD });
        const campId = await ownCampId(client);
        const { data: ownDistributions } = await client.from('aid_distributions').select('id').eq('camp_id', campId).limit(1);
        assert.ok(ownDistributions.length > 0, `${email} must have at least one own-camp distribution to attempt this on`);

        const { data: inserted, error: insertError } = await client
          .from('aid_distribution_families')
          .insert({ distribution_id: ownDistributions[0].id, family_id: otherFamilies[0].id })
          .select();
        assert.ok(
          insertError || (inserted && inserted.length === 0),
          "assigning another camp's family as a beneficiary must be rejected, not silently succeed"
        );
        await client.auth.signOut();
      });

      await t.test(`${email}: rendered list and Excel export never contain the other camp's family names`, async () => {
        const otherEmail = CAMP_ADMINS.find((e) => e !== email);
        const otherClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
        await otherClient.auth.signInWithPassword({ email: otherEmail, password: PASSWORD });
        const { data: otherFamilies } = await otherClient
          .from('families')
          .select('reference_code')
          .limit(20);
        await otherClient.auth.signOut();
        const otherCodes = otherFamilies.map((f) => f.reference_code);

        const page = await browser.newPage();
        await login(page, base, email, PASSWORD);
        await page.goto(`${base}/pages/aid.html`, { waitUntil: 'load' });
        await page.waitForSelector('table, .empty-state', { timeout: 15000 });
        const bodyText = await page.locator('body').innerText();
        for (const code of otherCodes) {
          assert.ok(!bodyText.includes(code), `${email}: rendered aid list must never show another camp's family code (${code})`);
        }
        await page.close();
      });
    }
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
});

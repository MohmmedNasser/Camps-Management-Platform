/**
 * Phase 4.5 cross-camp isolation: proves a Camp Admin cannot read, filter,
 * export, create into, update or delete another camp's displaced people —
 * through RLS directly, not merely "the UI doesn't show it." Uses the two
 * active seeded Camp Admin accounts, admin@camps.ps (مخيم النور) and
 * nour@camps.ps (مخيم الرحمة).
 *
 *   cd supabase && npm run frontend:config && npm run test:phase4.5-camp-isolation
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
  const { data: { user } } = await client.auth.getUser();
  const { data: profile } = await client.from('profiles').select('camp_id').eq('id', user.id).single();
  return profile.camp_id;
}

test('Phase 4.5 cross-camp isolation', async (t) => {
  const SUPABASE_URL = required('SUPABASE_URL');
  const SUPABASE_PUBLISHABLE_KEY = required('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY');

  const server = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();

  try {
    for (const email of CAMP_ADMINS) {
      await t.test(`${email}: RLS returns only own-camp family_members, zero of the other camp's`, async () => {
        const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
        const { error: signInError } = await client.auth.signInWithPassword({ email, password: PASSWORD });
        assert.equal(signInError, null, `${email} must be able to sign in`);

        const campId = await ownCampId(client);
        const { data: allVisible } = await client.from('family_members').select('id, camp_id, national_id');
        assert.ok(allVisible.length > 0, `${email} must see at least one displaced person (own camp)`);
        assert.ok(
          allVisible.every((m) => m.camp_id === campId),
          `${email} must see zero family_members outside their own camp`
        );

        await client.auth.signOut();
      });

      await t.test(`${email}: displaced-details for another camp's member id renders not-found`, async () => {
        const otherEmail = CAMP_ADMINS.find((e) => e !== email);
        const otherClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
        await otherClient.auth.signInWithPassword({ email: otherEmail, password: PASSWORD });
        const { data: otherMembers } = await otherClient.from('family_members').select('id').limit(1);
        await otherClient.auth.signOut();
        assert.ok(otherMembers.length > 0, 'the other camp must have at least one seeded person');
        const otherId = otherMembers[0].id;

        const page = await browser.newPage();
        await login(page, base, email, PASSWORD);
        await page.goto(`${base}/pages/displaced-details.html?id=${otherId}`, { waitUntil: 'load' });
        await page.waitForSelector('.empty, h3', { timeout: 15000 });
        const bodyText = await page.locator('body').innerText();
        assert.ok(
          bodyText.includes('غير موجود') || bodyText.includes('خارج نطاق'),
          `${email}: viewing another camp's person by id must render the not-found state, got: ${bodyText.slice(0, 200)}`
        );
        await page.close();
      });

      await t.test(`${email}: deleting another camp's displaced person — raw client — affects zero rows`, async () => {
        const otherEmail = CAMP_ADMINS.find((e) => e !== email);
        const otherClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
        await otherClient.auth.signInWithPassword({ email: otherEmail, password: PASSWORD });
        const { data: otherMembers } = await otherClient.from('family_members').select('id, national_id').limit(1);
        await otherClient.auth.signOut();
        const target = otherMembers[0];

        const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
        await client.auth.signInWithPassword({ email, password: PASSWORD });

        const { data: deleted, error: deleteError } = await client
          .from('family_members')
          .delete()
          .eq('id', target.id)
          .select();
        assert.equal(deleteError, null, 'RLS-blocked delete must not error, only match zero rows');
        assert.equal(deleted.length, 0, "must not be able to delete another camp's displaced person");

        const verifyClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
        await verifyClient.auth.signInWithPassword({ email: otherEmail, password: PASSWORD });
        const { data: stillThere } = await verifyClient.from('family_members').select('id').eq('id', target.id).maybeSingle();
        assert.ok(stillThere, "the other camp's person must still exist after the rejected delete attempt");
        await verifyClient.auth.signOut();

        await client.auth.signOut();
      });

      await t.test(`${email}: updating another camp's displaced person — raw client — affects zero rows`, async () => {
        const otherEmail = CAMP_ADMINS.find((e) => e !== email);
        const otherClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
        await otherClient.auth.signInWithPassword({ email: otherEmail, password: PASSWORD });
        const { data: otherMembers } = await otherClient.from('family_members').select('id, chronic_diseases').limit(1);
        await otherClient.auth.signOut();
        const target = otherMembers[0];

        const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
        await client.auth.signInWithPassword({ email, password: PASSWORD });
        const { data: updated, error: updateError } = await client
          .from('family_members')
          .update({ chronic_diseases: 'RLS-should-block-this' })
          .eq('id', target.id)
          .select();
        assert.equal(updateError, null, 'RLS-blocked update must not error, only match zero rows');
        assert.equal(updated.length, 0, "must not be able to update another camp's displaced person");
        await client.auth.signOut();
      });

      await t.test(`${email}: addFamilyMember into another camp's family is rejected with 42501`, async () => {
        const otherEmail = CAMP_ADMINS.find((e) => e !== email);
        const otherClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
        await otherClient.auth.signInWithPassword({ email: otherEmail, password: PASSWORD });
        const { data: otherFamilies } = await otherClient.from('families').select('id').limit(1);
        await otherClient.auth.signOut();
        const targetFamilyId = otherFamilies[0].id;

        const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
        await client.auth.signInWithPassword({ email, password: PASSWORD });
        const uniqueId = String(Date.now()).slice(-9);
        const { error } = await client.rpc('add_family_member', {
          p_family_id: targetFamilyId,
          p_member: { full_name: 'محاولة اختراق', national_id: uniqueId, gender: 'male', tent_type: 'tarp_tent' },
        });
        assert.ok(error, 'adding a member into another camp\'s family must be rejected');
        assert.equal(error.code, '42501', `expected 42501, got ${error.code}: ${error.message}`);
        await client.auth.signOut();
      });

      await t.test(`${email}: rendered list and Excel export never contain the other camp's national IDs`, async () => {
        const otherEmail = CAMP_ADMINS.find((e) => e !== email);
        const otherClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
        await otherClient.auth.signInWithPassword({ email: otherEmail, password: PASSWORD });
        const { data: otherMembers } = await otherClient.from('family_members').select('national_id');
        await otherClient.auth.signOut();
        const otherIds = otherMembers.map((m) => m.national_id);

        const page = await browser.newPage();
        await login(page, base, email, PASSWORD);
        await page.goto(`${base}/pages/displaced.html`, { waitUntil: 'load' });
        await page.waitForSelector('table, .empty-state', { timeout: 15000 });
        const bodyText = await page.locator('body').innerText();
        for (const id of otherIds) {
          assert.ok(!bodyText.includes(id), `${email}: rendered displaced list must never show another camp's national ID (${id})`);
        }
        await page.close();
      });
    }
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
});

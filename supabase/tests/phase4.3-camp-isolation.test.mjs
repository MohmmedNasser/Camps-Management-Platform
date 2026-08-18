// supabase/tests/phase4.3-camp-isolation.test.mjs
/**
 * Phase 4.3 cross-camp isolation: proves a Camp Admin cannot reach another
 * camp's protected data — through get_dashboard_statistics's own
 * authorization check AND through RLS directly, not merely "the UI
 * doesn't show it." Uses the two active seeded Camp Admin accounts,
 * admin@camps.ps and nour@camps.ps — a third, raed@camps.ps, is seeded
 * disabled and cannot authenticate as a camp_admin (is_camp_admin()
 * requires status='active'), so it is not used here.
 *
 *   cd supabase && npm run frontend:config && npm run test:phase4.3-camp-isolation
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

test('Phase 4.3 cross-camp isolation', async (t) => {
  const SUPABASE_URL = required('SUPABASE_URL');
  const SUPABASE_PUBLISHABLE_KEY = required('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY');

  const anonClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
  const { data: camps } = await anonClient.from('camps').select('id, name');
  assert.ok(camps.length >= 2, 'seeded project must have at least 2 camps for isolation testing to be meaningful');

  const server = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();

  try {
    for (const email of CAMP_ADMINS) {
      await t.test(`${email}: get_dashboard_statistics rejects another camp's id and null`, async () => {
        const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
        const { error: signInError } = await client.auth.signInWithPassword({ email, password: PASSWORD });
        assert.equal(signInError, null, `${email} must be able to sign in`);

        const campId = await ownCampId(client);
        const otherCamp = camps.find((c) => c.id !== campId);
        assert.ok(otherCamp, "must find a camp other than the admin's own");

        const { error: ownError } = await client.rpc('get_dashboard_statistics', { p_camp_id: campId });
        assert.equal(ownError, null, 'own camp id must succeed');

        const { error: otherError } = await client.rpc('get_dashboard_statistics', { p_camp_id: otherCamp.id });
        assert.ok(otherError, "another camp's id must be rejected");
        assert.equal(otherError.code, '42501', "rejection must be the RPC's own authorization exception");

        const { error: nullError } = await client.rpc('get_dashboard_statistics', { p_camp_id: null });
        assert.ok(nullError, 'null camp id must also be rejected for a camp_admin');
        assert.equal(nullError.code, '42501');

        await client.auth.signOut();
      });

      await t.test(`${email}: RLS returns zero rows for another camp's protected tables`, async () => {
        const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
        await client.auth.signInWithPassword({ email, password: PASSWORD });
        const campId = await ownCampId(client);
        const otherCamp = camps.find((c) => c.id !== campId);

        const { data: otherMembers } = await client.from('family_members').select('id').eq('camp_id', otherCamp.id);
        assert.equal(otherMembers.length, 0, "must see zero of another camp's family_members");

        const { data: otherAid } = await client.from('aid_distributions').select('id').eq('camp_id', otherCamp.id);
        assert.equal(otherAid.length, 0, "must see zero of another camp's aid_distributions");

        const { data: otherRequests } = await client
          .from('registration_requests')
          .select('id')
          .eq('camp_id', otherCamp.id);
        assert.equal(otherRequests.length, 0, "must see zero of another camp's registration_requests");

        await client.auth.signOut();
      });

      await t.test(`${email}: dashboard renders only their own camp's name`, async () => {
        const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
        await client.auth.signInWithPassword({ email, password: PASSWORD });
        const campId = await ownCampId(client);
        const ownCamp = camps.find((c) => c.id === campId);
        await client.auth.signOut();

        const page = await browser.newPage();
        await login(page, base, email, PASSWORD);
        await page.waitForSelector('.stat__label', { timeout: 15000 });
        const bodyText = await page.locator('body').innerText();

        assert.ok(bodyText.includes(ownCamp.name), `dashboard must render the admin's own camp name ("${ownCamp.name}")`);
        for (const camp of camps.filter((c) => c.id !== campId)) {
          assert.ok(!bodyText.includes(camp.name), `dashboard must never render another camp's name ("${camp.name}")`);
        }
        await page.close();
      });
    }
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
});

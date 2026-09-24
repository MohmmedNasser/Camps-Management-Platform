// supabase/tests/phase4.12-displaced-dashboard-isolation.test.mjs
/**
 * Phase 4.12 cross-user isolation: proves a displaced account's dashboard
 * can read only its OWN profile, family, family members, aid and documents
 * — through RLS directly, not merely "the UI doesn't show it" — using the
 * four seeded displaced accounts across three camps (two of them,
 * ahmad@camps.ps/yousef@camps.ps, share a camp but not a family, which a
 * camp-only boundary would miss). Also covers anonymous access, a
 * disposable fixture for the one state seed data cannot express (an
 * approved profile with no family link), and session preservation.
 *
 *   cd supabase && npm run frontend:config && npm run test:phase4.12-displaced-dashboard-isolation
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

async function ownIdentity(client) {
  const { data: { user } } = await client.auth.getUser();
  const { data: profile } = await client
    .from('profiles')
    .select('family_member_id, camp_id')
    .eq('id', user.id)
    .single();
  return { userId: user.id, familyMemberId: profile.family_member_id, campId: profile.camp_id };
}

test('Phase 4.12 displaced dashboard: cross-user isolation', async (t) => {
  const SUPABASE_URL = required('SUPABASE_URL');
  const SUPABASE_PUBLISHABLE_KEY = required('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY');
  const SUPABASE_SECRET_KEY = required('SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY');
  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

  const server = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();
  let fixtureUserId = null;
  const fixtureEmail = `phase412-fixture-${Date.now()}@example.com`;

  try {
    for (const email of ACCOUNTS) {
      await t.test(`${email}: RLS returns only own-family rows across every table the dashboard reads`, async () => {
        const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
        await client.auth.signInWithPassword({ email, password: PASSWORD });
        const me = await ownIdentity(client);

        const { data: ownMember } = await client.from('family_members').select('family_id').eq('id', me.familyMemberId).single();
        const ownFamilyId = ownMember.family_id;

        const { data: members } = await client.from('family_members').select('id, family_id');
        assert.ok(members.length > 0, `${email} must see at least their own family's members`);
        assert.ok(
          members.every((m) => m.family_id === ownFamilyId),
          `${email} must see zero family_members outside their own family`
        );

        const { data: families } = await client.from('families').select('id');
        assert.equal(families.length, 1, `${email} must see exactly one family (their own)`);
        assert.equal(families[0].id, ownFamilyId, `${email} must see their own family and no other`);

        const { data: aidLinks } = await client.from('aid_distribution_families').select('family_id');
        assert.ok(aidLinks.every((l) => l.family_id === families[0].id), `${email} must see zero aid links outside their own family`);

        const { data: docs } = await client.from('documents').select('family_id');
        assert.ok(docs.every((d) => d.family_id === families[0].id), `${email} must see zero documents outside their own family`);

        await client.auth.signOut();
      });
    }

    await t.test('same-camp, different-family isolation: yousef cannot see ahmad\'s family (both in مخيم النور)', async () => {
      const ahmadClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
      await ahmadClient.auth.signInWithPassword({ email: 'ahmad@camps.ps', password: PASSWORD });
      const ahmad = await ownIdentity(ahmadClient);
      const { data: ahmadMember } = await ahmadClient.from('family_members').select('national_id, full_name').eq('id', ahmad.familyMemberId).single();
      await ahmadClient.auth.signOut();

      const yousefClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
      await yousefClient.auth.signInWithPassword({ email: 'yousef@camps.ps', password: PASSWORD });

      const { data: probe } = await yousefClient.from('family_members').select('id').eq('id', ahmad.familyMemberId).maybeSingle();
      assert.equal(probe, null, "yousef must not be able to read ahmad's family_member row, even by direct id, though they share a camp");

      const { data: allVisible } = await yousefClient.from('family_members').select('national_id');
      assert.ok(!allVisible.some((m) => m.national_id === ahmadMember.national_id), "yousef's visible rows must never include ahmad's national ID");

      await yousefClient.auth.signOut();
    });

    await t.test('identity cannot be spoofed by id: requesting another account\'s family_member_id while signed in as a different one returns nothing', async () => {
      const ibrahimClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
      await ibrahimClient.auth.signInWithPassword({ email: 'ibrahim@camps.ps', password: PASSWORD });
      const ibrahim = await ownIdentity(ibrahimClient);
      await ibrahimClient.auth.signOut();

      const omarClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
      await omarClient.auth.signInWithPassword({ email: 'omar@camps.ps', password: PASSWORD });
      const { data: spoofed } = await omarClient
        .from('family_members')
        .select('*, family:families!family_members_family_id_fkey(reference_code)')
        .eq('id', ibrahim.familyMemberId)
        .maybeSingle();
      assert.equal(spoofed, null, "omar's client asking for ibrahim's family_member_id must get null, not ibrahim's data");
      await omarClient.auth.signOut();
    });

    await t.test('rendered dashboard for ahmad shows only ahmad\'s data, never another account\'s', async () => {
      const otherAccounts = [
        { email: 'yousef@camps.ps', name: 'يوسف عبد الله النجار', familyId: 'FAM-000002' },
        { email: 'ibrahim@camps.ps', name: 'إبراهيم سعيد قاسم', familyId: 'FAM-000004' },
        { email: 'omar@camps.ps', name: 'عمر ياسين الغول', familyId: 'FAM-000007' },
      ];

      const page = await browser.newPage();
      await login(page, base, 'ahmad@camps.ps', PASSWORD);
      await page.goto(`${base}/pages/dashboard.html`, { waitUntil: 'load' });
      await page.waitForSelector('.stat', { timeout: 15000 });
      const bodyText = await page.locator('body').innerText();

      assert.ok(bodyText.includes('أحمد محمود الشريف'), "ahmad's own name must render");
      assert.ok(bodyText.includes('FAM-000001'), "ahmad's own family id must render");
      for (const other of otherAccounts) {
        assert.ok(!bodyText.includes(other.name), `ahmad's dashboard must never show ${other.email}'s name`);
        assert.ok(!bodyText.includes(other.familyId), `ahmad's dashboard must never show ${other.email}'s family id`);
      }
      await page.close();
    });

    await t.test('anonymous: every table the dashboard reads is unreachable without a session', async () => {
      const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
      for (const table of ['family_members', 'families', 'aid_distribution_families', 'documents']) {
        const { data, error } = await client.from(table).select('id').limit(1);
        assert.ok(error || (data && data.length === 0), `anonymous ${table} read must be rejected or return nothing`);
      }
    });

    await t.test('Camp Admin and Super Admin sessions are unaffected by the displaced dashboard branch', async () => {
      for (const email of ['admin@camps.ps', 'super@camps.ps']) {
        const page = await browser.newPage();
        await login(page, base, email, PASSWORD);
        await page.goto(`${base}/pages/dashboard.html`, { waitUntil: 'load' });
        await page.waitForSelector('.stat', { timeout: 15000 });
        const bodyText = await page.locator('body').innerText();
        assert.ok(!bodyText.includes('بياناتي'), `${email} must render their own admin dashboard, not the displaced-person view`);
        await page.close();
      }
    });

    // Test G: the one state seed data cannot express — an approved profile
    // with no family link (architecturally unreachable through the app,
    // §2 of the design; only reachable by direct, service-role manipulation).
    await t.test('missing family: an approved profile with no family link renders the safe empty state, never a crash', async () => {
      const { data: created, error: createError } = await serviceClient.auth.admin.createUser({
        email: fixtureEmail,
        password: 'Fixture123!',
        email_confirm: true,
      });
      assert.equal(createError, null, `fixture auth user create must succeed: ${createError?.message}`);
      fixtureUserId = created.user.id;

      // The on_auth_user_created trigger already wrote role='displaced',
      // status='pending', family_member_id=null. Only status changes here —
      // family_member_id is left null on purpose, the state under test.
      const { error: approveError } = await serviceClient
        .from('profiles')
        .update({ status: 'approved', full_name: 'مستخدم اختبار بلا أسرة' })
        .eq('id', fixtureUserId);
      assert.equal(approveError, null, `fixture approval must succeed: ${approveError?.message}`);

      const page = await browser.newPage();
      const consoleErrors = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });
      await login(page, base, fixtureEmail, 'Fixture123!');
      await page.goto(`${base}/pages/dashboard.html`, { waitUntil: 'load' });
      await page.waitForSelector('.empty, .stat', { timeout: 15000 });
      const bodyText = await page.locator('body').innerText();
      assert.ok(
        bodyText.includes('لم يتم إنشاء سجل النازح') || bodyText.includes('لم يتم ربط حسابك بأسرة'),
        `must render a safe "no record / no family" state, got: ${bodyText.slice(0, 300)}`
      );
      assert.deepEqual(consoleErrors, [], 'no console error for a profile with no family link');
      await page.close();
    });

    await t.test('session preservation: loading the dashboard never changes auth.uid()', async () => {
      const page = await browser.newPage();
      await login(page, base, 'ahmad@camps.ps', PASSWORD);
      const before = await page.evaluate(async () => {
        const mod = await import('/assets/js/core/supabase-client.js');
        const { data } = await mod.supabase.auth.getUser();
        return data.user.id;
      });
      await page.goto(`${base}/pages/dashboard.html`, { waitUntil: 'load' });
      await page.waitForSelector('.stat', { timeout: 15000 });
      const after = await page.evaluate(async () => {
        const mod = await import('/assets/js/core/supabase-client.js');
        const { data } = await mod.supabase.auth.getUser();
        return data.user.id;
      });
      assert.equal(after, before, "loading the dashboard must not change the signed-in account's own auth.uid()");
      await page.close();
    });
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
    if (fixtureUserId) {
      await serviceClient.from('profiles').delete().eq('id', fixtureUserId);
      await serviceClient.auth.admin.deleteUser(fixtureUserId).catch(() => {});
    }
  }
});

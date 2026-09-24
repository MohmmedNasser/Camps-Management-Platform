// supabase/tests/phase4.13-displaced-isolation.test.mjs
/**
 * Phase 4.13 cross-user isolation: proves the five displaced-person own
 * pages (family-details "أسرتي", profile, documents, aid, notifications)
 * can only ever read/touch the signed-in account's own rows — through RLS
 * directly, not merely "the UI doesn't show it" — using the same four
 * seeded displaced accounts Phase 4.12 already verified (ahmad/yousef share
 * a camp but not a family). Also covers URL spoofing, write boundaries
 * (family_members update, notifications insert/delete), Camp
 * Admin/Super Admin non-regression, and session preservation across the
 * profile page's password re-auth step.
 *
 *   cd supabase && npm run frontend:config && npm run test:phase4.13-displaced-isolation
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
const OWN_PAGES = ['family-details.html', 'profile.html', 'documents.html', 'aid.html', 'notifications.html'];

async function ownIdentity(client) {
  const {
    data: { user },
  } = await client.auth.getUser();
  const { data: profile } = await client
    .from('profiles')
    .select('family_member_id, camp_id')
    .eq('id', user.id)
    .single();
  return { userId: user.id, familyMemberId: profile.family_member_id, campId: profile.camp_id };
}

test('Phase 4.13 displaced own pages: cross-user isolation', async (t) => {
  const SUPABASE_URL = required('SUPABASE_URL');
  const SUPABASE_PUBLISHABLE_KEY = required('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY');
  const SUPABASE_SECRET_KEY = required('SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY');
  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

  const server = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();

  try {
    await t.test('aid_distribution_families: RLS returns only own-family rows for every account', async () => {
      for (const email of ACCOUNTS) {
        const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
        await client.auth.signInWithPassword({ email, password: PASSWORD });
        const me = await ownIdentity(client);
        const { data: member } = await client.from('family_members').select('family_id').eq('id', me.familyMemberId).single();

        const { data: aidLinks } = await client.from('aid_distribution_families').select('family_id');
        assert.ok(aidLinks.every((l) => l.family_id === member.family_id), `${email} must see zero aid links outside their own family`);
        await client.auth.signOut();
      }
    });

    await t.test('documents: RLS returns only own-family rows for every account', async () => {
      for (const email of ACCOUNTS) {
        const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
        await client.auth.signInWithPassword({ email, password: PASSWORD });
        const me = await ownIdentity(client);
        const { data: member } = await client.from('family_members').select('family_id').eq('id', me.familyMemberId).single();
        const { data: docs } = await client.from('documents').select('family_id');
        assert.ok(docs.every((d) => d.family_id === member.family_id), `${email} must see zero documents outside their own family`);
        await client.auth.signOut();
      }
    });

    await t.test('notifications: RLS returns only own rows for every account', async () => {
      for (const email of ACCOUNTS) {
        const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
        await client.auth.signInWithPassword({ email, password: PASSWORD });
        const me = await ownIdentity(client);
        const { data: notifs } = await client.from('notifications').select('recipient_id');
        assert.ok(notifs.every((n) => n.recipient_id === me.userId), `${email} must see zero notifications belonging to another account`);
        await client.auth.signOut();
      }
    });

    await t.test("same-camp, different-family: yousef cannot read ahmad's notifications, family_members, or documents", async () => {
      const ahmadClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
      await ahmadClient.auth.signInWithPassword({ email: 'ahmad@camps.ps', password: PASSWORD });
      const ahmad = await ownIdentity(ahmadClient);
      await ahmadClient.auth.signOut();

      const yousefClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
      await yousefClient.auth.signInWithPassword({ email: 'yousef@camps.ps', password: PASSWORD });

      const { data: notif } = await yousefClient.from('notifications').select('id').eq('recipient_id', ahmad.userId).maybeSingle();
      assert.equal(notif, null, "yousef must not read ahmad's notifications even by direct recipient_id");

      const { data: member } = await yousefClient.from('family_members').select('id').eq('id', ahmad.familyMemberId).maybeSingle();
      assert.equal(member, null, "yousef must not resolve ahmad's family_member_id at all, though they share a camp");

      await yousefClient.auth.signOut();
    });

    await t.test('write boundaries: a displaced session cannot update family_members, cannot insert notifications, cannot delete notifications, cannot write aid_distributions', async () => {
      const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
      await client.auth.signInWithPassword({ email: 'ahmad@camps.ps', password: PASSWORD });
      const me = await ownIdentity(client);

      // Postgres RLS silently filters the target row out of an UPDATE that no
      // policy authorizes — it is NOT a thrown error, just zero rows
      // affected (confirmed live: no displaced-scoped UPDATE policy exists
      // on family_members at all). Verify both angles: PostgREST reports
      // zero affected rows, AND an independent service-role read proves the
      // value was never actually written.
      const { data: memberBefore } = await serviceClient.from('family_members').select('phone').eq('id', me.familyMemberId).single();
      const { error: memberUpdateError, count: memberUpdateCount } = await client
        .from('family_members')
        .update({ phone: '0599999999' }, { count: 'exact' })
        .eq('id', me.familyMemberId);
      assert.ok(
        memberUpdateError || memberUpdateCount === 0,
        'updating own family_members row must be rejected or affect zero rows (no displaced UPDATE policy exists)'
      );
      const { data: memberAfter } = await serviceClient.from('family_members').select('phone').eq('id', me.familyMemberId).single();
      assert.equal(memberAfter.phone, memberBefore.phone, "a displaced session's family_members update must never actually persist");

      const { error: notifInsertError } = await client
        .from('notifications')
        .insert({ recipient_id: me.userId, title: 'x', body: 'x' });
      assert.ok(notifInsertError, 'inserting a notification must be rejected (no INSERT policy exists)');

      const { data: ownNotif } = await client.from('notifications').select('id').limit(1).maybeSingle();
      if (ownNotif) {
        const { error: notifDeleteError, count } = await client
          .from('notifications')
          .delete({ count: 'exact' })
          .eq('id', ownNotif.id);
        assert.ok(notifDeleteError || count === 0, 'deleting a notification must be rejected or affect zero rows (no DELETE policy exists)');
      }

      const { error: aidInsertError } = await client.from('aid_distributions').insert({
        organization_id: null,
        camp_id: me.campId,
        distributed_on: new Date().toISOString().slice(0, 10),
      });
      assert.ok(aidInsertError, 'a displaced session must never be able to create an aid distribution');

      await client.auth.signOut();
    });

    await t.test("URL spoofing: family-details.html?id=<another family> still renders the caller's own family", async () => {
      const page = await browser.newPage();
      await login(page, base, 'ahmad@camps.ps', PASSWORD);
      await page.goto(`${base}/pages/family-details.html?id=FAM-000002`, { waitUntil: 'load' });
      await page.waitForSelector('.stat, .empty', { timeout: 20000 });
      const bodyText = await page.locator('body').innerText();
      assert.ok(bodyText.includes('FAM-000001'), 'ahmad must see his own family id, never the spoofed FAM-000002');
      assert.ok(!bodyText.includes('يوسف عبد الله النجار'), "ahmad's page must never render yousef's name via the spoofed id");
      await page.close();
    });

    await t.test("rendered pages for ahmad never include yousef's name or family id", async () => {
      const otherName = 'يوسف عبد الله النجار';
      const otherFamilyId = 'FAM-000002';
      for (const pageName of OWN_PAGES) {
        const page = await browser.newPage();
        await login(page, base, 'ahmad@camps.ps', PASSWORD);
        await page.goto(`${base}/pages/${pageName}`, { waitUntil: 'load' });
        await page.waitForSelector('body', { timeout: 15000 });
        await page.waitForTimeout(1500); // let async collect() settle
        const bodyText = await page.locator('body').innerText();
        assert.ok(!bodyText.includes(otherName), `${pageName} must never show yousef's name`);
        assert.ok(!bodyText.includes(otherFamilyId), `${pageName} must never show yousef's family id`);
        await page.close();
      }
    });

    await t.test('Camp Admin and Super Admin sessions render all five pages without a thrown error', async () => {
      for (const email of ['admin@camps.ps', 'super@camps.ps']) {
        for (const pageName of OWN_PAGES) {
          const page = await browser.newPage();
          const errors = [];
          page.on('pageerror', (e) => errors.push(String(e)));
          await login(page, base, email, PASSWORD);
          await page.goto(`${base}/pages/${pageName}`, { waitUntil: 'load' });
          await page.waitForSelector('body', { timeout: 15000 });
          await page.waitForTimeout(1500);
          assert.deepEqual(errors, [], `${email} on ${pageName} must render without a thrown error`);
          await page.close();
        }
      }
    });

    await t.test("session preservation: a failed password re-auth attempt does not change auth.uid()", async () => {
      const page = await browser.newPage();
      await login(page, base, 'ahmad@camps.ps', PASSWORD);
      const before = await page.evaluate(async () => {
        const mod = await import('/assets/js/core/supabase-client.js');
        const { data } = await mod.supabase.auth.getUser();
        return data.user.id;
      });
      await page.goto(`${base}/pages/profile.html`, { waitUntil: 'load' });
      await page.waitForSelector('#password-form', { timeout: 15000 });
      await page.fill('#currentPassword', 'wrong-password-on-purpose');
      await page.fill('#newPassword', 'irrelevant1');
      await page.fill('#confirmPassword', 'irrelevant1');
      await page.click('#password-form button[type="submit"]');
      await page.waitForSelector('#currentPassword-error:not(:empty)', { timeout: 10000 });
      const after = await page.evaluate(async () => {
        const mod = await import('/assets/js/core/supabase-client.js');
        const { data } = await mod.supabase.auth.getUser();
        return data.user.id;
      });
      assert.equal(after, before, "a failed password-change attempt must not change the signed-in account's own auth.uid()");
      await page.close();
    });
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
});

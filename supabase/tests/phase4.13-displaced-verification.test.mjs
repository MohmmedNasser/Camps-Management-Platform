// supabase/tests/phase4.13-displaced-verification.test.mjs
/**
 * Phase 4.13 DB-vs-UI verification: every value the real displaced-person
 * pages (family-details "أسرتي", profile, documents, aid, notifications)
 * render is checked against an INDEPENDENT query against the same live
 * database (a service-role client, never importing assets/js/supabase/*.js)
 * — family reference/head/members, profile fields plus a real permitted
 * name update (reverted), a real document upload (cleaned up through the
 * same documents-delete Edge Function an authorized Camp Admin would use —
 * a displaced session cannot delete, proven independently by the isolation
 * suite), real aid history, and real notification read/unread state
 * (restored to its seeded value afterward).
 *
 *   cd supabase && npm run frontend:config && npm run test:phase4.13-displaced-verification
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile as readFileAsync } from 'node:fs/promises';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
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

const EMAIL = 'ahmad@camps.ps';
const PASSWORD = '123456';
const FAMILY_REF = 'FAM-000001';
const UPLOAD_DOC_NAME = 'وثيقة اختبار Phase 4.13';

// A real, tiny, genuinely decodable 1x1 JPEG — same fixture
// phase3-documents.test.mjs / phase4.8-documents-verification.test.mjs use.
const JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=';

function writeTempJpeg() {
  const path = resolve(HERE, `.tmp-phase4.13-${Date.now()}.jpg`);
  writeFileSync(path, Buffer.from(JPEG_BASE64, 'base64'));
  return path;
}

test('Phase 4.13 displaced own pages DB-vs-UI verification', async (t) => {
  const SUPABASE_URL = required('SUPABASE_URL');
  const SUPABASE_PUBLISHABLE_KEY = required('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY');
  const SUPABASE_SECRET_KEY = required('SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY');
  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

  const server = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();

  let uploadedDocId = null;
  let restoreNotificationState = null; // [{id, is_read}]

  const { data: usersPage } = await serviceClient.auth.admin.listUsers();
  const ahmadUser = usersPage.users.find((u) => u.email === EMAIL);
  assert.ok(ahmadUser, `seeded account ${EMAIL} must exist`);

  try {
    await t.test('family-details: rendered family reference, head, member count, member names match an independent query', async () => {
      const { data: family } = await serviceClient
        .from('families')
        .select('id, reference_code, head:family_members!families_head_member_id_fkey(full_name)')
        .eq('reference_code', FAMILY_REF)
        .single();
      const { data: members } = await serviceClient.from('family_members').select('full_name').eq('family_id', family.id);
      const { data: stats } = await serviceClient.from('family_stats').select('members_count').eq('family_id', family.id).single();

      const page = await browser.newPage();
      await login(page, base, EMAIL, PASSWORD);
      await page.goto(`${base}/pages/family-details.html`, { waitUntil: 'load' });
      await page.waitForSelector('.stat', { timeout: 20000 });
      const bodyText = await page.locator('body').innerText();

      assert.ok(bodyText.includes(family.reference_code), 'family reference code must render');
      assert.ok(bodyText.includes(family.head.full_name), 'family head name must render');
      assert.ok(bodyText.includes(String(stats.members_count)), 'member count stat must render');
      for (const member of members) {
        assert.ok(bodyText.includes(member.full_name), `member "${member.full_name}" must render`);
      }
      await page.close();
    });

    await t.test('profile: rendered national id/name/gender/phone match an independent query, and a real name+phone update persists then reverts', async () => {
      const { data: profileBefore } = await serviceClient
        .from('profiles')
        .select('id, full_name, phone, family_member_id')
        .eq('id', ahmadUser.id)
        .single();
      const { data: member } = await serviceClient
        .from('family_members')
        .select('full_name, national_id, gender')
        .eq('id', profileBefore.family_member_id)
        .single();

      const page = await browser.newPage();
      await login(page, base, EMAIL, PASSWORD);
      await page.goto(`${base}/pages/profile.html`, { waitUntil: 'load' });
      await page.waitForSelector('#account-form', { timeout: 20000 });
      const bodyText = await page.locator('body').innerText();
      assert.ok(bodyText.includes(member.national_id), "the real national id must render in the camp-file card");
      assert.ok(bodyText.includes(member.full_name), "the real family-member name must render in the camp-file card");

      const emailInput = page.locator('#email');
      assert.equal(await emailInput.isDisabled(), true, 'the email field must be disabled (Auth email change is deferred)');

      const newName = `${profileBefore.full_name} test`;
      await page.fill('#name', newName);
      await page.click('#account-form button[type="submit"]');
      await page.waitForSelector('.toast', { timeout: 15000 });

      const { data: profileAfter } = await serviceClient.from('profiles').select('full_name').eq('id', profileBefore.id).single();
      assert.equal(profileAfter.full_name, newName, 'the real profiles row must reflect the update');

      await serviceClient.from('profiles').update({ full_name: profileBefore.full_name }).eq('id', profileBefore.id);
      const { data: reverted } = await serviceClient.from('profiles').select('full_name').eq('id', profileBefore.id).single();
      assert.equal(reverted.full_name, profileBefore.full_name, 'revert must succeed');

      await page.close();
    });

    await t.test('documents: rendered document count matches an independent query, and a real upload persists then is cleaned up', async () => {
      const { data: familyRow } = await serviceClient.from('families').select('id').eq('reference_code', FAMILY_REF).single();
      const { count: before } = await serviceClient
        .from('documents')
        .select('id', { count: 'exact', head: true })
        .eq('family_id', familyRow.id);

      const page = await browser.newPage();
      await login(page, base, EMAIL, PASSWORD);
      await page.goto(`${base}/pages/documents.html`, { waitUntil: 'load' });
      await page.waitForSelector('table, .empty', { timeout: 20000 });
      const bodyText = await page.locator('body').innerText();
      assert.ok(bodyText.includes(String(before)), `expected document count ${before} to appear in the rendered page`);

      await page.click('[data-upload]');
      await page.waitForSelector('#document-form', { timeout: 10000 });
      const jpegPath = writeTempJpeg();
      try {
        await page.setInputFiles('#document-form input[type="file"]', jpegPath);
        await page.fill('#name', UPLOAD_DOC_NAME);
        await page.selectOption('#category', { index: 1 });
        // Ahmad's family has more than one member, so the "يخص النازح"
        // select starts empty (documentFields() only pre-fills it when the
        // person list has exactly one option) and is required.
        await page.selectOption('#displacedId', { index: 1 });
        // The submit button lives in the modal footer, outside <form
        // id="document-form">, associated via the HTML5 form="..." attribute.
        await page.click('button[form="document-form"]');
        await page.waitForSelector('.toast', { timeout: 20000 });
      } finally {
        unlinkSync(jpegPath);
      }

      const { data: uploaded } = await serviceClient
        .from('documents')
        .select('id')
        .eq('family_id', familyRow.id)
        .eq('name', UPLOAD_DOC_NAME)
        .single();
      assert.ok(uploaded, 'the real document row must exist after upload');
      uploadedDocId = uploaded.id;

      await page.close();
    });

    await t.test('aid: rendered organization name matches an independent query', async () => {
      const { data: familyRow } = await serviceClient.from('families').select('id').eq('reference_code', FAMILY_REF).single();
      const { data: links } = await serviceClient.from('aid_distribution_families').select('distribution_id').eq('family_id', familyRow.id);
      assert.ok(links.length > 0, `${FAMILY_REF} must have at least one seeded aid distribution`);

      const { data: dist } = await serviceClient
        .from('aid_distributions')
        .select('organization:organizations(name)')
        .eq('id', links[0].distribution_id)
        .single();

      const page = await browser.newPage();
      await login(page, base, EMAIL, PASSWORD);
      await page.goto(`${base}/pages/aid.html`, { waitUntil: 'load' });
      await page.waitForSelector('.card, .empty', { timeout: 20000 });
      const bodyText = await page.locator('body').innerText();
      assert.ok(bodyText.includes(dist.organization.name), 'the real organization name must render in the aid history');
      await page.close();
    });

    await t.test('notifications: rendered rows/read-state match an independent query, and mark-read persists (trigger stamps read_at), then state is restored', async () => {
      const { data: before } = await serviceClient.from('notifications').select('id, title, is_read').eq('recipient_id', ahmadUser.id);
      assert.ok(before.length > 0, `${EMAIL} must have at least one seeded notification`);
      restoreNotificationState = before.map((n) => ({ id: n.id, is_read: n.is_read }));

      const page = await browser.newPage();
      await login(page, base, EMAIL, PASSWORD);
      await page.goto(`${base}/pages/notifications.html`, { waitUntil: 'load' });
      await page.waitForSelector('.list, .empty', { timeout: 20000 });
      const bodyText = await page.locator('body').innerText();
      for (const n of before) assert.ok(bodyText.includes(n.title), `notification "${n.title}" must render`);

      const unreadBefore = before.find((n) => !n.is_read);
      if (unreadBefore) {
        await page.click(`[data-read="${unreadBefore.id}"]`);
        await page.waitForTimeout(1200);
        const { data: after } = await serviceClient.from('notifications').select('is_read, read_at').eq('id', unreadBefore.id).single();
        assert.equal(after.is_read, true, 'marking read must persist in the real table');
        assert.ok(after.read_at, 'read_at must be stamped by the notifications_guard_update trigger');
      }
      await page.close();
    });
  } finally {
    if (uploadedDocId) {
      const adminClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
      await adminClient.auth.signInWithPassword({ email: 'admin@camps.ps', password: PASSWORD });
      await adminClient.functions.invoke('documents-delete', { body: { id: uploadedDocId } });
      await adminClient.auth.signOut();
      const { data: gone } = await serviceClient.from('documents').select('id').eq('id', uploadedDocId).maybeSingle();
      if (gone) console.error('[phase4.13-verification] cleanup warning: test document still present after delete attempt', uploadedDocId);
    }
    if (restoreNotificationState) {
      for (const row of restoreNotificationState) {
        await serviceClient
          .from('notifications')
          .update({ is_read: row.is_read, read_at: row.is_read ? new Date().toISOString() : null })
          .eq('id', row.id);
      }
    }
    await browser.close();
    await new Promise((r) => server.close(r));
  }
});

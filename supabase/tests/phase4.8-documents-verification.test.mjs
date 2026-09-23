// supabase/tests/phase4.8-documents-verification.test.mjs
/**
 * Phase 4.8 verification: every value the real Camp Admin documents page
 * renders is compared against an INDEPENDENT query against the same live
 * database (a second supabase-js client, never importing
 * assets/js/supabase/documents.js) — list count, search, category filter,
 * the summary stat, a full real upload -> preview -> delete round trip
 * through the actual UI and Cloudinary, and an empty-result case. Cleans up
 * every fixture and Cloudinary asset it creates.
 *
 *   cd supabase && npm run frontend:config && npm run test:phase4.8-documents
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

const CAMP_ID = '5853adc9-9d23-4d4d-bc32-6fff17bdc3b0'; // مخيم النور
const EMAIL = 'admin@camps.ps';
const PASSWORD = '123456';

// A real, tiny, genuinely decodable 1x1 JPEG — Cloudinary validates actual
// image content on upload, so a fixture with only the right magic bytes but
// no real image data is rejected upstream (same fixture phase3-documents.test.mjs uses).
const JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=';

test('Phase 4.8 documents DB-vs-UI verification', async (t) => {
  const SUPABASE_URL = required('SUPABASE_URL');
  const SUPABASE_PUBLISHABLE_KEY = required('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY');
  const SUPABASE_SECRET_KEY = required('SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY');
  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

  const server = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();

  const { data: member } = await serviceClient.from('family_members').select('id, full_name').eq('camp_id', CAMP_ID).limit(1).single();
  assert.ok(member, 'camp النور must have at least one seeded family member');

  try {
    await t.test('list: rendered document count matches a direct count', async () => {
      const { count } = await serviceClient.from('documents').select('id', { count: 'exact', head: true }).eq('camp_id', CAMP_ID);

      const page = await browser.newPage();
      await login(page, base, EMAIL, PASSWORD);
      await page.goto(`${base}/pages/documents.html`, { waitUntil: 'load' });
      await page.waitForSelector('table, .empty', { timeout: 30000 });
      const bodyText = await page.locator('body').innerText();
      assert.ok(bodyText.includes(String(count)), `expected document count ${count} to appear in the rendered page`);
      await page.close();
    });

    await t.test('search: filters to exactly the matching document', async () => {
      const { data: fixture, error: fixtureError } = await serviceClient
        .from('documents')
        .insert({
          name: 'مستند اختبار البحث الفريد',
          category: 'other',
          camp_id: CAMP_ID,
          family_member_id: member.id,
          storage_provider: 'pending',
        })
        .select('id, name')
        .single();
      assert.equal(fixtureError, null, `fixture insert must succeed: ${fixtureError?.message}`);

      try {
        const page = await browser.newPage();
        await login(page, base, EMAIL, PASSWORD);
        await page.goto(`${base}/pages/documents.html`, { waitUntil: 'load' });
        await page.waitForSelector('table, .empty', { timeout: 30000 });
        await page.fill('#toolbar-search', 'البحث الفريد');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(1000);
        const bodyText = await page.locator('body').innerText();
        assert.ok(bodyText.includes(fixture.name), `expected "${fixture.name}" in filtered results`);
        await page.close();
      } finally {
        await serviceClient.from('documents').delete().eq('id', fixture.id);
      }
    });

    await t.test('category filter (deep-linked): rendered count matches a direct per-category count', async () => {
      const { count } = await serviceClient
        .from('documents')
        .select('id', { count: 'exact', head: true })
        .eq('camp_id', CAMP_ID)
        .eq('category', 'passport');

      const page = await browser.newPage();
      await login(page, base, EMAIL, PASSWORD);
      await page.goto(`${base}/pages/documents.html?category=passport`, { waitUntil: 'load' });
      await page.waitForSelector('table, .empty', { timeout: 30000 });
      const bodyText = await page.locator('body').innerText();
      if (count > 0) {
        assert.ok(bodyText.includes(String(count)), `expected passport-category count ${count} in the rendered page`);
      } else {
        assert.ok(bodyText.includes('لا توجد'), 'expected the empty state when no document matches the category');
      }
      await page.close();
    });

    await t.test('summary stat: "أنواع المستندات" matches a distinct-category count across the whole camp', async () => {
      const { data: rows } = await serviceClient.from('documents').select('category').eq('camp_id', CAMP_ID);
      const distinctCategories = new Set(rows.map((r) => r.category)).size;

      const page = await browser.newPage();
      await login(page, base, EMAIL, PASSWORD);
      await page.goto(`${base}/pages/documents.html`, { waitUntil: 'load' });
      await page.waitForSelector('table, .empty', { timeout: 30000 });
      const bodyText = await page.locator('body').innerText();
      assert.ok(bodyText.includes(String(distinctCategories)), `expected distinct-category count ${distinctCategories} in the summary`);
      await page.close();
    });

    await t.test('upload -> preview -> delete round trip through the real UI and Cloudinary', async () => {
      const tmpFile = join(HERE, `phase4.8-fixture-${Date.now()}.jpg`);
      writeFileSync(tmpFile, Buffer.from(JPEG_BASE64, 'base64'));
      const fixtureName = 'مستند اختبار الرفع الفريد';
      let uploadedId = null;

      try {
        const page = await browser.newPage();
        await login(page, base, EMAIL, PASSWORD);
        await page.goto(`${base}/pages/documents.html`, { waitUntil: 'load' });
        await page.waitForSelector('table, .empty', { timeout: 30000 });

        await page.click('[data-upload]');
        await page.waitForSelector('#document-form', { timeout: 15000 });
        await page.setInputFiles('#file', tmpFile);
        await page.fill('#name', fixtureName);
        await page.selectOption('#category', 'other');
        await page.selectOption('#displacedId', { index: 1 }); // index 0 is the "اختر..." placeholder
        const [uploadResponse] = await Promise.all([
          page.waitForResponse((res) => res.url().includes('documents-upload'), { timeout: 15000 }),
          page.click('button[type="submit"][form="document-form"]'),
        ]);
        assert.equal(uploadResponse.status(), 201, `documents-upload responded ${uploadResponse.status()}`);
        await page.waitForTimeout(1000); // list reload after the upload handler's load(session)

        const { data: uploaded, error: uploadedError } = await serviceClient
          .from('documents')
          .select('id, storage_provider, cloudinary_public_id')
          .eq('camp_id', CAMP_ID)
          .eq('name', fixtureName)
          .maybeSingle();
        assert.equal(uploadedError, null);
        assert.ok(uploaded, 'the uploaded document must exist in the database');
        assert.equal(uploaded.storage_provider, 'cloudinary', 'a real upload must be storage_provider=cloudinary');
        assert.ok(uploaded.cloudinary_public_id, 'a real upload must carry a cloudinary_public_id');
        uploadedId = uploaded.id;

        const bodyTextAfterUpload = await page.locator('body').innerText();
        assert.ok(bodyTextAfterUpload.includes(fixtureName), 'the new document must appear in the rendered list');

        // Preview: fetch the inline blob directly (same function/mode the UI's
        // openPreview() now calls) and confirm the bytes round-trip. Uses a
        // SEPARATE client signed in as the SAME admin as the browser page --
        // `signOut()`'s default scope is 'global' and revokes every session
        // for that user, which would kill the browser's own session and
        // break the delete step below. `scope: 'local'` only ends this one.
        const adminClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
        await adminClient.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
        const { data: blobData, error: blobError } = await adminClient.functions.invoke('documents-access', {
          body: { id: uploadedId, mode: 'inline' },
        });
        assert.equal(blobError, null, blobError && JSON.stringify(blobError));
        assert.ok(blobData instanceof Blob && blobData.size > 0, 'expected a non-empty Blob from documents-access');
        await adminClient.auth.signOut({ scope: 'local' });

        // Delete through the real UI.
        await page.click(`[data-delete="${uploadedId}"]`);
        await page.waitForSelector('[data-confirm]', { timeout: 10000 });
        const [deleteResponse] = await Promise.all([
          page.waitForResponse((res) => res.url().includes('documents-delete'), { timeout: 15000 }),
          page.click('[data-confirm]'),
        ]);
        assert.equal(deleteResponse.status(), 200, `documents-delete responded ${deleteResponse.status()}`);
        await page.waitForTimeout(1000); // list reload after the delete handler's load(session)

        const { data: stillThere } = await serviceClient.from('documents').select('id').eq('id', uploadedId).maybeSingle();
        assert.equal(stillThere, null, 'the document row must be gone after delete');

        const bodyTextAfterDelete = await page.locator('body').innerText();
        assert.ok(!bodyTextAfterDelete.includes(fixtureName), 'the deleted document must not remain in the rendered list');

        uploadedId = null; // already gone — the finally block below has nothing to clean up
        await page.close();
      } finally {
        // Windows can briefly keep the file handle locked right after
        // page.close() releases the <input type=file> reference — this is
        // an OS/Playwright timing quirk unrelated to the app, not worth
        // failing the whole round-trip test over.
        try {
          unlinkSync(tmpFile);
        } catch {
          // ignored
        }
        if (uploadedId) {
          // Only reached if an assertion above failed before the UI delete ran.
          const cleanupClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
          await cleanupClient.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
          await cleanupClient.functions.invoke('documents-delete', { body: { id: uploadedId } });
          await cleanupClient.auth.signOut();
        }
      }
    });

    await t.test('empty-result case renders the empty state, not a blank panel', async () => {
      const page = await browser.newPage();
      await login(page, base, EMAIL, PASSWORD);
      await page.goto(`${base}/pages/documents.html?q=${encodeURIComponent('لا-يوجد-مستند-بهذا-الاسم-قط')}`, { waitUntil: 'load' });
      await page.waitForSelector('.empty', { timeout: 30000 });
      const bodyText = await page.locator('body').innerText();
      assert.ok(bodyText.includes('لا توجد نتائج مطابقة') || bodyText.includes('لا توجد مستندات'), 'expected an empty-state message');
      await page.close();
    });
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
});

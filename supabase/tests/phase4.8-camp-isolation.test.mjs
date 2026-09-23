// supabase/tests/phase4.8-camp-isolation.test.mjs
/**
 * Phase 4.8 cross-camp isolation: proves a Camp Admin cannot read, upload
 * into, update, or delete another camp's documents — through RLS and the
 * real documents-upload Edge Function directly, not merely "the UI doesn't
 * show it." Two throwaway 'pending'-storage fixture rows (no real Cloudinary
 * asset needed for these assertions) are inserted via a service-role client,
 * one per camp, and removed in `finally`.
 *
 *   cd supabase && npm run frontend:config && npm run test:phase4.8-camp-isolation
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

const CAMPS = {
  'admin@camps.ps': '5853adc9-9d23-4d4d-bc32-6fff17bdc3b0', // مخيم النور
  'nour@camps.ps': '05a29dd9-ae3f-4f4d-bcc3-05f0cd8b4405', // مخيم الرحمة
};
const PASSWORD = '123456';

test('Phase 4.8 documents cross-camp isolation', async (t) => {
  const SUPABASE_URL = required('SUPABASE_URL');
  const SUPABASE_PUBLISHABLE_KEY = required('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY');
  const SUPABASE_SECRET_KEY = required('SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY');

  const serviceClient = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);
  const server = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();

  const { data: memberNour } = await serviceClient
    .from('family_members')
    .select('id')
    .eq('camp_id', CAMPS['admin@camps.ps'])
    .limit(1)
    .single();
  const { data: memberRahma } = await serviceClient
    .from('family_members')
    .select('id')
    .eq('camp_id', CAMPS['nour@camps.ps'])
    .limit(1)
    .single();
  assert.ok(memberNour && memberRahma, 'both camps must have at least one family member seeded');

  // Fixtures: one 'pending'-storage row per camp — no real Cloudinary asset
  // needed for RLS/raw-query/rendered-list assertions (spec §8).
  const { data: fixtureNour, error: fxErrN } = await serviceClient
    .from('documents')
    .insert({
      name: 'اختبار عزل المخيمات - النور',
      category: 'other',
      camp_id: CAMPS['admin@camps.ps'],
      family_member_id: memberNour.id,
      storage_provider: 'pending',
    })
    .select('id')
    .single();
  assert.equal(fxErrN, null, `fixture insert (النور) must succeed: ${fxErrN?.message}`);

  const { data: fixtureRahma, error: fxErrR } = await serviceClient
    .from('documents')
    .insert({
      name: 'اختبار عزل المخيمات - الرحمة',
      category: 'other',
      camp_id: CAMPS['nour@camps.ps'],
      family_member_id: memberRahma.id,
      storage_provider: 'pending',
    })
    .select('id')
    .single();
  assert.equal(fxErrR, null, `fixture insert (الرحمة) must succeed: ${fxErrR?.message}`);

  try {
    await t.test("admin@camps.ps: RLS returns only own-camp documents, zero of camp الرحمة's", async () => {
      const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
      await client.auth.signInWithPassword({ email: 'admin@camps.ps', password: PASSWORD });
      const { data: allVisible } = await client.from('documents').select('id, camp_id');
      assert.ok(allVisible.length > 0, 'must see at least one own-camp document');
      assert.ok(
        allVisible.every((r) => r.camp_id === CAMPS['admin@camps.ps']),
        "must see zero of camp الرحمة's documents, including the fixture"
      );
      assert.ok(allVisible.some((r) => r.id === fixtureNour.id), 'must see its own camp\'s fixture');
      await client.auth.signOut();
    });

    await t.test("a raw update/delete on camp الرحمة's fixture — admin@camps.ps — affects zero rows", async () => {
      const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
      await client.auth.signInWithPassword({ email: 'admin@camps.ps', password: PASSWORD });

      const { data: updated, error: updateError } = await client
        .from('documents')
        .update({ name: 'محاولة تعديل مباشر' })
        .eq('id', fixtureRahma.id)
        .select();
      assert.equal(updateError, null, 'RLS-blocked update must not error, only match zero rows');
      assert.equal(updated.length, 0, "must not be able to update another camp's document directly");

      const { data: deleted, error: deleteError } = await client.from('documents').delete().eq('id', fixtureRahma.id).select();
      assert.equal(deleteError, null, 'RLS-blocked delete must not error, only match zero rows');
      assert.equal(deleted.length, 0, "must not be able to delete another camp's document directly");
      await client.auth.signOut();
    });

    await t.test('documents-upload with a family_member_id in another camp is rejected', async () => {
      const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
      await client.auth.signInWithPassword({ email: 'nour@camps.ps', password: PASSWORD }); // camp الرحمة

      const form = new FormData();
      form.set('file', new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'x.jpg', { type: 'image/jpeg' }));
      form.set('name', 'محاولة رفع عبر مخيم آخر');
      form.set('category', 'other');
      form.set('family_member_id', memberNour.id); // belongs to مخيم النور, not the caller's camp

      const { error } = await client.functions.invoke('documents-upload', { body: form });
      assert.ok(error, 'cross-camp upload must be rejected');
      await client.auth.signOut();
    });

    await t.test("rendered documents.html for nour@camps.ps never contains camp النور's fixture name", async () => {
      const page = await browser.newPage();
      await login(page, base, 'nour@camps.ps', PASSWORD);
      await page.goto(`${base}/pages/documents.html`, { waitUntil: 'load' });
      await page.waitForSelector('table, .empty', { timeout: 30000 });
      const bodyText = await page.locator('body').innerText();
      assert.ok(!bodyText.includes('اختبار عزل المخيمات - النور'), "must never render another camp's document name");
      assert.ok(bodyText.includes('اختبار عزل المخيمات - الرحمة'), "must render its own camp's fixture");
      await page.close();
    });
  } finally {
    await serviceClient.from('documents').delete().in('id', [fixtureNour.id, fixtureRahma.id]);
    await browser.close();
    await new Promise((r) => server.close(r));
  }
});

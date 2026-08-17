/**
 * Phase 3 document/Cloudinary security suite.
 *
 * Same approach as tests/rls.test.mjs and tests/phase2-business-logic.test.mjs:
 * real signed-in sessions over real HTTP against the live, seeded project —
 * this time calling the three Edge Functions (documents-upload,
 * documents-access, documents-delete) instead of PostgREST/RPC directly.
 * Needs the Cloudinary secrets to be configured on the project
 * (`supabase secrets set CLOUDINARY_CLOUD_NAME=... CLOUDINARY_API_KEY=...
 * CLOUDINARY_API_SECRET=...`) — see BACKEND.md's Phase 3 section.
 *
 * Two things this suite deliberately does NOT attempt, and why:
 *   - Forcing a genuine Cloudinary `destroy` failure (to prove metadata is
 *     kept when it does) isn't reproducible black-box: a bad public_id comes
 *     back "not found", which this project correctly treats as success
 *     ("already gone"), not a failure. Covered by code review instead —
 *     documents-delete/index.ts only deletes the metadata row when
 *     destroyOnCloudinary() returns true.
 *   - Forcing the metadata INSERT to fail after a successful Cloudinary
 *     upload (to prove orphan cleanup runs) needs a fault-injection hook this
 *     suite doesn't have. Covered by code review instead —
 *     documents-upload/index.ts calls destroyOnCloudinary() on the
 *     just-created public_id whenever the insert fails.
 *
 *   cd supabase && npm install
 *   npm run seed:reset
 *   npm run frontend:config    (not required for this suite, but harmless)
 *   npm run test:phase3
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');

loadDotEnv(resolve(ROOT, '.env'));

const URL = required('SUPABASE_URL');
const PUBLISHABLE = required('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY');
const SECRET = required('SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY');

const PASSWORD = '123456';

/** Seeded personas, matching tests/rls.test.mjs. */
const ACCOUNTS = {
  superAdmin: 'super@camps.ps',
  campAdminA: 'admin@camps.ps', // مخيم النور
  campAdminB: 'nour@camps.ps', // مخيم الرحمة
  displacedA: 'ahmad@camps.ps', // FAM-000001, مخيم النور
  displacedB: 'ibrahim@camps.ps', // FAM-000004, مخيم الرحمة
};

const admin = createClient(URL, SECRET, { auth: { autoRefreshToken: false, persistSession: false } });
const anon = createClient(URL, PUBLISHABLE, { auth: { autoRefreshToken: false, persistSession: false } });

const clients = {};
async function as(persona) {
  if (clients[persona]) return clients[persona];
  const client = createClient(URL, PUBLISHABLE, { auth: { autoRefreshToken: false, persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email: ACCOUNTS[persona], password: PASSWORD });
  assert.equal(error, null, `sign-in failed for ${persona}: ${error?.message}`);
  clients[persona] = client;
  return client;
}

const world = {};

/* ---- File fixtures --------------------------------------------------------
 * Real, tiny, genuinely decodable files — not just the right magic bytes.
 * Cloudinary validates actual image content on upload ("Invalid image
 * file"), so the truncated-header fixtures this suite started with upload
 * fine past this project's own magic-byte pre-check but are rejected by
 * Cloudinary itself. These are well-known 1x1 test fixtures.
 * ------------------------------------------------------------------------- */

function fromBase64(b64) {
  return Uint8Array.from(Buffer.from(b64, 'base64'));
}

const FIXTURES = {
  'image/jpeg': {
    name: 'id.jpg',
    bytes: fromBase64(
      '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k='
    ),
  },
  'image/png': {
    name: 'id.png',
    bytes: fromBase64(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    ),
  },
  'image/webp': {
    name: 'id.webp',
    bytes: fromBase64('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA=='),
  },
  'application/pdf': {
    name: 'id.pdf',
    bytes: new TextEncoder().encode(
      '%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 3 3]>>endobj\ntrailer<</Root 1 0 R/Size 4>>\n%%EOF\n'
    ),
  },
};

function fixtureFile(mime) {
  const f = FIXTURES[mime];
  return new File([f.bytes], f.name, { type: mime });
}

async function upload(client, { mime = 'image/jpeg', name = 'وثيقة اختبار', category = 'id_card', familyMemberId }) {
  const form = new FormData();
  form.set('file', fixtureFile(mime));
  form.set('name', name);
  form.set('category', category);
  if (familyMemberId) form.set('family_member_id', familyMemberId);
  return client.functions.invoke('documents-upload', { body: form });
}

function download(client, id, mode = 'inline') {
  return client.functions.invoke('documents-access', { body: { id, mode } });
}

function remove(client, id) {
  return client.functions.invoke('documents-delete', { body: { id } });
}

test('setup: resolve the seeded world', async () => {
  const { data: camps } = await admin.from('camps').select('id, name').order('created_at');
  assert.ok(camps.length >= 2, 'seed must contain at least two camps');
  world.campA = camps[0];
  world.campB = camps[1];

  const displacedA = await as('displacedA');
  const displacedB = await as('displacedB');

  const { data: membersA } = await displacedA.from('family_members').select('id, family_id, camp_id');
  const { data: membersB } = await displacedB.from('family_members').select('id, family_id, camp_id');
  assert.ok(membersA.length > 0 && membersB.length > 0, 'both displaced personas must resolve to a family');
  world.memberInA = membersA[0];
  world.memberInB = membersB[0];
  assert.notEqual(world.memberInA.camp_id, world.memberInB.camp_id, 'the two personas must be in different camps');
});

/* =============================================================================
   1 · Anonymous
   ========================================================================== */

test('anonymous: cannot call any document function', async () => {
  const { error: uploadError } = await upload(anon, { familyMemberId: world.memberInA.id });
  assert.ok(uploadError, 'anonymous upload succeeded');

  const { error: accessError } = await download(anon, '00000000-0000-0000-0000-000000000000');
  assert.ok(accessError, 'anonymous access succeeded');

  const { error: deleteError } = await remove(anon, '00000000-0000-0000-0000-000000000000');
  assert.ok(deleteError, 'anonymous delete succeeded');
});

/* =============================================================================
   2 · Camp isolation — upload
   ========================================================================== */

test('camp admin A: uploads a document for a member in their own camp', async () => {
  const client = await as('campAdminA');
  const { data, error } = await upload(client, { familyMemberId: world.memberInA.id });
  assert.equal(error, null, error && JSON.stringify(error));
  assert.ok(data.document.id);
  world.docInA = data.document.id;
});

test('camp admin A: cannot upload a document for a member in camp B', async () => {
  const client = await as('campAdminA');
  const { error } = await upload(client, { familyMemberId: world.memberInB.id });
  assert.ok(error, 'camp admin A uploaded into another camp');
});

/* =============================================================================
   3 · Displaced isolation — upload
   ========================================================================== */

test('displaced A: uploads a document for themselves', async () => {
  const client = await as('displacedA');
  const { data, error } = await upload(client, { familyMemberId: world.memberInA.id, category: 'medical_report' });
  assert.equal(error, null, error && JSON.stringify(error));
  assert.ok(data.document.id);
  world.docByDisplacedA = data.document.id;
});

test('displaced A: cannot upload a document for someone outside their family', async () => {
  const client = await as('displacedA');
  const { error } = await upload(client, { familyMemberId: world.memberInB.id });
  assert.ok(error, 'displaced A uploaded a document for another family');
});

/* =============================================================================
   4 · Download / preview — same authorization path (§18)
   ========================================================================== */

test('camp admin A: downloads a document from their own camp, bytes round-trip', async () => {
  const client = await as('campAdminA');
  const { data, error } = await download(client, world.docInA);
  assert.equal(error, null, error && JSON.stringify(error));
  assert.ok(data instanceof Blob, 'expected a Blob response');
  assert.ok(data.size > 0, 'downloaded an empty file');
});

test('camp admin A: cannot download a document from camp B', async () => {
  const clientB = await as('campAdminB');
  const { data: up, error: upErr } = await upload(clientB, { familyMemberId: world.memberInB.id });
  assert.equal(upErr, null, upErr && JSON.stringify(upErr));
  world.docInB = up.document.id;

  const clientA = await as('campAdminA');
  const { error } = await download(clientA, world.docInB);
  assert.ok(error, 'camp admin A downloaded a document from another camp');
});

test('displaced B: cannot download displaced A’s document', async () => {
  const client = await as('displacedB');
  const { error } = await download(client, world.docByDisplacedA);
  assert.ok(error, 'displaced B downloaded another family’s document');
});

test('displaced A: can download their own document', async () => {
  const client = await as('displacedA');
  const { data, error } = await download(client, world.docByDisplacedA);
  assert.equal(error, null, error && JSON.stringify(error));
  assert.ok(data instanceof Blob && data.size > 0);
});

/* =============================================================================
   5 · Delete — admin only, camp-scoped (§19, §26)
   ========================================================================== */

test('displaced A: cannot delete their own uploaded document', async () => {
  const client = await as('displacedA');
  const { error } = await remove(client, world.docByDisplacedA);
  assert.ok(error, 'a displaced person deleted a document');

  const { data: stillThere } = await admin.from('documents').select('id').eq('id', world.docByDisplacedA).maybeSingle();
  assert.ok(stillThere, 'metadata row was removed despite the rejected delete');
});

test('camp admin A: cannot delete a document in camp B', async () => {
  const client = await as('campAdminA');
  const { error } = await remove(client, world.docInB);
  assert.ok(error, 'camp admin A deleted a document in another camp');

  const { data: stillThere } = await admin.from('documents').select('id').eq('id', world.docInB).maybeSingle();
  assert.ok(stillThere, 'metadata row was removed despite the rejected cross-camp delete');
});

test('camp admin A: deletes a document in their own camp; it is gone from both stores', async () => {
  const client = await as('campAdminA');
  const { error } = await remove(client, world.docInA);
  assert.equal(error, null, error && JSON.stringify(error));

  const { data: stillThere } = await admin.from('documents').select('id').eq('id', world.docInA).maybeSingle();
  assert.equal(stillThere, null, 'metadata row survived a successful delete');

  const { error: reDownloadError } = await download(client, world.docInA);
  assert.ok(reDownloadError, 'the Cloudinary asset was still reachable after delete');
});

test('super admin: reaches documents in every camp', async () => {
  const client = await as('superAdmin');
  const { data, error } = await download(client, world.docInB);
  assert.equal(error, null, error && JSON.stringify(error));
  assert.ok(data instanceof Blob && data.size > 0);
});

/* =============================================================================
   6 · File validation (§11, §12, §37)
   ========================================================================== */

test('file validation: every allowed type uploads successfully', async () => {
  const client = await as('campAdminA');
  for (const mime of Object.keys(FIXTURES)) {
    const { data, error } = await upload(client, { mime, familyMemberId: world.memberInA.id, category: 'other' });
    assert.equal(error, null, `${mime}: ${error && JSON.stringify(error)}`);
    await remove(client, data.document.id); // clean up after ourselves
  }
});

test('file validation: an unsupported declared type is rejected', async () => {
  const client = await as('campAdminA');
  const file = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'archive.zip', { type: 'application/zip' });
  const form = new FormData();
  form.set('file', file);
  form.set('name', 'ملف مضغوط');
  form.set('category', 'other');
  form.set('family_member_id', world.memberInA.id);
  const { error } = await client.functions.invoke('documents-upload', { body: form });
  assert.ok(error, 'a .zip file was accepted');
});

test('file validation: declared MIME must match the real file content (magic bytes)', async () => {
  const client = await as('campAdminA');
  // An MZ (Windows executable) header, declared as a JPEG.
  const file = new File([new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00])], 'not-a-photo.jpg', {
    type: 'image/jpeg',
  });
  const form = new FormData();
  form.set('file', file);
  form.set('name', 'ليست صورة');
  form.set('category', 'other');
  form.set('family_member_id', world.memberInA.id);
  const { error } = await client.functions.invoke('documents-upload', { body: form });
  assert.ok(error, 'a renamed executable with a spoofed image/jpeg type was accepted');
});

test('file validation: a file over the size limit is rejected', async () => {
  const client = await as('campAdminA');
  const oversized = new Uint8Array(5 * 1024 * 1024 + 1);
  oversized.set([0xff, 0xd8, 0xff, 0xe0]); // valid jpeg header, only the size is wrong
  const file = new File([oversized], 'huge.jpg', { type: 'image/jpeg' });
  const form = new FormData();
  form.set('file', file);
  form.set('name', 'ملف كبير');
  form.set('category', 'other');
  form.set('family_member_id', world.memberInA.id);
  const { error } = await client.functions.invoke('documents-upload', { body: form });
  assert.ok(error, 'an oversized file was accepted');
});

/* =============================================================================
   helpers
   ========================================================================== */

function loadDotEnv(path) {
  let contents;
  try {
    contents = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const line of contents.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match && !(match[1] in process.env)) {
      process.env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
    }
  }
}

function required(...names) {
  for (const name of names) {
    if (process.env[name]) return process.env[name];
  }
  throw new Error(`Missing required env var: one of ${names.join(', ')}`);
}

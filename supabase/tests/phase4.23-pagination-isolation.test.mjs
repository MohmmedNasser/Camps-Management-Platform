/**
 * Phase 4.23 isolation: batched reads (fetchAll) never widen what RLS allows,
 * at any batch size, and the real browser data-access modules (run under a
 * signed-in session) return exactly the independent service-role row counts.
 *
 *   cd supabase && npm run frontend:config && npm run test:phase4.23-pagination-isolation
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile as readFileAsync } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };

for (const line of (() => { try { return readFileSync(resolve(ROOT, '.env'), 'utf8'); } catch { return ''; } })().split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
const required = (...names) => {
  for (const n of names) if (process.env[n]) return process.env[n];
  throw new Error(`Missing ${names.join(' or ')}`);
};
const URL_ = required('SUPABASE_URL');
const ANON = required('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY');
const SERVICE = required('SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY');
const PASSWORD = '123456';

const { fetchAll } = await import(pathToFileURL(resolve(ROOT, 'assets/js/supabase/query.js')).href);

function startServer() {
  return new Promise((done) => {
    const server = createServer(async (req, res) => {
      const safe = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
      for (const candidate of extname(safe) ? [safe] : [safe, `${safe}.html`]) {
        try {
          const file = join(ROOT, candidate);
          const body = await readFileAsync(file);
          res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
          res.end(body);
          return;
        } catch { /* next */ }
      }
      res.writeHead(404);
      res.end('not found');
    });
    server.listen(0, '127.0.0.1', () => done(server));
  });
}

async function signedIn(email) {
  const client = createClient(URL_, ANON, { auth: { persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  assert.equal(error, null, `${email} must sign in`);
  const { data: { user } } = await client.auth.getUser();
  const { data: profile } = await client.from('profiles').select('camp_id, family_member_id').eq('id', user.id).single();
  return { client, profile };
}
const service = createClient(URL_, SERVICE, { auth: { persistSession: false } });

async function browserLogin(page, base, email) {
  await page.goto(`${base}/pages/login.html`, { waitUntil: 'load' });
  await page.fill('#email', email);
  await page.fill('#password', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/dashboard/, { timeout: 15000 });
}

test('Phase 4.23 pagination isolation', async (t) => {
  const camps = [];
  for (const email of ['admin@camps.ps', 'nour@camps.ps']) camps.push({ email, ...(await signedIn(email)) });
  assert.notEqual(camps[0].profile.camp_id, camps[1].profile.camp_id, 'the two camp admins must be in different camps');

  for (const batchSize of [1, 3, 1000]) {
    for (const [i, admin] of camps.entries()) {
      const other = camps[1 - i].profile.camp_id;
      await t.test(`${admin.email}: batched reads at batchSize ${batchSize} never include another camp`, async () => {
        for (const table of ['family_members', 'families', 'aid_distributions', 'documents', 'messages', 'registration_requests']) {
          const rows = await fetchAll(() => admin.client.from(table).select('id, camp_id'), { order: ['id'], batchSize });
          assert.ok(rows.every((r) => r.camp_id === admin.profile.camp_id), `${table}: only own camp`);
          assert.ok(!rows.some((r) => r.camp_id === other), `${table}: zero rows from the other camp`);
          const { count } = await service.from(table).select('id', { count: 'exact', head: true }).eq('camp_id', admin.profile.camp_id);
          assert.equal(rows.length, count, `${table}: complete own-camp set`);
        }
      });
    }
  }

  await t.test('displaced: batched reads return only the own family', async () => {
    const ahmad = await signedIn('ahmad@camps.ps');
    const { data: me } = await service.from('family_members').select('family_id').eq('id', ahmad.profile.family_member_id).single();
    const members = await fetchAll(() => ahmad.client.from('family_members').select('id, family_id'), { order: ['id'], batchSize: 2 });
    assert.ok(members.length > 0 && members.every((m) => m.family_id === me.family_id));
    const docs = await fetchAll(() => ahmad.client.from('documents').select('id, family_id'), { order: ['id'], batchSize: 2 });
    assert.ok(docs.every((d) => d.family_id === me.family_id));
    const notes = await fetchAll(() => ahmad.client.from('notifications').select('id, recipient_id'), { order: ['id'], batchSize: 2 });
    const { data: { user } } = await ahmad.client.auth.getUser();
    assert.ok(notes.every((n) => n.recipient_id === user.id));
  });

  await t.test('anonymous batched reads return nothing (or are rejected) exactly as before', async () => {
    const anon = createClient(URL_, ANON, { auth: { persistSession: false } });
    for (const table of ['family_members', 'families', 'aid_distributions', 'documents', 'messages', 'notifications']) {
      let rows = [];
      try {
        rows = await fetchAll(() => anon.from(table).select('id'), { order: ['id'], batchSize: 3 });
      } catch { /* rejection is also denial */ }
      assert.equal(rows.length, 0, `${table}: anon sees no rows`);
    }
  });

  await t.test('super admin batched reads equal the platform-wide independent counts', async () => {
    const sup = await signedIn('super@camps.ps');
    for (const table of ['family_members', 'families', 'aid_distributions', 'documents']) {
      const rows = await fetchAll(() => sup.client.from(table).select('id'), { order: ['id'], batchSize: 4 });
      const { count } = await service.from(table).select('id', { count: 'exact', head: true });
      assert.equal(rows.length, count, table);
    }
  });

  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  try {
    await t.test('in-browser data-access modules return the independent counts (camp admin)', async () => {
      const admin = camps[0];
      const page = await browser.newPage();
      const problems = [];
      page.on('pageerror', (e) => problems.push(e.message));
      await browserLogin(page, base, admin.email);
      const got = await page.evaluate(async (campId) => {
        const [fam, dis, aid, doc, msg, req] = await Promise.all([
          import('/assets/js/supabase/families.js').then((m) => m.getCampFamilies(campId)),
          import('/assets/js/supabase/family-members.js').then((m) => m.getCampDisplacedPersons(campId)),
          import('/assets/js/supabase/aids.js').then((m) => m.getCampAidDistributions(campId)),
          import('/assets/js/supabase/documents.js').then((m) => m.getCampDocuments(campId)),
          import('/assets/js/supabase/messages.js').then((m) => m.getCampMessages(campId)),
          import('/assets/js/supabase/registration-requests.js').then((m) => m.getCampRegistrationRequests(campId)),
        ]);
        const dash = await import('/assets/js/supabase/dashboard.js');
        return {
          families: fam.length, displaced: dis.length, aid: aid.length, documents: doc.length, messages: msg.length,
          requests: req.length, gender: await dash.getGenderBreakdown(campId),
          sizes: (await dash.getFamilySizeDistribution(campId)).reduce((n, b) => n + b.count, 0),
          famIds: new Set(fam.map((f) => f.id)).size, disIds: new Set(dis.map((d) => d.id)).size,
        };
      }, admin.profile.camp_id);
      const count = async (table, extra = (q) => q) => (await extra(service.from(table).select('id', { count: 'exact', head: true }).eq('camp_id', admin.profile.camp_id))).count;
      assert.equal(got.families, await count('families'));
      assert.equal(got.famIds, got.families, 'no duplicate families');
      assert.equal(got.displaced, await count('family_members'));
      assert.equal(got.disIds, got.displaced, 'no duplicate members');
      assert.equal(got.aid, await count('aid_distributions'));
      assert.equal(got.documents, await count('documents'));
      assert.equal(got.messages, await count('messages'));
      assert.equal(got.requests, await count('registration_requests'));
      assert.equal(got.gender.males, await count('family_members', (q) => q.eq('gender', 'male')));
      assert.equal(got.gender.females, await count('family_members', (q) => q.eq('gender', 'female')));
      assert.equal(got.sizes, got.families, 'family-size buckets cover every family exactly once');
      assert.deepEqual(problems, []);
      await page.close();
    });
  } finally {
    await browser.close();
    server.close();
  }
});

// supabase/tests/phase4.17-family-activation-verification.test.mjs
/**
 * Phase 4.17 end-to-end verification: the full real flow — Camp Admin
 * registers a family, generates an activation link, the head activates it,
 * the identity chain (auth.uid() -> profiles -> family_member_id ->
 * family_members -> families) resolves correctly, the account can log out
 * and log back in, and every test-created row is removed afterward.
 *
 *   cd supabase && npm run test:phase4.17-family-activation-verification
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

const SUPABASE_URL = required('SUPABASE_URL');
const SUPABASE_PUBLISHABLE_KEY = required('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY');
const SUPABASE_SECRET_KEY = required('SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY');
const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/activate-family-account`;
const NOOR_CAMP_ID = '5853adc9-9d23-4d4d-bc32-6fff17bdc3b0'; // مخيم النور — admin@camps.ps

const service = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

async function clientAs(email, password) {
  const client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
  const { error } = await client.auth.signInWithPassword({ email, password });
  assert.equal(error, null, `sign-in for ${email} must succeed: ${error?.message}`);
  return client;
}

function randomNationalId() {
  return String(900000000 + Math.floor(Math.random() * 99999999));
}

async function activate(body) {
  const res = await fetch(FUNCTION_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_PUBLISHABLE_KEY },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };

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

async function loginPage(page, base, email, password) {
  await page.goto(`${base}/pages/login.html`, { waitUntil: 'load' });
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/dashboard/, { timeout: 15000 });
}

async function baselineCounts() {
  const [{ count: profiles }, { count: families }] = await Promise.all([
    service.from('profiles').select('*', { count: 'exact', head: true }),
    service.from('families').select('*', { count: 'exact', head: true }),
  ]);
  return { profiles, families };
}

test('Phase 4.17 end-to-end: register -> generate link -> activate -> login -> dashboard data -> logout -> login again', async (t) => {
  const before = await baselineCounts();

  const admin = await clientAs('admin@camps.ps', '123456');
  const nationalId = randomNationalId();
  const headName = 'رب أسرة التحقق الشامل';
  const birthDate = '1978-03-15';
  const email = `phase417-e2e-${Date.now()}@example.com`;
  const password = 'Fixture123!Strong';

  let familyDbId = null;
  let newUserId = null;

  try {
    await t.test('Camp Admin registers a family through the real workflow function', async () => {
      const { data, error } = await admin.rpc('create_family_with_members', {
        p_camp_id: NOOR_CAMP_ID,
        p_head: { full_name: headName, gender: 'male', national_id: nationalId, birth_date: birthDate },
        p_members: [
          { full_name: 'زوجة رب الأسرة', gender: 'female', national_id: randomNationalId(), birth_date: '1980-06-01', relationship: 'spouse' },
        ],
        p_notes: 'Phase 4.17 end-to-end test fixture — safe to delete',
      });
      assert.equal(error, null, `family creation must succeed: ${error?.message}`);
      familyDbId = data;
    });

    let referenceCode;
    let headMemberId;

    await t.test('Camp Admin generates an activation link for that family', async () => {
      const { data: family } = await service
        .from('families')
        .select('reference_code, head_member_id, camp_id')
        .eq('id', familyDbId)
        .single();
      referenceCode = family.reference_code;
      headMemberId = family.head_member_id;
      assert.equal(family.camp_id, NOOR_CAMP_ID);
    });

    let token;
    await t.test('the link carries a fresh, single-use token', async () => {
      const { data, error } = await admin.rpc('generate_family_activation_token', { p_family_id: familyDbId });
      assert.equal(error, null);
      token = data[0].token;
      assert.match(token, /^[0-9a-f]{64}$/);
    });

    await t.test('the head opens the link, enters identity data, and activates the account', async () => {
      const { status, json } = await activate({
        token,
        referenceCode,
        nationalId,
        birthDate,
        email,
        password,
      });
      assert.equal(status, 201, JSON.stringify(json));
    });

    await t.test('a real Supabase Auth account now exists, correctly linked', async () => {
      const { data: authUsers } = await service.auth.admin.listUsers({ page: 1, perPage: 200 });
      const authUser = authUsers.users.find((u) => u.email === email);
      assert.ok(authUser, 'Auth account must exist');
      newUserId = authUser.id;

      const { data: profile } = await service
        .from('profiles')
        .select('role, status, camp_id, family_member_id, full_name')
        .eq('id', newUserId)
        .single();
      assert.equal(profile.role, 'displaced');
      assert.equal(profile.status, 'approved');
      assert.equal(profile.camp_id, NOOR_CAMP_ID);
      assert.equal(profile.family_member_id, headMemberId);
      assert.equal(profile.full_name, headName);
    });

    await t.test('the identity chain resolves the correct family/camp/members (the same chain dashboard.js/family-details.js use)', async () => {
      const displaced = await clientAs(email, password);

      const { data: me } = await displaced.from('profiles').select('family_member_id, camp_id').eq('id', newUserId).single();
      assert.equal(me.family_member_id, headMemberId);

      const { data: person } = await displaced
        .from('family_members')
        .select('id, family_id, full_name')
        .eq('id', me.family_member_id)
        .single();
      assert.equal(person.full_name, headName);

      // families<->family_members has two FK relationships (family_id, and
      // the reverse head_member_id), so the embed must name which one —
      // same reason assets/js/supabase/families.js's getFamilyByReferenceCode()
      // spells out `family_members!family_members_family_id_fkey`.
      const { data: family, error: familyError } = await displaced
        .from('families')
        .select('reference_code, camp_id, family_members!family_members_family_id_fkey(full_name)')
        .eq('id', person.family_id)
        .single();
      assert.equal(familyError, null, `expected success: ${familyError?.message}`);
      assert.equal(family.reference_code, referenceCode);
      assert.equal(family.camp_id, NOOR_CAMP_ID);
      assert.equal(family.family_members.length, 2, 'both the head and the spouse must be visible to the new account');

      await displaced.auth.signOut();
    });

    await t.test('duplicate activation of the same (now-activated) family is rejected, no second account', async () => {
      const { data: relinkToken } = await admin.rpc('generate_family_activation_token', { p_family_id: familyDbId });
      const { status, json } = await activate({
        token: relinkToken[0].token,
        referenceCode,
        nationalId,
        birthDate,
        email: `phase417-dup-${Date.now()}@example.com`,
        password,
      });
      assert.equal(status, 409);
      assert.equal(json.error.code, 'already_activated');

      const { data: profiles } = await service.from('profiles').select('id').eq('family_member_id', headMemberId);
      assert.equal(profiles.length, 1, 'still exactly one account for this head');
    });

    await t.test('logout, then login again reaches the same account and data', async () => {
      const first = await clientAs(email, password);
      await first.auth.signOut();

      const second = await clientAs(email, password);
      const { data: session } = await second.auth.getSession();
      assert.ok(session.session, 'a session must be established on re-login');
      assert.equal(session.session.user.id, newUserId);

      const { data: profile } = await second.from('profiles').select('status, family_member_id').eq('id', newUserId).single();
      assert.equal(profile.status, 'approved');
      assert.equal(profile.family_member_id, headMemberId);
      await second.auth.signOut();
    });
  } finally {
    if (newUserId) await service.auth.admin.deleteUser(newUserId).catch(() => {});
    if (familyDbId) await service.from('families').delete().eq('id', familyDbId);
  }

  await t.test('database baseline is restored — no test debris', async () => {
    const after = await baselineCounts();
    assert.equal(after.profiles, before.profiles, 'profiles count must return to baseline');
    assert.equal(after.families, before.families, 'families count must return to baseline');
  });
});

test('Phase 4.17 real browser: Camp Admin generates a link -> a signed-out visitor activates it -> logout -> login again', async (t) => {
  const server = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch();

  const admin = await clientAs('admin@camps.ps', '123456');
  const nationalId = randomNationalId();
  const headName = 'رب أسرة المتصفح الحقيقي';
  const birthDate = '1982-11-20';
  const email = `phase417-browser-${Date.now()}@example.com`;
  const password = 'Fixture123!Strong';
  let familyDbId = null;
  let referenceCode = null;
  let newUserId = null;
  const consoleErrors = [];

  try {
    const { data: familyId, error } = await admin.rpc('create_family_with_members', {
      p_camp_id: NOOR_CAMP_ID,
      p_head: { full_name: headName, gender: 'male', national_id: nationalId, birth_date: birthDate },
      p_notes: 'Phase 4.17 browser test fixture — safe to delete',
    });
    assert.equal(error, null, `family creation must succeed: ${error?.message}`);
    familyDbId = familyId;
    const { data: family } = await service.from('families').select('reference_code').eq('id', familyDbId).single();
    referenceCode = family.reference_code;

    let activationUrl;

    await t.test('Camp Admin generates the activation link from family-details.html', async () => {
      const adminPage = await browser.newPage();
      adminPage.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(`[admin] ${msg.text()}`);
      });
      adminPage.on('pageerror', (err) => consoleErrors.push(`[admin pageerror] ${err.message}`));

      await loginPage(adminPage, base, 'admin@camps.ps', '123456');
      await adminPage.goto(`${base}/pages/family-details.html?id=${referenceCode}`, { waitUntil: 'load' });
      await adminPage.waitForSelector('[data-activate]', { timeout: 15000 });
      await adminPage.click('[data-activate]');
      await adminPage.waitForSelector('[data-generate]', { timeout: 10000 });
      await adminPage.click('[data-generate]');
      await adminPage.waitForSelector('[data-activation-url]', { timeout: 10000 });
      activationUrl = await adminPage.locator('[data-activation-url]').inputValue();
      assert.match(activationUrl, /activate-family\.html\?token=[0-9a-f]{64}$/, `unexpected URL shape: ${activationUrl}`);
      await adminPage.close();
    });

    await t.test('a signed-out visitor opens the link and activates the account, no console errors', async () => {
      const context = await browser.newContext(); // fresh storage — no session, like a real recipient
      const page = await context.newPage();
      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(`[activate] ${msg.text()}`);
      });
      page.on('pageerror', (err) => consoleErrors.push(`[activate pageerror] ${err.message}`));

      await page.goto(activationUrl, { waitUntil: 'load' });
      await page.waitForSelector('#activate-form', { timeout: 15000 });
      await page.fill('#referenceCode', referenceCode);
      await page.fill('#nationalId', nationalId);
      await page.fill('#birthDate', birthDate);
      await page.fill('#email', email);
      await page.fill('#password', password);
      await page.fill('#passwordConfirm', password);
      await page.click('button[type="submit"]');
      await page.waitForURL(/dashboard/, { timeout: 20000 });
      await page.waitForSelector('.stat', { timeout: 15000 });
      await page.waitForTimeout(300);

      const bodyText = await page.locator('body').innerText();
      assert.ok(bodyText.includes(headName) || bodyText.includes('النور'), 'the new dashboard must reflect the activated head/camp');

      assert.equal(consoleErrors.length, 0, `no console errors expected: ${JSON.stringify(consoleErrors)}`);
      await context.close();
    });

    await t.test('both URL styles (.html and extensionless) load the activation form for a fresh token', async () => {
      const { data: reToken } = await admin.rpc('generate_family_activation_token', { p_family_id: familyDbId });
      const token = reToken[0].token;

      for (const path of [`/pages/activate-family.html?token=${token}`, `/pages/activate-family?token=${token}`]) {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(`${base}${path}`, { waitUntil: 'load' });
        await page.waitForSelector('#activate-form', { timeout: 15000 });
        assert.ok(await page.locator('#referenceCode').count(), `${path} must render the activation form`);
        await context.close();
      }
      // Family is already activated; this fresh token is never consumed — no
      // extra account fixture to clean up beyond the family delete below.
    });

    await t.test('responsive: no horizontal overflow on the activation page at any required breakpoint', async () => {
      const { data: reToken } = await admin.rpc('generate_family_activation_token', { p_family_id: familyDbId });
      const token = reToken[0].token;
      const context = await browser.newContext();
      const page = await context.newPage();
      for (const width of [320, 375, 414, 768, 1024, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`${base}/pages/activate-family.html?token=${token}`, { waitUntil: 'load' });
        await page.waitForSelector('#activate-form', { timeout: 15000 });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.ok(overflow <= 1, `horizontal overflow of ${overflow}px at width ${width}`);
      }
      await context.close();
    });

    await t.test('logout, then login again with the chosen credentials reaches the dashboard', async () => {
      const { data: authUsers } = await service.auth.admin.listUsers({ page: 1, perPage: 200 });
      newUserId = authUsers.users.find((u) => u.email === email)?.id;
      assert.ok(newUserId, 'the activated account must exist for this check');

      const page = await browser.newPage();
      await loginPage(page, base, email, password);
      await page.click('[data-dropdown="user"] .dropdown__trigger');
      await page.click('[data-logout]');
      await page.waitForSelector('[data-confirm]', { timeout: 10000 });
      await page.click('[data-confirm]');
      await page.waitForURL(/login/, { timeout: 15000 });

      await loginPage(page, base, email, password);
      assert.match(page.url(), /dashboard/);
      await page.close();
    });
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
    if (newUserId) await service.auth.admin.deleteUser(newUserId).catch(() => {});
    if (familyDbId) await service.from('families').delete().eq('id', familyDbId);
  }
});

// One-off, disposable script for Phase 4.1 Task 14 Step 2 — NOT part of the
// permanent test suite. Verifies the ProfileError fail-closed path using a
// throwaway account (never a seeded persona), then cleans up after itself.
//
// Creates the throwaway user via the Admin API (service role) rather than
// the public register.html signUp flow: the public flow is already proven
// live and working (Task 13's suite drives real signIn/signOut through it),
// and Supabase Auth's email-send rate limit — a platform safety limit, not
// a bug — makes repeated public signUps unreliable for a quick disposable
// check. Admin-created users are how supabase/seed/seed.mjs already creates
// every seeded persona, so this is an established, in-scope pattern.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };

const envText = readFileSync(join(ROOT, '.env'), 'utf8');
const env = Object.fromEntries(
  envText.split('\n').filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);

const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY);

function startServer() {
  return new Promise((resolvePromise) => {
    const server = createServer(async (req, res) => {
      const safePath = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
      const candidates = extname(safePath) ? [safePath] : [safePath, `${safePath}.html`];
      for (const candidate of candidates) {
        try {
          const filePath = join(ROOT, candidate);
          const body = await readFile(filePath);
          res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
          res.end(body);
          return;
        } catch {}
      }
      res.writeHead(404);
      res.end('not found');
    });
    server.listen(0, '127.0.0.1', () => resolvePromise(server));
  });
}

const email = `phase4-test-${Date.now()}@gmail.com`;
const password = 'Test123456!';
let userId = null;

const server = await startServer();
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch();

try {
  // 1. Create a throwaway, pre-confirmed auth user via the Admin API — the
  //    on_auth_user_created trigger still fires, creating its profile row
  //    exactly as it would for a real sign-up.
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createErr) throw createErr;
  userId = created.user.id;
  console.log('OK: created throwaway auth user + trigger-created profile (id=' + userId + ')');

  // 2. Delete only its profile row (disposable data, not a seeded persona).
  const { error: delProfileErr } = await admin.from('profiles').delete().eq('id', userId);
  if (delProfileErr) throw delProfileErr;
  console.log('OK: deleted the throwaway profile row');

  // 3. Sign in as that account through the real login.html and confirm it
  //    fails closed to auth-error.html — never a guessed role.
  const page = await browser.newPage();
  await page.goto(`${base}/pages/login.html`, { waitUntil: 'load' });
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/auth-error/, { timeout: 15000 });
  console.log('PASS: signing in with a missing profile landed on auth-error.html — never a guessed role');
  await page.close();
} finally {
  if (userId) {
    const { error: delUserErr } = await admin.auth.admin.deleteUser(userId);
    if (delUserErr) console.error('CLEANUP WARNING: failed to delete throwaway auth user:', delUserErr.message);
    else console.log('OK: cleaned up — throwaway auth user deleted');
  }
  await browser.close();
  server.close();
}

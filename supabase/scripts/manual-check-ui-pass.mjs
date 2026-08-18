// One-off, disposable script for Phase 4.1 Task 14 Step 3 — approximates
// CLAUDE.md's manual UI pass (console errors, no horizontal scroll across
// breakpoints, keyboard Esc-closes-modal) via Playwright, since this
// environment has no interactive browser to eyeball directly.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, normalize, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };

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

const BREAKPOINTS = [320, 375, 414, 768, 1024, 1440];
const server = await startServer();
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch();
let failures = 0;

async function login(page, email, password) {
  await page.goto(`${base}/pages/login.html`, { waitUntil: 'load' });
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/dashboard/, { timeout: 15000 });
}

async function checkNoConsoleErrors(page, label) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  await page.waitForTimeout(500);
  if (errors.length) {
    console.error(`FAIL [${label}] console errors:`, errors);
    failures++;
  } else {
    console.log(`OK [${label}] no console errors`);
  }
}

async function checkNoHorizontalScroll(page, label) {
  for (const width of BREAKPOINTS) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(150);
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    if (scrollWidth > clientWidth + 1) {
      console.error(`FAIL [${label}] horizontal scroll at ${width}px: scrollWidth=${scrollWidth} clientWidth=${clientWidth}`);
      failures++;
    } else {
      console.log(`OK [${label}] no horizontal scroll at ${width}px`);
    }
  }
}

try {
  // login.html, register.html, auth-error.html — no console errors.
  for (const [url, label] of [
    [`${base}/pages/login.html`, 'login.html'],
    [`${base}/pages/register.html`, 'register.html'],
    [`${base}/pages/auth-error.html`, 'auth-error.html'],
  ]) {
    const page = await browser.newPage();
    await checkNoConsoleErrors(page, label);
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForTimeout(800);
    await checkNoHorizontalScroll(page, label);
    await page.close();
  }

  // dashboard.html per role — no console errors, no horizontal scroll.
  for (const [email, roleLabel] of [
    ['super@camps.ps', 'dashboard (super_admin)'],
    ['admin@camps.ps', 'dashboard (camp_admin)'],
    ['ahmad@camps.ps', 'dashboard (displaced)'],
  ]) {
    const page = await browser.newPage();
    await checkNoConsoleErrors(page, roleLabel);
    await login(page, email, '123456');
    await checkNoHorizontalScroll(page, roleLabel);
    await page.close();
  }

  // Keyboard: Esc closes the logout confirm dialog.
  {
    const page = await browser.newPage();
    await login(page, 'super@camps.ps', '123456');
    await page.click('[data-dropdown="user"] .dropdown__trigger');
    await page.click('[data-logout]');
    await page.waitForSelector('.modal', { timeout: 5000 });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const modalStillOpen = await page.locator('.modal').count();
    if (modalStillOpen > 0) {
      console.error('FAIL [keyboard] Esc did not close the logout confirm dialog');
      failures++;
    } else {
      console.log('OK [keyboard] Esc closes the logout confirm dialog');
    }
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

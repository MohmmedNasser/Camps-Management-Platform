/**
 * Browser smoke test for the Phase 2 data-access layer.
 *
 * tests/phase2-business-logic.test.mjs exercises the RPCs and RLS directly
 * via the npm @supabase/supabase-js package, because Node cannot resolve
 * the `https://esm.sh/...` CDN import inside assets/js/core/supabase-client.js.
 * This test is the one place that actually loads the real
 * assets/js/supabase/*.js files, in a real browser, the way a page would.
 *
 * Uses a tiny inline node:http static server rather than shelling out to
 * `npx serve`: spawning an external CLI here proved fragile in this
 * environment (a first-run npx install prompt hung indefinitely, and
 * `TaskStop`-killing the parent shell left the grandchild `serve` process
 * running and holding the port for later runs). A same-process server has
 * no such failure mode and needs no cleanup between runs.
 *
 *   cd supabase && npm run frontend:config && npm run test:browser-smoke
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, normalize, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..'); // repo root — index.html, assets/, pages/, supabase/

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };

function startServer() {
  return new Promise((resolvePromise) => {
    const server = createServer(async (req, res) => {
      const safePath = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
      const filePath = join(ROOT, safePath);
      try {
        const body = await readFile(filePath);
        res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end('not found');
      }
    });
    server.listen(0, '127.0.0.1', () => resolvePromise(server));
  });
}

test('camp admin: signed-in browser session loads camps and own-camp families', async () => {
  const server = await startServer();
  const port = server.address().port;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    await page.goto(`http://127.0.0.1:${port}/supabase/tests/browser-smoke.html`, {
      timeout: 15000,
      waitUntil: 'load',
    });

    const result = await Promise.race([
      page.evaluate((email) => window.__runSmoke(email), 'admin@camps.ps'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('window.__runSmoke timed out')), 20000)),
    ]);

    assert.deepEqual(pageErrors, [], `unexpected page errors: ${pageErrors.join('; ')}`);
    assert.ok(result.campsCount > 0, 'camps list should not be empty');
    assert.ok(result.familiesTotal >= result.familiesRows, 'total should be >= one page of rows');
  } finally {
    await browser.close();
    server.close();
  }
});

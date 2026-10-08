/**
 * Inlines assets/css/main.css's @import list into main.css itself, at deploy
 * time only.
 *
 * Locally main.css stays a list of @imports (one file per concern, no build
 * step). Served that way, though, the browser only discovers the nine
 * imported files after main.css arrives, then fetches them as a second
 * render-blocking round trip — the largest item in Lighthouse's mobile
 * "render-blocking requests". One concatenated file removes that round trip.
 *
 * It rewrites main.css IN PLACE (Vercel serves the repo root as-is), so it
 * refuses to run outside Vercel unless forced — running it in a working copy
 * would replace the source file with the bundle.
 *
 *   node supabase/scripts/bundle-css.mjs            # on Vercel (VERCEL=1)
 *   node supabase/scripts/bundle-css.mjs --force    # anywhere, e.g. to inspect
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS_DIR = resolve(HERE, '../../assets/css');
const ENTRY = resolve(CSS_DIR, 'main.css');
const IMPORT = /^@import url\("\.\/([\w-]+\.css)"\);\s*$/gm;

if (!process.env.VERCEL && !process.argv.includes('--force')) {
  process.stdout.write('  bundle-css: not on Vercel, main.css left as @imports (pass --force to bundle anyway)\n');
  process.exit(0);
}

const entry = readFileSync(ENTRY, 'utf8');
const files = [...entry.matchAll(IMPORT)].map((match) => match[1]);

if (files.length === 0) {
  process.stdout.write('  bundle-css: main.css has no @imports, nothing to do\n');
  process.exit(0);
}

// Each import is replaced where it stands, so the cascade order main.css
// documents (tokens → base → … → responsive) is preserved exactly.
const bundle = entry.replace(IMPORT, (_, file) => {
  const css = readFileSync(resolve(CSS_DIR, file), 'utf8');
  if (/^\s*@import\b/m.test(css)) fail(`${file} has its own @import, which a flat bundle would misplace`);
  return `/* ---- ${file} ---- */\n${css.trimEnd()}\n`;
});

writeFileSync(ENTRY, bundle, 'utf8');
process.stdout.write(`  bundle-css: inlined ${files.length} files into main.css (${Buffer.byteLength(bundle)} bytes)\n`);

function fail(message) {
  process.stderr.write(`\n  ✖ bundle-css: ${message}\n\n`);
  process.exit(1);
}

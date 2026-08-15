/**
 * Page guards.
 *
 * Runs before any in-app page renders: no session -> login, pending or
 * rejected account -> its status screen, role without access -> 404.
 * The Next.js port replaces this with middleware; the rules stay identical.
 */

import { getSession } from './auth.js';
import { ROLES, STATUS, PAGE_ACCESS } from './config.js';

/** Last path segment, e.g. "displaced-details.html" or "displaced". */
function lastSegment() {
  return window.location.pathname.split('/').pop();
}

/**
 * True when this document was served without a `.html` extension.
 *
 * Static hosts that rewrite clean URLs (`serve`, Vercel, Netlify, GitHub
 * Pages) redirect `foo.html` to `foo` — and that redirect **drops the query
 * string**, which would silently strip every `?id=` the app navigates with.
 * So the app matches whichever form it was loaded in and never triggers the
 * redirect in the first place.
 */
function cleanUrls() {
  const name = lastSegment();
  return Boolean(name) && !name.includes('.');
}

/**
 * Page key of the current document, always with the `.html` suffix that
 * `PAGE_ACCESS` and `NAVIGATION` are keyed by — regardless of whether the host
 * served it as `displaced.html` or `displaced`. Getting this wrong makes
 * `PAGE_ACCESS[page]` undefined, which silently lets every role through.
 */
export function currentPage() {
  const name = lastSegment();
  if (!name) return 'index.html';
  return name.includes('.') ? name : `${name}.html`;
}

/** True when the current document sits inside /pages/. */
function inPagesDir() {
  return window.location.pathname.includes('/pages/');
}

/**
 * Build a URL to a page from wherever we are.
 *
 * `page` may already carry a query (notification hrefs do), in which case the
 * two sets of parameters are merged rather than concatenated.
 */
export function pageUrl(page, params = {}) {
  const prefix = inPagesDir() ? '' : 'pages/';
  const [rawFile, rawQuery = ''] = String(page).split('?');
  const file = cleanUrls() ? rawFile.replace(/\.html$/, '') : rawFile;

  const search = new URLSearchParams(rawQuery);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') search.set(key, value);
  });

  const query = search.toString();
  return `${prefix}${file}${query ? `?${query}` : ''}`;
}

export function go(page, params) {
  window.location.href = pageUrl(page, params);
}

export function replace(page, params) {
  window.location.replace(pageUrl(page, params));
}

/** Where a signed-in user lands. */
export function homeFor(session) {
  if (!session) return 'login.html';
  if (session.status === STATUS.PENDING) return 'pending.html';
  if (session.status === STATUS.REJECTED) return 'rejected.html';
  return 'dashboard.html';
}

/**
 * Guard the current page.
 * @returns {object|null} the session when access is granted; null after a redirect.
 */
export function guard({ page = currentPage() } = {}) {
  const session = getSession();

  if (!session) {
    replace('login.html');
    return null;
  }

  if (session.status === STATUS.PENDING && page !== 'pending.html') {
    replace('pending.html');
    return null;
  }

  if (session.status === STATUS.REJECTED && page !== 'rejected.html') {
    replace('rejected.html');
    return null;
  }

  const allowed = PAGE_ACCESS[page];
  if (allowed && !allowed.includes(session.role)) {
    replace('404.html');
    return null;
  }

  return session;
}

/** Guard for auth screens: a signed-in user should not see the login form. */
export function guestOnly() {
  const session = getSession();
  if (session) {
    replace(homeFor(session));
    return true;
  }
  return false;
}

export { ROLES, STATUS };

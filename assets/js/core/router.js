/**
 * Page guards.
 *
 * Runs before any in-app page renders: no session -> login, pending or
 * rejected account -> its status screen, role without access -> 404.
 * The Next.js port replaces this with middleware; the rules stay identical.
 */

import { getSession } from './auth.js';
import { ROLES, STATUS, PAGE_ACCESS } from './config.js';

/** File name of the current page, e.g. "displaced-details.html". */
export function currentPage() {
  const name = window.location.pathname.split('/').pop();
  return name && name.includes('.') ? name : 'index.html';
}

/** True when the current document sits inside /pages/. */
function inPagesDir() {
  return window.location.pathname.includes('/pages/');
}

/** Build a URL to a page from wherever we are. */
export function pageUrl(page, params = {}) {
  const prefix = inPagesDir() ? '' : 'pages/';
  const search = new URLSearchParams(
    Object.entries(params).filter(([, value]) => value !== undefined && value !== null && value !== '')
  ).toString();
  return `${prefix}${page}${search ? `?${search}` : ''}`;
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

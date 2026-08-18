/**
 * Session, role and permissions — real Supabase Auth.
 *
 * The "session" here is the authenticated Supabase user enriched with their
 * `profiles` row. Role, camp and family scope come ONLY from that row —
 * never from localStorage, a URL parameter or any other client-side state.
 *
 * This file's checks are UX/navigation only. Row Level Security on the
 * database is the real authorization boundary and does not consult
 * anything defined here.
 */

import * as supabaseAuth from '../supabase/auth.js';
import { getOwnProfile } from '../supabase/profiles.js';
import { listCamps } from '../supabase/camps.js';
import { createRegistrationRequest } from '../supabase/registration-requests.js';
import { ROLES, STATUS } from './config.js';

/** Thrown when a real, authenticated user has no usable application profile. */
export class ProfileError extends Error {
  constructor(reason) {
    super(`auth profile error: ${reason}`);
    this.name = 'ProfileError';
    this.reason = reason; // 'missing' | 'invalid_role'
  }
}

/* ---- Permissions -------------------------------------------------------- */

/**
 * action -> roles allowed. Domain rules encoded once:
 *   - aid is created/edited/deleted by Camp Admin only
 *   - a displaced person can only read
 *   - camps and camp admins belong to the single Super Admin
 * This table decides what the UI RENDERS. It is not security — RLS is.
 */
const PERMISSIONS = {
  'displaced:create': [ROLES.CAMP_ADMIN],
  'displaced:update': [ROLES.CAMP_ADMIN],
  'displaced:delete': [ROLES.CAMP_ADMIN],
  'displaced:view': [ROLES.CAMP_ADMIN, ROLES.SUPER_ADMIN],

  'family:create': [ROLES.CAMP_ADMIN],
  'family:update': [ROLES.CAMP_ADMIN],
  'family:delete': [ROLES.CAMP_ADMIN],
  'family:view': [ROLES.CAMP_ADMIN, ROLES.SUPER_ADMIN, ROLES.DISPLACED],

  'aid:create': [ROLES.CAMP_ADMIN],
  'aid:update': [ROLES.CAMP_ADMIN],
  'aid:delete': [ROLES.CAMP_ADMIN],
  'aid:view': [ROLES.CAMP_ADMIN, ROLES.SUPER_ADMIN, ROLES.DISPLACED],

  'organization:manage': [ROLES.CAMP_ADMIN, ROLES.SUPER_ADMIN],
  'request:review': [ROLES.CAMP_ADMIN],

  'camp:manage': [ROLES.SUPER_ADMIN],
  'campAdmin:manage': [ROLES.SUPER_ADMIN],

  'document:upload': [ROLES.CAMP_ADMIN, ROLES.SUPER_ADMIN, ROLES.DISPLACED],
  'document:delete': [ROLES.CAMP_ADMIN, ROLES.SUPER_ADMIN],
  'message:send': [ROLES.DISPLACED],
  'message:reply': [ROLES.CAMP_ADMIN, ROLES.SUPER_ADMIN],
};

/* ---- Camp label cache ----------------------------------------------------
 * Camp relationship data, not "dashboard data": a tiny, session-lifetime
 * memoized lookup against the real `camps` table so the header/sidebar can
 * show a name instead of a raw camp_id. */

let campCache = null;

async function campLabelFor(campId) {
  if (!campId) return '—';
  if (!campCache) {
    const rows = await listCamps({});
    campCache = new Map(rows.map((row) => [row.id, row.name]));
  }
  return campCache.get(campId) || '—';
}

/* ---- Session -------------------------------------------------------------- */

/**
 * The most recent session `getSession()` resolved, within THIS page load
 * only (never persisted). `mountShell()`/`guard()` always resolve a fresh
 * session before any page renders its own content, so by the time a page's
 * render code runs and calls `can()`/`inScope()` without an explicit
 * session, this is already populated with the current one. It exists so
 * the many existing `can('action')` call sites across the app (written
 * against the old synchronous, default-parameter session lookup) keep
 * working without every one of them threading `session` through by hand —
 * it is never used as an authorization source itself, only as a same-page
 * cache of a value `guard()` already authorized.
 */
let lastKnownSession = null;

/**
 * The signed-in user, enriched with their real profile. Null when signed
 * out. Throws ProfileError when authenticated but the profile is missing or
 * carries a role this frontend does not recognize — callers must not treat
 * that as "signed out" or guess a role.
 */
export async function getSession() {
  const raw = await supabaseAuth.getSession();
  if (!raw || !raw.user) {
    lastKnownSession = null;
    return null;
  }

  const profile = await getOwnProfile();
  if (!profile) {
    lastKnownSession = null;
    throw new ProfileError('missing');
  }
  if (!Object.values(ROLES).includes(profile.role)) {
    lastKnownSession = null;
    throw new ProfileError('invalid_role');
  }

  const campLabel =
    profile.role === ROLES.SUPER_ADMIN ? 'كل المخيمات' : await campLabelFor(profile.camp_id);

  const session = {
    id: raw.user.id,
    email: raw.user.email,
    name: profile.full_name,
    role: profile.role,
    status: profile.status,
    campId: profile.camp_id,
    campLabel,
    familyMemberId: profile.family_member_id,
  };
  lastKnownSession = session;
  return session;
}

export async function isSignedIn() {
  return Boolean(await getSession());
}

/** Real sign-in against Supabase Auth. Returns { ok, user, error }. */
export async function login(email, password) {
  try {
    await supabaseAuth.signIn(String(email).trim(), password);
  } catch (error) {
    return { ok: false, error: error.message };
  }
  return { ok: true, user: await getSession() };
}

export async function logout() {
  await supabaseAuth.signOut();
  campCache = null;
  lastKnownSession = null;
}

/**
 * Register a displaced account: creates the auth user + profile (role
 * `displaced`, status `pending`, via the database trigger), then the
 * registration request the camp admin reviews. The one-national-ID-per-camp
 * rule is enforced by the database's unique index — its duplicate error is
 * already mapped to a friendly Arabic message by `errors.js`.
 */
export async function register(data) {
  try {
    await supabaseAuth.signUp({
      email: data.email,
      password: data.password,
      fullName: data.fullName,
      phone: data.phone,
    });
  } catch (error) {
    return { ok: false, field: 'email', error: error.message };
  }

  try {
    await createRegistrationRequest({
      fullName: data.fullName,
      nationalId: data.nationalId,
      phone: data.phone,
      email: data.email,
      campId: data.campId,
    });
  } catch (error) {
    return { ok: false, field: 'nationalId', error: error.message };
  }

  return { ok: true, user: await getSession() };
}

/* ---- Permission check ------------------------------------------------------
 * UX only. RLS is the real authorization boundary and does not consult this. */

/**
 * @param {string} action e.g. 'aid:create'
 * @param {object} [session] defaults to the last session getSession() resolved this page load
 */
export function can(action, session = lastKnownSession) {
  if (!session) return false;
  const allowed = PERMISSIONS[action];
  if (!allowed) return false;
  return allowed.includes(session.role);
}

/** True when the signed-in user may act on this record's camp/family. UX only. */
export function inScope(record, session = lastKnownSession) {
  if (!session || !record) return false;
  if (session.role === ROLES.SUPER_ADMIN) return true;
  if (session.role === ROLES.CAMP_ADMIN) return record.campId === session.campId;
  return record.familyMemberId === session.familyMemberId || record.id === session.familyMemberId;
}

export { ROLES, STATUS };

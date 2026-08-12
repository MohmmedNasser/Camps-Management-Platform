/**
 * Prototype session + permissions.
 *
 * There is NO real authentication here: the "session" is a user id in
 * localStorage. What is real — and what the backend must reproduce — is the
 * permission table in `can()`. Every mutating control in the UI is gated on it.
 */

import * as storage from './storage.js';
import * as store from './store.js';
import { ROLES, STATUS } from './config.js';
import { campName } from './selectors.js';

const SESSION_KEY = 'session';

/* ---- Permissions -------------------------------------------------------- */

/**
 * action -> roles allowed. Domain rules encoded once:
 *   - aid is created/edited/deleted by Camp Admin only
 *   - a displaced person can only read
 *   - camps and camp admins belong to the single Super Admin
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

/* ---- Session ------------------------------------------------------------ */

/** The signed-in user, enriched with camp name. Null when signed out. */
export function getSession() {
  const raw = storage.read(SESSION_KEY);
  if (!raw || !raw.userId) return null;
  const user = store.users.get(raw.userId);
  if (!user) {
    storage.remove(SESSION_KEY);
    return null;
  }
  return {
    ...user,
    campLabel: user.campId ? campName(user.campId) : 'كل المخيمات',
    // A role override is only used by the demo role switcher.
    role: raw.roleOverride || user.role,
  };
}

export function isSignedIn() {
  return Boolean(getSession());
}

/**
 * Prototype sign-in. Matches email and (optionally) password against the
 * mock users. Returns { ok, user, error }.
 */
export function login(email, password = '') {
  const user = store.users.find(
    (row) => row.email.toLowerCase() === String(email).trim().toLowerCase()
  );
  if (!user) {
    return { ok: false, error: 'لا يوجد حساب بهذا البريد الإلكتروني.' };
  }
  if (password && user.password && user.password !== password) {
    return { ok: false, error: 'كلمة المرور غير صحيحة.' };
  }
  if (user.status === STATUS.DISABLED) {
    return { ok: false, error: 'هذا الحساب معطّل. يرجى التواصل مع إدارة النظام.' };
  }
  storage.write(SESSION_KEY, { userId: user.id, at: new Date().toISOString() });
  return { ok: true, user: getSession() };
}

export function logout() {
  storage.remove(SESSION_KEY);
}

/**
 * Register a displaced account. Enforces the domain rule that one national ID
 * cannot exist in two camps. Creates a pending registration request.
 */
export function register(data) {
  const nationalId = String(data.nationalId || '').trim();

  const existingPerson = store.displaced.find((person) => person.nationalId === nationalId);
  const existingRequest = store.registrationRequests.find(
    (request) => request.nationalId === nationalId && request.status !== STATUS.REJECTED
  );

  if (existingPerson || existingRequest) {
    const camp = campName((existingPerson || existingRequest).campId);
    return {
      ok: false,
      field: 'nationalId',
      error: `رقم الهوية مسجّل مسبقاً في ${camp}. لا يمكن التسجيل في أكثر من مخيم باستخدام نفس رقم الهوية.`,
    };
  }

  if (store.users.exists((user) => user.email.toLowerCase() === String(data.email).toLowerCase())) {
    return { ok: false, field: 'email', error: 'هذا البريد الإلكتروني مستخدم بالفعل.' };
  }

  const request = store.registrationRequests.create({
    fullName: data.fullName,
    nationalId,
    phone: data.phone,
    email: data.email,
    campId: data.campId,
    status: STATUS.PENDING,
    createdAt: new Date().toISOString(),
    note: '',
  });

  const user = store.users.create({
    name: data.fullName,
    email: data.email,
    password: data.password,
    phone: data.phone,
    role: ROLES.DISPLACED,
    campId: data.campId,
    status: STATUS.PENDING,
    requestId: request.id,
    createdAt: new Date().toISOString(),
  });

  store.notifications.create({
    userId: user.id,
    type: 'info',
    title: 'تم استلام طلب التسجيل',
    text: 'طلبك قيد المراجعة من قبل إدارة المخيم، وسيتم إشعارك عند اتخاذ القرار.',
    createdAt: new Date().toISOString(),
    read: false,
    href: 'pending.html',
  });

  storage.write(SESSION_KEY, { userId: user.id, at: new Date().toISOString() });
  return { ok: true, user: getSession(), request };
}

/** Demo-only: view the app as another role without signing out. */
export function switchRole(role) {
  const target = store.users.find((user) => user.role === role && user.status !== STATUS.DISABLED);
  if (!target) return false;
  storage.write(SESSION_KEY, { userId: target.id, at: new Date().toISOString() });
  return true;
}

/* ---- Permission check ---------------------------------------------------- */

/**
 * @param {string} action e.g. 'aid:create'
 * @param {object} [session] defaults to the current session
 */
export function can(action, session = getSession()) {
  if (!session) return false;
  const allowed = PERMISSIONS[action];
  if (!allowed) return false;
  return allowed.includes(session.role);
}

/** True when the signed-in user may act on this record's camp. */
export function inScope(record, session = getSession()) {
  if (!session || !record) return false;
  if (session.role === ROLES.SUPER_ADMIN) return true;
  if (session.role === ROLES.CAMP_ADMIN) return record.campId === session.campId;
  return record.displacedId === session.displacedId || record.id === session.displacedId;
}

export { ROLES, STATUS };

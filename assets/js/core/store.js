/**
 * Data layer.
 *
 * A tiny repository per collection over localStorage. Pages never touch
 * storage directly — they call `store.displaced.list()` and friends. The
 * method surface (list / get / create / update / remove) is deliberately the
 * shape a Supabase client call will take, so the Next.js port replaces the
 * body of each method and nothing above it changes.
 */

import * as storage from './storage.js';
import seed, { SEED_VERSION } from '../data/mock-data.js';
import { FAKE_LATENCY } from './config.js';

const COLLECTIONS = [
  'camps',
  'organizations',
  'users',
  'families',
  'displaced',
  'aid',
  'registrationRequests',
  'documents',
  'messages',
  'notifications',
];

/* ---- Seeding ----------------------------------------------------------- */

function seedAll() {
  COLLECTIONS.forEach((name) => storage.write(name, clone(seed[name] || [])));
  storage.write('meta', { version: SEED_VERSION, seededAt: new Date().toISOString() });
}

function ensureSeeded() {
  const meta = storage.read('meta');
  if (!meta || meta.version !== SEED_VERSION) seedAll();
}

ensureSeeded();

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/* ---- Change notification ---------------------------------------------- */

const listeners = new Set();

/** Subscribe to any write. Returns an unsubscribe function. */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(collection) {
  listeners.forEach((fn) => {
    try {
      fn(collection);
    } catch (error) {
      console.error('[store] listener error', error);
    }
  });
}

/* ---- Repository -------------------------------------------------------- */

let idCounter = Date.now();

function nextId(prefix) {
  idCounter += 1;
  return `${prefix}-${idCounter.toString(36)}`;
}

function repository(name, { idPrefix = name.slice(0, 3) } = {}) {
  const rows = () => storage.read(name, []);
  const save = (next) => {
    storage.write(name, next);
    emit(name);
  };

  return {
    name,

    /** All rows, optionally filtered by a predicate. */
    list(predicate) {
      const all = rows();
      return predicate ? all.filter(predicate) : all;
    },

    get(id) {
      return rows().find((row) => row.id === id) || null;
    },

    find(predicate) {
      return rows().find(predicate) || null;
    },

    count(predicate) {
      return this.list(predicate).length;
    },

    exists(predicate) {
      return rows().some(predicate);
    },

    create(data, { id } = {}) {
      const all = rows();
      const record = {
        id: id || data.id || nextId(idPrefix),
        createdAt: data.createdAt || new Date().toISOString(),
        ...data,
      };
      record.id = id || data.id || record.id;
      all.unshift(record);
      save(all);
      return record;
    },

    update(id, patch) {
      const all = rows();
      const index = all.findIndex((row) => row.id === id);
      if (index === -1) return null;
      all[index] = { ...all[index], ...patch, id };
      save(all);
      return all[index];
    },

    remove(id) {
      const all = rows();
      const next = all.filter((row) => row.id !== id);
      if (next.length === all.length) return false;
      save(next);
      return true;
    },

    removeWhere(predicate) {
      const all = rows();
      const next = all.filter((row) => !predicate(row));
      const removed = all.length - next.length;
      if (removed) save(next);
      return removed;
    },

    replaceAll(next) {
      save(clone(next));
    },
  };
}

export const camps = repository('camps', { idPrefix: 'camp' });
export const organizations = repository('organizations', { idPrefix: 'org' });
export const users = repository('users', { idPrefix: 'u' });
export const families = repository('families', { idPrefix: 'FAM' });
export const displaced = repository('displaced', { idPrefix: 'd' });
export const aid = repository('aid', { idPrefix: 'aid' });
export const registrationRequests = repository('registrationRequests', { idPrefix: 'req' });
export const documents = repository('documents', { idPrefix: 'doc' });
export const messages = repository('messages', { idPrefix: 'msg' });
export const notifications = repository('notifications', { idPrefix: 'ntf' });

/* ---- Preferences -------------------------------------------------------- */

const PREFERENCE_DEFAULTS = {
  notifyAid: true,
  notifyRequests: true,
  notifyMessages: true,
  denseTables: false,
};

/**
 * Per-user UI preferences. A single row rather than a collection, but the same
 * rule holds: pages read and write it through here, never through storage.
 */
export const preferences = {
  get(userId) {
    const all = storage.read('preferences', {});
    return { ...PREFERENCE_DEFAULTS, ...(all[userId] || {}) };
  },

  set(userId, patch) {
    const all = storage.read('preferences', {});
    all[userId] = { ...PREFERENCE_DEFAULTS, ...(all[userId] || {}), ...patch };
    storage.write('preferences', all);
    emit('preferences');
    return all[userId];
  },

  defaults: PREFERENCE_DEFAULTS,
};

/* ---- Async helper ------------------------------------------------------ */

/**
 * Wrap a synchronous read in a short delay so loading skeletons are real.
 * Pages await this exactly where they will later await a Supabase query.
 */
export function load(producer, delay = FAKE_LATENCY) {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        resolve(producer());
      } catch (error) {
        reject(error);
      }
    }, delay);
  });
}

/* ---- Dataset management ------------------------------------------------ */

/** Restore the original demo dataset. */
export function resetDemoData() {
  seedAll();
  COLLECTIONS.forEach(emit);
}

/** Empty every collection except camps — used to review empty states. */
export function clearRecords() {
  ['organizations', 'families', 'displaced', 'aid', 'registrationRequests', 'documents', 'messages', 'notifications'].forEach(
    (name) => {
      storage.write(name, []);
      emit(name);
    }
  );
}

/**
 * Development guard: verifies the referential rules the mock data promises.
 * Logs to the console; never throws in the user's face.
 */
export function validateData() {
  const problems = [];
  const familyIds = new Set(families.list().map((f) => f.id));
  const personIds = new Set(displaced.list().map((p) => p.id));
  const orgIds = new Set(organizations.list().map((o) => o.id));
  const campIds = new Set(camps.list().map((c) => c.id));

  displaced.list().forEach((person) => {
    if (person.familyId && !familyIds.has(person.familyId)) {
      problems.push(`النازح ${person.id} يشير إلى أسرة غير موجودة (${person.familyId})`);
    }
    if (person.campId && !campIds.has(person.campId)) {
      problems.push(`النازح ${person.id} يشير إلى مخيم غير موجود`);
    }
    if ('isOrphan' in person || 'currentResidence' in person) {
      problems.push(`النازح ${person.id} يحتوي على حقول ملغاة (يتيم يدوي أو مكان إقامة)`);
    }
  });

  families.list().forEach((family) => {
    if (family.headId && !personIds.has(family.headId)) {
      problems.push(`الأسرة ${family.id} لها رب أسرة غير موجود`);
      return;
    }
    const head = displaced.get(family.headId);
    if (head && head.familyId !== family.id) {
      problems.push(`رب الأسرة ${family.id} غير مسجل ضمن أفرادها`);
    }
    if (head && head.campId !== family.campId) {
      problems.push(`رب الأسرة ${family.id} في مخيم مختلف عن الأسرة`);
    }
  });

  aid.list().forEach((record) => {
    if (!record.organizationId || !orgIds.has(record.organizationId)) {
      problems.push(`المساعدة ${record.id} تشير إلى جهة مانحة غير موجودة`);
    }
    if (!Array.isArray(record.familyIds) || !record.familyIds.length) {
      problems.push(`المساعدة ${record.id} لا تحتوي على أسر مستفيدة`);
    } else {
      record.familyIds.forEach((id) => {
        if (!familyIds.has(id)) {
          problems.push(`المساعدة ${record.id} تشير إلى أسرة غير موجودة (${id})`);
        }
      });
    }
    if (!Array.isArray(record.types) || !record.types.length) {
      problems.push(`المساعدة ${record.id} لا تحتوي على نوع مساعدة`);
    }
    // Aid records the assistance itself, never its price, an individual
    // recipient, or a free-text quantity/description — a leftover field
    // means stale data from before the multi-type/multi-family rework.
    if (
      'value' in record ||
      'displacedId' in record ||
      'type' in record ||
      'familyId' in record ||
      'quantity' in record ||
      'description' in record
    ) {
      problems.push(`المساعدة ${record.id} تحتوي على حقول ملغاة (القيمة أو المستلم أو الشكل القديم)`);
    }
  });

  const nationalIds = new Map();
  displaced.list().forEach((person) => {
    if (!person.nationalId) return;
    if (nationalIds.has(person.nationalId)) {
      problems.push(`رقم الهوية ${person.nationalId} مكرر بين أكثر من نازح`);
    }
    nationalIds.set(person.nationalId, person.id);
  });

  if (problems.length) console.warn('[store] تعارض في البيانات:\n' + problems.join('\n'));
  return problems;
}

export default {
  camps,
  organizations,
  users,
  families,
  displaced,
  aid,
  registrationRequests,
  documents,
  messages,
  notifications,
  preferences,
  load,
  subscribe,
  resetDemoData,
  clearRecords,
  validateData,
};

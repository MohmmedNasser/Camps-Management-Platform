/**
 * Domain queries composed from the repositories.
 *
 * Business logic lives here, not in page modules. Each function takes plain
 * arguments and returns plain data, so it ports to a server component or an
 * RPC without change.
 */

import * as store from './store.js';
import { ROLES, STATUS, AID_TYPES, labelOf, GENDERS } from './config.js';
import { nextFamilySequence } from '../utils/format.js';

/* ---- Lookups ----------------------------------------------------------- */

export function campName(campId) {
  const camp = store.camps.get(campId);
  return camp ? camp.name : '—';
}

export function organizationName(organizationId) {
  const org = store.organizations.get(organizationId);
  return org ? org.name : '—';
}

export function personName(displacedId) {
  const person = store.displaced.get(displacedId);
  return person ? person.fullName : '—';
}

export function aidTypeLabel(type) {
  return labelOf(AID_TYPES, type);
}

export function genderLabel(gender) {
  return labelOf(GENDERS, gender);
}

/* ---- Scope ------------------------------------------------------------- */

/**
 * A Camp Admin only ever sees their own camp; the Super Admin sees all;
 * a displaced person sees only their own family. Every list page funnels
 * through this so the rule cannot be forgotten in one place.
 */
export function scopeFilter(session) {
  if (!session) return () => false;
  if (session.role === ROLES.SUPER_ADMIN) return () => true;
  if (session.role === ROLES.CAMP_ADMIN) return (row) => row.campId === session.campId;
  const person = store.displaced.get(session.displacedId);
  const familyId = person ? person.familyId : null;
  return (row) => row.familyId === familyId || row.displacedId === session.displacedId;
}

/* ---- Families ---------------------------------------------------------- */

export function familyMembers(familyId) {
  return store.displaced
    .list((person) => person.familyId === familyId)
    .sort((a, b) => (a.relationship === 'head' ? -1 : b.relationship === 'head' ? 1 : 0));
}

/** Family record enriched with derived counts — membersCount is never stored. */
export function familyWithStats(familyId) {
  const family = store.families.get(familyId);
  if (!family) return null;
  const members = familyMembers(familyId);
  const head = store.displaced.get(family.headId);
  return {
    ...family,
    members,
    membersCount: members.length,
    head,
    headName: head ? head.fullName : '—',
    campName: campName(family.campId),
    aidCount: store.aid.count((record) => record.familyId === familyId),
    childrenCount: members.filter((m) => ['son', 'daughter'].includes(m.relationship)).length,
    hasDisability: members.some((m) => Boolean(m.disability)),
    hasChronic: members.some((m) => Boolean(m.chronicDiseases)),
  };
}

export function familiesWithStats(predicate) {
  return store.families.list(predicate).map((family) => familyWithStats(family.id));
}

export function familyOfPerson(displacedId) {
  const person = store.displaced.get(displacedId);
  return person && person.familyId ? familyWithStats(person.familyId) : null;
}

/** Next auto-generated family ID, e.g. FAM-000009. */
export function nextFamilyId() {
  const sequence = nextFamilySequence(store.families.list().map((family) => family.id));
  return `FAM-${String(sequence).padStart(6, '0')}`;
}

/* ---- Displaced people --------------------------------------------------- */

/** Row shaped for list views (name, id, phone, family, camp, status). */
export function displacedRow(person) {
  return {
    ...person,
    campName: campName(person.campId),
    familyLabel: person.familyId || '—',
    aidCount: store.aid.count((record) => record.displacedId === person.id),
  };
}

/**
 * Search across name, national ID and phone; filter by camp, aid type and
 * supporting organization. File number and tent number are intentionally
 * absent — the domain has neither.
 */
export function searchDisplaced({
  query = '',
  campId = '',
  aidType = '',
  organizationId = '',
  gender = '',
  status = '',
  scope = () => true,
} = {}) {
  const term = query.trim().toLowerCase();

  let aidPersonIds = null;
  if (aidType || organizationId) {
    aidPersonIds = new Set(
      store.aid
        .list(
          (record) =>
            (!aidType || record.type === aidType) &&
            (!organizationId || record.organizationId === organizationId)
        )
        .map((record) => record.displacedId)
    );
  }

  return store.displaced
    .list(scope)
    .filter((person) => {
      if (campId && person.campId !== campId) return false;
      if (gender && person.gender !== gender) return false;
      if (status && person.status !== status) return false;
      if (aidPersonIds && !aidPersonIds.has(person.id)) return false;
      if (!term) return true;
      return (
        person.fullName.toLowerCase().includes(term) ||
        (person.fullNameEn || '').toLowerCase().includes(term) ||
        (person.nationalId || '').includes(term) ||
        (person.phone || '').includes(term) ||
        (person.familyId || '').toLowerCase().includes(term)
      );
    })
    .map(displacedRow);
}

/** Is this national ID already registered (in any camp)? */
export function nationalIdTaken(nationalId, exceptId = null) {
  const value = String(nationalId || '').trim();
  if (!value) return false;
  const inRecords = store.displaced.exists(
    (person) => person.nationalId === value && person.id !== exceptId
  );
  const inRequests = store.registrationRequests.exists(
    (request) => request.nationalId === value && request.status !== STATUS.REJECTED
  );
  return inRecords || inRequests;
}

/** Which camp a national ID is already tied to, for the duplicate message. */
export function campOfNationalId(nationalId) {
  const person = store.displaced.find((row) => row.nationalId === nationalId);
  if (person) return campName(person.campId);
  const request = store.registrationRequests.find(
    (row) => row.nationalId === nationalId && row.status !== STATUS.REJECTED
  );
  return request ? campName(request.campId) : '';
}

/* ---- Aid ---------------------------------------------------------------- */

export function aidRow(record) {
  return {
    ...record,
    typeLabel: aidTypeLabel(record.type),
    organizationName: organizationName(record.organizationId),
    personName: personName(record.displacedId),
    campName: campName(record.campId),
  };
}

export function searchAid({
  query = '',
  type = '',
  organizationId = '',
  familyId = '',
  displacedId = '',
  scope = () => true,
} = {}) {
  const term = query.trim().toLowerCase();
  return store.aid
    .list(scope)
    .filter((record) => {
      if (type && record.type !== type) return false;
      if (organizationId && record.organizationId !== organizationId) return false;
      if (familyId && record.familyId !== familyId) return false;
      if (displacedId && record.displacedId !== displacedId) return false;
      if (!term) return true;
      const person = store.displaced.get(record.displacedId);
      return (
        (person && person.fullName.toLowerCase().includes(term)) ||
        (record.familyId || '').toLowerCase().includes(term) ||
        organizationName(record.organizationId).toLowerCase().includes(term) ||
        aidTypeLabel(record.type).includes(term)
      );
    })
    .map(aidRow)
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}

export function aidForFamily(familyId) {
  return searchAid({ familyId });
}

export function aidForPerson(displacedId) {
  const person = store.displaced.get(displacedId);
  if (!person) return [];
  // A person sees aid registered to them personally and to their family.
  return store.aid
    .list((record) => record.displacedId === displacedId || record.familyId === person.familyId)
    .map(aidRow)
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}

/* ---- Documents / messages / notifications ------------------------------- */

export function documentsFor(session) {
  return store.documents.list(scopeFilter(session)).sort(
    (a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt)
  );
}

export function messagesFor(session) {
  if (!session) return [];
  const rows =
    session.role === ROLES.DISPLACED
      ? store.messages.list((message) => message.fromUserId === session.id)
      : session.role === ROLES.SUPER_ADMIN
        ? store.messages.list()
        : store.messages.list((message) => message.campId === session.campId);
  return rows.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export function notificationsFor(userId) {
  return store.notifications
    .list((row) => row.userId === userId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export function unreadNotificationCount(userId) {
  return store.notifications.count((row) => row.userId === userId && !row.read);
}

export function unreadMessageCount(session) {
  if (!session || session.role === ROLES.DISPLACED) return 0;
  return messagesFor(session).filter((message) => message.status === 'unread').length;
}

export function pendingRequestCount(session) {
  if (!session) return 0;
  if (session.role === ROLES.SUPER_ADMIN) {
    return store.registrationRequests.count((row) => row.status === STATUS.PENDING);
  }
  return store.registrationRequests.count(
    (row) => row.status === STATUS.PENDING && row.campId === session.campId
  );
}

/* ---- Statistics --------------------------------------------------------- */

/** Headline counters for the dashboard cards. */
export function statistics(session) {
  const inScope = scopeFilter(session);
  const people = store.displaced.list(
    session && session.role === ROLES.CAMP_ADMIN
      ? (row) => row.campId === session.campId
      : () => true
  );
  const familyRows = store.families.list(
    session && session.role === ROLES.CAMP_ADMIN
      ? (row) => row.campId === session.campId
      : () => true
  );
  const aidRows = store.aid.list(
    session && session.role === ROLES.CAMP_ADMIN
      ? (row) => row.campId === session.campId
      : () => true
  );

  return {
    displaced: people.length,
    families: familyRows.length,
    requests: pendingRequestCount(session),
    aid: aidRows.length,
    aidValue: aidRows.reduce((sum, record) => sum + Number(record.value || 0), 0),
    disability: people.filter((person) => Boolean(person.disability)).length,
    chronic: people.filter((person) => Boolean(person.chronicDiseases)).length,
    males: people.filter((person) => person.gender === 'male').length,
    females: people.filter((person) => person.gender === 'female').length,
    children: people.filter((person) => ['son', 'daughter'].includes(person.relationship)).length,
    camps: store.camps.count(),
    campAdmins: store.users.count((user) => user.role === ROLES.CAMP_ADMIN),
    documents: store.documents.list(inScope).length,
  };
}

/** Registrations per month for the last `months` months. */
export function displacedByMonth(session, months = 8) {
  const people = store.displaced.list(
    session && session.role === ROLES.CAMP_ADMIN ? (row) => row.campId === session.campId : () => true
  );
  const buckets = [];
  const now = new Date();
  for (let i = months - 1; i >= 0; i -= 1) {
    const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
    buckets.push({ date, key: `${date.getFullYear()}-${date.getMonth()}`, value: 0 });
  }
  const index = new Map(buckets.map((bucket) => [bucket.key, bucket]));
  people.forEach((person) => {
    const created = new Date(person.createdAt);
    if (Number.isNaN(created.getTime())) return;
    const bucket = index.get(`${created.getFullYear()}-${created.getMonth()}`);
    if (bucket) bucket.value += 1;
  });
  return buckets;
}

/** Aid record counts grouped by aid type (only types that occur). */
export function aidByType(session) {
  const rows = store.aid.list(
    session && session.role === ROLES.CAMP_ADMIN ? (row) => row.campId === session.campId : () => true
  );
  return AID_TYPES.map((type) => ({
    value: type.value,
    label: type.label,
    count: rows.filter((row) => row.type === type.value).length,
  })).filter((entry) => entry.count > 0);
}

/** Family size distribution, bucketed. */
export function familySizeDistribution(session) {
  const rows = store.families.list(
    session && session.role === ROLES.CAMP_ADMIN ? (row) => row.campId === session.campId : () => true
  );
  const buckets = [
    { label: '1–2 أفراد', min: 1, max: 2, count: 0 },
    { label: '3–4 أفراد', min: 3, max: 4, count: 0 },
    { label: '5–6 أفراد', min: 5, max: 6, count: 0 },
    { label: '7 فأكثر', min: 7, max: Infinity, count: 0 },
  ];
  rows.forEach((family) => {
    const size = familyMembers(family.id).length;
    const bucket = buckets.find((entry) => size >= entry.min && size <= entry.max);
    if (bucket) bucket.count += 1;
  });
  return buckets;
}

/** Per-camp totals — Super Admin dashboard and statistics page. */
export function campBreakdown() {
  return store.camps.list().map((camp) => {
    const people = store.displaced.list((row) => row.campId === camp.id);
    return {
      ...camp,
      displacedCount: people.length,
      familiesCount: store.families.count((row) => row.campId === camp.id),
      aidCount: store.aid.count((row) => row.campId === camp.id),
      adminsCount: store.users.count(
        (user) => user.role === ROLES.CAMP_ADMIN && user.campId === camp.id
      ),
      disabilityCount: people.filter((person) => Boolean(person.disability)).length,
    };
  });
}

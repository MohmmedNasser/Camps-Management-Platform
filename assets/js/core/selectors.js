/**
 * Domain queries composed from the repositories.
 *
 * Business logic lives here, not in page modules. Each function takes plain
 * arguments and returns plain data, so it ports to a server component or an
 * RPC without change.
 */

import * as store from './store.js';
import {
  ROLES,
  STATUS,
  AID_TYPES,
  labelOf,
  GENDERS,
  GOVERNORATES,
  WORK_STATUSES,
  TENT_TYPES,
  DOCUMENT_CATEGORIES,
  MESSAGE_SUBJECTS,
  RELATIONSHIPS,
} from './config.js';
import { nextFamilySequence, ageFrom } from '../utils/format.js';

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

/** Search families by id, head name or notes. */
export function searchFamilies({ query = '', campId = '', size = '', scope = () => true } = {}) {
  const term = query.trim().toLowerCase();

  return store.families
    .list(scope)
    .map((family) => familyWithStats(family.id))
    .filter((family) => {
      if (campId && family.campId !== campId) return false;
      if (size === 'small' && family.membersCount > 3) return false;
      if (size === 'medium' && (family.membersCount < 4 || family.membersCount > 6)) return false;
      if (size === 'large' && family.membersCount < 7) return false;
      if (!term) return true;
      return (
        family.id.toLowerCase().includes(term) ||
        family.headName.toLowerCase().includes(term) ||
        (family.notes || '').toLowerCase().includes(term)
      );
    })
    .sort((a, b) => a.id.localeCompare(b.id));
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

/* ---- Option lists for selects -------------------------------------------- */

/** Camps as `{value,label}`; a Camp Admin only ever gets their own. */
export function campOptions(session = null, { activeOnly = false } = {}) {
  return store.camps
    .list((camp) => {
      if (activeOnly && camp.status !== STATUS.ACTIVE) return false;
      if (session && session.role === ROLES.CAMP_ADMIN) return camp.id === session.campId;
      return true;
    })
    .map((camp) => ({ value: camp.id, label: `${camp.name} — ${camp.city}` }));
}

export function familyOptions(campId = '') {
  return store.families
    .list((family) => !campId || family.campId === campId)
    .map((family) => {
      const head = store.displaced.get(family.headId);
      return { value: family.id, label: `${family.id} — ${head ? head.fullName : 'بدون رب أسرة'}` };
    })
    .sort((a, b) => a.value.localeCompare(b.value));
}

export function personOptions({ campId = '', familyId = '' } = {}) {
  return store.displaced
    .list((person) => {
      if (campId && person.campId !== campId) return false;
      if (familyId && person.familyId !== familyId) return false;
      return true;
    })
    .map((person) => ({
      value: person.id,
      label: `${person.fullName} — ${person.nationalId}`,
    }));
}

export function organizationOptions() {
  return store.organizations.list().map((org) => ({ value: org.id, label: org.name }));
}

/** People in a camp who can head a family: not already a head elsewhere. */
export function familyHeadCandidates(campId, { exceptFamilyId = '' } = {}) {
  const takenHeads = new Set(
    store.families.list((family) => family.id !== exceptFamilyId).map((family) => family.headId)
  );
  return store.displaced
    .list((person) => person.campId === campId && !takenHeads.has(person.id))
    .map((person) => ({
      value: person.id,
      label: `${person.fullName} — ${person.nationalId}`,
    }));
}

/** People in a camp not attached to any family yet. */
export function unassignedPeople(campId) {
  return store.displaced.list((person) => person.campId === campId && !person.familyId);
}

/* ---- Organizations ------------------------------------------------------- */

/** An organisation has a name and an optional responsible person — nothing else. */
export function organizationRow(org) {
  const aidRows = store.aid.list((record) => record.organizationId === org.id);
  return {
    ...org,
    aidCount: aidRows.length,
    aidValue: aidRows.reduce((sum, record) => sum + Number(record.value || 0), 0),
    familiesCount: new Set(aidRows.map((record) => record.familyId)).size,
  };
}

export function searchOrganizations({ query = '' } = {}) {
  const term = query.trim().toLowerCase();
  return store.organizations
    .list(
      (org) =>
        !term ||
        org.name.toLowerCase().includes(term) ||
        (org.responsiblePerson || '').toLowerCase().includes(term)
    )
    .map(organizationRow)
    .sort((a, b) => b.aidCount - a.aidCount);
}

/** An organisation still referenced by aid records must not be deleted. */
export function organizationInUse(organizationId) {
  return store.aid.exists((record) => record.organizationId === organizationId);
}

/* ---- Registration requests ----------------------------------------------- */

export function requestRow(request) {
  return {
    ...request,
    campName: campName(request.campId),
    reviewerName: request.reviewedBy
      ? (store.users.get(request.reviewedBy) || {}).name || '—'
      : '',
  };
}

export function searchRequests({ query = '', status = '', campId = '' } = {}) {
  const term = query.trim().toLowerCase();
  return store.registrationRequests
    .list((request) => {
      if (campId && request.campId !== campId) return false;
      if (status && request.status !== status) return false;
      if (!term) return true;
      return (
        request.fullName.toLowerCase().includes(term) ||
        (request.nationalId || '').includes(term) ||
        (request.phone || '').includes(term) ||
        (request.email || '').toLowerCase().includes(term)
      );
    })
    .map(requestRow)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export function requestCountsByStatus(campId = '') {
  const rows = store.registrationRequests.list((row) => !campId || row.campId === campId);
  return {
    all: rows.length,
    [STATUS.PENDING]: rows.filter((row) => row.status === STATUS.PENDING).length,
    [STATUS.APPROVED]: rows.filter((row) => row.status === STATUS.APPROVED).length,
    [STATUS.REJECTED]: rows.filter((row) => row.status === STATUS.REJECTED).length,
  };
}

/* ---- Registration decisions ---------------------------------------------- */

/**
 * Approve a registration request.
 *
 * Approval is what turns an applicant into a record: it creates the displaced
 * person, opens a family with them as its head (a family is an independent
 * entity with a generated ID), activates the linked account and notifies them.
 */
export function approveRequest(requestId, reviewerId) {
  const request = store.registrationRequests.get(requestId);
  if (!request || request.status !== STATUS.PENDING) return null;

  const familyId = nextFamilyId();

  const person = store.displaced.create({
    fullName: request.fullName,
    nationalId: request.nationalId,
    phone: request.phone,
    email: request.email,
    campId: request.campId,
    familyId,
    relationship: 'head',
    gender: 'male',
    maritalStatus: 'single',
    nationality: 'palestinian',
    tentType: 'family_tent',
    workStatus: 'unemployed',
    incomeSource: 'none',
    monthlyIncome: 0,
    chronicDiseases: '',
    disability: '',
    status: STATUS.APPROVED,
    createdAt: new Date().toISOString(),
  });

  store.families.create(
    {
      id: familyId,
      campId: request.campId,
      headId: person.id,
      notes: '',
      createdAt: new Date().toISOString(),
    },
    { id: familyId }
  );

  store.registrationRequests.update(requestId, {
    status: STATUS.APPROVED,
    reviewedAt: new Date().toISOString(),
    reviewedBy: reviewerId,
    displacedId: person.id,
  });

  const user = store.users.find(
    (row) => row.requestId === requestId || row.email === request.email
  );
  if (user) {
    store.users.update(user.id, { status: STATUS.APPROVED, displacedId: person.id });
    store.notifications.create({
      userId: user.id,
      type: 'success',
      title: 'تم قبول طلب التسجيل',
      text: `تم قبول طلبك في ${campName(request.campId)}. يمكنك الآن استكمال بياناتك.`,
      createdAt: new Date().toISOString(),
      read: false,
      href: 'profile.html',
    });
  }

  return { person, familyId };
}

/** Reject a request; the reason is shown to the applicant on their status screen. */
export function rejectRequest(requestId, reviewerId, note = '') {
  const request = store.registrationRequests.get(requestId);
  if (!request || request.status !== STATUS.PENDING) return null;

  store.registrationRequests.update(requestId, {
    status: STATUS.REJECTED,
    reviewedAt: new Date().toISOString(),
    reviewedBy: reviewerId,
    note,
  });

  const user = store.users.find(
    (row) => row.requestId === requestId || row.email === request.email
  );
  if (user) {
    store.users.update(user.id, { status: STATUS.REJECTED, rejectionReason: note });
    store.notifications.create({
      userId: user.id,
      type: 'error',
      title: 'تم رفض طلب التسجيل',
      text: note || 'يمكنك مراجعة إدارة المخيم لمعرفة التفاصيل.',
      createdAt: new Date().toISOString(),
      read: false,
      href: 'rejected.html',
    });
  }

  return store.registrationRequests.get(requestId);
}

/* ---- Documents / messages / notifications ------------------------------- */

export function documentsFor(session) {
  return store.documents.list(scopeFilter(session)).sort(
    (a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt)
  );
}

/** Document enriched for list views. Documents have no expiry date by design. */
export function documentRow(row) {
  return {
    ...row,
    categoryLabel: labelOf(
      DOCUMENT_CATEGORIES.map((item) => ({ value: item.value, label: item.label })),
      row.category
    ),
    categoryIcon: (DOCUMENT_CATEGORIES.find((item) => item.value === row.category) || {}).icon || 'folder',
    personName: personName(row.displacedId),
    campName: campName(row.campId),
    uploaderName: (store.users.get(row.uploadedBy) || {}).name || '—',
  };
}

export function searchDocuments({ query = '', category = '', campId = '', session = null } = {}) {
  const term = query.trim().toLowerCase();
  const scope = session ? scopeFilter(session) : () => true;

  return store.documents
    .list(scope)
    .filter((row) => {
      if (category && row.category !== category) return false;
      if (campId && row.campId !== campId) return false;
      if (!term) return true;
      return (
        row.name.toLowerCase().includes(term) ||
        personName(row.displacedId).toLowerCase().includes(term) ||
        (row.familyId || '').toLowerCase().includes(term)
      );
    })
    .map(documentRow)
    .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
}

export function documentsByCategory(session) {
  const rows = documentsFor(session);
  return DOCUMENT_CATEGORIES.map((category) => ({
    value: category.value,
    label: category.label,
    count: rows.filter((row) => row.category === category.value).length,
  }));
}

export function messageRow(message) {
  const sender = store.users.get(message.fromUserId);
  return {
    ...message,
    senderName: sender ? sender.name : 'مستخدم محذوف',
    senderEmail: sender ? sender.email : '',
    subjectLabel: labelOf(MESSAGE_SUBJECTS, message.subject),
    campName: campName(message.campId),
  };
}

export function searchMessages(session, { query = '', status = '', subject = '' } = {}) {
  const term = query.trim().toLowerCase();
  return messagesFor(session)
    .filter((message) => {
      if (status && message.status !== status) return false;
      if (subject && message.subject !== subject) return false;
      if (!term) return true;
      const sender = store.users.get(message.fromUserId);
      return (
        message.body.toLowerCase().includes(term) ||
        labelOf(MESSAGE_SUBJECTS, message.subject).includes(term) ||
        (sender ? sender.name.toLowerCase().includes(term) : false)
      );
    })
    .map(messageRow);
}

export function messageCountsByStatus(session) {
  const rows = messagesFor(session);
  return {
    all: rows.length,
    unread: rows.filter((row) => row.status === 'unread').length,
    read: rows.filter((row) => row.status === 'read').length,
    replied: rows.filter((row) => row.status === 'replied').length,
  };
}

/* ---- Camps and camp admins ----------------------------------------------- */

/** Camp Admins with their camp name — the Camp Admin is the camp representative. */
export function campAdminRows({ query = '', campId = '', status = '' } = {}) {
  const term = query.trim().toLowerCase();
  return store.users
    .list((user) => user.role === ROLES.CAMP_ADMIN)
    .filter((user) => {
      if (campId && user.campId !== campId) return false;
      if (status && user.status !== status) return false;
      if (!term) return true;
      return (
        user.name.toLowerCase().includes(term) ||
        user.email.toLowerCase().includes(term) ||
        (user.phone || '').includes(term)
      );
    })
    .map((user) => ({
      ...user,
      campName: campName(user.campId),
      displacedCount: store.displaced.count((row) => row.campId === user.campId),
    }));
}

/** True when a camp still holds records and therefore cannot be deleted. */
export function campInUse(campId) {
  return (
    store.displaced.exists((row) => row.campId === campId) ||
    store.families.exists((row) => row.campId === campId) ||
    store.users.exists((row) => row.campId === campId && row.role === ROLES.CAMP_ADMIN)
  );
}

export function campWithStats(campId) {
  const camp = store.camps.get(campId);
  if (!camp) return null;
  return campBreakdown().find((row) => row.id === campId) || camp;
}

/* ---- Cascading deletes ---------------------------------------------------- */

/**
 * Remove a displaced person and everything that only exists because of them.
 * Supabase will do this with `ON DELETE CASCADE`; the rules are the same, so
 * they live here rather than in a page.
 */
export function removeDisplaced(displacedId) {
  const person = store.displaced.get(displacedId);
  if (!person) return false;

  store.aid.removeWhere((record) => record.displacedId === displacedId);
  store.documents.removeWhere((row) => row.displacedId === displacedId);

  // A family whose head is removed loses its head; an empty family is removed.
  store.families.list((family) => family.headId === displacedId).forEach((family) => {
    const remaining = familyMembers(family.id).filter((member) => member.id !== displacedId);
    if (remaining.length) store.families.update(family.id, { headId: remaining[0].id });
    else store.families.remove(family.id);
  });

  store.users.list((user) => user.displacedId === displacedId).forEach((user) => {
    store.users.update(user.id, { displacedId: null, status: STATUS.DISABLED });
  });

  return store.displaced.remove(displacedId);
}

/** Remove a family, detaching (not deleting) its members. */
export function removeFamily(familyId) {
  familyMembers(familyId).forEach((member) => {
    store.displaced.update(member.id, { familyId: '' });
  });
  store.aid.removeWhere((record) => record.familyId === familyId);
  return store.families.remove(familyId);
}

/** Remove a camp admin account. */
export function removeCampAdmin(userId) {
  return store.users.remove(userId);
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

/** People in scope for a session — the base of every distribution below. */
function peopleInScope(session) {
  return store.displaced.list(
    session && session.role === ROLES.CAMP_ADMIN ? (row) => row.campId === session.campId : () => true
  );
}

/** Age brackets used by the statistics page. */
export function ageDistribution(session) {
  const buckets = [
    { label: 'أقل من 5 سنوات', min: 0, max: 4, count: 0 },
    { label: '5 – 17 سنة', min: 5, max: 17, count: 0 },
    { label: '18 – 40 سنة', min: 18, max: 40, count: 0 },
    { label: '41 – 60 سنة', min: 41, max: 60, count: 0 },
    { label: 'أكثر من 60 سنة', min: 61, max: 200, count: 0 },
  ];
  peopleInScope(session).forEach((person) => {
    const age = ageFrom(person.birthDate);
    if (age === null) return;
    const bucket = buckets.find((entry) => age >= entry.min && age <= entry.max);
    if (bucket) bucket.count += 1;
  });
  return buckets;
}

/** Counts for any `{value,label}` enum over a field of the person record. */
function distributionOver(session, list, field) {
  const people = peopleInScope(session);
  return list
    .map((item) => ({
      value: item.value,
      label: item.label,
      count: people.filter((person) => person[field] === item.value).length,
    }))
    .filter((entry) => entry.count > 0);
}

export function workStatusDistribution(session) {
  return distributionOver(session, WORK_STATUSES, 'workStatus');
}

export function tentTypeDistribution(session) {
  return distributionOver(session, TENT_TYPES, 'tentType');
}

/** Where the people in scope were displaced from. */
export function originDistribution(session) {
  return distributionOver(session, GOVERNORATES, 'originGovernorate');
}

export function relationshipDistribution(session) {
  return distributionOver(session, RELATIONSHIPS, 'relationship');
}

/** Aid record count and value per organisation, largest first. */
export function aidByOrganization(session) {
  const rows = store.aid.list(
    session && session.role === ROLES.CAMP_ADMIN ? (row) => row.campId === session.campId : () => true
  );
  return store.organizations
    .list()
    .map((org) => {
      const own = rows.filter((record) => record.organizationId === org.id);
      return {
        value: org.id,
        label: org.name,
        count: own.length,
        total: own.reduce((sum, record) => sum + Number(record.value || 0), 0),
      };
    })
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count);
}

/** Aid value per month for the last `months` months. */
export function aidValueByMonth(session, months = 8) {
  const rows = store.aid.list(
    session && session.role === ROLES.CAMP_ADMIN ? (row) => row.campId === session.campId : () => true
  );
  const buckets = [];
  const now = new Date();
  for (let i = months - 1; i >= 0; i -= 1) {
    const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
    buckets.push({ date, key: `${date.getFullYear()}-${date.getMonth()}`, value: 0 });
  }
  const index = new Map(buckets.map((bucket) => [bucket.key, bucket]));
  rows.forEach((record) => {
    const date = new Date(record.date);
    if (Number.isNaN(date.getTime())) return;
    const bucket = index.get(`${date.getFullYear()}-${date.getMonth()}`);
    if (bucket) bucket.value += Number(record.value || 0);
  });
  return buckets;
}

/** Families that received the most aid — used by the statistics page. */
export function topFamiliesByAid(session, limit = 5) {
  const rows = store.aid.list(
    session && session.role === ROLES.CAMP_ADMIN ? (row) => row.campId === session.campId : () => true
  );
  const totals = new Map();
  rows.forEach((record) => {
    const entry = totals.get(record.familyId) || { count: 0, total: 0 };
    entry.count += 1;
    entry.total += Number(record.value || 0);
    totals.set(record.familyId, entry);
  });
  return [...totals.entries()]
    .map(([familyId, entry]) => {
      const family = store.families.get(familyId);
      const head = family ? store.displaced.get(family.headId) : null;
      return {
        familyId,
        headName: head ? head.fullName : '—',
        campName: family ? campName(family.campId) : '—',
        ...entry,
      };
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
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

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
  AGE_BANDS,
  FAMILY_SIZES,
} from './config.js';
import { nextFamilySequence, ageFrom } from '../utils/format.js';

/** Anyone under this age counts as a child in every statistic. */
export const CHILD_AGE_LIMIT = 18;

/**
 * Resolve a tri-state filter ('' | 'yes' | 'no') against a boolean fact.
 * '' means "الكل" and matches everything.
 */
function matchesYesNo(value, fact) {
  if (!value) return true;
  return value === 'yes' ? Boolean(fact) : !fact;
}

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
  return (row) =>
    row.familyId === familyId ||
    (Array.isArray(row.familyIds) && row.familyIds.includes(familyId)) ||
    row.displacedId === session.displacedId;
}

/* ---- Families ---------------------------------------------------------- */

export function familyMembers(familyId) {
  return store.displaced
    .list((person) => person.familyId === familyId)
    .sort((a, b) => (a.relationship === 'head' ? -1 : b.relationship === 'head' ? 1 : 0));
}

/** Age in whole years, or null when there is no usable birth date. */
export function ageOf(person) {
  return ageFrom(person && person.birthDate);
}

/** A child is anyone under 18 — derived from the birth date, never stored. */
export function isChild(person) {
  return isUnder(person, CHILD_AGE_LIMIT);
}

/** Strictly under `years` — the shared primitive behind every age band. */
export function isUnder(person, years) {
  const age = ageOf(person);
  return age !== null && age < years;
}

/**
 * A person is an orphan when either parent is recorded as deceased. This is
 * the only place orphan status is computed — nothing stores it directly.
 */
export function isOrphan(person) {
  return person.fatherStatus === 'deceased' || person.motherStatus === 'deceased';
}

/**
 * The boolean facts every filter, statistic and export column asks about one
 * person. Defined once so the table, the dashboard and the Excel file can
 * never disagree about what "طفل" or "مرضعة" means.
 */
export function personFacts(person) {
  return {
    isChild: isChild(person),
    under1: isUnder(person, 1),
    under2: isUnder(person, 2),
    under3: isUnder(person, 3),
    isOrphan: isOrphan(person),
    hasChronic: Boolean(person.chronicDiseases),
    hasDisability: Boolean(person.disability),
    // Only meaningful for female records; absent on male ones by design.
    isPregnant: Boolean(person.isPregnant),
    isBreastfeeding: Boolean(person.isBreastfeeding),
    maternityApplies: person.gender === 'female',
  };
}

/** Family record enriched with derived counts — membersCount is never stored. */
export function familyWithStats(familyId) {
  const family = store.families.get(familyId);
  if (!family) return null;
  const members = familyMembers(familyId);
  const head = store.displaced.get(family.headId);
  const facts = familyFacts(members);
  return {
    ...family,
    ...facts,
    members,
    head,
    headName: head ? head.fullName : '—',
    campName: campName(family.campId),
    aidCount: store.aid.count((record) => (record.familyIds || []).includes(familyId)),
    // Aliases the detail and list views already read.
    childrenCount: facts.childrenUnder18,
    orphansCount: facts.orphans,
    hasDisability: facts.disability > 0,
    hasChronic: facts.chronic > 0,
  };
}

export function familiesWithStats(predicate) {
  return store.families.list(predicate).map((family) => familyWithStats(family.id));
}

export function familyOfPerson(displacedId) {
  const person = store.displaced.get(displacedId);
  return person && person.familyId ? familyWithStats(person.familyId) : null;
}

/**
 * One pass over `displaced` producing familyId -> members.
 *
 * Family filters ask about member characteristics, so without this every
 * family would rescan the whole displaced collection — O(families × people).
 * Built once per query and handed down.
 */
function membersByFamily() {
  const index = new Map();
  store.displaced.list().forEach((person) => {
    if (!person.familyId) return;
    const bucket = index.get(person.familyId);
    if (bucket) bucket.push(person);
    else index.set(person.familyId, [person]);
  });
  return index;
}

/**
 * Aggregate counts for one family, derived from its members every time.
 *
 * These are exactly the Excel columns in spec §17 and exactly what the family
 * filters test, so a family shown by "وجود حامل" always exports حوامل ≥ 1.
 */
export function familyFacts(members) {
  const count = (predicate) => members.filter(predicate).length;
  return {
    membersCount: members.length,
    childrenUnder18: count(isChild),
    childrenUnder3: count((m) => isUnder(m, 3)),
    childrenUnder2: count((m) => isUnder(m, 2)),
    childrenUnder1: count((m) => isUnder(m, 1)),
    orphans: count(isOrphan),
    chronic: count((m) => m.chronicDiseases),
    disability: count((m) => m.disability),
    breastfeeding: count((m) => m.isBreastfeeding),
    pregnant: count((m) => m.isPregnant),
  };
}

/**
 * Families matching a search term AND every active filter.
 *
 * A family matches a member-characteristic filter when **at least one** of its
 * members satisfies it (spec §12). Scope is derived from the session, so a
 * Camp Admin cannot reach another camp's families through the URL.
 */
export function getFilteredFamilies(session, filters = {}) {
  if (!session || session.role === ROLES.DISPLACED) return [];

  const {
    query = '',
    campId = '',
    size = '',
    hasChildren = '',
    hasUnder3 = '',
    hasUnder2 = '',
    hasUnder1 = '',
    hasOrphan = '',
    hasChronic = '',
    hasBreastfeeding = '',
    hasPregnant = '',
  } = filters;

  const term = query.trim().toLowerCase();
  const camp = scopedCampId(session, campId);
  const bucket = FAMILY_SIZES.find((entry) => entry.value === size);
  const index = membersByFamily();

  return store.families
    .list(scopeFilter(session))
    .filter((family) => !camp || family.campId === camp)
    .map((family) => {
      const members = (index.get(family.id) || []).slice().sort((a, b) =>
        a.relationship === 'head' ? -1 : b.relationship === 'head' ? 1 : 0
      );
      const head = store.displaced.get(family.headId);
      const facts = familyFacts(members);
      return {
        ...family,
        ...facts,
        members,
        head,
        headName: head ? head.fullName : '—',
        campName: campName(family.campId),
        aidCount: store.aid.count((record) => (record.familyIds || []).includes(family.id)),
        // Kept for the existing list columns.
        childrenCount: facts.childrenUnder18,
        orphansCount: facts.orphans,
        hasDisability: facts.disability > 0,
        hasChronic: facts.chronic > 0,
      };
    })
    .filter((family) => {
      if (bucket) {
        if (family.membersCount < bucket.min) return false;
        if (bucket.max !== null && family.membersCount > bucket.max) return false;
      }
      if (!matchesYesNo(hasChildren, family.childrenUnder18)) return false;
      if (!matchesYesNo(hasUnder3, family.childrenUnder3)) return false;
      if (!matchesYesNo(hasUnder2, family.childrenUnder2)) return false;
      if (!matchesYesNo(hasUnder1, family.childrenUnder1)) return false;
      if (!matchesYesNo(hasOrphan, family.orphans)) return false;
      if (!matchesYesNo(hasChronic, family.chronic)) return false;
      if (!matchesYesNo(hasBreastfeeding, family.breastfeeding)) return false;
      if (!matchesYesNo(hasPregnant, family.pregnant)) return false;

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

/** Fields a household shares, copied from the head onto every member. */
const SHARED_HOUSEHOLD_FIELDS = [
  'tentType',
  'originGovernorate',
  'originCity',
  'displacementDate',
  'governorate',
  'city',
  'area',
];

/**
 * Create a family, its head and its remaining members in one go.
 *
 * This is the only way a family comes into existence from the UI: the admin
 * fills one form and everything is written together, so a family is never
 * left headless and a member is never left without a family. Members inherit
 * the household fields from the head, since they live in the same shelter.
 *
 * @param {{campId: string, notes?: string, head: object, members?: object[]}} input
 * @returns {{family: object, head: object, members: object[]}}
 */
export function createFamilyWithMembers({ campId, notes = '', head, members = [] }) {
  const familyId = nextFamilyId();
  const now = new Date().toISOString();

  const headRecord = store.displaced.create({
    ...head,
    campId,
    familyId,
    relationship: 'head',
    status: STATUS.APPROVED,
    createdAt: now,
  });

  const shared = {};
  SHARED_HOUSEHOLD_FIELDS.forEach((field) => {
    if (headRecord[field]) shared[field] = headRecord[field];
  });

  const memberRecords = members.map((member) =>
    store.displaced.create({
      ...shared,
      ...member,
      campId,
      familyId,
      status: STATUS.APPROVED,
      createdAt: now,
    })
  );

  const family = store.families.create(
    { id: familyId, campId, headId: headRecord.id, notes, createdAt: now },
    { id: familyId }
  );

  return { family, head: headRecord, members: memberRecords };
}

/* ---- Displaced people --------------------------------------------------- */

/** Row shaped for list views (name, id, phone, family, camp, status). */
export function displacedRow(person) {
  return {
    ...person,
    campName: campName(person.campId),
    familyLabel: person.familyId || '—',
    // Aid belongs to the family, so a person's aid count is their family's.
    aidCount: person.familyId
      ? store.aid.count((record) => (record.familyIds || []).includes(person.familyId))
      : 0,
  };
}

/**
 * Search across name, national ID and phone; filter by camp, aid type and
 * donor. File number and tent number are intentionally absent — the domain
 * has neither.
 */
export function searchDisplaced({
  query = '',
  campId = '',
  aidType = '',
  organizationId = '',
  gender = '',
  tentType = '',
  status = '',
  scope = () => true,
} = {}) {
  const term = query.trim().toLowerCase();

  // Aid is recorded against a family, so an aid filter narrows to the people
  // whose family received a matching delivery.
  let aidFamilyIds = null;
  if (aidType || organizationId) {
    aidFamilyIds = new Set(
      store.aid
        .list(
          (record) =>
            (!aidType || (record.types || []).includes(aidType)) &&
            (!organizationId || record.organizationId === organizationId)
        )
        .flatMap((record) => record.familyIds || [])
    );
  }

  return store.displaced
    .list(scope)
    .filter((person) => {
      if (campId && person.campId !== campId) return false;
      if (gender && person.gender !== gender) return false;
      if (tentType && person.tentType !== tentType) return false;
      if (status && person.status !== status) return false;
      if (aidFamilyIds && !aidFamilyIds.has(person.familyId)) return false;
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

/* ---- The filtered query (table + dashboard + export share this) --------- */

/**
 * The camp a session is allowed to read, and nothing wider.
 *
 * A Camp Admin's camp is taken from the session, never from the request: a
 * hand-edited `?campId=` cannot widen it, only the Super Admin may pass one.
 * Every export runs through here, so the file can only ever contain rows the
 * signed-in user was already entitled to see.
 */
function scopedCampId(session, requestedCampId = '') {
  if (!session) return null;
  if (session.role === ROLES.CAMP_ADMIN) return session.campId;
  if (session.role === ROLES.SUPER_ADMIN) return requestedCampId || '';
  return null;
}

/**
 * Displaced people matching a search term AND every active filter.
 *
 * Filters combine with AND throughout; an empty value means "الكل" and drops
 * out. This is the one query behind the list table and the Excel export, so
 * the count on screen is by construction the row count in the file.
 *
 * @param {object} session signed-in user — supplies the scope, non-negotiable
 * @param {object} filters { query, campId, gender, status, tentType, ageBand,
 *   isChild, isOrphan, hasChronic, isPregnant, isBreastfeeding, aidType,
 *   organizationId }
 */
export function getFilteredDisplaced(session, filters = {}) {
  if (!session || session.role === ROLES.DISPLACED) return [];

  const {
    query = '',
    campId = '',
    gender = '',
    status = '',
    tentType = '',
    ageBand = '',
    isChild: childFilter = '',
    isOrphan: orphanFilter = '',
    hasChronic: chronicFilter = '',
    isPregnant: pregnantFilter = '',
    isBreastfeeding: breastfeedingFilter = '',
    aidType = '',
    organizationId = '',
  } = filters;

  const band = AGE_BANDS.find((entry) => entry.value === ageBand);

  return searchDisplaced({
    query,
    campId: scopedCampId(session, campId),
    gender,
    status,
    tentType,
    aidType,
    organizationId,
    scope: scopeFilter(session),
  }).filter((person) => {
    const facts = personFacts(person);

    if (band && !isUnder(person, band.max)) return false;
    if (!matchesYesNo(childFilter, facts.isChild)) return false;
    if (!matchesYesNo(orphanFilter, facts.isOrphan)) return false;
    if (!matchesYesNo(chronicFilter, facts.hasChronic)) return false;

    // Maternity filters never apply to a male record: "غير حامل" must not
    // return every man in the camp.
    if (pregnantFilter) {
      if (!facts.maternityApplies) return false;
      if (!matchesYesNo(pregnantFilter, facts.isPregnant)) return false;
    }
    if (breastfeedingFilter) {
      if (!facts.maternityApplies) return false;
      if (!matchesYesNo(breastfeedingFilter, facts.isBreastfeeding)) return false;
    }

    return true;
  });
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

/**
 * Aid enriched for display. The record names a donor and a beneficiary family
 * — there is no individual recipient and no monetary value.
 */
export function aidRow(record) {
  const types = record.types || [];
  const familyIds = record.familyIds || [];
  const beneficiaries = familyIds.map((familyId) => {
    const family = store.families.get(familyId);
    const head = family ? store.displaced.get(family.headId) : null;
    return { familyId, headName: head ? head.fullName : '—' };
  });
  return {
    ...record,
    typeLabels: types.map(aidTypeLabel).join('، '),
    organizationName: organizationName(record.organizationId),
    beneficiaryCount: familyIds.length,
    beneficiaries,
    campName: campName(record.campId),
  };
}

export function searchAid({
  query = '',
  type = '',
  organizationId = '',
  familyId = '',
  scope = () => true,
} = {}) {
  const term = query.trim().toLowerCase();
  return store.aid
    .list(scope)
    .filter((record) => {
      if (type && !(record.types || []).includes(type)) return false;
      if (organizationId && record.organizationId !== organizationId) return false;
      if (familyId && !(record.familyIds || []).includes(familyId)) return false;
      if (!term) return true;
      const headNames = (record.familyIds || [])
        .map((id) => store.families.get(id))
        .filter(Boolean)
        .map((family) => store.displaced.get(family.headId))
        .filter(Boolean)
        .map((head) => head.fullName.toLowerCase());
      return (
        (record.familyIds || []).some((id) => id.toLowerCase().includes(term)) ||
        headNames.some((name) => name.includes(term)) ||
        organizationName(record.organizationId).toLowerCase().includes(term) ||
        (record.types || []).some((value) => aidTypeLabel(value).includes(term))
      );
    })
    .map(aidRow)
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}

/** Matches when this family is among the distribution's beneficiaries. */
export function aidForFamily(familyId) {
  return searchAid({ familyId });
}

/** What a displaced person has received — that is, what their family received. */
export function aidForPerson(displacedId) {
  const person = store.displaced.get(displacedId);
  if (!person || !person.familyId) return [];
  return aidForFamily(person.familyId);
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

/**
 * Filter an already-resolved `familyOptions()` list by family ID or head
 * name — the label already carries both, so one substring match covers the
 * search behaviour every family multi-select needs.
 */
export function searchFamilyOptions(options, query = '') {
  const term = query.trim().toLowerCase();
  if (!term) return options;
  return options.filter((option) => option.label.toLowerCase().includes(term));
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

/* ---- Donors -------------------------------------------------------------- */

/**
 * A donor has a name, plus an optional responsible person and phone. It may be
 * an organisation, an initiative or a single person, so nothing else is asked
 * for and nothing but the name is required.
 */
export function organizationRow(org) {
  const aidRows = store.aid.list((record) => record.organizationId === org.id);
  return {
    ...org,
    aidCount: aidRows.length,
    familiesCount: new Set(aidRows.flatMap((record) => record.familyIds || [])).size,
  };
}

export function searchOrganizations({ query = '' } = {}) {
  const term = query.trim().toLowerCase();
  return store.organizations
    .list(
      (org) =>
        !term ||
        org.name.toLowerCase().includes(term) ||
        (org.responsiblePerson || '').toLowerCase().includes(term) ||
        (org.phone || '').includes(term)
    )
    .map(organizationRow)
    .sort((a, b) => b.aidCount - a.aidCount);
}

/** A donor still referenced by aid records must not be deleted. */
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
    tentType: 'tarp_tent',
    workStatus: 'unemployed',
    incomeSource: 'none',
    monthlyIncome: 0,
    chronicDiseases: '',
    disability: '',
    fatherStatus: 'alive',
    motherStatus: 'alive',
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

  // Aid belongs to the family, not the person, so it survives them; it is only
  // removed when the family itself goes (see removeFamily).
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
  // A distribution's beneficiary list is fixed at creation time; removing one
  // of several beneficiary families removes the whole shared record rather
  // than trying to edit a snapshot after the fact.
  store.aid.removeWhere((record) => (record.familyIds || []).includes(familyId));
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
    donors: new Set(aidRows.map((record) => record.organizationId)).size,
    disability: people.filter((person) => Boolean(person.disability)).length,
    chronic: people.filter((person) => Boolean(person.chronicDiseases)).length,
    males: people.filter((person) => person.gender === 'male').length,
    females: people.filter((person) => person.gender === 'female').length,
    // Age-derived, not relationship-derived: a "son" of 30 is not a child.
    children: people.filter(isChild).length,
    orphans: people.filter(isOrphan).length,
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
    count: rows.filter((row) => (row.types || []).includes(type.value)).length,
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

/** Number of deliveries per donor, largest first. */
export function aidByOrganization(session) {
  const rows = store.aid.list(
    session && session.role === ROLES.CAMP_ADMIN ? (row) => row.campId === session.campId : () => true
  );
  return store.organizations
    .list()
    .map((org) => ({
      value: org.id,
      label: org.name,
      count: rows.filter((record) => record.organizationId === org.id).length,
    }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count);
}

/** Number of aid deliveries per month for the last `months` months. */
export function aidCountByMonth(session, months = 8) {
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
    if (bucket) bucket.value += 1;
  });
  return buckets;
}

/** Families that received the most deliveries — used by the statistics page. */
export function topFamiliesByAid(session, limit = 5) {
  const rows = store.aid.list(
    session && session.role === ROLES.CAMP_ADMIN ? (row) => row.campId === session.campId : () => true
  );
  const counts = new Map();
  rows.forEach((record) => {
    (record.familyIds || []).forEach((familyId) => {
      counts.set(familyId, (counts.get(familyId) || 0) + 1);
    });
  });
  return [...counts.entries()]
    .map(([familyId, count]) => {
      const family = store.families.get(familyId);
      const head = family ? store.displaced.get(family.headId) : null;
      return {
        familyId,
        count,
        headName: head ? head.fullName : '—',
        campName: family ? campName(family.campId) : '—',
      };
    })
    .sort((a, b) => b.count - a.count)
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
      childrenCount: people.filter(isChild).length,
      orphansCount: people.filter(isOrphan).length,
    };
  });
}

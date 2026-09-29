/**
 * Domain queries composed from real (already camelCase) rows.
 *
 * Business logic lives here, not in page modules: pure predicates
 * ("does this row match these filters") and pure aggregations ("bucket
 * these rows by month/age/size"), never data access of their own. Every
 * function takes plain arguments — the rows a page already fetched through
 * `supabase/*.js` — and returns plain data, so it ports to a server
 * component or an RPC without change.
 *
 * This file used to also hold the mock/localStorage query layer (search,
 * option lists, cascading deletes, registration decisions) from before the
 * real backend landed. That layer is gone — every page now reads/writes
 * Supabase directly — so only the parts every real page still needs remain.
 */

import {
  AID_TYPES,
  labelOf,
  GOVERNORATES,
  WORK_STATUSES,
  TENT_TYPES,
  DOCUMENT_CATEGORIES,
  MESSAGE_SUBJECTS,
  AGE_BANDS,
  FAMILY_SIZES,
} from './config.js';
import { ageFrom } from '../utils/format.js';

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

/* ---- Age / child / orphan facts ------------------------------------------ */

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
 * An orphan is a minor (under 18) who is unmarried and has a deceased parent.
 * A married adult — e.g. a family head — who lost a parent is not an orphan.
 * Mirrors public.is_orphan() in the database; nothing stores it directly.
 */
export function isOrphan(person) {
  const parentDeceased = person.fatherStatus === 'deceased' || person.motherStatus === 'deceased';
  return parentDeceased && person.maritalStatus === 'single' && isChild(person);
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

/* ---- Real-data filter predicates ------------------------------------------
 * One pure predicate per record type, shared by every role's list page
 * (Camp Admin's own-camp query, Super Admin's platform-wide one, a
 * displaced person's own-family one) so they can never disagree about what
 * a filter means. `campId`, where present, is only meaningful for a caller
 * whose rows span more than one camp (a Super Admin's platform-wide list);
 * a Camp Admin/Displaced path never sets it, since its query is already
 * scoped to one camp/family. */

/**
 * Whether one family (the shape `getCampFamilies()`/`getAllFamilies()`
 * return) matches a search term and every active member-characteristic
 * filter. A family matches a characteristic filter when at least one of its
 * members satisfies it (domain spec §12).
 */
export function matchesFamilyFilters(family, filters = {}) {
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

  if (campId && family.campId !== campId) return false;

  const term = query.trim().toLowerCase();
  const bucket = FAMILY_SIZES.find((entry) => entry.value === size);

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
}

/**
 * Whether one aid-distribution row (the shape `getCampAidDistributions()`/
 * `getAllAidDistributions()`/`getAidDistribution()` return) matches a
 * search term and every active filter.
 */
export function matchesAidFilters(row, filters = {}) {
  const { query = '', type = '', organizationId = '', familyId = '' } = filters;

  if (type && !(row.types || []).includes(type)) return false;
  if (organizationId && row.organizationId !== organizationId) return false;
  if (familyId && !(row.familyDbIds || []).includes(familyId)) return false;

  const term = query.trim().toLowerCase();
  if (!term) return true;
  const headNames = (row.beneficiaries || []).map((b) => (b.headName || '').toLowerCase());
  return (
    (row.familyIds || []).some((id) => id.toLowerCase().includes(term)) ||
    headNames.some((name) => name.includes(term)) ||
    (row.organizationName || '').toLowerCase().includes(term) ||
    (row.typeLabels || '').toLowerCase().includes(term)
  );
}

/**
 * Whether one displaced-person row (the shape `getCampDisplacedPersons()`/
 * `getAllDisplacedPersons()`/`getDisplacedPerson()` return) matches a
 * search term and every active filter.
 *
 * `aidFamilyIds`, when the aid-type/donor filter is active, is a Set of
 * family reference codes known to have received a matching distribution
 * (`getFamilyIdsForAidFilter()`).
 */
export function matchesDisplacedFilters(person, filters = {}, { aidFamilyIds = null } = {}) {
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

  if (campId && person.campId !== campId) return false;
  if (gender && person.gender !== gender) return false;
  if (status && person.status !== status) return false;
  if (tentType && person.tentType !== tentType) return false;
  if ((aidType || organizationId) && !(aidFamilyIds && aidFamilyIds.has(person.familyId))) return false;

  const facts = personFacts(person);
  const band = AGE_BANDS.find((entry) => entry.value === ageBand);
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

  const term = query.trim().toLowerCase();
  if (!term) return true;
  return (
    person.fullName.toLowerCase().includes(term) ||
    (person.fullNameEn || '').toLowerCase().includes(term) ||
    (person.nationalId || '').includes(term) ||
    (person.phone || '').includes(term) ||
    (person.familyId || '').toLowerCase().includes(term)
  );
}

/** Pure predicate over one real organization row from `listOrganizationsWithUsage()`. */
export function matchesOrganizationFilters(row, { query = '' } = {}) {
  const term = query.trim().toLowerCase();
  if (!term) return true;
  return (
    row.name.toLowerCase().includes(term) ||
    (row.responsiblePerson || '').toLowerCase().includes(term) ||
    (row.phone || '').includes(term)
  );
}

/** Pure predicate over one real registration-request row. */
export function matchesRegistrationRequestFilters(row, { query = '', status = '' } = {}) {
  if (status && row.status !== status) return false;
  const term = query.trim().toLowerCase();
  if (!term) return true;
  return (
    row.fullName.toLowerCase().includes(term) ||
    (row.nationalId || '').includes(term) ||
    (row.phone || '').includes(term) ||
    (row.email || '').toLowerCase().includes(term)
  );
}

/** Pure predicate over one real document row. */
export function matchesDocumentFilters(row, { query = '', category = '', campId = '' } = {}) {
  if (campId && row.campId !== campId) return false;
  if (category && row.category !== category) return false;
  const term = query.trim().toLowerCase();
  if (!term) return true;
  return (
    row.name.toLowerCase().includes(term) ||
    row.personName.toLowerCase().includes(term) ||
    (row.familyId || '').toLowerCase().includes(term)
  );
}

/** Pure predicate over one real message row. */
export function matchesMessageFilters(row, { query = '', status = '', subject = '' } = {}) {
  if (status && row.status !== status) return false;
  if (subject && row.subject !== subject) return false;
  const term = query.trim().toLowerCase();
  if (!term) return true;
  return (
    row.body.toLowerCase().includes(term) ||
    labelOf(MESSAGE_SUBJECTS, row.subject).toLowerCase().includes(term) ||
    (row.senderName || '').toLowerCase().includes(term)
  );
}

/** Pure predicate over one real camp-admin-account row from `listCampAdminAccounts()`. */
export function matchesCampAdminFilters(row, { query = '', campId = '', status = '' } = {}) {
  if (campId && row.campId !== campId) return false;
  if (status && row.status !== status) return false;
  const term = query.trim().toLowerCase();
  if (!term) return true;
  return (
    row.fullName.toLowerCase().includes(term) ||
    row.email.toLowerCase().includes(term) ||
    (row.phone || '').includes(term)
  );
}

/* ---- Statistics (real data — statistics.html, Super Admin only) --------- */
/*
 * Every function below takes the already-fetched real row arrays
 * (getAllDisplacedPersons()/getAllFamilies()/getAllAidDistributions()/
 * getAllDocuments(), all fetched once in statistics.js's collect()) instead
 * of a session + store lookup — pure aggregation, no data access of its own.
 * Per-camp totals are just listCampsWithStats() (Phase 4.10), called
 * directly from statistics.js.
 */

/** Headline counters for the dashboard cards. */
export function statistics({ people, families, aidRows, documents, camps }) {
  return {
    displaced: people.length,
    families: families.length,
    aid: aidRows.length,
    donors: new Set(aidRows.map((record) => record.organizationId)).size,
    disability: people.filter((person) => Boolean(person.disability)).length,
    chronic: people.filter((person) => Boolean(person.chronicDiseases)).length,
    males: people.filter((person) => person.gender === 'male').length,
    females: people.filter((person) => person.gender === 'female').length,
    // Age-derived, not relationship-derived: a "son" of 30 is not a child.
    children: people.filter(isChild).length,
    orphans: people.filter(isOrphan).length,
    camps: camps.length,
    campAdmins: camps.reduce((sum, camp) => sum + (camp.adminsCount || 0), 0),
    documents: documents.length,
  };
}

/** Registrations per month for the last `months` months. */
export function displacedByMonth(people, months = 8) {
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
export function aidByType(aidRows) {
  return AID_TYPES.map((type) => ({
    value: type.value,
    label: type.label,
    count: aidRows.filter((row) => (row.types || []).includes(type.value)).length,
  })).filter((entry) => entry.count > 0);
}

/** Family size distribution, bucketed. */
export function familySizeDistribution(families) {
  const buckets = [
    { label: '1–2 أفراد', min: 1, max: 2, count: 0 },
    { label: '3–4 أفراد', min: 3, max: 4, count: 0 },
    { label: '5–6 أفراد', min: 5, max: 6, count: 0 },
    { label: '7 فأكثر', min: 7, max: Infinity, count: 0 },
  ];
  families.forEach((family) => {
    const bucket = buckets.find((entry) => family.membersCount >= entry.min && family.membersCount <= entry.max);
    if (bucket) bucket.count += 1;
  });
  return buckets;
}

/** Age brackets used by the statistics page. */
export function ageDistribution(people) {
  const buckets = [
    { label: 'أقل من 5 سنوات', min: 0, max: 4, count: 0 },
    { label: '5 – 17 سنة', min: 5, max: 17, count: 0 },
    { label: '18 – 40 سنة', min: 18, max: 40, count: 0 },
    { label: '41 – 60 سنة', min: 41, max: 60, count: 0 },
    { label: 'أكثر من 60 سنة', min: 61, max: 200, count: 0 },
  ];
  people.forEach((person) => {
    const age = ageFrom(person.birthDate);
    if (age === null) return;
    const bucket = buckets.find((entry) => age >= entry.min && age <= entry.max);
    if (bucket) bucket.count += 1;
  });
  return buckets;
}

/** Counts for any `{value,label}` enum over a field of the person record. */
function distributionOver(people, list, field) {
  return list
    .map((item) => ({
      value: item.value,
      label: item.label,
      count: people.filter((person) => person[field] === item.value).length,
    }))
    .filter((entry) => entry.count > 0);
}

export function workStatusDistribution(people) {
  return distributionOver(people, WORK_STATUSES, 'workStatus');
}

export function tentTypeDistribution(people) {
  return distributionOver(people, TENT_TYPES, 'tentType');
}

/** Where the people in scope were displaced from. */
export function originDistribution(people) {
  return distributionOver(people, GOVERNORATES, 'originGovernorate');
}

/** Number of deliveries per donor, largest first. Each real aid row already
 *  carries its own donor name (mapAidDistributionRow()), so no separate
 *  organizations fetch is needed. */
export function aidByOrganization(aidRows) {
  const counts = new Map();
  aidRows.forEach((record) => {
    if (!record.organizationId) return;
    const entry = counts.get(record.organizationId) || { value: record.organizationId, label: record.organizationName, count: 0 };
    entry.count += 1;
    counts.set(record.organizationId, entry);
  });
  return [...counts.values()].sort((a, b) => b.count - a.count);
}

/** Number of aid deliveries per month for the last `months` months. */
export function aidCountByMonth(aidRows, months = 8) {
  const buckets = [];
  const now = new Date();
  for (let i = months - 1; i >= 0; i -= 1) {
    const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
    buckets.push({ date, key: `${date.getFullYear()}-${date.getMonth()}`, value: 0 });
  }
  const index = new Map(buckets.map((bucket) => [bucket.key, bucket]));
  aidRows.forEach((record) => {
    const date = new Date(record.date);
    if (Number.isNaN(date.getTime())) return;
    const bucket = index.get(`${date.getFullYear()}-${date.getMonth()}`);
    if (bucket) bucket.value += 1;
  });
  return buckets;
}

/** Families that received the most deliveries — used by the statistics
 *  page. Each real aid row already carries its beneficiaries' reference
 *  code, head name and the distribution's own camp name, so no separate
 *  families/displaced fetch is needed to label the result. */
export function topFamiliesByAid(aidRows, limit = 5) {
  const counts = new Map();
  aidRows.forEach((record) => {
    (record.beneficiaries || []).forEach((beneficiary) => {
      const entry = counts.get(beneficiary.familyId) || {
        familyId: beneficiary.familyId,
        count: 0,
        headName: beneficiary.headName || '—',
        campName: record.campName || '—',
      };
      entry.count += 1;
      counts.set(beneficiary.familyId, entry);
    });
  });
  return [...counts.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}

/** Document counts grouped by category. */
export function documentsByCategory(documents) {
  return DOCUMENT_CATEGORIES.map((category) => ({
    value: category.value,
    label: category.label,
    count: documents.filter((row) => row.category === category.value).length,
  }));
}

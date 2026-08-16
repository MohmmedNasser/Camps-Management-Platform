/**
 * Excel export definitions.
 *
 * The column sets live here rather than in the page modules so the export and
 * the query it reads stay next to each other. Rows are produced from exactly
 * the same `getFilteredDisplaced` / `getFilteredFamilies` results the table
 * renders, so the count on screen is always the row count in the file.
 *
 * Fields the domain has removed are absent by construction: there is no tent
 * number, caravan number, file number, camp-representative name or family-needs
 * column anywhere below.
 */

import { ageFrom } from '../utils/format.js';
import { labelOf, GENDERS, TENT_TYPES, GOVERNORATES, WORK_STATUSES, INCOME_SOURCES } from './config.js';
import { campName, personFacts } from './selectors.js';

const yesNo = (value) => (value ? 'نعم' : 'لا');

/** Maternity is not a yes/no question for a male record. */
const maternity = (person, value) => (person.gender === 'female' ? yesNo(value) : 'لا ينطبق');

/* ---- Displaced people ---------------------------------------------------- */

export const DISPLACED_COLUMNS = [
  { key: 'fullName', label: 'الاسم الكامل', width: 28 },
  { key: 'nationalId', label: 'رقم الهوية', width: 14 },
  { key: 'gender', label: 'الجنس', width: 10 },
  { key: 'age', label: 'العمر', width: 8 },
  { key: 'phone', label: 'رقم الجوال', width: 14 },
  { key: 'campName', label: 'المخيم', width: 18 },
  { key: 'originCity', label: 'المدينة الأصلية', width: 18 },
  { key: 'displacementDate', label: 'تاريخ النزوح', width: 14 },
  { key: 'tentType', label: 'نوع وحدة الإيواء', width: 16 },
  { key: 'chronicDiseases', label: 'الأمراض المزمنة', width: 22 },
  { key: 'disability', label: 'إعاقة', width: 18 },
  { key: 'isOrphan', label: 'يتيم', width: 10 },
  { key: 'isBreastfeeding', label: 'مرضعة', width: 12 },
  { key: 'isPregnant', label: 'حامل', width: 10 },
  { key: 'workStatus', label: 'حالة العمل', width: 16 },
  { key: 'incomeSource', label: 'مصدر الدخل', width: 16 },
  { key: 'monthlyIncome', label: 'الدخل الشهري', width: 14 },
];

/** One spreadsheet row from one displaced record. */
export function displacedExportRow(person) {
  const facts = personFacts(person);
  const age = ageFrom(person.birthDate);

  return {
    fullName: person.fullName,
    // Kept as text so a leading zero is never eaten by Excel.
    nationalId: person.nationalId,
    gender: labelOf(GENDERS, person.gender),
    age: age === null ? '' : age,
    phone: person.phone,
    campName: person.campName || campName(person.campId),
    originCity: person.originCity || labelOf(GOVERNORATES, person.originGovernorate, ''),
    displacementDate: person.displacementDate,
    tentType: labelOf(TENT_TYPES, person.tentType),
    chronicDiseases: person.chronicDiseases,
    disability: person.disability,
    isOrphan: yesNo(facts.isOrphan),
    isBreastfeeding: maternity(person, facts.isBreastfeeding),
    isPregnant: maternity(person, facts.isPregnant),
    workStatus: labelOf(WORK_STATUSES, person.workStatus),
    incomeSource: labelOf(INCOME_SOURCES, person.incomeSource),
    monthlyIncome: Number(person.monthlyIncome || 0),
  };
}

/* ---- Families ------------------------------------------------------------ */

export const FAMILY_COLUMNS = [
  { key: 'id', label: 'رقم الأسرة', width: 16 },
  { key: 'headName', label: 'رب الأسرة', width: 28 },
  { key: 'campName', label: 'المخيم', width: 18 },
  { key: 'membersCount', label: 'عدد أفراد الأسرة', width: 16 },
  { key: 'childrenUnder18', label: 'عدد الأطفال أقل من 18', width: 20 },
  { key: 'childrenUnder3', label: 'عدد الأطفال أقل من 3', width: 20 },
  { key: 'childrenUnder2', label: 'عدد الأطفال أقل من سنتين', width: 22 },
  { key: 'childrenUnder1', label: 'عدد الأطفال أقل من سنة', width: 22 },
  { key: 'orphans', label: 'عدد الأيتام', width: 14 },
  { key: 'chronic', label: 'عدد المرضى بأمراض مزمنة', width: 24 },
  { key: 'breastfeeding', label: 'عدد المرضعات', width: 16 },
  { key: 'pregnant', label: 'عدد الحوامل', width: 14 },
];

/**
 * One spreadsheet row from one family. Every count is derived from the
 * members by `familyFacts`, never read from a stored field.
 */
export function familyExportRow(family) {
  return {
    id: family.id,
    headName: family.headName,
    campName: family.campName,
    membersCount: family.membersCount,
    childrenUnder18: family.childrenUnder18,
    childrenUnder3: family.childrenUnder3,
    childrenUnder2: family.childrenUnder2,
    childrenUnder1: family.childrenUnder1,
    orphans: family.orphans,
    chronic: family.chronic,
    breastfeeding: family.breastfeeding,
    pregnant: family.pregnant,
  };
}

/* ---- Aid ------------------------------------------------------------------ */

export const AID_COLUMNS = [
  { key: 'typeLabels', label: 'نوع المساعدة', width: 30 },
  { key: 'organizationName', label: 'الجهة المانحة', width: 24 },
  { key: 'beneficiaryCount', label: 'عدد الأسر المستفيدة', width: 18 },
  { key: 'campName', label: 'المخيم', width: 18 },
  { key: 'date', label: 'تاريخ التوزيع', width: 14 },
];

/** One spreadsheet row from one aid distribution — `aidRow()`'s shape already matches. */
export function aidExportRow(record) {
  return {
    typeLabels: record.typeLabels,
    organizationName: record.organizationName,
    beneficiaryCount: record.beneficiaryCount,
    campName: record.campName,
    date: record.date,
  };
}

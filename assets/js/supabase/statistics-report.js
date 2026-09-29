// assets/js/supabase/statistics-report.js
// Pure shaping of `get_statistics_report()` (Phase 4.24) into the structures
// statistics.js already renders. No client import: testable in Node. Labels
// stay here (from config.js); SQL only returns value -> count.
import { AID_TYPES, WORK_STATUSES, TENT_TYPES, GOVERNORATES, DOCUMENT_CATEGORIES } from '../core/config.js';

const AGE_LABELS = ['أقل من 5 سنوات', '5 – 17 سنة', '18 – 40 سنة', '41 – 60 سنة', 'أكثر من 60 سنة'];
const SIZE_LABELS = ['1–2 أفراد', '3–4 أفراد', '5–6 أفراد', '7 فأكثر'];

const months = (list) =>
  list.map(({ month, value }) => {
    const [year, mon] = month.split('-').map(Number);
    return { date: new Date(year, mon - 1, 1), value: Number(value) };
  });

/** Only values that occur, in the order and with the labels of `list` (unknown DB values are dropped, as before). */
const distribution = (list, counts) =>
  list
    .map((item) => ({ value: item.value, label: item.label, count: Number(counts[item.value]) || 0 }))
    .filter((entry) => entry.count > 0);

export function shapeStatisticsReport(raw) {
  const s = raw.stats;
  return {
    stats: {
      displaced: Number(s.displaced),
      families: Number(s.families),
      aid: Number(s.aid),
      donors: Number(s.donors),
      disability: Number(s.disability),
      chronic: Number(s.chronic),
      males: Number(s.males),
      females: Number(s.females),
      children: Number(s.children),
      orphans: Number(s.orphans),
      documents: Number(s.documents),
    },
    byMonth: months(raw.by_month),
    aidCountByMonth: months(raw.aid_by_month),
    aidByType: distribution(AID_TYPES, raw.aid_by_type),
    aidByOrganization: raw.aid_by_organization.map((o) => ({ value: o.id, label: o.name, count: Number(o.count) })),
    familySizes: SIZE_LABELS.map((label, i) => ({ label, count: Number(raw.family_sizes[i]) })),
    ages: AGE_LABELS.map((label, i) => ({ label, count: Number(raw.ages[i]) })),
    work: distribution(WORK_STATUSES, raw.work),
    tents: distribution(TENT_TYPES, raw.tents),
    origins: distribution(GOVERNORATES, raw.origins),
    documents: distribution(DOCUMENT_CATEGORIES, raw.documents_by_category),
    topFamilies: raw.top_families.map((f) => ({
      familyId: f.family_id,
      count: Number(f.count),
      headName: f.head_name,
      campName: f.camp_name,
    })),
  };
}

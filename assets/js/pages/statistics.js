/**
 * Statistics (Super Admin only).
 *
 * Every number here comes from a selector, never from a filter written in the
 * page — the same functions will back the reporting queries after the port.
 * Charts degrade to CSS bars when the Chart.js CDN is unavailable.
 */

import { esc, delegate } from '../utils/dom.js';
import { formatNumber, formatDate } from '../utils/format.js';
import { mountShell } from '../ui/layout.js';
import {
  button,
  card,
  statCard,
  emptyState,
  errorState,
  skeletonStats,
  skeletonChart,
  pageHeader,
  barList,
} from '../ui/components.js';
import { dataTable, cellMain, cellMono } from '../ui/table.js';
import {
  chartCard,
  monthlyLine,
  aidTypeBar,
  genderDoughnut,
  familySizeBar,
  campComparisonBar,
  legendItems,
} from '../ui/charts.js';
import { pageUrl } from '../core/router.js';
import * as store from '../core/store.js';
import * as select from '../core/selectors.js';
import { CHART_COLORS } from '../core/config.js';

const shell = mountShell({ active: 'statistics.html', title: 'الإحصائيات' });
if (shell) init(shell);

async function init({ session, content }) {
  content.innerHTML = `
    ${pageHeader({ title: 'الإحصائيات' })}
    <div class="grid grid--4 u-mb-6">${skeletonStats(4)}</div>
    <div class="grid grid--2">${skeletonChart()}${skeletonChart()}</div>`;

  try {
    const data = await store.load(() => collect(session));

    if (!data.stats.displaced && !data.camps.length) {
      content.innerHTML = `
        ${pageHeader({ title: 'الإحصائيات' })}
        ${emptyState({
          iconName: 'chart',
          title: 'لا توجد بيانات كافية',
          text: 'ستظهر الإحصائيات فور تسجيل النازحين والأسر والمساعدات في المخيمات.',
          actions: button({ label: 'إدارة المخيمات', variant: 'primary', href: pageUrl('camps.html') }),
        })}`;
      return;
    }

    content.innerHTML = view(data);
    draw(data);
  } catch (error) {
    console.error(error);
    content.innerHTML = errorState({ retryAttrs: 'data-retry' });
    delegate(content, 'click', '[data-retry]', () => init({ session, content }));
  }
}

function collect(session) {
  return {
    stats: select.statistics(session),
    camps: select.campBreakdown(),
    byMonth: select.displacedByMonth(session, 8),
    aidByType: select.aidByType(session),
    aidByOrganization: select.aidByOrganization(session),
    aidCountByMonth: select.aidCountByMonth(session, 8),
    familySizes: select.familySizeDistribution(session),
    ages: select.ageDistribution(session),
    work: select.workStatusDistribution(session),
    tents: select.tentTypeDistribution(session),
    origins: select.originDistribution(session),
    topFamilies: select.topFamiliesByAid(session, 5),
    documents: select.documentsByCategory(session).filter((entry) => entry.count > 0),
  };
}

/* ---- View ------------------------------------------------------------------ */

function view(data) {
  const { stats } = data;

  return `
    ${pageHeader({
      title: 'الإحصائيات',
      description: `نظرة شاملة على جميع المخيمات — ${formatDate(new Date())}`,
      actions: button({
        label: 'طباعة التقرير',
        variant: 'secondary',
        iconName: 'download',
        attrs: 'data-print',
      }),
    })}

    <div class="grid grid--4 u-mb-6">
      ${statCard({ label: 'المخيمات', value: formatNumber(stats.camps), iconName: 'tent', href: pageUrl('camps.html') })}
      ${statCard({ label: 'إجمالي النازحين', value: formatNumber(stats.displaced), iconName: 'users', href: pageUrl('displaced.html') })}
      ${statCard({ label: 'إجمالي الأسر', value: formatNumber(stats.families), iconName: 'family', tone: 'success', href: pageUrl('families.html') })}
      ${statCard({ label: 'المساعدات الموزَّعة', value: formatNumber(stats.aid), iconName: 'aid', meta: `${formatNumber(stats.donors)} جهة مانحة` })}
      ${statCard({ label: 'ذوو الإعاقة', value: formatNumber(stats.disability), iconName: 'accessibility', tone: 'error' })}
      ${statCard({ label: 'الأمراض المزمنة', value: formatNumber(stats.chronic), iconName: 'heartPulse', tone: 'warning' })}
      ${statCard({ label: 'الأطفال أقل من 18 عامًا', value: formatNumber(stats.children), iconName: 'users' })}
      ${statCard({ label: 'الأيتام', value: formatNumber(stats.orphans), iconName: 'family', tone: 'warning' })}
    </div>

    <div class="grid grid--2 u-mb-6">
      ${chartCard({ id: 'chart-camps', title: 'مقارنة المخيمات', subtitle: 'عدد النازحين والأسر لكل مخيم' })}
      ${chartCard({ id: 'chart-monthly', title: 'التسجيلات حسب الشهر', subtitle: 'آخر 8 أشهر' })}
      ${chartCard({
        id: 'chart-gender',
        title: 'التوزيع حسب الجنس',
        legend: legendItems([
          { label: 'ذكور', value: data.stats.males, color: CHART_COLORS[0] },
          { label: 'إناث', value: data.stats.females, color: CHART_COLORS[4] },
        ]),
      })}
      ${chartCard({ id: 'chart-families', title: 'توزيع الأسر', subtitle: 'حسب عدد الأفراد' })}
      ${chartCard({ id: 'chart-aid', title: 'المساعدات حسب النوع', subtitle: 'عدد السجلات لكل نوع' })}
      ${chartCard({ id: 'chart-aid-month', title: 'المساعدات الموزَّعة شهرياً', subtitle: 'عدد عمليات التوزيع — آخر 8 أشهر' })}
    </div>

    <div class="grid grid--2 u-mb-6">
      ${card({
        title: 'الفئات العمرية',
        body: data.ages.some((bucket) => bucket.count)
          ? barList(data.ages.map((bucket) => ({ label: bucket.label, value: bucket.count })))
          : emptyState({ iconName: 'users', title: 'لا توجد بيانات أعمار', text: 'لم تُسجَّل تواريخ ميلاد بعد.' }),
      })}
      ${card({
        title: 'حالة العمل',
        body: data.work.length
          ? barList(
              data.work.map((entry, index) => ({
                label: entry.label,
                value: entry.count,
                color: CHART_COLORS[index % CHART_COLORS.length],
              }))
            )
          : emptyState({ iconName: 'briefcase', title: 'لا توجد بيانات', text: 'لم تُسجَّل حالات عمل بعد.' }),
      })}
      ${card({
        title: 'نوع الإيواء',
        body: data.tents.length
          ? barList(data.tents.map((entry) => ({ label: entry.label, value: entry.count })))
          : emptyState({ iconName: 'tent', title: 'لا توجد بيانات', text: 'لم يُسجَّل نوع إيواء بعد.' }),
      })}
      ${card({
        title: 'محافظات النزوح الأصلية',
        body: data.origins.length
          ? barList(
              data.origins.map((entry, index) => ({
                label: entry.label,
                value: entry.count,
                color: CHART_COLORS[(index + 2) % CHART_COLORS.length],
              }))
            )
          : emptyState({ iconName: 'mapPin', title: 'لا توجد بيانات', text: 'لم تُسجَّل محافظات النزوح بعد.' }),
      })}
    </div>

    <div class="grid grid--2 u-mb-6">
      ${card({
        title: 'الجهات المانحة',
        action: `<a class="btn btn--ghost btn--sm" href="${pageUrl('organizations.html')}">إدارة الجهات</a>`,
        body: data.aidByOrganization.length
          ? barList(
              data.aidByOrganization.map((entry) => ({
                label: entry.label,
                value: entry.count,
                display: `${entry.count} مساعدة`,
              }))
            )
          : emptyState({
              iconName: 'building',
              title: 'لا توجد مساعدات مسجلة',
              text: 'ستظهر هنا حصة كل جهة مانحة فور تسجيل المساعدات.',
            }),
      })}
      ${card({
        title: 'الأسر الأكثر استفادة',
        body: data.topFamilies.length
          ? `<div class="list">${data.topFamilies
              .map(
                (family) => `
              <a class="list__row" href="${pageUrl('family-details.html', { id: family.familyId })}">
                <span class="list__main">
                  <span class="list__title mono">${esc(family.familyId)}</span>
                  <span class="list__meta">${esc(family.headName)} · ${esc(family.campName)}</span>
                </span>
                <span class="list__side">
                  <span class="mono u-sm">${esc(`${family.count} مساعدة`)}</span>
                </span>
              </a>`
              )
              .join('')}</div>`
          : emptyState({
              iconName: 'family',
              title: 'لا توجد بيانات',
              text: 'ستظهر هنا الأسر الأكثر استفادة من المساعدات.',
            }),
      })}
    </div>

    ${card({
      title: 'تفصيل المخيمات',
      flush: true,
      body: campsTable(data.camps),
    })}`;
}

function campsTable(camps) {
  if (!camps.length) {
    return emptyState({ iconName: 'tent', title: 'لا توجد مخيمات', text: 'أضف مخيماً لعرض تفاصيله.' });
  }

  return dataTable({
    columns: [
      { key: 'name', label: 'المخيم', primary: true, cell: (row) => cellMain(row.name, row.city) },
      { key: 'displacedCount', label: 'النازحون', cell: (row) => cellMono(row.displacedCount) },
      { key: 'familiesCount', label: 'الأسر', cell: (row) => cellMono(row.familiesCount) },
      { key: 'aidCount', label: 'المساعدات', cell: (row) => cellMono(row.aidCount) },
      { key: 'childrenCount', label: 'الأطفال', cell: (row) => cellMono(row.childrenCount) },
      { key: 'orphansCount', label: 'الأيتام', cell: (row) => cellMono(row.orphansCount) },
      { key: 'disabilityCount', label: 'ذوو الإعاقة', cell: (row) => cellMono(row.disabilityCount) },
      { key: 'adminsCount', label: 'المسؤولون', cell: (row) => cellMono(row.adminsCount) },
      {
        key: 'average',
        label: 'متوسط حجم الأسرة',
        cell: (row) =>
          cellMono(
            row.familiesCount ? (row.displacedCount / row.familiesCount).toFixed(1) : '—'
          ),
      },
    ],
    rows: camps,
    caption: 'تفصيل المخيمات',
  });
}

function draw(data) {
  campComparisonBar('chart-camps', data.camps);
  monthlyLine('chart-monthly', data.byMonth);
  genderDoughnut('chart-gender', { males: data.stats.males, females: data.stats.females });
  familySizeBar('chart-families', data.familySizes);
  aidTypeBar('chart-aid', data.aidByType);
  monthlyLine('chart-aid-month', data.aidCountByMonth, 'عدد المساعدات');

  delegate(document, 'click', '[data-print]', () => window.print());
}

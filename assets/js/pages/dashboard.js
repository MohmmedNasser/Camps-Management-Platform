/**
 * Dashboard — one route, three role variants.
 * Camp Admin: camp operations. Super Admin: cross-camp overview.
 * Displaced person: their own file, family and aid history.
 */

import { esc, delegate } from '../utils/dom.js';
import { formatDate, formatNumber, formatCurrency, formatRelative } from '../utils/format.js';
import { mountShell } from '../ui/layout.js';
import {
  button,
  statCard,
  card,
  statusBadge,
  emptyState,
  errorState,
  skeletonStats,
  skeletonChart,
  pageHeader,
  definitionList,
  definition,
} from '../ui/components.js';
import { icon } from '../ui/icons.js';
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
import { ROLES, STATUS, CHART_COLORS } from '../core/config.js';

const shell = mountShell({ active: 'dashboard.html', title: 'الرئيسية' });
if (shell) init(shell);

/* ---- Entry -------------------------------------------------------------- */

async function init({ session, content }) {
  content.innerHTML = loadingView();

  try {
    const data = await store.load(() => collect(session));
    content.innerHTML = viewFor(session, data);
    drawCharts(session, data);
    wire(content);
  } catch (error) {
    console.error(error);
    content.innerHTML = errorState({ retryAttrs: 'data-retry' });
    delegate(content, 'click', '[data-retry]', () => init({ session, content }));
  }
}

function collect(session) {
  const stats = select.statistics(session);
  return {
    stats,
    byMonth: select.displacedByMonth(session),
    aidByType: select.aidByType(session),
    familySizes: select.familySizeDistribution(session),
    camps: select.campBreakdown(),
    requests: store.registrationRequests
      .list((row) =>
        session.role === ROLES.SUPER_ADMIN ? true : row.campId === session.campId
      )
      .filter((row) => row.status === STATUS.PENDING)
      .slice(0, 4),
    recentAid: select
      .searchAid({ scope: select.scopeFilter(session) })
      .slice(0, 5),
    person: session.displacedId ? store.displaced.get(session.displacedId) : null,
    family: session.displacedId ? select.familyOfPerson(session.displacedId) : null,
    myAid: session.displacedId ? select.aidForPerson(session.displacedId) : [],
    myDocuments: session.displacedId
      ? store.documents.list((row) => row.displacedId === session.displacedId)
      : [],
    notifications: select.notificationsFor(session.id).slice(0, 4),
  };
}

function loadingView() {
  return `
    ${pageHeader({ title: 'الرئيسية' })}
    <div class="grid grid--4 u-mb-6">${skeletonStats(4)}</div>
    <div class="grid grid--2">${skeletonChart()}${skeletonChart()}</div>`;
}

/* ---- Shared pieces ------------------------------------------------------ */

function greeting(session, description) {
  const hour = new Date().getHours();
  const salutation = hour < 12 ? 'صباح الخير' : hour < 18 ? 'مساء الخير' : 'مساء الخير';
  return pageHeader({
    title: `${salutation}، ${session.name.split(' ')[0]}`,
    description,
  });
}

function listCard({ title, href, hrefLabel, rows, empty }) {
  return `
    <section class="card">
      <div class="card__head">
        <h2 class="card__title">${esc(title)}</h2>
        ${href ? `<a class="btn btn--ghost btn--sm" href="${esc(href)}">${esc(hrefLabel)}</a>` : ''}
      </div>
      <div class="card__body card__body--flush">
        ${rows.length ? `<div class="list">${rows.join('')}</div>` : empty}
      </div>
    </section>`;
}

function requestRow(request) {
  return `
    <a class="list__row" href="${pageUrl('registration-request-details.html', { id: request.id })}">
      <span class="list__main">
        <span class="list__title">${esc(request.fullName)}</span>
        <span class="list__meta"><span class="mono">${esc(request.nationalId)}</span> · ${esc(
          formatRelative(request.createdAt)
        )}</span>
      </span>
      <span class="list__side">${statusBadge(request.status)}${icon('chevronLeft', { size: 16 })}</span>
    </a>`;
}

function aidRow(record) {
  return `
    <a class="list__row" href="${pageUrl('aid-details.html', { id: record.id })}">
      <span class="list__main">
        <span class="list__title">${esc(record.typeLabel)} — ${esc(record.organizationName)}</span>
        <span class="list__meta">${esc(record.personName)} · <span class="mono">${esc(record.familyId)}</span> · ${esc(
          formatDate(record.date)
        )}</span>
      </span>
      <span class="list__side"><span class="mono u-sm">${esc(formatCurrency(record.value))}</span>${icon(
        'chevronLeft',
        { size: 16 }
      )}</span>
    </a>`;
}

/* ---- Camp Admin --------------------------------------------------------- */

function campAdminView(session, data) {
  const { stats } = data;

  return `
    ${greeting(session, `نظرة عامة على ${session.campLabel} — ${formatDate(new Date())}`)}

    <div class="grid grid--4 u-mb-6">
      ${statCard({ label: 'إجمالي النازحين', value: formatNumber(stats.displaced), iconName: 'users', href: pageUrl('displaced.html') })}
      ${statCard({ label: 'إجمالي الأسر', value: formatNumber(stats.families), iconName: 'family', tone: 'success', href: pageUrl('families.html') })}
      ${statCard({ label: 'طلبات التسجيل', value: formatNumber(stats.requests), iconName: 'clipboard', tone: 'warning', meta: stats.requests ? 'بانتظار المراجعة' : 'لا توجد طلبات', href: pageUrl('registration-requests.html') })}
      ${statCard({ label: 'إجمالي المساعدات', value: formatNumber(stats.aid), iconName: 'aid', meta: formatCurrency(stats.aidValue), href: pageUrl('aid.html') })}
      ${statCard({ label: 'ذوو الإعاقة', value: formatNumber(stats.disability), iconName: 'accessibility', tone: 'error' })}
      ${statCard({ label: 'الأمراض المزمنة', value: formatNumber(stats.chronic), iconName: 'heartPulse', tone: 'warning' })}
    </div>

    <div class="grid grid--2 u-mb-6">
      ${chartCard({ id: 'chart-monthly', title: 'عدد النازحين حسب الشهر', subtitle: 'التسجيلات خلال آخر 8 أشهر' })}
      ${chartCard({
        id: 'chart-gender',
        title: 'توزيع النازحين حسب الجنس',
        legend: legendItems([
          { label: 'ذكور', value: stats.males, color: CHART_COLORS[0] },
          { label: 'إناث', value: stats.females, color: CHART_COLORS[4] },
        ]),
      })}
      ${chartCard({ id: 'chart-aid', title: 'المساعدات حسب النوع', subtitle: 'عدد السجلات لكل نوع' })}
      ${chartCard({ id: 'chart-families', title: 'توزيع الأسر', subtitle: 'حسب عدد أفراد الأسرة' })}
    </div>

    <div class="grid grid--2">
      ${listCard({
        title: 'طلبات تسجيل بانتظار المراجعة',
        href: pageUrl('registration-requests.html'),
        hrefLabel: 'عرض الكل',
        rows: data.requests.map(requestRow),
        empty: emptyState({
          iconName: 'clipboard',
          title: 'لا توجد طلبات تسجيل',
          text: 'ستظهر هنا طلبات التسجيل الجديدة فور وصولها.',
        }),
      })}
      ${listCard({
        title: 'أحدث المساعدات',
        href: pageUrl('aid.html'),
        hrefLabel: 'عرض الكل',
        rows: data.recentAid.map(aidRow),
        empty: emptyState({
          iconName: 'aid',
          title: 'لا توجد مساعدات مسجلة',
          text: 'ابدأ بتسجيل أول مساعدة للأسر في المخيم.',
          actions: button({ label: 'إضافة مساعدة', variant: 'primary', iconName: 'plus', href: pageUrl('aid-create.html') }),
        }),
      })}
    </div>`;
}

/* ---- Super Admin -------------------------------------------------------- */

function campRow(camp) {
  return `
    <a class="list__row" href="${pageUrl('camps.html', { id: camp.id })}">
      <span class="list__main">
        <span class="list__title">${esc(camp.name)}</span>
        <span class="list__meta">${esc(camp.city)} · ${formatNumber(camp.displacedCount)} نازح · ${formatNumber(
          camp.familiesCount
        )} أسرة</span>
      </span>
      <span class="list__side">${statusBadge(camp.status)}${icon('chevronLeft', { size: 16 })}</span>
    </a>`;
}

function superAdminView(session, data) {
  const { stats } = data;

  return `
    ${greeting(session, `نظرة شاملة على جميع المخيمات — ${formatDate(new Date())}`)}

    <div class="grid grid--4 u-mb-6">
      ${statCard({ label: 'المخيمات', value: formatNumber(stats.camps), iconName: 'tent', href: pageUrl('camps.html') })}
      ${statCard({ label: 'مسؤولو المخيمات', value: formatNumber(stats.campAdmins), iconName: 'shield', tone: 'success', href: pageUrl('camp-admins.html') })}
      ${statCard({ label: 'إجمالي النازحين', value: formatNumber(stats.displaced), iconName: 'users', href: pageUrl('displaced.html') })}
      ${statCard({ label: 'إجمالي الأسر', value: formatNumber(stats.families), iconName: 'family', href: pageUrl('families.html') })}
      ${statCard({ label: 'إجمالي المساعدات', value: formatNumber(stats.aid), iconName: 'aid', meta: formatCurrency(stats.aidValue) })}
      ${statCard({ label: 'ذوو الإعاقة', value: formatNumber(stats.disability), iconName: 'accessibility', tone: 'error' })}
      ${statCard({ label: 'الأمراض المزمنة', value: formatNumber(stats.chronic), iconName: 'heartPulse', tone: 'warning' })}
      ${statCard({ label: 'طلبات التسجيل', value: formatNumber(stats.requests), iconName: 'clipboard', tone: 'warning' })}
    </div>

    <div class="grid grid--2 u-mb-6">
      ${chartCard({ id: 'chart-camps', title: 'المخيمات مقارنة', subtitle: 'عدد النازحين والأسر لكل مخيم' })}
      ${chartCard({ id: 'chart-monthly', title: 'عدد النازحين حسب الشهر', subtitle: 'كل المخيمات — آخر 8 أشهر' })}
      ${chartCard({
        id: 'chart-gender',
        title: 'توزيع النازحين حسب الجنس',
        legend: legendItems([
          { label: 'ذكور', value: stats.males, color: CHART_COLORS[0] },
          { label: 'إناث', value: stats.females, color: CHART_COLORS[4] },
        ]),
      })}
      ${chartCard({ id: 'chart-families', title: 'توزيع الأسر', subtitle: 'حسب عدد أفراد الأسرة' })}
    </div>

    ${listCard({
      title: 'المخيمات',
      href: pageUrl('camps.html'),
      hrefLabel: 'إدارة المخيمات',
      rows: data.camps.map(campRow),
      empty: emptyState({ iconName: 'tent', title: 'لا توجد مخيمات', text: 'ابدأ بإضافة أول مخيم إلى النظام.' }),
    })}`;
}

/* ---- Displaced person ---------------------------------------------------- */

function profileCompletion(person) {
  if (!person) return 0;
  const checks = [
    person.fullName,
    person.nationalId,
    person.phone,
    person.birthDate,
    person.gender,
    person.maritalStatus,
    person.campId,
    person.originGovernorate,
    person.displacementDate,
    person.workStatus,
  ];
  const filled = checks.filter(Boolean).length;
  return Math.round((filled / checks.length) * 100);
}

function displacedView(session, data) {
  const { person, family, myAid, myDocuments, stats } = data;
  const completion = profileCompletion(person);

  const aidValue = myAid.reduce((sum, record) => sum + Number(record.value || 0), 0);

  return `
    ${greeting(session, `${session.campLabel} — ${formatDate(new Date())}`)}

    ${
      completion < 100
        ? `
      <section class="card u-mb-5">
        <div class="card__body">
          <div class="row row--between u-mb-3">
            <div>
              <h2 class="card__title">استكمل بيانات ملفك</h2>
              <p class="u-sm u-secondary u-mt-1">كلما اكتملت بياناتك، سهُل على إدارة المخيم تقديم المساعدة المناسبة.</p>
            </div>
            <span class="mono u-bold">${completion}%</span>
          </div>
          <div class="progress u-mb-4"><div class="progress__bar" style="width:${completion}%"></div></div>
          ${button({ label: 'استكمال الملف', variant: 'primary', iconName: 'user', href: pageUrl('profile.html') })}
        </div>
      </section>`
        : ''
    }

    <div class="grid grid--4 u-mb-6">
      ${statCard({ label: 'أفراد الأسرة', value: formatNumber(family ? family.membersCount : 0), iconName: 'family', href: family ? pageUrl('family-details.html', { id: family.id }) : '' })}
      ${statCard({ label: 'المساعدات المستلمة', value: formatNumber(myAid.length), iconName: 'aid', tone: 'success', meta: formatCurrency(aidValue), href: pageUrl('aid.html') })}
      ${statCard({ label: 'المستندات', value: formatNumber(myDocuments.length), iconName: 'folder', href: pageUrl('documents.html') })}
      ${statCard({ label: 'الإشعارات غير المقروءة', value: formatNumber(select.unreadNotificationCount(session.id)), iconName: 'bell', tone: 'warning', href: pageUrl('notifications.html') })}
    </div>

    <div class="split">
      <div class="stack">
        ${listCard({
          title: 'سجل مساعداتي',
          href: pageUrl('aid.html'),
          hrefLabel: 'عرض الكل',
          rows: myAid.slice(0, 5).map(aidRow),
          empty: emptyState({
            iconName: 'aid',
            title: 'لا توجد مساعدات مسجلة',
            text: 'ستظهر هنا المساعدات التي تسجلها إدارة المخيم لأسرتك.',
          }),
        })}

        ${card({
          title: 'أسرتي',
          action: family
            ? `<a class="btn btn--ghost btn--sm" href="${pageUrl('family-details.html', { id: family.id })}">تفاصيل الأسرة</a>`
            : '',
          body: family
            ? definitionList([
                definition('رقم الأسرة', family.id, { mono: true }),
                definition('رب الأسرة', family.headName),
                definition('المخيم', family.campName),
                definition('عدد الأفراد', formatNumber(family.membersCount)),
              ])
            : emptyState({
                iconName: 'family',
                title: 'لم يتم ربط حسابك بأسرة بعد',
                text: 'تواصل مع إدارة المخيم لإضافتك إلى سجل أسرتك.',
              }),
        })}
      </div>

      <aside class="split__aside stack">
        ${card({
          title: 'بياناتي',
          body: person
            ? definitionList([
                definition('الاسم الكامل', person.fullName),
                definition('رقم الهوية', person.nationalId, { mono: true }),
                definition('رقم الهاتف', person.phone, { mono: true }),
                definition('المخيم', session.campLabel),
              ])
            : `<p class="u-sm u-secondary">لم يتم إنشاء سجل النازح الخاص بك بعد.</p>`,
          foot: button({ label: 'تعديل ملفي', variant: 'secondary', iconName: 'edit', href: pageUrl('profile.html'), block: true }),
        })}

        ${card({
          title: 'تواصل مع الإدارة',
          body: `<p class="u-sm u-secondary">لديك استفسار أو ملاحظة؟ أرسل رسالة إلى إدارة المخيم وسيتم الرد عليك.</p>`,
          foot: button({ label: 'إرسال رسالة', variant: 'primary', iconName: 'send', href: pageUrl('message-compose.html'), block: true }),
        })}
      </aside>
    </div>`;
}

/* ---- Dispatch ------------------------------------------------------------ */

function viewFor(session, data) {
  if (session.role === ROLES.SUPER_ADMIN) return superAdminView(session, data);
  if (session.role === ROLES.DISPLACED) return displacedView(session, data);
  return campAdminView(session, data);
}

function drawCharts(session, data) {
  if (session.role === ROLES.DISPLACED) return;

  if (session.role === ROLES.SUPER_ADMIN) campComparisonBar('chart-camps', data.camps);
  else aidTypeBar('chart-aid', data.aidByType);

  monthlyLine('chart-monthly', data.byMonth);
  genderDoughnut('chart-gender', { males: data.stats.males, females: data.stats.females });
  familySizeBar('chart-families', data.familySizes);
}

function wire(content) {
  delegate(content, 'click', '[data-retry]', () => window.location.reload());
}

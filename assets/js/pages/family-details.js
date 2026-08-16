/**
 * One family — members, aid history and documents.
 *
 * This is also "أسرتي" for a displaced person: with no `id` in the URL the
 * page resolves the signed-in user's own family, and refuses any other.
 */

import { esc, params, delegate } from '../utils/dom.js';
import { formatDate, formatAge, formatNumber, fileSize } from '../utils/format.js';
import { mountShell } from '../ui/layout.js';
import {
  button,
  card,
  badge,
  statCard,
  emptyState,
  errorState,
  skeletonStats,
  skeletonTable,
  pageHeader,
  breadcrumb,
  definition,
  definitionList,
} from '../ui/components.js';
import { dataTable, cellMain, cellMono, rowActions } from '../ui/table.js';
import { icon } from '../ui/icons.js';
import { confirmDialog } from '../ui/modal.js';
import { toast } from '../ui/toast.js';
import { pageUrl, go } from '../core/router.js';
import { can, getSession } from '../core/auth.js';
import * as store from '../core/store.js';
import * as select from '../core/selectors.js';
import { ROLES, labelOf, GENDERS, RELATIONSHIPS, TENT_TYPES } from '../core/config.js';

// A displaced person reaches this page through "أسرتي"; an administrator
// through the families list — highlight whichever nav entry they came from.
const activeNav = (getSession() || {}).role === ROLES.DISPLACED ? 'family-details.html' : 'families.html';

const shell = mountShell({ active: activeNav, title: 'تفاصيل الأسرة' });
if (shell) init(shell);

async function init({ session, content }) {
  content.innerHTML = `<div class="grid grid--4 u-mb-6">${skeletonStats(4)}</div>${skeletonTable(5)}`;

  try {
    const data = await store.load(() => collect(session));

    if (!data.family) {
      content.innerHTML = missingView(session);
      return;
    }

    content.innerHTML = view(session, data);
    wire(content, session, data);
  } catch (error) {
    console.error(error);
    content.innerHTML = errorState({ retryAttrs: 'data-retry' });
    delegate(content, 'click', '[data-retry]', () => init({ session, content }));
  }
}

function collect(session) {
  const { id } = params();

  // A displaced person only ever sees their own family, whatever the URL says.
  const familyId =
    session.role === ROLES.DISPLACED
      ? (store.displaced.get(session.displacedId) || {}).familyId
      : id;

  if (!familyId) return { family: null };

  const family = select.familyWithStats(familyId);
  if (!family) return { family: null };
  if (session.role === ROLES.CAMP_ADMIN && family.campId !== session.campId) return { family: null };

  return {
    family,
    aid: select.aidForFamily(familyId),
    documents: store.documents.list((row) => row.familyId === familyId).map(select.documentRow),
  };
}

function missingView(session) {
  if (session.role === ROLES.DISPLACED) {
    return emptyState({
      iconName: 'family',
      title: 'لم يتم ربط حسابك بأسرة بعد',
      text: 'تواصل مع إدارة المخيم لإضافتك إلى سجل أسرتك، وستظهر بياناتها هنا.',
      actions: button({
        label: 'مراسلة إدارة المخيم',
        variant: 'primary',
        iconName: 'send',
        href: pageUrl('message-compose.html'),
      }),
    });
  }
  return emptyState({
    iconName: 'alertTriangle',
    title: 'الأسرة غير موجودة',
    text: 'قد تكون محذوفة أو خارج نطاق صلاحياتك.',
    actions: button({ label: 'العودة إلى الأسر', variant: 'primary', href: pageUrl('families.html') }),
  });
}

/* ---- View ----------------------------------------------------------------- */

function view(session, { family, aid, documents }) {
  const isOwn = session.role === ROLES.DISPLACED;
  const head = family.head;

  return `
    ${
      isOwn
        ? pageHeader({ title: 'أسرتي', description: `بيانات أسرتك المسجلة في ${family.campName}.` })
        : `${breadcrumb([
            { label: 'الأسر', href: pageUrl('families.html') },
            { label: family.id },
          ])}
          ${pageHeader({
            title: `الأسرة ${family.id}`,
            description: `رب الأسرة: ${family.headName} — ${family.campName}`,
            actions: `
              ${
                can('aid:create')
                  ? button({
                      label: 'تسجيل مساعدة',
                      variant: 'primary',
                      iconName: 'plus',
                      href: pageUrl('aid-create.html', { familyId: family.id }),
                    })
                  : ''
              }
              ${
                can('family:delete')
                  ? button({ label: 'حذف', variant: 'danger', iconName: 'trash', attrs: 'data-delete' })
                  : ''
              }`,
          })}`
    }

    <div class="grid grid--4 u-mb-6">
      ${statCard({ label: 'عدد الأفراد', value: formatNumber(family.membersCount), iconName: 'family' })}
      ${statCard({ label: 'الأطفال أقل من 18 عامًا', value: formatNumber(family.childrenCount), iconName: 'users', tone: 'success' })}
      ${statCard({ label: 'الأيتام', value: formatNumber(family.orphansCount), iconName: 'family', tone: 'warning' })}
      ${statCard({ label: 'المساعدات المستلمة', value: formatNumber(aid.length), iconName: 'aid' })}
      ${statCard({ label: 'المستندات', value: formatNumber(documents.length), iconName: 'folder', href: pageUrl('documents.html') })}
    </div>

    <div class="split">
      <div class="stack">
        ${card({
          title: 'أفراد الأسرة',
          action: can('displaced:create')
            ? `<a class="btn btn--ghost btn--sm" href="${pageUrl('displaced-create.html', {
                familyId: family.id,
              })}">إضافة فرد</a>`
            : '',
          flush: true,
          body: membersTable(family),
        })}

        ${card({
          title: 'سجل مساعدات الأسرة',
          action: aid.length
            ? `<a class="btn btn--ghost btn--sm" href="${pageUrl('aid.html', { familyId: family.id })}">عرض الكل</a>`
            : '',
          flush: true,
          body: aid.length
            ? `<div class="list">${aid
                .slice(0, 8)
                .map((record) => aidRow(record, { linked: !isOwn }))
                .join('')}</div>`
            : emptyState({
                iconName: 'aid',
                title: 'لا توجد مساعدات مسجلة',
                text: isOwn
                  ? 'ستظهر هنا المساعدات التي تسجلها إدارة المخيم لأسرتك.'
                  : 'لم تُسجَّل أي مساعدة لهذه الأسرة بعد.',
                actions: can('aid:create')
                  ? button({
                      label: 'تسجيل مساعدة',
                      variant: 'primary',
                      iconName: 'plus',
                      href: pageUrl('aid-create.html', { familyId: family.id }),
                    })
                  : '',
              }),
        })}
      </div>

      <aside class="split__aside stack">
        ${card({
          title: 'بيانات الأسرة',
          body: definitionList([
            definition('رقم الأسرة', family.id, { mono: true }),
            definition('المخيم', family.campName),
            definition('رب الأسرة', family.headName),
            definition('نوع الخيمة', head ? labelOf(TENT_TYPES, head.tentType) : ''),
            definition('تاريخ التسجيل', formatDate(family.createdAt)),
            definition('ملاحظات', family.notes),
          ]),
        })}

        ${card({
          title: 'مستندات الأسرة',
          flush: true,
          body: documents.length
            ? `<div class="list">${documents.slice(0, 6).map(documentRow).join('')}</div>`
            : emptyState({
                iconName: 'folder',
                title: 'لا توجد مستندات',
                text: 'لم يُرفع أي مستند لهذه الأسرة.',
              }),
        })}
      </aside>
    </div>`;
}

function membersTable(family) {
  if (!family.members.length) {
    return emptyState({
      iconName: 'users',
      title: 'لا يوجد أفراد مسجلون',
      text: 'أضف أفراد الأسرة من سجل النازحين.',
    });
  }

  return dataTable({
    columns: [
      {
        key: 'fullName',
        label: 'الاسم',
        primary: true,
        cell: (row) =>
          cellMain(
            row.fullName,
            `${labelOf(RELATIONSHIPS, row.relationship)} · ${labelOf(GENDERS, row.gender)}`
          ),
      },
      { key: 'relationship', label: 'صلة القرابة', cell: (row) => labelOf(RELATIONSHIPS, row.relationship) },
      { key: 'age', label: 'العمر', cell: (row) => formatAge(row.birthDate) },
      { key: 'nationalId', label: 'رقم الهوية', cell: (row) => cellMono(row.nationalId) },
      {
        key: 'health',
        label: 'الحالة',
        cell: (row) =>
          [
            row.chronicDiseases ? badge('مرض مزمن', 'warning') : '',
            row.disability ? badge('إعاقة', 'error') : '',
            select.isOrphan(row) ? badge('يتيم', 'info') : '',
          ]
            .filter(Boolean)
            .join(' ') || '<span class="u-muted">—</span>',
      },
      {
        key: 'actions',
        label: 'إجراءات',
        actions: true,
        cell: (row) =>
          rowActions([
            can('displaced:view') && {
              iconName: 'eye',
              title: `عرض ${row.fullName}`,
              href: pageUrl('displaced-details.html', { id: row.id }),
            },
            can('displaced:update') && {
              iconName: 'edit',
              title: `تعديل ${row.fullName}`,
              href: pageUrl('displaced-edit.html', { id: row.id }),
            },
          ]),
      },
    ],
    rows: family.members,
    caption: `أفراد الأسرة ${family.id}`,
  });
}

/**
 * A displaced person gets a read-only line; an administrator gets a link to
 * the record. Aid detail is not part of the displaced person's interface.
 */
function aidRow(record, { linked = true } = {}) {
  const inner = `
    <span class="list__main">
      <span class="list__title">${esc(record.typeLabels || '—')} — ${esc(record.organizationName)}</span>
      <span class="list__meta">${esc(formatDate(record.date))}</span>
    </span>`;

  if (!linked) return `<div class="list__row">${inner}</div>`;

  return `
    <a class="list__row" href="${pageUrl('aid-details.html', { id: record.id })}">
      ${inner}
      <span class="list__side">${icon('chevronLeft', { size: 16 })}</span>
    </a>`;
}

function documentRow(row) {
  return `
    <a class="list__row" href="${pageUrl('documents.html', { id: row.id })}">
      <span class="list__main">
        <span class="list__title">${esc(row.name)}</span>
        <span class="list__meta">${esc(row.categoryLabel)} · ${esc(fileSize(row.size))}</span>
      </span>
      <span class="list__side">${icon('chevronLeft', { size: 16 })}</span>
    </a>`;
}

function wire(content, session, { family }) {
  delegate(content, 'click', '[data-delete]', async () => {
    const ok = await confirmDialog({
      title: 'حذف الأسرة',
      text: `سيتم حذف الأسرة ${family.id} وسجل مساعداتها. يبقى أفرادها مسجلين كنازحين دون أسرة.`,
      confirmLabel: 'حذف الأسرة',
    });
    if (!ok) return;
    select.removeFamily(family.id);
    toast.success('تم الحذف', 'تم حذف الأسرة.');
    go('families.html');
  });
}

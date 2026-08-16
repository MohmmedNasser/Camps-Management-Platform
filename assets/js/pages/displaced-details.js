/**
 * One displaced person — full file across tabs.
 *
 * The tab set mirrors the record exactly: no file number, no tent number, and
 * health is chronic diseases plus disability only.
 */

import { esc, params, delegate } from '../utils/dom.js';
// formatCurrency is for the monthly income only — aid carries no value.
import {
  formatDate,
  formatAge,
  formatPhone,
  formatNumber,
  formatCurrency,
  fileSize,
} from '../utils/format.js';
import { mountShell } from '../ui/layout.js';
import {
  button,
  badge,
  statusBadge,
  emptyState,
  errorState,
  skeletonProfile,
  skeletonForm,
  breadcrumb,
  avatar,
  definition,
  definitionList,
  tabs,
  tabPanel,
  initTabs,
} from '../ui/components.js';
import { icon } from '../ui/icons.js';
import { confirmDialog } from '../ui/modal.js';
import { toast } from '../ui/toast.js';
import { pageUrl, go } from '../core/router.js';
import { can, inScope } from '../core/auth.js';
import * as store from '../core/store.js';
import * as select from '../core/selectors.js';
import {
  labelOf,
  GENDERS,
  MARITAL_STATUSES,
  NATIONALITIES,
  TENT_TYPES,
  GOVERNORATES,
  WORK_STATUSES,
  INCOME_SOURCES,
  RELATIONSHIPS,
} from '../core/config.js';

const shell = mountShell({ active: 'displaced.html', title: 'بيانات النازح' });
if (shell) init(shell);

/* ---- Entry --------------------------------------------------------------- */

async function init({ session, content }) {
  const { id } = params();
  content.innerHTML = loadingView();

  try {
    const data = await store.load(() => collect(id));

    if (!data.person || !inScope(data.person, session)) {
      content.innerHTML = notFoundView();
      return;
    }

    content.innerHTML = view(data);
    initTabs(content);
    wire(content, data);
  } catch (error) {
    console.error(error);
    content.innerHTML = errorState({ retryAttrs: 'data-retry' });
    delegate(content, 'click', '[data-retry]', () => init({ session, content }));
  }
}

function collect(id) {
  const person = store.displaced.get(id);
  if (!person) return { person: null };
  return {
    person,
    family: person.familyId ? select.familyWithStats(person.familyId) : null,
    // Aid is distributed to the family, so this is the family's history.
    aid: person.familyId ? select.aidForFamily(person.familyId) : [],
    documents: store.documents
      .list((row) => row.displacedId === id)
      .map(select.documentRow),
    campName: select.campName(person.campId),
  };
}

function loadingView() {
  return `${skeletonProfile()}<div class="u-mt-5">${skeletonForm(6)}</div>`;
}

function notFoundView() {
  return emptyState({
    iconName: 'alertTriangle',
    title: 'سجل النازح غير موجود',
    text: 'قد يكون السجل محذوفاً أو خارج نطاق صلاحياتك.',
    actions: button({ label: 'العودة إلى النازحين', variant: 'primary', href: pageUrl('displaced.html') }),
  });
}

/* ---- Header -------------------------------------------------------------- */

function header({ person, campName }) {
  const chips = [
    person.chronicDiseases ? badge('مرض مزمن', 'warning') : '',
    person.disability ? badge('إعاقة', 'error') : '',
    select.isOrphan(person) ? badge('يتيم', 'info') : '',
    person.isPregnant ? badge('حامل', 'success') : '',
    person.isBreastfeeding ? badge('مرضعة', 'success') : '',
  ]
    .filter(Boolean)
    .join('');

  return `
    ${breadcrumb([
      { label: 'النازحون', href: pageUrl('displaced.html') },
      { label: person.fullName },
    ])}

    <section class="card u-mb-5">
      <div class="card__body">
        <div class="row row--between u-gap-4">
          <div class="u-flex u-gap-4">
            ${avatar(person.fullName, { size: 'lg' })}
            <div style="min-width:0">
              <h1 class="page-header__title">${esc(person.fullName)}</h1>
              <p class="u-sm u-secondary u-mt-1">
                <span class="mono">${esc(person.nationalId)}</span> ·
                ${esc(labelOf(GENDERS, person.gender))} · ${esc(formatAge(person.birthDate))}
              </p>
              <div class="row u-gap-2 u-wrap u-mt-3">
                ${statusBadge(person.status)}
                <span class="chip chip--outline">${esc(campName)}</span>
                ${person.familyId ? `<span class="chip chip--outline mono">${esc(person.familyId)}</span>` : ''}
                ${chips}
              </div>
            </div>
          </div>
          <div class="page-header__actions">
            ${
              can('displaced:update')
                ? button({
                    label: 'تعديل',
                    variant: 'secondary',
                    iconName: 'edit',
                    href: pageUrl('displaced-edit.html', { id: person.id }),
                  })
                : ''
            }
            ${
              can('displaced:delete')
                ? button({ label: 'حذف', variant: 'danger', iconName: 'trash', attrs: 'data-delete' })
                : ''
            }
          </div>
        </div>
      </div>
    </section>`;
}

/* ---- Tab panels ----------------------------------------------------------- */

function personalPanel(person) {
  return definitionList([
    definition('الاسم الكامل', person.fullName),
    definition('الاسم بالإنجليزية', person.fullNameEn),
    definition('رقم الهوية', person.nationalId, { mono: true }),
    definition('الجنس', labelOf(GENDERS, person.gender)),
    definition('تاريخ الميلاد', formatDate(person.birthDate)),
    definition('العمر', formatAge(person.birthDate)),
    definition('الحالة الاجتماعية', labelOf(MARITAL_STATUSES, person.maritalStatus)),
    definition('الجنسية', labelOf(NATIONALITIES, person.nationality)),
    definition('رقم جواز السفر', person.passportNumber, { mono: true }),
    definition('رقم وكالة الغوث', person.unrwaNumber, { mono: true }),
    definition('رقم الجوال', formatPhone(person.phone), { mono: true }),
    definition('رقم بديل', person.altPhone ? formatPhone(person.altPhone) : '', { mono: true }),
    definition('البريد الإلكتروني', person.email),
    definition('المحافظة', labelOf(GOVERNORATES, person.governorate)),
    definition('المدينة', person.city),
    definition('الحي / المنطقة', person.area),
    definition('يتيم', select.isOrphan(person) ? 'نعم' : 'لا'),
    // Maternity is not a yes/no question for a male record.
    definition('حامل', person.gender === 'female' ? (person.isPregnant ? 'نعم' : 'لا') : 'لا ينطبق'),
    definition(
      'مرضعة',
      person.gender === 'female' ? (person.isBreastfeeding ? 'نعم' : 'لا') : 'لا ينطبق'
    ),
  ]);
}

function displacementPanel(person, campName) {
  return definitionList([
    definition('المخيم', campName),
    definition('نوع الخيمة / وحدة الإيواء', labelOf(TENT_TYPES, person.tentType)),
    definition('محافظة النزوح الأصلية', labelOf(GOVERNORATES, person.originGovernorate)),
    definition('مدينة النزوح الأصلية', person.originCity),
    definition('تاريخ النزوح', formatDate(person.displacementDate)),
    definition('تاريخ التسجيل', formatDate(person.createdAt)),
  ]);
}

/** Chronic diseases and disability only — the domain recognises nothing else. */
function healthPanel(person) {
  const empty = !person.chronicDiseases && !person.disability;
  if (empty) {
    return emptyState({
      iconName: 'heartPulse',
      title: 'لا توجد حالات صحية مسجلة',
      text: 'لم يُسجَّل أي مرض مزمن أو إعاقة لهذا النازح.',
    });
  }
  return definitionList([
    definition('الأمراض المزمنة', person.chronicDiseases),
    definition('الإعاقة', person.disability),
  ]);
}

function economicPanel(person) {
  return definitionList([
    definition('حالة العمل', labelOf(WORK_STATUSES, person.workStatus)),
    definition('مصدر الدخل', labelOf(INCOME_SOURCES, person.incomeSource)),
    definition('الدخل الشهري', formatCurrency(person.monthlyIncome)),
  ]);
}

function familyPanel(person, family) {
  if (!family) {
    return emptyState({
      iconName: 'family',
      title: 'النازح غير مرتبط بأي أسرة',
      text: 'يمكن ربطه بأسرة قائمة من صفحة تعديل بيانات النازح.',
      actions: can('displaced:update')
        ? button({
            label: 'تعديل البيانات',
            variant: 'secondary',
            iconName: 'edit',
            href: pageUrl('displaced-edit.html', { id: person.id }),
          })
        : '',
    });
  }

  const members = family.members
    .map(
      (member) => `
      <a class="list__row" href="${pageUrl('displaced-details.html', { id: member.id })}">
        <span class="list__main">
          <span class="list__title">${esc(member.fullName)}${
            member.id === person.id ? ' <span class="tag">هذا الملف</span>' : ''
          }</span>
          <span class="list__meta">${esc(labelOf(RELATIONSHIPS, member.relationship))} · ${esc(
            formatAge(member.birthDate)
          )}</span>
        </span>
        <span class="list__side">${icon('chevronLeft', { size: 16 })}</span>
      </a>`
    )
    .join('');

  return `
    ${definitionList([
      definition('رقم الأسرة', family.id, { mono: true }),
      definition('رب الأسرة', family.headName),
      definition('صلة القرابة', labelOf(RELATIONSHIPS, person.relationship)),
      definition('عدد أفراد الأسرة', formatNumber(family.membersCount)),
      definition('الأطفال أقل من 18 عامًا', formatNumber(family.childrenCount)),
    ])}
    <div class="u-mt-5">
      <div class="row row--between u-mb-3">
        <h3 class="card__title">أفراد الأسرة</h3>
        <a class="btn btn--ghost btn--sm" href="${pageUrl('family-details.html', { id: family.id })}">
          ملف الأسرة
        </a>
      </div>
      <div class="list">${members}</div>
    </div>`;
}

/** Aid belongs to the family, so this panel shows the family's history. */
function aidPanel(person, rows) {
  if (!rows.length) {
    return emptyState({
      iconName: 'aid',
      title: 'لا توجد مساعدات مسجلة',
      text: person.familyId
        ? 'ستظهر هنا كل مساعدة تُوزَّع على أسرة هذا النازح.'
        : 'المساعدات تُسجَّل باسم الأسرة، وهذا النازح غير مرتبط بأي أسرة بعد.',
      actions:
        can('aid:create') && person.familyId
          ? button({
              label: 'تسجيل مساعدة',
              variant: 'primary',
              iconName: 'plus',
              href: pageUrl('aid-create.html', { familyId: person.familyId }),
            })
          : '',
    });
  }

  return `
    <p class="u-sm u-secondary u-mb-3">تُوزَّع المساعدات على الأسرة ${esc(
      person.familyId
    )} ولا تُسجَّل باسم فرد بعينه.</p>
    <div class="list">${rows
      .map(
        (record) => `
      <a class="list__row" href="${pageUrl('aid-details.html', { id: record.id })}">
        <span class="list__main">
          <span class="list__title">${esc(record.typeLabel)} — ${esc(record.organizationName)}</span>
          <span class="list__meta">${esc(formatDate(record.date))}${
            record.quantity ? ` · ${esc(record.quantity)}` : ''
          }</span>
        </span>
        <span class="list__side">${icon('chevronLeft', { size: 16 })}</span>
      </a>`
      )
      .join('')}</div>`;
}

function documentsPanel(person, rows) {
  if (!rows.length) {
    return emptyState({
      iconName: 'folder',
      title: 'لا توجد مستندات',
      text: 'لم يتم رفع أي مستند يخص هذا النازح بعد.',
      actions: can('document:upload')
        ? button({
            label: 'إدارة المستندات',
            variant: 'secondary',
            iconName: 'upload',
            href: pageUrl('documents.html', { displacedId: person.id }),
          })
        : '',
    });
  }

  return `<div class="list">${rows
    .map(
      (row) => `
      <a class="list__row" href="${pageUrl('documents.html', { id: row.id })}">
        <span class="list__main">
          <span class="list__title">${esc(row.name)}</span>
          <span class="list__meta">${esc(row.categoryLabel)} · ${esc(fileSize(row.size))} · ${esc(
            formatDate(row.uploadedAt)
          )}</span>
        </span>
        <span class="list__side">${icon('chevronLeft', { size: 16 })}</span>
      </a>`
    )
    .join('')}</div>`;
}

/* ---- View ----------------------------------------------------------------- */

function view(data) {
  const { person, family, aid, documents, campName } = data;

  const items = [
    { id: 'personal', label: 'البيانات الشخصية' },
    { id: 'displacement', label: 'بيانات النزوح' },
    { id: 'health', label: 'الحالة الصحية' },
    { id: 'economic', label: 'الوضع الاقتصادي' },
    { id: 'family', label: 'الأسرة' },
    { id: 'aid', label: `المساعدات (${aid.length})` },
    { id: 'documents', label: `المستندات (${documents.length})` },
  ];

  return `
    ${header(data)}

    <section class="card">
      <div class="card__body">
        ${tabs(items, 'personal')}
        <div class="u-mt-5">
          ${tabPanel('personal', personalPanel(person), true)}
          ${tabPanel('displacement', displacementPanel(person, campName), false)}
          ${tabPanel('health', healthPanel(person), false)}
          ${tabPanel('economic', economicPanel(person), false)}
          ${tabPanel('family', familyPanel(person, family), false)}
          ${tabPanel('aid', aidPanel(person, aid), false)}
          ${tabPanel('documents', documentsPanel(person, documents), false)}
        </div>
      </div>
    </section>`;
}

function wire(content, { person }) {
  delegate(content, 'click', '[data-delete]', async () => {
    const ok = await confirmDialog({
      title: 'حذف سجل النازح',
      text: `سيتم حذف "${person.fullName}" وكل ما يرتبط به من مساعدات ومستندات. لا يمكن التراجع عن هذه العملية.`,
      confirmLabel: 'حذف نهائي',
    });
    if (!ok) return;
    select.removeDisplaced(person.id);
    toast.success('تم الحذف', 'تم حذف سجل النازح.');
    go('displaced.html');
  });
}

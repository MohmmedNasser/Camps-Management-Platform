/**
 * Design-system reference page.
 *
 * Not part of the product navigation — it exists so the visual language can
 * be reviewed and regression-checked in one screen.
 */

import { qs, on, ready, delegate } from '../utils/dom.js';
import {
  button,
  iconButton,
  badge,
  statusBadge,
  chip,
  avatar,
  card,
  statCard,
  alert,
  emptyState,
  errorState,
  pageHeader,
  breadcrumb,
  pagination,
  definitionList,
  definition,
  skeletonStats,
  skeletonTable,
  skeletonForm,
  skeletonProfile,
  tabs,
  tabPanel,
  initTabs,
  barList,
} from '../ui/components.js';
import {
  inputField,
  passwordField,
  selectField,
  textareaField,
  checkboxField,
  switchField,
  radioCards,
  fieldset,
} from '../ui/form.js';
import { dataTable, cellMain, cellMono, rowActions, resultBar } from '../ui/table.js';
import { toolbar, initToolbar, filterChips } from '../ui/toolbar.js';
import { dropzone, initDropzone } from '../ui/upload.js';
import { openModal, confirmDialog } from '../ui/modal.js';
import { toast } from '../ui/toast.js';
import { STATUS, GENDERS, TENT_TYPES, AID_TYPES, DOCUMENT_CATEGORIES } from '../core/config.js';

const SWATCHES = [
  ['Primary', '--color-primary'],
  ['Primary hover', '--color-primary-hover'],
  ['Background', '--color-bg'],
  ['Surface', '--color-surface'],
  ['Border', '--color-border'],
  ['Text', '--color-text'],
  ['Text secondary', '--color-text-secondary'],
  ['Muted', '--color-muted'],
  ['Success', '--color-success'],
  ['Warning', '--color-warning'],
  ['Error', '--color-error'],
  ['Info', '--color-info'],
];

function section(title, body) {
  return `
    <section class="section">
      <div class="section__head"><h2 class="section__title">${title}</h2></div>
      ${body}
    </section>`;
}

function swatches() {
  return `
    <div class="card-grid card-grid--wide">
      ${SWATCHES.map(
        ([name, token]) => `
        <div class="card">
          <div style="height:64px;background:var(${token});border-bottom:1px solid var(--color-border)"></div>
          <div class="card__body" style="padding:var(--space-3) var(--space-4)">
            <div class="u-medium u-sm">${name}</div>
            <div class="u-xs u-muted mono">${token}</div>
          </div>
        </div>`
      ).join('')}
    </div>`;
}

function typography() {
  return card({
    body: `
      <p style="font-size:var(--fs-h1);font-weight:700;letter-spacing:-.02em;margin-bottom:var(--space-3)">عنوان الصفحة — 28px / Bold</p>
      <p style="font-size:var(--fs-h2);font-weight:700;letter-spacing:-.02em;margin-bottom:var(--space-3)">عنوان قسم — 22px / Bold</p>
      <p style="font-size:var(--fs-h3);font-weight:700;margin-bottom:var(--space-3)">عنوان بطاقة — 18px / Bold</p>
      <p style="margin-bottom:var(--space-3)">نص المحتوى الأساسي — 15px / Regular. تُستخدم هذه المقاسات في كل صفحات النظام، ويُحتفظ بالمقاسات الأكبر لشاشات الدخول فقط.</p>
      <p class="u-sm u-secondary" style="margin-bottom:var(--space-3)">نص ثانوي — 13px</p>
      <p class="u-xs u-muted" style="margin-bottom:var(--space-3)">نص مساعد — 12px</p>
      <p class="mono">FAM-000125 · 402318765 · 1,250 ₪</p>`,
  });
}

function buttons() {
  return card({
    body: `
      <div class="row u-mb-4">
        ${button({ label: 'إجراء أساسي', variant: 'primary' })}
        ${button({ label: 'إجراء ثانوي', variant: 'secondary' })}
        ${button({ label: 'إجراء خفيف', variant: 'ghost' })}
        ${button({ label: 'حذف', variant: 'danger', iconName: 'trash' })}
        ${button({ label: 'حذف نهائي', variant: 'danger-solid' })}
      </div>
      <div class="row u-mb-4">
        ${button({ label: 'صغير', variant: 'secondary', size: 'sm' })}
        ${button({ label: 'متوسط', variant: 'secondary' })}
        ${button({ label: 'كبير', variant: 'secondary', size: 'lg' })}
        ${button({ label: 'مع أيقونة', variant: 'primary', iconName: 'plus' })}
        ${button({ label: 'معطّل', variant: 'primary', disabled: true })}
      </div>
      <div class="row">
        ${iconButton({ iconName: 'eye', title: 'عرض' })}
        ${iconButton({ iconName: 'edit', title: 'تعديل' })}
        ${iconButton({ iconName: 'trash', title: 'حذف', variant: 'danger' })}
      </div>`,
  });
}

function statusBits() {
  return card({
    body: `
      <div class="row u-mb-4">
        ${statusBadge(STATUS.PENDING)}
        ${statusBadge(STATUS.APPROVED)}
        ${statusBadge(STATUS.REJECTED)}
        ${statusBadge(STATUS.ACTIVE)}
        ${statusBadge(STATUS.DISABLED)}
        ${badge('معلومة', 'info')}
      </div>
      <div class="row u-mb-4">
        ${chip('كل المخيمات', { active: true })}
        ${chip('مخيم النور')}
        ${chip('غذائية', { outline: true })}
      </div>
      <div class="row">
        ${avatar('أحمد محمود', { size: 'sm' })}
        ${avatar('فاطمة عادل')}
        ${avatar('يوسف النجار', { size: 'lg' })}
      </div>`,
  });
}

function statsRow() {
  return `
    <div class="grid grid--4">
      ${statCard({ label: 'إجمالي النازحين', value: '1,248', iconName: 'users' })}
      ${statCard({ label: 'إجمالي الأسر', value: '312', iconName: 'family', tone: 'success' })}
      ${statCard({ label: 'طلبات التسجيل', value: '17', iconName: 'clipboard', tone: 'warning' })}
      ${statCard({ label: 'ذوو الإعاقة', value: '96', iconName: 'accessibility', tone: 'error' })}
    </div>`;
}

function alerts() {
  return `
    <div class="stack">
      ${alert({ variant: 'info', title: 'معلومة', text: 'يمكن للنازح الاطلاع على سجل مساعداته فقط دون تعديله.' })}
      ${alert({ variant: 'success', title: 'تم الحفظ', text: 'تم تحديث بيانات النازح بنجاح.' })}
      ${alert({ variant: 'warning', title: 'تنبيه مهم', text: 'لا يمكن التسجيل في أكثر من مخيم باستخدام نفس رقم الهوية.' })}
      ${alert({ variant: 'error', title: 'تعذر إكمال العملية', text: 'يرجى التحقق من البيانات المدخلة والمحاولة مرة أخرى.' })}
    </div>`;
}

function formSample() {
  return card({
    body: `
      <form class="form" novalidate onsubmit="return false">
        ${fieldset({
          legend: 'نموذج مختصر',
          hint: 'جميع الحقول تعرض حالة الخطأ والتلميح والنص المساعد.',
          fields: [
            inputField({ name: 'ds-name', label: 'الاسم الكامل', required: true, placeholder: 'الاسم الرباعي' }),
            inputField({ name: 'ds-nid', label: 'رقم الهوية', required: true, mono: true, hint: '9 أرقام' }),
            selectField({ name: 'ds-gender', label: 'الجنس', options: GENDERS, required: true }),
            selectField({ name: 'ds-tent', label: 'نوع الخيمة', options: TENT_TYPES }),
            passwordField({ name: 'ds-pass', label: 'كلمة المرور', required: true }),
            inputField({ name: 'ds-date', label: 'تاريخ النزوح', type: 'date' }),
          ],
        })}
        ${radioCards({
          name: 'ds-radio',
          label: 'نوع المساعدة',
          value: 'food',
          options: AID_TYPES.slice(0, 4).map((type) => ({ value: type.value, label: type.label })),
        })}
        ${textareaField({ name: 'ds-notes', label: 'ملاحظات', optional: true, placeholder: 'أي معلومات إضافية…' })}
        ${checkboxField({ name: 'ds-terms', label: 'أقرّ بصحة البيانات المدخلة', description: 'وأوافق على استخدامها لأغراض إدارة المخيم.' })}
        ${switchField({ name: 'ds-notif', label: 'إشعارات البريد الإلكتروني', description: 'استلام رسالة عند إضافة مساعدة جديدة.', checked: true })}
        <div class="form-actions">
          ${button({ label: 'إلغاء', variant: 'secondary' })}
          ${button({ label: 'حفظ', variant: 'primary', attrs: 'data-demo-save' })}
        </div>
      </form>
      <div class="u-mt-5">
        <p class="u-sm u-medium u-mb-2">حالة الخطأ</p>
        <div class="field" data-state="error" data-field="ds-error">
          <label class="label" for="ds-error-input">رقم الهاتف <span class="label__required">*</span></label>
          <input class="input" id="ds-error-input" value="0591" aria-invalid="true">
          <p class="field__msg field__msg--error">رقم الهاتف يجب أن يبدأ بـ 05 ويتكون من 10 أرقام.</p>
        </div>
      </div>`,
  });
}

/** The real `dataTable` component, so this page matches what pages render. */
function tableSample() {
  const rows = [
    { id: 'd-1', name: 'أحمد محمود الشريف', nameEn: 'Ahmad Al-Sharif', nid: '402318765', phone: '059 234 5671', family: 'FAM-000001', status: STATUS.APPROVED },
    { id: 'd-2', name: 'فاطمة عادل الشريف', nameEn: 'Fatima Al-Sharif', nid: '402318766', phone: '059 234 5672', family: 'FAM-000001', status: STATUS.APPROVED },
    { id: 'd-8', name: 'سميرة حسن أبو زيد', nameEn: 'Samira Abu Zaid', nid: '399872145', phone: '059 234 5678', family: 'FAM-000003', status: STATUS.PENDING },
  ];

  return `
    ${resultBar({ count: 3, total: 48, noun: 'نازح' })}
    ${dataTable({
      columns: [
        { key: 'name', label: 'الاسم', primary: true, cell: (row) => cellMain(row.name, row.nameEn) },
        { key: 'nid', label: 'رقم الهوية', cell: (row) => cellMono(row.nid) },
        { key: 'phone', label: 'الهاتف', cell: (row) => cellMono(row.phone) },
        { key: 'family', label: 'رقم الأسرة', cell: (row) => cellMono(row.family) },
        { key: 'status', label: 'الحالة', cell: (row) => statusBadge(row.status) },
        {
          key: 'actions',
          label: 'إجراءات',
          actions: true,
          cell: () =>
            rowActions([
              { iconName: 'eye', title: 'عرض' },
              { iconName: 'edit', title: 'تعديل' },
              { iconName: 'trash', title: 'حذف', variant: 'danger' },
            ]),
        },
      ],
      rows,
      caption: 'مثال على جدول السجلات',
      foot: pagination({ page: 2, pageSize: 10, total: 48 }),
    })}`;
}

/** Search box, filter panel and quick chips — the head of every list page. */
function toolbarSample() {
  return `
    ${toolbar({
      searchPlaceholder: 'ابحث بالاسم أو رقم الهوية أو الهاتف…',
      filters: [
        { name: 'ds-camp', label: 'المخيم', options: [{ value: 'camp-1', label: 'مخيم النور' }, { value: 'camp-2', label: 'مخيم الرحمة' }] },
        { name: 'ds-gender', label: 'الجنس', options: GENDERS },
        { name: 'ds-aid', label: 'نوع المساعدة', options: AID_TYPES.map((type) => ({ value: type.value, label: type.label })) },
      ],
      actions: button({ label: 'إضافة نازح', variant: 'primary', iconName: 'plus' }),
      modal: true,
    })}
    ${filterChips(
      [
        { value: '', label: 'الكل', count: 48 },
        { value: 'pending', label: 'قيد المراجعة', count: 3 },
        { value: 'approved', label: 'مقبول', count: 44 },
        { value: 'rejected', label: 'مرفوض', count: 1 },
      ],
      'pending'
    )}`;
}

/** File picker used by the documents page. */
function uploadSample() {
  return card({
    body: `
      <form id="ds-upload" novalidate onsubmit="return false">
        <div class="field-grid">
          ${dropzone({ name: 'ds-file' })}
          ${selectField({
            name: 'ds-doc-category',
            label: 'نوع المستند',
            options: DOCUMENT_CATEGORIES.map((item) => ({ value: item.value, label: item.label })),
            required: true,
            full: true,
          })}
        </div>
      </form>
      <p class="u-xs u-muted u-mt-3">المستندات بلا تواريخ انتهاء — يكفي نوع المستند وصاحبه.</p>`,
  });
}

function states() {
  return `
    <div class="grid grid--2">
      <div class="card">${emptyState({
        title: 'لا يوجد نازحون حتى الآن',
        text: 'ابدأ بإضافة أول نازح إلى سجل المخيم.',
        actions: button({ label: 'إضافة نازح', variant: 'primary', iconName: 'plus' }),
      })}</div>
      <div class="card">${errorState()}</div>
    </div>`;
}

function skeletons() {
  return `
    <div class="stack">
      <div class="grid grid--4">${skeletonStats(4)}</div>
      ${skeletonTable(3)}
      <div class="card"><div class="card__body">${skeletonForm(4)}</div></div>
      ${skeletonProfile()}
    </div>`;
}

function overlays() {
  return card({
    body: `
      <div class="row">
        ${button({ label: 'نافذة تأكيد الحذف', variant: 'danger', attrs: 'data-open-confirm' })}
        ${button({ label: 'نافذة عادية', variant: 'secondary', attrs: 'data-open-modal' })}
        ${button({ label: 'تنبيه نجاح', variant: 'secondary', attrs: 'data-toast="success"' })}
        ${button({ label: 'تنبيه خطأ', variant: 'secondary', attrs: 'data-toast="error"' })}
      </div>`,
  });
}

function tabsSample() {
  return card({
    flush: true,
    body: `
      <div style="padding:var(--space-5) var(--space-5) 0">
        ${tabs(
          [
            { id: 'ds-a', label: 'البيانات الأساسية' },
            { id: 'ds-b', label: 'الحالة الصحية' },
            { id: 'ds-c', label: 'سجل المساعدات' },
          ],
          'ds-a'
        )}
      </div>
      <div style="padding:0 var(--space-5) var(--space-5)">
        ${tabPanel(
          'ds-a',
          definitionList([
            definition('الاسم الكامل', 'أحمد محمود الشريف'),
            definition('رقم الهوية', '402318765', { mono: true }),
            definition('رقم الأسرة', 'FAM-000001', { mono: true }),
            definition('رقم الجواز', ''),
          ]),
          true
        )}
        ${tabPanel(
          'ds-b',
          definitionList([definition('أمراض مزمنة', 'ضغط الدم'), definition('إعاقة', '')]),
          false
        )}
        ${tabPanel(
          'ds-c',
          barList([
            { label: 'غذائية', value: 12 },
            { label: 'مالية', value: 7 },
            { label: 'طبية', value: 4 },
          ]),
          false
        )}
      </div>`,
  });
}

ready(() => {
  const root = qs('#ds-root');

  root.innerHTML = `
    ${breadcrumb([{ label: 'الرئيسية', href: 'login.html' }, { label: 'نظام التصميم' }])}
    ${pageHeader({
      title: 'نظام التصميم',
      description: 'مرجع بصري لكل مكوّنات الواجهة — للمراجعة فقط، وليس جزءاً من تنقّل التطبيق.',
      actions: button({ label: 'شاشة تسجيل الدخول', variant: 'secondary', href: 'login.html' }),
    })}
    ${section('الألوان', swatches())}
    ${section('الخطوط والمقاسات', typography())}
    ${section('الأزرار', buttons())}
    ${section('الحالات والشارات', statusBits())}
    ${section('بطاقات الإحصاء', statsRow())}
    ${section('التنبيهات', alerts())}
    ${section('النماذج', formSample())}
    ${section('رفع الملفات', uploadSample())}
    ${section('شريط البحث والتصفية', toolbarSample())}
    ${section('الجداول', tableSample())}
    ${section('التبويبات وصفوف البيانات', tabsSample())}
    ${section('الحالات الفارغة وحالات الخطأ', states())}
    ${section('حالات التحميل', skeletons())}
    ${section('النوافذ والتنبيهات المنبثقة', overlays())}`;

  initTabs(root);
  initToolbar(root, { onChange: () => {} });
  initDropzone(qs('#ds-upload', root));

  on(qs('[data-open-confirm]'), 'click', async () => {
    const ok = await confirmDialog({
      title: 'هل أنت متأكد من حذف هذا النازح؟',
      text: 'سيتم حذف السجل وكل ما يرتبط به من مستندات. لا يمكن التراجع عن هذه العملية.',
      confirmLabel: 'حذف',
    });
    if (ok) toast.success('تم الحذف', 'تم حذف السجل بنجاح.');
  });

  on(qs('[data-open-modal]'), 'click', () =>
    openModal({
      title: 'إضافة مؤسسة',
      description: 'المؤسسة تحتوي على الاسم والشخص المسؤول فقط.',
      body: `<div class="field-grid">
        ${inputField({ name: 'ds-org', label: 'اسم المؤسسة', required: true, full: true })}
        ${inputField({ name: 'ds-org-person', label: 'الشخص المسؤول', optional: true, full: true })}
      </div>`,
      footer: `${button({ label: 'إلغاء', variant: 'secondary', attrs: 'data-close' })}${button({
        label: 'حفظ',
        variant: 'primary',
        attrs: 'data-close',
      })}`,
    })
  );

  delegate(root, 'click', '[data-toast]', (event, node) => {
    const variant = node.dataset.toast;
    if (variant === 'success') toast.success('تم الحفظ', 'تم تحديث البيانات بنجاح.');
    else toast.error('تعذر إكمال العملية', 'حاول مرة أخرى بعد قليل.');
  });

  delegate(root, 'click', '[data-demo-save]', () => toast.success('تم الحفظ'));
});

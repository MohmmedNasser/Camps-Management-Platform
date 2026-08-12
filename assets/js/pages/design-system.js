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
import { openModal, confirmDialog } from '../ui/modal.js';
import { toast } from '../ui/toast.js';
import { STATUS, GENDERS, TENT_TYPES, AID_TYPES } from '../core/config.js';

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

function tableSample() {
  const rows = [
    ['أحمد محمود الشريف', '402318765', '059 234 5671', 'FAM-000001', STATUS.APPROVED],
    ['فاطمة عادل الشريف', '402318766', '059 234 5672', 'FAM-000001', STATUS.APPROVED],
    ['سميرة حسن أبو زيد', '399872145', '059 234 5678', 'FAM-000003', STATUS.PENDING],
  ];
  return `
    <div class="table-wrap">
      <div class="table-scroll">
        <table class="table">
          <thead>
            <tr>
              <th scope="col">الاسم</th>
              <th scope="col">رقم الهوية</th>
              <th scope="col">الهاتف</th>
              <th scope="col">رقم الأسرة</th>
              <th scope="col">الحالة</th>
              <th scope="col"><span class="sr-only">إجراءات</span></th>
            </tr>
          </thead>
          <tbody>
            ${rows
              .map(
                (row) => `
              <tr>
                <td data-primary data-label="الاسم">${row[0]}</td>
                <td data-label="رقم الهوية"><span class="cell-mono">${row[1]}</span></td>
                <td data-label="الهاتف"><span class="cell-mono">${row[2]}</span></td>
                <td data-label="رقم الأسرة"><span class="cell-mono">${row[3]}</span></td>
                <td data-label="الحالة">${statusBadge(row[4])}</td>
                <td data-actions>
                  <span class="cell-actions">
                    ${iconButton({ iconName: 'eye', title: 'عرض' })}
                    ${iconButton({ iconName: 'edit', title: 'تعديل' })}
                    ${iconButton({ iconName: 'trash', title: 'حذف', variant: 'danger' })}
                  </span>
                </td>
              </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>
      ${pagination({ page: 2, pageSize: 10, total: 48 })}
    </div>`;
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
    ${section('الجداول', tableSample())}
    ${section('التبويبات وصفوف البيانات', tabsSample())}
    ${section('الحالات الفارغة وحالات الخطأ', states())}
    ${section('حالات التحميل', skeletons())}
    ${section('النوافذ والتنبيهات المنبثقة', overlays())}`;

  initTabs(root);

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

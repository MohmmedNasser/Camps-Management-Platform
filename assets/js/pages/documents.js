/**
 * Documents.
 *
 * Documents carry no expiry date, and there is no "proof of displacement"
 * category — both are deliberate absences in the domain.
 *
 * Files never leave the browser in this phase: a picked image is kept as a
 * data URL for the preview, anything larger keeps its metadata only.
 */

import { esc, qs, delegate, params, setParams } from '../utils/dom.js';
import { formatDate, fileSize } from '../utils/format.js';
import { mountShell } from '../ui/layout.js';
import {
  button,
  statCard,
  emptyState,
  errorState,
  skeletonTable,
  pageHeader,
  alert,
  definition,
  definitionList,
} from '../ui/components.js';
import { dataTable, cellMain, cellMono, rowActions, resultBar } from '../ui/table.js';
import { toolbar, initToolbar } from '../ui/toolbar.js';
import { openModal, confirmDialog } from '../ui/modal.js';
import { bindForm } from '../ui/form.js';
import { dropzone, initDropzone } from '../ui/upload.js';
import { documentFields, documentSchema } from '../ui/record-forms.js';
import { icon } from '../ui/icons.js';
import { toast } from '../ui/toast.js';
import { can } from '../core/auth.js';
import * as store from '../core/store.js';
import * as select from '../core/selectors.js';
import { ROLES, DOCUMENT_CATEGORIES } from '../core/config.js';

const state = { q: '', category: '', campId: '' };

const shell = mountShell({ active: 'documents.html', title: 'الملفات والمستندات' });
if (shell) init(shell);

function init({ session, content }) {
  const query = params();
  state.q = query.q || '';
  state.category = query.category || '';
  state.campId = query.campId || '';

  const isSuper = session.role === ROLES.SUPER_ADMIN;
  const filters = [
    {
      name: 'category',
      label: 'نوع المستند',
      options: DOCUMENT_CATEGORIES.map((item) => ({ value: item.value, label: item.label })),
      value: state.category,
    },
    ...(isSuper
      ? [{ name: 'campId', label: 'المخيم', options: select.campOptions(session), value: state.campId }]
      : []),
  ];

  content.innerHTML = `
    ${pageHeader({
      title: 'الملفات والمستندات',
      description:
        session.role === ROLES.DISPLACED
          ? 'مستندات أسرتك المرفوعة على المنصة.'
          : `المستندات المرفوعة ضمن ${session.campLabel}.`,
      actions: can('document:upload')
        ? button({ label: 'رفع مستند', variant: 'primary', iconName: 'upload', attrs: 'data-upload' })
        : '',
    })}
    ${alert({
      variant: 'info',
      title: 'ملاحظة',
      text: 'لا تُسجَّل تواريخ انتهاء للمستندات — يكفي رفع نسخة واضحة من المستند وتحديد نوعه.',
    })}
    <div id="summary" class="u-mt-5"></div>
    ${toolbar({
      searchValue: state.q,
      searchPlaceholder: 'ابحث باسم المستند أو صاحبه…',
      filters,
      activeCount: [state.category, state.campId].filter(Boolean).length,
    })}
    <div id="results">${skeletonTable(5)}</div>`;

  initToolbar(content, {
    onChange: (values) => {
      state.q = values.q ?? state.q;
      ['category', 'campId'].forEach((key) => {
        if (key in values) state[key] = values[key];
      });
      setParams(values);
      load(session);
    },
  });

  delegate(content, 'click', '[data-upload]', () => openUploader(session));

  delegate(content, 'click', '[data-preview]', (event, node) => {
    const row = store.documents.get(node.dataset.preview);
    if (row) openPreview(select.documentRow(row));
  });

  delegate(content, 'click', '[data-delete]', async (event, node) => {
    const row = store.documents.get(node.dataset.delete);
    if (!row) return;
    const ok = await confirmDialog({
      title: 'حذف المستند',
      text: `سيتم حذف "${row.name}" نهائياً.`,
      confirmLabel: 'حذف',
    });
    if (!ok) return;
    store.documents.remove(row.id);
    toast.success('تم الحذف', 'تم حذف المستند.');
    load(session);
  });

  delegate(content, 'click', '[data-clear-search]', () => {
    const search = qs('#toolbar-search', content);
    if (search) search.value = '';
    Object.assign(state, { q: '', category: '', campId: '' });
    setParams({ q: '', category: '', campId: '' });
    load(session);
  });

  load(session);
}

/* ---- Data + rendering ------------------------------------------------------ */

async function load(session) {
  const target = qs('#results');
  if (!target) return;
  target.innerHTML = skeletonTable(5);

  try {
    const rows = await store.load(() =>
      select.searchDocuments({
        query: state.q,
        category: state.category,
        campId: state.campId,
        session,
      })
    );
    target.innerHTML = resultsView(session, rows);
    const summary = qs('#summary');
    if (summary) summary.innerHTML = summaryView(session, rows);
  } catch (error) {
    console.error(error);
    target.innerHTML = errorState({ retryAttrs: 'data-retry' });
    delegate(target, 'click', '[data-retry]', () => load(session));
  }
}

function summaryView(session, rows) {
  const byCategory = select.documentsByCategory(session).filter((entry) => entry.count > 0);
  const totalSize = rows.reduce((sum, row) => sum + Number(row.size || 0), 0);

  return `
    <div class="grid grid--3 u-mb-5">
      ${statCard({ label: 'عدد المستندات', value: String(rows.length), iconName: 'folder' })}
      ${statCard({ label: 'أنواع المستندات', value: String(byCategory.length), iconName: 'fileText', tone: 'success' })}
      ${statCard({ label: 'الحجم الإجمالي', value: fileSize(totalSize), iconName: 'upload', tone: 'warning' })}
    </div>`;
}

function resultsView(session, rows) {
  if (!rows.length) return emptyView(session);

  const isSuper = session.role === ROLES.SUPER_ADMIN;
  const columns = [
    {
      key: 'name',
      label: 'اسم المستند',
      primary: true,
      cell: (row) => cellMain(row.name, row.categoryLabel),
    },
    { key: 'categoryLabel', label: 'النوع' },
    { key: 'personName', label: 'يخص' },
    { key: 'familyId', label: 'رقم الأسرة', cell: (row) => cellMono(row.familyId) },
    ...(isSuper ? [{ key: 'campName', label: 'المخيم' }] : []),
    { key: 'size', label: 'الحجم', cell: (row) => cellMono(fileSize(row.size)) },
    { key: 'uploadedAt', label: 'تاريخ الرفع', cell: (row) => formatDate(row.uploadedAt) },
    {
      key: 'actions',
      label: 'إجراءات',
      actions: true,
      cell: (row) =>
        rowActions([
          { iconName: 'eye', title: `معاينة ${row.name}`, attrs: `data-preview="${row.id}"` },
          can('document:delete') && {
            iconName: 'trash',
            title: `حذف ${row.name}`,
            variant: 'danger',
            attrs: `data-delete="${row.id}"`,
          },
        ]),
    },
  ];

  return `
    ${resultBar({ count: rows.length, total: rows.length, noun: 'مستند' })}
    ${dataTable({ columns, rows, caption: 'المستندات المرفوعة' })}`;
}

function emptyView(session) {
  if (state.q || state.category || state.campId) {
    return emptyState({
      iconName: 'search',
      title: 'لا توجد نتائج مطابقة',
      text: 'جرّب تعديل البحث أو اختيار نوع مستند آخر.',
      actions: button({ label: 'إعادة تعيين البحث', variant: 'secondary', attrs: 'data-clear-search' }),
    });
  }

  return emptyState({
    iconName: 'folder',
    title: 'لا توجد مستندات',
    text:
      session.role === ROLES.DISPLACED
        ? 'ارفع صور هويتك ومستنداتك ليتمكن مسؤول المخيم من التحقق من بياناتك.'
        : 'ابدأ برفع مستندات النازحين لحفظها ضمن ملفاتهم.',
    actions: can('document:upload')
      ? button({ label: 'رفع مستند', variant: 'primary', iconName: 'upload', attrs: 'data-upload' })
      : '',
  });
}

/* ---- Upload ---------------------------------------------------------------- */

function peopleFor(session) {
  if (session.role === ROLES.DISPLACED) {
    const person = store.displaced.get(session.displacedId);
    if (!person) return [];
    return select.personOptions({ familyId: person.familyId });
  }
  return select.personOptions({ campId: session.role === ROLES.CAMP_ADMIN ? session.campId : '' });
}

function openUploader(session) {
  const people = peopleFor(session);

  if (!people.length) {
    toast.error('تعذر الرفع', 'لا يوجد نازحون مرتبطون بحسابك لرفع مستند باسمهم.');
    return;
  }

  const modal = openModal({
    title: 'رفع مستند',
    description: 'اختر الملف وحدد نوعه وصاحبه. لا يُطلب تاريخ انتهاء.',
    size: 'lg',
    body: `
      <form class="field-grid" id="document-form" novalidate>
        ${dropzone({ name: 'file' })}
        ${documentFields({ displacedId: people.length === 1 ? people[0].value : '' }, { people })}
      </form>`,
    footer: `
      ${button({ label: 'إلغاء', variant: 'secondary', attrs: 'data-close' })}
      ${button({ label: 'رفع المستند', variant: 'primary', type: 'submit', attrs: 'form="document-form"' })}`,
  });

  const form = qs('#document-form', modal.element);
  const picker = initDropzone(form, {
    onChange: (files) => {
      const nameInput = qs('#name', form);
      if (files.length && nameInput && !nameInput.value) nameInput.value = files[0].name.replace(/\.[^.]+$/, '');
    },
  });

  bindForm(form, {
    schema: documentSchema({ requirePerson: true }),
    onSubmit: (values) => {
      const files = picker.files();
      if (!files.length) {
        toast.error('تعذر الرفع', 'اختر ملفاً أولاً.');
        return;
      }

      const file = files[0];
      const person = store.displaced.get(values.displacedId);

      store.documents.create({
        name: values.name.trim(),
        category: values.category,
        displacedId: values.displacedId,
        familyId: person ? person.familyId : '',
        campId: person ? person.campId : session.campId,
        size: file.size,
        mime: file.mime,
        dataUrl: file.dataUrl,
        uploadedAt: new Date().toISOString(),
        uploadedBy: session.id,
      });

      modal.close('submit');
      toast.success('تم الرفع', 'تمت إضافة المستند إلى الملف.');
      load(session);
    },
  });
}

function openPreview(row) {
  openModal({
    title: row.name,
    description: `${row.categoryLabel} · ${fileSize(row.size)} · ${formatDate(row.uploadedAt)}`,
    size: 'lg',
    body: `
      <div class="u-text-center">
        ${
          row.dataUrl
            ? `<img src="${esc(row.dataUrl)}" alt="${esc(row.name)}" style="max-width:100%;border-radius:var(--radius-lg)">`
            : `<div class="empty">
                <span class="empty__icon">${icon(row.mime === 'application/pdf' ? 'fileText' : 'image', { size: 28 })}</span>
                <h3 class="empty__title">لا تتوفر معاينة لهذا الملف</h3>
                <p class="empty__text">المعاينة متاحة للصور المرفوعة من هذا الجهاز فقط، أما الملفات الكبيرة وملفات PDF فتُحفظ بياناتها دون معاينة في هذا النموذج الأولي.</p>
              </div>`
        }
      </div>
      <div class="u-mt-4">
        ${definitionList([
          definition('يخص', row.personName),
          definition('رقم الأسرة', row.familyId, { mono: true }),
          definition('رفع بواسطة', row.uploaderName),
        ])}
      </div>`,
    footer: button({ label: 'إغلاق', variant: 'secondary', attrs: 'data-close' }),
  });
}

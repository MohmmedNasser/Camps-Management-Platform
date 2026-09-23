/**
 * Documents.
 *
 * Documents carry no expiry date, and there is no "proof of displacement"
 * category — both are deliberate absences in the domain.
 *
 * Camp Admin (Phase 4.8) reads/writes real Supabase + Cloudinary data end
 * to end. Super Admin and the displaced person's own document list stay on
 * the Phase 3 mock/localStorage path: a picked image is kept as a data URL
 * for the preview, and upload mirrors into localStorage (marked with
 * backendId when a real backend session exists, so download/delete still
 * route to the real Cloudinary Edge Functions for those rows).
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
import { isConfigured, currentUserId } from '../core/supabase-client.js';
import * as store from '../core/store.js';
import * as select from '../core/selectors.js';
import * as cloudinary from '../supabase/cloudinary.js';
import { getCampDocuments } from '../supabase/documents.js';
import { getCampDisplacedPersons } from '../supabase/family-members.js';
import { ROLES, DOCUMENT_CATEGORIES } from '../core/config.js';

const state = { q: '', category: '', campId: '' };
let campPeople = []; // Camp Admin's real person options, fetched once in init()
let currentRows = []; // last rendered rows, for the data-preview/download/delete handlers

const MIME_EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
};

function filenameWithExtension(name, mime) {
  if (/\.[a-zA-Z0-9]{2,5}$/.test(name)) return name;
  const ext = MIME_EXTENSIONS[mime];
  return ext ? `${name}.${ext}` : name;
}

/**
 * True when a real Supabase session exists — i.e. the Cloudinary Edge
 * Functions (documents-upload/-access/-delete) can actually be called.
 * Every role has a real session since Phase 4.1; this is used only by the
 * non-Camp-Admin (mock-list) upload/delete paths below, which mirror into
 * localStorage but still route a real backend session's rows through the
 * real Edge Functions for download/delete.
 */
async function backendAvailable() {
  return isConfigured && Boolean(await currentUserId());
}

/** Triggers a real browser download. No-ops when there is no downloadable content. */
async function downloadDocument(row) {
  if (row.backendId) {
    try {
      const blob = await cloudinary.getDocumentBlob(row.backendId, { mode: 'attachment' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filenameWithExtension(row.name, row.mime);
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.error('تعذر التنزيل', error.message || 'حدث خطأ غير متوقع');
    }
    return;
  }
  if (!row.dataUrl) return;
  const link = document.createElement('a');
  link.href = row.dataUrl;
  link.download = filenameWithExtension(row.name, row.mime);
  document.body.appendChild(link);
  link.click();
  link.remove();
}

const shell = await mountShell({ active: 'documents.html', title: 'الملفات والمستندات' });
if (shell) init(shell);

/** Rebuilt fresh on every call so the sheet never shows stale values. */
function filterSpec(session) {
  const isSuper = session.role === ROLES.SUPER_ADMIN;
  return [
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
}

async function init({ session, content }) {
  const query = params();
  state.q = query.q || '';
  state.category = query.category || '';
  state.campId = query.campId || '';

  if (session.role === ROLES.CAMP_ADMIN) {
    content.innerHTML = skeletonTable(5);
    campPeople = (await getCampDisplacedPersons(session.campId)).map((p) => ({ value: p.id, label: p.fullName }));
  }

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
      filters: filterSpec(session),
      activeCount: [state.category, state.campId].filter(Boolean).length,
      modal: true,
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
    getFilters: () => filterSpec(session),
  });

  delegate(content, 'click', '[data-upload]', () => openUploader(session));

  delegate(content, 'click', '[data-preview]', (event, node) => {
    const row = currentRows.find((r) => r.id === node.dataset.preview);
    if (row) openPreview(row);
  });

  delegate(content, 'click', '[data-download]', async (event, node) => {
    const row = currentRows.find((r) => r.id === node.dataset.download);
    if (row) await downloadDocument(row);
  });

  delegate(content, 'click', '[data-delete]', async (event, node) => {
    const row = currentRows.find((r) => r.id === node.dataset.delete);
    if (!row) return;
    const ok = await confirmDialog({
      title: 'حذف المستند',
      text: `سيتم حذف "${row.name}" نهائياً.`,
      confirmLabel: 'حذف',
    });
    if (!ok) return;

    if (session.role === ROLES.CAMP_ADMIN) {
      try {
        await cloudinary.deleteDocumentAsset(row.id);
        toast.success('تم الحذف', 'تم حذف المستند.');
        load(session);
      } catch (error) {
        toast.error('تعذر الحذف', error.message || 'حدث خطأ غير متوقع');
      }
      return;
    }

    if (row.backendId) {
      try {
        await cloudinary.deleteDocumentAsset(row.backendId);
      } catch (error) {
        toast.error('تعذر الحذف', error.message || 'حدث خطأ غير متوقع');
        return;
      }
    }
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

/**
 * The single query behind the table and the summary stat. Camp Admin reads
 * real data (getCampDocuments), returning the unfiltered array too so the
 * "أنواع المستندات" stat keeps counting the whole camp regardless of the
 * active search/category filter, matching what select.documentsByCategory()
 * already guarantees for the mock branch below.
 */
async function collect(session) {
  if (session.role !== ROLES.CAMP_ADMIN) {
    return {
      rows: select.searchDocuments({ query: state.q, category: state.category, campId: state.campId, session }),
      allRows: null,
    };
  }
  const allRows = await getCampDocuments(session.campId);
  const rows = allRows.filter((row) => select.matchesDocumentFilters(row, { query: state.q, category: state.category }));
  return { rows, allRows };
}

async function load(session) {
  const target = qs('#results');
  if (!target) return;
  target.innerHTML = skeletonTable(5);

  try {
    const { rows, allRows } = await store.load(() => collect(session));
    currentRows = rows;
    target.innerHTML = resultsView(session, rows);
    const summary = qs('#summary');
    if (summary) summary.innerHTML = summaryView(session, rows, allRows);
  } catch (error) {
    console.error(error);
    target.innerHTML = errorState({ retryAttrs: 'data-retry' });
    delegate(target, 'click', '[data-retry]', () => load(session));
  }
}

function summaryView(session, rows, allRows = null) {
  const byCategory = allRows
    ? new Set(allRows.map((row) => row.category))
    : new Set(select.documentsByCategory(session).filter((entry) => entry.count > 0).map((entry) => entry.value));
  const totalSize = rows.reduce((sum, row) => sum + Number(row.size || 0), 0);

  return `
    <div class="grid grid--3 u-mb-5">
      ${statCard({ label: 'عدد المستندات', value: String(rows.length), iconName: 'folder' })}
      ${statCard({ label: 'أنواع المستندات', value: String(byCategory.size), iconName: 'fileText', tone: 'success' })}
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
          row.dataUrl || row.backendId
            ? { iconName: 'download', title: `تنزيل ${row.name}`, attrs: `data-download="${row.id}"` }
            : { iconName: 'download', title: 'الملف غير متاح للتنزيل', attrs: 'disabled aria-disabled="true"' },
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

/**
 * Person options for the upload modal. Camp Admin reads the real cache
 * populated once in init() (a real Camp Admin session's mock ids/camp ids
 * never match select.personOptions()'s localStorage rows — the person
 * picker would otherwise render empty or submit a family_member_id the
 * real documents-upload function can't resolve). Displaced/Super Admin
 * keep the existing mock lookup.
 */
function peopleFor(session) {
  if (session.role === ROLES.CAMP_ADMIN) return campPeople;
  if (session.role === ROLES.DISPLACED) {
    const person = store.displaced.get(session.displacedId);
    if (!person) return [];
    return select.personOptions({ familyId: person.familyId });
  }
  return select.personOptions({ campId: '' });
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
    onSubmit: async (values) => {
      const files = picker.files();
      if (!files.length) {
        toast.error('تعذر الرفع', 'اختر ملفاً أولاً.');
        return;
      }

      const file = files[0];
      const name = values.name.trim();

      // Camp Admin: the row is real, sourced from getCampDocuments() on the
      // next load() — no mock mirroring, no localStorage record.
      if (session.role === ROLES.CAMP_ADMIN) {
        try {
          await cloudinary.uploadDocument({
            file: file.raw,
            name,
            category: values.category,
            familyMemberId: values.displacedId,
          });
        } catch (error) {
          toast.error('تعذر الرفع', error.message || 'حدث خطأ غير متوقع');
          return;
        }
        modal.close('submit');
        toast.success('تم الرفع', 'تمت إضافة المستند إلى الملف.');
        load(session);
        return;
      }

      const person = store.displaced.get(values.displacedId);
      const record = {
        name,
        category: values.category,
        displacedId: values.displacedId,
        familyId: person ? person.familyId : '',
        campId: person ? person.campId : session.campId,
        size: file.size,
        mime: file.mime,
        dataUrl: file.dataUrl,
        uploadedAt: new Date().toISOString(),
        uploadedBy: session.id,
      };

      // Super Admin/displaced sessions are real too since Phase 4.1, but
      // their list stays mock (out of this phase's scope) — the upload
      // still mirrors into localStorage, marked with backendId when a real
      // backend session exists, so download/delete keep routing to the
      // backend for those rows (see downloadDocument() and the delete
      // handler above).
      if (await backendAvailable()) {
        try {
          const uploaded = await cloudinary.uploadDocument({
            file: file.raw,
            name: record.name,
            category: record.category,
            familyMemberId: values.displacedId,
          });
          store.documents.create({ ...record, dataUrl: '', backendId: uploaded.id });
        } catch (error) {
          toast.error('تعذر الرفع', error.message || 'حدث خطأ غير متوقع');
          return;
        }
      } else {
        store.documents.create(record);
      }

      modal.close('submit');
      toast.success('تم الرفع', 'تمت إضافة المستند إلى الملف.');
      load(session);
    },
  });
}

function openPreview(row) {
  const isImage = (row.mime || '').startsWith('image/');
  const modal = openModal({
    title: row.name,
    description: `${row.categoryLabel} · ${fileSize(row.size)} · ${formatDate(row.uploadedAt)}`,
    size: 'lg',
    body: `
      <div class="u-text-center" id="preview-body">
        ${
          row.dataUrl
            ? `<img src="${esc(row.dataUrl)}" alt="${esc(row.name)}" style="max-width:100%;border-radius:var(--radius-lg)">`
            : row.backendId && isImage
              ? `<p class="u-text-muted">جارٍ تحميل المعاينة…</p>`
              : `<div class="empty">
                  <span class="empty__icon">${icon(row.mime === 'application/pdf' ? 'fileText' : 'image', { size: 28 })}</span>
                  <h3 class="empty__title">لا تتوفر معاينة لهذا الملف</h3>
                  <p class="empty__text">المعاينة متاحة للصور فقط، أما ملفات PDF فيمكن تنزيلها لعرضها.</p>
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
    footer: `
      ${button({ label: 'إغلاق', variant: 'secondary', attrs: 'data-close' })}
      ${
        row.dataUrl || row.backendId
          ? button({ label: 'تنزيل المستند', variant: 'primary', iconName: 'download', attrs: `data-download="${row.id}"` })
          : button({ label: 'تنزيل المستند', variant: 'primary', iconName: 'download', attrs: 'disabled aria-disabled="true"' })
      }`,
  });

  if (row.dataUrl || row.backendId) {
    delegate(modal.element, 'click', '[data-download]', () => downloadDocument(row));
  }

  // Real, Cloudinary-backed image documents never had a dataUrl to render —
  // fetch the inline blob through the same secure Edge Function download
  // already uses (documents-access, mode:'inline') and patch the
  // placeholder with it. PDFs keep the static "no preview" copy above.
  if (!row.dataUrl && row.backendId && isImage) {
    let objectUrl = '';
    cloudinary
      .getDocumentBlob(row.backendId, { mode: 'inline' })
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        const body = qs('#preview-body', modal.element);
        if (body) {
          body.innerHTML = `<img src="${objectUrl}" alt="${esc(row.name)}" style="max-width:100%;border-radius:var(--radius-lg)">`;
        }
      })
      .catch(() => {
        const body = qs('#preview-body', modal.element);
        if (body) body.innerHTML = `<p class="u-text-muted">تعذر تحميل المعاينة.</p>`;
      });
    modal.onClose(() => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    });
  }
}

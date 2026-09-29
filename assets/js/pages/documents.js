/**
 * Documents.
 *
 * Documents carry no expiry date, and there is no "proof of displacement"
 * category — both are deliberate absences in the domain.
 *
 * Fully real for all three roles (Camp Admin since Phase 4.8, Displaced
 * since Phase 4.13, Super Admin closing the last gap): every row is a real
 * Cloudinary-backed `documents` row, read through RLS-scoped queries and
 * uploaded/deleted through the real Edge Functions. No mock/localStorage
 * mirroring left.
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
import { matchesDocumentFilters } from '../core/selectors.js';
import * as store from '../core/store.js';
import * as cloudinary from '../supabase/cloudinary.js';
import { getCampDocuments, getFamilyDocuments, getAllDocuments } from '../supabase/documents.js';
import { getCampDisplacedPersons, getAllDisplacedPersons } from '../supabase/family-members.js';
import { getOwnFamily } from '../supabase/families.js';
import { listCampOptions } from '../supabase/camps.js';
import { ROLES, DOCUMENT_CATEGORIES } from '../core/config.js';

const state = { q: '', category: '', campId: '' };
let campPeople = []; // Camp Admin's real person options, fetched once in init()
let allPeople = []; // Super Admin's real, platform-wide person options, fetched once in init()
let campOptionsCache = []; // Super Admin's real camp filter options, fetched once in init()
let ownFamily = null; // the displaced session's own family (with members), fetched once in init()
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
      ? [{ name: 'campId', label: 'المخيم', options: campOptionsCache, value: state.campId }]
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
  } else if (session.role === ROLES.SUPER_ADMIN) {
    content.innerHTML = skeletonTable(5);
    const [people, camps] = await Promise.all([getAllDisplacedPersons(), listCampOptions()]);
    allPeople = people.map((p) => ({ value: p.id, label: p.fullName }));
    campOptionsCache = camps;
  } else if (session.role === ROLES.DISPLACED) {
    content.innerHTML = skeletonTable(5);
    ownFamily = await getOwnFamily(session);
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

    // document:delete is Camp Admin/Super Admin only (core/auth.js
    // PERMISSIONS) — every row reaching here is real, so this is one path.
    try {
      await cloudinary.deleteDocumentAsset(row.id);
      toast.success('تم الحذف', 'تم حذف المستند.');
      load(session);
    } catch (error) {
      toast.error('تعذر الحذف', error.message || 'حدث خطأ غير متوقع');
    }
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
 * The single query behind the table and the summary stat, for all three
 * roles. `allRows` is always the unfiltered set, so the "أنواع المستندات"
 * stat keeps counting the whole scope regardless of the active
 * search/category/camp filter.
 */
async function collect(session) {
  if (session.role === ROLES.CAMP_ADMIN) {
    const allRows = await getCampDocuments(session.campId);
    const rows = allRows.filter((row) => matchesDocumentFilters(row, { query: state.q, category: state.category }));
    return { rows, allRows };
  }

  if (session.role === ROLES.DISPLACED) {
    if (!ownFamily) return { rows: [], allRows: [] };
    const allRows = await getFamilyDocuments(ownFamily._dbId);
    const rows = allRows.filter((row) => matchesDocumentFilters(row, { query: state.q, category: state.category }));
    return { rows, allRows };
  }

  // campId is a scope narrowing (which camp am I looking at), applied to
  // allRows too — unlike search/category, which only narrow the visible
  // rows without changing what the summary stat counts against.
  const platformRows = await getAllDocuments();
  const allRows = state.campId ? platformRows.filter((row) => row.campId === state.campId) : platformRows;
  const rows = allRows.filter((row) => matchesDocumentFilters(row, { query: state.q, category: state.category }));
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
    if (summary) summary.innerHTML = summaryView(rows, allRows);
  } catch (error) {
    console.error(error);
    target.innerHTML = errorState({ retryAttrs: 'data-retry' });
    delegate(target, 'click', '[data-retry]', () => load(session));
  }
}

function summaryView(rows, allRows) {
  const byCategory = new Set(allRows.map((row) => row.category));
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

/** Person options for the upload modal — each cache is populated once in
 *  init(), since filterSpec()-style rebuilding on every open isn't needed
 *  here (the person list doesn't change mid-session). */
function peopleFor(session) {
  if (session.role === ROLES.CAMP_ADMIN) return campPeople;
  if (session.role === ROLES.SUPER_ADMIN) return allPeople;
  if (!ownFamily) return [];
  return ownFamily.members.map((member) => ({ value: member.id, label: member.fullName }));
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
      <form class="field-grid" id="document-form" novalidate autocomplete="off">
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

      // Every role's row is real, sourced from the matching getXDocuments()
      // on the next load() — no mock mirroring, no localStorage record.
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

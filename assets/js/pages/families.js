/**
 * Families — list, advanced filtering and Excel export.
 *
 * A family is an independent entity with its own auto-generated ID; every
 * count shown here — members, children by age band, orphans, chronic cases,
 * mothers — is derived from the members at read time, never stored.
 *
 * Filters ask about member characteristics: "وجود طفل أقل من 3 سنوات" matches
 * a family when at least one member is under three. The table, the result
 * count and the export all read one call to `selectors.getFilteredFamilies`.
 */

import { delegate, params, setParams, qs } from '../utils/dom.js';
import { formatDate, formatNumber } from '../utils/format.js';
import { mountShell } from '../ui/layout.js';
import {
  button,
  badge,
  emptyState,
  errorState,
  skeletonTable,
  pageHeader,
  pagination,
} from '../ui/components.js';
import { dataTable, cellMain, cellMono, rowActions, resultBar } from '../ui/table.js';
import { toolbar, initToolbar, activeFilters, filterSummary } from '../ui/toolbar.js';
import { confirmDialog } from '../ui/modal.js';
import { toast } from '../ui/toast.js';
import { pageUrl } from '../core/router.js';
import { can } from '../core/auth.js';
import * as store from '../core/store.js';
import * as select from '../core/selectors.js';
import { FAMILY_COLUMNS, familyExportRow } from '../core/exports.js';
import { exportSheet, timestampedName } from '../utils/xlsx.js';
import { ROLES, PAGE_SIZE, FAMILY_SIZES, YES_NO } from '../core/config.js';

/* ---- State --------------------------------------------------------------- */

/** Every filter the page understands; `q` and `page` are handled separately. */
const FILTER_KEYS = [
  'campId',
  'size',
  'hasChildren',
  'hasUnder3',
  'hasUnder2',
  'hasUnder1',
  'hasOrphan',
  'hasChronic',
  'hasBreastfeeding',
  'hasPregnant',
];

const state = { q: '', page: 1 };
FILTER_KEYS.forEach((key) => {
  state[key] = '';
});

const shell = mountShell({ active: 'families.html', title: 'الأسر' });
if (shell) init(shell);

function readQuery() {
  const query = params();
  state.q = query.q || '';
  FILTER_KEYS.forEach((key) => {
    state[key] = query[key] || '';
  });
  state.page = Math.max(1, Number(query.page) || 1);
}

/** Filter values only — what the summary chips and the active count read. */
function filterValues() {
  return Object.fromEntries(FILTER_KEYS.map((key) => [key, state[key]]));
}

function activeFilterCount() {
  return FILTER_KEYS.filter((key) => state[key]).length;
}

/* ---- Filter descriptors --------------------------------------------------- */

/**
 * One list drives the panel, the active count and the summary chips, so a
 * filter can never appear in one and be missing from another. Every
 * member-characteristic filter means "at least one member matches".
 */
function filterSpec(session) {
  const isSuper = session.role === ROLES.SUPER_ADMIN;

  return [
    isSuper && {
      name: 'campId',
      label: 'المخيم',
      group: 'بيانات الأسرة',
      options: select.campOptions(session),
      value: state.campId,
    },
    {
      name: 'size',
      label: 'عدد أفراد الأسرة',
      group: 'بيانات الأسرة',
      options: FAMILY_SIZES.map(({ value, label }) => ({ value, label })),
      value: state.size,
    },

    {
      name: 'hasChildren',
      label: 'وجود أطفال أقل من 18',
      group: 'الأطفال',
      options: YES_NO,
      value: state.hasChildren,
    },
    {
      name: 'hasUnder3',
      label: 'وجود أطفال أقل من 3 سنوات',
      group: 'الأطفال',
      options: YES_NO,
      value: state.hasUnder3,
    },
    {
      name: 'hasUnder2',
      label: 'وجود طفل أقل من سنتين',
      group: 'الأطفال',
      options: YES_NO,
      value: state.hasUnder2,
    },
    {
      name: 'hasUnder1',
      label: 'وجود طفل أقل من سنة',
      group: 'الأطفال',
      options: YES_NO,
      value: state.hasUnder1,
    },

    {
      name: 'hasOrphan',
      label: 'وجود يتيم',
      group: 'الحالة الصحية والاجتماعية',
      options: YES_NO,
      value: state.hasOrphan,
    },
    {
      name: 'hasChronic',
      label: 'وجود مرض مزمن',
      group: 'الحالة الصحية والاجتماعية',
      options: YES_NO,
      value: state.hasChronic,
    },
    {
      name: 'hasBreastfeeding',
      label: 'وجود مرضعة',
      group: 'الحالة الصحية والاجتماعية',
      options: YES_NO,
      value: state.hasBreastfeeding,
    },
    {
      name: 'hasPregnant',
      label: 'وجود حامل',
      group: 'الحالة الصحية والاجتماعية',
      options: YES_NO,
      value: state.hasPregnant,
    },
  ].filter(Boolean);
}

/* ---- Entry --------------------------------------------------------------- */

function init({ session, content }) {
  readQuery();
  const isSuper = session.role === ROLES.SUPER_ADMIN;
  const filters = filterSpec(session);

  content.innerHTML = `
    ${pageHeader({
      title: 'الأسر',
      description: isSuper ? 'سجل الأسر في جميع المخيمات.' : `سجل الأسر في ${session.campLabel}.`,
      actions: `
        ${button({
          label: 'تصدير إلى Excel',
          variant: 'secondary',
          iconName: 'download',
          attrs: 'data-export',
        })}
        ${
          can('family:create')
            ? button({
                label: 'إضافة أسرة',
                variant: 'primary',
                iconName: 'plus',
                href: pageUrl('family-create.html'),
              })
            : ''
        }`,
    })}
    ${toolbar({
      searchValue: state.q,
      searchPlaceholder: 'ابحث برقم الأسرة أو اسم رب الأسرة…',
      filters,
      activeCount: activeFilterCount(),
      staged: true,
    })}
    <div id="summary"></div>
    <div id="results">${skeletonTable(6)}</div>`;

  initToolbar(content, {
    onChange: (values) => {
      if (values.q !== undefined) state.q = values.q;
      FILTER_KEYS.forEach((key) => {
        if (key in values) state[key] = values[key];
      });
      state.page = 1;
      setParams({ q: state.q, ...filterValues(), page: '' });
      load(session);
    },
  });

  delegate(content, 'click', '[data-page]', (event, node) => {
    const page = Number(node.dataset.page);
    if (!page || node.disabled) return;
    state.page = page;
    setParams({ page: page > 1 ? page : '' });
    load(session);
  });

  // Removing a single chip from the summary.
  delegate(content, 'click', '[data-remove-filter]', (event, node) => {
    const key = node.dataset.removeFilter;
    if (key === 'q') {
      state.q = '';
      const search = qs('#toolbar-search', content);
      if (search) search.value = '';
    } else {
      state[key] = '';
      const field = qs(`#${key}`, content);
      if (field) field.value = '';
    }
    state.page = 1;
    setParams({ q: state.q, ...filterValues(), page: '' });
    load(session);
  });

  delegate(content, 'click', '[data-delete]', async (event, node) => {
    const ok = await confirmDialog({
      title: 'حذف الأسرة',
      text: `سيتم حذف الأسرة ${node.dataset.delete} وسجل مساعداتها. يبقى أفرادها مسجلين كنازحين دون أسرة.`,
      confirmLabel: 'حذف الأسرة',
    });
    if (!ok) return;
    select.removeFamily(node.dataset.delete);
    toast.success('تم الحذف', 'تم حذف الأسرة وفك ارتباط أفرادها.');
    load(session);
  });

  delegate(content, 'click', '[data-clear-search]', () => {
    const search = qs('#toolbar-search', content);
    if (search) search.value = '';
    state.q = '';
    state.page = 1;
    FILTER_KEYS.forEach((key) => {
      state[key] = '';
      const field = qs(`#${key}`, content);
      if (field) field.value = '';
    });
    setParams({ q: '', ...filterValues(), page: '' });
    load(session);
  });

  delegate(content, 'click', '[data-export]', (event, node) => exportRows(session, node));

  load(session);
}

/* ---- Data + rendering ----------------------------------------------------- */

/** The single query behind the table, the count and the export. */
function collect(session) {
  return select.getFilteredFamilies(session, { query: state.q, ...filterValues() });
}

async function load(session) {
  const target = qs('#results');
  if (!target) return;
  target.innerHTML = skeletonTable(6);

  try {
    const rows = await store.load(() => collect(session));
    target.innerHTML = resultsView(session, rows);

    const summary = qs('#summary');
    if (summary) {
      summary.innerHTML = filterSummary({
        active: activeFilters(filterSpec(session), filterValues()),
        total: rows.length,
        noun: 'أسرة',
        query: state.q,
      });
    }
  } catch (error) {
    console.error(error);
    target.innerHTML = errorState({ retryAttrs: 'data-retry' });
    delegate(target, 'click', '[data-retry]', () => load(session));
  }
}

/* ---- Excel export --------------------------------------------------------- */

/**
 * Export exactly what is on screen.
 *
 * The rows come from the same `collect()` the table used, and the scope lives
 * inside `getFilteredFamilies` — a Camp Admin cannot reach another camp's
 * families by editing `?campId=`.
 */
async function exportRows(session, trigger) {
  const original = trigger.innerHTML;
  trigger.disabled = true;
  trigger.innerHTML = `<span class="btn__spinner"></span><span>جارٍ تجهيز ملف Excel…</span>`;

  try {
    const rows = await store.load(() => collect(session), 120);

    if (!rows.length) {
      toast.error('لا توجد نتائج لتصديرها', 'عدّل الفلاتر ثم حاول مرة أخرى.');
      return;
    }

    const filtered = Boolean(state.q) || activeFilterCount() > 0;
    const count = exportSheet({
      columns: FAMILY_COLUMNS,
      rows: rows.map(familyExportRow),
      filename: timestampedName('الأسر', { filtered }),
      sheetName: 'الأسر',
    });

    toast.success('تم التصدير', `تم تصدير ${count} سجلًا بنجاح.`);
  } catch (error) {
    console.error(error);
    toast.error('تعذر التصدير', 'حدث خطأ أثناء تجهيز الملف، حاول مرة أخرى.');
  } finally {
    trigger.disabled = false;
    trigger.innerHTML = original;
  }
}

/* ---- Table ---------------------------------------------------------------- */

function resultsView(session, rows) {
  if (!rows.length) return emptyView();

  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const page = Math.min(state.page, pages);
  const slice = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const isSuper = session.role === ROLES.SUPER_ADMIN;

  const columns = [
    {
      key: 'id',
      label: 'رقم الأسرة',
      primary: true,
      cell: (row) => cellMain(row.id, row.headName),
    },
    { key: 'headName', label: 'رب الأسرة' },
    { key: 'membersCount', label: 'عدد الأفراد', cell: (row) => cellMono(row.membersCount) },
    { key: 'childrenUnder18', label: 'أطفال < 18', cell: (row) => cellMono(row.childrenUnder18) },
    { key: 'childrenUnder3', label: 'أطفال < 3', cell: (row) => cellMono(row.childrenUnder3) },
    ...(isSuper ? [{ key: 'campName', label: 'المخيم' }] : []),
    {
      key: 'flags',
      label: 'حالات خاصة',
      cell: (row) =>
        [
          row.orphans ? badge(`أيتام ${row.orphans}`, 'info') : '',
          row.chronic ? badge('مرض مزمن', 'warning') : '',
          row.disability ? badge('إعاقة', 'error') : '',
          row.pregnant ? badge('حامل', 'success') : '',
          row.breastfeeding ? badge('مرضعة', 'success') : '',
        ]
          .filter(Boolean)
          .join(' ') || '<span class="u-muted">—</span>',
    },
    { key: 'aidCount', label: 'المساعدات', cell: (row) => cellMono(row.aidCount) },
    { key: 'createdAt', label: 'تاريخ التسجيل', cell: (row) => formatDate(row.createdAt) },
    {
      key: 'actions',
      label: 'إجراءات',
      actions: true,
      cell: (row) =>
        rowActions([
          {
            iconName: 'eye',
            title: `عرض الأسرة ${row.id}`,
            href: pageUrl('family-details.html', { id: row.id }),
          },
          can('aid:create') && {
            iconName: 'aid',
            title: `تسجيل مساعدة للأسرة ${row.id}`,
            href: pageUrl('aid-create.html', { familyId: row.id }),
          },
          can('family:delete') && {
            iconName: 'trash',
            title: `حذف الأسرة ${row.id}`,
            variant: 'danger',
            attrs: `data-delete="${row.id}"`,
          },
        ]),
    },
  ];

  const totalMembers = rows.reduce((sum, row) => sum + row.membersCount, 0);

  return `
    ${resultBar({
      count: slice.length,
      total: rows.length,
      noun: 'أسرة',
      side: `<span class="chip chip--outline">${formatNumber(totalMembers)} فرداً</span>`,
    })}
    ${dataTable({
      columns,
      rows: slice,
      caption: 'سجل الأسر',
      foot: rows.length > PAGE_SIZE ? pagination({ page, pageSize: PAGE_SIZE, total: rows.length }) : '',
    })}`;
}

function emptyView() {
  return state.q || activeFilterCount()
    ? emptyState({
        iconName: 'search',
        title: 'لا توجد نتائج مطابقة',
        text: 'جرّب تعديل كلمات البحث أو إزالة بعض الفلاتر.',
        actions: button({ label: 'إزالة كل الفلاتر', variant: 'secondary', attrs: 'data-clear-search' }),
      })
    : emptyState({
        iconName: 'family',
        title: 'لا توجد أسر مسجلة',
        text: 'أنشئ أول أسرة واربط بها النازحين المسجلين في المخيم.',
        actions: can('family:create')
          ? button({
              label: 'إضافة أسرة',
              variant: 'primary',
              iconName: 'plus',
              href: pageUrl('family-create.html'),
            })
          : '',
      });
}

/**
 * Families — list, search and filter.
 *
 * A family is an independent entity with its own auto-generated ID; the member
 * count is derived at read time, never stored.
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
import { toolbar, initToolbar } from '../ui/toolbar.js';
import { confirmDialog } from '../ui/modal.js';
import { toast } from '../ui/toast.js';
import { pageUrl } from '../core/router.js';
import { can } from '../core/auth.js';
import * as store from '../core/store.js';
import * as select from '../core/selectors.js';
import { ROLES, PAGE_SIZE } from '../core/config.js';

const SIZES = [
  { value: 'small', label: '1 – 3 أفراد' },
  { value: 'medium', label: '4 – 6 أفراد' },
  { value: 'large', label: '7 أفراد فأكثر' },
];

const state = { q: '', campId: '', size: '', page: 1 };

const shell = mountShell({ active: 'families.html', title: 'الأسر' });
if (shell) init(shell);

function readQuery() {
  const query = params();
  state.q = query.q || '';
  state.campId = query.campId || '';
  state.size = query.size || '';
  state.page = Math.max(1, Number(query.page) || 1);
}

function activeFilterCount() {
  return ['campId', 'size'].filter((key) => state[key]).length;
}

function init({ session, content }) {
  readQuery();
  const isSuper = session.role === ROLES.SUPER_ADMIN;

  const filters = [
    isSuper && {
      name: 'campId',
      label: 'المخيم',
      options: select.campOptions(session),
      value: state.campId,
    },
    { name: 'size', label: 'حجم الأسرة', options: SIZES, value: state.size },
  ].filter(Boolean);

  content.innerHTML = `
    ${pageHeader({
      title: 'الأسر',
      description: isSuper ? 'سجل الأسر في جميع المخيمات.' : `سجل الأسر في ${session.campLabel}.`,
      actions: can('family:create')
        ? button({
            label: 'إضافة أسرة',
            variant: 'primary',
            iconName: 'plus',
            href: pageUrl('family-create.html'),
          })
        : '',
    })}
    ${toolbar({
      searchValue: state.q,
      searchPlaceholder: 'ابحث برقم الأسرة أو اسم رب الأسرة…',
      filters,
      activeCount: activeFilterCount(),
    })}
    <div id="results">${skeletonTable(6)}</div>`;

  initToolbar(content, {
    onChange: (values) => {
      state.q = values.q ?? state.q;
      ['campId', 'size'].forEach((key) => {
        if (key in values) state[key] = values[key];
      });
      state.page = 1;
      setParams({ ...values, page: '' });
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
    Object.assign(state, { q: '', campId: '', size: '', page: 1 });
    setParams({ q: '', campId: '', size: '', page: '' });
    load(session);
  });

  load(session);
}

async function load(session) {
  const target = qs('#results');
  if (!target) return;
  target.innerHTML = skeletonTable(6);

  try {
    const rows = await store.load(() =>
      select.searchFamilies({
        query: state.q,
        campId: state.campId,
        size: state.size,
        scope: select.scopeFilter(session),
      })
    );
    target.innerHTML = resultsView(session, rows);
  } catch (error) {
    console.error(error);
    target.innerHTML = errorState({ retryAttrs: 'data-retry' });
    delegate(target, 'click', '[data-retry]', () => load(session));
  }
}

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
    { key: 'childrenCount', label: 'الأطفال', cell: (row) => cellMono(row.childrenCount) },
    ...(isSuper ? [{ key: 'campName', label: 'المخيم' }] : []),
    {
      key: 'flags',
      label: 'حالات خاصة',
      cell: (row) =>
        [
          row.hasDisability ? badge('إعاقة', 'error') : '',
          row.hasChronic ? badge('مرض مزمن', 'warning') : '',
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
        text: 'جرّب تعديل كلمات البحث أو إزالة عوامل التصفية.',
        actions: button({ label: 'إعادة تعيين البحث', variant: 'secondary', attrs: 'data-clear-search' }),
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

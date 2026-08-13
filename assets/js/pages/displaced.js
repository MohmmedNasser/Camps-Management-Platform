/**
 * Displaced people — list, search and filter.
 *
 * Search covers name, national ID, phone and family ID. It deliberately does
 * not cover a file number or a tent number: the domain has neither.
 */

import { delegate, params, setParams, qs } from '../utils/dom.js';
import { formatPhone } from '../utils/format.js';
import { mountShell } from '../ui/layout.js';
import {
  button,
  statusBadge,
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
import { ROLES, STATUS, GENDERS, AID_TYPES, STATUS_LABELS, PAGE_SIZE } from '../core/config.js';

/* ---- State --------------------------------------------------------------- */

const state = {
  q: '',
  campId: '',
  gender: '',
  aidType: '',
  organizationId: '',
  status: '',
  page: 1,
};

const shell = mountShell({ active: 'displaced.html', title: 'النازحون' });
if (shell) init(shell);

function readQuery() {
  const query = params();
  state.q = query.q || '';
  state.campId = query.campId || '';
  state.gender = query.gender || '';
  state.aidType = query.aidType || '';
  state.organizationId = query.organizationId || '';
  state.status = query.status || '';
  state.page = Math.max(1, Number(query.page) || 1);
}

function activeFilterCount() {
  return ['campId', 'gender', 'aidType', 'organizationId', 'status'].filter((key) => state[key]).length;
}

/* ---- Entry --------------------------------------------------------------- */

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
    { name: 'gender', label: 'الجنس', options: GENDERS, value: state.gender },
    {
      name: 'aidType',
      label: 'نوع المساعدة المستلمة',
      options: AID_TYPES.map((type) => ({ value: type.value, label: type.label })),
      value: state.aidType,
    },
    {
      name: 'organizationId',
      label: 'المؤسسة المانحة',
      options: select.organizationOptions(),
      value: state.organizationId,
    },
    {
      name: 'status',
      label: 'الحالة',
      options: [STATUS.APPROVED, STATUS.PENDING, STATUS.REJECTED].map((value) => ({
        value,
        label: STATUS_LABELS[value],
      })),
      value: state.status,
    },
  ].filter(Boolean);

  content.innerHTML = `
    ${pageHeader({
      title: 'النازحون',
      description: isSuper
        ? 'سجل النازحين في جميع المخيمات.'
        : `سجل النازحين في ${session.campLabel}.`,
      actions: can('displaced:create')
        ? button({
            label: 'إضافة نازح',
            variant: 'primary',
            iconName: 'plus',
            href: pageUrl('displaced-create.html'),
          })
        : '',
    })}
    ${toolbar({
      searchValue: state.q,
      searchPlaceholder: 'ابحث بالاسم أو رقم الهوية أو الهاتف أو رقم الأسرة…',
      filters,
      activeCount: activeFilterCount(),
    })}
    <div id="results">${skeletonTable(6)}</div>`;

  initToolbar(content, {
    onChange: (values) => {
      Object.assign(state, values.q !== undefined ? { q: values.q } : {});
      ['campId', 'gender', 'aidType', 'organizationId', 'status'].forEach((key) => {
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
    qs('#results', content).scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  delegate(content, 'click', '[data-delete]', async (event, node) => {
    const ok = await confirmDialog({
      title: 'حذف سجل النازح',
      text: `سيتم حذف "${node.dataset.name}" وكل ما يرتبط به من مساعدات ومستندات. لا يمكن التراجع عن هذه العملية.`,
      confirmLabel: 'حذف نهائي',
    });
    if (!ok) return;
    select.removeDisplaced(node.dataset.delete);
    toast.success('تم الحذف', 'تم حذف سجل النازح وكل ما يرتبط به.');
    load(session);
  });

  delegate(content, 'click', '[data-clear-search]', () => {
    const search = qs('#toolbar-search', content);
    if (search) search.value = '';
    Object.assign(state, {
      q: '',
      campId: '',
      gender: '',
      aidType: '',
      organizationId: '',
      status: '',
      page: 1,
    });
    setParams({ q: '', campId: '', gender: '', aidType: '', organizationId: '', status: '', page: '' });
    load(session);
  });

  load(session);
}

/* ---- Data + rendering ----------------------------------------------------- */

async function load(session) {
  const target = qs('#results');
  if (!target) return;
  target.innerHTML = skeletonTable(6);

  try {
    const rows = await store.load(() =>
      select.searchDisplaced({
        query: state.q,
        campId: state.campId,
        gender: state.gender,
        aidType: state.aidType,
        organizationId: state.organizationId,
        status: state.status,
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
      key: 'fullName',
      label: 'الاسم',
      primary: true,
      cell: (row) => cellMain(row.fullName, row.fullNameEn),
    },
    { key: 'nationalId', label: 'رقم الهوية', cell: (row) => cellMono(row.nationalId) },
    { key: 'phone', label: 'الهاتف', cell: (row) => cellMono(formatPhone(row.phone)) },
    { key: 'familyId', label: 'رقم الأسرة', cell: (row) => cellMono(row.familyLabel) },
    ...(isSuper ? [{ key: 'campName', label: 'المخيم' }] : []),
    { key: 'aidCount', label: 'المساعدات', cell: (row) => cellMono(row.aidCount) },
    { key: 'status', label: 'الحالة', cell: (row) => statusBadge(row.status) },
    {
      key: 'actions',
      label: 'إجراءات',
      actions: true,
      cell: (row) =>
        rowActions([
          {
            iconName: 'eye',
            title: `عرض ${row.fullName}`,
            href: pageUrl('displaced-details.html', { id: row.id }),
          },
          can('displaced:update') && {
            iconName: 'edit',
            title: `تعديل ${row.fullName}`,
            href: pageUrl('displaced-edit.html', { id: row.id }),
          },
          can('displaced:delete') && {
            iconName: 'trash',
            title: `حذف ${row.fullName}`,
            variant: 'danger',
            attrs: `data-delete="${row.id}" data-name="${row.fullName}"`,
          },
        ]),
    },
  ];

  return `
    ${resultBar({ count: slice.length, total: rows.length, noun: 'نازح' })}
    ${dataTable({
      columns,
      rows: slice,
      caption: 'سجل النازحين',
      foot: rows.length > PAGE_SIZE ? pagination({ page, pageSize: PAGE_SIZE, total: rows.length }) : '',
    })}`;
}

function emptyView() {
  const filtered = state.q || activeFilterCount();
  return filtered
    ? emptyState({
        iconName: 'search',
        title: 'لا توجد نتائج مطابقة',
        text: 'جرّب تعديل كلمات البحث أو إزالة بعض عوامل التصفية.',
        actions: button({ label: 'إعادة تعيين البحث', variant: 'secondary', attrs: 'data-clear-search' }),
      })
    : emptyState({
        iconName: 'users',
        title: 'لا يوجد نازحون حتى الآن',
        text: 'ابدأ بإضافة أول نازح إلى سجل المخيم، أو راجع طلبات التسجيل الواردة.',
        actions: can('displaced:create')
          ? button({
              label: 'إضافة نازح',
              variant: 'primary',
              iconName: 'plus',
              href: pageUrl('displaced-create.html'),
            })
          : '',
      });
}

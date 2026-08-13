/**
 * Aid records.
 *
 * Two audiences, one route: a Camp Admin manages the camp's records, while a
 * displaced person only ever reads their own history — creating, editing and
 * deleting aid is Camp Admin work by domain rule, so no control appears here
 * that `can('aid:*')` has not allowed.
 */

import { esc, delegate, params, setParams, qs } from '../utils/dom.js';
import { formatDate, formatCurrency, formatNumber } from '../utils/format.js';
import { mountShell } from '../ui/layout.js';
import {
  button,
  alert,
  statCard,
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
import { ROLES, AID_TYPES, PAGE_SIZE } from '../core/config.js';

const state = { q: '', type: '', organizationId: '', familyId: '', page: 1 };

const shell = mountShell({ active: 'aid.html', title: 'المساعدات' });
if (shell) init(shell);

function readQuery() {
  const query = params();
  state.q = query.q || '';
  state.type = query.type || '';
  state.organizationId = query.organizationId || '';
  state.familyId = query.familyId || '';
  state.page = Math.max(1, Number(query.page) || 1);
}

function activeFilterCount() {
  return ['type', 'organizationId', 'familyId'].filter((key) => state[key]).length;
}

function init({ session, content }) {
  readQuery();
  const isOwn = session.role === ROLES.DISPLACED;

  const filters = [
    {
      name: 'type',
      label: 'نوع المساعدة',
      options: AID_TYPES.map((type) => ({ value: type.value, label: type.label })),
      value: state.type,
    },
    {
      name: 'organizationId',
      label: 'المؤسسة المانحة',
      options: select.organizationOptions(),
      value: state.organizationId,
    },
    ...(isOwn
      ? []
      : [
          {
            name: 'familyId',
            label: 'الأسرة',
            options: select.familyOptions(session.role === ROLES.CAMP_ADMIN ? session.campId : ''),
            value: state.familyId,
          },
        ]),
  ];

  content.innerHTML = `
    ${pageHeader({
      title: isOwn ? 'مساعداتي' : 'المساعدات',
      description: isOwn
        ? 'سجل المساعدات التي استلمتها أسرتك من المؤسسات المانحة.'
        : `سجل المساعدات في ${session.campLabel}.`,
      actions: can('aid:create')
        ? button({
            label: 'تسجيل مساعدة',
            variant: 'primary',
            iconName: 'plus',
            href: pageUrl('aid-create.html'),
          })
        : '',
    })}

    ${
      isOwn
        ? alert({
            variant: 'info',
            title: 'للاطلاع فقط',
            text: 'تُسجَّل المساعدات وتُعدَّل من قبل إدارة المخيم. إذا لاحظت خطأً في السجل يمكنك مراسلة الإدارة.',
          })
        : ''
    }

    <div id="summary" class="u-mt-5"></div>
    ${toolbar({
      searchValue: state.q,
      searchPlaceholder: isOwn ? 'ابحث في مساعداتك…' : 'ابحث باسم المستلم أو رقم الأسرة أو المؤسسة…',
      filters,
      activeCount: activeFilterCount(),
    })}
    <div id="results">${skeletonTable(6)}</div>`;

  initToolbar(content, {
    onChange: (values) => {
      state.q = values.q ?? state.q;
      ['type', 'organizationId', 'familyId'].forEach((key) => {
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
      title: 'حذف سجل المساعدة',
      text: 'سيتم حذف هذا السجل نهائياً من سجل مساعدات الأسرة.',
      confirmLabel: 'حذف',
    });
    if (!ok) return;
    store.aid.remove(node.dataset.delete);
    toast.success('تم الحذف', 'تم حذف سجل المساعدة.');
    load(session);
  });

  delegate(content, 'click', '[data-clear-search]', () => {
    const search = qs('#toolbar-search', content);
    if (search) search.value = '';
    Object.assign(state, { q: '', type: '', organizationId: '', familyId: '', page: 1 });
    setParams({ q: '', type: '', organizationId: '', familyId: '', page: '' });
    load(session);
  });

  load(session);
}

/* ---- Data + rendering ------------------------------------------------------ */

async function load(session) {
  const target = qs('#results');
  if (!target) return;
  target.innerHTML = skeletonTable(6);

  try {
    const rows = await store.load(() => collect(session));
    target.innerHTML = resultsView(session, rows);
    const summary = qs('#summary');
    if (summary) summary.innerHTML = summaryView(rows);
  } catch (error) {
    console.error(error);
    target.innerHTML = errorState({ retryAttrs: 'data-retry' });
    delegate(target, 'click', '[data-retry]', () => load(session));
  }
}

/**
 * One query for all three roles: `scopeFilter` is what narrows a displaced
 * person to their own family's records, so the page never filters itself.
 */
function collect(session) {
  return select.searchAid({
    query: state.q,
    type: state.type,
    organizationId: state.organizationId,
    familyId: state.familyId,
    scope: select.scopeFilter(session),
  });
}

function summaryView(rows) {
  const total = rows.reduce((sum, record) => sum + Number(record.value || 0), 0);
  const organizations = new Set(rows.map((record) => record.organizationId)).size;
  const types = new Set(rows.map((record) => record.type)).size;

  return `
    <div class="grid grid--4 u-mb-5">
      ${statCard({ label: 'عدد المساعدات', value: formatNumber(rows.length), iconName: 'aid' })}
      ${statCard({ label: 'القيمة الإجمالية', value: formatCurrency(total), iconName: 'wallet', tone: 'success' })}
      ${statCard({ label: 'المؤسسات المانحة', value: formatNumber(organizations), iconName: 'building' })}
      ${statCard({ label: 'أنواع المساعدات', value: formatNumber(types), iconName: 'chart', tone: 'warning' })}
    </div>`;
}

function resultsView(session, rows) {
  if (!rows.length) return emptyView(session);

  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const page = Math.min(state.page, pages);
  const slice = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const isSuper = session.role === ROLES.SUPER_ADMIN;

  const columns = [
    {
      key: 'typeLabel',
      label: 'نوع المساعدة',
      primary: true,
      cell: (row) => cellMain(row.typeLabel, row.organizationName),
    },
    { key: 'personName', label: 'المستلم' },
    { key: 'familyId', label: 'رقم الأسرة', cell: (row) => cellMono(row.familyId) },
    { key: 'organizationName', label: 'المؤسسة المانحة' },
    ...(isSuper ? [{ key: 'campName', label: 'المخيم' }] : []),
    { key: 'quantity', label: 'الكمية', cell: (row) => esc(row.quantity || '—') },
    { key: 'value', label: 'القيمة', cell: (row) => cellMono(formatCurrency(row.value)) },
    { key: 'date', label: 'تاريخ التسليم', cell: (row) => formatDate(row.date) },
    {
      key: 'actions',
      label: 'إجراءات',
      actions: true,
      cell: (row) =>
        rowActions([
          { iconName: 'eye', title: 'عرض المساعدة', href: pageUrl('aid-details.html', { id: row.id }) },
          can('aid:update') && {
            iconName: 'edit',
            title: 'تعديل المساعدة',
            href: pageUrl('aid-edit.html', { id: row.id }),
          },
          can('aid:delete') && {
            iconName: 'trash',
            title: 'حذف المساعدة',
            variant: 'danger',
            attrs: `data-delete="${row.id}"`,
          },
        ]),
    },
  ];

  return `
    ${resultBar({ count: slice.length, total: rows.length, noun: 'مساعدة' })}
    ${dataTable({
      columns,
      rows: slice,
      caption: 'سجل المساعدات',
      foot: rows.length > PAGE_SIZE ? pagination({ page, pageSize: PAGE_SIZE, total: rows.length }) : '',
    })}`;
}

function emptyView(session) {
  if (state.q || activeFilterCount()) {
    return emptyState({
      iconName: 'search',
      title: 'لا توجد نتائج مطابقة',
      text: 'جرّب تعديل كلمات البحث أو إزالة عوامل التصفية.',
      actions: button({ label: 'إعادة تعيين البحث', variant: 'secondary', attrs: 'data-clear-search' }),
    });
  }

  if (session.role === ROLES.DISPLACED) {
    return emptyState({
      iconName: 'aid',
      title: 'لا توجد مساعدات مسجلة لأسرتك',
      text: 'ستظهر هنا كل مساعدة تسجلها إدارة المخيم لك أو لأحد أفراد أسرتك.',
      actions: button({
        label: 'مراسلة إدارة المخيم',
        variant: 'secondary',
        iconName: 'send',
        href: pageUrl('message-compose.html'),
      }),
    });
  }

  return emptyState({
    iconName: 'aid',
    title: 'لا توجد مساعدات مسجلة',
    text: 'ابدأ بتسجيل أول مساعدة للأسر في المخيم.',
    actions: can('aid:create')
      ? button({
          label: 'تسجيل مساعدة',
          variant: 'primary',
          iconName: 'plus',
          href: pageUrl('aid-create.html'),
        })
      : '',
  });
}

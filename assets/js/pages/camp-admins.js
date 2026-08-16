/**
 * Camp administrators (Super Admin only).
 *
 * The Camp Admin *is* the camp representative — the platform has no separate
 * representative record or name field. There is exactly one Super Admin, so
 * this page never creates one.
 */

import { qs, delegate, params, setParams } from '../utils/dom.js';
import { formatDate, formatPhone, formatNumber } from '../utils/format.js';
import { mountShell } from '../ui/layout.js';
import {
  button,
  alert,
  statCard,
  statusBadge,
  emptyState,
  errorState,
  skeletonTable,
  pageHeader,
} from '../ui/components.js';
import { dataTable, cellMain, cellMono, rowActions, resultBar } from '../ui/table.js';
import { toolbar, initToolbar } from '../ui/toolbar.js';
import { openModal, confirmDialog } from '../ui/modal.js';
import { bindForm } from '../ui/form.js';
import { campAdminFields, campAdminSchema } from '../ui/record-forms.js';
import { toast } from '../ui/toast.js';
import { pageUrl } from '../core/router.js';
import { can } from '../core/auth.js';
import * as store from '../core/store.js';
import * as select from '../core/selectors.js';
import { ROLES, STATUS, STATUS_LABELS } from '../core/config.js';

const state = { q: '', campId: '', status: '' };

const shell = mountShell({ active: 'camp-admins.html', title: 'مسؤولو المخيمات' });
if (shell) init(shell);

/** Rebuilt fresh on every call so the sheet never shows stale values. */
function filterSpec() {
  return [
    { name: 'campId', label: 'المخيم', options: select.campOptions(), value: state.campId },
    {
      name: 'status',
      label: 'حالة الحساب',
      options: [STATUS.ACTIVE, STATUS.DISABLED].map((value) => ({
        value,
        label: STATUS_LABELS[value],
      })),
      value: state.status,
    },
  ];
}

function init({ session, content }) {
  const query = params();
  state.q = query.q || '';
  state.campId = query.campId || '';
  state.status = query.status || '';

  content.innerHTML = `
    ${pageHeader({
      title: 'مسؤولو المخيمات',
      description: 'حسابات إدارة المخيمات وصلاحياتها.',
      actions: can('campAdmin:manage')
        ? button({ label: 'إضافة مسؤول', variant: 'primary', iconName: 'userPlus', attrs: 'data-create' })
        : '',
    })}
    ${alert({
      variant: 'info',
      title: 'مسؤول المخيم هو مندوب المخيم',
      text: 'لا يوجد سجل منفصل لمندوب المخيم — الحساب المسجل هنا هو الجهة المعتمدة للمخيم.',
    })}
    <div id="summary" class="u-mt-5"></div>
    ${toolbar({
      searchValue: state.q,
      searchPlaceholder: 'ابحث بالاسم أو البريد الإلكتروني أو الهاتف…',
      filters: filterSpec(),
      activeCount: [state.campId, state.status].filter(Boolean).length,
      modal: true,
    })}
    <div id="results">${skeletonTable(4)}</div>`;

  initToolbar(content, {
    onChange: (values) => {
      state.q = values.q ?? state.q;
      ['campId', 'status'].forEach((key) => {
        if (key in values) state[key] = values[key];
      });
      setParams(values);
      load(session);
    },
    getFilters: () => filterSpec(),
  });

  delegate(content, 'click', '[data-create]', () => openEditor(session, null));
  delegate(content, 'click', '[data-edit]', (event, node) =>
    openEditor(session, store.users.get(node.dataset.edit))
  );

  delegate(content, 'click', '[data-toggle]', (event, node) => {
    const user = store.users.get(node.dataset.toggle);
    if (!user) return;
    const next = user.status === STATUS.ACTIVE ? STATUS.DISABLED : STATUS.ACTIVE;
    store.users.update(user.id, { status: next });
    toast.success(
      next === STATUS.ACTIVE ? 'تم التفعيل' : 'تم التعطيل',
      `${user.name}: ${next === STATUS.ACTIVE ? 'يمكنه الدخول الآن.' : 'لن يتمكن من تسجيل الدخول.'}`
    );
    load(session);
  });

  delegate(content, 'click', '[data-delete]', async (event, node) => {
    const user = store.users.get(node.dataset.delete);
    if (!user) return;

    const ok = await confirmDialog({
      title: 'حذف حساب المسؤول',
      text: `سيتم حذف حساب "${user.name}". تبقى بيانات المخيم وسجلاته كما هي.`,
      confirmLabel: 'حذف الحساب',
    });
    if (!ok) return;
    select.removeCampAdmin(user.id);
    toast.success('تم الحذف', 'تم حذف حساب المسؤول.');
    load(session);
  });

  delegate(content, 'click', '[data-clear-search]', () => {
    const search = qs('#toolbar-search', content);
    if (search) search.value = '';
    Object.assign(state, { q: '', campId: '', status: '' });
    setParams({ q: '', campId: '', status: '' });
    load(session);
  });

  load(session);
}

/* ---- Data + rendering ------------------------------------------------------ */

async function load(session) {
  const target = qs('#results');
  if (!target) return;
  target.innerHTML = skeletonTable(4);

  try {
    const rows = await store.load(() =>
      select.campAdminRows({ query: state.q, campId: state.campId, status: state.status })
    );
    target.innerHTML = resultsView(rows);

    const summary = qs('#summary');
    if (summary) summary.innerHTML = summaryView();
  } catch (error) {
    console.error(error);
    target.innerHTML = errorState({ retryAttrs: 'data-retry' });
    delegate(target, 'click', '[data-retry]', () => load(session));
  }
}

function summaryView() {
  const all = select.campAdminRows();
  const active = all.filter((user) => user.status === STATUS.ACTIVE).length;
  const camps = select.campBreakdown();
  const uncovered = camps.filter((camp) => camp.adminsCount === 0);

  return `
    <div class="grid grid--3 u-mb-5">
      ${statCard({ label: 'عدد المسؤولين', value: formatNumber(all.length), iconName: 'shield' })}
      ${statCard({ label: 'حسابات نشطة', value: formatNumber(active), iconName: 'userCheck', tone: 'success' })}
      ${statCard({
        label: 'مخيمات بلا مسؤول',
        value: formatNumber(uncovered.length),
        iconName: 'alertTriangle',
        tone: uncovered.length ? 'error' : '',
        meta: uncovered.length ? uncovered.map((camp) => camp.name).join('، ') : 'كل المخيمات مغطاة',
      })}
    </div>`;
}

function resultsView(rows) {
  if (!rows.length) {
    return state.q || state.campId || state.status
      ? emptyState({
          iconName: 'search',
          title: 'لا توجد نتائج مطابقة',
          text: 'جرّب تعديل البحث أو إزالة عوامل التصفية.',
          actions: button({ label: 'إعادة تعيين البحث', variant: 'secondary', attrs: 'data-clear-search' }),
        })
      : emptyState({
          iconName: 'shield',
          title: 'لا يوجد مسؤولو مخيمات',
          text: 'أضف مسؤولاً لكل مخيم ليتمكن من إدارة سجلات النازحين والمساعدات.',
          actions: can('campAdmin:manage')
            ? button({ label: 'إضافة مسؤول', variant: 'primary', iconName: 'userPlus', attrs: 'data-create' })
            : '',
        });
  }

  const columns = [
    { key: 'name', label: 'المسؤول', primary: true, cell: (row) => cellMain(row.name, row.email) },
    { key: 'email', label: 'البريد الإلكتروني' },
    { key: 'phone', label: 'الهاتف', cell: (row) => cellMono(formatPhone(row.phone)) },
    { key: 'campName', label: 'المخيم' },
    { key: 'displacedCount', label: 'نازحو المخيم', cell: (row) => cellMono(row.displacedCount) },
    { key: 'createdAt', label: 'تاريخ الإنشاء', cell: (row) => formatDate(row.createdAt) },
    { key: 'status', label: 'الحالة', cell: (row) => statusBadge(row.status) },
    {
      key: 'actions',
      label: 'إجراءات',
      actions: true,
      cell: (row) =>
        rowActions([
          {
            iconName: 'users',
            title: `نازحو ${row.campName}`,
            href: pageUrl('displaced.html', { campId: row.campId }),
          },
          can('campAdmin:manage') && {
            iconName: 'edit',
            title: `تعديل ${row.name}`,
            attrs: `data-edit="${row.id}"`,
          },
          can('campAdmin:manage') && {
            iconName: row.status === STATUS.ACTIVE ? 'ban' : 'power',
            title: row.status === STATUS.ACTIVE ? `تعطيل ${row.name}` : `تفعيل ${row.name}`,
            attrs: `data-toggle="${row.id}"`,
          },
          can('campAdmin:manage') && {
            iconName: 'trash',
            title: `حذف ${row.name}`,
            variant: 'danger',
            attrs: `data-delete="${row.id}"`,
          },
        ]),
    },
  ];

  return `
    ${resultBar({ count: rows.length, total: rows.length, noun: 'مسؤول' })}
    ${dataTable({ columns, rows, caption: 'مسؤولو المخيمات' })}`;
}

/* ---- Editor dialog --------------------------------------------------------- */

function openEditor(session, user) {
  const isNew = !user;
  const camps = select.campOptions();

  if (isNew && !camps.length) {
    toast.error('تعذر الإضافة', 'أضف مخيماً واحداً على الأقل قبل تعيين مسؤول.');
    return;
  }

  const modal = openModal({
    title: isNew ? 'إضافة مسؤول مخيم' : `تعديل ${user.name}`,
    description: 'حساب إدارة مخيم واحد. مسؤول المخيم هو مندوبه المعتمد.',
    size: 'lg',
    body: `<form class="form" id="admin-form" novalidate>${campAdminFields(user || {}, { camps, isNew })}</form>`,
    footer: `
      ${button({ label: 'إلغاء', variant: 'secondary', attrs: 'data-close' })}
      ${button({ label: isNew ? 'إضافة' : 'حفظ', variant: 'primary', type: 'submit', attrs: 'form="admin-form"' })}`,
  });

  const form = qs('#admin-form', modal.element);

  bindForm(form, {
    schema: campAdminSchema({
      isNew,
      isDuplicateEmail: (value) =>
        store.users.exists(
          (row) =>
            row.email.toLowerCase() === String(value).trim().toLowerCase() &&
            (!user || row.id !== user.id)
        ),
    }),
    onSubmit: (values) => {
      const payload = {
        name: values.name.trim(),
        email: values.email.trim(),
        phone: values.phone.trim(),
        campId: values.campId,
        status: values.status,
        role: ROLES.CAMP_ADMIN,
      };

      if (isNew) {
        store.users.create({
          ...payload,
          password: values.password,
          createdAt: new Date().toISOString(),
        });
      } else {
        store.users.update(user.id, payload);
      }

      modal.close('submit');
      toast.success(isNew ? 'تمت الإضافة' : 'تم الحفظ', `تم حفظ حساب "${payload.name}".`);
      load(session);
    },
  });
}

/**
 * Camp administrators (Super Admin only).
 *
 * The Camp Admin *is* the camp representative — the platform has no separate
 * representative record or name field. There is exactly one Super Admin, so
 * this page never creates one.
 *
 * Creating a brand-new admin account is deferred: it needs a privileged
 * Auth-user-creation step (service_role, via a secure Edge Function) that
 * does not exist yet — see docs/superpowers/specs/2026-08-19-phase-4.10-
 * camps-camp-admins-design.md §1.3/§4. The "إضافة مسؤول" button stays, but
 * opens an explanation instead of the create form.
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
import { STATUS, STATUS_LABELS } from '../core/config.js';
import { listCampAdminAccounts, updateProfile, deleteProfile, assignCampAdmin, setProfileStatus } from '../supabase/profiles.js';
import { listCampsWithStats, listCampOptions } from '../supabase/camps.js';

const state = { q: '', campId: '', status: '', campOptions: [] };
let currentRows = []; // last rendered rows, for the data-edit/data-toggle/data-delete handlers

const shell = await mountShell({ active: 'camp-admins.html', title: 'مسؤولو المخيمات' });
if (shell) init(shell);

/** Rebuilt fresh on every call so the sheet never shows stale values.
 *  toolbar.js's getFilters() is called synchronously, so campOptions is
 *  fetched once in init() and cached in state rather than fetched here. */
function filterSpec() {
  return [
    { name: 'campId', label: 'المخيم', options: state.campOptions, value: state.campId },
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

async function init({ session, content }) {
  const query = params();
  state.q = query.q || '';
  state.campId = query.campId || '';
  state.status = query.status || '';

  content.innerHTML = skeletonTable(4);

  try {
    state.campOptions = await listCampOptions();
  } catch (error) {
    console.error(error);
    state.campOptions = [];
  }

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

  delegate(content, 'click', '[data-create]', () => {
    openModal({
      title: 'إضافة مسؤول مخيم',
      body: alert({
        variant: 'warning',
        title: 'هذه الميزة غير متاحة بعد',
        text: 'إنشاء حساب مسؤول جديد يتطلب إنشاء حساب مصادقة، وهي عملية لا يمكن تنفيذها بأمان من المتصفح حالياً. يمكنك تعديل بيانات المسؤولين الحاليين أو تفعيل/تعطيل حساباتهم أو حذفها.',
      }),
      footer: button({ label: 'حسناً', variant: 'primary', attrs: 'data-close' }),
    });
  });

  delegate(content, 'click', '[data-edit]', (event, node) =>
    openEditor(session, currentRows.find((row) => row.id === node.dataset.edit))
  );

  delegate(content, 'click', '[data-toggle]', async (event, node) => {
    const user = currentRows.find((row) => row.id === node.dataset.toggle);
    if (!user) return;
    const next = user.status === STATUS.ACTIVE ? STATUS.DISABLED : STATUS.ACTIVE;
    try {
      await setProfileStatus(user.id, next);
      toast.success(
        next === STATUS.ACTIVE ? 'تم التفعيل' : 'تم التعطيل',
        `${user.fullName}: ${next === STATUS.ACTIVE ? 'يمكنه الدخول الآن.' : 'لن يتمكن من تسجيل الدخول.'}`
      );
      load(session);
    } catch (error) {
      console.error(error);
      toast.error('تعذر التنفيذ', error.message || 'حدث خطأ غير متوقع');
    }
  });

  delegate(content, 'click', '[data-delete]', async (event, node) => {
    const user = currentRows.find((row) => row.id === node.dataset.delete);
    if (!user) return;

    const ok = await confirmDialog({
      title: 'حذف حساب المسؤول',
      text: `سيتم حذف حساب "${user.fullName}". تبقى بيانات المخيم وسجلاته كما هي.`,
      confirmLabel: 'حذف الحساب',
    });
    if (!ok) return;

    try {
      await deleteProfile(user.id);
      toast.success('تم الحذف', 'تم حذف حساب المسؤول.');
      load(session);
    } catch (error) {
      console.error(error);
      toast.error('تعذر الحذف', error.message || 'حدث خطأ غير متوقع');
    }
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
    const [accounts, breakdown] = await store.load(() =>
      Promise.all([listCampAdminAccounts(), listCampsWithStats()])
    );
    const breakdownById = new Map(breakdown.map((camp) => [camp.id, camp]));
    const allRows = accounts.map((row) => ({
      ...row,
      displacedCount: breakdownById.get(row.campId)?.displacedCount || 0,
    }));
    currentRows = allRows.filter((row) =>
      select.matchesCampAdminFilters(row, { query: state.q, campId: state.campId, status: state.status })
    );

    target.innerHTML = resultsView(currentRows);

    const summary = qs('#summary');
    if (summary) summary.innerHTML = summaryView(allRows, breakdown);
  } catch (error) {
    console.error(error);
    target.innerHTML = errorState({ retryAttrs: 'data-retry' });
    delegate(target, 'click', '[data-retry]', () => load(session));
  }
}

function summaryView(allRows, breakdown) {
  const active = allRows.filter((user) => user.status === STATUS.ACTIVE).length;
  const uncovered = breakdown.filter((camp) => camp.adminsCount === 0);

  return `
    <div class="grid grid--3 u-mb-5">
      ${statCard({ label: 'عدد المسؤولين', value: formatNumber(allRows.length), iconName: 'shield' })}
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
    { key: 'name', label: 'المسؤول', primary: true, cell: (row) => cellMain(row.fullName, row.email) },
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
            title: `تعديل ${row.fullName}`,
            attrs: `data-edit="${row.id}"`,
          },
          can('campAdmin:manage') && {
            iconName: row.status === STATUS.ACTIVE ? 'ban' : 'power',
            title: row.status === STATUS.ACTIVE ? `تعطيل ${row.fullName}` : `تفعيل ${row.fullName}`,
            attrs: `data-toggle="${row.id}"`,
          },
          can('campAdmin:manage') && {
            iconName: 'trash',
            title: `حذف ${row.fullName}`,
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

/** Edit only — creating a new admin is deferred (see the module header and
 *  the `[data-create]` handler above, which never calls this with a null user). */
function openEditor(session, user) {
  if (!user) return;

  const modal = openModal({
    title: `تعديل ${user.fullName}`,
    description: 'حساب إدارة مخيم واحد. مسؤول المخيم هو مندوبه المعتمد.',
    size: 'lg',
    body: `<form class="form" id="admin-form" novalidate>${campAdminFields(
      { ...user, name: user.fullName },
      { camps: state.campOptions, isNew: false }
    )}</form>`,
    footer: `
      ${button({ label: 'إلغاء', variant: 'secondary', attrs: 'data-close' })}
      ${button({ label: 'حفظ', variant: 'primary', type: 'submit', attrs: 'form="admin-form"' })}`,
  });

  const form = qs('#admin-form', modal.element);

  bindForm(form, {
    schema: campAdminSchema({ isNew: false, isDuplicateEmail: () => false }),
    onSubmit: async (values) => {
      const payload = { fullName: values.name.trim(), phone: values.phone.trim() };

      try {
        await updateProfile(user.id, payload);
        if (values.campId !== user.campId) await assignCampAdmin(user.id, values.campId);
        if (values.status !== user.status) await setProfileStatus(user.id, values.status);

        modal.close('submit');
        toast.success('تم الحفظ', `تم حفظ حساب "${payload.fullName}".`);
        load(session);
      } catch (error) {
        console.error(error);
        toast.error('تعذر الحفظ', error.message || 'حدث خطأ غير متوقع');
      }
    },
  });
}

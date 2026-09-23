/**
 * Registration requests waiting for a Camp Admin decision.
 *
 * Approving creates the displaced record and opens a family for the applicant;
 * rejecting records a reason that the applicant sees on their status screen.
 * Camp-Admin-only page (PAGE_ACCESS) — no mock branch.
 */

import { qs, delegate, params, setParams } from '../utils/dom.js';
import { formatDate, formatPhone, formatRelative } from '../utils/format.js';
import { mountShell } from '../ui/layout.js';
import {
  statusBadge,
  emptyState,
  errorState,
  skeletonTable,
  pageHeader,
  pagination,
} from '../ui/components.js';
import { dataTable, cellMain, cellMono, rowActions, resultBar } from '../ui/table.js';
import { toolbar, initToolbar, filterChips } from '../ui/toolbar.js';
import { formDialog } from '../ui/modal.js';
import { textareaField, selectField, inputField } from '../ui/form.js';
import { rules } from '../utils/validators.js';
import { toast } from '../ui/toast.js';
import { pageUrl } from '../core/router.js';
import * as store from '../core/store.js';
import { matchesRegistrationRequestFilters } from '../core/selectors.js';
import {
  getCampRegistrationRequests,
  approveRegistrationRequest,
  rejectRegistrationRequest,
} from '../supabase/registration-requests.js';
import { STATUS, STATUS_LABELS, GENDERS, PAGE_SIZE } from '../core/config.js';

const state = { q: '', status: STATUS.PENDING, page: 1 };

const shell = await mountShell({ active: 'registration-requests.html', title: 'طلبات التسجيل' });
if (shell) init(shell);

function init({ session, content }) {
  const query = params();
  state.q = query.q || '';
  state.status = query.status === undefined ? STATUS.PENDING : query.status || '';
  state.page = Math.max(1, Number(query.page) || 1);

  content.innerHTML = `
    ${pageHeader({
      title: 'طلبات التسجيل',
      description: `طلبات الانضمام الواردة إلى ${session.campLabel}.`,
    })}
    <div id="chips" class="u-mb-4"></div>
    ${toolbar({
      searchValue: state.q,
      searchPlaceholder: 'ابحث بالاسم أو رقم الهوية أو الهاتف…',
    })}
    <div id="results">${skeletonTable(5)}</div>`;

  initToolbar(content, {
    onChange: (values) => {
      state.q = values.q ?? '';
      state.page = 1;
      setParams({ q: state.q, page: '' });
      load(session);
    },
  });

  delegate(content, 'click', '[data-chip]', (event, node) => {
    state.status = node.dataset.chip;
    state.page = 1;
    setParams({ status: state.status, page: '' });
    load(session);
  });

  delegate(content, 'click', '[data-page]', (event, node) => {
    const page = Number(node.dataset.page);
    if (!page || node.disabled) return;
    state.page = page;
    setParams({ page: page > 1 ? page : '' });
    load(session);
  });

  delegate(content, 'click', '[data-approve]', async (event, node) => {
    const rows = await store.load(() => collect(session));
    const request = rows.find((row) => row.id === node.dataset.approve);
    if (!request) return;
    const ok = await approveFlow(request);
    if (ok) load(session);
  });

  delegate(content, 'click', '[data-reject]', async (event, node) => {
    const rows = await store.load(() => collect(session));
    const request = rows.find((row) => row.id === node.dataset.reject);
    if (!request) return;
    const ok = await rejectFlow(request);
    if (ok) load(session);
  });

  load(session);
}

/** The approve flow needs gender + birth date — the RPC requires both and
 *  the request itself carries neither (Phase 4.7 spec §2). */
async function approveFlow(request) {
  const values = await formDialog({
    title: 'قبول طلب التسجيل',
    description: `سيتم إنشاء سجل نازح وأسرة جديدة باسم "${request.fullName}" وتفعيل حسابه.`,
    fields:
      selectField({ name: 'gender', label: 'الجنس', options: GENDERS, required: true }) +
      inputField({ name: 'birthDate', label: 'تاريخ الميلاد', type: 'date', required: true }),
    submitLabel: 'قبول الطلب',
    validate: (input) => {
      const errors = {};
      const genderError = rules.required('الجنس')(input.gender);
      if (genderError) errors.gender = genderError;
      const dateError = rules.required('تاريخ الميلاد')(input.birthDate) || rules.pastDate('تاريخ الميلاد')(input.birthDate);
      if (dateError) errors.birthDate = dateError;
      return errors;
    },
  });
  if (!values) return false;

  try {
    await approveRegistrationRequest(request.id, { gender: values.gender, birthDate: values.birthDate });
    toast.success('تم القبول', 'تم إنشاء الأسرة وتفعيل الحساب.');
    return true;
  } catch (error) {
    console.error(error);
    toast.error('تعذر القبول', error.message || 'حدث خطأ غير متوقع.');
    return false;
  }
}

/** Rejection always asks for a reason — the applicant sees it. */
async function rejectFlow(request) {
  const values = await formDialog({
    title: 'رفض طلب التسجيل',
    description: `سيتم إشعار "${request.fullName}" بالقرار وبالسبب المذكور.`,
    fields: textareaField({
      name: 'note',
      label: 'سبب الرفض',
      required: true,
      rows: 4,
      placeholder: 'مثال: رقم الهوية مسجّل مسبقاً في مخيم آخر.',
    }),
    submitLabel: 'رفض الطلب',
    validate: (input) => (input.note && input.note.trim().length >= 5 ? {} : { note: 'اذكر سبباً واضحاً للرفض.' }),
  });
  if (!values) return false;

  try {
    await rejectRegistrationRequest(request.id, values.note.trim());
    toast.success('تم الرفض', 'تم تسجيل القرار وإشعار مقدم الطلب.');
    return true;
  } catch (error) {
    console.error(error);
    toast.error('تعذر الرفض', error.message || 'حدث خطأ غير متوقع.');
    return false;
  }
}

/* ---- Data + rendering ------------------------------------------------------ */

async function collect(session) {
  const rows = await getCampRegistrationRequests(session.campId);
  return rows.filter((row) => matchesRegistrationRequestFilters(row, { query: state.q, status: state.status }));
}

function countsByStatus(rows) {
  return {
    all: rows.length,
    [STATUS.PENDING]: rows.filter((row) => row.status === STATUS.PENDING).length,
    [STATUS.APPROVED]: rows.filter((row) => row.status === STATUS.APPROVED).length,
    [STATUS.REJECTED]: rows.filter((row) => row.status === STATUS.REJECTED).length,
  };
}

async function load(session) {
  const target = qs('#results');
  if (!target) return;
  target.innerHTML = skeletonTable(5);

  try {
    const allRows = await store.load(() => getCampRegistrationRequests(session.campId));
    const counts = countsByStatus(allRows);
    const rows = allRows
      .filter((row) => matchesRegistrationRequestFilters(row, { query: state.q, status: state.status }))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const chips = qs('#chips');
    if (chips) {
      chips.innerHTML = filterChips(
        [
          { value: STATUS.PENDING, label: STATUS_LABELS[STATUS.PENDING], count: counts[STATUS.PENDING] },
          { value: STATUS.APPROVED, label: STATUS_LABELS[STATUS.APPROVED], count: counts[STATUS.APPROVED] },
          { value: STATUS.REJECTED, label: STATUS_LABELS[STATUS.REJECTED], count: counts[STATUS.REJECTED] },
          { value: '', label: 'الكل', count: counts.all },
        ],
        state.status
      );
    }

    target.innerHTML = resultsView(rows);
  } catch (error) {
    console.error(error);
    target.innerHTML = errorState({ retryAttrs: 'data-retry' });
    delegate(target, 'click', '[data-retry]', () => load(session));
  }
}

function resultsView(rows) {
  if (!rows.length) return emptyView();

  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const page = Math.min(state.page, pages);
  const slice = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const columns = [
    { key: 'fullName', label: 'مقدم الطلب', primary: true, cell: (row) => cellMain(row.fullName, row.email) },
    { key: 'nationalId', label: 'رقم الهوية', cell: (row) => cellMono(row.nationalId) },
    { key: 'phone', label: 'الهاتف', cell: (row) => cellMono(formatPhone(row.phone)) },
    { key: 'createdAt', label: 'تاريخ الطلب', cell: (row) => formatDate(row.createdAt) },
    { key: 'age', label: 'منذ', cell: (row) => formatRelative(row.createdAt) },
    { key: 'status', label: 'الحالة', cell: (row) => statusBadge(row.status) },
    {
      key: 'actions',
      label: 'إجراءات',
      actions: true,
      cell: (row) =>
        rowActions([
          { iconName: 'eye', title: `عرض طلب ${row.fullName}`, href: pageUrl('registration-request-details.html', { id: row.id }) },
          row.status === STATUS.PENDING && { iconName: 'checkCircle', title: `قبول طلب ${row.fullName}`, attrs: `data-approve="${row.id}"` },
          row.status === STATUS.PENDING && { iconName: 'xCircle', title: `رفض طلب ${row.fullName}`, variant: 'danger', attrs: `data-reject="${row.id}"` },
        ]),
    },
  ];

  return `
    ${resultBar({ count: slice.length, total: rows.length, noun: 'طلب' })}
    ${dataTable({
      columns,
      rows: slice,
      caption: 'طلبات التسجيل',
      foot: rows.length > PAGE_SIZE ? pagination({ page, pageSize: PAGE_SIZE, total: rows.length }) : '',
    })}`;
}

function emptyView() {
  if (state.q) {
    return emptyState({ iconName: 'search', title: 'لا توجد نتائج مطابقة', text: 'جرّب كلمات بحث أخرى.' });
  }
  if (state.status === STATUS.PENDING) {
    return emptyState({
      iconName: 'checkCircle',
      title: 'لا توجد طلبات بانتظار المراجعة',
      text: 'تمت مراجعة جميع الطلبات الواردة. ستظهر الطلبات الجديدة هنا فور وصولها.',
    });
  }
  return emptyState({ iconName: 'clipboard', title: 'لا توجد طلبات في هذه الحالة', text: 'اختر حالة أخرى لعرض الطلبات المسجلة.' });
}

/**
 * Donor organisations.
 *
 * An organisation record is a name and an optional responsible person — there
 * is deliberately no email, phone, logo, website or address. Because the whole
 * record is two fields, it is created and edited in a dialog rather than on a
 * page of its own.
 */

import { qs, delegate, params, setParams } from '../utils/dom.js';
import { formatNumber, formatPhone } from '../utils/format.js';
import { mountShell } from '../ui/layout.js';
import {
  button,
  statCard,
  emptyState,
  errorState,
  skeletonTable,
  pageHeader,
  alert,
} from '../ui/components.js';
import { dataTable, cellMain, cellMono, rowActions, resultBar } from '../ui/table.js';
import { toolbar, initToolbar } from '../ui/toolbar.js';
import { openModal, confirmDialog } from '../ui/modal.js';
import { bindForm } from '../ui/form.js';
import { organizationFields, organizationSchema } from '../ui/record-forms.js';
import { toast } from '../ui/toast.js';
import { pageUrl } from '../core/router.js';
import { can } from '../core/auth.js';
import * as store from '../core/store.js';
import * as select from '../core/selectors.js';

const state = { q: '' };

const shell = mountShell({ active: 'organizations.html', title: 'المؤسسات' });
if (shell) init(shell);

function init({ session, content }) {
  state.q = params().q || '';

  content.innerHTML = `
    ${pageHeader({
      title: 'الجهات المانحة',
      description: 'الجهات التي تقدم المساعدات للأسر داخل المخيمات.',
      actions: can('organization:manage')
        ? button({ label: 'إضافة جهة', variant: 'primary', iconName: 'plus', attrs: 'data-create' })
        : '',
    })}
    ${alert({
      variant: 'info',
      title: 'من يمكن أن يكون جهة مانحة؟',
      text: 'قد تكون مؤسسة أو مبادرة أو شخصاً، لذلك الاسم وحده مطلوب، ورقم الجوال والشخص المسؤول اختياريان.',
    })}
    <div id="summary" class="u-mt-5"></div>
    ${toolbar({
      searchValue: state.q,
      searchPlaceholder: 'ابحث بالاسم أو الشخص المسؤول أو رقم الجوال…',
    })}
    <div id="results">${skeletonTable(5)}</div>`;

  initToolbar(content, {
    onChange: (values) => {
      state.q = values.q ?? '';
      setParams({ q: state.q });
      load(session);
    },
  });

  delegate(content, 'click', '[data-create]', () => openEditor(session, null));
  delegate(content, 'click', '[data-edit]', (event, node) =>
    openEditor(session, store.organizations.get(node.dataset.edit))
  );

  delegate(content, 'click', '[data-delete]', async (event, node) => {
    const org = store.organizations.get(node.dataset.delete);
    if (!org) return;

    if (select.organizationInUse(org.id)) {
      toast.error(
        'تعذر الحذف',
        'توجد مساعدات مسجلة باسم هذه الجهة. احذف تلك السجلات أولاً أو انقلها إلى جهة أخرى.'
      );
      return;
    }

    const ok = await confirmDialog({
      title: 'حذف الجهة المانحة',
      text: `سيتم حذف "${org.name}" من قائمة الجهات المانحة.`,
      confirmLabel: 'حذف',
    });
    if (!ok) return;
    store.organizations.remove(org.id);
    toast.success('تم الحذف', 'تم حذف الجهة المانحة.');
    load(session);
  });

  delegate(content, 'click', '[data-clear-search]', () => {
    const search = qs('#toolbar-search', content);
    if (search) search.value = '';
    state.q = '';
    setParams({ q: '' });
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
    const rows = await store.load(() => select.searchOrganizations({ query: state.q }));
    target.innerHTML = resultsView(rows);
    const summary = qs('#summary');
    if (summary) summary.innerHTML = summaryView(rows);
  } catch (error) {
    console.error(error);
    target.innerHTML = errorState({ retryAttrs: 'data-retry' });
    delegate(target, 'click', '[data-retry]', () => load(session));
  }
}

function summaryView(rows) {
  const totalAid = rows.reduce((sum, row) => sum + row.aidCount, 0);
  const withPhone = rows.filter((row) => row.phone).length;

  return `
    <div class="grid grid--3 u-mb-5">
      ${statCard({ label: 'عدد الجهات المانحة', value: formatNumber(rows.length), iconName: 'building' })}
      ${statCard({ label: 'المساعدات المقدمة', value: formatNumber(totalAid), iconName: 'aid', tone: 'success' })}
      ${statCard({ label: 'جهات لها رقم تواصل', value: formatNumber(withPhone), iconName: 'phone', tone: 'warning' })}
    </div>`;
}

function resultsView(rows) {
  if (!rows.length) {
    return state.q
      ? emptyState({
          iconName: 'search',
          title: 'لا توجد نتائج مطابقة',
          text: 'جرّب كلمات بحث أخرى.',
          actions: button({ label: 'إعادة تعيين البحث', variant: 'secondary', attrs: 'data-clear-search' }),
        })
      : emptyState({
          iconName: 'building',
          title: 'لا توجد جهات مانحة مسجلة',
          text: 'أضف الجهات المانحة لتتمكن من ربط المساعدات بها.',
          actions: can('organization:manage')
            ? button({ label: 'إضافة جهة', variant: 'primary', iconName: 'plus', attrs: 'data-create' })
            : '',
        });
  }

  const columns = [
    {
      key: 'name',
      label: 'اسم الجهة',
      primary: true,
      cell: (row) => cellMain(row.name, row.responsiblePerson || 'بدون شخص مسؤول'),
    },
    {
      key: 'phone',
      label: 'رقم الجوال',
      cell: (row) => (row.phone ? cellMono(formatPhone(row.phone)) : '<span class="u-muted">—</span>'),
    },
    {
      key: 'responsiblePerson',
      label: 'الشخص المسؤول',
      cell: (row) => row.responsiblePerson || '<span class="u-muted">—</span>',
    },
    { key: 'aidCount', label: 'عدد المساعدات', cell: (row) => cellMono(row.aidCount) },
    { key: 'familiesCount', label: 'الأسر المستفيدة', cell: (row) => cellMono(row.familiesCount) },
    {
      key: 'actions',
      label: 'إجراءات',
      actions: true,
      cell: (row) =>
        rowActions([
          {
            iconName: 'aid',
            title: `مساعدات ${row.name}`,
            href: pageUrl('aid.html', { organizationId: row.id }),
          },
          can('organization:manage') && {
            iconName: 'edit',
            title: `تعديل ${row.name}`,
            attrs: `data-edit="${row.id}"`,
          },
          can('organization:manage') && {
            iconName: 'trash',
            title: `حذف ${row.name}`,
            variant: 'danger',
            attrs: `data-delete="${row.id}"`,
          },
        ]),
    },
  ];

  return `
    ${resultBar({ count: rows.length, total: rows.length, noun: 'جهة' })}
    ${dataTable({ columns, rows, caption: 'الجهات المانحة' })}`;
}

/* ---- Editor dialog --------------------------------------------------------- */

function openEditor(session, org) {
  const isNew = !org;

  const modal = openModal({
    title: isNew ? 'إضافة جهة مانحة' : 'تعديل الجهة المانحة',
    description: 'الاسم مطلوب؛ رقم الجوال والشخص المسؤول اختياريان.',
    body: `<form class="field-grid" id="org-form" novalidate>${organizationFields(org || {})}</form>`,
    footer: `
      ${button({ label: 'إلغاء', variant: 'secondary', attrs: 'data-close' })}
      ${button({ label: isNew ? 'إضافة' : 'حفظ', variant: 'primary', type: 'submit', attrs: 'form="org-form"' })}`,
  });

  const form = qs('#org-form', modal.element);

  bindForm(form, {
    schema: organizationSchema(),
    onSubmit: (values) => {
      const payload = {
        name: values.name.trim(),
        phone: (values.phone || '').trim(),
        responsiblePerson: (values.responsiblePerson || '').trim(),
      };

      const duplicate = store.organizations.find(
        (row) => row.name.trim() === payload.name && (!org || row.id !== org.id)
      );
      if (duplicate) {
        toast.error('تعذر الحفظ', 'توجد جهة مسجلة بنفس الاسم.');
        return;
      }

      if (isNew) store.organizations.create(payload);
      else store.organizations.update(org.id, payload);

      modal.close('submit');
      toast.success(isNew ? 'تمت الإضافة' : 'تم الحفظ', `تم حفظ بيانات "${payload.name}".`);
      load(session);
    },
  });
}

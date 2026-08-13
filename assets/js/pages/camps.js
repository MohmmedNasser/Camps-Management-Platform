/**
 * Camps (Super Admin only).
 *
 * There is exactly one Super Admin, and camp administration belongs to them.
 * A camp that still holds people, families or admins cannot be deleted — the
 * records would be orphaned.
 */

import { qs, delegate, params, setParams } from '../utils/dom.js';
import { formatDate, formatNumber } from '../utils/format.js';
import { mountShell } from '../ui/layout.js';
import {
  button,
  statCard,
  statusBadge,
  emptyState,
  errorState,
  skeletonTable,
  skeletonChart,
  pageHeader,
} from '../ui/components.js';
import { dataTable, cellMain, cellMono, rowActions, resultBar } from '../ui/table.js';
import { toolbar, initToolbar } from '../ui/toolbar.js';
import { chartCard, campComparisonBar } from '../ui/charts.js';
import { openModal, confirmDialog } from '../ui/modal.js';
import { bindForm } from '../ui/form.js';
import { campFields, campSchema } from '../ui/record-forms.js';
import { toast } from '../ui/toast.js';
import { pageUrl } from '../core/router.js';
import { can } from '../core/auth.js';
import * as store from '../core/store.js';
import * as select from '../core/selectors.js';
import { STATUS, labelOf, GOVERNORATES } from '../core/config.js';

const state = { q: '' };

const shell = mountShell({ active: 'camps.html', title: 'المخيمات' });
if (shell) init(shell);

function init({ session, content }) {
  state.q = params().q || '';

  content.innerHTML = `
    ${pageHeader({
      title: 'المخيمات',
      description: 'جميع المخيمات المسجلة في المنصة وأعداد النازحين فيها.',
      actions: can('camp:manage')
        ? button({ label: 'إضافة مخيم', variant: 'primary', iconName: 'plus', attrs: 'data-create' })
        : '',
    })}
    <div id="summary"></div>
    <div class="u-mb-6" id="chart">${skeletonChart()}</div>
    ${toolbar({ searchValue: state.q, searchPlaceholder: 'ابحث باسم المخيم أو المدينة…' })}
    <div id="results">${skeletonTable(4)}</div>`;

  initToolbar(content, {
    onChange: (values) => {
      state.q = values.q ?? '';
      setParams({ q: state.q });
      load(session);
    },
  });

  delegate(content, 'click', '[data-create]', () => openEditor(session, null));
  delegate(content, 'click', '[data-edit]', (event, node) =>
    openEditor(session, store.camps.get(node.dataset.edit))
  );

  delegate(content, 'click', '[data-toggle]', (event, node) => {
    const camp = store.camps.get(node.dataset.toggle);
    if (!camp) return;
    const next = camp.status === STATUS.ACTIVE ? STATUS.DISABLED : STATUS.ACTIVE;
    store.camps.update(camp.id, { status: next });
    toast.success(
      next === STATUS.ACTIVE ? 'تم التفعيل' : 'تم التعطيل',
      `${camp.name}: ${next === STATUS.ACTIVE ? 'أصبح متاحاً للتسجيل.' : 'لن يظهر في خيارات التسجيل الجديدة.'}`
    );
    load(session);
  });

  delegate(content, 'click', '[data-delete]', async (event, node) => {
    const camp = store.camps.get(node.dataset.delete);
    if (!camp) return;

    if (select.campInUse(camp.id)) {
      toast.error(
        'تعذر الحذف',
        'يوجد نازحون أو أسر أو مسؤولون مرتبطون بهذا المخيم. انقلهم أو احذفهم أولاً.'
      );
      return;
    }

    const ok = await confirmDialog({
      title: 'حذف المخيم',
      text: `سيتم حذف "${camp.name}" من المنصة نهائياً.`,
      confirmLabel: 'حذف',
    });
    if (!ok) return;
    store.camps.remove(camp.id);
    toast.success('تم الحذف', 'تم حذف المخيم.');
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
  target.innerHTML = skeletonTable(4);

  try {
    const all = await store.load(() => select.campBreakdown());
    const term = state.q.trim().toLowerCase();
    const rows = term
      ? all.filter(
          (camp) =>
            camp.name.toLowerCase().includes(term) || (camp.city || '').toLowerCase().includes(term)
        )
      : all;

    target.innerHTML = resultsView(rows);

    const summary = qs('#summary');
    if (summary) summary.innerHTML = summaryView(all);

    const chartSlot = qs('#chart');
    if (chartSlot) {
      if (all.length) {
        chartSlot.innerHTML = chartCard({
          id: 'chart-camps',
          title: 'مقارنة المخيمات',
          subtitle: 'عدد النازحين والأسر في كل مخيم',
        });
        campComparisonBar('chart-camps', all);
      } else {
        chartSlot.innerHTML = '';
      }
    }
  } catch (error) {
    console.error(error);
    target.innerHTML = errorState({ retryAttrs: 'data-retry' });
    delegate(target, 'click', '[data-retry]', () => load(session));
  }
}

function summaryView(rows) {
  const displaced = rows.reduce((sum, camp) => sum + camp.displacedCount, 0);
  const families = rows.reduce((sum, camp) => sum + camp.familiesCount, 0);
  const admins = rows.reduce((sum, camp) => sum + camp.adminsCount, 0);

  return `
    <div class="grid grid--4 u-mb-6">
      ${statCard({ label: 'عدد المخيمات', value: formatNumber(rows.length), iconName: 'tent' })}
      ${statCard({ label: 'إجمالي النازحين', value: formatNumber(displaced), iconName: 'users', tone: 'success' })}
      ${statCard({ label: 'إجمالي الأسر', value: formatNumber(families), iconName: 'family' })}
      ${statCard({
        label: 'مسؤولو المخيمات',
        value: formatNumber(admins),
        iconName: 'shield',
        tone: 'warning',
        href: pageUrl('camp-admins.html'),
      })}
    </div>`;
}

function resultsView(rows) {
  if (!rows.length) {
    return state.q
      ? emptyState({
          iconName: 'search',
          title: 'لا توجد مخيمات مطابقة',
          text: 'جرّب كلمات بحث أخرى.',
          actions: button({ label: 'إعادة تعيين البحث', variant: 'secondary', attrs: 'data-clear-search' }),
        })
      : emptyState({
          iconName: 'tent',
          title: 'لا توجد مخيمات',
          text: 'ابدأ بإضافة أول مخيم، ثم عيّن له مسؤولاً.',
          actions: can('camp:manage')
            ? button({ label: 'إضافة مخيم', variant: 'primary', iconName: 'plus', attrs: 'data-create' })
            : '',
        });
  }

  const columns = [
    {
      key: 'name',
      label: 'المخيم',
      primary: true,
      cell: (row) => cellMain(row.name, `${labelOf(GOVERNORATES, row.governorate)} — ${row.city}`),
    },
    { key: 'city', label: 'المدينة' },
    { key: 'governorate', label: 'المحافظة', cell: (row) => labelOf(GOVERNORATES, row.governorate) },
    { key: 'displacedCount', label: 'النازحون', cell: (row) => cellMono(row.displacedCount) },
    { key: 'familiesCount', label: 'الأسر', cell: (row) => cellMono(row.familiesCount) },
    { key: 'adminsCount', label: 'المسؤولون', cell: (row) => cellMono(row.adminsCount) },
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
            title: `نازحو ${row.name}`,
            href: pageUrl('displaced.html', { campId: row.id }),
          },
          can('camp:manage') && {
            iconName: 'edit',
            title: `تعديل ${row.name}`,
            attrs: `data-edit="${row.id}"`,
          },
          can('camp:manage') && {
            iconName: row.status === STATUS.ACTIVE ? 'ban' : 'power',
            title: row.status === STATUS.ACTIVE ? `تعطيل ${row.name}` : `تفعيل ${row.name}`,
            attrs: `data-toggle="${row.id}"`,
          },
          can('camp:manage') && {
            iconName: 'trash',
            title: `حذف ${row.name}`,
            variant: 'danger',
            attrs: `data-delete="${row.id}"`,
          },
        ]),
    },
  ];

  return `
    ${resultBar({ count: rows.length, total: rows.length, noun: 'مخيم' })}
    ${dataTable({ columns, rows, caption: 'المخيمات المسجلة' })}`;
}

/* ---- Editor dialog --------------------------------------------------------- */

function openEditor(session, camp) {
  const isNew = !camp;

  const modal = openModal({
    title: isNew ? 'إضافة مخيم' : `تعديل ${camp.name}`,
    description: 'اسم المخيم وموقعه وحالته.',
    size: 'lg',
    body: `<form class="form" id="camp-form" novalidate>${campFields(camp || {})}</form>`,
    footer: `
      ${button({ label: 'إلغاء', variant: 'secondary', attrs: 'data-close' })}
      ${button({ label: isNew ? 'إضافة' : 'حفظ', variant: 'primary', type: 'submit', attrs: 'form="camp-form"' })}`,
  });

  const form = qs('#camp-form', modal.element);

  bindForm(form, {
    schema: campSchema(),
    onSubmit: (values) => {
      const payload = {
        name: values.name.trim(),
        governorate: values.governorate,
        city: values.city.trim(),
        status: values.status,
      };

      const duplicate = store.camps.find(
        (row) => row.name.trim() === payload.name && (!camp || row.id !== camp.id)
      );
      if (duplicate) {
        toast.error('تعذر الحفظ', 'يوجد مخيم مسجل بنفس الاسم.');
        return;
      }

      if (isNew) store.camps.create({ ...payload, createdAt: new Date().toISOString() });
      else store.camps.update(camp.id, payload);

      modal.close('submit');
      toast.success(isNew ? 'تمت الإضافة' : 'تم الحفظ', `تم حفظ بيانات "${payload.name}".`);
      load(session);
    },
  });
}

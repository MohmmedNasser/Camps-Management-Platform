/**
 * Edit an aid record (Camp Admin only, real Supabase data — Phase 4.6).
 */

import { qs, params, delegate } from '../utils/dom.js';
import { formatDate } from '../utils/format.js';
import { mountShell } from '../ui/layout.js';
import {
  button,
  breadcrumb,
  pageHeader,
  emptyState,
  errorState,
  skeletonForm,
} from '../ui/components.js';
import { bindForm } from '../ui/form.js';
import { aidFields, aidSchema, formSummary, familyCountLabel } from '../ui/record-forms.js';
import { initMultiSelect } from '../ui/combobox.js';
import { confirmDialog } from '../ui/modal.js';
import { toast } from '../ui/toast.js';
import { pageUrl, go } from '../core/router.js';
import { can } from '../core/auth.js';
import { getAidDistribution, updateAidDistribution, deleteAidDistribution } from '../supabase/aids.js';
import { getCampFamilyOptions } from '../supabase/families.js';
import { listOrganizationOptions } from '../supabase/organizations.js';

const shell = await mountShell({ active: 'aid.html', title: 'تعديل مساعدة' });
if (shell) init(shell);

async function init({ session, content }) {
  const { id } = params();
  content.innerHTML = skeletonForm(6);

  try {
    // record.campId !== session.campId is redundant, UX-only narrowing — RLS
    // on aid_distributions (aid_distributions_select_scoped) already prevents
    // getAidDistribution() from returning another camp's row at all (Phase
    // 4.6 spec, same convention as displaced-edit.js's loadReal()).
    const record = await getAidDistribution(id);
    if (!record || record.campId !== session.campId) {
      content.innerHTML = emptyState({
        iconName: 'alertTriangle',
        title: 'سجل المساعدة غير موجود',
        text: 'قد يكون محذوفاً أو خارج نطاق صلاحياتك.',
        actions: button({ label: 'العودة إلى المساعدات', variant: 'primary', href: pageUrl('aid.html') }),
      });
      return;
    }

    const [organizations, families] = await Promise.all([
      listOrganizationOptions(),
      getCampFamilyOptions(session.campId),
    ]);

    render({ session, content, record, organizations, families });
  } catch (error) {
    console.error(error);
    content.innerHTML = errorState({ retryAttrs: 'data-retry' });
    delegate(content, 'click', '[data-retry]', () => init({ session, content }));
  }
}

function render({ session, content, record, organizations, families }) {
  content.innerHTML = `
    ${breadcrumb([
      { label: 'المساعدات', href: pageUrl('aid.html') },
      { label: record.typeLabels || 'مساعدة', href: pageUrl('aid-details.html', { id: record.id }) },
      { label: 'تعديل' },
    ])}
    ${pageHeader({
      title: 'تعديل المساعدة',
      description: `مسجلة بتاريخ ${formatDate(record.date)}.`,
      actions: can('aid:delete')
        ? button({ label: 'حذف السجل', variant: 'danger', iconName: 'trash', attrs: 'data-delete' })
        : '',
    })}
    ${formSummary([record.typeLabels, record.organizationName, `${record.beneficiaryCount} أسرة مستفيدة`])}

    <form class="form" id="aid-form" novalidate>
      ${aidFields(
        { organizationId: record.organizationId, date: record.date, types: record.types },
        {
          organizations,
          selectedFamilies: families.filter((f) => (record.familyDbIds || []).includes(f.value)),
        }
      )}
      <div class="form-actions">
        ${button({
          label: 'إلغاء',
          variant: 'secondary',
          href: pageUrl('aid-details.html', { id: record.id }),
        })}
        ${button({ label: 'حفظ التعديلات', variant: 'primary', iconName: 'check', type: 'submit' })}
      </div>
    </form>`;

  const form = qs('#aid-form', content);
  initMultiSelect(form, {
    name: 'familyIds',
    search: (query) => searchOptions(families, query),
    selectAllSource: () => families,
    countLabel: familyCountLabel,
  });

  bindForm(form, {
    schema: aidSchema(),
    onSubmit: async (values) => {
      const familyIds = Array.isArray(values.familyIds) ? values.familyIds : [];
      const eligibleFamilyIds = new Set(families.map((f) => f.value));
      const allFamiliesSelected =
        eligibleFamilyIds.size > 0 && familyIds.length === eligibleFamilyIds.size;

      try {
        await updateAidDistribution(record.id, {
          organizationId: values.organizationId,
          distributedOn: values.date,
          aidTypeCodes: values.types,
          familyIds,
          allFamiliesSelected,
        });
        toast.success('تم الحفظ', 'تم تحديث سجل المساعدة.');
        go('aid-details.html', { id: record.id });
      } catch (error) {
        console.error(error);
        toast.error('تعذر الحفظ', 'حدث خطأ أثناء الحفظ، حاول مرة أخرى.');
      }
    },
  });

  delegate(content, 'click', '[data-delete]', async () => {
    const ok = await confirmDialog({
      title: 'حذف سجل المساعدة',
      text: 'سيتم حذف هذا السجل نهائياً من سجل مساعدات الأسرة.',
      confirmLabel: 'حذف',
    });
    if (!ok) return;
    try {
      const deleted = await deleteAidDistribution(record.id);
      if (!deleted) {
        toast.error('تعذر الحذف', 'قد لا تملك صلاحية حذف هذا السجل.');
        return;
      }
      toast.success('تم الحذف', 'تم حذف سجل المساعدة.');
      go('aid.html');
    } catch (error) {
      console.error(error);
      toast.error('تعذر الحذف', 'حدث خطأ أثناء الحذف، حاول مرة أخرى.');
    }
  });
}

/** Matches the mock's `select.searchFamilyOptions()` — a plain label substring match. */
function searchOptions(options, query = '') {
  const term = query.trim().toLowerCase();
  if (!term) return options;
  return options.filter((option) => option.label.toLowerCase().includes(term));
}

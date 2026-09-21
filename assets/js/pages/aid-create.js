/**
 * Register an aid delivery (Camp Admin only, real Supabase data — Phase 4.6).
 *
 * Accepts `?familyId=` so `families.js`/`family-details.js`/
 * `displaced-details.js` can hand over a pre-selected beneficiary. Every one
 * of those callers passes the family's human-readable `reference_code`
 * (`FAM-000001`), not its UUID — matched against `families[].referenceCode`
 * below, while the multi-select itself still runs on the UUID `value` the
 * create RPC needs.
 */

import { qs, params } from '../utils/dom.js';
import { toInputDate } from '../utils/format.js';
import { mountShell } from '../ui/layout.js';
import { button, alert, breadcrumb, pageHeader, emptyState, skeletonForm } from '../ui/components.js';
import { bindForm } from '../ui/form.js';
import { aidFields, aidSchema, familyCountLabel } from '../ui/record-forms.js';
import { initMultiSelect } from '../ui/combobox.js';
import { toast } from '../ui/toast.js';
import { pageUrl, go } from '../core/router.js';
import { createAidDistribution } from '../supabase/aids.js';
import { getCampFamilyOptions } from '../supabase/families.js';
import { listOrganizationOptions } from '../supabase/organizations.js';

const shell = await mountShell({ active: 'aid.html', title: 'إضافة مساعدة' });
if (shell) init(shell);

async function init({ session, content }) {
  content.innerHTML = skeletonForm(4);

  // select.organizationOptions()/select.familyOptions() read the mock store
  // and never match a real authenticated Camp Admin's ids (Phase 4.6 live-
  // schema finding, same trap Phase 4.4's family-create.js flagged for
  // select.campOptions()) — this page is Camp-Admin-only, so both option
  // lists come from the real, camp-scoped data-access layer instead.
  const [organizations, families] = await Promise.all([
    listOrganizationOptions(),
    getCampFamilyOptions(session.campId),
  ]);

  render({ session, content, organizations, families });
}

function render({ session, content, organizations, families }) {
  const query = params();
  const preselected = query.familyId ? families.find((f) => f.referenceCode === query.familyId) : null;
  const familyId = preselected ? preselected.value : '';

  if (!families.length || !organizations.length) {
    content.innerHTML = `
      ${breadcrumb([{ label: 'المساعدات', href: pageUrl('aid.html') }, { label: 'إضافة مساعدة' }])}
      ${pageHeader({ title: 'تسجيل مساعدة' })}
      ${emptyState({
        iconName: 'aid',
        title: !families.length ? 'لا توجد أسر مسجلة' : 'لا توجد جهات مانحة',
        text: !families.length
          ? 'يجب إنشاء أسرة واحدة على الأقل قبل تسجيل المساعدات.'
          : 'أضف جهة مانحة واحدة على الأقل قبل تسجيل المساعدات.',
        actions: button({
          label: !families.length ? 'إضافة أسرة' : 'إدارة الجهات المانحة',
          variant: 'primary',
          iconName: 'plus',
          href: pageUrl(!families.length ? 'family-create.html' : 'organizations.html'),
        }),
      })}`;
    return;
  }

  content.innerHTML = `
    ${breadcrumb([{ label: 'المساعدات', href: pageUrl('aid.html') }, { label: 'إضافة مساعدة' }])}
    ${pageHeader({
      title: 'تسجيل مساعدة',
      description: `سيتم تسجيل المساعدة ضمن ${session.campLabel}.`,
    })}
    ${alert({
      variant: 'info',
      title: 'من يسجّل المساعدات؟',
      text: 'إضافة المساعدات وتعديلها وحذفها من صلاحيات مسؤول المخيم فقط، ويطّلع عليها النازح دون تعديل.',
    })}

    <form class="form u-mt-5" id="aid-form" novalidate>
      ${aidFields(
        {
          familyIds: familyId ? [familyId] : [],
          date: toInputDate(new Date()),
        },
        {
          organizations,
          selectedFamilies: familyId ? families.filter((f) => f.value === familyId) : [],
        }
      )}
      <div class="form-actions">
        ${button({ label: 'إلغاء', variant: 'secondary', href: pageUrl('aid.html') })}
        ${button({ label: 'حفظ المساعدة', variant: 'primary', iconName: 'check', type: 'submit' })}
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
        const id = await createAidDistribution({
          organizationId: values.organizationId,
          campId: session.campId,
          distributedOn: values.date,
          aidTypeCodes: values.types,
          familyIds,
          allFamiliesSelected,
        });
        toast.success('تم الحفظ', 'تم تسجيل المساعدة في سجل الأسر المستفيدة.');
        go('aid-details.html', { id });
      } catch (error) {
        console.error(error);
        toast.error('تعذر الحفظ', 'حدث خطأ أثناء الحفظ، حاول مرة أخرى.');
      }
    },
  });
}

/** Matches the mock's `select.searchFamilyOptions()` — a plain label substring match. */
function searchOptions(options, query = '') {
  const term = query.trim().toLowerCase();
  if (!term) return options;
  return options.filter((option) => option.label.toLowerCase().includes(term));
}

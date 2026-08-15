/**
 * Edit an aid record (Camp Admin only).
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
import { aidFields, aidSchema, formSummary } from '../ui/record-forms.js';
import { confirmDialog } from '../ui/modal.js';
import { toast } from '../ui/toast.js';
import { pageUrl, go } from '../core/router.js';
import { can, inScope } from '../core/auth.js';
import * as store from '../core/store.js';
import * as select from '../core/selectors.js';

const shell = mountShell({ active: 'aid.html', title: 'تعديل مساعدة' });
if (shell) init(shell);

async function init({ session, content }) {
  const { id } = params();
  content.innerHTML = skeletonForm(6);

  try {
    const record = await store.load(() => store.aid.get(id));

    if (!record || !inScope(record, session)) {
      content.innerHTML = emptyState({
        iconName: 'alertTriangle',
        title: 'سجل المساعدة غير موجود',
        text: 'قد يكون محذوفاً أو خارج نطاق صلاحياتك.',
        actions: button({ label: 'العودة إلى المساعدات', variant: 'primary', href: pageUrl('aid.html') }),
      });
      return;
    }

    render({ session, content, record });
  } catch (error) {
    console.error(error);
    content.innerHTML = errorState({ retryAttrs: 'data-retry' });
    delegate(content, 'click', '[data-retry]', () => init({ session, content }));
  }
}

function render({ session, content, record }) {
  const campId = record.campId || session.campId;
  const organizations = select.organizationOptions();
  const families = select.familyOptions(campId);
  const row = select.aidRow(record);

  content.innerHTML = `
    ${breadcrumb([
      { label: 'المساعدات', href: pageUrl('aid.html') },
      { label: row.typeLabel, href: pageUrl('aid-details.html', { id: record.id }) },
      { label: 'تعديل' },
    ])}
    ${pageHeader({
      title: 'تعديل المساعدة',
      description: `مسجلة بتاريخ ${formatDate(record.date)}.`,
      actions: can('aid:delete')
        ? button({ label: 'حذف السجل', variant: 'danger', iconName: 'trash', attrs: 'data-delete' })
        : '',
    })}
    ${formSummary([row.typeLabel, row.organizationName, row.familyId, row.familyHeadName])}

    <form class="form" id="aid-form" novalidate>
      ${aidFields(record, { organizations, families })}
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

  bindForm(form, {
    schema: aidSchema(),
    onSubmit: (values) => {
      const family = store.families.get(values.familyId);
      store.aid.update(record.id, {
        type: values.type,
        organizationId: values.organizationId,
        familyId: values.familyId,
        campId: family ? family.campId : campId,
        date: values.date,
        quantity: (values.quantity || '').trim(),
        description: values.description.trim(),
      });
      toast.success('تم الحفظ', 'تم تحديث سجل المساعدة.');
      go('aid-details.html', { id: record.id });
    },
  });

  delegate(content, 'click', '[data-delete]', async () => {
    const ok = await confirmDialog({
      title: 'حذف سجل المساعدة',
      text: 'سيتم حذف هذا السجل نهائياً من سجل مساعدات الأسرة.',
      confirmLabel: 'حذف',
    });
    if (!ok) return;
    store.aid.remove(record.id);
    toast.success('تم الحذف', 'تم حذف سجل المساعدة.');
    go('aid.html');
  });
}

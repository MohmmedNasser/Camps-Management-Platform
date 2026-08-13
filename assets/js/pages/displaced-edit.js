/**
 * Edit a displaced person (Camp Admin only).
 *
 * Same field set as creation; the duplicate check on the national ID skips
 * this record so an unchanged ID does not report itself as a duplicate.
 */

import { qs, esc, params, delegate } from '../utils/dom.js';
import { mountShell } from '../ui/layout.js';
import {
  button,
  breadcrumb,
  pageHeader,
  emptyState,
  errorState,
  skeletonForm,
} from '../ui/components.js';
import { bindForm, setFieldError } from '../ui/form.js';
import { displacedFields, displacedSchema, formSummary } from '../ui/record-forms.js';
import { confirmDialog } from '../ui/modal.js';
import { toast } from '../ui/toast.js';
import { pageUrl, go } from '../core/router.js';
import { inScope, can } from '../core/auth.js';
import * as store from '../core/store.js';
import * as select from '../core/selectors.js';

const shell = mountShell({ active: 'displaced.html', title: 'تعديل بيانات نازح' });
if (shell) init(shell);

async function init({ session, content }) {
  const { id } = params();
  content.innerHTML = skeletonForm(8);

  try {
    const person = await store.load(() => store.displaced.get(id));

    if (!person || !inScope(person, session)) {
      content.innerHTML = emptyState({
        iconName: 'alertTriangle',
        title: 'سجل النازح غير موجود',
        text: 'قد يكون السجل محذوفاً أو خارج نطاق صلاحياتك.',
        actions: button({ label: 'العودة إلى النازحين', variant: 'primary', href: pageUrl('displaced.html') }),
      });
      return;
    }

    render({ session, content, person });
  } catch (error) {
    console.error(error);
    content.innerHTML = errorState({ retryAttrs: 'data-retry' });
    delegate(content, 'click', '[data-retry]', () => init({ session, content }));
  }
}

function render({ session, content, person }) {
  const camps = select.campOptions(session);
  const families = select.familyOptions(person.campId);

  content.innerHTML = `
    ${breadcrumb([
      { label: 'النازحون', href: pageUrl('displaced.html') },
      { label: person.fullName, href: pageUrl('displaced-details.html', { id: person.id }) },
      { label: 'تعديل' },
    ])}
    ${pageHeader({
      title: 'تعديل بيانات النازح',
      description: 'التعديلات تُحفظ فور الضغط على زر الحفظ.',
      actions: can('displaced:delete')
        ? button({ label: 'حذف السجل', variant: 'danger', iconName: 'trash', attrs: 'data-delete' })
        : '',
    })}
    ${formSummary([person.fullName, person.nationalId, person.familyId])}

    <form class="form" id="displaced-form" novalidate>
      ${displacedFields(person, { camps, families, lockCamp: camps.length === 1 })}
      <div class="form-actions">
        ${button({
          label: 'إلغاء',
          variant: 'secondary',
          href: pageUrl('displaced-details.html', { id: person.id }),
        })}
        ${button({ label: 'حفظ التعديلات', variant: 'primary', iconName: 'check', type: 'submit' })}
      </div>
    </form>`;

  const form = qs('#displaced-form', content);
  const campSelect = qs('#campId', form);
  if (campSelect && campSelect.disabled) campSelect.value = person.campId;

  bindForm(form, {
    schema: displacedSchema({
      isDuplicateId: (value) => select.nationalIdTaken(value, person.id),
    }),
    onSubmit: (values) => {
      if (select.nationalIdTaken(values.nationalId, person.id)) {
        setFieldError(form, 'nationalId', 'رقم الهوية مسجّل لنازح آخر.');
        toast.error('تعذر الحفظ', 'رقم الهوية مسجّل لنازح آخر.');
        return;
      }

      const previousFamilyId = person.familyId;
      const updated = store.displaced.update(person.id, {
        ...values,
        campId: values.campId || person.campId,
        monthlyIncome: Number(values.monthlyIncome || 0),
      });

      if (values.familyId && values.relationship === 'head') {
        store.families.update(values.familyId, { headId: person.id });
      }
      // Leaving a family they headed hands the role to another member.
      if (previousFamilyId && previousFamilyId !== values.familyId) {
        const old = store.families.get(previousFamilyId);
        if (old && old.headId === person.id) {
          const remaining = select.familyMembers(previousFamilyId);
          if (remaining.length) store.families.update(previousFamilyId, { headId: remaining[0].id });
        }
      }

      toast.success('تم الحفظ', `تم تحديث بيانات ${updated.fullName}.`);
      go('displaced-details.html', { id: person.id });
    },
  });

  delegate(content, 'change', '#campId', (event, node) => {
    const familySelect = qs('#familyId', form);
    if (!familySelect) return;
    familySelect.innerHTML =
      `<option value="">بدون أسرة</option>` +
      select
        .familyOptions(node.value)
        .map((option) => `<option value="${esc(option.value)}">${esc(option.label)}</option>`)
        .join('');
  });

  delegate(content, 'click', '[data-delete]', async () => {
    const ok = await confirmDialog({
      title: 'حذف سجل النازح',
      text: `سيتم حذف "${person.fullName}" وكل ما يرتبط به من مساعدات ومستندات. لا يمكن التراجع عن هذه العملية.`,
      confirmLabel: 'حذف نهائي',
    });
    if (!ok) return;
    select.removeDisplaced(person.id);
    toast.success('تم الحذف', 'تم حذف سجل النازح.');
    go('displaced.html');
  });
}

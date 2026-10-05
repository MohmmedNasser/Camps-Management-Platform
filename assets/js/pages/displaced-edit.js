/**
 * Edit a displaced person (Camp Admin only).
 *
 * Same field set as creation; the duplicate check on the national ID skips
 * this record so an unchanged ID does not report itself as a duplicate.
 */

import { qs, params, delegate } from '../utils/dom.js';
import { mountShell } from '../ui/layout.js';
import {
  button,
  breadcrumb,
  pageHeader,
  emptyState,
  errorState,
  skeletonForm,
} from '../ui/components.js';
import { bindForm, setFieldError, bindMaternityFields } from '../ui/form.js';
import { displacedFields, displacedSchema, formSummary } from '../ui/record-forms.js';
import { confirmDialog } from '../ui/modal.js';
import { toast } from '../ui/toast.js';
import { pageUrl, go } from '../core/router.js';
import { can } from '../core/auth.js';
import { getDisplacedPerson, updateFamilyMember, removeFamilyMember, toFamilyMemberPayload, isDuplicateNationalId, hasLinkedAccount } from '../supabase/family-members.js';

const shell = await mountShell({ active: 'displaced.html', title: 'تعديل بيانات نازح' });
if (shell) init(shell);

// Camp-Admin-only page (PAGE_ACCESS), so `session.role` here is always
// `camp_admin` — no other-role branch needed.
async function init({ session, content }) {
  const { id } = params();
  content.innerHTML = skeletonForm(8);

  try {
    const person = await loadReal(id, session);

    if (!person) {
      content.innerHTML = emptyState({
        iconName: 'alertTriangle',
        title: 'سجل النازح غير موجود',
        text: 'قد يكون السجل محذوفاً أو خارج نطاق صلاحياتك.',
        actions: button({ label: 'العودة إلى النازحين', variant: 'primary', href: pageUrl('displaced.html') }),
      });
      return;
    }

    renderReal({ session, content, person, emailLocked: await hasLinkedAccount(person.id) });
  } catch (error) {
    console.error(error);
    content.innerHTML = errorState({ retryAttrs: 'data-retry' });
    delegate(content, 'click', '[data-retry]', () => init({ session, content }));
  }
}

/**
 * `person.campId !== session.campId` is redundant, UX-only narrowing — RLS
 * on `family_members` already prevents `getDisplacedPerson()` from
 * returning another camp's row at all (Phase 4.5 spec §1/§5.2).
 */
async function loadReal(id, session) {
  const person = await getDisplacedPerson(id);
  if (!person || person.campId !== session.campId) return null;
  return person;
}

/* ---- Real Camp Admin path --------------------------------------------------
 * Family reassignment is not exposed here (`showFamily: false`): the only
 * server-side head-repair trigger, `family_members_promote_head`, fires
 * `AFTER DELETE`, not on a family_id reassignment via UPDATE — confirmed
 * live (Phase 4.5 spec §1). Reassigning a family's head to a different
 * family here would leave the old family's `head_member_id` dangling with
 * no automatic repair, so the field stays out of the real edit form; every
 * other field remains editable. */

function renderReal({ session, content, person, emailLocked }) {
  const camps = [{ value: session.campId, label: session.campLabel }];

  content.innerHTML = `
    ${breadcrumb([
      { label: 'النازحون', href: pageUrl('displaced.html') },
      { label: person.fullName, href: pageUrl('displaced-details.html', { id: person.id }) },
      { label: 'تعديل' },
    ])}
    ${pageHeader({
      title: 'تعديل بيانات النازح',
      description: 'التعديلات تُحفظ فور الضغط على زر الحفظ. لا يمكن تغيير الأسرة من هذه الصفحة.',
      actions: can('displaced:delete')
        ? button({ label: 'حذف السجل', variant: 'danger', iconName: 'trash', attrs: 'data-delete' })
        : '',
    })}
    ${formSummary([person.fullName, person.nationalId, person.familyId])}

    <form class="form" id="displaced-form" novalidate autocomplete="off">
      ${displacedFields(person, { camps, lockCamp: true, showFamily: false, lockEmail: emailLocked })}
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
  bindMaternityFields(form);

  const campSelect = qs('#campId', form);
  if (campSelect && campSelect.disabled) campSelect.value = person.campId;

  bindForm(form, {
    schema: displacedSchema(),
    onSubmit: async (values) => {
      try {
        const payload = toFamilyMemberPayload(values);
        // A disabled field is not submitted; leave the stored email untouched
        // rather than letting it be written as null.
        if (emailLocked) delete payload.email;
        await updateFamilyMember(person.id, payload);
        toast.success('تم الحفظ', `تم تحديث بيانات ${values.fullName}.`);
        go('displaced-details.html', { id: person.id });
      } catch (error) {
        if (isDuplicateNationalId(error)) {
          setFieldError(form, 'nationalId', 'رقم الهوية مسجّل لنازح آخر.');
          toast.error('تعذر الحفظ', 'رقم الهوية مسجّل لنازح آخر.');
          return;
        }
        console.error(error);
        toast.error('تعذر الحفظ', 'حدث خطأ أثناء الحفظ، حاول مرة أخرى.');
      }
    },
  });

  delegate(content, 'click', '[data-delete]', async () => {
    const ok = await confirmDialog({
      title: 'حذف سجل النازح',
      text: `سيتم حذف "${person.fullName}" وكل ما يرتبط به من مساعدات ومستندات. لا يمكن التراجع عن هذه العملية.`,
      confirmLabel: 'حذف نهائي',
    });
    if (!ok) return;
    try {
      await removeFamilyMember(person.id);
      toast.success('تم الحذف', 'تم حذف سجل النازح.');
      go('displaced.html');
    } catch (error) {
      console.error(error);
      toast.error('تعذر الحذف', 'قد لا تملك صلاحية حذف هذا السجل.');
    }
  });
}

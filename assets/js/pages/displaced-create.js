/**
 * Add a displaced person (Camp Admin only).
 *
 * The national ID is the single duplicate check — the same person cannot be
 * registered twice, or in two camps.
 */

import { qs, esc, delegate } from '../utils/dom.js';
import { mountShell } from '../ui/layout.js';
import { button, alert, breadcrumb, pageHeader } from '../ui/components.js';
import { bindForm, setFieldError } from '../ui/form.js';
import { displacedFields, displacedSchema } from '../ui/record-forms.js';
import { toast } from '../ui/toast.js';
import { pageUrl, go } from '../core/router.js';
import * as store from '../core/store.js';
import * as select from '../core/selectors.js';
import { STATUS } from '../core/config.js';

const shell = mountShell({ active: 'displaced.html', title: 'إضافة نازح' });
if (shell) init(shell);

function init({ session, content }) {
  const camps = select.campOptions(session);
  const families = select.familyOptions(session.campId);
  const defaults = { campId: session.campId, relationship: 'head', tentType: 'family_tent' };

  content.innerHTML = `
    ${breadcrumb([
      { label: 'النازحون', href: pageUrl('displaced.html') },
      { label: 'إضافة نازح' },
    ])}
    ${pageHeader({
      title: 'إضافة نازح',
      description: `سيتم تسجيل النازح في ${session.campLabel}.`,
    })}

    ${alert({
      variant: 'info',
      title: 'قبل البدء',
      text: 'رقم الهوية هو المعرّف الوحيد لمنع التسجيل المكرر — لا يوجد رقم ملف أو رقم خيمة في النظام.',
    })}

    <form class="form u-mt-5" id="displaced-form" novalidate>
      ${displacedFields(defaults, { camps, families, lockCamp: camps.length === 1 })}
      <div class="form-actions">
        ${button({ label: 'إلغاء', variant: 'secondary', href: pageUrl('displaced.html') })}
        ${button({ label: 'حفظ النازح', variant: 'primary', iconName: 'check', type: 'submit' })}
      </div>
    </form>`;

  const form = qs('#displaced-form', content);

  // A locked camp select posts nothing; keep the value available on submit.
  const campSelect = qs('#campId', form);
  if (campSelect && campSelect.disabled) campSelect.value = session.campId;

  bindForm(form, {
    schema: displacedSchema({ isDuplicateId: (value) => select.nationalIdTaken(value) }),
    onSubmit: (values) => {
      const campId = values.campId || session.campId;

      if (select.nationalIdTaken(values.nationalId)) {
        const camp = select.campOfNationalId(values.nationalId);
        setFieldError(
          form,
          'nationalId',
          `رقم الهوية مسجّل مسبقاً${camp ? ` في ${camp}` : ''}. لا يمكن تسجيله مرة أخرى.`
        );
        toast.error('تعذر الحفظ', 'رقم الهوية مسجّل مسبقاً.');
        return;
      }

      const person = store.displaced.create({
        ...values,
        campId,
        monthlyIncome: Number(values.monthlyIncome || 0),
        status: STATUS.APPROVED,
        createdAt: new Date().toISOString(),
      });

      // Keeping a family's head inside its own member list is a data rule.
      if (values.familyId && values.relationship === 'head') {
        store.families.update(values.familyId, { headId: person.id });
      }

      toast.success('تمت الإضافة', `تم تسجيل ${person.fullName} بنجاح.`);
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
}

/**
 * Create a family (Camp Admin only).
 *
 * The ID is generated, never typed: `selectors.nextFamilyId()` produces the
 * next `FAM-000000` in sequence. Members can be attached during creation from
 * the people in this camp who do not belong to a family yet.
 */

import { qs, qsa, esc, delegate } from '../utils/dom.js';
import { formatAge } from '../utils/format.js';
import { mountShell } from '../ui/layout.js';
import { button, alert, breadcrumb, pageHeader, emptyState } from '../ui/components.js';
import { bindForm, checkboxField } from '../ui/form.js';
import { familyFields, familySchema } from '../ui/record-forms.js';
import { toast } from '../ui/toast.js';
import { pageUrl, go } from '../core/router.js';
import * as store from '../core/store.js';
import * as select from '../core/selectors.js';
import { labelOf, GENDERS } from '../core/config.js';

const shell = mountShell({ active: 'families.html', title: 'إضافة أسرة' });
if (shell) init(shell);

function init({ session, content }) {
  const familyId = select.nextFamilyId();
  const camps = select.campOptions(session);
  const candidates = select.familyHeadCandidates(session.campId);
  const unassigned = select.unassignedPeople(session.campId);

  content.innerHTML = `
    ${breadcrumb([{ label: 'الأسر', href: pageUrl('families.html') }, { label: 'إضافة أسرة' }])}
    ${pageHeader({
      title: 'إضافة أسرة',
      description: `سيتم إنشاء الأسرة في ${session.campLabel}.`,
    })}

    ${
      candidates.length
        ? alert({
            variant: 'info',
            title: 'رقم الأسرة يُولَّد تلقائياً',
            text: `سيحمل هذا السجل الرقم ${familyId}، ولا يمكن تعديله لاحقاً.`,
          })
        : alert({
            variant: 'warning',
            title: 'لا يوجد نازحون متاحون',
            text: 'يجب تسجيل نازح واحد على الأقل في المخيم قبل إنشاء أسرة، لأن كل أسرة تحتاج رب أسرة.',
          })
    }

    ${
      candidates.length
        ? `<form class="form u-mt-5" id="family-form" novalidate>
            ${familyFields(
              { id: familyId, campId: session.campId },
              { camps, members: candidates, lockCamp: camps.length === 1 }
            )}
            ${membersFieldset(unassigned)}
            <div class="form-actions">
              ${button({ label: 'إلغاء', variant: 'secondary', href: pageUrl('families.html') })}
              ${button({ label: 'إنشاء الأسرة', variant: 'primary', iconName: 'check', type: 'submit' })}
            </div>
          </form>`
        : `<div class="u-mt-5">${emptyState({
            iconName: 'users',
            title: 'ابدأ بتسجيل نازح',
            text: 'بعد تسجيل أول نازح في المخيم يمكنك إنشاء أسرة وتعيينه رباً لها.',
            actions: button({
              label: 'إضافة نازح',
              variant: 'primary',
              iconName: 'plus',
              href: pageUrl('displaced-create.html'),
            }),
          })}</div>`
    }`;

  const form = qs('#family-form', content);
  if (!form) return;

  const campSelect = qs('#campId', form);
  if (campSelect && campSelect.disabled) campSelect.value = session.campId;

  bindForm(form, {
    schema: familySchema(),
    onSubmit: (values) => {
      const campId = values.campId || session.campId;
      const head = store.displaced.get(values.headId);

      if (!head) {
        toast.error('تعذر الحفظ', 'رب الأسرة المحدد غير موجود.');
        return;
      }

      const family = store.families.create(
        {
          id: familyId,
          campId,
          headId: head.id,
          notes: values.notes || '',
          createdAt: new Date().toISOString(),
        },
        { id: familyId }
      );

      // The head must be a member of their own family, in the same camp.
      store.displaced.update(head.id, { familyId: family.id, campId, relationship: 'head' });

      qsa('[name^="member-"]:checked', form).forEach((checkbox) => {
        const memberId = checkbox.name.replace('member-', '');
        if (memberId === head.id) return;
        store.displaced.update(memberId, { familyId: family.id });
      });

      toast.success('تم الإنشاء', `تم إنشاء الأسرة ${family.id}.`);
      go('family-details.html', { id: family.id });
    },
  });

  // Someone chosen as head should not also appear as an optional member.
  delegate(content, 'change', '#headId', (event, node) => {
    qsa('[data-member-row]', form).forEach((row) => {
      const isHead = row.dataset.memberRow === node.value;
      row.hidden = isHead;
      const checkbox = qs('input', row);
      if (isHead && checkbox) checkbox.checked = false;
    });
  });
}

function membersFieldset(people) {
  if (!people.length) return '';

  return `
    <fieldset class="fieldset">
      <legend class="fieldset__legend">إضافة أفراد (اختياري)</legend>
      <p class="fieldset__hint">النازحون المسجلون في المخيم وغير المرتبطين بأي أسرة.</p>
      <div class="field-grid">
        ${people
          .map(
            (person) => `
          <div data-member-row="${esc(person.id)}">
            ${checkboxField({
              name: `member-${person.id}`,
              label: person.fullName,
              description: `${labelOf(GENDERS, person.gender)} · ${formatAge(person.birthDate)} · ${person.nationalId}`,
            })}
          </div>`
          )
          .join('')}
      </div>
    </fieldset>`;
}

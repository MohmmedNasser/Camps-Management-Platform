/**
 * Add a displaced person (Camp Admin only).
 *
 * The national ID is the single duplicate check — the same person cannot be
 * registered twice, or in two camps.
 */

import { qs, esc, params, delegate } from '../utils/dom.js';
import { mountShell } from '../ui/layout.js';
import { button, alert, breadcrumb, pageHeader, skeletonForm, errorState } from '../ui/components.js';
import { bindForm, setFieldError, bindMaternityFields } from '../ui/form.js';
import { displacedFields, displacedSchema, maternityFrom } from '../ui/record-forms.js';
import { toast } from '../ui/toast.js';
import { pageUrl, go } from '../core/router.js';
import * as store from '../core/store.js';
import * as select from '../core/selectors.js';
import { STATUS, ROLES } from '../core/config.js';
import { getCampFamilies, getFamilyByReferenceCode } from '../supabase/families.js';
import { addFamilyMember, toFamilyMemberPayload, isDuplicateNationalId } from '../supabase/family-members.js';

const shell = await mountShell({ active: 'displaced.html', title: 'إضافة نازح' });
if (shell) init(shell);

function init({ session, content }) {
  if (session.role === ROLES.CAMP_ADMIN) {
    initReal(session, content);
    return;
  }
  initMock(session, content);
}

/* ---- Real Camp Admin path -------------------------------------------------
 * `family_members.family_id` is NOT NULL in the live schema (Phase 4.5
 * spec §1), and CLAUDE.md domain rule 13 already documents the intended
 * architecture: displaced-create.html only ever adds a person to an
 * EXISTING family. The mock's "بدون أسرة" choice has no real-schema
 * equivalent, so the family field is required here (and only here). */

async function initReal(session, content) {
  content.innerHTML = skeletonForm(8);

  let families;
  try {
    families = await getCampFamilies(session.campId);
  } catch (error) {
    console.error(error);
    content.innerHTML = errorState({ retryAttrs: 'data-retry' });
    delegate(content, 'click', '[data-retry]', () => initReal(session, content));
    return;
  }

  const { familyId: referenceCode } = params();
  const preselected = referenceCode && families.some((family) => family.id === referenceCode) ? referenceCode : '';
  const familyOptions = families
    .map((family) => ({ value: family.id, label: `${family.id} — ${family.headName}` }))
    .sort((a, b) => a.value.localeCompare(b.value));

  const camps = [{ value: session.campId, label: session.campLabel }];
  const defaults = {
    campId: session.campId,
    relationship: 'son',
    familyId: preselected,
    tentType: 'tarp_tent',
  };

  content.innerHTML = `
    ${breadcrumb([
      { label: 'النازحون', href: pageUrl('displaced.html') },
      { label: 'إضافة نازح' },
    ])}
    ${pageHeader({
      title: 'إضافة نازح',
      description: preselected
        ? `سيتم إضافة الفرد إلى الأسرة ${preselected} في ${session.campLabel}.`
        : `اختر الأسرة التي سينضم إليها النازح في ${session.campLabel}.`,
    })}

    ${alert({
      variant: 'info',
      title: 'قبل البدء',
      text: 'رقم الهوية هو المعرّف الوحيد لمنع التسجيل المكرر — لا يوجد رقم ملف أو رقم خيمة في النظام. لا يمكن تسجيل نازح دون ربطه بأسرة قائمة؛ لتسجيل أسرة جديدة بكامل أفرادها استخدم صفحة إضافة أسرة.',
    })}

    ${
      families.length
        ? `<form class="form u-mt-5" id="displaced-form" novalidate>
      ${displacedFields(defaults, { camps, families: familyOptions, lockCamp: true })}
      <div class="form-actions">
        ${button({ label: 'إلغاء', variant: 'secondary', href: pageUrl('displaced.html') })}
        ${button({ label: 'حفظ النازح', variant: 'primary', iconName: 'check', type: 'submit' })}
      </div>
    </form>`
        : alert({
            variant: 'warning',
            title: 'لا توجد أسر مسجلة بعد',
            text: 'أنشئ أسرة أولاً من صفحة إضافة أسرة قبل تسجيل أفرادها.',
          })
    }`;

  const form = qs('#displaced-form', content);
  if (!form) return;

  bindMaternityFields(form);

  const campSelect = qs('#campId', form);
  if (campSelect && campSelect.disabled) campSelect.value = session.campId;

  bindForm(form, {
    schema: displacedSchema({ requireFamily: true }),
    onSubmit: async (values) => {
      const targetFamily = families.find((family) => family.id === values.familyId);
      if (!targetFamily) {
        setFieldError(form, 'familyId', 'اختر أسرة صحيحة.');
        return;
      }

      try {
        const family = await getFamilyByReferenceCode(values.familyId);
        if (!family) {
          setFieldError(form, 'familyId', 'تعذر العثور على الأسرة المختارة.');
          return;
        }
        const memberId = await addFamilyMember(family._dbId, toFamilyMemberPayload(values));
        toast.success('تمت الإضافة', `تم تسجيل ${values.fullName} بنجاح.`);
        go('displaced-details.html', { id: memberId });
      } catch (error) {
        if (isDuplicateNationalId(error)) {
          setFieldError(form, 'nationalId', 'رقم الهوية مسجّل مسبقاً. لا يمكن تسجيل الشخص نفسه في أكثر من مخيم.');
          toast.error('تعذر الحفظ', 'رقم الهوية مسجّل مسبقاً.');
          return;
        }
        console.error(error);
        toast.error('تعذر الحفظ', 'حدث خطأ أثناء حفظ البيانات، حاول مرة أخرى.');
      }
    },
  });
}

/* ---- Mock path (Super Admin) — unchanged ---------------------------------- */

function initMock(session, content) {
  const camps = select.campOptions(session);
  const families = select.familyOptions(session.campId);

  // Adding one person to a family that already exists. A brand-new family is
  // registered with all its members at once from family-create.html.
  const { familyId } = params();
  const preselected = familyId && families.some((option) => option.value === familyId) ? familyId : '';

  const defaults = {
    campId: session.campId,
    relationship: preselected ? 'son' : 'head',
    familyId: preselected,
    tentType: 'tarp_tent',
  };

  content.innerHTML = `
    ${breadcrumb([
      { label: 'النازحون', href: pageUrl('displaced.html') },
      { label: 'إضافة نازح' },
    ])}
    ${pageHeader({
      title: 'إضافة نازح',
      description: preselected
        ? `سيتم إضافة الفرد إلى الأسرة ${preselected} في ${session.campLabel}.`
        : `سيتم تسجيل النازح في ${session.campLabel}.`,
    })}

    ${alert({
      variant: 'info',
      title: 'قبل البدء',
      text: 'رقم الهوية هو المعرّف الوحيد لمنع التسجيل المكرر — لا يوجد رقم ملف أو رقم خيمة في النظام. لتسجيل أسرة جديدة بكامل أفرادها استخدم صفحة إضافة أسرة.',
    })}

    <form class="form u-mt-5" id="displaced-form" novalidate>
      ${displacedFields(defaults, { camps, families, lockCamp: camps.length === 1 })}
      <div class="form-actions">
        ${button({ label: 'إلغاء', variant: 'secondary', href: pageUrl('displaced.html') })}
        ${button({ label: 'حفظ النازح', variant: 'primary', iconName: 'check', type: 'submit' })}
      </div>
    </form>`;

  const form = qs('#displaced-form', content);
  bindMaternityFields(form);

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
        isOrphan: Boolean(values.isOrphan),
        ...maternityFrom(values),
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

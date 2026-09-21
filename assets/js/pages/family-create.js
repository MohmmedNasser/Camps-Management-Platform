/**
 * Register a family (Camp Admin only).
 *
 * One form, one submit: the head of household, the family record and every
 * remaining member are created together. There is no "save the family, then
 * open it, then add a member" round trip — a family is never left headless and
 * a member is never left without a family.
 *
 * The ID is generated, never typed: `selectors.nextFamilyId()` produces the
 * next `FAM-000000` in sequence.
 */

import { qs, qsa, params, delegate } from '../utils/dom.js';
import { mountShell } from '../ui/layout.js';
import { button, alert, breadcrumb, pageHeader } from '../ui/components.js';
import { bindForm, textareaField, readForm, bindMaternityFields } from '../ui/form.js';
import {
  displacedFields,
  displacedSchema,
  memberFields,
  memberSchema,
  readMember,
  maternityFrom,
} from '../ui/record-forms.js';
import { toast } from '../ui/toast.js';
import { pageUrl, go } from '../core/router.js';
import { createFamilyWithMembers } from '../supabase/families.js';
import { isDuplicateNationalId, toFamilyMemberPayload } from '../supabase/family-members.js';

const shell = await mountShell({ active: 'families.html', title: 'إضافة أسرة' });
if (shell) init(shell);

function init({ session, content }) {
  // select.campOptions(session) reads the mock camps table and never
  // matches a real authenticated Camp Admin's session.campId (Phase 4.4
  // spec's live-schema finding) — this page is Camp-Admin-only, so the
  // admin's own session already IS the one valid option.
  const camps = [{ value: session.campId, label: session.campLabel }];

  // Blocks are tracked by index and never renumbered, so removing "فرد 2" does
  // not silently rewrite the values the admin already typed into "فرد 3".
  const blocks = [];
  let nextIndex = 0;

  content.innerHTML = view(session, camps);

  const form = qs('#family-form', content);
  const list = qs('#member-list', content);
  const empty = qs('#member-empty', content);

  bindMaternityFields(form);

  const campSelect = qs('#campId', form);
  if (campSelect && campSelect.disabled) campSelect.value = session.campId;

  /* ---- Duplicate national IDs ------------------------------------------ */

  // select.nationalIdTaken(id) only checks the mock store; this page's
  // Camp Admin can't see other camps' national IDs to pre-check them
  // client-side (RLS), so the live cross-camp check is dropped. The DB's
  // global unique index is the real boundary, surfaced at submit time via
  // isDuplicateNationalId() above. What's left here — catching two blocks
  // in THIS form using the same id — needs no server round trip and still
  // runs on every keystroke.
  const isDuplicateId = (value, values, self = null) => {
    const id = String(value || '').trim();
    if (!id) return false;

    const others = [values.nationalId, ...blocks.map((i) => values[`member${i}_nationalId`])];
    const selfSlot = self === null ? 0 : blocks.indexOf(self) + 1;
    return others.some((other, slot) => slot !== selfSlot && String(other || '').trim() === id);
  };

  /* ---- Schema, grown and shrunk with the member blocks ------------------ */

  // bindForm reads this object on every run, so mutating it in place is how
  // dynamically added blocks get validated.
  const schema = displacedSchema({ isDuplicateId: (value) => isDuplicateId(value, readForm(form)) });

  const addBlock = () => {
    const index = nextIndex;
    nextIndex += 1;
    blocks.push(index);

    list.insertAdjacentHTML('beforeend', memberFields(index));
    Object.assign(schema, memberSchema(index, { isDuplicateId }));
    // The new block carries its own maternity toggle; already-wired ones are
    // skipped, so this stays cheap however many members are added.
    bindMaternityFields(form);
    syncEmptyState();

    qs(`[data-member-block="${index}"] .input`, list)?.focus();
  };

  const removeBlock = (index) => {
    const node = qs(`[data-member-block="${index}"]`, list);
    if (node) node.remove();
    blocks.splice(blocks.indexOf(index), 1);
    Object.keys(memberSchema(index)).forEach((name) => delete schema[name]);
    renumber();
    syncEmptyState();
  };

  // The stored index stays put; only the visible heading is renumbered.
  const renumber = () => {
    qsa('[data-member-block]', list).forEach((node, position) => {
      const title = qs('.member-block__title', node);
      if (title) title.textContent = `فرد ${position + 1}`;
    });
  };

  const syncEmptyState = () => {
    if (empty) empty.hidden = blocks.length > 0;
  };

  syncEmptyState();

  delegate(content, 'click', '[data-add-member]', () => addBlock());
  delegate(content, 'click', '[data-remove-member]', (event, node) =>
    removeBlock(Number(node.dataset.removeMember))
  );

  /* ---- Submit ----------------------------------------------------------- */

  bindForm(form, {
    schema,
    onSubmit: async (values) => {
      const campId = values.campId || session.campId;
      const memberCount = blocks.length;
      const maternity = maternityFrom(values);

      try {
        const result = await createFamilyWithMembers({
          campId,
          notes: (values.notes || '').trim(),
          head: toFamilyMemberPayload(
            { ...values, isPregnant: maternity.isPregnant, isBreastfeeding: maternity.isBreastfeeding },
            { relationship: 'head', status: 'approved' }
          ),
          members: blocks.map((index) => toFamilyMemberPayload(readMember(values, index))),
        });
        toast.success('تم الإنشاء', `تم إنشاء الأسرة ${result.referenceCode} مع ${memberCount + 1} من الأفراد.`);
        go('family-details.html', { id: result.referenceCode });
      } catch (error) {
        if (isDuplicateNationalId(error)) {
          toast.error(
            'رقم هوية مكرر',
            'أحد أرقام الهوية المدخلة مسجّل بالفعل لدى أسرة أخرى. تحقق من رقم رب الأسرة وكل فرد ثم أعد المحاولة.'
          );
          return;
        }
        console.error(error);
        toast.error('تعذر الإنشاء', 'حدث خطأ أثناء حفظ الأسرة، حاول مرة أخرى.');
      }
    },
  });

  // Deep link: ?members=3 opens the form with three blocks ready.
  const preset = Math.min(10, Math.max(0, Number(params().members) || 0));
  for (let i = 0; i < preset; i += 1) addBlock();
}

/* ---- Markup -------------------------------------------------------------- */

function view(session, camps) {
  return `
    ${breadcrumb([{ label: 'الأسر', href: pageUrl('families.html') }, { label: 'إضافة أسرة' }])}
    ${pageHeader({
      title: 'إضافة أسرة',
      description: `سيتم إنشاء الأسرة وأفرادها معاً في ${session.campLabel}.`,
    })}

    ${alert({
      variant: 'info',
      title: 'رقم الأسرة يُولَّد تلقائياً',
      text: 'سيُولَّد رقم الأسرة تلقائياً عند الحفظ، ولا يمكن تعديله لاحقاً. سجّل بيانات رب الأسرة ثم أضف بقية الأفراد، واحفظ الجميع دفعة واحدة.',
    })}

    <form class="form u-mt-5" id="family-form" novalidate>
      <h2 class="card__title u-mb-4">بيانات رب الأسرة</h2>
      ${displacedFields(
        { campId: session.campId },
        { camps, lockCamp: camps.length === 1, showFamily: false }
      )}

      <fieldset class="fieldset">
        <legend class="fieldset__legend">أفراد الأسرة</legend>
        <p class="fieldset__hint">
          أضف بقية أفراد الأسرة هنا. يرث كل فرد بيانات المخيم ونوع الخيمة والنزوح من رب الأسرة،
          ويمكن استكمال باقي بياناته لاحقاً من ملفه.
        </p>

        <div class="member-list" id="member-list"></div>

        <p class="u-sm u-secondary" id="member-empty" hidden>
          لم تتم إضافة أي فرد بعد. يمكنك حفظ الأسرة برب الأسرة وحده وإضافة الأفراد لاحقاً.
        </p>

        <div class="member-add">
          ${button({
            label: 'إضافة فرد',
            variant: 'secondary',
            iconName: 'plus',
            attrs: 'data-add-member',
          })}
        </div>
      </fieldset>

      <fieldset class="fieldset">
        <legend class="fieldset__legend">ملاحظات الأسرة</legend>
        <div class="field-grid">
          ${textareaField({
            name: 'notes',
            label: 'ملاحظات',
            optional: true,
            placeholder: 'أي معلومات إضافية عن حالة الأسرة…',
          })}
        </div>
      </fieldset>

      <div class="form-actions">
        ${button({ label: 'إلغاء', variant: 'secondary', href: pageUrl('families.html') })}
        ${button({ label: 'حفظ الأسرة', variant: 'primary', iconName: 'check', type: 'submit' })}
      </div>
    </form>`;
}

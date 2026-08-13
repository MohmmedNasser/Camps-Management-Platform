/**
 * Register an aid delivery (Camp Admin only).
 *
 * Accepts `?familyId=` / `?displacedId=` so the family and aid pages can hand
 * over a pre-selected beneficiary.
 */

import { qs, esc, params, delegate } from '../utils/dom.js';
import { toInputDate } from '../utils/format.js';
import { mountShell } from '../ui/layout.js';
import { button, alert, breadcrumb, pageHeader, emptyState } from '../ui/components.js';
import { bindForm } from '../ui/form.js';
import { aidFields, aidSchema } from '../ui/record-forms.js';
import { toast } from '../ui/toast.js';
import { pageUrl, go } from '../core/router.js';
import * as store from '../core/store.js';
import * as select from '../core/selectors.js';

const shell = mountShell({ active: 'aid.html', title: 'إضافة مساعدة' });
if (shell) init(shell);

function init({ session, content }) {
  const query = params();
  const organizations = select.organizationOptions();
  const families = select.familyOptions(session.campId);
  const familyId = query.familyId && families.some((f) => f.value === query.familyId) ? query.familyId : '';
  const people = select.personOptions({ campId: session.campId, familyId });

  if (!families.length || !organizations.length) {
    content.innerHTML = `
      ${breadcrumb([{ label: 'المساعدات', href: pageUrl('aid.html') }, { label: 'إضافة مساعدة' }])}
      ${pageHeader({ title: 'تسجيل مساعدة' })}
      ${emptyState({
        iconName: 'aid',
        title: !families.length ? 'لا توجد أسر مسجلة' : 'لا توجد مؤسسات مانحة',
        text: !families.length
          ? 'يجب إنشاء أسرة واحدة على الأقل قبل تسجيل المساعدات.'
          : 'أضف مؤسسة مانحة واحدة على الأقل قبل تسجيل المساعدات.',
        actions: button({
          label: !families.length ? 'إضافة أسرة' : 'إدارة المؤسسات',
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
          familyId,
          displacedId: query.displacedId || '',
          date: toInputDate(new Date()),
          type: query.type || 'food',
        },
        { organizations, families, people }
      )}
      <div class="form-actions">
        ${button({ label: 'إلغاء', variant: 'secondary', href: pageUrl('aid.html') })}
        ${button({ label: 'حفظ المساعدة', variant: 'primary', iconName: 'check', type: 'submit' })}
      </div>
    </form>`;

  const form = qs('#aid-form', content);

  // The recipient list always follows the selected family.
  delegate(content, 'change', '#familyId', (event, node) => {
    const recipients = qs('#displacedId', form);
    if (!recipients) return;
    recipients.innerHTML =
      `<option value="">اختر...</option>` +
      select
        .personOptions({ campId: session.campId, familyId: node.value })
        .map((option) => `<option value="${esc(option.value)}">${esc(option.label)}</option>`)
        .join('');
  });

  bindForm(form, {
    schema: aidSchema(),
    onSubmit: (values) => {
      const family = store.families.get(values.familyId);
      const record = store.aid.create({
        ...values,
        value: Number(values.value || 0),
        campId: family ? family.campId : session.campId,
        receiptImage: '',
        createdBy: session.id,
        createdAt: new Date().toISOString(),
      });

      notifyBeneficiary(record);
      toast.success('تم الحفظ', 'تم تسجيل المساعدة في سجل الأسرة.');
      go('aid-details.html', { id: record.id });
    },
  });
}

/** The beneficiary's account, when they have one, is told about new aid. */
function notifyBeneficiary(record) {
  const user = store.users.find((row) => row.displacedId === record.displacedId);
  if (!user) return;
  store.notifications.create({
    userId: user.id,
    type: 'info',
    title: 'تمت إضافة مساعدة جديدة إلى ملفك',
    text: `${select.aidTypeLabel(record.type)} من ${select.organizationName(record.organizationId)}.`,
    createdAt: new Date().toISOString(),
    read: false,
    href: 'aid.html',
  });
}

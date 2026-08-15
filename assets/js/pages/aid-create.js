/**
 * Register an aid delivery (Camp Admin only).
 *
 * Accepts `?familyId=` / `?displacedId=` so the family and aid pages can hand
 * over a pre-selected beneficiary.
 */

import { qs, params } from '../utils/dom.js';
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
          familyId,
          date: toInputDate(new Date()),
          type: query.type || 'food',
        },
        { organizations, families }
      )}
      <div class="form-actions">
        ${button({ label: 'إلغاء', variant: 'secondary', href: pageUrl('aid.html') })}
        ${button({ label: 'حفظ المساعدة', variant: 'primary', iconName: 'check', type: 'submit' })}
      </div>
    </form>`;

  const form = qs('#aid-form', content);

  bindForm(form, {
    schema: aidSchema(),
    onSubmit: (values) => {
      const family = store.families.get(values.familyId);
      const record = store.aid.create({
        type: values.type,
        organizationId: values.organizationId,
        familyId: values.familyId,
        campId: family ? family.campId : session.campId,
        date: values.date,
        quantity: (values.quantity || '').trim(),
        description: values.description.trim(),
        createdBy: session.id,
        createdAt: new Date().toISOString(),
      });

      notifyFamily(record);
      toast.success('تم الحفظ', 'تم تسجيل المساعدة في سجل الأسرة.');
      go('aid-details.html', { id: record.id });
    },
  });
}

/**
 * Aid belongs to the family, so every account attached to a member of that
 * family is told about it — not one nominated recipient.
 */
function notifyFamily(record) {
  const memberIds = new Set(select.familyMembers(record.familyId).map((member) => member.id));
  store.users
    .list((row) => row.displacedId && memberIds.has(row.displacedId))
    .forEach((user) => {
      store.notifications.create({
        userId: user.id,
        type: 'info',
        title: 'تمت إضافة مساعدة جديدة لأسرتك',
        text: `${select.aidTypeLabel(record.type)} من ${select.organizationName(record.organizationId)}.`,
        createdAt: new Date().toISOString(),
        read: false,
        href: 'aid.html',
      });
    });
}

/**
 * One registration request, with the approve / reject decision.
 *
 * The duplicate check is shown before the decision, scoped to what RLS
 * lets this Camp Admin see (their own camp only) — a cross-camp duplicate
 * is still caught by the database's global unique index at approval time.
 * Camp-Admin-only page (PAGE_ACCESS) — no mock branch.
 */

import { esc, params, delegate } from '../utils/dom.js';
import { formatDate, formatDateTime, formatPhone, formatRelative } from '../utils/format.js';
import { mountShell } from '../ui/layout.js';
import {
  button,
  card,
  alert,
  statusBadge,
  avatar,
  emptyState,
  errorState,
  skeletonProfile,
  pageHeader,
  breadcrumb,
  definition,
  definitionList,
} from '../ui/components.js';
import { formDialog } from '../ui/modal.js';
import { textareaField, selectField, inputField } from '../ui/form.js';
import { rules } from '../utils/validators.js';
import { toast } from '../ui/toast.js';
import { pageUrl, go } from '../core/router.js';
import * as store from '../core/store.js';
import { STATUS, GENDERS } from '../core/config.js';
import {
  getRegistrationRequest,
  findOwnCampDuplicate,
  approveRegistrationRequest,
  rejectRegistrationRequest,
} from '../supabase/registration-requests.js';
import { getFamilyMember } from '../supabase/family-members.js';

const shell = await mountShell({ active: 'registration-requests.html', title: 'تفاصيل طلب التسجيل' });
if (shell) init(shell);

async function init({ session, content }) {
  const { id } = params();
  content.innerHTML = skeletonProfile();

  try {
    const data = await store.load(() => collect(session, id));

    if (!data.request) {
      content.innerHTML = emptyState({
        iconName: 'alertTriangle',
        title: 'الطلب غير موجود',
        text: 'قد يكون محذوفاً أو خارج نطاق صلاحياتك.',
        actions: button({ label: 'العودة إلى الطلبات', variant: 'primary', href: pageUrl('registration-requests.html') }),
      });
      return;
    }

    content.innerHTML = view(data);
    wire(content, session, data);
  } catch (error) {
    console.error(error);
    content.innerHTML = errorState({ retryAttrs: 'data-retry' });
    delegate(content, 'click', '[data-retry]', () => init({ session, content }));
  }
}

async function collect(session, id) {
  const request = await getRegistrationRequest(id, session.campLabel);
  if (!request) return { request: null };

  const duplicate = await findOwnCampDuplicate(request.nationalId, session.campId);
  // Visible only once approved — the account's profile.camp_id is null
  // until then, so RLS hides it from this Camp Admin beforehand (spec §2).
  const account =
    request.status === STATUS.APPROVED && request.displacedId
      ? await getFamilyMember(request.displacedId)
      : null;

  return { request, duplicate, account };
}

function view({ request, duplicate, account }) {
  const pending = request.status === STATUS.PENDING;

  return `
    ${breadcrumb([
      { label: 'طلبات التسجيل', href: pageUrl('registration-requests.html') },
      { label: request.fullName },
    ])}
    ${pageHeader({
      title: request.fullName,
      description: `تم استلام الطلب ${formatRelative(request.createdAt)} — ${formatDate(request.createdAt)}`,
      actions: pending
        ? `
          ${button({ label: 'رفض', variant: 'danger', iconName: 'xCircle', attrs: 'data-reject' })}
          ${button({ label: 'قبول الطلب', variant: 'primary', iconName: 'checkCircle', attrs: 'data-approve' })}`
        : '',
    })}

    ${
      duplicate
        ? alert({
            variant: 'error',
            title: 'رقم الهوية مسجّل مسبقاً في مخيمك',
            text: `هذا الرقم مسجّل باسم "${duplicate.full_name}" في مخيمك الحالي. لا يمكن تسجيل الشخص نفسه مرتين.`,
          })
        : pending
          ? alert({
              variant: 'success',
              title: 'لا يوجد تسجيل مكرر في مخيمك',
              text: 'رقم الهوية غير مسجّل في مخيمك الحالي. قد يظهر تعارض عند القبول إذا كان مسجلاً في مخيم آخر.',
            })
          : ''
    }

    <div class="split u-mt-5">
      <div class="stack">
        ${card({
          title: 'بيانات مقدم الطلب',
          body: definitionList([
            definition('الاسم الكامل', request.fullName),
            definition('رقم الهوية', request.nationalId, { mono: true }),
            definition('رقم الجوال', formatPhone(request.phone), { mono: true }),
            definition('البريد الإلكتروني', request.email),
            definition('المخيم المطلوب', request.campName),
            definition('تاريخ تقديم الطلب', formatDateTime(request.createdAt)),
          ]),
        })}

        ${
          request.status !== STATUS.PENDING
            ? card({
                title: 'قرار المراجعة',
                body: definitionList([
                  definition('القرار', request.status === STATUS.APPROVED ? 'مقبول' : 'مرفوض'),
                  definition('تمت المراجعة بواسطة', request.reviewerName || '—'),
                  definition('تاريخ المراجعة', formatDateTime(request.reviewedAt)),
                  definition('السبب / الملاحظات', request.note),
                ]),
                foot:
                  request.status === STATUS.APPROVED && request.displacedId
                    ? button({ label: 'فتح ملف النازح', variant: 'secondary', iconName: 'user', href: pageUrl('displaced-details.html', { id: request.displacedId }) })
                    : '',
              })
            : card({
                title: 'ماذا يحدث عند القبول؟',
                body: `
                  <ul class="u-sm u-secondary" style="display:grid;gap:var(--space-2);padding-inline-start:var(--space-5);list-style:disc">
                    <li>يتم إنشاء سجل نازح باسم مقدم الطلب في المخيم.</li>
                    <li>يتم فتح أسرة جديدة برقم تلقائي ويصبح مقدم الطلب رب الأسرة.</li>
                    <li>يتم تفعيل حسابه ليتمكن من استكمال بياناته ومتابعة مساعداته.</li>
                    <li>يصله إشعار بالقرار داخل المنصة.</li>
                  </ul>`,
              })
        }
      </div>

      <aside class="split__aside stack">
        ${card({
          title: 'حالة الطلب',
          body: `
            <div class="u-flex u-gap-3 u-center u-mb-4">
              ${avatar(request.fullName, { size: 'lg' })}
              <div style="min-width:0">
                <div class="u-medium u-truncate">${esc(request.fullName)}</div>
                <div class="u-xs u-muted mono">${esc(request.nationalId)}</div>
              </div>
            </div>
            <div class="row u-gap-2 u-wrap">
              ${statusBadge(request.status)}
              <span class="chip chip--outline">${esc(request.campName)}</span>
            </div>`,
        })}

        ${card({
          title: 'الحساب المرتبط',
          body: account
            ? definitionList([
                definition('الاسم', account.full_name),
                definition('حالة الحساب', 'مفعّل'),
              ])
            : `<p class="u-sm u-secondary">لا يوجد حساب مرتبط ظاهر من هنا.</p>`,
        })}
      </aside>
    </div>`;
}

function wire(content, session, { request, duplicate }) {
  delegate(content, 'click', '[data-approve]', async () => {
    if (duplicate) {
      toast.error('تعذر القبول', `رقم الهوية مسجّل مسبقاً في مخيمك باسم "${duplicate.full_name}".`);
      return;
    }

    const values = await formDialog({
      title: 'قبول طلب التسجيل',
      description: `سيتم إنشاء سجل نازح وأسرة جديدة باسم "${request.fullName}" وتفعيل حسابه.`,
      fields:
        selectField({ name: 'gender', label: 'الجنس', options: GENDERS, required: true }) +
        inputField({ name: 'birthDate', label: 'تاريخ الميلاد', type: 'date', required: true }),
      submitLabel: 'قبول الطلب',
      validate: (input) => {
        const errors = {};
        const genderError = rules.required('الجنس')(input.gender);
        if (genderError) errors.gender = genderError;
        const dateError = rules.required('تاريخ الميلاد')(input.birthDate) || rules.pastDate('تاريخ الميلاد')(input.birthDate);
        if (dateError) errors.birthDate = dateError;
        return errors;
      },
    });
    if (!values) return;

    try {
      const memberId = await approveRegistrationRequest(request.id, { gender: values.gender, birthDate: values.birthDate });
      toast.success('تم القبول', 'تم إنشاء الأسرة وتفعيل الحساب.');
      go('displaced-details.html', { id: memberId });
    } catch (error) {
      console.error(error);
      toast.error('تعذر القبول', error.message || 'حدث خطأ غير متوقع.');
    }
  });

  delegate(content, 'click', '[data-reject]', async () => {
    const values = await formDialog({
      title: 'رفض طلب التسجيل',
      description: `سيتم إشعار "${request.fullName}" بالقرار وبالسبب المذكور.`,
      fields: textareaField({ name: 'note', label: 'سبب الرفض', required: true, rows: 4, placeholder: 'مثال: رقم الهوية مسجّل مسبقاً في مخيم آخر.' }),
      submitLabel: 'رفض الطلب',
      validate: (input) => (input.note && input.note.trim().length >= 5 ? {} : { note: 'اذكر سبباً واضحاً للرفض.' }),
    });
    if (!values) return;

    try {
      await rejectRegistrationRequest(request.id, values.note.trim());
      toast.success('تم الرفض', 'تم تسجيل القرار وإشعار مقدم الطلب.');
      go('registration-requests.html');
    } catch (error) {
      console.error(error);
      toast.error('تعذر الرفض', error.message || 'حدث خطأ غير متوقع.');
    }
  });
}

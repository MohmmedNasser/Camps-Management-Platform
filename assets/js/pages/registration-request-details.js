/**
 * One registration request, with the approve / reject decision.
 *
 * The duplicate check is shown before the decision: a national ID already
 * registered anywhere is the single reason a request cannot be approved.
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
import { confirmDialog, formDialog } from '../ui/modal.js';
import { textareaField } from '../ui/form.js';
import { toast } from '../ui/toast.js';
import { pageUrl, go } from '../core/router.js';
import * as store from '../core/store.js';
import * as select from '../core/selectors.js';
import { STATUS } from '../core/config.js';

const shell = mountShell({ active: 'registration-requests.html', title: 'تفاصيل طلب التسجيل' });
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
        actions: button({
          label: 'العودة إلى الطلبات',
          variant: 'primary',
          href: pageUrl('registration-requests.html'),
        }),
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

function collect(session, id) {
  const raw = store.registrationRequests.get(id);
  if (!raw || raw.campId !== session.campId) return { request: null };

  const request = select.requestRow(raw);
  const duplicate = store.displaced.find((person) => person.nationalId === raw.nationalId);

  return {
    request,
    duplicate,
    duplicateCamp: duplicate ? select.campName(duplicate.campId) : '',
    account: store.users.find((user) => user.requestId === raw.id || user.email === raw.email),
  };
}

function view({ request, duplicate, duplicateCamp, account }) {
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
            title: 'رقم الهوية مسجّل مسبقاً',
            text: `هذا الرقم مسجّل باسم "${duplicate.fullName}" في ${duplicateCamp}. لا يمكن تسجيل الشخص نفسه في أكثر من مخيم.`,
          })
        : pending
          ? alert({
              variant: 'success',
              title: 'لا يوجد تسجيل مكرر',
              text: 'رقم الهوية غير مسجّل في أي مخيم آخر، ويمكن قبول الطلب.',
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
                  definition('تمت المراجعة بواسطة', request.reviewerName),
                  definition('تاريخ المراجعة', formatDateTime(request.reviewedAt)),
                  definition('السبب / الملاحظات', request.note),
                ]),
                foot:
                  request.status === STATUS.APPROVED && request.displacedId
                    ? button({
                        label: 'فتح ملف النازح',
                        variant: 'secondary',
                        iconName: 'user',
                        href: pageUrl('displaced-details.html', { id: request.displacedId }),
                      })
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
                definition('البريد الإلكتروني', account.email),
                definition('حالة الحساب', account.status === STATUS.APPROVED ? 'مفعّل' : 'قيد المراجعة'),
                definition('تاريخ الإنشاء', formatDate(account.createdAt)),
              ])
            : `<p class="u-sm u-secondary">لا يوجد حساب مرتبط بهذا الطلب.</p>`,
        })}
      </aside>
    </div>`;
}

function wire(content, session, { request, duplicate, duplicateCamp }) {
  delegate(content, 'click', '[data-approve]', async () => {
    if (duplicate) {
      toast.error('تعذر القبول', `رقم الهوية مسجّل مسبقاً في ${duplicateCamp}.`);
      return;
    }

    const ok = await confirmDialog({
      title: 'قبول طلب التسجيل',
      text: `سيتم إنشاء سجل نازح وأسرة جديدة باسم "${request.fullName}" وتفعيل حسابه.`,
      confirmLabel: 'قبول الطلب',
      variant: 'default',
    });
    if (!ok) return;

    const result = select.approveRequest(request.id, session.id);
    if (!result) {
      toast.error('تعذر القبول', 'تمت مراجعة هذا الطلب مسبقاً.');
      return;
    }
    toast.success('تم القبول', `تم إنشاء الأسرة ${result.familyId}.`);
    go('displaced-details.html', { id: result.person.id });
  });

  delegate(content, 'click', '[data-reject]', async () => {
    const values = await formDialog({
      title: 'رفض طلب التسجيل',
      description: `سيتم إشعار "${request.fullName}" بالقرار وبالسبب المذكور.`,
      fields: textareaField({
        name: 'note',
        label: 'سبب الرفض',
        required: true,
        rows: 4,
        placeholder: 'مثال: رقم الهوية مسجّل مسبقاً في مخيم آخر.',
      }),
      submitLabel: 'رفض الطلب',
      validate: (input) =>
        input.note && input.note.trim().length >= 5 ? {} : { note: 'اذكر سبباً واضحاً للرفض.' },
    });

    if (!values) return;
    select.rejectRequest(request.id, session.id, values.note.trim());
    toast.success('تم الرفض', 'تم تسجيل القرار وإشعار مقدم الطلب.');
    go('registration-requests.html');
  });
}

/**
 * Write a message to the camp administration.
 *
 * Sending is a displaced-person action (`message:send`); administrators reply
 * from a message rather than starting a thread, so they see a pointer instead
 * of a form. Fully real — the camp's admin(s) are notified server-side by the
 * `messages_notify_on_change` trigger (Phase 4.19), since a displaced user's
 * browser has no INSERT permission on `notifications`.
 */

import { qs, params } from '../utils/dom.js';
import { mountShell } from '../ui/layout.js';
import { button, card, alert, emptyState, pageHeader, breadcrumb } from '../ui/components.js';
import { bindForm } from '../ui/form.js';
import { messageFields, messageSchema } from '../ui/record-forms.js';
import { toast } from '../ui/toast.js';
import { pageUrl, go } from '../core/router.js';
import { can } from '../core/auth.js';
import { createMessage } from '../supabase/messages.js';

const shell = await mountShell({ active: 'messages.html', title: 'رسالة جديدة' });
if (shell) init(shell);

function init({ session, content }) {
  if (!can('message:send')) {
    content.innerHTML = `
      ${breadcrumb([{ label: 'الرسائل', href: pageUrl('messages.html') }, { label: 'رسالة جديدة' }])}
      ${pageHeader({ title: 'رسالة جديدة' })}
      ${emptyState({
        iconName: 'message',
        title: 'الرد يتم من داخل الرسالة',
        text: 'إنشاء الرسائل متاح للنازحين. بصفتك مسؤولاً، افتح الرسالة الواردة وأرسل ردك من داخلها.',
        actions: button({
          label: 'الرسائل الواردة',
          variant: 'primary',
          iconName: 'message',
          href: pageUrl('messages.html'),
        }),
      })}`;
    return;
  }

  content.innerHTML = `
    ${breadcrumb([{ label: 'رسائلي', href: pageUrl('messages.html') }, { label: 'رسالة جديدة' }])}
    ${pageHeader({
      title: 'رسالة جديدة',
      description: `ستصل رسالتك إلى إدارة ${session.campLabel}.`,
    })}
    ${alert({
      variant: 'info',
      title: 'قبل الإرسال',
      text: 'اذكر التفاصيل بوضوح (رقم الأسرة، التواريخ، نوع المساعدة) ليتمكن المسؤول من متابعة طلبك بسرعة.',
    })}

    <div class="u-mt-5">
      ${card({
        body: `
          <form class="form" id="message-form" novalidate autocomplete="off">
            ${messageFields({ subject: params().subject || '' })}
            <div class="form-actions">
              ${button({ label: 'إلغاء', variant: 'secondary', href: pageUrl('messages.html') })}
              ${button({ label: 'إرسال الرسالة', variant: 'primary', iconName: 'send', type: 'submit' })}
            </div>
          </form>`,
      })}
    </div>`;

  const form = qs('#message-form', content);

  bindForm(form, {
    schema: messageSchema(),
    onSubmit: async (values) => {
      try {
        const message = await createMessage({
          campId: session.campId,
          subject: values.subject,
          body: values.body.trim(),
        });
        toast.success('تم الإرسال', 'وصلت رسالتك إلى إدارة المخيم.');
        go('message-details.html', { id: message.id });
      } catch (error) {
        console.error(error);
        toast.error('تعذر الإرسال', error.message || 'حدث خطأ غير متوقع، حاول مرة أخرى.');
      }
    },
  });
}

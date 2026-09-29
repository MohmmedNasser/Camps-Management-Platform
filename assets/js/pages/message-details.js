/**
 * One message thread.
 *
 * Opening an unread message marks it read for the administration. The reply
 * box only appears for roles allowed to reply. Fully real — replying notifies
 * the sender server-side via the `messages_notify_on_change` trigger (Phase
 * 4.19), since a browser has no INSERT permission on `notifications`.
 */

import { esc, qs, params, delegate } from '../utils/dom.js';
import { formatDateTime, formatRelative, formatPhone } from '../utils/format.js';
import { mountShell } from '../ui/layout.js';
import {
  button,
  card,
  badge,
  avatar,
  alert,
  emptyState,
  errorState,
  skeletonForm,
  pageHeader,
  breadcrumb,
  definition,
  definitionList,
} from '../ui/components.js';
import { textareaField, bindForm } from '../ui/form.js';
import { toast } from '../ui/toast.js';
import { pageUrl } from '../core/router.js';
import { can } from '../core/auth.js';
import * as store from '../core/store.js';
import {
  getMessage,
  markMessageRead,
  replyToMessage,
  getCampMessages,
  getAllMessages,
  getOwnMessages,
} from '../supabase/messages.js';
import { getDisplacedPerson } from '../supabase/family-members.js';
import { getCamp } from '../supabase/camps.js';
import { ROLES, MESSAGE_SUBJECTS, labelOf } from '../core/config.js';
import { rules } from '../utils/validators.js';

const STATUS_VARIANTS = { unread: 'warning', read: 'neutral', replied: 'success' };
const STATUS_LABELS = { unread: 'غير مقروءة', read: 'مقروءة', replied: 'تم الرد' };

const shell = await mountShell({ active: 'messages.html', title: 'تفاصيل الرسالة' });
if (shell) init(shell);

async function init({ session, content }) {
  const { id } = params();
  content.innerHTML = skeletonForm(4);

  try {
    const data = await store.load(() => collect(session, id));

    if (!data.message) {
      content.innerHTML = emptyState({
        iconName: 'alertTriangle',
        title: 'الرسالة غير موجودة',
        text: 'قد تكون محذوفة أو خارج نطاق صلاحياتك.',
        actions: button({ label: 'العودة إلى الرسائل', variant: 'primary', href: pageUrl('messages.html') }),
      });
      return;
    }

    content.innerHTML = view(session, data);
    wire(content, session, data);
  } catch (error) {
    console.error(error);
    content.innerHTML = errorState({ retryAttrs: 'data-retry' });
    delegate(content, 'click', '[data-retry]', () => init({ session, content }));
  }
}

async function collect(session, id) {
  const message = await getMessage(id);
  if (!message) return { message: null };

  // Reading an incoming message is what marks it read.
  if (message.status === 'unread' && session.role !== ROLES.DISPLACED) {
    await markMessageRead(message.id);
    message.status = 'read';
  }

  const isOwn = session.role === ROLES.DISPLACED;
  const scopeRows = isOwn
    ? getOwnMessages()
    : session.role === ROLES.SUPER_ADMIN
      ? getAllMessages()
      : getCampMessages(session.campId);

  const [camp, person, history] = await Promise.all([
    getCamp(message.campId),
    !isOwn && message.senderFamilyMemberId ? getDisplacedPerson(message.senderFamilyMemberId) : null,
    scopeRows.then((rows) => rows.filter((row) => row.senderId === message.senderId && row.id !== message.id).slice(0, 5)),
  ]);

  return { message, camp, person, history };
}

function bubble({ author, initialsFor, time, body, tone = '' }) {
  return `
    <div class="u-flex u-gap-3 ${tone}" style="align-items:flex-start">
      ${avatar(initialsFor, { size: 'sm' })}
      <div class="u-grow" style="min-width:0">
        <div class="row row--between u-gap-2">
          <span class="u-medium u-sm">${esc(author)}</span>
          <span class="u-xs u-muted">${esc(time)}</span>
        </div>
        <p class="u-mt-2" style="white-space:pre-wrap;line-height:1.8">${esc(body)}</p>
      </div>
    </div>`;
}

function view(session, { message, camp, person, history }) {
  const isOwn = session.role === ROLES.DISPLACED;
  const subjectLabel = labelOf(MESSAGE_SUBJECTS, message.subject);
  const campLabel = camp ? camp.name : '—';

  return `
    ${breadcrumb([
      { label: 'الرسائل', href: pageUrl('messages.html') },
      { label: subjectLabel },
    ])}
    ${pageHeader({
      title: subjectLabel,
      description: `${isOwn ? 'أرسلتها' : `من ${message.senderName}`} ${formatRelative(
        message.createdAt
      )} · ${formatDateTime(message.createdAt)}`,
      actions: button({
        label: 'العودة إلى الرسائل',
        variant: 'secondary',
        iconName: 'chevronRight',
        href: pageUrl('messages.html'),
      }),
    })}

    <div class="split">
      <div class="stack">
        ${card({
          title: 'الرسالة',
          action: badge(STATUS_LABELS[message.status] || message.status, STATUS_VARIANTS[message.status] || 'neutral'),
          body: `
            ${bubble({
              author: isOwn ? 'أنت' : message.senderName,
              initialsFor: message.senderName,
              time: formatDateTime(message.createdAt),
              body: message.body,
            })}
            ${
              message.reply
                ? `<div class="divider"></div>
                   ${bubble({
                     author: 'إدارة المخيم',
                     initialsFor: 'إدارة المخيم',
                     time: formatDateTime(message.repliedAt || message.createdAt),
                     body: message.reply,
                   })}`
                : ''
            }`,
        })}

        ${
          can('message:reply')
            ? card({
                title: message.reply ? 'تعديل الرد' : 'الرد على الرسالة',
                body: `
                  <form class="form" id="reply-form" novalidate autocomplete="off">
                    ${textareaField({
                      name: 'reply',
                      label: 'نص الرد',
                      value: message.reply || '',
                      required: true,
                      rows: 5,
                      placeholder: 'اكتب رداً واضحاً ومختصراً…',
                    })}
                    <div class="form-actions">
                      ${button({ label: 'إرسال الرد', variant: 'primary', iconName: 'send', type: 'submit' })}
                    </div>
                  </form>`,
              })
            : message.reply
              ? ''
              : alert({
                  variant: 'info',
                  title: 'بانتظار الرد',
                  text: 'ستصلك إشعار عند رد إدارة المخيم على رسالتك.',
                })
        }

        ${
          history.length
            ? card({
                title: isOwn ? 'رسائلك السابقة' : `رسائل سابقة من ${message.senderName}`,
                flush: true,
                body: `<div class="list">${history
                  .map(
                    (row) => `
                  <a class="list__row" href="${pageUrl('message-details.html', { id: row.id })}">
                    <span class="list__main">
                      <span class="list__title">${esc(labelOf(MESSAGE_SUBJECTS, row.subject))}</span>
                      <span class="list__meta">${esc(formatRelative(row.createdAt))}</span>
                    </span>
                    <span class="list__side">${badge(
                      STATUS_LABELS[row.status] || row.status,
                      STATUS_VARIANTS[row.status] || 'neutral'
                    )}</span>
                  </a>`
                  )
                  .join('')}</div>`,
              })
            : ''
        }
      </div>

      <aside class="split__aside stack">
        ${card({
          title: isOwn ? 'الجهة المستقبِلة' : 'المُرسِل',
          body: isOwn
            ? definitionList([
                definition('الجهة', 'إدارة المخيم'),
                definition('المخيم', campLabel),
                definition('تاريخ الإرسال', formatDateTime(message.createdAt)),
              ])
            : definitionList([
                definition('الاسم', message.senderName),
                definition('البريد الإلكتروني', person ? person.email : ''),
                definition('رقم الجوال', person ? formatPhone(person.phone) : '', { mono: true }),
                definition('رقم الهوية', person ? person.nationalId : '', { mono: true }),
                definition('رقم الأسرة', person ? person.familyLabel : '', { mono: true }),
                definition('المخيم', campLabel),
              ]),
          foot:
            !isOwn && person
              ? button({
                  label: 'فتح ملف النازح',
                  variant: 'secondary',
                  iconName: 'user',
                  href: pageUrl('displaced-details.html', { id: person.id }),
                  block: true,
                })
              : '',
        })}
      </aside>
    </div>`;
}

function wire(content, session, { message }) {
  const form = qs('#reply-form', content);
  if (!form) return;

  bindForm(form, {
    schema: { reply: [rules.required('نص الرد'), rules.minLength(5, 'نص الرد')] },
    onSubmit: async (values) => {
      try {
        await replyToMessage(message.id, values.reply.trim());
        toast.success('تم الإرسال', 'تم إرسال الرد إلى مقدم الرسالة.');
        init({ session, content });
      } catch (error) {
        console.error(error);
        toast.error('تعذر الإرسال', error.message || 'حدث خطأ غير متوقع، حاول مرة أخرى.');
      }
    },
  });
}

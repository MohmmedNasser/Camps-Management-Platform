/**
 * Messages.
 *
 * A displaced person writes to the camp administration and reads the replies;
 * an administrator reads the camp's inbox and replies. Sending a new message
 * is a displaced-only action (`message:send`), replying an admin one.
 */

import { esc, qs, delegate, params, setParams } from '../utils/dom.js';
import { formatDateTime, formatRelative, truncate } from '../utils/format.js';
import { mountShell } from '../ui/layout.js';
import {
  button,
  badge,
  card,
  emptyState,
  errorState,
  skeletonTable,
  pageHeader,
  avatar,
} from '../ui/components.js';
import { toolbar, initToolbar, filterChips } from '../ui/toolbar.js';
import { icon } from '../ui/icons.js';
import { pageUrl } from '../core/router.js';
import { can } from '../core/auth.js';
import * as store from '../core/store.js';
import * as select from '../core/selectors.js';
import { ROLES, MESSAGE_SUBJECTS } from '../core/config.js';

const STATUS_VARIANTS = { unread: 'warning', read: 'neutral', replied: 'success' };
const STATUS_LABELS = { unread: 'غير مقروءة', read: 'مقروءة', replied: 'تم الرد' };

const state = { q: '', status: '', subject: '' };

const shell = mountShell({ active: 'messages.html', title: 'الرسائل' });
if (shell) init(shell);

function init({ session, content }) {
  const query = params();
  state.q = query.q || '';
  state.status = query.status || '';
  state.subject = query.subject || '';

  const isOwn = session.role === ROLES.DISPLACED;

  content.innerHTML = `
    ${pageHeader({
      title: isOwn ? 'رسائلي' : 'الرسائل الواردة',
      description: isOwn
        ? 'رسائلك إلى إدارة المخيم وردودها عليك.'
        : `الرسائل الواردة من نازحي ${session.campLabel}.`,
      actions: can('message:send')
        ? button({
            label: 'رسالة جديدة',
            variant: 'primary',
            iconName: 'send',
            href: pageUrl('message-compose.html'),
          })
        : '',
    })}
    <div id="chips" class="u-mb-4"></div>
    ${toolbar({
      searchValue: state.q,
      searchPlaceholder: 'ابحث في نص الرسائل…',
      filters: [
        { name: 'subject', label: 'الموضوع', options: MESSAGE_SUBJECTS, value: state.subject },
      ],
      activeCount: state.subject ? 1 : 0,
      modal: true,
    })}
    <div id="results">${skeletonTable(5)}</div>`;

  initToolbar(content, {
    onChange: (values) => {
      state.q = values.q ?? state.q;
      if ('subject' in values) state.subject = values.subject;
      setParams(values);
      load(session);
    },
  });

  delegate(content, 'click', '[data-chip]', (event, node) => {
    state.status = node.dataset.chip;
    setParams({ status: state.status });
    load(session);
  });

  delegate(content, 'click', '[data-clear-search]', () => {
    const search = qs('#toolbar-search', content);
    if (search) search.value = '';
    Object.assign(state, { q: '', status: '', subject: '' });
    setParams({ q: '', status: '', subject: '' });
    load(session);
  });

  load(session);
}

async function load(session) {
  const target = qs('#results');
  if (!target) return;
  target.innerHTML = skeletonTable(5);

  try {
    const [rows, counts] = await store.load(() => [
      select.searchMessages(session, { query: state.q, status: state.status, subject: state.subject }),
      select.messageCountsByStatus(session),
    ]);

    const chips = qs('#chips');
    if (chips) {
      chips.innerHTML = filterChips(
        [
          { value: '', label: 'الكل', count: counts.all },
          { value: 'unread', label: 'غير مقروءة', count: counts.unread },
          { value: 'read', label: 'مقروءة', count: counts.read },
          { value: 'replied', label: 'تم الرد', count: counts.replied },
        ],
        state.status
      );
    }

    target.innerHTML = rows.length ? listView(session, rows) : emptyView(session);
  } catch (error) {
    console.error(error);
    target.innerHTML = errorState({ retryAttrs: 'data-retry' });
    delegate(target, 'click', '[data-retry]', () => load(session));
  }
}

function listView(session, rows) {
  const isOwn = session.role === ROLES.DISPLACED;

  return card({
    flush: true,
    body: `<div class="list">${rows
      .map(
        (message) => `
      <a class="list__row" href="${pageUrl('message-details.html', { id: message.id })}">
        <span class="u-flex u-gap-3 u-grow" style="min-width:0">
          ${avatar(isOwn ? 'إدارة المخيم' : message.senderName, { size: 'sm' })}
          <span class="list__main">
            <span class="list__title">
              ${esc(message.subjectLabel)}
              ${message.status === 'unread' && !isOwn ? badge('جديدة', 'warning') : ''}
            </span>
            <span class="list__meta">${esc(
              isOwn ? truncate(message.body, 80) : `${message.senderName} · ${truncate(message.body, 60)}`
            )}</span>
            <span class="u-xs u-muted">${esc(formatRelative(message.createdAt))} · ${esc(
              formatDateTime(message.createdAt)
            )}</span>
          </span>
        </span>
        <span class="list__side">
          ${badge(STATUS_LABELS[message.status] || message.status, STATUS_VARIANTS[message.status] || 'neutral')}
          ${icon('chevronLeft', { size: 16 })}
        </span>
      </a>`
      )
      .join('')}</div>`,
  });
}

function emptyView(session) {
  if (state.q || state.status || state.subject) {
    return emptyState({
      iconName: 'search',
      title: 'لا توجد رسائل مطابقة',
      text: 'جرّب تعديل البحث أو اختيار حالة أخرى.',
      actions: button({ label: 'إعادة تعيين البحث', variant: 'secondary', attrs: 'data-clear-search' }),
    });
  }

  return session.role === ROLES.DISPLACED
    ? emptyState({
        iconName: 'message',
        title: 'لم ترسل أي رسالة بعد',
        text: 'لديك استفسار أو ملاحظة؟ أرسل رسالة إلى إدارة المخيم وسيتم الرد عليك.',
        actions: button({
          label: 'رسالة جديدة',
          variant: 'primary',
          iconName: 'send',
          href: pageUrl('message-compose.html'),
        }),
      })
    : emptyState({
        iconName: 'message',
        title: 'لا توجد رسائل واردة',
        text: 'ستظهر هنا رسائل النازحين فور إرسالها.',
      });
}

/**
 * Notifications for the signed-in account — real data for every role
 * (Phase 4.13): no per-role branch ever existed here, and the mock version
 * was equally (silently) empty for every real account regardless of role.
 * Read/unread and mark-all-read only — no cross-user visibility. Delete is
 * intentionally absent: `notifications` carries no DELETE RLS policy for
 * any role.
 */

import { esc, qs, delegate, params, setParams } from '../utils/dom.js';
import { formatDateTime, formatRelative } from '../utils/format.js';
import { mountShell } from '../ui/layout.js';
import {
  button,
  card,
  badge,
  emptyState,
  errorState,
  skeletonTable,
  pageHeader,
} from '../ui/components.js';
import { filterChips } from '../ui/toolbar.js';
import { icon } from '../ui/icons.js';
import { toast } from '../ui/toast.js';
import { pageUrl } from '../core/router.js';
import { listAllNotifications, markNotificationRead, markNotificationUnread, markAllNotificationsRead, mapNotificationRow } from '../supabase/notifications.js';

const ICONS = { success: 'checkCircle', warning: 'alertTriangle', error: 'alertCircle', info: 'info' };

const state = { filter: '' };
let currentAll = []; // last-loaded full list, for the mark-all-read no-op check

const shell = await mountShell({ active: 'notifications.html', title: 'الإشعارات' });
if (shell) init(shell);

function init({ session, content }) {
  state.filter = params().filter || '';

  content.innerHTML = `
    ${pageHeader({
      title: 'الإشعارات',
      description: 'كل ما يخص حسابك من تحديثات وقرارات.',
      // No delete/dismiss control: notifications carries no DELETE RLS
      // policy for any role (Phase 4.13 design §4.5, confirmed live) — a
      // control that always failed (or silently no-opped) would be worse
      // than no control.
      actions: button({ label: 'تعليم الكل كمقروء', variant: 'secondary', iconName: 'check', attrs: 'data-read-all' }),
    })}
    <div id="chips" class="u-mb-4"></div>
    <div id="results">${skeletonTable(5)}</div>`;

  delegate(content, 'click', '[data-chip]', (event, node) => {
    state.filter = node.dataset.chip;
    setParams({ filter: state.filter });
    load(session);
  });

  delegate(content, 'click', '[data-read]', async (event, node) => {
    try {
      await markNotificationRead(node.dataset.read);
    } catch (error) {
      toast.error('تعذر التحديث', error.message || 'حدث خطأ غير متوقع');
      return;
    }
    load(session);
  });

  delegate(content, 'click', '[data-unread]', async (event, node) => {
    try {
      await markNotificationUnread(node.dataset.unread);
    } catch (error) {
      toast.error('تعذر التحديث', error.message || 'حدث خطأ غير متوقع');
      return;
    }
    load(session);
  });

  delegate(content, 'click', '[data-read-all]', async () => {
    if (!currentAll.some((row) => !row.read)) {
      toast.info('لا توجد إشعارات جديدة');
      return;
    }
    try {
      await markAllNotificationsRead();
    } catch (error) {
      toast.error('تعذر التحديث', error.message || 'حدث خطأ غير متوقع');
      return;
    }
    toast.success('تم التحديث', 'تم تعليم كل الإشعارات كمقروءة.');
    load(session);
  });

  load(session);
}

async function load(session) {
  const target = qs('#results');
  if (!target) return;
  target.innerHTML = skeletonTable(5);

  try {
    const raw = await listAllNotifications();
    currentAll = raw.map(mapNotificationRow);
    const rows = state.filter === 'unread' ? currentAll.filter((row) => !row.read) : currentAll;

    const chips = qs('#chips');
    if (chips) {
      chips.innerHTML = filterChips(
        [
          { value: '', label: 'الكل', count: currentAll.length },
          { value: 'unread', label: 'غير مقروءة', count: currentAll.filter((row) => !row.read).length },
        ],
        state.filter
      );
    }

    target.innerHTML = rows.length ? listView(rows) : emptyView();
  } catch (error) {
    console.error(error);
    target.innerHTML = errorState({ retryAttrs: 'data-retry' });
    delegate(target, 'click', '[data-retry]', () => load(session));
  }
}

function listView(rows) {
  return card({
    flush: true,
    body: `<div class="list">${rows.map(row).join('')}</div>`,
  });
}

function row(item) {
  return `
    <div class="list__row">
      <span class="notif__icon notif__icon--${esc(item.type)}">
        ${icon(ICONS[item.type] || 'info', { size: 16 })}
      </span>
      <span class="list__main">
        <span class="list__title">
          ${esc(item.title)}
          ${item.read ? '' : badge('جديد', 'warning')}
        </span>
        <span class="list__meta">${esc(item.text)}</span>
        <span class="u-xs u-muted">${esc(formatRelative(item.createdAt))} · ${esc(
          formatDateTime(item.createdAt)
        )}</span>
      </span>
      <span class="list__side">
        ${
          item.href
            ? `<a class="btn btn--ghost btn--sm" href="${pageUrl(item.href)}">فتح</a>`
            : ''
        }
        <button type="button" class="icon-btn" title="${item.read ? 'تعليم كغير مقروء' : 'تعليم كمقروء'}"
          ${item.read ? `data-unread="${esc(item.id)}"` : `data-read="${esc(item.id)}"`}>
          ${icon(item.read ? 'eye' : 'check', { size: 16 })}
          <span class="sr-only">${item.read ? 'تعليم كغير مقروء' : 'تعليم كمقروء'}</span>
        </button>
      </span>
    </div>`;
}

function emptyView() {
  return emptyState({
    iconName: 'bell',
    title: state.filter === 'unread' ? 'لا توجد إشعارات غير مقروءة' : 'لا توجد إشعارات',
    text:
      state.filter === 'unread'
        ? 'اطلعت على كل الإشعارات الجديدة.'
        : 'ستظهر هنا الإشعارات المتعلقة بحسابك: القرارات، المساعدات الجديدة والرسائل.',
  });
}

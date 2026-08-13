/**
 * Notifications for the signed-in account.
 * Read/unread, mark-all-read and delete — no cross-user visibility.
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
import { confirmDialog } from '../ui/modal.js';
import { toast } from '../ui/toast.js';
import { pageUrl } from '../core/router.js';
import * as store from '../core/store.js';
import * as select from '../core/selectors.js';

const ICONS = { success: 'checkCircle', warning: 'alertTriangle', error: 'alertCircle', info: 'info' };

const state = { filter: '' };

const shell = mountShell({ active: 'notifications.html', title: 'الإشعارات' });
if (shell) init(shell);

function init({ session, content }) {
  state.filter = params().filter || '';

  content.innerHTML = `
    ${pageHeader({
      title: 'الإشعارات',
      description: 'كل ما يخص حسابك من تحديثات وقرارات.',
      actions: `
        ${button({ label: 'تعليم الكل كمقروء', variant: 'secondary', iconName: 'check', attrs: 'data-read-all' })}
        ${button({ label: 'حذف المقروءة', variant: 'danger', iconName: 'trash', attrs: 'data-clear-read' })}`,
    })}
    <div id="chips" class="u-mb-4"></div>
    <div id="results">${skeletonTable(5)}</div>`;

  delegate(content, 'click', '[data-chip]', (event, node) => {
    state.filter = node.dataset.chip;
    setParams({ filter: state.filter });
    load(session);
  });

  delegate(content, 'click', '[data-read]', (event, node) => {
    store.notifications.update(node.dataset.read, { read: true });
    load(session);
  });

  delegate(content, 'click', '[data-unread]', (event, node) => {
    store.notifications.update(node.dataset.unread, { read: false });
    load(session);
  });

  delegate(content, 'click', '[data-remove]', (event, node) => {
    store.notifications.remove(node.dataset.remove);
    toast.success('تم الحذف', 'تم حذف الإشعار.');
    load(session);
  });

  delegate(content, 'click', '[data-read-all]', () => {
    const unread = store.notifications.list((row) => row.userId === session.id && !row.read);
    if (!unread.length) {
      toast.info('لا توجد إشعارات جديدة');
      return;
    }
    unread.forEach((row) => store.notifications.update(row.id, { read: true }));
    toast.success('تم التحديث', 'تم تعليم كل الإشعارات كمقروءة.');
    load(session);
  });

  delegate(content, 'click', '[data-clear-read]', async () => {
    const read = store.notifications.list((row) => row.userId === session.id && row.read);
    if (!read.length) {
      toast.info('لا توجد إشعارات مقروءة');
      return;
    }
    const ok = await confirmDialog({
      title: 'حذف الإشعارات المقروءة',
      text: `سيتم حذف ${read.length} إشعاراً مقروءاً. لا يمكن التراجع عن هذه العملية.`,
      confirmLabel: 'حذف',
    });
    if (!ok) return;
    store.notifications.removeWhere((row) => row.userId === session.id && row.read);
    toast.success('تم الحذف', 'تم حذف الإشعارات المقروءة.');
    load(session);
  });

  load(session);
}

async function load(session) {
  const target = qs('#results');
  if (!target) return;
  target.innerHTML = skeletonTable(5);

  try {
    const all = await store.load(() => select.notificationsFor(session.id));
    const rows = state.filter === 'unread' ? all.filter((row) => !row.read) : all;

    const chips = qs('#chips');
    if (chips) {
      chips.innerHTML = filterChips(
        [
          { value: '', label: 'الكل', count: all.length },
          { value: 'unread', label: 'غير مقروءة', count: all.filter((row) => !row.read).length },
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
        <button type="button" class="icon-btn icon-btn--danger" title="حذف الإشعار" data-remove="${esc(item.id)}">
          ${icon('trash', { size: 16 })}
          <span class="sr-only">حذف الإشعار</span>
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

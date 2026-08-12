/**
 * Application shell.
 *
 * Every in-app page calls `mountShell()` first: it guards the route, renders
 * header + sidebar + bottom navigation for the signed-in role, and hands back
 * the container the page renders itself into.
 *
 * This is the vanilla equivalent of a Next.js `layout.tsx`.
 */

import { esc, qs, qsa, on } from '../utils/dom.js';
import { formatRelative } from '../utils/format.js';
import { icon } from './icons.js';
import { avatar } from './components.js';
import { confirmDialog } from './modal.js';
import { guard, pageUrl, currentPage, go } from '../core/router.js';
import { logout, switchRole } from '../core/auth.js';
import * as store from '../core/store.js';
import {
  notificationsFor,
  unreadNotificationCount,
  unreadMessageCount,
  pendingRequestCount,
} from '../core/selectors.js';
import { APP_SHORT, NAVIGATION, ROLE_LABELS, ROLES } from '../core/config.js';

const NOTIF_ICONS = { success: 'checkCircle', warning: 'alertTriangle', error: 'alertCircle', info: 'info' };

/* ---- Markup ------------------------------------------------------------- */

function brandMarkup(subtitle) {
  return `
    <a class="brand" href="${pageUrl('dashboard.html')}">
      <span class="brand__mark">${icon('logo', { size: 19 })}</span>
      <span class="brand__text">
        <span class="brand__name">${esc(APP_SHORT)}</span>
        <span class="brand__sub">${esc(subtitle)}</span>
      </span>
    </a>`;
}

function navItems(session, active, badges) {
  const items = NAVIGATION[session.role] || [];
  return items
    .map((item) => {
      const count = item.badge ? badges[item.badge] : 0;
      const isActive = item.href === active;
      return `
        <a class="nav-item" href="${pageUrl(item.href)}"${isActive ? ' aria-current="page"' : ''}>
          <span class="nav-item__icon">${icon(item.icon, { size: 19 })}</span>
          <span class="nav-item__label">${esc(item.label)}</span>
          ${count ? `<span class="nav-item__badge">${count}</span>` : ''}
        </a>`;
    })
    .join('');
}

function bottomNavItems(session, active, badges) {
  const items = (NAVIGATION[session.role] || []).filter((item) => item.primary).slice(0, 4);
  const links = items
    .map((item) => {
      const count = item.badge ? badges[item.badge] : 0;
      const isActive = item.href === active;
      return `
        <a class="bottom-nav__item" href="${pageUrl(item.href)}"${isActive ? ' aria-current="page"' : ''}>
          <span style="position:relative">
            ${icon(item.icon, { size: 21 })}
            ${count ? `<span class="count-badge">${count}</span>` : ''}
          </span>
          <span class="bottom-nav__label">${esc(item.label)}</span>
        </a>`;
    })
    .join('');

  return `${links}
    <button type="button" class="bottom-nav__item" data-open-drawer>
      ${icon('menu', { size: 21 })}
      <span class="bottom-nav__label">المزيد</span>
    </button>`;
}

function notificationList(rows) {
  if (!rows.length) {
    return `<p class="u-sm u-muted" style="padding:var(--space-5);text-align:center">لا توجد إشعارات</p>`;
  }
  return rows
    .slice(0, 5)
    .map(
      (row) => `
      <a class="notif" href="${pageUrl(row.href || 'notifications.html')}" data-unread="${!row.read}">
        <span class="notif__icon notif__icon--${esc(row.type)}">${icon(NOTIF_ICONS[row.type] || 'info', { size: 16 })}</span>
        <span class="notif__body">
          <span class="notif__title">${esc(row.title)}</span>
          <span class="notif__text">${esc(row.text)}</span>
          <span class="notif__time">${esc(formatRelative(row.createdAt))}</span>
        </span>
      </a>`
    )
    .join('');
}

function userMenu(session) {
  const roleSwitch = Object.values(ROLES)
    .map(
      (role) => `
      <button type="button" class="menu-item" role="menuitemradio" aria-checked="${role === session.role}" data-role="${role}">
        ${icon(role === session.role ? 'check' : 'user', { size: 16 })}
        <span>${esc(ROLE_LABELS[role])}</span>
      </button>`
    )
    .join('');

  return `
    <div class="dropdown__section">
      <div class="u-flex u-gap-3 u-center">
        ${avatar(session.name)}
        <div class="u-grow" style="min-width:0">
          <div class="u-medium u-truncate">${esc(session.name)}</div>
          <div class="u-xs u-muted u-truncate">${esc(session.email)}</div>
        </div>
      </div>
      <div class="u-mt-3 u-flex u-gap-2 u-wrap">
        <span class="chip">${esc(ROLE_LABELS[session.role])}</span>
        <span class="chip chip--outline">${esc(session.campLabel)}</span>
      </div>
    </div>
    <a class="menu-item" href="${pageUrl('profile.html')}">${icon('user', { size: 16 })}<span>الملف الشخصي</span></a>
    <a class="menu-item" href="${pageUrl('settings.html')}">${icon('settings', { size: 16 })}<span>الإعدادات</span></a>
    <div class="menu-divider"></div>
    <div class="dropdown__label">تبديل الدور (للمراجعة فقط)</div>
    ${roleSwitch}
    <div class="menu-divider"></div>
    <button type="button" class="menu-item menu-item--danger" data-logout>
      ${icon('logout', { size: 16 })}<span>تسجيل الخروج</span>
    </button>`;
}

function shellMarkup(session, active, badges, notifications, unreadCount) {
  return `
    <a class="skip-link" href="#main-content">تخطي إلى المحتوى</a>

    <aside class="app-sidebar" id="app-sidebar" aria-label="القائمة الرئيسية">
      <div class="app-sidebar__head">
        ${brandMarkup(session.campLabel)}
        <button type="button" class="app-sidebar__close" data-close-drawer aria-label="إغلاق القائمة">
          ${icon('x', { size: 20 })}
        </button>
      </div>
      <nav class="app-sidebar__nav">
        ${navItems(session, active, badges)}
      </nav>
      <div class="app-sidebar__foot">
        <a class="nav-item" href="${pageUrl('profile.html')}">
          ${avatar(session.name, { size: 'sm' })}
          <span class="nav-item__label">
            <span style="display:block" class="u-truncate">${esc(session.name)}</span>
            <span class="u-xs u-muted">${esc(ROLE_LABELS[session.role])}</span>
          </span>
        </a>
      </div>
    </aside>

    <div class="scrim" data-close-drawer></div>

    <div class="app-body">
      <header class="app-header">
        <button type="button" class="app-header__menu" data-open-drawer aria-label="فتح القائمة" aria-controls="app-sidebar">
          ${icon('menu', { size: 22 })}
        </button>

        <div class="app-header__camp">
          <span class="app-header__camp-label">${esc(session.role === ROLES.SUPER_ADMIN ? 'نطاق الإشراف' : 'المخيم')}</span>
          <span class="app-header__camp-name">${esc(session.campLabel)}</span>
        </div>

        <div class="app-header__actions">
          <div class="dropdown" data-dropdown="notifications">
            <button type="button" class="dropdown__trigger" aria-expanded="false" aria-haspopup="true" aria-label="الإشعارات">
              ${icon('bell', { size: 21 })}
              ${unreadCount ? `<span class="count-badge">${unreadCount}</span>` : ''}
            </button>
            <div class="dropdown__panel dropdown__panel--wide" role="menu">
              <div class="dropdown__header">
                <span>الإشعارات</span>
                ${unreadCount ? `<button type="button" class="btn btn--ghost btn--sm" data-read-all>تعليم الكل كمقروء</button>` : ''}
              </div>
              <div>${notificationList(notifications)}</div>
              <div class="dropdown__footer">
                <a class="btn btn--secondary btn--sm btn--block" href="${pageUrl('notifications.html')}">عرض كل الإشعارات</a>
              </div>
            </div>
          </div>

          <div class="dropdown" data-dropdown="user">
            <button type="button" class="dropdown__trigger" aria-expanded="false" aria-haspopup="true" aria-label="قائمة الحساب">
              ${avatar(session.name, { size: 'sm' })}
            </button>
            <div class="dropdown__panel" role="menu">${userMenu(session)}</div>
          </div>
        </div>
      </header>

      <main class="app-main" id="main-content" tabindex="-1">
        <div class="container page" id="page-content"></div>
      </main>
    </div>

    <nav class="bottom-nav" aria-label="التنقل السريع">
      ${bottomNavItems(session, active, badges)}
    </nav>`;
}

/* ---- Behaviour ---------------------------------------------------------- */

function wireDrawer() {
  const sidebar = qs('#app-sidebar');
  const scrim = qs('.scrim');
  if (!sidebar) return;

  const setOpen = (open) => {
    sidebar.dataset.open = String(open);
    if (scrim) scrim.dataset.open = String(open);
    document.body.classList.toggle('is-locked', open && window.innerWidth < 1024);
    if (open) qs('.app-sidebar__nav .nav-item')?.focus();
  };

  qsa('[data-open-drawer]').forEach((node) => on(node, 'click', () => setOpen(true)));
  qsa('[data-close-drawer]').forEach((node) => on(node, 'click', () => setOpen(false)));
  on(document, 'keydown', (event) => {
    if (event.key === 'Escape' && sidebar.dataset.open === 'true') setOpen(false);
  });
  on(window, 'resize', () => {
    if (window.innerWidth >= 1024) setOpen(false);
  });
}

function wireDropdowns() {
  const dropdowns = qsa('[data-dropdown]');

  const closeAll = (except) => {
    dropdowns.forEach((dropdown) => {
      if (dropdown === except) return;
      dropdown.querySelector('.dropdown__panel').dataset.open = 'false';
      dropdown.querySelector('.dropdown__trigger').setAttribute('aria-expanded', 'false');
    });
  };

  dropdowns.forEach((dropdown) => {
    const trigger = dropdown.querySelector('.dropdown__trigger');
    const panel = dropdown.querySelector('.dropdown__panel');

    on(trigger, 'click', (event) => {
      event.stopPropagation();
      const open = panel.dataset.open !== 'true';
      closeAll(dropdown);
      panel.dataset.open = String(open);
      trigger.setAttribute('aria-expanded', String(open));
    });
  });

  on(document, 'click', () => closeAll());
  on(document, 'keydown', (event) => {
    if (event.key === 'Escape') closeAll();
  });
  qsa('.dropdown__panel').forEach((panel) =>
    on(panel, 'click', (event) => event.stopPropagation())
  );
}

function wireUserMenu(session) {
  qsa('[data-role]').forEach((node) =>
    on(node, 'click', () => {
      const role = node.dataset.role;
      if (role === session.role) return;
      if (switchRole(role)) window.location.href = pageUrl('dashboard.html');
    })
  );

  const logoutBtn = qs('[data-logout]');
  if (logoutBtn) {
    on(logoutBtn, 'click', async () => {
      const ok = await confirmDialog({
        title: 'تسجيل الخروج',
        text: 'هل تريد تسجيل الخروج من حسابك؟',
        confirmLabel: 'تسجيل الخروج',
      });
      if (!ok) return;
      logout();
      window.location.href = pageUrl('login.html');
    });
  }

  const readAll = qs('[data-read-all]');
  if (readAll) {
    on(readAll, 'click', () => {
      store.notifications
        .list((row) => row.userId === session.id && !row.read)
        .forEach((row) => store.notifications.update(row.id, { read: true }));
      window.location.reload();
    });
  }
}

/* ---- Public API ---------------------------------------------------------- */

/**
 * Guard the route and render the shell.
 * @param {{active?: string, title?: string}} options
 * @returns {{session: object, content: HTMLElement}|null} null when redirected
 */
export function mountShell({ active = currentPage(), title = '' } = {}) {
  const session = guard();
  if (!session) return null;

  const badges = {
    pendingRequests: pendingRequestCount(session),
    unreadMessages: unreadMessageCount(session),
  };
  const notifications = notificationsFor(session.id);
  const unread = unreadNotificationCount(session.id);

  document.body.innerHTML = shellMarkup(session, active, badges, notifications, unread);

  wireDrawer();
  wireDropdowns();
  wireUserMenu(session);

  if (title) document.title = `${title} · ${APP_SHORT}`;

  return { session, content: qs('#page-content') };
}

export { go, pageUrl };

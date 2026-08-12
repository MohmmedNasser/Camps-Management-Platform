/**
 * "Account awaiting approval" screen.
 * Explains exactly who is reviewing the request and what happens next.
 */

import { qs, on, ready, esc } from '../utils/dom.js';
import { formatDate } from '../utils/format.js';
import { statusLayout } from '../ui/auth-layout.js';
import { button, statusBadge, definitionList, definition } from '../ui/components.js';
import { getSession, logout } from '../core/auth.js';
import { homeFor } from '../core/router.js';
import { campName } from '../core/selectors.js';
import { STATUS } from '../core/config.js';

ready(() => {
  const session = getSession();

  if (!session) {
    window.location.replace('login.html');
    return;
  }
  if (session.status !== STATUS.PENDING) {
    window.location.replace(homeFor(session));
    return;
  }

  render(session);
});

function render(session) {
  const details = definitionList([
    definition('الاسم', session.name),
    definition('البريد الإلكتروني', session.email),
    definition('المخيم', campName(session.campId)),
    definition('تاريخ تقديم الطلب', formatDate(session.createdAt)),
  ]);

  document.body.innerHTML = statusLayout({
    iconName: 'clock',
    tone: 'warning',
    title: 'طلبك قيد المراجعة',
    text: 'تم استلام طلب تسجيلك بنجاح. سيقوم مسؤول المخيم بمراجعة بياناتك واعتماد الحساب، وستصلك رسالة عند اتخاذ القرار.',
    extra: `
      <div class="u-mt-5" style="text-align:start">
        <div class="row u-mb-4" style="justify-content:center">
          ${statusBadge(STATUS.PENDING)}
        </div>
        <div class="card">
          <div class="card__body">${details}</div>
        </div>
        <p class="u-sm u-muted u-mt-4 u-text-center">
          مدة المراجعة المعتادة من يوم إلى ثلاثة أيام عمل.
        </p>
      </div>`,
    actions: `
      ${button({ label: 'تحديث الحالة', variant: 'secondary', iconName: 'refresh', attrs: 'data-refresh' })}
      ${button({ label: 'تسجيل الخروج', variant: 'ghost', iconName: 'logout', attrs: 'data-logout' })}`,
  });

  document.title = 'طلبك قيد المراجعة · إدارة المخيمات';

  on(qs('[data-refresh]'), 'click', () => window.location.reload());
  on(qs('[data-logout]'), 'click', () => {
    logout();
    window.location.href = 'login.html';
  });
}

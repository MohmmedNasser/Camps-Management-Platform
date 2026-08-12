/**
 * "Registration rejected" screen. Always shows the reason recorded by the
 * camp admin so the applicant knows what to correct.
 */

import { qs, on, ready } from '../utils/dom.js';
import { formatDate } from '../utils/format.js';
import { statusLayout } from '../ui/auth-layout.js';
import { button, statusBadge, alert, definitionList, definition } from '../ui/components.js';
import { getSession, logout } from '../core/auth.js';
import { homeFor } from '../core/router.js';
import { campName } from '../core/selectors.js';
import * as store from '../core/store.js';
import { STATUS } from '../core/config.js';

ready(() => {
  const session = getSession();

  if (!session) {
    window.location.replace('login.html');
    return;
  }
  if (session.status !== STATUS.REJECTED) {
    window.location.replace(homeFor(session));
    return;
  }

  render(session);
});

function render(session) {
  const request =
    (session.requestId && store.registrationRequests.get(session.requestId)) ||
    store.registrationRequests.find((row) => row.email === session.email);

  const reason = (request && request.note) || 'لم يتم تسجيل سبب محدد. يرجى مراجعة إدارة المخيم.';

  document.body.innerHTML = statusLayout({
    iconName: 'xCircle',
    tone: 'error',
    title: 'تم رفض طلب التسجيل',
    text: 'راجعت إدارة المخيم طلبك ولم تتم الموافقة عليه. يمكنك تصحيح البيانات والتقدم بطلب جديد.',
    extra: `
      <div class="u-mt-5" style="text-align:start">
        <div class="row u-mb-4" style="justify-content:center">${statusBadge(STATUS.REJECTED)}</div>
        ${alert({ variant: 'error', title: 'سبب الرفض', text: reason })}
        <div class="card u-mt-4">
          <div class="card__body">
            ${definitionList([
              definition('الاسم', session.name),
              definition('المخيم', campName(session.campId)),
              definition('تاريخ الطلب', formatDate(request ? request.createdAt : session.createdAt)),
              definition('تاريخ المراجعة', request && request.reviewedAt ? formatDate(request.reviewedAt) : '—'),
            ])}
          </div>
        </div>
      </div>`,
    actions: `
      ${button({ label: 'تقديم طلب جديد', variant: 'primary', href: 'register.html', attrs: 'data-restart' })}
      ${button({ label: 'تسجيل الخروج', variant: 'ghost', iconName: 'logout', attrs: 'data-logout' })}`,
  });

  document.title = 'تم رفض طلب التسجيل · إدارة المخيمات';

  // A new application starts from a signed-out state.
  on(qs('[data-restart]'), 'click', () => logout());
  on(qs('[data-logout]'), 'click', (event) => {
    event.preventDefault();
    logout();
    window.location.href = 'login.html';
  });
}

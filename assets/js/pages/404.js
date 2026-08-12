/**
 * Not-found / no-access screen.
 * Also the landing point when a role opens a page it is not allowed to see,
 * so the copy covers both cases without exposing what the page was.
 */

import { ready } from '../utils/dom.js';
import { statusLayout } from '../ui/auth-layout.js';
import { button } from '../ui/components.js';
import { getSession } from '../core/auth.js';
import { homeFor } from '../core/router.js';

ready(() => {
  const session = getSession();
  const home = homeFor(session);

  document.body.innerHTML = statusLayout({
    iconName: 'alertTriangle',
    tone: 'neutral',
    title: 'الصفحة غير متاحة',
    text: session
      ? 'الصفحة التي تحاول فتحها غير موجودة أو أنها خارج صلاحيات حسابك.'
      : 'الصفحة التي تحاول فتحها غير موجودة. يرجى تسجيل الدخول للمتابعة.',
    actions: `
      ${button({ label: session ? 'العودة إلى الرئيسية' : 'تسجيل الدخول', variant: 'primary', href: home })}
      ${button({ label: 'الرجوع للخلف', variant: 'secondary', attrs: 'onclick="history.back()"' })}`,
  });

  document.title = 'الصفحة غير متاحة · إدارة المخيمات';
});

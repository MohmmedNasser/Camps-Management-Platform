/**
 * "Account has no usable profile" screen — the fail-closed landing point
 * when a real, authenticated Supabase user has no `profiles` row or an
 * unrecognized role. Never guesses a role or grants access; the only
 * recovery offered is signing out.
 */

import { qs, on, ready } from '../utils/dom.js';
import { statusLayout } from '../ui/auth-layout.js';
import { button } from '../ui/components.js';
import { logout } from '../core/auth.js';

ready(() => {
  document.body.classList.remove('app-loading');
  document.body.innerHTML = statusLayout({
    iconName: 'alertCircle',
    tone: 'error',
    title: 'تعذر تحميل بيانات حسابك',
    text: 'حسابك موثّق لكن لا توجد بيانات ملف تعريف صالحة له. يرجى التواصل مع إدارة النظام لمراجعة الحساب.',
    actions: `
      ${button({ label: 'تسجيل الخروج', variant: 'primary', iconName: 'logout', attrs: 'data-logout' })}`,
  });

  document.title = 'تعذر الوصول · إدارة المخيمات';

  on(qs('[data-logout]'), 'click', async () => {
    await logout();
    window.location.href = 'login.html';
  });
});

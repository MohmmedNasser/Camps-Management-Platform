/**
 * Forgot password (prototype). Shows the confirmation state that the real
 * flow will show once an email is actually sent.
 */

import { qs, ready, esc } from '../utils/dom.js';
import { rules } from '../utils/validators.js';
import { authLayout } from '../ui/auth-layout.js';
import { inputField, bindForm } from '../ui/form.js';
import { button, alert } from '../ui/components.js';
import { guestOnly } from '../core/router.js';

if (!guestOnly()) {
  ready(render);
}

function render() {
  document.body.innerHTML = authLayout({
    title: 'استعادة كلمة المرور',
    subtitle: 'أدخل بريدك الإلكتروني وسنرسل لك رابط إعادة التعيين.',
    asideTitle: 'استعادة الوصول إلى حسابك',
    asideText: 'إذا لم يصلك البريد خلال دقائق، تواصل مع إدارة المخيم لإعادة ضبط كلمة المرور يدوياً.',
    body: `
      <div class="card" id="forgot-card">
        <div class="card__body">
          <form class="form" id="forgot-form" novalidate>
            ${inputField({
              name: 'email',
              label: 'البريد الإلكتروني',
              type: 'email',
              required: true,
              iconName: 'mail',
              placeholder: 'name@example.ps',
              autocomplete: 'email',
              full: true,
            })}
            ${button({ label: 'إرسال رابط الاستعادة', variant: 'primary', size: 'lg', block: true, type: 'submit' })}
          </form>
        </div>
      </div>`,
    foot: `<a href="login.html">العودة إلى تسجيل الدخول</a>`,
  });

  document.title = 'استعادة كلمة المرور · إدارة المخيمات';

  const form = qs('#forgot-form');

  bindForm(form, {
    schema: { email: [rules.required('البريد الإلكتروني'), rules.email()] },
    onSubmit: (values) => {
      qs('#forgot-card').innerHTML = `
        <div class="card__body u-text-center">
          <span class="status-icon status-icon--success">
            <svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>
            </svg>
          </span>
          <h2 class="u-mt-4" style="font-size:var(--fs-h3)">تحقق من بريدك الإلكتروني</h2>
          <p class="u-mt-3 u-secondary">
            أرسلنا رابط إعادة تعيين كلمة المرور إلى
            <span class="mono">${esc(values.email)}</span>.
          </p>
          <div class="u-mt-5">
            ${button({ label: 'العودة إلى تسجيل الدخول', variant: 'secondary', href: 'login.html', block: true })}
          </div>
        </div>`;
    },
  });
}

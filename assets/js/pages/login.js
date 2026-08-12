/**
 * Login screen (prototype — no real authentication).
 * Offers one-click demo accounts so a reviewer can move between the three
 * roles without typing credentials.
 */

import { qs, qsa, on, esc, ready } from '../utils/dom.js';
import { rules } from '../utils/validators.js';
import { authLayout } from '../ui/auth-layout.js';
import { inputField, passwordField, checkboxField, bindForm, setFieldError } from '../ui/form.js';
import { button, alert } from '../ui/components.js';
import { icon } from '../ui/icons.js';
import { toast } from '../ui/toast.js';
import { login } from '../core/auth.js';
import { guestOnly, homeFor } from '../core/router.js';
import { demoAccounts } from '../data/mock-data.js';
import { ROLE_LABELS } from '../core/config.js';

if (!guestOnly()) {
  ready(render);
}

function demoList() {
  return demoAccounts
    .map(
      (account) => `
      <button type="button" class="list__row" data-demo="${esc(account.email)}">
        <span class="list__main">
          <span class="list__title">${esc(ROLE_LABELS[account.role])}</span>
          <span class="list__meta">${esc(account.hint)} · <span class="mono">${esc(account.email)}</span></span>
        </span>
        <span class="list__side">${icon('arrowLeft', { size: 16 })}</span>
      </button>`
    )
    .join('');
}

function render() {
  document.body.innerHTML = authLayout({
    title: 'تسجيل الدخول',
    subtitle: 'أدخل بيانات حسابك للوصول إلى لوحة التحكم.',
    body: `
      <div class="card">
        <div class="card__body">
          <div id="login-error" class="u-mb-4 u-hidden"></div>
          <form class="form" id="login-form" novalidate>
            ${inputField({
              name: 'email',
              label: 'البريد الإلكتروني',
              type: 'email',
              placeholder: 'name@example.ps',
              required: true,
              iconName: 'mail',
              autocomplete: 'email',
              full: true,
            })}
            ${passwordField({
              name: 'password',
              label: 'كلمة المرور',
              required: true,
              autocomplete: 'current-password',
              full: true,
            })}
            <div class="row row--between" style="margin-top:calc(var(--space-3) * -1)">
              ${checkboxField({ name: 'remember', label: 'تذكرني', checked: true, full: false })}
              <a href="forgot-password.html" class="u-sm">نسيت كلمة المرور؟</a>
            </div>
            ${button({ label: 'تسجيل الدخول', variant: 'primary', size: 'lg', block: true, type: 'submit' })}
          </form>
        </div>
      </div>

      <div class="card u-mt-5">
        <div class="card__head">
          <h2 class="card__title" style="font-size:var(--fs-body)">حسابات تجريبية</h2>
          <span class="chip">للمراجعة</span>
        </div>
        <div class="card__body card__body--flush">
          <div class="list">${demoList()}</div>
        </div>
      </div>`,
    foot: `ليس لديك حساب؟ <a href="register.html">إنشاء حساب جديد</a>`,
  });

  document.title = 'تسجيل الدخول · إدارة المخيمات';

  const form = qs('#login-form');
  const errorSlot = qs('#login-error');

  const showError = (message) => {
    errorSlot.innerHTML = alert({ variant: 'error', title: 'تعذر تسجيل الدخول', text: message });
    errorSlot.classList.remove('u-hidden');
  };

  const signIn = (email, password) => {
    const result = login(email, password);
    if (!result.ok) {
      showError(result.error);
      setFieldError(form, 'email', ' ');
      return;
    }
    errorSlot.classList.add('u-hidden');
    toast.success('مرحباً بك', `تم تسجيل الدخول باسم ${result.user.name}`);
    setTimeout(() => {
      window.location.href = homeFor(result.user);
    }, 350);
  };

  bindForm(form, {
    schema: {
      email: [rules.required('البريد الإلكتروني'), rules.email()],
      password: [rules.required('كلمة المرور')],
    },
    onSubmit: (values) => signIn(values.email, values.password),
  });

  qsa('[data-demo]').forEach((node) =>
    on(node, 'click', () => {
      qs('#email').value = node.dataset.demo;
      qs('#password').value = '123456';
      signIn(node.dataset.demo, '123456');
    })
  );
}

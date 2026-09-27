/**
 * Family account activation (Phase 4.17).
 *
 * Reached only via the one-time link a Camp Admin generates from
 * family-details.html — never linked to from inside the app shell, so this
 * page carries no `mountShell()`/`guard()` and no `PAGE_ACCESS` entry: the
 * head of family has no session at all when they open it, by design (same
 * reasoning as login.html/register.html).
 */

import { qs, params, ready } from '../utils/dom.js';
import { rules } from '../utils/validators.js';
import { authLayout } from '../ui/auth-layout.js';
import { inputField, passwordField, bindForm, setFieldError } from '../ui/form.js';
import { button, alert } from '../ui/components.js';
import { toast } from '../ui/toast.js';
import { activateFamilyAccount } from '../supabase/family-activation.js';
import { login, ProfileError } from '../core/auth.js';
import { homeFor } from '../core/router.js';

ready(render);

function render() {
  const { token } = params();

  document.body.classList.remove('app-loading');

  if (!token) {
    document.body.innerHTML = authLayout({
      title: 'رابط التفعيل غير صالح',
      body: `<div class="card"><div class="card__body">
        ${alert({
          variant: 'error',
          title: 'رابط غير مكتمل',
          text: 'هذا الرابط لا يحتوي على رمز تفعيل. تواصل مع إدارة المخيم للحصول على رابط تفعيل جديد.',
        })}
      </div></div>`,
      foot: `لديك حساب بالفعل؟ <a href="login.html">تسجيل الدخول</a>`,
    });
    document.title = 'رابط التفعيل غير صالح · إدارة المخيمات';
    return;
  }

  document.body.innerHTML = authLayout({
    title: 'تفعيل حساب الأسرة',
    subtitle: 'أدخل بيانات رب الأسرة كما هي مسجلة لدى إدارة المخيم، ثم اختر كلمة مرور لتسجيل الدخول لاحقاً.',
    body: `
      <div class="card">
        <div class="card__body">
          <div id="activate-error" class="u-mb-4 u-hidden"></div>
          <form class="form" id="activate-form" novalidate>
            ${inputField({
              name: 'referenceCode',
              label: 'رقم الأسرة',
              placeholder: 'FAM-000001',
              required: true,
              mono: true,
              full: true,
              hint: 'كما هو مسجل لدى إدارة المخيم.',
            })}
            ${inputField({
              name: 'nationalId',
              label: 'رقم هوية رب الأسرة',
              required: true,
              mono: true,
              inputMode: 'numeric',
              placeholder: '9 أرقام',
              full: true,
              attrs: 'maxlength="9"',
            })}
            ${inputField({
              name: 'birthDate',
              label: 'تاريخ ميلاد رب الأسرة',
              type: 'date',
              required: true,
              full: true,
            })}
            ${inputField({
              name: 'email',
              label: 'البريد الإلكتروني لتسجيل الدخول',
              type: 'email',
              placeholder: 'name@example.ps',
              required: true,
              autocomplete: 'email',
              full: true,
              hint: 'سيُستخدم لتسجيل الدخول لاحقاً فقط — لن يُرسل إليه أي بريد.',
            })}
            ${passwordField({ name: 'password', label: 'كلمة المرور', required: true, autocomplete: 'new-password', hint: '6 أحرف على الأقل.', full: true })}
            ${passwordField({ name: 'passwordConfirm', label: 'تأكيد كلمة المرور', required: true, autocomplete: 'new-password', full: true })}
            ${button({ label: 'تفعيل الحساب', variant: 'primary', size: 'lg', block: true, type: 'submit' })}
          </form>
        </div>
      </div>`,
    foot: `لديك حساب بالفعل؟ <a href="login.html">تسجيل الدخول</a>`,
  });

  document.title = 'تفعيل حساب الأسرة · إدارة المخيمات';

  const form = qs('#activate-form');
  const errorSlot = qs('#activate-error');

  const showError = ({ title = 'تعذر تفعيل الحساب', text, showLogin = false }) => {
    errorSlot.innerHTML = alert({
      variant: 'error',
      title,
      text: showLogin ? `${text} <a href="login.html">تسجيل الدخول</a>` : text,
    });
    errorSlot.classList.remove('u-hidden');
    errorSlot.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  bindForm(form, {
    schema: {
      referenceCode: [rules.required('رقم الأسرة'), rules.custom((v) => /^FAM-\d{6,}$/i.test(String(v).trim()), 'صيغة رقم الأسرة غير صحيحة.')],
      nationalId: [rules.required('رقم الهوية'), rules.nationalId()],
      birthDate: [rules.required('تاريخ الميلاد'), rules.pastDate('تاريخ الميلاد')],
      email: [rules.required('البريد الإلكتروني'), rules.email()],
      password: [rules.required('كلمة المرور'), rules.password(6)],
      passwordConfirm: [
        rules.required('تأكيد كلمة المرور'),
        rules.matches('password', 'كلمتا المرور غير متطابقتين.'),
      ],
    },
    onSubmit: async (values) => {
      errorSlot.classList.add('u-hidden');
      try {
        await activateFamilyAccount({
          token,
          referenceCode: values.referenceCode.trim().toUpperCase(),
          nationalId: values.nationalId.trim(),
          birthDate: values.birthDate,
          email: values.email.trim(),
          password: values.password,
        });
      } catch (error) {
        if (error?.type === 'already_activated') {
          showError({ title: 'الحساب مفعّل بالفعل', text: error.message, showLogin: true });
          return;
        }
        showError({ text: error?.message || 'حدث خطأ غير متوقع، حاول مرة أخرى.' });
        setFieldError(form, 'referenceCode', ' ');
        return;
      }

      let session;
      try {
        const result = await login(values.email.trim(), values.password);
        if (!result.ok) {
          toast.success('تم تفعيل الحساب', 'يمكنك الآن تسجيل الدخول.');
          window.location.href = 'login.html';
          return;
        }
        session = result.user;
      } catch (error) {
        if (error instanceof ProfileError) {
          window.location.href = 'auth-error.html';
          return;
        }
        toast.success('تم تفعيل الحساب', 'يمكنك الآن تسجيل الدخول.');
        window.location.href = 'login.html';
        return;
      }

      toast.success('تم تفعيل الحساب', `مرحباً بك ${session.name}`);
      setTimeout(() => {
        window.location.href = homeFor(session);
      }, 350);
    },
  });
}

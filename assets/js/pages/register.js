/**
 * Registration for displaced people (prototype).
 *
 * Enforces the core domain rule in the UI: one national ID cannot be
 * registered in more than one camp. The rule is stated up front, checked as
 * the user types, and checked again on submit by core/auth.register.
 */

import { qs, ready } from '../utils/dom.js';
import { rules } from '../utils/validators.js';
import { authLayout } from '../ui/auth-layout.js';
import { inputField, selectField, passwordField, checkboxField, bindForm, setFieldError } from '../ui/form.js';
import { button, alert } from '../ui/components.js';
import { toast } from '../ui/toast.js';
import { register } from '../core/auth.js';
import { guestOnly } from '../core/router.js';
import * as store from '../core/store.js';
import { nationalIdTaken, campOfNationalId } from '../core/selectors.js';
import { STATUS } from '../core/config.js';

if (!guestOnly()) {
  ready(render);
}

function campOptions() {
  return store.camps
    .list((camp) => camp.status === STATUS.ACTIVE)
    .map((camp) => ({ value: camp.id, label: `${camp.name} — ${camp.city}` }));
}

function render() {
  document.body.innerHTML = authLayout({
    title: 'إنشاء حساب جديد',
    subtitle: 'أدخل بياناتك الأساسية، وسيقوم مسؤول المخيم بمراجعة طلبك.',
    asideTitle: 'سجّل مرة واحدة، وتابع ملفك بسهولة',
    asideText: 'بعد اعتماد طلبك من إدارة المخيم ستتمكن من استكمال بياناتك ورفع مستنداتك ومتابعة المساعدات التي استلمتها أسرتك.',
    body: `
      <div class="card">
        <div class="card__body">
          ${alert({
            variant: 'warning',
            title: 'تنبيه مهم',
            text: 'لا يمكن التسجيل في أكثر من مخيم باستخدام نفس رقم الهوية.',
          })}

          <div id="register-error" class="u-mt-4 u-hidden"></div>

          <form class="form u-mt-5" id="register-form" novalidate>
            <div class="field-grid">
              ${inputField({
                name: 'fullName',
                label: 'الاسم الكامل',
                placeholder: 'الاسم الرباعي كما في الهوية',
                required: true,
                autocomplete: 'name',
                full: true,
              })}
              ${inputField({
                name: 'nationalId',
                label: 'رقم الهوية',
                required: true,
                mono: true,
                inputMode: 'numeric',
                placeholder: '9 أرقام',
                hint: 'رقم الهوية هو المعرّف الوحيد لمنع التسجيل المكرر.',
                attrs: 'maxlength="9"',
              })}
              ${inputField({
                name: 'phone',
                label: 'رقم الجوال',
                type: 'tel',
                required: true,
                mono: true,
                inputMode: 'tel',
                placeholder: '05xxxxxxxx',
                autocomplete: 'tel',
                attrs: 'maxlength="10"',
              })}
              ${inputField({
                name: 'email',
                label: 'البريد الإلكتروني',
                type: 'email',
                required: true,
                autocomplete: 'email',
                placeholder: 'name@example.ps',
                full: true,
              })}
              ${selectField({
                name: 'campId',
                label: 'المخيم',
                options: campOptions(),
                required: true,
                placeholder: 'اختر المخيم',
                full: true,
              })}
              ${passwordField({ name: 'password', label: 'كلمة المرور', required: true, autocomplete: 'new-password', hint: '6 أحرف على الأقل.' })}
              ${passwordField({ name: 'passwordConfirm', label: 'تأكيد كلمة المرور', required: true, autocomplete: 'new-password' })}
            </div>

            ${checkboxField({
              name: 'terms',
              label: 'أقرّ بصحة البيانات المدخلة',
              description: 'وأوافق على استخدامها لأغراض إدارة المخيم وتوزيع المساعدات.',
            })}

            ${button({ label: 'إنشاء الحساب', variant: 'primary', size: 'lg', block: true, type: 'submit' })}
          </form>
        </div>
      </div>`,
    foot: `لديك حساب بالفعل؟ <a href="login.html">تسجيل الدخول</a>`,
  });

  document.title = 'إنشاء حساب · إدارة المخيمات';

  const form = qs('#register-form');
  const errorSlot = qs('#register-error');

  bindForm(form, {
    schema: {
      fullName: [rules.required('الاسم الكامل'), rules.minLength(6, 'الاسم الكامل')],
      nationalId: [
        rules.required('رقم الهوية'),
        rules.nationalId(),
        rules.custom(
          (value) => !nationalIdTaken(value),
          'رقم الهوية مسجّل مسبقاً. لا يمكن التسجيل في أكثر من مخيم باستخدام نفس رقم الهوية.'
        ),
      ],
      phone: [rules.required('رقم الجوال'), rules.phone('رقم الجوال')],
      email: [rules.required('البريد الإلكتروني'), rules.email()],
      campId: [rules.required('المخيم')],
      password: [rules.required('كلمة المرور'), rules.password(6)],
      passwordConfirm: [
        rules.required('تأكيد كلمة المرور'),
        rules.matches('password', 'كلمتا المرور غير متطابقتين.'),
      ],
      terms: [rules.checked('يجب الإقرار بصحة البيانات للمتابعة.')],
    },
    onSubmit: (values) => {
      const result = register(values);

      if (!result.ok) {
        const camp = campOfNationalId(values.nationalId);
        errorSlot.innerHTML = alert({
          variant: 'error',
          title: 'تعذر إنشاء الحساب',
          text: camp && result.field === 'nationalId'
            ? `رقم الهوية مسجّل مسبقاً في ${camp}. لا يمكن التسجيل في أكثر من مخيم باستخدام نفس رقم الهوية.`
            : result.error,
        });
        errorSlot.classList.remove('u-hidden');
        setFieldError(form, result.field, result.error);
        errorSlot.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }

      toast.success('تم إرسال الطلب', 'طلبك قيد المراجعة من إدارة المخيم.');
      setTimeout(() => {
        window.location.href = 'pending.html';
      }, 400);
    },
  });
}

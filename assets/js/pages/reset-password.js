/**
 * Set a new password after following the emailed reset link. Deliberately not
 * guestOnly(): opening the link creates a recovery session, which is exactly
 * what authorises the change.
 */

import { qs, ready } from '../utils/dom.js';
import { rules } from '../utils/validators.js';
import { authLayout } from '../ui/auth-layout.js';
import { passwordField, bindForm } from '../ui/form.js';
import { button, alert } from '../ui/components.js';
import { toast } from '../ui/toast.js';
import { pageUrl } from '../core/router.js';
import { updatePassword, signOut, waitForRecoverySession } from '../supabase/auth.js';

ready(render);

async function render() {
  const session = await waitForRecoverySession();
  document.body.classList.remove('app-loading');

  if (!session) {
    document.body.innerHTML = authLayout({
      title: 'الرابط غير صالح',
      subtitle: 'انتهت صلاحية رابط الاستعادة أو تم استخدامه مسبقاً.',
      asideTitle: 'استعادة الوصول إلى حسابك',
      asideText: 'اطلب رابطاً جديداً وافتحه من نفس المتصفح.',
      body: `<div class="card"><div class="card__body">
        ${button({ label: 'طلب رابط جديد', variant: 'primary', size: 'lg', block: true, href: pageUrl('forgot-password.html') })}
      </div></div>`,
      foot: `<a href="${pageUrl('login.html')}">العودة إلى تسجيل الدخول</a>`,
    });
    return;
  }

  document.body.innerHTML = authLayout({
    title: 'تعيين كلمة مرور جديدة',
    subtitle: 'اختر كلمة مرور جديدة لحسابك.',
    asideTitle: 'استعادة الوصول إلى حسابك',
    asideText: 'بعد الحفظ سيُطلب منك تسجيل الدخول بكلمة المرور الجديدة.',
    body: `
      <div class="card"><div class="card__body">
        <div id="reset-error" class="u-mb-4 u-hidden"></div>
        <form class="form" id="reset-form" novalidate autocomplete="off">
          ${passwordField({ name: 'password', label: 'كلمة المرور الجديدة', required: true, hint: '6 أحرف على الأقل.' })}
          ${passwordField({ name: 'passwordConfirm', label: 'تأكيد كلمة المرور', required: true })}
          ${button({ label: 'حفظ كلمة المرور', variant: 'primary', size: 'lg', block: true, type: 'submit' })}
        </form>
      </div></div>`,
    foot: '',
  });
  document.title = 'تعيين كلمة مرور جديدة · إدارة المخيمات';

  const errorSlot = qs('#reset-error');
  bindForm(qs('#reset-form'), {
    schema: {
      password: [rules.required('كلمة المرور'), rules.password(6)],
      passwordConfirm: [
        rules.required('تأكيد كلمة المرور'),
        rules.matches('password', 'كلمتا المرور غير متطابقتين.'),
      ],
    },
    onSubmit: async (values) => {
      try {
        await updatePassword(values.password);
        await signOut();
      } catch (error) {
        errorSlot.innerHTML = alert({ variant: 'error', title: 'تعذر حفظ كلمة المرور', text: error.message });
        errorSlot.classList.remove('u-hidden');
        return;
      }
      toast.success('تم التحديث', 'سجّل الدخول بكلمة المرور الجديدة.');
      setTimeout(() => { window.location.href = pageUrl('login.html'); }, 600);
    },
  });
}

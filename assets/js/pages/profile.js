/**
 * The signed-in account's own profile.
 *
 * Everyone can maintain their own contact details and password. A displaced
 * person sees their camp file here too, but read-only: updating a displaced
 * record is Camp Admin work (`displaced:update`), so the page offers a data
 * update request instead of an edit form.
 */

import { esc, qs, delegate } from '../utils/dom.js';
import {
  formatDate,
  formatAge,
  formatPhone,
  formatNumber,
  formatCurrency,
} from '../utils/format.js';
import { mountShell } from '../ui/layout.js';
import {
  button,
  card,
  alert,
  avatar,
  badge,
  statusBadge,
  emptyState,
  errorState,
  skeletonProfile,
  pageHeader,
  definition,
  definitionList,
} from '../ui/components.js';
import { inputField, passwordField, bindForm, setFieldError } from '../ui/form.js';
import { toast } from '../ui/toast.js';
import { pageUrl } from '../core/router.js';
import { rules } from '../utils/validators.js';
import * as store from '../core/store.js';
import * as select from '../core/selectors.js';
import {
  ROLES,
  ROLE_LABELS,
  labelOf,
  GENDERS,
  MARITAL_STATUSES,
  TENT_TYPES,
  WORK_STATUSES,
  GOVERNORATES,
} from '../core/config.js';

const shell = mountShell({ active: 'profile.html', title: 'الملف الشخصي' });
if (shell) init(shell);

async function init({ session, content }) {
  content.innerHTML = skeletonProfile();

  try {
    const data = await store.load(() => collect(session));
    content.innerHTML = view(session, data);
    wire(content, session, data);
  } catch (error) {
    console.error(error);
    content.innerHTML = errorState({ retryAttrs: 'data-retry' });
    delegate(content, 'click', '[data-retry]', () => init({ session, content }));
  }
}

function collect(session) {
  const person = session.displacedId ? store.displaced.get(session.displacedId) : null;
  return {
    user: store.users.get(session.id),
    person,
    family: person && person.familyId ? select.familyWithStats(person.familyId) : null,
    aidCount: person ? select.aidForPerson(person.id).length : 0,
    documentCount: person ? store.documents.count((row) => row.displacedId === person.id) : 0,
  };
}

/** Which of the fields the camp needs are actually filled in. */
function completion(person) {
  if (!person) return 0;
  const checks = [
    person.fullName,
    person.nationalId,
    person.phone,
    person.birthDate,
    person.gender,
    person.maritalStatus,
    person.campId,
    person.originGovernorate,
    person.displacementDate,
    person.workStatus,
  ];
  return Math.round((checks.filter(Boolean).length / checks.length) * 100);
}

/* ---- View ------------------------------------------------------------------ */

function view(session, { user, person, family, aidCount, documentCount }) {
  const isDisplaced = session.role === ROLES.DISPLACED;
  const filled = completion(person);

  return `
    ${pageHeader({
      title: 'الملف الشخصي',
      description: 'بيانات حسابك على المنصة وإعدادات الدخول.',
    })}

    <div class="split">
      <div class="stack">
        ${card({
          title: 'بيانات الحساب',
          body: `
            <form class="form" id="account-form" novalidate>
              <div class="field-grid">
                ${inputField({ name: 'name', label: 'الاسم الكامل', value: user.name, required: true, full: true })}
                ${inputField({
                  name: 'email',
                  label: 'البريد الإلكتروني',
                  type: 'email',
                  value: user.email,
                  required: true,
                })}
                ${inputField({
                  name: 'phone',
                  label: 'رقم الجوال',
                  type: 'tel',
                  value: user.phone,
                  required: true,
                  mono: true,
                  inputMode: 'tel',
                  attrs: 'maxlength="10"',
                })}
              </div>
              <div class="form-actions">
                ${button({ label: 'حفظ البيانات', variant: 'primary', iconName: 'check', type: 'submit' })}
              </div>
            </form>`,
        })}

        ${card({
          title: 'تغيير كلمة المرور',
          body: `
            <form class="form" id="password-form" novalidate>
              <div class="field-grid">
                ${passwordField({ name: 'currentPassword', label: 'كلمة المرور الحالية', required: true, full: true })}
                ${passwordField({
                  name: 'newPassword',
                  label: 'كلمة المرور الجديدة',
                  required: true,
                  autocomplete: 'new-password',
                  hint: '6 أحرف على الأقل.',
                })}
                ${passwordField({
                  name: 'confirmPassword',
                  label: 'تأكيد كلمة المرور',
                  required: true,
                  autocomplete: 'new-password',
                })}
              </div>
              <div class="form-actions">
                ${button({ label: 'تحديث كلمة المرور', variant: 'primary', iconName: 'lock', type: 'submit' })}
              </div>
            </form>`,
        })}

        ${isDisplaced ? campFileCard(person, family) : ''}
      </div>

      <aside class="split__aside stack">
        ${card({
          body: `
            <div class="u-text-center">
              <div style="display:flex;justify-content:center">${avatar(user.name, { size: 'xl' })}</div>
              <h2 class="card__title u-mt-4">${esc(user.name)}</h2>
              <p class="u-sm u-secondary u-mt-1">${esc(user.email)}</p>
              <div class="row u-gap-2 u-wrap u-mt-4" style="justify-content:center">
                <span class="chip">${esc(ROLE_LABELS[session.role])}</span>
                <span class="chip chip--outline">${esc(session.campLabel)}</span>
                ${statusBadge(user.status)}
              </div>
            </div>`,
          foot: `<p class="u-xs u-muted u-text-center">عضو منذ ${esc(formatDate(user.createdAt))}</p>`,
        })}

        ${
          isDisplaced && person
            ? card({
                title: 'اكتمال الملف',
                body: `
                  <div class="row row--between u-mb-3">
                    <span class="u-sm u-secondary">نسبة اكتمال بياناتك</span>
                    <span class="mono u-bold">${filled}%</span>
                  </div>
                  <div class="progress u-mb-4"><div class="progress__bar" style="width:${filled}%"></div></div>
                  <dl class="definitions">
                    ${definition('المساعدات المستلمة', formatNumber(aidCount))}
                    ${definition('المستندات المرفوعة', formatNumber(documentCount))}
                    ${definition('عدد أفراد الأسرة', family ? formatNumber(family.membersCount) : '—')}
                  </dl>`,
                foot: button({
                  label: 'طلب تحديث البيانات',
                  variant: 'secondary',
                  iconName: 'send',
                  href: pageUrl('message-compose.html', { subject: 'data_update' }),
                  block: true,
                }),
              })
            : ''
        }
      </aside>
    </div>`;
}

function campFileCard(person, family) {
  if (!person) {
    return card({
      title: 'ملفي في المخيم',
      body: emptyState({
        iconName: 'user',
        title: 'لم يتم إنشاء سجل النازح الخاص بك بعد',
        text: 'بعد اعتماد طلبك من إدارة المخيم سيظهر ملفك هنا.',
      }),
    });
  }

  return card({
    title: 'ملفي في المخيم',
    action: badge('للاطلاع فقط', 'neutral'),
    body: `
      ${alert({
        variant: 'info',
        title: 'تعديل البيانات',
        text: 'تُحدَّث بيانات سجل النازح من قبل إدارة المخيم. أرسل طلب تحديث بيانات وسيتم تعديلها.',
      })}
      <div class="u-mt-4">
        ${definitionList([
          definition('الاسم الكامل', person.fullName),
          definition('رقم الهوية', person.nationalId, { mono: true }),
          definition('تاريخ الميلاد', formatDate(person.birthDate)),
          definition('العمر', formatAge(person.birthDate)),
          definition('الجنس', labelOf(GENDERS, person.gender)),
          definition('الحالة الاجتماعية', labelOf(MARITAL_STATUSES, person.maritalStatus)),
          definition('رقم الجوال', formatPhone(person.phone), { mono: true }),
          definition('رقم الأسرة', person.familyId, { mono: true }),
          definition('رب الأسرة', family ? family.headName : '—'),
          definition('نوع الخيمة', labelOf(TENT_TYPES, person.tentType)),
          definition('محافظة النزوح الأصلية', labelOf(GOVERNORATES, person.originGovernorate)),
          definition('تاريخ النزوح', formatDate(person.displacementDate)),
          definition('الأمراض المزمنة', person.chronicDiseases),
          definition('الإعاقة', person.disability),
          definition('حالة العمل', labelOf(WORK_STATUSES, person.workStatus)),
          definition('الدخل الشهري', formatCurrency(person.monthlyIncome)),
        ])}
      </div>`,
    foot: family
      ? button({
          label: 'ملف أسرتي',
          variant: 'secondary',
          iconName: 'family',
          href: pageUrl('family-details.html', { id: family.id }),
        })
      : '',
  });
}

/* ---- Behaviour ------------------------------------------------------------- */

function wire(content, session, { user }) {
  const accountForm = qs('#account-form', content);
  bindForm(accountForm, {
    schema: {
      name: [rules.required('الاسم الكامل'), rules.minLength(5, 'الاسم الكامل')],
      email: [rules.required('البريد الإلكتروني'), rules.email()],
      phone: [rules.required('رقم الجوال'), rules.phone('رقم الجوال')],
    },
    onSubmit: (values) => {
      const taken = store.users.exists(
        (row) => row.id !== user.id && row.email.toLowerCase() === values.email.trim().toLowerCase()
      );
      if (taken) {
        setFieldError(accountForm, 'email', 'هذا البريد الإلكتروني مستخدم بالفعل.');
        return;
      }

      store.users.update(user.id, {
        name: values.name.trim(),
        email: values.email.trim(),
        phone: values.phone.trim(),
      });

      // Keep the person record's contact details in step with the account.
      if (session.displacedId) {
        store.displaced.update(session.displacedId, {
          phone: values.phone.trim(),
          email: values.email.trim(),
        });
      }

      toast.success('تم الحفظ', 'تم تحديث بيانات حسابك.');
      init({ session, content });
    },
  });

  const passwordForm = qs('#password-form', content);
  bindForm(passwordForm, {
    schema: {
      currentPassword: [rules.required('كلمة المرور الحالية')],
      newPassword: [rules.required('كلمة المرور الجديدة'), rules.password(6)],
      confirmPassword: [
        rules.required('تأكيد كلمة المرور'),
        rules.matches('newPassword', 'كلمتا المرور غير متطابقتين.'),
      ],
    },
    onSubmit: (values) => {
      const current = store.users.get(user.id);
      if (current.password && current.password !== values.currentPassword) {
        setFieldError(passwordForm, 'currentPassword', 'كلمة المرور الحالية غير صحيحة.');
        return;
      }

      store.users.update(user.id, { password: values.newPassword });
      passwordForm.reset();
      toast.success('تم التحديث', 'تم تغيير كلمة المرور بنجاح.');
    },
  });
}

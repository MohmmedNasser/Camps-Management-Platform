/**
 * Field groups for the records the platform edits.
 *
 * Still presentation: every function takes the values to prefill and the
 * option lists to offer, and returns HTML. Nothing here reads the store — the
 * page supplies `options` — so the same groups serve both create and edit.
 *
 * Several absences are deliberate and enforced by the domain, not oversights:
 *   - no tent number, caravan number or file number (tent *type* instead)
 *   - health is chronic diseases and disability, nothing else
 *   - the economic group has no "family needs"
 *   - an organisation is a name and an optional responsible person
 *   - documents have no expiry date
 */

import { esc } from '../utils/dom.js';
import { toInputDate } from '../utils/format.js';
import { rules } from '../utils/validators.js';
import { inputField, selectField, textareaField, fieldset, radioCards } from './form.js';
import {
  GENDERS,
  MARITAL_STATUSES,
  NATIONALITIES,
  TENT_TYPES,
  GOVERNORATES,
  WORK_STATUSES,
  INCOME_SOURCES,
  RELATIONSHIPS,
  AID_TYPES,
  DOCUMENT_CATEGORIES,
  MESSAGE_SUBJECTS,
  STATUS,
  STATUS_LABELS,
} from '../core/config.js';

const statusOptions = (values) => values.map((value) => ({ value, label: STATUS_LABELS[value] }));

/* ---- Displaced person --------------------------------------------------- */

/**
 * @param {object} values current record (empty object when creating)
 * @param {{camps: {value,label}[], families: {value,label}[], lockCamp?: boolean}} options
 */
export function displacedFields(values = {}, options = {}) {
  const { camps = [], families = [], lockCamp = false } = options;

  return [
    fieldset({
      legend: 'البيانات الشخصية',
      fields: [
        inputField({
          name: 'fullName',
          label: 'الاسم الكامل',
          value: values.fullName,
          placeholder: 'الاسم الرباعي كما في الهوية',
          required: true,
          full: true,
        }),
        inputField({
          name: 'fullNameEn',
          label: 'الاسم بالإنجليزية',
          value: values.fullNameEn,
          optional: true,
          attrs: 'dir="ltr"',
        }),
        inputField({
          name: 'nationalId',
          label: 'رقم الهوية',
          value: values.nationalId,
          required: true,
          mono: true,
          inputMode: 'numeric',
          placeholder: '9 أرقام',
          hint: 'المعرّف الوحيد لمنع التسجيل المكرر.',
          attrs: 'maxlength="9"',
        }),
        selectField({ name: 'gender', label: 'الجنس', options: GENDERS, value: values.gender, required: true }),
        inputField({
          name: 'birthDate',
          label: 'تاريخ الميلاد',
          type: 'date',
          value: toInputDate(values.birthDate),
          required: true,
        }),
        selectField({
          name: 'maritalStatus',
          label: 'الحالة الاجتماعية',
          options: MARITAL_STATUSES,
          value: values.maritalStatus,
        }),
        selectField({
          name: 'nationality',
          label: 'الجنسية',
          options: NATIONALITIES,
          value: values.nationality || 'palestinian',
        }),
        inputField({
          name: 'passportNumber',
          label: 'رقم جواز السفر',
          value: values.passportNumber,
          optional: true,
          mono: true,
        }),
        inputField({
          name: 'unrwaNumber',
          label: 'رقم وكالة الغوث',
          value: values.unrwaNumber,
          optional: true,
          mono: true,
        }),
      ],
    }),

    fieldset({
      legend: 'بيانات الاتصال والعنوان',
      fields: [
        inputField({
          name: 'phone',
          label: 'رقم الجوال',
          type: 'tel',
          value: values.phone,
          required: true,
          mono: true,
          inputMode: 'tel',
          placeholder: '05xxxxxxxx',
          attrs: 'maxlength="10"',
        }),
        inputField({
          name: 'altPhone',
          label: 'رقم بديل',
          type: 'tel',
          value: values.altPhone,
          optional: true,
          mono: true,
          inputMode: 'tel',
          attrs: 'maxlength="10"',
        }),
        inputField({
          name: 'email',
          label: 'البريد الإلكتروني',
          type: 'email',
          value: values.email,
          optional: true,
          full: true,
        }),
        selectField({
          name: 'governorate',
          label: 'المحافظة',
          options: GOVERNORATES,
          value: values.governorate,
        }),
        inputField({ name: 'city', label: 'المدينة', value: values.city }),
        inputField({ name: 'area', label: 'الحي / المنطقة', value: values.area, optional: true }),
      ],
    }),

    fieldset({
      legend: 'بيانات النزوح والإقامة',
      hint: 'يُسجَّل نوع الخيمة فقط — لا يوجد رقم خيمة أو كرفان في النظام.',
      fields: [
        selectField({
          name: 'campId',
          label: 'المخيم',
          options: camps,
          value: values.campId,
          required: true,
          attrs: lockCamp ? 'disabled' : '',
          hint: lockCamp ? 'مخيمك الحالي — لا يمكن تسجيل نازح خارج نطاق إشرافك.' : '',
        }),
        selectField({
          name: 'tentType',
          label: 'نوع الخيمة / وحدة الإيواء',
          options: TENT_TYPES,
          value: values.tentType,
          required: true,
        }),
        selectField({
          name: 'originGovernorate',
          label: 'محافظة النزوح الأصلية',
          options: GOVERNORATES,
          value: values.originGovernorate,
        }),
        inputField({ name: 'originCity', label: 'مدينة النزوح الأصلية', value: values.originCity }),
        inputField({
          name: 'displacementDate',
          label: 'تاريخ النزوح',
          type: 'date',
          value: toInputDate(values.displacementDate),
        }),
        inputField({
          name: 'currentResidence',
          label: 'مكان الإقامة الحالي',
          value: values.currentResidence,
          placeholder: 'القطاع أو البلوك داخل المخيم',
          full: true,
        }),
      ],
    }),

    fieldset({
      legend: 'الحالة الصحية',
      hint: 'الأمراض المزمنة والإعاقة فقط. اترك الحقل فارغاً إن لم توجد حالة.',
      fields: [
        inputField({
          name: 'chronicDiseases',
          label: 'الأمراض المزمنة',
          value: values.chronicDiseases,
          optional: true,
          placeholder: 'مثال: ضغط الدم، سكري',
        }),
        inputField({
          name: 'disability',
          label: 'الإعاقة',
          value: values.disability,
          optional: true,
          placeholder: 'مثال: إعاقة حركية',
        }),
      ],
    }),

    fieldset({
      legend: 'الوضع الاقتصادي',
      fields: [
        selectField({
          name: 'workStatus',
          label: 'حالة العمل',
          options: WORK_STATUSES,
          value: values.workStatus,
        }),
        selectField({
          name: 'incomeSource',
          label: 'مصدر الدخل',
          options: INCOME_SOURCES,
          value: values.incomeSource,
        }),
        inputField({
          name: 'monthlyIncome',
          label: 'الدخل الشهري (₪)',
          type: 'number',
          value: values.monthlyIncome,
          mono: true,
          inputMode: 'numeric',
          attrs: 'min="0" step="10"',
        }),
      ],
    }),

    fieldset({
      legend: 'الأسرة',
      hint: 'اربط النازح بأسرة قائمة، أو أنشئ الأسرة أولاً من صفحة الأسر.',
      fields: [
        selectField({
          name: 'familyId',
          label: 'الأسرة',
          options: families,
          value: values.familyId,
          placeholder: 'بدون أسرة',
          optional: true,
        }),
        selectField({
          name: 'relationship',
          label: 'صلة القرابة برب الأسرة',
          options: RELATIONSHIPS,
          value: values.relationship,
        }),
      ],
    }),
  ].join('');
}

/* ---- Family ------------------------------------------------------------- */

/**
 * @param {object} values
 * @param {{camps, members: {value,label}[], lockCamp?: boolean, lockId?: boolean}} options
 */
export function familyFields(values = {}, options = {}) {
  const { camps = [], members = [], lockCamp = false } = options;

  return [
    fieldset({
      legend: 'بيانات الأسرة',
      hint: 'رقم الأسرة يُولَّد تلقائياً ولا يمكن تعديله.',
      fields: [
        inputField({
          name: 'id',
          label: 'رقم الأسرة',
          value: values.id,
          mono: true,
          attrs: 'readonly',
          hint: 'يُنشأ تلقائياً بالصيغة FAM-000001.',
        }),
        selectField({
          name: 'campId',
          label: 'المخيم',
          options: camps,
          value: values.campId,
          required: true,
          attrs: lockCamp ? 'disabled' : '',
        }),
        selectField({
          name: 'headId',
          label: 'رب الأسرة',
          options: members,
          value: values.headId,
          required: true,
          placeholder: 'اختر رب الأسرة',
          hint: 'يجب أن يكون أحد النازحين المسجّلين في المخيم نفسه.',
          full: true,
        }),
      ],
    }),
    textareaField({
      name: 'notes',
      label: 'ملاحظات',
      value: values.notes,
      optional: true,
      placeholder: 'أي معلومات إضافية عن حالة الأسرة…',
    }),
  ].join('');
}

/* ---- Aid ---------------------------------------------------------------- */

/**
 * @param {object} values
 * @param {{organizations, families, people, lockCamp?: boolean}} options
 */
export function aidFields(values = {}, options = {}) {
  const { organizations = [], families = [], people = [] } = options;

  return [
    radioCards({
      name: 'type',
      label: 'نوع المساعدة',
      options: AID_TYPES.map((type) => ({ value: type.value, label: type.label })),
      value: values.type || 'food',
      required: true,
    }),

    fieldset({
      legend: 'الجهة والمستفيد',
      fields: [
        selectField({
          name: 'organizationId',
          label: 'المؤسسة المانحة',
          options: organizations,
          value: values.organizationId,
          required: true,
        }),
        selectField({
          name: 'familyId',
          label: 'الأسرة المستفيدة',
          options: families,
          value: values.familyId,
          required: true,
        }),
        selectField({
          name: 'displacedId',
          label: 'المستلم',
          options: people,
          value: values.displacedId,
          required: true,
          hint: 'يتم تحديث القائمة حسب الأسرة المختارة.',
          full: true,
        }),
      ],
    }),

    fieldset({
      legend: 'تفاصيل المساعدة',
      fields: [
        inputField({
          name: 'date',
          label: 'تاريخ التسليم',
          type: 'date',
          value: toInputDate(values.date),
          required: true,
        }),
        inputField({
          name: 'quantity',
          label: 'الكمية',
          value: values.quantity,
          placeholder: 'مثال: 1 طرد، 500 لتر',
        }),
        inputField({
          name: 'value',
          label: 'القيمة التقديرية (₪)',
          type: 'number',
          value: values.value,
          mono: true,
          inputMode: 'numeric',
          attrs: 'min="0" step="5"',
        }),
      ],
    }),

    textareaField({
      name: 'notes',
      label: 'ملاحظات',
      value: values.notes,
      optional: true,
      placeholder: 'تفاصيل إضافية عن المساعدة…',
    }),
  ].join('');
}

/* ---- Camp --------------------------------------------------------------- */

export function campFields(values = {}) {
  return fieldset({
    legend: 'بيانات المخيم',
    fields: [
      inputField({
        name: 'name',
        label: 'اسم المخيم',
        value: values.name,
        required: true,
        placeholder: 'مثال: مخيم النور',
        full: true,
      }),
      selectField({
        name: 'governorate',
        label: 'المحافظة',
        options: GOVERNORATES,
        value: values.governorate,
        required: true,
      }),
      inputField({ name: 'city', label: 'المدينة', value: values.city, required: true }),
      selectField({
        name: 'status',
        label: 'حالة المخيم',
        options: statusOptions([STATUS.ACTIVE, STATUS.DISABLED]),
        value: values.status || STATUS.ACTIVE,
        required: true,
        full: true,
      }),
    ],
  });
}

/* ---- Camp admin --------------------------------------------------------- */

/**
 * The Camp Admin *is* the camp representative — there is no separate
 * representative-name field anywhere in the platform.
 */
export function campAdminFields(values = {}, { camps = [], isNew = true } = {}) {
  return fieldset({
    legend: 'بيانات مسؤول المخيم',
    hint: 'مسؤول المخيم هو مندوب المخيم المعتمد — لا يوجد حقل منفصل لاسم المندوب.',
    fields: [
      inputField({
        name: 'name',
        label: 'الاسم الكامل',
        value: values.name,
        required: true,
        full: true,
      }),
      inputField({
        name: 'email',
        label: 'البريد الإلكتروني',
        type: 'email',
        value: values.email,
        required: true,
      }),
      inputField({
        name: 'phone',
        label: 'رقم الجوال',
        type: 'tel',
        value: values.phone,
        required: true,
        mono: true,
        inputMode: 'tel',
        placeholder: '05xxxxxxxx',
        attrs: 'maxlength="10"',
      }),
      selectField({
        name: 'campId',
        label: 'المخيم',
        options: camps,
        value: values.campId,
        required: true,
      }),
      selectField({
        name: 'status',
        label: 'حالة الحساب',
        options: statusOptions([STATUS.ACTIVE, STATUS.DISABLED]),
        value: values.status || STATUS.ACTIVE,
        required: true,
      }),
      ...(isNew
        ? [
            inputField({
              name: 'password',
              label: 'كلمة المرور المبدئية',
              value: '',
              required: true,
              hint: '6 أحرف على الأقل، يغيّرها المسؤول بعد أول دخول.',
              full: true,
            }),
          ]
        : []),
    ],
  });
}

/* ---- Organization ------------------------------------------------------- */

/** Name and an optional responsible person — nothing else, by domain rule. */
export function organizationFields(values = {}) {
  return `
    ${inputField({
      name: 'name',
      label: 'اسم المؤسسة',
      value: values.name,
      required: true,
      full: true,
    })}
    ${inputField({
      name: 'responsiblePerson',
      label: 'الشخص المسؤول',
      value: values.responsiblePerson,
      optional: true,
      full: true,
      hint: 'لا يحتوي سجل المؤسسة على بريد أو هاتف أو عنوان.',
    })}`;
}

/* ---- Document ----------------------------------------------------------- */

/** Documents carry no expiry date — the domain has none. */
export function documentFields(values = {}, { people = [] } = {}) {
  return `
    ${inputField({
      name: 'name',
      label: 'اسم المستند',
      value: values.name,
      required: true,
      full: true,
      placeholder: 'مثال: بطاقة هوية - أحمد الشريف',
    })}
    ${selectField({
      name: 'category',
      label: 'نوع المستند',
      options: DOCUMENT_CATEGORIES.map((item) => ({ value: item.value, label: item.label })),
      value: values.category,
      required: true,
      full: true,
    })}
    ${
      people.length
        ? selectField({
            name: 'displacedId',
            label: 'يخص النازح',
            options: people,
            value: values.displacedId,
            required: true,
            full: true,
          })
        : ''
    }`;
}

/* ---- Message ------------------------------------------------------------ */

export function messageFields(values = {}) {
  return `
    ${selectField({
      name: 'subject',
      label: 'موضوع الرسالة',
      options: MESSAGE_SUBJECTS,
      value: values.subject,
      required: true,
      full: true,
    })}
    ${textareaField({
      name: 'body',
      label: 'نص الرسالة',
      value: values.body,
      required: true,
      rows: 6,
      placeholder: 'اكتب رسالتك إلى إدارة المخيم…',
    })}`;
}

/* ---- Validation schemas -------------------------------------------------- */

/**
 * Rules for each field group above. They live next to the fields so a renamed
 * field cannot silently lose its validation.
 *
 * `isDuplicateId` lets the page plug in the store-backed uniqueness check
 * without this module reaching for data itself.
 */
export function displacedSchema({ isDuplicateId = () => false } = {}) {
  return {
    fullName: [rules.required('الاسم الكامل'), rules.minLength(6, 'الاسم الكامل')],
    nationalId: [
      rules.required('رقم الهوية'),
      rules.nationalId(),
      rules.custom(
        (value) => !isDuplicateId(value),
        'رقم الهوية مسجّل مسبقاً. لا يمكن تسجيل الشخص نفسه في أكثر من مخيم.'
      ),
    ],
    gender: [rules.required('الجنس')],
    birthDate: [rules.required('تاريخ الميلاد'), rules.pastDate('تاريخ الميلاد')],
    phone: [rules.required('رقم الجوال'), rules.phone('رقم الجوال')],
    altPhone: [rules.phone('الرقم البديل')],
    email: [rules.email()],
    campId: [rules.required('المخيم')],
    tentType: [rules.required('نوع الخيمة')],
    displacementDate: [rules.pastDate('تاريخ النزوح')],
    monthlyIncome: [rules.number({ min: 0, label: 'الدخل الشهري' })],
  };
}

export function familySchema() {
  return {
    campId: [rules.required('المخيم')],
    headId: [rules.required('رب الأسرة')],
  };
}

export function aidSchema() {
  return {
    type: [rules.required('نوع المساعدة')],
    organizationId: [rules.required('المؤسسة المانحة')],
    familyId: [rules.required('الأسرة المستفيدة')],
    displacedId: [rules.required('المستلم')],
    date: [rules.required('تاريخ التسليم'), rules.pastDate('تاريخ التسليم')],
    value: [rules.number({ min: 0, label: 'القيمة التقديرية' })],
  };
}

export function campSchema() {
  return {
    name: [rules.required('اسم المخيم'), rules.minLength(3, 'اسم المخيم')],
    governorate: [rules.required('المحافظة')],
    city: [rules.required('المدينة')],
    status: [rules.required('حالة المخيم')],
  };
}

export function campAdminSchema({ isNew = true, isDuplicateEmail = () => false } = {}) {
  return {
    name: [rules.required('الاسم الكامل'), rules.minLength(5, 'الاسم الكامل')],
    email: [
      rules.required('البريد الإلكتروني'),
      rules.email(),
      rules.custom((value) => !isDuplicateEmail(value), 'هذا البريد الإلكتروني مستخدم بالفعل.'),
    ],
    phone: [rules.required('رقم الجوال'), rules.phone('رقم الجوال')],
    campId: [rules.required('المخيم')],
    status: [rules.required('حالة الحساب')],
    ...(isNew ? { password: [rules.required('كلمة المرور'), rules.password(6)] } : {}),
  };
}

export function organizationSchema() {
  return { name: [rules.required('اسم المؤسسة'), rules.minLength(3, 'اسم المؤسسة')] };
}

export function documentSchema({ requirePerson = false } = {}) {
  return {
    name: [rules.required('اسم المستند'), rules.minLength(3, 'اسم المستند')],
    category: [rules.required('نوع المستند')],
    ...(requirePerson ? { displacedId: [rules.required('النازح')] } : {}),
  };
}

export function messageSchema() {
  return {
    subject: [rules.required('موضوع الرسالة')],
    body: [rules.required('نص الرسالة'), rules.minLength(10, 'نص الرسالة')],
  };
}

/** Read-only summary line reused above forms that edit an existing record. */
export function formSummary(items) {
  return `
    <div class="row u-gap-2 u-wrap u-mb-4">
      ${items
        .filter(Boolean)
        .map((item) => `<span class="chip chip--outline">${esc(item)}</span>`)
        .join('')}
    </div>`;
}

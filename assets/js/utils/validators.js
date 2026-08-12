/**
 * Field validation rules.
 *
 * Each rule is a function returning an Arabic error message, or '' when the
 * value is acceptable. Rules are pure so the same set can run on the server
 * after migration.
 */

export const rules = {
  required: (label = 'هذا الحقل') => (value) =>
    String(value ?? '').trim() ? '' : `${label} مطلوب.`,

  minLength: (min, label = 'هذا الحقل') => (value) =>
    !value || String(value).trim().length >= min ? '' : `${label} يجب ألا يقل عن ${min} أحرف.`,

  maxLength: (max, label = 'هذا الحقل') => (value) =>
    !value || String(value).length <= max ? '' : `${label} يجب ألا يزيد عن ${max} حرفاً.`,

  /** Palestinian national ID: exactly 9 digits. */
  nationalId: () => (value) => {
    if (!value) return '';
    return /^\d{9}$/.test(String(value).trim()) ? '' : 'رقم الهوية يجب أن يتكون من 9 أرقام.';
  },

  /** Mobile: 10 digits starting with 05. */
  phone: (label = 'رقم الهاتف') => (value) => {
    if (!value) return '';
    return /^05\d{8}$/.test(String(value).trim())
      ? ''
      : `${label} يجب أن يبدأ بـ 05 ويتكون من 10 أرقام.`;
  },

  email: () => (value) => {
    if (!value) return '';
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value).trim())
      ? ''
      : 'صيغة البريد الإلكتروني غير صحيحة.';
  },

  password: (min = 6) => (value) => {
    if (!value) return '';
    return String(value).length >= min ? '' : `كلمة المرور يجب ألا تقل عن ${min} أحرف.`;
  },

  /** Cross-field: must equal the value of another named field. */
  matches: (otherName, message = 'القيمتان غير متطابقتين.') => (value, values) =>
    !value || value === values[otherName] ? '' : message,

  number: ({ min, max, label = 'القيمة' } = {}) => (value) => {
    if (value === '' || value === null || value === undefined) return '';
    const num = Number(value);
    if (Number.isNaN(num)) return `${label} يجب أن تكون رقماً.`;
    if (min !== undefined && num < min) return `${label} يجب ألا تقل عن ${min}.`;
    if (max !== undefined && num > max) return `${label} يجب ألا تزيد عن ${max}.`;
    return '';
  },

  /** Date must be valid and not in the future. */
  pastDate: (label = 'التاريخ') => (value) => {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return `${label} غير صحيح.`;
    return date > new Date() ? `${label} لا يمكن أن يكون في المستقبل.` : '';
  },

  checked: (message = 'يجب الموافقة للمتابعة.') => (value) =>
    value === true || value === 'on' || value === 'true' ? '' : message,

  /** Arbitrary predicate; return true when valid. */
  custom: (predicate, message) => (value, values) => (predicate(value, values) ? '' : message),
};

/**
 * Run a schema against a values object.
 * @param {object} values
 * @param {Record<string, Function[]>} schema field name -> rules
 * @returns {Record<string, string>} field name -> first error found
 */
export function validate(values, schema) {
  const errors = {};
  Object.entries(schema).forEach(([field, fieldRules]) => {
    for (const rule of fieldRules) {
      const message = rule(values[field], values);
      if (message) {
        errors[field] = message;
        break;
      }
    }
  });
  return errors;
}

export default { rules, validate };

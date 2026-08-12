/**
 * Application constants: roles, enumerations, Arabic labels and navigation.
 *
 * Everything the UI displays as a fixed choice lives here so a single edit
 * changes every dropdown, filter and badge. When this moves to Supabase these
 * become database enums / lookup tables.
 */

export const APP_NAME = 'منصة إدارة مخيمات النازحين';
export const APP_SHORT = 'إدارة المخيمات';

/* ---- Roles ------------------------------------------------------------ */

export const ROLES = {
  SUPER_ADMIN: 'super_admin',
  CAMP_ADMIN: 'camp_admin',
  DISPLACED: 'displaced',
};

export const ROLE_LABELS = {
  [ROLES.SUPER_ADMIN]: 'مدير النظام',
  [ROLES.CAMP_ADMIN]: 'مسؤول مخيم',
  [ROLES.DISPLACED]: 'نازح',
};

/* ---- Account / record status ------------------------------------------ */

export const STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  ACTIVE: 'active',
  DISABLED: 'disabled',
};

export const STATUS_LABELS = {
  [STATUS.PENDING]: 'قيد المراجعة',
  [STATUS.APPROVED]: 'مقبول',
  [STATUS.REJECTED]: 'مرفوض',
  [STATUS.ACTIVE]: 'نشط',
  [STATUS.DISABLED]: 'معطّل',
};

/** Badge variant for each status — drives color everywhere. */
export const STATUS_VARIANTS = {
  [STATUS.PENDING]: 'warning',
  [STATUS.APPROVED]: 'success',
  [STATUS.REJECTED]: 'error',
  [STATUS.ACTIVE]: 'success',
  [STATUS.DISABLED]: 'error',
};

/* ---- Enumerations ----------------------------------------------------- */

export const GENDERS = [
  { value: 'male', label: 'ذكر' },
  { value: 'female', label: 'أنثى' },
];

export const MARITAL_STATUSES = [
  { value: 'single', label: 'أعزب / عزباء' },
  { value: 'married', label: 'متزوج / متزوجة' },
  { value: 'divorced', label: 'مطلق / مطلقة' },
  { value: 'widowed', label: 'أرمل / أرملة' },
];

export const NATIONALITIES = [
  { value: 'palestinian', label: 'فلسطيني' },
  { value: 'other', label: 'أخرى' },
];

/** Tent type — the platform stores type, never a tent or caravan number. */
export const TENT_TYPES = [
  { value: 'family_tent', label: 'خيمة عائلية' },
  { value: 'individual_tent', label: 'خيمة فردية' },
  { value: 'shared_tent', label: 'خيمة مشتركة' },
  { value: 'shelter_unit', label: 'وحدة إيواء' },
  { value: 'classroom', label: 'غرفة صفية' },
];

export const GOVERNORATES = [
  { value: 'north_gaza', label: 'شمال غزة' },
  { value: 'gaza', label: 'غزة' },
  { value: 'deir_albalah', label: 'دير البلح' },
  { value: 'khan_younis', label: 'خان يونس' },
  { value: 'rafah', label: 'رفح' },
];

export const WORK_STATUSES = [
  { value: 'employed', label: 'يعمل' },
  { value: 'unemployed', label: 'عاطل عن العمل' },
  { value: 'irregular', label: 'عمل غير منتظم' },
  { value: 'student', label: 'طالب' },
  { value: 'unable', label: 'غير قادر على العمل' },
];

export const INCOME_SOURCES = [
  { value: 'salary', label: 'راتب' },
  { value: 'daily_work', label: 'عمل يومي' },
  { value: 'aid', label: 'مساعدات' },
  { value: 'trade', label: 'تجارة صغيرة' },
  { value: 'none', label: 'لا يوجد' },
];

export const RELATIONSHIPS = [
  { value: 'head', label: 'رب الأسرة' },
  { value: 'spouse', label: 'زوج / زوجة' },
  { value: 'son', label: 'ابن' },
  { value: 'daughter', label: 'ابنة' },
  { value: 'father', label: 'أب' },
  { value: 'mother', label: 'أم' },
  { value: 'brother', label: 'أخ' },
  { value: 'sister', label: 'أخت' },
  { value: 'other', label: 'قريب آخر' },
];

/** The ten aid types required by the domain, in order. */
export const AID_TYPES = [
  { value: 'food', label: 'غذائية', icon: 'aid' },
  { value: 'financial', label: 'مالية', icon: 'wallet' },
  { value: 'medical', label: 'طبية', icon: 'heartPulse' },
  { value: 'medicine', label: 'أدوية', icon: 'heartPulse' },
  { value: 'blankets', label: 'بطانيات', icon: 'aid' },
  { value: 'water', label: 'مياه', icon: 'aid' },
  { value: 'clothes', label: 'ملابس', icon: 'aid' },
  { value: 'cleaning', label: 'مواد تنظيف', icon: 'aid' },
  { value: 'household', label: 'أدوات منزلية', icon: 'aid' },
  { value: 'other', label: 'أخرى', icon: 'aid' },
];

export const DOCUMENT_CATEGORIES = [
  { value: 'id_card', label: 'الهوية', icon: 'idCard' },
  { value: 'passport', label: 'جواز السفر', icon: 'fileText' },
  { value: 'birth_certificate', label: 'شهادة الميلاد', icon: 'fileText' },
  { value: 'medical_report', label: 'تقرير طبي', icon: 'heartPulse' },
  { value: 'other', label: 'مستند آخر', icon: 'folder' },
];

export const MESSAGE_STATUSES = [
  { value: 'unread', label: 'غير مقروءة' },
  { value: 'read', label: 'مقروءة' },
  { value: 'replied', label: 'تم الرد' },
];

export const MESSAGE_SUBJECTS = [
  { value: 'aid_request', label: 'استفسار عن مساعدة' },
  { value: 'data_update', label: 'تحديث بيانات' },
  { value: 'complaint', label: 'شكوى' },
  { value: 'document', label: 'مستندات' },
  { value: 'other', label: 'موضوع آخر' },
];

/* ---- Lookup helper ---------------------------------------------------- */

/** Resolve an enum value to its Arabic label. */
export function labelOf(list, value, fallback = '—') {
  const found = list.find((item) => item.value === value);
  return found ? found.label : fallback;
}

/* ---- Navigation ------------------------------------------------------- */

/**
 * Navigation per role. `primary: true` marks the items that appear in the
 * mobile bottom bar (max 4 + "المزيد").
 */
export const NAVIGATION = {
  [ROLES.CAMP_ADMIN]: [
    { href: 'dashboard.html', label: 'الرئيسية', icon: 'home', primary: true },
    { href: 'displaced.html', label: 'النازحون', icon: 'users', primary: true },
    { href: 'families.html', label: 'الأسر', icon: 'family', primary: true },
    { href: 'registration-requests.html', label: 'طلبات التسجيل', icon: 'clipboard', badge: 'pendingRequests', primary: true },
    { href: 'aid.html', label: 'المساعدات', icon: 'aid' },
    { href: 'organizations.html', label: 'المؤسسات', icon: 'building' },
    { href: 'documents.html', label: 'الملفات', icon: 'folder' },
    { href: 'messages.html', label: 'الرسائل', icon: 'message', badge: 'unreadMessages' },
    { href: 'notifications.html', label: 'الإشعارات', icon: 'bell' },
    { href: 'settings.html', label: 'الإعدادات', icon: 'settings' },
  ],
  [ROLES.DISPLACED]: [
    { href: 'dashboard.html', label: 'الرئيسية', icon: 'home', primary: true },
    { href: 'profile.html', label: 'ملفي', icon: 'user', primary: true },
    { href: 'family-details.html', label: 'أسرتي', icon: 'family', primary: true },
    { href: 'aid.html', label: 'مساعداتي', icon: 'aid', primary: true },
    { href: 'documents.html', label: 'المستندات', icon: 'folder' },
    { href: 'messages.html', label: 'الرسائل', icon: 'message', badge: 'unreadMessages' },
    { href: 'notifications.html', label: 'الإشعارات', icon: 'bell' },
    { href: 'settings.html', label: 'الإعدادات', icon: 'settings' },
  ],
  [ROLES.SUPER_ADMIN]: [
    { href: 'dashboard.html', label: 'الرئيسية', icon: 'home', primary: true },
    { href: 'camps.html', label: 'المخيمات', icon: 'tent', primary: true },
    { href: 'camp-admins.html', label: 'مسؤولو المخيمات', icon: 'shield', primary: true },
    { href: 'displaced.html', label: 'النازحون', icon: 'users', primary: true },
    { href: 'families.html', label: 'الأسر', icon: 'family' },
    { href: 'organizations.html', label: 'المؤسسات', icon: 'building' },
    { href: 'statistics.html', label: 'الإحصائيات', icon: 'chart' },
    { href: 'settings.html', label: 'الإعدادات', icon: 'settings' },
  ],
};

/** Pages each role is allowed to open. Enforced by core/router.js. */
export const PAGE_ACCESS = {
  'dashboard.html': [ROLES.SUPER_ADMIN, ROLES.CAMP_ADMIN, ROLES.DISPLACED],
  'displaced.html': [ROLES.SUPER_ADMIN, ROLES.CAMP_ADMIN],
  'displaced-details.html': [ROLES.SUPER_ADMIN, ROLES.CAMP_ADMIN],
  'displaced-create.html': [ROLES.CAMP_ADMIN],
  'displaced-edit.html': [ROLES.CAMP_ADMIN],
  'families.html': [ROLES.SUPER_ADMIN, ROLES.CAMP_ADMIN],
  'family-details.html': [ROLES.SUPER_ADMIN, ROLES.CAMP_ADMIN, ROLES.DISPLACED],
  'family-create.html': [ROLES.CAMP_ADMIN],
  'aid.html': [ROLES.SUPER_ADMIN, ROLES.CAMP_ADMIN, ROLES.DISPLACED],
  'aid-details.html': [ROLES.SUPER_ADMIN, ROLES.CAMP_ADMIN, ROLES.DISPLACED],
  'aid-create.html': [ROLES.CAMP_ADMIN],
  'aid-edit.html': [ROLES.CAMP_ADMIN],
  'organizations.html': [ROLES.SUPER_ADMIN, ROLES.CAMP_ADMIN],
  'registration-requests.html': [ROLES.CAMP_ADMIN],
  'registration-request-details.html': [ROLES.CAMP_ADMIN],
  'documents.html': [ROLES.SUPER_ADMIN, ROLES.CAMP_ADMIN, ROLES.DISPLACED],
  'messages.html': [ROLES.SUPER_ADMIN, ROLES.CAMP_ADMIN, ROLES.DISPLACED],
  'message-details.html': [ROLES.SUPER_ADMIN, ROLES.CAMP_ADMIN, ROLES.DISPLACED],
  'message-compose.html': [ROLES.SUPER_ADMIN, ROLES.CAMP_ADMIN, ROLES.DISPLACED],
  'notifications.html': [ROLES.SUPER_ADMIN, ROLES.CAMP_ADMIN, ROLES.DISPLACED],
  'profile.html': [ROLES.SUPER_ADMIN, ROLES.CAMP_ADMIN, ROLES.DISPLACED],
  'settings.html': [ROLES.SUPER_ADMIN, ROLES.CAMP_ADMIN, ROLES.DISPLACED],
  'camps.html': [ROLES.SUPER_ADMIN],
  'camp-admins.html': [ROLES.SUPER_ADMIN],
  'statistics.html': [ROLES.SUPER_ADMIN],
};

/** Pagination default. */
export const PAGE_SIZE = 10;

/** Simulated network latency (ms) so skeleton states are real. */
export const FAKE_LATENCY = 320;

/** Chart palette, derived from the design system. */
export const CHART_COLORS = [
  '#6366F1',
  '#10B981',
  '#F59E0B',
  '#EF4444',
  '#8B5CF6',
  '#06B6D4',
  '#EC4899',
  '#84CC16',
  '#F97316',
  '#64748B',
];

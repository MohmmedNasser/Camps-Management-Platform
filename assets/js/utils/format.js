/**
 * Formatting helpers — Arabic locale, Latin numerals.
 *
 * Latin digits are used deliberately: national IDs, phone numbers and family
 * IDs are read aloud and copied by hand, and mixed numeral systems are a
 * common source of transcription errors in the field.
 */

const AR = 'ar-u-nu-latn';

const dateLong = new Intl.DateTimeFormat(AR, { day: 'numeric', month: 'long', year: 'numeric' });
const dateShort = new Intl.DateTimeFormat(AR, { day: '2-digit', month: '2-digit', year: 'numeric' });
const monthLabel = new Intl.DateTimeFormat(AR, { month: 'long' });
const timeShort = new Intl.DateTimeFormat(AR, { hour: '2-digit', minute: '2-digit', hour12: true });
const numberFmt = new Intl.NumberFormat(AR);

function toDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "12 أغسطس 2026" */
export function formatDate(value) {
  const date = toDate(value);
  return date ? dateLong.format(date) : '—';
}

/** "12/08/2026" — for dense table cells */
export function formatDateShort(value) {
  const date = toDate(value);
  return date ? dateShort.format(date) : '—';
}

/** "12 أغسطس 2026 · 09:30 ص" */
export function formatDateTime(value) {
  const date = toDate(value);
  if (!date) return '—';
  return `${dateLong.format(date)} · ${timeShort.format(date)}`;
}

export function formatMonth(value) {
  const date = toDate(value);
  return date ? monthLabel.format(date) : '';
}

/** Value for an <input type="date"> */
export function toInputDate(value) {
  const date = toDate(value);
  return date ? date.toISOString().slice(0, 10) : '';
}

/** "منذ 3 أيام" / "قبل قليل" */
export function formatRelative(value) {
  const date = toDate(value);
  if (!date) return '';
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'قبل قليل';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `منذ ${minutes} دقيقة`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `منذ ${hours} ساعة`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'أمس';
  if (days < 30) return `منذ ${days} يوم`;
  const months = Math.round(days / 30);
  if (months < 12) return `منذ ${months} شهر`;
  return `منذ ${Math.round(months / 12)} سنة`;
}

export function formatNumber(value) {
  if (value === null || value === undefined || value === '') return '—';
  return numberFmt.format(Number(value));
}

/** "1,250 ₪" */
export function formatCurrency(value) {
  if (value === null || value === undefined || value === '') return '—';
  return `${numberFmt.format(Number(value))} ₪`;
}

export function formatAge(birthDate) {
  const date = toDate(birthDate);
  if (!date) return '—';
  const now = new Date();
  let age = now.getFullYear() - date.getFullYear();
  const monthDiff = now.getMonth() - date.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < date.getDate())) age -= 1;
  return `${age} سنة`;
}

export function ageFrom(birthDate) {
  const date = toDate(birthDate);
  if (!date) return null;
  const now = new Date();
  let age = now.getFullYear() - date.getFullYear();
  const monthDiff = now.getMonth() - date.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < date.getDate())) age -= 1;
  return age;
}

/** "أحمد محمد" -> "أم" */
export function initials(name) {
  if (!name) return '؟';
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '؟';
  if (parts.length === 1) return parts[0].slice(0, 2);
  return parts[0][0] + parts[1][0];
}

/** 125 -> "FAM-000125" */
export function familyId(sequence) {
  return `FAM-${String(sequence).padStart(6, '0')}`;
}

/** Next sequence number from a list of existing "FAM-000xyz" ids. */
export function nextFamilySequence(existingIds) {
  const max = existingIds.reduce((acc, id) => {
    const num = Number(String(id).replace(/\D/g, ''));
    return Number.isFinite(num) && num > acc ? num : acc;
  }, 0);
  return max + 1;
}

/** "0591234567" -> "059 123 4567" */
export function formatPhone(value) {
  if (!value) return '—';
  const digits = String(value).replace(/\D/g, '');
  if (digits.length !== 10) return value;
  return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
}

export function truncate(text, max = 90) {
  if (!text) return '';
  const value = String(text);
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Fallback dash for empty values in detail views. */
export function orDash(value) {
  return value === null || value === undefined || value === '' ? '—' : value;
}

export function fileSize(bytes) {
  if (!bytes) return '—';
  const units = ['بايت', 'ك.ب', 'م.ب'];
  let size = Number(bytes);
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${numberFmt.format(Math.round(size * 10) / 10)} ${units[unit]}`;
}

export function pluralAr(count, one, two, few) {
  const n = Number(count);
  if (n === 1) return one;
  if (n === 2) return two;
  return few;
}

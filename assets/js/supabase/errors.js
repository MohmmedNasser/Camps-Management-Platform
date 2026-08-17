// assets/js/supabase/errors.js
/**
 * Central error mapping for the Supabase data-access layer (Phase 2 §30/§31).
 * Never surface a raw Postgres/PostgREST message: constraint names, column
 * names and SQLSTATE codes stay server-side. Only messages our own
 * `RAISE EXCEPTION ... using errcode` calls wrote (always Arabic) pass
 * through; everything else is replaced with a generic Arabic message keyed
 * by error class.
 */

export const ErrorType = Object.freeze({
  VALIDATION: 'validation',
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  DUPLICATE: 'duplicate',
  INVALID_STATE: 'invalid_state',
  DATABASE: 'database',
});

const PG_CODE_MAP = {
  '23505': ErrorType.DUPLICATE,
  '23503': ErrorType.VALIDATION,
  '23514': ErrorType.VALIDATION,
  '42501': ErrorType.FORBIDDEN,
  '22023': ErrorType.INVALID_STATE,
  P0002: ErrorType.NOT_FOUND,
  PGRST116: ErrorType.NOT_FOUND,
};

const FRIENDLY_AR = {
  [ErrorType.DUPLICATE]: 'هذا السجل موجود مسبقاً',
  [ErrorType.FORBIDDEN]: 'لا تملك صلاحية تنفيذ هذا الإجراء',
  [ErrorType.NOT_FOUND]: 'السجل غير موجود',
  [ErrorType.INVALID_STATE]: 'لا يمكن تنفيذ هذا الإجراء في الحالة الحالية',
  [ErrorType.VALIDATION]: 'البيانات المدخلة غير صالحة',
  [ErrorType.UNAUTHORIZED]: 'يجب تسجيل الدخول لإتمام هذا الإجراء',
  [ErrorType.DATABASE]: 'حدث خطأ غير متوقع، حاول مرة أخرى',
};

const ARABIC_START = /^[؀-ۿ]/;

export class DataAccessError extends Error {
  constructor(type, message, cause) {
    super(message);
    this.name = 'DataAccessError';
    this.type = type;
    this.cause = cause;
  }
}

/** Maps a PostgREST/Postgres error object (the `error` half of `{ data, error }`). */
export function mapError(error) {
  if (!error) return null;
  const type = PG_CODE_MAP[error.code] || ErrorType.DATABASE;
  const message = ARABIC_START.test(error.message || '') ? error.message : FRIENDLY_AR[type];
  return new DataAccessError(type, message, error);
}

/** Maps a GoTrue auth error object (`error` from `supabase.auth.*`). */
export function mapAuthError(error) {
  if (!error) return null;
  const status = error.status;
  const type = status === 400 || status === 401 ? ErrorType.UNAUTHORIZED : ErrorType.VALIDATION;
  return new DataAccessError(type, FRIENDLY_AR[type], error);
}

/** Awaits a `{ data, error }`-shaped Supabase call and throws a mapped error. */
export async function run(promise) {
  const { data, error } = await promise;
  if (error) throw mapError(error);
  return data;
}

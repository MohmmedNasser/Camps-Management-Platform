// assets/js/supabase/family-activation.js
//
// Phase 4.17: generating/inspecting an activation link is a plain SECURITY
// DEFINER RPC (Camp Admin, own camp only — enforced in the database, not
// here). Actually creating the Auth account is the one operation that needs
// service_role, so that alone goes through the activate-family-account Edge
// Function, called anonymously (the head of family has no session yet).
import { requireClient } from '../core/supabase-client.js';
import { run, DataAccessError, ErrorType } from './errors.js';

/**
 * An absolute URL, since this is copied out of the app into WhatsApp/
 * Telegram/etc — never a relative `<a href>`. Matches whichever URL style
 * (`.html` or extensionless) this deployment/browser is currently using,
 * same rule `core/router.js`'s `pageUrl()` applies for in-app links, without
 * depending on its private helpers: `family-details.html` (the only caller)
 * always lives in `/pages/`, so the sibling path is built directly from the
 * current directory.
 */
function absoluteActivationUrl(token) {
  const { origin, pathname } = window.location;
  const currentFile = pathname.split('/').pop() || '';
  const clean = currentFile !== '' && !currentFile.includes('.');
  const file = clean ? 'activate-family' : 'activate-family.html';
  const dir = pathname.replace(/[^/]*$/, '');
  return `${origin}${dir}${file}?token=${encodeURIComponent(token)}`;
}

/** Camp Admin only, own camp only (RLS-equivalent check inside the RPC). */
export async function generateActivationLink(familyId) {
  const client = requireClient();
  const rows = await run(client.rpc('generate_family_activation_token', { p_family_id: familyId }));
  const row = rows?.[0];
  if (!row) throw new DataAccessError(ErrorType.DATABASE, 'تعذر إنشاء رابط التفعيل', null);
  return {
    url: absoluteActivationUrl(row.token),
    token: row.token,
    expiresAt: row.expires_at,
  };
}

/** `{ state: 'none'|'active'|'expired'|'used'|'revoked'|'activated', expiresAt, createdAt }` */
export async function getActivationStatus(familyId) {
  const client = requireClient();
  const rows = await run(client.rpc('get_family_activation_status', { p_family_id: familyId }));
  const row = rows?.[0] || { state: 'none', expires_at: null, created_at: null };
  return { state: row.state, expiresAt: row.expires_at, createdAt: row.created_at };
}

const ACTIVATION_EDGE_ERROR_TYPES = {
  validation: ErrorType.VALIDATION,
  already_activated: ErrorType.ALREADY_ACTIVATED,
  email_taken: ErrorType.DUPLICATE,
  database: ErrorType.DATABASE,
};

/** Edge Function errors arrive as `{ error: { code, message } }` on the failed response. */
async function mapActivationFunctionError(error) {
  const context = error?.context;
  if (context && typeof context.json === 'function') {
    try {
      const body = await context.json();
      if (body?.error?.message) {
        return new DataAccessError(
          ACTIVATION_EDGE_ERROR_TYPES[body.error.code] || ErrorType.DATABASE,
          body.error.message,
          error
        );
      }
    } catch {
      // fall through to the generic message below
    }
  }
  return new DataAccessError(ErrorType.DATABASE, 'حدث خطأ غير متوقع، حاول مرة أخرى', error);
}

/**
 * Anonymous by design — the head of family has no session at this point.
 * `{ token, referenceCode, nationalId, birthDate, email, password }`.
 */
export async function activateFamilyAccount(payload) {
  const client = requireClient();
  const { data, error } = await client.functions.invoke('activate-family-account', { body: payload });
  if (error) throw await mapActivationFunctionError(error);
  return data;
}

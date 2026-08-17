/**
 * The Supabase client — the single place the browser talks to the backend.
 *
 * PHASE 1: this module exists and is verified, but no page imports it yet. The
 * prototype still reads `core/store.js` (localStorage). Phase 2 replaces the
 * bodies of the repository methods in store.js with calls made through here;
 * nothing above store.js changes, which is the whole point of the layering.
 *
 * The rule that already governs storage.js governs this file too: it is the
 * ONLY module allowed to construct a Supabase client. Pages never import
 * `createClient` themselves — several clients would mean several auth sessions
 * fighting over the same refresh token.
 *
 * No build step, so supabase-js is loaded as an ES module from a CDN, the same
 * way Chart.js already is.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.58.0';

/* ---- Configuration ------------------------------------------------------ */

let config = null;
let configError = null;

try {
  config = await import('./supabase-config.js');
} catch (error) {
  configError = error;
}

/**
 * True when the backend is configured. Phase 2 will branch on this so the
 * prototype keeps running from mock data on a machine that has no project yet.
 */
export const isConfigured = Boolean(
  config &&
    config.SUPABASE_URL &&
    config.SUPABASE_ANON_KEY &&
    !config.SUPABASE_URL.includes('your-project-ref')
);

if (!isConfigured) {
  console.warn(
    '[supabase] لم يتم ضبط الاتصال بقاعدة البيانات.\n' +
      'انسخ assets/js/core/supabase-config.example.js إلى supabase-config.js، ' +
      'أو شغّل `npm run frontend:config` من مجلد supabase.',
    configError || ''
  );
}

/* ---- Client -------------------------------------------------------------- */

/**
 * The shared client. Null until the project is configured, so importing this
 * module never throws and the prototype still loads.
 *
 * The key used here is the PUBLISHABLE key and is meant to be visible in the
 * browser. It grants nothing on its own: every table has Row Level Security
 * enabled, and the policies decide what the signed-in user may see. The secret
 * key must never reach this file.
 */
export const supabase = isConfigured
  ? createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, {
      auth: {
        // The prototype is a multi-page app: every navigation is a full page
        // load, so the session has to survive in storage and refresh itself.
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storageKey: 'dcmp.auth',
        flowType: 'pkce',
      },
      global: {
        headers: { 'x-application-name': 'camps-management-platform' },
      },
    })
  : null;

/**
 * Throws with an Arabic message rather than letting `null.from(...)` surface as
 * an opaque TypeError halfway down a page module.
 */
export function requireClient() {
  if (!supabase) {
    throw new Error('لم يتم ضبط الاتصال بقاعدة البيانات. راجع ملف BACKEND.md.');
  }
  return supabase;
}

/**
 * The authenticated user's id, or null.
 *
 * Always read the user from the auth server rather than decoding the stored
 * JWT: a token in localStorage can be stale or tampered with, and this is the
 * value the RLS policies key on.
 */
export async function currentUserId() {
  if (!supabase) return null;
  const { data, error } = await supabase.auth.getUser();
  if (error) return null;
  return data.user ? data.user.id : null;
}

/**
 * The signed-in user's application profile — role, camp and status.
 *
 * The role comes from the database, never from localStorage and never from the
 * JWT's user_metadata (which the user themselves can edit). The UI uses it only
 * to decide what to render; the database enforces it regardless.
 */
export async function currentProfile() {
  if (!supabase) return null;

  const userId = await currentUserId();
  if (!userId) return null;

  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name, phone, role, camp_id, family_member_id, status')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    console.error('[supabase] تعذر قراءة ملف المستخدم', error);
    return null;
  }
  return data;
}

export default supabase;

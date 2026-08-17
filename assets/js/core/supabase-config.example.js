/**
 * Supabase connection settings for the browser.
 *
 * Copy this file to `supabase-config.js` and fill in the two values, or run
 * `npm run frontend:config` from ./supabase to generate it from .env.
 *
 * `supabase-config.js` is git-ignored: the values are project-specific even
 * though the publishable key itself is safe to expose.
 *
 * ONLY the publishable key belongs here. The secret / service_role key bypasses
 * Row Level Security and must never appear anywhere under assets/.
 */

export const SUPABASE_URL = 'https://your-project-ref.supabase.co';

/** Publishable key (sb_publishable_… , or the legacy anon JWT). */
export const SUPABASE_ANON_KEY = 'sb_publishable_xxxxxxxxxxxxxxxxxxxxxx';

// assets/js/supabase/auth.js
import { requireClient } from '../core/supabase-client.js';
import { mapAuthError } from './errors.js';

export async function signIn(email, password) {
  const client = requireClient();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw mapAuthError(error);
  return data.session;
}

export async function signUp({ email, password, fullName, phone }) {
  const client = requireClient();
  const { data, error } = await client.auth.signUp({
    email,
    password,
    options: { data: { full_name: fullName, phone } },
  });
  if (error) throw mapAuthError(error);
  return data.user;
}

/**
 * Signs out EVERY session of this account, not just this device (scope 'global' — also supabase-js's default,
 * stated explicitly so it reads as a decision). Deliberate: camp devices are often shared, and a user who
 * signs out on one phone expects a lost or borrowed phone to be locked out too. Phase 4.29, BACKEND.md.
 */
export async function signOut() {
  const client = requireClient();
  const { error } = await client.auth.signOut({ scope: 'global' });
  if (error) throw mapAuthError(error);
}

export async function updatePassword(newPassword) {
  const client = requireClient();
  const { error } = await client.auth.updateUser({ password: newPassword });
  if (error) throw mapAuthError(error);
}

/**
 * Sends the password-reset email. The link returns to `redirectTo` (which must
 * be in the project's allowed redirect URLs) carrying a one-time PKCE code that
 * supabase-js exchanges for a recovery session on load (detectSessionInUrl).
 */
export async function requestPasswordReset(email, redirectTo) {
  const client = requireClient();
  const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo });
  if (error) throw mapAuthError(error);
}

/** Resolves the recovery session once supabase-js has processed the link, or null. */
export async function waitForRecoverySession(timeoutMs = 4000) {
  const client = requireClient();
  const existing = (await client.auth.getSession()).data.session;
  if (existing) return existing;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { subscription.unsubscribe(); resolve(null); }, timeoutMs);
    const { data: { subscription } } = client.auth.onAuthStateChange((event, session) => {
      if (session) { clearTimeout(timer); subscription.unsubscribe(); resolve(session); }
    });
  });
}

export async function getSession() {
  const client = requireClient();
  const { data, error } = await client.auth.getSession();
  if (error) throw mapAuthError(error);
  return data.session;
}

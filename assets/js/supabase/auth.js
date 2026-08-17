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

export async function signOut() {
  const client = requireClient();
  const { error } = await client.auth.signOut();
  if (error) throw mapAuthError(error);
}

export async function getSession() {
  const client = requireClient();
  const { data, error } = await client.auth.getSession();
  if (error) throw mapAuthError(error);
  return data.session;
}

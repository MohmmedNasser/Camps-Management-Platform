// Every document function builds its Postgres access through a client scoped
// to the CALLER's own JWT — never through the service_role key. RLS is still
// the real authorization boundary (BACKEND.md §13: "RLS is the only access
// control that matters"); this only lets the function make signed Cloudinary
// calls on the caller's behalf while every database read/write stays exactly
// as restricted as if the caller had gone through PostgREST directly.
//
// SUPABASE_URL and the publishable key are injected into every Edge Function
// by the platform — never set as a secret here, and never the secret/
// service_role key.
import { createClient, type SupabaseClient, type User } from 'npm:@supabase/supabase-js@2';

export function callerClient(authHeader: string): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const key = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY') ?? '';
  return createClient(url, key, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
}

/** Resolves the caller from the Authorization header, or null if the JWT is missing/invalid. */
export async function callerUser(client: SupabaseClient, authHeader: string | null): Promise<User | null> {
  if (!authHeader) return null;
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user;
}

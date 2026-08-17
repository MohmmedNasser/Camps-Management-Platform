// Shared CORS headers for the Phase 3 document functions. supabase-js's
// `.functions.invoke()` sends a real cross-origin request (the Supabase
// project URL is never same-origin with the static frontend), so every
// response — including the OPTIONS preflight — needs these.
export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  // documents-access exposes the real filename/MIME as custom headers
  // (see that function for why) — without this, the browser drops them.
  'Access-Control-Expose-Headers': 'X-Document-Mime, X-Document-Name',
};

// Shared CORS headers for the Phase 3 document functions. supabase-js's
// `.functions.invoke()` sends a real cross-origin request (the Supabase
// project URL is never same-origin with the static frontend), so every
// response — including the OPTIONS preflight — needs these.
export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  // x-application-name/x-supabase-api-version: sent automatically by
  // supabase-js's browser client (confirmed live during Phase 4.8's first
  // real browser upload attempt via Playwright — the preflight was rejected
  // with "Request header field x-application-name is not allowed"). Every
  // call from a real browser was silently blocked by this until now; Phase
  // 3's own test suite never caught it because it calls these functions
  // from Node, which does not enforce CORS preflights.
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-application-name, x-supabase-api-version',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  // documents-access exposes the real filename/MIME as custom headers
  // (see that function for why) — without this, the browser drops them.
  'Access-Control-Expose-Headers': 'X-Document-Mime, X-Document-Name',
};
